// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure logic for the cross-store `boundDocument` binding (#450): turn a
 * source's declarative `BoundDocumentSpec` into the concrete row-key the
 * graph walker looks up, and back.
 *
 * No DB access — `AnalyticsCatalogStore` reads the catalog and hands rows in;
 * `DocumentGraphService` calls `reconstructRowKey` per document vertex. Kept
 * pure so the inversion (document `externalId` → row primary key) is unit-
 * testable without a DuckDB instance.
 */

import { parseSourceKey } from "@omnesis/core";
import { STREAM_COLUMN } from "./internal.js";
import type { BoundDocumentSpec, ColumnType } from "@omnesis/core";

/**
 * A `boundDocument` declaration resolved against its table's catalog metadata
 * — everything the walker needs to invert a document `externalId` into the
 * row's primary key and cast it for the DuckDB lookup.
 */
export interface BoundDocumentBinding {
  tableName: string;
  tableDisplayName: string;
  /** Catalog `source_id` that owns the table (a bare type when shared). */
  sourceId: string;
  /** Primary-key column order — the key is always built in this order. */
  primaryKey: string[];
  /** Every column name in declared order — for a bounded default projection. */
  columns: string[];
  /** Declared DuckDB type of every column, for the lookup cast. */
  columnTypes: Record<string, ColumnType>;
  spec: BoundDocumentSpec;
  /**
   * The table keys its rows by device stream: a row key is the declared key
   * plus the document's stream, so a partitioned source's namesake rows from
   * two devices resolve to their own documents. Absent on a hand-built
   * binding, which keys by the declared columns alone.
   */
  streamKeyed?: boolean;
}

/** A reconstructed row primary key, ready for `getRowsByKeys`. */
export interface BoundRowKey {
  /** Key columns in primary-key order, with the cast type for each. */
  keyColumns: { name: string; castType?: ColumnType }[];
  /** Key values in the same order (all strings — sourced from `externalId`). */
  keyValues: string[];
  /** `:`-joined key value — the addressing half of the row vertex id. */
  pkString: string;
}

/** Minimal catalog row shape `buildBoundDocumentRegistry` consumes. */
export interface BoundDocumentCatalogRow {
  tableName: string;
  displayName: string;
  sourceId: string;
  primaryKey: string[];
  columns: { name: string; type: ColumnType }[];
  boundDocument?: BoundDocumentSpec;
  /** The table keys its rows by device stream (it carries the reserved stream column). */
  streamKeyed?: boolean;
}

/**
 * Canonical match key joining a tuple of values — NUL-separated so a value
 * containing the human-facing `:` separator can't collide. Both
 * `AnalyticsQueryRunner.getRowsByKeys` (re-keying result rows) and the walker
 * (looking a row up) must form keys identically, so they share this.
 */
/**
 * The slice of the analytics layer the cross-store consumers need — the graph
 * walker (`attachBoundRows`) and the search pipeline (`boundRow` hydration).
 * `AnalyticsDb` satisfies it structurally; a fake satisfies it in tests.
 * Keeping the port here (with the binding logic) means neither consumer
 * depends on the whole DuckDB façade.
 */
export interface BoundRowResolver {
  getBoundDocumentBindings(): Promise<Map<string, BoundDocumentBinding[]>>;
  getRowsByKeys(
    tableName: string,
    keyColumns: { name: string; castType?: ColumnType }[],
    keyTuples: (string | number)[][],
    opts?: { projection?: string[] },
  ): Promise<Map<string, Record<string, unknown>>>;
}

export function canonicalRowKey(values: unknown[]): string {
  return values.map((v) => String(v)).join("\u0000");
}

/**
 * Build the `sourceType → bindings` registry from catalog rows. Keyed by the
 * bare source TYPE (the part before `:` in a source-id) so a document's
 * `<type>:<accountId>` source-id resolves regardless of which account wrote
 * the row, and so a table shared across sibling instances (its catalog
 * source_id collapsed to the bare type) still matches.
 */
export function buildBoundDocumentRegistry(
  rows: BoundDocumentCatalogRow[],
): Map<string, BoundDocumentBinding[]> {
  const out = new Map<string, BoundDocumentBinding[]>();
  for (const row of rows) {
    if (!row.boundDocument) continue;
    const columnTypes: Record<string, ColumnType> = {};
    for (const c of row.columns) columnTypes[c.name] = c.type;
    const binding: BoundDocumentBinding = {
      tableName: row.tableName,
      tableDisplayName: row.displayName,
      sourceId: row.sourceId,
      primaryKey: row.primaryKey,
      columns: row.columns.map((c) => c.name),
      columnTypes,
      spec: row.boundDocument,
      streamKeyed: row.streamKeyed === true,
    };
    const type = parseSourceKey(row.sourceId).sourceType;
    const list = out.get(type);
    if (list) list.push(binding);
    else out.set(type, [binding]);
  }
  return out;
}

