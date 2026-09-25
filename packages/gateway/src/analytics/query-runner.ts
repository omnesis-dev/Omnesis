// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `AnalyticsQueryRunner` — read-side. Owns the user-SQL entry point
 * (`executeQuery`, which runs on the pool's sandbox connection) plus the
 * "preview" / "recent rows" / "activity sparkline" helpers that the portal
 * and CLI surface. Catalog reads route through `AnalyticsCatalogStore`;
 * pool conns come from `AnalyticsConnectionPool`.
 */

import { convertDuckDBValue, escapeStr, quoteIdent } from "./internal.js";
import { authorizeSandboxTables, extractSandboxTableRefs } from "./sandbox-tables.js";
import { canonicalRowKey } from "./bound-documents.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { AnalyticsCatalogEntry, ColumnType } from "@omnesis/source-sdk";
import type { AnalyticsConnectionPool } from "./connection-pool.js";
import type { AnalyticsCatalogStore } from "./catalog-store.js";

const DEFAULT_QUERY_ROW_LIMIT = 10_000;
const MAX_QUERY_ROW_LIMIT = 10_000;
const DUCKDB_INTERRUPT_RETRY_MS = 10;

export type AnalyticsRecentCursorValue = string | number | boolean | null;

export interface AnalyticsRecentCursor {
  timeValue: AnalyticsRecentCursorValue;
  keyValues: AnalyticsRecentCursorValue[];
}

export class InvalidAnalyticsRecentCursorError extends Error {
  constructor() {
    super("Invalid analytics recent-row cursor");
    this.name = "InvalidAnalyticsRecentCursorError";
  }
}

function isRecentCursorValue(value: unknown): value is AnalyticsRecentCursorValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function recentCursorValue(value: unknown): AnalyticsRecentCursorValue {
  if (isRecentCursorValue(value)) return value;
  // Analytics primary keys are scalar by contract. This fallback keeps a
  // malformed legacy table pageable without ever embedding an object in the
  // cursor or interpolating it into SQL.
  return String(value);
}

function castRecentBind(name: string, type: ColumnType | undefined): string {
  const bind = `$${name}`;
  return type && type !== "VARCHAR" ? `CAST(${bind} AS ${type})` : bind;
}

function lexicographicAfter(
  columns: Array<{ expression: string; type: ColumnType | undefined }>,
  values: AnalyticsRecentCursorValue[],
  binds: Record<string, AnalyticsRecentCursorValue>,
): string {
  const alternatives: string[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const prefix: string[] = [];
    for (let prior = 0; prior < index; prior += 1) {
      const name = `recent_key_${prior}`;
      binds[name] = values[prior]!;
      prefix.push(`${columns[prior]!.expression} = ${castRecentBind(name, columns[prior]!.type)}`);
    }
    const name = `recent_key_${index}`;
    binds[name] = values[index]!;
    alternatives.push(
      [
        ...prefix,
        `${columns[index]!.expression} > ${castRecentBind(name, columns[index]!.type)}`,
      ].join(" AND "),
    );
  }
  // Every production analytics table declares a primary key. The rowid
  // fallback above also guarantees one column for old/malformed catalogs.
  return alternatives.map((alternative) => `(${alternative})`).join(" OR ");
}

class QueryDeadline {
  private readonly expiresAt: number | null;

  constructor(
    private readonly timeoutMs: number | undefined,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.expiresAt =
      timeoutMs !== undefined && timeoutMs > 0 ? performance.now() + timeoutMs : null;
  }

  assertRemaining(phase: string): void {
    this.remainingMs(phase);
  }

  async waitFor<T>(work: Promise<T>, phase: string): Promise<T> {
    const remainingMs = this.remainingMs(phase);
    if (remainingMs === null && !this.signal) return work;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;
    const guards: Promise<never>[] = [];
    if (remainingMs !== null) {
      guards.push(
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(this.timeoutError(phase)), remainingMs);
          timeoutHandle.unref?.();
        }),
      );
    }
    if (this.signal) {
      guards.push(
        new Promise<never>((_, reject) => {
          abortHandler = () => reject(this.cancelledError(phase));
          this.signal!.addEventListener("abort", abortHandler, { once: true });
          // AbortSignal does not replay an abort that lands between the
          // earlier `aborted` check and listener registration.
          if (this.signal!.aborted) abortHandler();
        }),
      );
    }
    try {
      return await Promise.race([work, ...guards]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (abortHandler) this.signal?.removeEventListener("abort", abortHandler);
    }
  }

  /**
   * DuckDB operations that exclusively own their connection can be
   * cancelled natively. Arm the interrupt for only the time left on the
   * end-to-end deadline — setup time must not buy the query a fresh budget.
   */
  async runDuckDb<T>(conn: DuckDBConnection, work: () => Promise<T>, phase: string): Promise<T> {
    const remainingMs = this.remainingMs(phase);
    if (remainingMs === null && !this.signal) return work();

    let cancelledBy: "timeout" | "signal" | null = null;
    let interruptError: unknown;
    let workSettled = false;
    let interruptRetryHandle: ReturnType<typeof setTimeout> | null = null;
    const issueInterrupt = () => {
      try {
        conn.interrupt();
      } catch (error) {
        interruptError ??= error;
      }
      // DuckDB's interrupt is edge-triggered: a query submitted to its native
      // worker may not be running when the first interrupt lands. This
      // connection is leased only to the request, so keep pulsing until its owned
      // work settles rather than allowing a queued query to start uncancelled.
      if (!workSettled) {
        interruptRetryHandle = setTimeout(issueInterrupt, DUCKDB_INTERRUPT_RETRY_MS);
        interruptRetryHandle.unref?.();
      }
    };
    const interrupt = (reason: "timeout" | "signal") => {
      if (cancelledBy) return;
      cancelledBy = reason;
      issueInterrupt();
    };
    const timeoutHandle =
      remainingMs === null ? null : setTimeout(() => interrupt("timeout"), remainingMs);
    timeoutHandle?.unref?.();
    const abortHandler = () => interrupt("signal");
    this.signal?.addEventListener("abort", abortHandler, { once: true });
    // Close the same registration race as `waitFor`: an already-fired abort
    // event is not replayed to a newly attached listener.
    if (this.signal?.aborted) abortHandler();

    try {
      let result: T;
      try {
        result = await work();
      } catch (error) {
        if (cancelledBy === "timeout") throw this.timeoutError(phase, interruptError ?? error);
        if (cancelledBy === "signal") throw this.cancelledError(phase, interruptError ?? error);
        throw error;
      }
      if (cancelledBy === "timeout") {
        throw this.timeoutError(
          phase,
          interruptError ?? new Error(`SQL execution deadline elapsed during ${phase}`),
        );
      }
      if (cancelledBy === "signal") {
        throw this.cancelledError(
          phase,
          interruptError ?? new Error(`SQL execution cancelled during ${phase}`),
        );
      }
      return result;
    } finally {
      workSettled = true;
      if (interruptRetryHandle) clearTimeout(interruptRetryHandle);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.signal?.removeEventListener("abort", abortHandler);
    }
  }

  timeoutError(phase: string, cause?: unknown): Error {
    return new Error(`SQL query timed out after ${this.timeoutMs}ms`, {
      cause: cause ?? new Error(`SQL execution deadline elapsed during ${phase}`),
    });
  }

  private cancelledError(phase: string, cause?: unknown): Error {
    return new Error("SQL query was cancelled", {
      cause: cause ?? new Error(`SQL execution cancelled during ${phase}`),
    });
  }

  private remainingMs(phase: string): number | null {
    if (this.signal?.aborted) throw this.cancelledError(phase);
    if (this.expiresAt === null) return null;
    const remainingMs = this.expiresAt - performance.now();
    if (remainingMs <= 0) throw this.timeoutError(phase);
    return remainingMs;
  }
}

