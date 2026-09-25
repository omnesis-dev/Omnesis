// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared types + helpers for the analytics layer. All cross-class concerns
 * live here so the four sub-classes (`AnalyticsConnectionPool`,
 * `AnalyticsCatalogStore`, `AnalyticsTableManager`, `AnalyticsQueryRunner`)
 * are leaf modules that depend only on this and on each other through
 * explicit constructor injection.
 *
 * Nothing in this file should be exported from `analytics-db.ts`'s public
 * surface — the façade re-exports `AnalyticsDb` and the legacy types only.
 */

import { DuckDBDecimalValue, type DuckDBConnection } from "@duckdb/node-api";
import { ANALYTICS_STREAM_COLUMN } from "@omnesis/source-sdk";
import { analyticsCatalogSchemaCodec } from "../data/json-columns.js";
import type {
  AnalyticsTableSchema,
  AnalyticsTemporalProjectionSpec,
  BoundDocumentSpec,
  ColumnDefinition,
  RecordDisplaySpec,
} from "@omnesis/source-sdk";

/**
 * One pool slot. Carries the underlying DuckDB connection. The pool
 * fans writes/reads across N conns (DuckDB MVCC handles isolation);
 * user SQL runs on a dedicated connection of the same instance
 * (`withSandboxStatement`), never on a pool slot.
 */
export interface PooledConn {
  conn: DuckDBConnection;
}

/**
 * Catalog row stored in the _analytics_catalog table.
 */
export interface CatalogRow {
  table_name: string;
  display_name: string;
  description: string;
  source_id: string;
  schema_json: string;
  record_count: number;
  earliest_date: string | null;
  latest_date: string | null;
  created_at: string;
  updated_at: string;
  /** The table keys its rows by device stream (its primary key ends with the stream column); NULL on a row written before the column existed. */
  stream_keyed: boolean | null;
}

/**
 * Shape we expect inside the catalog's `schema_json` column. Subset of
 * `AnalyticsTableSchema` plus the optional `sharedDiscriminatorColumn`
 * field that older `ensureTable` writes added. `getCatalog` /
 * `getPrimaryKey` / `deleteAnalyticsForSource` all read this column —
 * before the unified parser they each handled malformed JSON
 * differently (one swallowed errors silently, another threw inside an
 * iterator). The helper below logs and returns null on failure so
 * every caller can branch on null with explicit, consistent behaviour.
 */
export interface CatalogSchemaJson {
  columns: ColumnDefinition[];
  dynamicColumns?: true;
  primaryKey: string[];
  exampleQueries?: AnalyticsTableSchema["exampleQueries"];
  sharedDiscriminatorColumn?: string;
  sharedDiscriminatorParent?: AnalyticsTableSchema["sharedDiscriminatorParent"];
  /**
   * The 1:1 doc↔row binding (#450), persisted so the graph walker can
   * synthesize `same-entity` edges at read time from the catalog without the
   * source being mid-sync. Survives the catalog codec's `.passthrough()`.
   */
  boundDocument?: BoundDocumentSpec;
  /**
   * The declared semantic-time column (or explicit `null` for a timeless
   * table), persisted so a record citation reads the true event-time column
   * the source declared — not the query-runner's `pickTimeColumn` heuristic
   * (#757). Survives the catalog codec's `.passthrough()`. Older catalog rows
   * written before this field existed read back as `undefined`; the record
   * port treats `undefined` like `null` (not timeline-eligible until re-synced).
   */
  semanticTimeColumn?: string | null;
  /**
   * How to title a row and which columns to surface as its key fields when it
   * is cited as a record (#757). Persisted so the gateway derives the
   * client-ready title/key-fields without any source-specific code. Absent on
   * pre-#757 catalog rows.
   */
  record?: RecordDisplaySpec;
  /** Explicit source-owned temporal projection contract, when opted in. */
  temporalProjection?: AnalyticsTemporalProjectionSpec;
  /**
   * The columns a delete or a snapshot addresses this table by, when it is
   * not the primary key. Persisted because it is the key space every ledger
   * on this table records under: a table addressed one way on one page and
   * another way on the next would leave keys from both behind.
   */
  deleteKey?: string[];
}

export function parseSchemaJson(raw: string, tableName: string): CatalogSchemaJson | null {
  const parsed = analyticsCatalogSchemaCodec.parseWithFallback(raw, { rowId: tableName });
  return parsed as unknown as CatalogSchemaJson | null;
}

/**
 * Convert DuckDB result values to plain JS types.
 * DuckDB returns wrapper objects (DuckDBListValue, etc.) that need
 * conversion to plain arrays/objects for JSON serialization.
 */
export function convertDuckDBValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "bigint") return Number(val);
  if (typeof val !== "object") return val;
  if (val instanceof Date) return val.toISOString();
  // DECIMAL columns come back as DuckDBDecimalValue wrappers (scaled
  // bigint + width/scale). Return the exact scale-padded decimal string
  // — converting to a JS number would reintroduce the IEEE-754 rounding
  // that DECIMAL columns exist to avoid. Decimals nested inside list
  // values are covered too: the list branch below recurses through here.
  if (val instanceof DuckDBDecimalValue) return val.toString();
  // DuckDB list values have an `items` property (DuckDBListValue)
  if (
    "items" in (val as Record<string, unknown>) &&
    Array.isArray((val as { items: unknown[] }).items)
  ) {
    return (val as { items: unknown[] }).items.map(convertDuckDBValue);
  }
  try {
    JSON.stringify(val);
    return val;
  } catch {
    return String(val);
  }
}

export function escapeStr(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Quote a DuckDB identifier (table / column name) safely. We accept
 * only ASCII letters, digits, and underscore — every analytics
 * descriptor in the catalog stays inside that set, and rejecting
 * everything else is the simplest defence against SQL injection via
 * a crafted column name. Throws on the first byte that doesn't fit.
 */
export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "list_value()";
    const elements = value.map((el) =>
      el === null || el === undefined ? "NULL" : `'${escapeStr(String(el))}'`,
    );
    return `list_value(${elements.join(", ")})`;
  }
  if (typeof value === "object") {
    return `'${escapeStr(JSON.stringify(value))}'`;
  }
  return `'${escapeStr(String(value))}'`;
}

export function rowToObject<T>(columns: string[], row: unknown[]): T {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = row[i];
  }
  return obj as T;
}

/**
 * The reserved column that keys a table's rows by device stream once several
 * devices of one source write it; `ANALYTICS_STREAM_COLUMN` in the SDK, where
 * sources are refused from declaring it.
 */
/**
 * The tables the analytics plane keeps for itself: the catalog, the temporal
 * projection read model, and the pending-absence ledger. They are gateway
 * bookkeeping, not the operator's data, so nothing that walks the database as
 * a corpus — the CSV export above all — should see them.
 *
 * One list, because the alternative is a literal repeated at each walker and a
 * new internal table silently leaking into whichever one was not updated.
 */
export const ANALYTICS_INTERNAL_TABLES = [
  "_analytics_catalog",
  "_analytics_absences",
  "_analytics_absence_scopes",
  "_analytics_absence_observations",
  "_temporal_projections",
  "_temporal_projection_sources",
] as const;

export const STREAM_COLUMN = ANALYTICS_STREAM_COLUMN;

/** How the catalog describes the stream column on a table that carries it. */
export const STREAM_COLUMN_DEFINITION: ColumnDefinition = {
  name: STREAM_COLUMN,
  type: "VARCHAR",
  description: "The device stream that contributed the row; empty for a source with one stream",
};
