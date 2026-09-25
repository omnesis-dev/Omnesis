// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Source scoping for sandboxed user SQL (`run_sql` on a source-restricted
 * Direct grant).
 *
 * The analytics connection pool already vets every user statement through
 * DuckDB's own parser (`json_serialize_sql`) before preparing it. This
 * module reuses that same parse tree — an engine decision, never a keyword
 * scan — to answer "which base tables does this statement read?" so a
 * restricted grant can keep `run_sql` while touching only its permitted
 * sources.
 *
 * Why the parse tree and not `EXPLAIN (FORMAT JSON)`: the tree is already
 * fetched during vetting (no second round trip, no second bind, so the
 * table list cannot drift from what the engine vetted). The catalog
 * snapshot itself is read after the vet and can be stale relative to the
 * run — which fails closed in every direction (unknown tables deny,
 * dropped tables error at execution, tables are never reassigned between
 * sources). Its `BASE_TABLE` / `cte_map` / `TABLE_FUNCTION` node shapes
 * are already a load-bearing dependency of the sandbox vetting. CTE names
 * are subtracted scope-aware (an unqualified name only), views expand to
 * nothing here — no caller can create one on the read-only sandbox, so a
 * view-looking reference fails closed as an unknown table — and any table
 * function (`summary(t)`, `pragma_table_info(t)`, …) is reported
 * separately: those read table data or schema without a `FROM` clause, so
 * restricted grants refuse them wholesale.
 */

import type { SqlGrantRefusal } from "@omnesis/core";

export interface SandboxTableRef {
  catalog: string;
  schema: string;
  table: string;
}

export interface SandboxTableRefs {
  tables: SandboxTableRef[];
  /** Table-function names called anywhere in the statement (e.g. `summary`). */
  tableFunctions: string[];
  /** Scalar/aggregate function names called anywhere in the statement. */
  scalarFunctions: string[];
  /**
   * `SHOW` statements that read no named table (`SHOW TABLES`,
   * `SHOW ALL TABLES`, …) — engine `SHOW_REF` nodes with a null query.
   * Carries the engine `show_type`, never corpus text. Table-bound SHOW
   * (`DESCRIBE t`, `SUMMARIZE t`) instead embeds a full SELECT whose
   * `BASE_TABLE` refs walk normally, so they need no entry here.
   */
  bareShows: string[];
}

/**
 * Pull every base-table reference out of a `json_serialize_sql` parse
 * tree. CTE names are subtracted only where they are in scope; nothing
 * else is filtered here — unknown schemas, views, and system tables are
 * the authorizer's decision, so extraction stays fail-open and
 * authorization stays fail-closed.
 */
export function extractSandboxTableRefs(parseTree: unknown): SandboxTableRefs {
  const tables: SandboxTableRef[] = [];
  const tableFunctions = new Set<string>();
  const scalarFunctions = new Set<string>();
  const bareShows = new Set<string>();
  walkParseTree(parseTree, new Set(), { tables, tableFunctions, scalarFunctions, bareShows });
  return {
    tables,
    tableFunctions: [...tableFunctions],
    scalarFunctions: [...scalarFunctions],
    bareShows: [...bareShows],
  };
}

interface SandboxWalkOutput {
  tables: SandboxTableRef[];
  tableFunctions: Set<string>;
  scalarFunctions: Set<string>;
  bareShows: Set<string>;
}