export class AnalyticsQueryRunner {
  constructor(
    private readonly pool: AnalyticsConnectionPool,
    private readonly catalog: AnalyticsCatalogStore,
  ) {}

  /**
   * Execute a user-supplied SQL query in the pool's sandbox (see
   * `AnalyticsConnectionPool.withSandboxStatement`): one prepared SELECT,
   * vetted by DuckDB's own parser for anything that touches a file, on a
   * dedicated connection inside a read-only transaction of an instance whose
   * filesystem access is limited to the store and its spill directory. There
   * is no keyword block-list: the engine parses and refuses, so comments,
   * CTEs and nesting cannot hide a call from the gate.
   *
   * Cross-store SQL (attaching the SQLite stores) is not reachable from this
   * entry point; a feature needing it belongs on a separate admin-scoped,
   * audited entry point with its own threat model.
   */
  async executeQuery(
    sql: string,
    opts?: {
      limit?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
      /**
       * Named bind parameters. Keys correspond to `:name` placeholders in
       * the SQL. Only string/number/boolean/null/Date values are accepted
       * — anything else is JSON-stringified before binding so the caller
       * sees a deterministic representation rather than an opaque
       * DuckDB error. The trigger SQL guard is the only current caller.
       */
      params?: Record<string, string | number | boolean | null | Date>;
      /**
       * Source-restricted callers (a Direct grant naming selected
       * sources) pass the grant's permitted source ids. Every base table
       * the vetted statement reads must belong to one of them, or the
       * query is denied before it runs. Absent means no source gate —
       * the built-in agent and the operator's own SQL view.
       */
      permittedSourceIds?: ReadonlySet<string>;
    },
  ): Promise<{
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    timing: number;
    columnTypes: string[];
  }> {
    if (!this.pool.isOpen) throw new Error("AnalyticsDb not open");
    const deadline = new QueryDeadline(opts?.timeoutMs, opts?.signal);
    const requestedLimit = opts?.limit;
    if (
      requestedLimit !== undefined &&
      (!Number.isSafeInteger(requestedLimit) ||
        requestedLimit < 1 ||
        requestedLimit > MAX_QUERY_ROW_LIMIT)
    ) {
      throw new RangeError(`SQL row limit must be an integer from 1 to ${MAX_QUERY_ROW_LIMIT}`);
    }
    const limit = requestedLimit ?? DEFAULT_QUERY_ROW_LIMIT;

    // Always enforce the caller's cap in an outer query. Detecting an existing
    // LIMIT lexically is unsafe: the word can occur in a string literal,
    // comment, nested sub-query, or CTE while the outer result stays unbounded.
    // A caller-supplied inner/top-level LIMIT remains valid; the outer cap is a
    // second, non-bypassable ceiling.
    const trimmed = sql.trim();
    // A terminal semicolon is valid for callers but not inside DuckDB's
    // parenthesised sub-query. Strip exactly one; anything that still makes
    // the text more than one statement is refused when the pool prepares it.
    const queryBody = trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
    const querySql = `SELECT * FROM (${queryBody}) AS __q LIMIT ${limit}`;

    // Normalize bind values for DuckDB. Dates → ISO strings. Anything
    // else passes through; DuckDB handles string/number/boolean natively.
    const namedBinds: Record<string, string | number | boolean | null> | undefined = opts?.params
      ? Object.fromEntries(
          Object.entries(opts.params).map(([k, v]) => {
            if (v instanceof Date) return [k, v.toISOString()];
            return [k, v];
          }),
        )
      : undefined;

    // The pool vets the statement's syntax tree, prepares it as a single
    // SELECT and hands it over on a dedicated connection inside a read-only
    // transaction; only binding, the deadline and result shaping live here.
    // A timeout or abort interrupts the connection natively through
    // `runDuckDb`, and the pool closes it however the query ends.
    deadline.assertRemaining("query preparation");
    const permittedSourceIds = opts?.permittedSourceIds;
    return this.pool.withSandboxStatement(
      querySql,
      async ({ conn, statement }) => {
        deadline.assertRemaining("query execution");
        if (namedBinds) statement.bind(namedBinds);
        const start = Date.now();
        const reader = await deadline.runDuckDb(
          conn,
          () => statement.runAndReadAll(),
          "query execution",
        );
        const timing = Date.now() - start;
        deadline.assertRemaining("result materialization");
        const rawRows = reader.getRows() as unknown[][];
        const rows = rawRows.map((row) => row.map((val) => convertDuckDBValue(val)));
        const columnTypes = reader.columnTypes().map((t) => String(t));
        deadline.assertRemaining("result materialization");
        return {
          columns: reader.columnNames(),
          rows,
          rowCount: rows.length,
          timing,
          columnTypes,
        };
      },
      permittedSourceIds
        ? {
            // The source gate runs vetted-but-unbound: an unknown name
            // and a denied name fail identically, so restricted callers
            // cannot probe table existence through the error code.
            // `SELECT 1` and other table-less queries carry no refs and
            // pass.
            authorize: async ({ conn: sandboxConn, parseTree }) => {
              const catalog = await this.catalog.getCatalog();
              authorizeSandboxTables({
                refs: extractSandboxTableRefs(parseTree),
                catalog,
                permittedSourceIds,
                macroNames: await listNonInternalMacros(sandboxConn),
              });
            },
          }
        : undefined,
    );
  }

