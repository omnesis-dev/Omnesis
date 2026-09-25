// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A real DuckDB, built from the universe's declared world.
 *
 * SQL nodes run against a real engine from the first day, never a simulation —
 * a query that a lexer thinks is fine and DuckDB rejects is a query that would
 * have failed in production, and there is no point discovering that later.
 *
 * The universe commits **rows as JSON** and this module materializes the
 * database from them, deriving each `CREATE TABLE` from the ontology snapshot's
 * own declared schema. That is deliberate, and it buys something a committed
 * `.duckdb` file could not: the fixture database and the declared catalog
 * cannot disagree, because one builds the other. A row naming a column the
 * ontology does not declare fails to load, loudly, instead of sitting in a
 * binary nobody can read in review.
 *
 * The connection is read-only in spirit and sandboxed in fact: external access
 * is disabled, so a query cannot reach the filesystem or attach another
 * database. There is exactly one catalog a table name can resolve in, which is
 * what makes the validator's table checking honest.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

import type { AnalyticsTableSnapshot, Ontology } from "../ontology/snapshot.js";

/** A value a query parameter can carry. */
export type SqlParameterValue = string | number | boolean | null;

/**
 * A parameter whose SQL type matters.
 *
 * A bound instant is the case that forces this: `$now - INTERVAL 1 YEAR` is how
 * a DSL author writes a recency window, and DuckDB cannot subtract an interval
 * from a string. Binding the value with its real type keeps the query readable
 * instead of pushing a cast into every watch that mentions time.
 */
interface TypedSqlParameter {
  readonly sqlType: SqlTypeName;
  readonly value: SqlParameterValue;
}

export type SqlParameter = SqlParameterValue | TypedSqlParameter;

/**
 * The SQL types a bound parameter may be cast to at its binding site.
 *
 * Wide enough to carry every DSL value type that survives the journal, and no
 * wider. A value crossing the journal has been through JSON, which has no
 * decimal, no date and no interval — so a `DECIMAL(18,4)` arrives as a string
 * and binds VARCHAR unless something says otherwise, and arithmetic on it is
 * refused by the binder rather than answered wrongly.
 *
 * `DOUBLE` is the one lossy choice here: the DSL's own type system resolves
 * every numeric column to `number`, so a decimal's scale is already gone by the
 * time a binding site can ask. It is the resolution the validator reasons in,
 * and it is what makes a comparison possible at all.
 */
export type SqlTypeName = "DATE" | "TIMESTAMPTZ" | "VARCHAR" | "DOUBLE" | "BOOLEAN";

/**
 * The cast type is the one thing this module puts into a query as text, so it
 * is checked against the closed set at runtime and not merely typed. A
 * compile-time union is not a boundary guard: `prepareQuery` is exported, its
 * hints come from a caller, and an unchecked type would turn the one
 * interpolation site into an injection.
 */
const SQL_TYPE_NAMES: ReadonlySet<string> = new Set([
  "DATE",
  "TIMESTAMPTZ",
  "VARCHAR",
  "DOUBLE",
  "BOOLEAN",
]);

function assertSqlType(value: unknown, where: string): SqlTypeName {
  if (typeof value !== "string" || !SQL_TYPE_NAMES.has(value)) {
    throw new Error(
      `${where}: '${String(value)}' is not a bindable SQL type. ` +
        `Expected one of ${[...SQL_TYPE_NAMES].join(", ")}.`,
    );
  }
  return value as SqlTypeName;
}

function isTyped(parameter: SqlParameter): parameter is TypedSqlParameter {
  return (
    typeof parameter === "object" &&
    parameter !== null &&
    !Array.isArray(parameter) &&
    "sqlType" in parameter &&
    typeof (parameter as { sqlType: unknown }).sqlType === "string" &&
    "value" in parameter
  );
}

/**
 * The cast each bound value asks for, keyed as `prepareQuery` expects.
 *
 * A caller that prepares its own statement has to apply these itself, and the
 * type is the whole reason the value is bindable: a `DECIMAL` that crossed a
 * journal as JSON is a string, and a query doing arithmetic on it binds text
 * unless the cast is emitted. Exported so the derivation lives once — a host
 * that re-implemented it would be free to drift, and a host that omitted it
 * would run every query with the types silently discarded.
 */
export function sqlTypeHints(
  values: Readonly<Record<string, SqlParameter>>,
): Record<string, SqlTypeName> {
  const hints: Record<string, SqlTypeName> = {};
  for (const [reference, supplied] of Object.entries(values)) {
    if (isTyped(supplied)) hints[reference] = supplied.sqlType;
  }
  return hints;
}

/**
 * The type a reference carries when the caller did not say. `$today` is a date
 * and `$now` an instant by definition — they are the evaluation clock, and a
 * watch that mentions time should not have to spell that out.
 */