/**
 * Invert a document into the primary key of its bound row, or `null` when the
 * document is not bound to this table (its `externalId` lacks the required
 * prefix, or doesn't decompose into the expected number of components).
 * Returning `null` rather than throwing is deliberate: a non-match is normal
 * (a source can own several tables, only one of which a given document binds).
 */
export function reconstructRowKey(
  doc: { externalId: string; sourceId: string; streamId?: string },
  binding: BoundDocumentBinding,
): BoundRowKey | null {
  const spec = binding.spec;

  let raw = doc.externalId;
  if (spec.externalIdPrefix) {
    if (!raw.startsWith(spec.externalIdPrefix)) return null;
    raw = raw.slice(spec.externalIdPrefix.length);
  }

  const sep = spec.externalIdSeparator ?? ":";
  // Only split for a genuinely composite externalId — a single-column binding
  // keeps the whole (possibly `:`-containing) value intact (calendar event_id).
  const parts = spec.externalIdColumns.length > 1 ? raw.split(sep) : [raw];
  if (parts.length !== spec.externalIdColumns.length) return null;

  const valueByColumn = new Map<string, string>();
  spec.externalIdColumns.forEach((col, i) => valueByColumn.set(col, parts[i]));
  if (spec.sourceKeyColumns?.length) {
    const accountId = parseSourceKey(doc.sourceId).accountId;
    for (const col of spec.sourceKeyColumns) valueByColumn.set(col, accountId);
  }

  // Build the key in primary-key order so the vertex id and the lookup are
  // deterministic regardless of how the spec listed the columns.
  const keyColumns: { name: string; castType?: ColumnType }[] = [];
  const keyValues: string[] = [];
  for (const col of binding.primaryKey) {
    const value = valueByColumn.get(col);
    if (value === undefined) return null; // validated away at definition time; defensive
    keyColumns.push({ name: col, castType: binding.columnTypes[col] });
    keyValues.push(value);
  }
  if (binding.streamKeyed) {
    keyColumns.push({ name: STREAM_COLUMN, castType: "VARCHAR" });
    keyValues.push(doc.streamId ?? "");
  }

  return { keyColumns, keyValues, pkString: keyValues.join(":") };
}

/**
 * The reconstructed `(provider/source identity, externalId)` of the document
 * bound to a row — the inverse of {@link reconstructRowKey} (#757). The
 * cite-record path uses it to resolve a row back to its co-described document
 * id without walking the graph: given a row's primary-key column values and
 * the table's binding, rebuild the document's `externalId` and its owning
 * `sourceId`, then look the document up by `(source_id, external_id)`.
 */
export interface BoundDocumentRef {
  /**
   * The bound document's `externalId` — `externalIdColumns` values joined by
   * the spec's separator (single-column bindings keep the value intact), with
   * the `externalIdPrefix` re-applied.
   */
  externalId: string;
  /**
   * The owning `sourceId`. When the binding uses `sourceKeyColumns` (a shared
   * table discriminated per account), the accountId comes from those PK
   * columns and the source id is `${sourceType}:${accountId}`. Otherwise the
   * binding's catalog `sourceId` is used as-is (the bare type for a shared
   * table the source owns outright, or `type:account` for a single owner).
   */
  sourceId: string;
}

/**
 * Invert a row's primary key back into the `(sourceId, externalId)` of its
 * bound document — the row→document direction (#757), mirroring
 * {@link reconstructRowKey} (document→row). Returns `null` when the binding's
 * required columns aren't all present in `pkValues` (defensive; the catalog
 * validator guarantees the binding reconstructs the full PK, so the columns
 * are always present for a well-formed `RecordReference`).
 *
 * `pkValues` is keyed by column name — the `{name, value}` pairs of a
 * `RecordReference.primaryKeyColumns`.
 */
export function reconstructBoundDocumentRef(
  pkValues: ReadonlyMap<string, string>,
  binding: BoundDocumentBinding,
): BoundDocumentRef | null {
  const spec = binding.spec;

  const sep = spec.externalIdSeparator ?? ":";
  const parts: string[] = [];
  for (const col of spec.externalIdColumns) {
    const value = pkValues.get(col);
    if (value === undefined) return null;
    parts.push(value);
  }
  const externalId = (spec.externalIdPrefix ?? "") + parts.join(sep);

  let sourceId = binding.sourceId;
  if (spec.sourceKeyColumns?.length) {
    // The accountId is carried on the PK column(s) the binding filled from the
    // document's source identity. They all hold the same accountId, so the
    // first is sufficient. The bare source TYPE comes from the binding's
    // catalog source id (shared tables collapse it to the bare type).
    const accountId = pkValues.get(spec.sourceKeyColumns[0]);
    if (accountId === undefined) return null;
    const sourceType = parseSourceKey(binding.sourceId).sourceType;
    sourceId = `${sourceType}:${accountId}`;
  }

  return { externalId, sourceId };
}