  /** Get detailed info about a specific table. */
  async getTableInfo(tableName: string): Promise<{
    catalog: AnalyticsCatalogEntry;
    sampleRows: unknown[][];
    sampleColumns: string[];
  } | null> {
    const catalog = await this.catalog.getCatalog();
    const entry = catalog.find((e) => e.tableName === tableName);
    if (!entry) return null;

    return this.pool.withConn(async (p) => {
      // Prefer the most-recent rows when the table has a timestamp col.
      // Keeps the "what's in here" preview current rather than showing
      // the oldest ingested records.
      const timeCol = await this.pickTimeColumn(p.conn, tableName);
      const orderBy = timeCol ? ` ORDER BY ${quoteIdent(timeCol)} DESC NULLS LAST` : "";
      const reader = await p.conn.runAndReadAll(
        `SELECT * FROM ${quoteIdent(tableName)}${orderBy} LIMIT 20`,
      );

      const rawRows = reader.getRows() as unknown[][];
      const sampleRows = rawRows.map((row) => row.map((val) => convertDuckDBValue(val)));

      return {
        catalog: entry,
        sampleRows,
        sampleColumns: reader.columnNames(),
      };
    });
  }

  /**
   * Most-recent N rows for a table, ordered by its timestamp column when
   * one can be identified. Used by the per-source "recent" endpoint so the
   * portal can show recent rows for pure-structured sources (Strava,
   * Screen Time) the same way it shows recent documents for Gmail etc.
   * The cursor keys on the table's primary key as the catalog describes
   * it; a cursor minted before the table keyed its rows by stream no longer
   * fits that key and is refused as invalid, so the caller starts over.
   */
  async getRecentRows(
    tableName: string,
    limit: number,
    after?: AnalyticsRecentCursor,
  ): Promise<{
    columns: string[];
    rows: unknown[][];
    cursors: AnalyticsRecentCursor[];
  }> {
    const catalog = await this.catalog.getCatalog();
    const entry = catalog.find((candidate) => candidate.tableName === tableName);
    if (!entry) return { columns: [], rows: [], cursors: [] };

    return this.pool.withConn(async (p) => {
      const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
      const timeCol = await this.pickTimeColumn(p.conn, tableName);
      const fallbackRowId = entry.primaryKey.length === 0;
      const keyColumns = fallbackRowId ? ["__omnesis_recent_rowid"] : entry.primaryKey;
      if (
        after &&
        (after.keyValues.length !== keyColumns.length ||
          !after.keyValues.every(isRecentCursorValue) ||
          !isRecentCursorValue(after.timeValue))
      ) {
        throw new InvalidAnalyticsRecentCursorError();
      }

      const columnTypes = new Map(entry.columns.map((column) => [column.name, column.type]));
      const keySpecs = keyColumns.map((name) => ({
        expression: fallbackRowId ? "rowid" : quoteIdent(name),
        type: fallbackRowId ? ("BIGINT" as ColumnType) : columnTypes.get(name),
      }));
      const binds: Record<string, AnalyticsRecentCursorValue> = {};
      let where = "";
      if (after) {
        const keyAfter = lexicographicAfter(keySpecs, after.keyValues, binds);
        if (timeCol) {
          const timeExpression = quoteIdent(timeCol);
          if (after.timeValue === null) {
            where = ` WHERE ${timeExpression} IS NULL AND (${keyAfter})`;
          } else {
            binds.recent_time = after.timeValue;
            const timeBind = castRecentBind("recent_time", columnTypes.get(timeCol));
            where =
              ` WHERE (${timeExpression} < ${timeBind}` +
              ` OR ${timeExpression} IS NULL` +
              ` OR (${timeExpression} = ${timeBind} AND (${keyAfter})))`;
          }
        } else {
          where = ` WHERE ${keyAfter}`;
        }
      }
      const orderParts = [
        ...(timeCol ? [`${quoteIdent(timeCol)} DESC NULLS LAST`] : []),
        ...keySpecs.map((column) => `${column.expression} ASC`),
      ];
      const hiddenRowId = fallbackRowId ? `, rowid AS ${quoteIdent("__omnesis_recent_rowid")}` : "";
      const sql =
        `SELECT *${hiddenRowId} FROM ${quoteIdent(tableName)}` +
        where +
        ` ORDER BY ${orderParts.join(", ")} LIMIT ${safeLimit}`;
      const reader =
        Object.keys(binds).length > 0
          ? await p.conn.runAndReadAll(sql, binds)
          : await p.conn.runAndReadAll(sql);
      const rawRows = reader.getRows() as unknown[][];
      const readerColumns = reader.columnNames();
      const converted = rawRows.map((row) => row.map((val) => convertDuckDBValue(val)));
      const timeIndex = timeCol ? readerColumns.indexOf(timeCol) : -1;
      const keyIndexes = keyColumns.map((column) => readerColumns.indexOf(column));
      const cursors = converted.map((row) => ({
        timeValue: timeIndex >= 0 ? recentCursorValue(row[timeIndex]) : null,
        keyValues: keyIndexes.map((index) => recentCursorValue(row[index])),
      }));
      if (!fallbackRowId) {
        return { columns: readerColumns, rows: converted, cursors };
      }
      const hiddenIndex = readerColumns.indexOf("__omnesis_recent_rowid");
      return {
        columns: readerColumns.filter((_, index) => index !== hiddenIndex),
        rows: converted.map((row) => row.filter((_, index) => index !== hiddenIndex)),
        cursors,
      };
    });
  }