function defaultType(reference: string): SqlTypeName | undefined {
  if (reference === "$today") return "DATE";
  if (reference === "$now") return "TIMESTAMPTZ";
  return undefined;
}

export interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly columns: readonly string[];
}

/**
 * A DSL reference rewritten into a name DuckDB will accept as a parameter.
 *
 * `$key.month` and `$n.trip_booked.depart_date` are legal in the DSL and not
 * legal as SQL parameter names — DuckDB's are bare identifiers. So the query is
 * rewritten to generated names and the values bound to those, which keeps the
 * one property that matters: **a reference is never interpolated as text.**
 */
export interface PreparedQuery {
  readonly sql: string;
  readonly parameters: readonly {
    /** The reference exactly as the DSL wrote it. */
    readonly reference: string;
    /** The parameter name the rewritten SQL uses. */
    readonly name: string;
  }[];
}

/**
 * The type each reference is cast to at its binding site, if any.
 *
 * The cast, rather than a typed bind, is what makes `$now - INTERVAL 1 YEAR`
 * work: DuckDB's typed parameter binding wants its own value wrappers, and a
 * cast around the placeholder achieves the same thing while leaving the value a
 * plain bound string. The value is still never interpolated.
 */
export type SqlTypeHints = Readonly<Record<string, SqlTypeName | undefined>>;

/** Matches a `$`-reference, longest-first so `$n.a.b` beats `$n.a`. */
const REFERENCE = /\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;

/**
 * Rewrite every `$`-reference in a query to a DuckDB-legal parameter name.
 *
 * String literals are skipped: `'$today is not a parameter'` is text, and
 * rewriting inside it would corrupt the query.
 */