function walkParseTree(node: unknown, ctes: ReadonlySet<string>, out: SandboxWalkOutput): void {
  if (Array.isArray(node)) {
    for (const child of node) walkParseTree(child, ctes, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  // A bare SHOW dumps schema (table names, columns, types) with no FROM
  // clause for the gate to see — `SHOW TABLES` lists every table
  // including denied ones. Refuse it outright; discovery runs through
  // the grant's instructions catalog instead.
  if (record.type === "SHOW_REF" && record.query == null) {
    if (typeof record.show_type === "string") out.bareShows.add(record.show_type);
    else out.bareShows.add("SHOW");
    return;
  }
  // Scalar calls are table-less by construction and pass — except stored
  // macros, which the authorizer matches against the live macro catalog.
  // (No in-repo path creates macros; the check is defense in depth.)
  if (record.type === "FUNCTION") {
    if (typeof record.function_name === "string") out.scalarFunctions.add(record.function_name);
  }
  if (record.type === "BASE_TABLE") {
    const catalog = typeof record.catalog_name === "string" ? record.catalog_name : "";
    const schema = typeof record.schema_name === "string" ? record.schema_name : "";
    // A CTE hides a table name only for unqualified references: a
    // schema- or catalog-qualified ref (`main.t`, `db.main.t`) can never
    // bind to a CTE, so it must still be reported even when a same-named
    // CTE is in scope. Dropping it would let a qualified read of a denied
    // table vanish from the gate.
    if (
      typeof record.table_name === "string" &&
      (schema !== "" || catalog !== "" || !ctes.has(record.table_name))
    ) {
      out.tables.push({ catalog, schema, table: record.table_name });
    }
    return;
  }
  if (record.type === "TABLE_FUNCTION") {
    const fn = record.function as Record<string, unknown> | undefined;
    if (typeof fn?.function_name === "string") out.tableFunctions.add(fn.function_name);
  }
  // CTEs are visible to their own query level and everything below it,
  // and each entry sees the entries defined before it — so accumulate in
  // order rather than subtracting one global set. A CTE body that names a
  // real table keeps that table: it walks with the outer scope.
  let scope: ReadonlySet<string> = ctes;
  const cteMap = record.cte_map as { map?: unknown } | undefined;
  if (cteMap && Array.isArray(cteMap.map)) {
    const nested: Set<string> = new Set(ctes);
    scope = nested;
    for (const entry of cteMap.map) {
      const mapEntry = entry as { key?: unknown; value?: unknown };
      walkParseTree(mapEntry.value, nested, out);
      if (typeof mapEntry.key === "string") nested.add(mapEntry.key);
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "cte_map") continue;
    walkParseTree(value, scope, out);
  }
}

/**
 * A user statement a source-restricted grant may not run. Never constructed
 * for unrestricted callers.
 *
 * Carries what was refused per category, which is both what an adapter needs
 * to describe the refusal ({@link describeSqlGrantRefusal}) and what a caller
 * that can act on them one by one needs to read.
 */
export class ScopedSqlDeniedError extends Error implements SqlGrantRefusal {
  /** Table names as the caller typed them. */
  readonly tables: readonly string[];
  /** Table-function names as the caller typed them. */
  readonly tableFunctions: readonly string[];
  /** Engine `SHOW` kinds refused (`SHOW TABLES` dumps every table name). */
  readonly shows: readonly string[];
  /** Stored-macro names the statement tried to call, as typed. */
  readonly macros: readonly string[];

  constructor(input: {
    tables: readonly string[];
    tableFunctions: readonly string[];
    shows: readonly string[];
    macros: readonly string[];
  }) {
    super("SQL query touches tables outside this grant");
    this.name = "ScopedSqlDeniedError";
    this.tables = [...input.tables];
    this.tableFunctions = [...input.tableFunctions];
    this.shows = [...input.shows];
    this.macros = [...input.macros];
  }
}

export interface SandboxCatalogEntry {
  tableName: string;
  sourceId: string;
}

/**
 * Fail-closed table gate for one vetted statement. Every extracted table
 * reference must resolve to a catalog entry whose source the grant
 * permits; anything else — unknown tables, views, system schemas, bare
 * `SHOW` statements, table functions, stored-macro calls — denies the
 * whole statement. Table functions are denied unconditionally for
 * restricted grants because several of them (`summary(t)`,
 * `pragma_table_info(t)`) read a table's data or schema without a `FROM`
 * clause; stored macros are denied because a macro body can read any
 * table while the call site names none. Scalar introspection
 * (`version()`, `current_setting()`) passes by design: scalars cannot
 * reach corpus rows without a `FROM`, and any `FROM` is gated — the only
 * exposure is operator-local engine config.
 *
 * Name matching is exact-first with a lowercase fallback (DuckDB folds
 * unquoted identifiers), but a fallback match only passes when every
 * same-folded catalog entry is permitted — so a quoted `"X"` beside an
 * unquoted `x` can never smuggle the denied one. Macro matching folds the
 * same way.
 */
export function authorizeSandboxTables(input: {
  refs: SandboxTableRefs;
  catalog: readonly SandboxCatalogEntry[];
  permittedSourceIds: ReadonlySet<string>;
  /** Lowercase names of the store's non-internal macros. */
  macroNames: readonly string[];
}): void {
  const deniedTables: string[] = [];
  for (const ref of input.refs.tables) {
    if (!isAnalyticsQualifier(ref)) {
      deniedTables.push(qualifyRef(ref));
      continue;
    }
    const candidates = input.catalog.filter(
      (entry) =>
        entry.tableName === ref.table || entry.tableName.toLowerCase() === ref.table.toLowerCase(),
    );
    if (
      candidates.length === 0 ||
      candidates.some((entry) => !input.permittedSourceIds.has(entry.sourceId))
    ) {
      deniedTables.push(qualifyRef(ref));
    }
  }
  const macroNames = new Set(input.macroNames);
  const macros = input.refs.scalarFunctions.filter((name) => macroNames.has(name.toLowerCase()));
  if (
    deniedTables.length > 0 ||
    input.refs.tableFunctions.length > 0 ||
    input.refs.bareShows.length > 0 ||
    macros.length > 0
  ) {
    throw new ScopedSqlDeniedError({
      tables: deniedTables,
      tableFunctions: input.refs.tableFunctions,
      shows: input.refs.bareShows,
      macros,
    });
  }
}

/**
 * Analytics tables live in the attached store's default schema and are
 * addressed bare, `main.<table>`, or fully qualified. Anything else —
 * `information_schema`, a second catalog — is outside the corpus and
 * refused without a catalog lookup. The `_`-prefixed gateway bookkeeping
 * tables pass the qualifier but match no source-catalog entry, so they
 * are refused as unknown tables below.
 */
function isAnalyticsQualifier(ref: SandboxTableRef): boolean {
  // DuckDB folds identifiers even when quoted. Match that binding rule for
  // qualifiers as well as table names, without admitting another namespace.
  const catalogOk = ref.catalog === "" || ref.catalog.toLowerCase() === "omnesis_analytics";
  const schemaOk = ref.schema === "" || ref.schema.toLowerCase() === "main";
  return catalogOk && schemaOk;
}

function qualifyRef(ref: SandboxTableRef): string {
  const parts = [ref.catalog, ref.schema, ref.table].filter((part) => part !== "");
  return parts.join(".");
}