  /**
   * Batched primary-key lookup for the cross-store graph walker. Fetch
   * the rows of `tableName` whose key columns match any of `keyTuples`; each
   * tuple aligns positionally with `keyColumns`. A column's optional `castType`
   * wraps the *bound value* in `CAST($v AS <type>)` so a string key (from a
   * document's `externalId`) matches a numeric column (Strava's BIGINT `id`).
   *
   * Returns a map from each tuple's canonical key (`values.map(String).join(NUL)`
   * — the caller computes the same to look a row up) to a projected row object.
   * Missing keys are simply absent: the synthesized `same-entity` edge
   * self-heals (no row → no edge), so a missing table or a CAST type-mismatch
   * resolves to "no rows", never an error that could break a walk.
   *
   * Runs on the pooled READ path, NOT the user-SQL sandbox in `executeQuery`
   * — this is an internal trusted lookup on a pooled connection. Key *values*
   * are always
   * bound (never interpolated): they originate from `externalId` and are
   * untrusted; only the table/column identifiers are `quoteIdent`-ed.
   */
  async getRowsByKeys(
    tableName: string,
    keyColumns: { name: string; castType?: ColumnType }[],
    keyTuples: (string | number)[][],
    opts?: { projection?: string[] },
  ): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    if (keyTuples.length === 0 || keyColumns.length === 0) return out;