export function prepareQuery(sql: string, types: SqlTypeHints = {}): PreparedQuery {
  const parameters = new Map<string, { reference: string; name: string }>();
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    // Copy every literal and comment form through untouched. Missing one is
    // not a cosmetic bug: a stray quote inside an identifier desynchronises the
    // lexer, and from there a real reference can be left un-rewritten.
    if (ch === "'" || ch === '"') {
      const end = closingDelimiter(sql, i, ch);
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    // Dollar-quoted strings: `$$…$$` and `$tag$…$tag$`. Their contents are
    // literal text, and `$today` inside one is prose.
    const dollarQuote = dollarQuoteAt(sql, i);
    if (dollarQuote) {
      const end = sql.indexOf(dollarQuote, i + dollarQuote.length);
      const stop = end === -1 ? sql.length : end + dollarQuote.length;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === "$") {
      REFERENCE.lastIndex = i;
      const match = REFERENCE.exec(sql);
      if (match && match.index === i) {
        const reference = match[0];
        const name = parameterName(reference);
        parameters.set(reference, { reference, name });
        const hinted = Object.hasOwn(types, reference) ? types[reference] : undefined;
        const sqlType =
          hinted === undefined
            ? defaultType(reference)
            : assertSqlType(hinted, `type hint for ${reference}`);
        out += sqlType ? `CAST($${name} AS ${sqlType})` : `$${name}`;
        i += reference.length;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return { sql: out, parameters: [...parameters.values()] };
}

/**
 * The index just past the closing delimiter, honouring the doubled-delimiter
 * escape both `'…''…'` and `"…""…"` use. An unterminated literal runs to the
 * end of the input rather than throwing: the caller's job is to preserve the
 * query, and DuckDB will give a better message about the syntax than this could.
 */
function closingDelimiter(sql: string, start: number, delimiter: string): number {
  let i = start + 1;
  for (;;) {
    const end = sql.indexOf(delimiter, i);
    if (end === -1) return sql.length;
    if (sql[end + 1] === delimiter) {
      i = end + 2;
      continue;
    }
    return end + 1;
  }
}

/** The opening tag if a dollar-quoted string starts here, else null. */
function dollarQuoteAt(sql: string, index: number): string | null {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
  return match ? match[0] : null;
}

/** `$n.trip.depart` becomes `p_n__trip__depart` — legal, and traceable back. */
function parameterName(reference: string): string {
  return `p_${reference.slice(1).replaceAll(".", "__")}`;
}

export class AnalyticsDatabase {
  private constructor(
    private readonly connection: DuckDBConnection,
    private readonly instance: DuckDBInstance,
  ) {}

  /**
   * Build the database from a universe's row files, using the ontology's
   * declared schemas as the DDL. A table with no row file is still created —
   * an empty table is a real state a watch has to cope with, and a missing one
   * would fail with a confusing "table does not exist" instead.
   *
   * `seed` decides what starts populated. **A replay wants `"projections"`**:
   * the analytics store is downstream of the same events the journal carries,
   * so a watch evaluating at some point in the past must see only the rows that
   * had arrived by then. Seeding everything would let a SQL node read rows from
   * its own future — a budget watch would cross its threshold on the first
   * transaction of the month, because the month was already complete.
   *
   * Tables the ontology attributes to no source are the exception. They are
   * projections the system maintains rather than ingest output, so no event
   * carries them and they are seeded whole.
   */
  static async materialize(
    ontology: Ontology,
    analyticsDir: string,
    seed: "all" | "projections" = "all",
  ): Promise<AnalyticsDatabase> {
    const catalogued = new Set(ontology.snapshot.analyticsTables.map((t) => t.tableName));
    for (const file of readdirSync(analyticsDir).filter((f) => f.endsWith(".json"))) {
      const name = file.replace(/\.json$/, "");
      if (catalogued.has(name)) continue;
      throw new Error(
        `Row fixture '${file}' names no table in the catalog. A typo here would silently load nothing.`,
      );
    }

    // Replays own independent, tiny databases and advance one event at a time.
    // A native worker pool per replay costs more than it saves on these rows,
    // and multiplies the host's thread count when evaluations run in parallel.
    const instance = await DuckDBInstance.create(":memory:", { threads: "1" });
    let connection: DuckDBConnection | undefined;
    try {
      connection = await instance.connect();
      // Fixture loading is one operation. Committing every row separately
      // repeats transaction work without exposing any intermediate state.
      await connection.run("BEGIN TRANSACTION");
      for (const table of ontology.snapshot.analyticsTables) {
        await connection.run(createTableSql(table));
        const systemOwned = table.sourceId === undefined;
        if (seed === "all" || systemOwned) {
          for (const row of readRows(analyticsDir, table)) {
            await insertRow(connection, table, row);
          }
        }
      }
      await connection.run("COMMIT");

      // Rendered timestamps must not depend on the machine asking. DuckDB
      // formats TIMESTAMPTZ in the session zone, so a golden trace recorded in
      // one timezone would not reproduce in another.
      await connection.run("SET TimeZone = 'UTC'");

      // Nothing a watch runs may reach outside this database.
      await connection.run("SET enable_external_access = false");

      return new AnalyticsDatabase(connection, instance);
    } catch (error) {
      // A malformed fixture must not strand native workers or an open database.
      connection?.closeSync();
      instance.closeSync();
      throw error;
    }
  }

  /**
   * Run a query with its DSL references bound as parameters.
   *
   * `values` is keyed by the reference as the DSL wrote it (`$today`,
   * `$key.month`); the rewriting to legal parameter names happens here so no
   * caller has to know about it.
   */
  /**
   * Apply a row the journal reported, exactly as ingest would: an upsert on the
   * declared primary key, so a revision replaces the row it revises rather than
   * adding a second one.
   */
  async applyRow(
    table: AnalyticsTableSnapshot,
    row: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await insertRow(this.connection, table, row, "upsert");
  }

  async query(
    sql: string,
    values: Readonly<Record<string, SqlParameter>> = {},
  ): Promise<QueryResult> {
    const hints: Record<string, SqlTypeName | undefined> = {};
    for (const [reference, supplied] of Object.entries(values)) {
      if (isTyped(supplied)) {
        hints[reference] = assertSqlType(supplied.sqlType, `parameter ${reference}`);
      }
    }

    const prepared = prepareQuery(sql, hints);

    const bound: Record<string, SqlParameterValue> = {};
    for (const parameter of prepared.parameters) {
      if (!(parameter.reference in values)) {
        throw new Error(
          `Query binds ${parameter.reference} but no value was supplied for it. ` +
            `A reference is never interpolated as text, so an unbound one cannot run.`,
        );
      }
      const supplied = values[parameter.reference]!;
      bound[parameter.name] = isTyped(supplied) ? supplied.value : supplied;
    }

    const reader = await this.connection.runAndReadAll(prepared.sql, bound);
    const rows = reader.getRowObjects().map(normalizeRow);
    return { rows, columns: reader.columnNames() };
  }

  /**
   * Closed explicitly, and in this order.
   *
   * The connection first: closing the instance out from under a live connection
   * is the shape of bug that shows up as native memory corruption rather than
   * as an exception, and this is the only place in the package that allocates
   * natively.
   *
   * One unexplained crash sits behind that caution. A long evaluation run died
   * with `free(): corrupted unsorted chunks` — a glibc heap error, so a fact
   * about native memory and not about anything JavaScript could have done. It
   * has not been reproduced: `scripts/stress-replay.ts` drives bare open/close
   * cycles and then full concurrent replays at higher concurrency than the run
   * that died, and both survive. What differs between the harness and the run
   * that crashed is everything else the run was doing — an HTTP client, a model
   * provider, and a machine several gigabytes into swap.
   *
   * `parallel-replay.test.ts` holds the property the crash would have broken,
   * so a quiet version of the same fault fails a test rather than passing one.
   */
  close(): void {
    this.connection.closeSync();
    this.instance.closeSync();
  }
}

/**
 * Flatten DuckDB's value wrappers into plain JS.
 *
 * This is not cosmetic. Every non-scalar comes back as a wrapper object, and
 * `String(wrapper)` on a `TIMESTAMPTZ` renders it in the **host** timezone —
 * so a golden trace recorded on one machine would not reproduce on another, in
 * a package whose whole premise is reproducibility. Converting from the epoch
 * micros the wrapper carries sidesteps the formatter entirely.
 *
 * Decimals become numbers and lists become arrays for the same reason a caller
 * would expect: `row.amount > 100` should be a numeric comparison, not a
 * lexicographic one on `"185.4000"`.
 */
function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value === null || typeof value !== "object") return value;

  const wrapper = value as Record<string, unknown>;

  // TIMESTAMPTZ / TIMESTAMP — epoch microseconds, always rendered as UTC.
  if (typeof wrapper.micros === "bigint") {
    return new Date(Number(wrapper.micros / 1000n)).toISOString();
  }
  // DATE — days since the epoch.
  if (typeof wrapper.days === "number") {
    return new Date(wrapper.days * 86_400_000).toISOString().slice(0, 10);
  }
  // DECIMAL — an integer plus a scale.
  if (typeof wrapper.scale === "number" && typeof wrapper.value === "bigint") {
    return Number(wrapper.value) / 10 ** wrapper.scale;
  }
  // LIST / ARRAY.
  if (Array.isArray(wrapper.items)) return wrapper.items.map(normalizeValue);

  return value;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = normalizeValue(value);
  return out;
}

function createTableSql(table: AnalyticsTableSnapshot): string {
  const columns = table.columns.map((c) => `${quoteIdentifier(c.name)} ${c.type}`).join(", ");
  const primaryKey = table.primaryKey.map(quoteIdentifier).join(", ");
  return `CREATE TABLE ${quoteIdentifier(table.tableName)} (${columns}, PRIMARY KEY (${primaryKey}))`;
}

async function insertRow(
  connection: DuckDBConnection,
  table: AnalyticsTableSnapshot,
  row: Readonly<Record<string, unknown>>,
  mode: "insert" | "upsert" = "insert",
): Promise<void> {
  const declared = new Set(table.columns.map((c) => c.name));
  for (const name of Object.keys(row)) {
    if (declared.has(name)) continue;
    throw new Error(
      `Row fixture for '${table.tableName}' sets '${name}', which the ontology does not declare. ` +
        `The fixture database and the catalog are built from one source and cannot disagree.`,
    );
  }

  const names = table.columns.map((c) => c.name);
  const values: Record<string, SqlParameterValue> = {};
  // A `VARCHAR[]` or `JSON` column is declarable, so it has to be loadable.
  // Both bind as text and are cast on the way in, which keeps the parameter a
  // plain scalar while letting DuckDB build the real value.
  const placeholders = table.columns.map((column, i) => {
    const value = row[column.name];
    if (value === undefined || value === null) {
      values[`v${i}`] = null;
      return `$v${i}`;
    }
    if (column.type === "VARCHAR[]" || column.type === "JSON") {
      values[`v${i}`] = JSON.stringify(value);
      return `CAST($v${i} AS ${column.type})`;
    }
    values[`v${i}`] = value as SqlParameterValue;
    return `$v${i}`;
  });

  // A table whose every column is part of the key has nothing to update: the
  // row either exists or does not, and a redelivery is a no-op.
  const updatable = names.filter((name) => !table.primaryKey.includes(name));
  const conflict =
    mode !== "upsert"
      ? ""
      : updatable.length === 0
        ? ` ON CONFLICT (${table.primaryKey.map(quoteIdentifier).join(", ")}) DO NOTHING`
        : ` ON CONFLICT (${table.primaryKey.map(quoteIdentifier).join(", ")}) DO UPDATE SET ` +
          updatable
            .map((name) => `${quoteIdentifier(name)} = excluded.${quoteIdentifier(name)}`)
            .join(", ");

  await connection.run(
    `INSERT INTO ${quoteIdentifier(table.tableName)} (${names.map(quoteIdentifier).join(", ")}) ` +
      `VALUES (${placeholders.join(", ")})${conflict}`,
    values,
  );
}

function readRows(analyticsDir: string, table: AnalyticsTableSnapshot): Record<string, unknown>[] {
  const path = join(analyticsDir, `${table.tableName}.json`);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Row fixture '${path}' must be an array of row objects.`);
  }
  parsed.forEach((row, i) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Row fixture '${path}' entry ${i} is not an object.`);
    }
  });
  return parsed as Record<string, unknown>[];
}

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`'${name}' is not a legal identifier.`);
  }
  return `"${name}"`;
}
