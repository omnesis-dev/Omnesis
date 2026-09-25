// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `AnalyticsCatalogStore` — owns every read and write of the
 * `_analytics_catalog` table. Other sub-classes (`AnalyticsTableManager`,
 * `AnalyticsQueryRunner`) delegate catalog access here so the SQL for
 * the catalog row layout lives in one file.
 */

import { createLogger } from "@omnesis/core";
import { sourceTypeOf } from "@omnesis/types";
import { analyticsSchemaUsesDynamicColumns } from "@omnesis/source-sdk";
import { analyticsCatalogSchemaCodec } from "../data/json-columns.js";
import {
  buildBoundDocumentRegistry,
  type BoundDocumentBinding,
  type BoundDocumentCatalogRow,
} from "./bound-documents.js";
import {
  escapeStr,
  parseSchemaJson,
  quoteIdent,
  rowToObject,
  type CatalogRow,
  type CatalogSchemaJson,
  STREAM_COLUMN,
  STREAM_COLUMN_DEFINITION,
} from "./internal.js";
import type { AnalyticsCatalogEntry, AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { AnalyticsConnectionPool } from "./connection-pool.js";

const log = createLogger("gateway:analytics:catalog");

/** Metadata advertisements cannot turn an exclusive table into a shared one. */
function mergeCatalogOwner(previous: string | null, incoming: string): string {
  if (previous === null || previous === "" || previous === "unknown") return incoming;
  if (sourceTypeOf(previous) !== sourceTypeOf(incoming)) {
    throw new Error(`Analytics catalog ownership cannot move between source types`);
  }
  if (previous === incoming || incoming === sourceTypeOf(previous)) return previous;
  // A bare owner is ambiguous historical state; one account cannot claim it.
  return sourceTypeOf(incoming);
}

/**
 * Both spellings under which the catalog can record a source's ownership.
 *
 * A table one account owns outright is recorded under the full
 * `<type>:<account>` id; a table its sibling accounts share is recorded under
 * the bare type, because no single account owns it. A source asking about its
 * own tables has to reach either, so every reader of the catalog on a source's
 * behalf resolves ownership through here rather than re-deriving the pair.
 */
export function catalogOwnerIds(sourceId: string): readonly string[] {
  return [sourceId, sourceTypeOf(sourceId)];
}

export class AnalyticsCatalogStore {
  constructor(private readonly pool: AnalyticsConnectionPool) {}

  /**
   * Idempotent CREATE TABLE for `_analytics_catalog`. Called from the
   * façade's `open()` under the pool's first conn — every other catalog
   * read/write expects this table to exist.
   */
  async ensureCatalogTable(conn: DuckDBConnection): Promise<void> {
    await conn.run(`
      CREATE TABLE IF NOT EXISTS _analytics_catalog (
        table_name VARCHAR PRIMARY KEY,
        display_name VARCHAR NOT NULL,
        description VARCHAR NOT NULL,
        source_id VARCHAR NOT NULL,
        schema_json VARCHAR NOT NULL,
        record_count BIGINT DEFAULT 0,
        earliest_date VARCHAR,
        latest_date VARCHAR,
        created_at VARCHAR NOT NULL,
        updated_at VARCHAR NOT NULL,
        stream_keyed BOOLEAN DEFAULT false,
        ownership_backfill_pending BOOLEAN DEFAULT true
      )
    `);
    // DuckDB reapplies the DEFAULT to existing rows when `ADD COLUMN IF NOT
    // EXISTS` names an already-present column. Check explicitly so reopening
    // the database cannot turn a durable `true` adoption marker back to false.
    const streamKeyedColumn = await conn.runAndReadAll(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = '_analytics_catalog' AND column_name = 'stream_keyed' LIMIT 1`,
    );
    if (streamKeyedColumn.getRows().length === 0) {
      // A catalog created before tables could key by stream gains the column
      // here; it stays nullable and readers treat NULL as false.
      await conn.run(
        "ALTER TABLE _analytics_catalog ADD COLUMN stream_keyed BOOLEAN DEFAULT false",
      );
    }
    const ownershipColumn = await conn.runAndReadAll(
      "SELECT 1 FROM information_schema.columns WHERE table_name = '_analytics_catalog' AND column_name = 'ownership_backfill_pending' LIMIT 1",
    );
    if (ownershipColumn.getRows().length === 0) {
      await conn.run(
        "ALTER TABLE _analytics_catalog ADD COLUMN ownership_backfill_pending BOOLEAN DEFAULT true",
      );
    }
    // A gateway that ran the old unconditional ALTER may already have reset
    // the catalog bit while leaving the atomic physical rebuild intact. The
    // primary-key constraint is authoritative and makes this repair safe: a
    // merely namesake source column cannot opt a table into stream semantics.
    await conn.run(`
      UPDATE _analytics_catalog
         SET stream_keyed = true
       WHERE stream_keyed IS DISTINCT FROM true
         AND table_name IN (
           SELECT table_name
             FROM duckdb_constraints()
            WHERE constraint_type = 'PRIMARY KEY'
              AND list_contains(constraint_column_names, '${STREAM_COLUMN}')
         )
    `);
  }

  /**
   * Whether `tableName` keys its rows by device stream — its primary key ends
   * with the reserved stream column. One catalog read, so the ingest path
   * asks on every page.
   */
  async isStreamKeyed(conn: DuckDBConnection, tableName: string): Promise<boolean> {
    const reader = await conn.runAndReadAll(
      `SELECT stream_keyed FROM _analytics_catalog WHERE table_name = '${escapeStr(tableName)}'`,
    );
    return (reader.getRows() as unknown[][])[0]?.[0] === true;
  }

  /** Record that `tableName` keys its rows by device stream, inside the transaction that rebuilt it. */
  async markStreamKeyed(conn: DuckDBConnection, tableName: string): Promise<void> {
    await conn.run(
      `UPDATE _analytics_catalog SET stream_keyed = true WHERE table_name = '${escapeStr(tableName)}'`,
    );
  }

  /**
   * Upsert the catalog row for a table. Called from
   * `AnalyticsTableManager.ensureTable` inside the same write
   * transaction as the CREATE TABLE / ALTER TABLE so the row reflects
   * the schema the caller is about to insert against.
   */
  async upsertEntry(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const previousReader = await conn.runAndReadAll(
      `SELECT schema_json, source_id FROM _analytics_catalog WHERE table_name = '${escapeStr(schema.tableName)}'`,
    );
    const previousRows = previousReader.getRows() as unknown[][];
    const owner = mergeCatalogOwner(
      previousRows.length ? String(previousRows[0]![1]) : null,
      sourceId,
    );
    const previousSchema =
      previousRows.length > 0
        ? parseSchemaJson(String(previousRows[0]![0]), schema.tableName)
        : null;
    const previousColumns = new Map(
      (previousSchema?.columns ?? []).map((column) => [column.name, column]),
    );
    const dynamicColumns = analyticsSchemaUsesDynamicColumns(schema, previousSchema);
    const columns = schema.columns.map((column) => {
      const previous = previousColumns.get(column.name);
      const declaresCategoricalMetadata =
        column.allowedValues !== undefined ||
        column.canonicalValues !== undefined ||
        column.valueAliases !== undefined ||
        column.categoricalRole !== undefined;
      if (!previous || declaresCategoricalMetadata) return column;
      return {
        ...column,
        allowedValues: previous.allowedValues,
        canonicalValues: previous.canonicalValues,
        valueAliases: previous.valueAliases,
        categoricalRole: previous.categoricalRole,
      };
    });
    const protectedColumns = new Set([
      previousSchema?.sharedDiscriminatorColumn,
      previousSchema?.sharedDiscriminatorParent?.column,
    ]);
    if (!dynamicColumns || previousSchema?.sharedDiscriminatorColumn) {
      const currentNames = new Set(columns.map((column) => column.name));
      for (const previous of previousSchema?.columns ?? []) {
        if (
          !currentNames.has(previous.name) &&
          (!dynamicColumns || protectedColumns.has(previous.name))
        )
          columns.push(previous);
      }
    }
    const schemaJson = analyticsCatalogSchemaCodec.serialize({
      // An older paired mobile client does not know the categorical metadata
      // fields. Keep the last source-owned declaration instead of erasing it
      // on its next ingest; a current client can replace the declaration by
      // sending any of the fields.
      columns,
      dynamicColumns: dynamicColumns ? true : undefined,
      primaryKey: schema.primaryKey,
      // Kept the same way as the categorical metadata above: a client that
      // does not know the field must not erase the table's key space, which
      // every pending absence on it was recorded under.
      deleteKey: schema.deleteKey ?? previousSchema?.deleteKey,
      exampleQueries: schema.exampleQueries,
      // Persist so `deleteAnalyticsForSource` knows whether this table
      // is shared across siblings and what column to filter on.
      sharedDiscriminatorColumn:
        schema.sharedDiscriminatorColumn ?? previousSchema?.sharedDiscriminatorColumn,
      sharedDiscriminatorParent:
        schema.sharedDiscriminatorParent ?? previousSchema?.sharedDiscriminatorParent,
      // Persist the doc↔row binding so the graph walker can synthesize
      // `same-entity` edges from the catalog even when the source isn't syncing.
      boundDocument: schema.boundDocument,
      // Persist the record-citation contract so the cite-record path
      // derives the semantic time + title/key-fields from the declared schema
      // at read time — even when the source isn't currently syncing.
      semanticTimeColumn: schema.semanticTimeColumn,
      record: schema.record,
      temporalProjection: schema.temporalProjection,
    });

    await conn.run(`
      INSERT INTO _analytics_catalog (table_name, display_name, description, source_id, schema_json, created_at, updated_at)
      VALUES ('${escapeStr(schema.tableName)}', '${escapeStr(schema.displayName)}', '${escapeStr(schema.description)}', '${escapeStr(owner)}', '${escapeStr(schemaJson)}', '${now}', '${now}')
      ON CONFLICT (table_name) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        description = EXCLUDED.description,
        schema_json = EXCLUDED.schema_json,
        updated_at = EXCLUDED.updated_at,
        source_id = EXCLUDED.source_id
    `);
  }

  /**
   * Look up the primary key for a table from the catalog.
   *
   * Returns `[]` when the catalog row is missing OR when the stored
   * `schema_json` is corrupt (logged via `parseSchemaJson`). Callers
   * that treat `[]` as "no primary key" silently fall back to non-
   * upsert behaviour — that's the existing contract; corrupt JSON is
   * surfaced via the warn log so the data drift gets noticed instead
   * of producing duplicate rows on what should be an upsert.
   */
  async getPrimaryKey(tableName: string): Promise<string[]> {
    return this.pool.withConn(async (p) => {
      const reader = await p.conn.runAndReadAll(
        `SELECT schema_json FROM _analytics_catalog WHERE table_name = '${escapeStr(tableName)}'`,
      );
      const rows = reader.getRows();
      if (rows.length === 0) return [];
      const schema = parseSchemaJson(String(rows[0][0]), tableName);
      return schema?.primaryKey ?? [];
    });
  }

  /**
   * Full schema + identity for a single table, or `null` when the catalog has
   * no such row (or its `schema_json` is corrupt). Carries the persisted
   * `semanticTimeColumn` + `record` display spec and the
   * `boundDocument` binding — everything the cite-record path needs to derive
   * a record citation without re-deriving anything client-side.
   */
  async getTableSchema(tableName: string): Promise<{
    tableName: string;
    displayName: string;
    sourceId: string;
    schema: CatalogSchemaJson;
    streamKeyed: boolean;
  } | null> {
    return this.pool.withConn(async (p) => {
      const reader = await p.conn.runAndReadAll(
        `SELECT display_name, source_id, schema_json, stream_keyed FROM _analytics_catalog WHERE table_name = '${escapeStr(tableName)}'`,
      );
      const rows = reader.getRows();
      if (rows.length === 0) return null;
      const schema = parseSchemaJson(String(rows[0][2]), tableName);
      if (!schema) return null;
      return {
        tableName,
        displayName: String(rows[0][0]),
        sourceId: String(rows[0][1]),
        schema,
        streamKeyed: rows[0][3] === true,
      };
    });
  }

  /** Get the analytics catalog — all registered tables. */
  async getCatalog(): Promise<AnalyticsCatalogEntry[]> {
    return this.pool.withConn(async (p) => {
      const reader = await p.conn.runAndReadAll(
        "SELECT * FROM _analytics_catalog ORDER BY table_name",
      );

      const columns = reader.columnNames();
      const rows = reader.getRows() as unknown[][];

      // Map every row, skipping any whose schema_json is corrupt.
      // Older code threw on the first bad row, hiding every later
      // catalog entry from the UI — drop the bad row and warn-log
      // instead so the rest of the catalog still renders.
      const result: AnalyticsCatalogEntry[] = [];
      for (const row of rows) {
        const obj = rowToObject<CatalogRow>(columns, row);
        const schema = parseSchemaJson(obj.schema_json, obj.table_name);
        if (!schema) continue;
        // The entry describes the table as it is: a stream-keyed table lists
        // the stream column and a primary key that ends with it.
        const streamKeyed = obj.stream_keyed === true;
        result.push({
          tableName: obj.table_name,
          displayName: obj.display_name,
          description: obj.description,
          sourceId: obj.source_id,
          columns: streamKeyed ? [...schema.columns, STREAM_COLUMN_DEFINITION] : schema.columns,
          primaryKey: streamKeyed ? [...schema.primaryKey, STREAM_COLUMN] : schema.primaryKey,
          recordCount: Number(obj.record_count),
          earliestDate: obj.earliest_date,
          latestDate: obj.latest_date,
          exampleQueries: schema.exampleQueries,
          streamKeyed,
        });
      }
      return result;
    });
  }

  /**
   * Build the cross-store `boundDocument` registry from every catalog
   * row that declares one, keyed by bare source type. The graph walker uses it
   * to synthesize `same-entity` edges from a document's `externalId` without
   * the source being mid-sync. Cheap (one row per table); the façade caches it
   * and invalidates on `ensureTable` / source-id change / source removal.
   */
  async getBoundDocumentBindings(): Promise<Map<string, BoundDocumentBinding[]>> {
    return this.pool.withConn(async (p) => {
      const reader = await p.conn.runAndReadAll(
        "SELECT table_name, display_name, source_id, schema_json, stream_keyed FROM _analytics_catalog",
      );
      const rows = reader.getRows() as unknown[][];
      const catalogRows: BoundDocumentCatalogRow[] = [];
      for (const row of rows) {
        const tableName = String(row[0]);
        const schema = parseSchemaJson(String(row[3]), tableName);
        if (!schema?.boundDocument) continue;
        catalogRows.push({
          tableName,
          displayName: String(row[1]),
          sourceId: String(row[2]),
          primaryKey: schema.primaryKey,
          columns: schema.columns.map((c) => ({ name: c.name, type: c.type })),
          boundDocument: schema.boundDocument,
          streamKeyed: row[4] === true,
        });
      }
      return buildBoundDocumentRegistry(catalogRows);
    });
  }

  /**
   * Catalog rows whose `source_id` matches `sourceId` exactly OR matches
   * its bare type. Used by `AnalyticsTableManager.deleteAnalyticsForSource`
   * to decide which tables to drop vs. partial-clean per-row.
   */
  /**
   * The `source_id` currently recorded for a table, or `null` when the table
   * has no catalog row yet. A full `<type>:<account>` id means one source owns
   * the table exclusively; a bare type means siblings share it.
   */
  async readOwnerForTable(conn: DuckDBConnection, tableName: string): Promise<string | null> {
    const rows = await conn.runAndReadAll(
      `SELECT source_id FROM _analytics_catalog WHERE table_name = '${escapeStr(tableName)}'`,
    );
    const first = rows.getRows()[0];
    return first ? String(first[0]) : null;
  }

  async readEntriesForSource(
    conn: DuckDBConnection,
    sourceId: string,
  ): Promise<Array<{ tableName: string; sourceId: string; schema: CatalogSchemaJson | null }>> {
    const reader = await conn.runAndReadAll(
      `SELECT table_name, source_id, schema_json FROM _analytics_catalog
       WHERE source_id IN (${catalogOwnerIds(sourceId)
         .map((owner) => `'${escapeStr(owner)}'`)
         .join(", ")})`,
    );
    const rows = reader.getRows() as unknown[][];
    return rows.map((row) => {
      const tableName = String(row[0]);
      const catalogSourceId = String(row[1]);
      const schemaJson = String(row[2]);
      return {
        tableName,
        sourceId: catalogSourceId,
        schema: parseSchemaJson(schemaJson, tableName),
      };
    });
  }

  /**
   * Delete the catalog row for a table. Called by
   * `AnalyticsTableManager.deleteAnalyticsForSource` when a source's
   * exclusively-owned table has been dropped.
   */
  async deleteEntry(conn: DuckDBConnection, tableName: string): Promise<void> {
    await conn.run(`DELETE FROM _analytics_catalog WHERE table_name = '${escapeStr(tableName)}'`);
  }

  /** Update catalog stats (record count, date range) for a table. */
  async updateStats(tableName: string, qTable: string): Promise<void> {
    return this.pool.serializeWrite(() =>
      this.pool.withConn(async (p) => {
        // Get record count
        const countReader = await p.conn.runAndReadAll(`SELECT COUNT(*) as cnt FROM ${qTable}`);
        const count = Number((countReader.getRows() as unknown[][])[0][0]);

        // Prefer the source-declared semantic time axis. Older catalog rows
        // predate that contract and retain the deterministic legacy fallback.
        let earliest: string | null = null;
        let latest: string | null = null;

        try {
          const schemaReader = await p.conn.runAndReadAll(
            `SELECT schema_json FROM _analytics_catalog WHERE table_name = '${escapeStr(tableName)}'`,
          );
          const schemaRows = schemaReader.getRows() as unknown[][];
          const schema =
            schemaRows.length > 0 ? parseSchemaJson(String(schemaRows[0]![0]), tableName) : null;
          let dateColumn: string | null = null;

          if (schema?.semanticTimeColumn !== undefined) {
            dateColumn = schema.semanticTimeColumn;
          } else if (schema) {
            const infoReader = await p.conn.runAndReadAll(
              `SELECT column_name
               FROM information_schema.columns
               WHERE table_name = '${escapeStr(tableName)}'
                 AND (data_type LIKE '%DATE%'
                   OR data_type LIKE '%TIMESTAMP%'
                   OR column_name IN ('date', 'start_date', 'end_date', 'created_at', 'recorded_at'))
               ORDER BY ordinal_position`,
            );
            dateColumn = String((infoReader.getRows() as unknown[][])[0]?.[0] ?? "") || null;
          }

          if (dateColumn) {
            const qDateColumn = quoteIdent(dateColumn);
            const rangeReader = await p.conn.runAndReadAll(
              `SELECT MIN(${qDateColumn})::VARCHAR, MAX(${qDateColumn})::VARCHAR FROM ${qTable}`,
            );
            const rangeRow = (rangeReader.getRows() as unknown[][])[0];
            earliest = rangeRow[0] as string | null;
            latest = rangeRow[1] as string | null;
          }
        } catch {
          // Ignore — date detection is best-effort
        }

        const now = new Date().toISOString();
        await p.conn.run(`
        UPDATE _analytics_catalog
        SET record_count = ${count},
            earliest_date = ${earliest ? `'${escapeStr(earliest)}'` : "NULL"},
            latest_date = ${latest ? `'${escapeStr(latest)}'` : "NULL"},
            updated_at = '${now}'
        WHERE table_name = '${escapeStr(tableName)}'
      `);
      }),
    );
  }

  /**
   * Update the source_id in the catalog for a table.
   * Useful when a table was initially created with "unknown" sourceId.
   */
  async updateSourceId(tableName: string, sourceId: string): Promise<void> {
    return this.pool.serializeWrite(() =>
      this.pool.withConn((p) => this.claimSource(p.conn, tableName, sourceId)),
    );
  }

  /** Claim data ownership inside the same transaction as a schema-less page. */
  async claimSource(conn: DuckDBConnection, tableName: string, sourceId: string): Promise<void> {
    const previous = await this.readOwnerForTable(conn, tableName);
    const owner = mergeCatalogOwner(previous, sourceId);
    if (owner !== previous)
      await conn.run(`
        UPDATE _analytics_catalog
        SET source_id = '${escapeStr(owner)}'
        WHERE table_name = '${escapeStr(tableName)}'
      `);
  }

  // Reference the logger so a future warn-once in this file doesn't
  // need to re-import — keeps it scoped to catalog concerns.
  protected get log() {
    return log;
  }
}