    // De-dup identical tuples (several documents can bind the same row in a
    // multi-seed walk) so the OR-of-ANDs predicate stays minimal.
    const uniqueTuples = new Map<string, (string | number)[]>();
    for (const t of keyTuples) {
      if (t.length === keyColumns.length) uniqueTuples.set(canonicalRowKey(t), t);
    }
    if (uniqueTuples.size === 0) return out;

    // Projection always includes the key columns so result rows can be re-keyed.
    const keyColNames = keyColumns.map((c) => c.name);
    const projCols = opts?.projection
      ? Array.from(new Set([...keyColNames, ...opts.projection]))
      : null;
    const selectList = projCols ? projCols.map(quoteIdent).join(", ") : "*";

    const binds: Record<string, string | number> = {};
    const groups: string[] = [];
    let i = 0;
    for (const tuple of uniqueTuples.values()) {
      const conds = keyColumns.map((col, j) => {
        const bind = `k${i}_${j}`;
        binds[bind] = tuple[j];
        const ph = `$${bind}`;
        const expr =
          col.castType && col.castType !== "VARCHAR" ? `CAST(${ph} AS ${col.castType})` : ph;
        return `${quoteIdent(col.name)} = ${expr}`;
      });
      groups.push(`(${conds.join(" AND ")})`);
      i++;
    }

    const sql = `SELECT ${selectList} FROM ${quoteIdent(tableName)} WHERE ${groups.join(" OR ")}`;

    return this.pool.withConn(async (p) => {
      let reader;
      try {
        reader = await p.conn.runAndReadAll(sql, binds);
      } catch {
        return out;
      }
      const colNames = reader.columnNames();
      const keyIdx = keyColNames.map((n) => colNames.indexOf(n));
      for (const raw of reader.getRows() as unknown[][]) {
        const converted = raw.map((v) => convertDuckDBValue(v));
        const keyVals = keyIdx.map((idx) => converted[idx]);
        const obj: Record<string, unknown> = {};
        colNames.forEach((name, idx) => {
          obj[name] = converted[idx];
        });
        out.set(canonicalRowKey(keyVals), obj);
      }
      return out;
    });
  }

  /**
   * Best-effort guess at the timestamp column for previews / sparklines.
   * Shared by getTableInfo + getTableActivity so their choices stay in
   * sync. Takes a `conn` so callers can chain the lookup with their
   * already-acquired pool slot — avoids holding two conns for one
   * logical operation.
   */
  private async pickTimeColumn(conn: DuckDBConnection, tableName: string): Promise<string | null> {
    const infoReader = await conn.runAndReadAll(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${escapeStr(tableName)}'`,
    );
    const cols = (infoReader.getRows() as unknown[][]).map((r) => ({
      name: r[0] as string,
      type: String(r[1]).toUpperCase(),
    }));
    const preferred = [
      "start_time",
      "created_at",
      "recorded_at",
      "ingested_at",
      "date",
      "updated_at",
    ];
    return (
      preferred.find((p) => cols.some((c) => c.name === p)) ??
      cols.find((c) => c.type.includes("DATE") || c.type.includes("TIMESTAMP"))?.name ??
      null
    );
  }

  /**
   * Per-day row counts for the last `days` days, keyed off the first
   * DATE/TIMESTAMP column on the table (or `created_at` if present).
   * Returns `[]` when no timestamp column can be identified — the portal
   * handles that by hiding the sparkline.
   */
  async getTableActivity(
    tableName: string,
    days: number,
  ): Promise<{ day: string; count: number }[]> {
    return this.pool.withConn(async (p) => {
      const col = await this.pickTimeColumn(p.conn, tableName);
      if (!col) return [];

      const qCol = quoteIdent(col);
      const qTable = quoteIdent(tableName);
      // Cast to TIMESTAMP so DATE_TRUNC works regardless of the original type.
      const sql = `
        SELECT CAST(DATE_TRUNC('day', CAST(${qCol} AS TIMESTAMP)) AS VARCHAR) AS day,
               COUNT(*) AS count
        FROM ${qTable}
        WHERE CAST(${qCol} AS TIMESTAMP) > CURRENT_TIMESTAMP - INTERVAL '${days} days'
        GROUP BY day
        ORDER BY day
      `;

      try {
        const reader = await p.conn.runAndReadAll(sql);
        const rows = reader.getRows() as unknown[][];
        return rows.map((r) => ({
          day: String(r[0]).slice(0, 10),
          count: Number(r[1]),
        }));
      } catch {
        return [];
      }
    });
  }

  /**
   * Source ids whose analytics tables held at least one sample with a
   * semantic timestamp in the half-open range `[fromMs, toMs)` — the
   * analytics plane of the Briefs daily-batch discovery (health / financial
   * samples never land as documents). A table with no declared
   * `semanticTimeColumn` is skipped (its rows can't be positioned to a day);
   * a source is returned once even if several of its tables qualify. Cheap
   * by construction (one bounded existence probe per catalog table) and run
   * once a day. Generic — the signal is the semantic time column, never a
   * source name.
   */
  async listSourceIdsWithSamplesInRange(fromMs: number, toMs: number): Promise<string[]> {
    // Compare in epoch-ms (UTC), matching the document plane's absolute-time
    // scan — numeric bounds interpolate safely and dodge any ISO-string cast
    // quirks. `epoch_ms(CAST(col AS TIMESTAMP))` positions a DATE / TIMESTAMP
    // / parseable-VARCHAR column on the same axis.
    const from = Math.floor(fromMs);
    const to = Math.floor(toMs);
    const catalog = await this.catalog.getCatalog();
    const found = new Set<string>();
    for (const entry of catalog) {
      if (found.has(entry.sourceId)) continue;
      const table = await this.catalog.getTableSchema(entry.tableName);
      const timeCol = table?.schema.semanticTimeColumn;
      if (!timeCol) continue;
      const hit = await this.pool.withConn(async (p) => {
        const epoch = `epoch_ms(CAST(${quoteIdent(timeCol)} AS TIMESTAMP))`;
        const sql =
          `SELECT 1 FROM ${quoteIdent(entry.tableName)} ` +
          `WHERE ${epoch} >= ${from} AND ${epoch} < ${to} LIMIT 1`;
        try {
          const reader = await p.conn.runAndReadAll(sql);
          return (reader.getRows() as unknown[][]).length > 0;
        } catch {
          // A time column that can't cast to TIMESTAMP is not day-positionable
          // — skip it rather than fail the whole pass.
          return false;
        }
      });
      if (hit) found.add(entry.sourceId);
    }
    return [...found].sort();
  }
}

/**
 * Lowercase names of the store's non-internal macros, read on the sandbox
 * connection so the catalog context matches what the query will bind in.
 * A stored macro body can read any table while its call site names none,
 * so the source gate denies calls to these. Internal (builtin) macros are
 * excluded — a fresh store lists none of its own. A listing failure fails
 * the scoped query loudly as a query failure, never as a silent pass, so
 * engine drift surfaces in tests instead of opening the macro vector.
 */
async function listNonInternalMacros(conn: DuckDBConnection): Promise<string[]> {
  const reader = await conn.runAndReadAll(
    "SELECT function_name FROM duckdb_functions() WHERE function_type LIKE '%macro%' AND NOT internal",
  );
  return (reader.getRows() as unknown[][]).map((row) => String(row[0]).toLowerCase());
}
