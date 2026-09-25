// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `AnalyticsTemporalProjectionStore` owns the DuckDB-backed deterministic
 * temporal projection read model: internal DDL, connection-scoped
 * materialization/deletion/contract retirement, coverage, and queries.
 *
 * Write methods accept the caller's `DuckDBConnection` so
 * `AnalyticsTableManager.ingestPage` can keep analytics rows and their
 * projections in one transaction. Read methods acquire a pooled connection.
 */

import {
  createLogger,
  MAX_TIME_ZONE_SHIFT_MS,
  TEMPORAL_KINDS,
  TEMPORAL_MODALITIES,
  TEMPORAL_STATUSES,
  temporalVocabularyCheck,
} from "@omnesis/core";
import { escapeStr, formatValue, parseSchemaJson, quoteIdent } from "./internal.js";
import {
  deriveAnalyticsProjection,
  sameProjectionContract,
  serializeRecordKey,
} from "./temporal-projection-derivation.js";
import type { AnalyticsTableSchema, AnalyticsTemporalProjectionSpec } from "@omnesis/source-sdk";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { AnalyticsConnectionPool } from "./connection-pool.js";

const log = createLogger("gateway:analytics:temporal-projections");

export const TEMPORAL_PROJECTIONS_TABLE = "_temporal_projections";
export const TEMPORAL_PROJECTION_SOURCES_TABLE = "_temporal_projection_sources";

export interface AnalyticsTemporalProjectionRow {
  id: string;
  sourceId: string;
  tableName: string;
  recordKey: string;
  slot: string;
  documentExternalId: string | null;
  startMs: number;
  endExclusiveMs: number;
  startCanonical: string;
  endCanonical: string;
  precision: "instant" | "day";
  allDay: boolean;
  timeZone: string | null;
  label: string;
  kind: string;
  modality: string;
  status: string;
  sourceUpdatedAt: string | null;
  correlationKeys: string | null;
  projectedAt: string;
}

export interface AnalyticsTemporalProjectionCoverageRow {
  sourceId: string;
  tableName: string;
  slots: string[];
  lastMaterializedAt: string | null;
}

export interface AnalyticsTemporalProjectionQuery {
  fromMs: number;
  toMs: number;
  sourceIds?: string[];
  kinds?: string[];
  modalities?: string[];
  statuses?: string[];
  ids?: string[];
  entityDocumentRefs?: Array<{ sourceId: string; externalId: string }>;
  documentRefs?: Array<{ sourceId: string; externalId: string }>;
  after?: { startMs: number; endExclusiveMs: number; originRank: number; id: string };
  limit?: number;
}

export class AnalyticsTemporalProjectionStore {
  constructor(private readonly pool: AnalyticsConnectionPool) {}

  /** Internal projection storage is deliberately absent from the user catalog. */
  async ensureTables(conn: DuckDBConnection): Promise<void> {
    await conn.run(`
      CREATE TABLE IF NOT EXISTS ${TEMPORAL_PROJECTIONS_TABLE} (
        id VARCHAR PRIMARY KEY,
        source_id VARCHAR NOT NULL,
        table_name VARCHAR NOT NULL,
        record_key VARCHAR NOT NULL,
        slot VARCHAR NOT NULL,
        bound_document_external_id VARCHAR,
        start_ms BIGINT NOT NULL,
        end_exclusive_ms BIGINT NOT NULL,
        start_canonical VARCHAR NOT NULL,
        end_canonical VARCHAR NOT NULL,
        precision VARCHAR NOT NULL,
        all_day BOOLEAN NOT NULL,
        time_zone VARCHAR,
        label VARCHAR NOT NULL,
        kind VARCHAR NOT NULL CHECK (${temporalVocabularyCheck("kind", TEMPORAL_KINDS)}),
        modality VARCHAR NOT NULL CHECK (${temporalVocabularyCheck("modality", TEMPORAL_MODALITIES)}),
        status VARCHAR NOT NULL CHECK (${temporalVocabularyCheck("status", TEMPORAL_STATUSES)}),
        source_updated_at VARCHAR,
        correlation_keys VARCHAR,
        projected_at VARCHAR NOT NULL
      )
    `);
    // Retire any row the current vocabulary can no longer describe. DuckDB
    // cannot add a CHECK to a table that already exists, so this is what keeps
    // an upgraded install consistent with the constraint above — and it costs
    // nothing, because an analytics projection is re-derived from its source
    // on the next sync exactly as a changed contract would force.
    await conn.run(
      `DELETE FROM ${TEMPORAL_PROJECTIONS_TABLE}
       WHERE NOT (${temporalVocabularyCheck("kind", TEMPORAL_KINDS)})
          OR NOT (${temporalVocabularyCheck("modality", TEMPORAL_MODALITIES)})
          OR NOT (${temporalVocabularyCheck("status", TEMPORAL_STATUSES)})`,
    );
    // No secondary index: DuckDB's explicit non-unique ART indexes can reach a
    // stored state in which deleting through them fails fatally and
    // invalidates the store (duckdb/duckdb#23645), and a source removal deletes
    // every projection the source owns. Window and per-source filters are
    // served by DuckDB's per-block min/max statistics. A store may still carry
    // these indexes; dropping them also repairs one in that state.
    await conn.run(`DROP INDEX IF EXISTS idx_temporal_projections_window`);
    await conn.run(`DROP INDEX IF EXISTS idx_temporal_projections_source`);
    await conn.run(`
      CREATE TABLE IF NOT EXISTS ${TEMPORAL_PROJECTION_SOURCES_TABLE} (
        source_id VARCHAR NOT NULL,
        table_name VARCHAR NOT NULL,
        slots_json VARCHAR NOT NULL,
        last_materialized_at VARCHAR,
        PRIMARY KEY (source_id, table_name)
      )
    `);
  }

  async retireChangedContract(
    conn: DuckDBConnection,
    sourceId: string,
    tableName: string,
    previous: AnalyticsTemporalProjectionSpec | undefined,
    next: AnalyticsTemporalProjectionSpec | undefined,
  ): Promise<void> {
    if (!previous || sameProjectionContract(previous, next)) return;
    await conn.run(
      `DELETE FROM ${TEMPORAL_PROJECTIONS_TABLE}
       WHERE source_id = '${escapeStr(sourceId)}'
         AND table_name = '${escapeStr(tableName)}'`,
    );
  }

  serializeRecordKey(primaryKey: readonly string[], record: Record<string, unknown>): string {
    return serializeRecordKey(primaryKey, record);
  }

  async replaceIncoming(
    conn: DuckDBConnection,
    tableName: string,
    records: Record<string, unknown>[],
    schema: AnalyticsTableSchema,
    sourceId: string,
    /** The columns a record's key is made of — the declared key, plus the stream for a stream-keyed table. */
    recordKey: readonly string[] = schema.primaryKey,
  ): Promise<void> {
    const spec = schema.temporalProjection;
    if (!spec || records.length === 0) return;
    const projectedAt = new Date().toISOString();
    const deduped = new Map<string, Record<string, unknown>>();
    for (const record of records) {
      const key = serializeRecordKey(recordKey, record);
      deduped.set(key, record);
    }

    await this.deleteKeys(conn, sourceId, tableName, [...deduped.keys()]);
    for (const [recordKey, record] of deduped) {
      // A null derivation means the spec's eligibility gate declined this row.
      // A value that cannot be canonicalized costs this row's projection and
      // nothing else: the row itself lands in the same page, and a page of
      // analytics must not be rejected over derived metadata about one of its
      // rows.
      let projection;
      try {
        projection = deriveAnalyticsProjection({
          schema,
          spec,
          sourceId,
          record,
          recordKey,
          projectedAt,
        });
      } catch (error) {
        log.warn(
          `Skipped temporal projection '${spec.slot}' for ${sourceId} ${tableName} ${recordKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!projection) continue;
      const columns = [
        "id",
        "source_id",
        "table_name",
        "record_key",
        "slot",
        "bound_document_external_id",
        "start_ms",
        "end_exclusive_ms",
        "start_canonical",
        "end_canonical",
        "precision",
        "all_day",
        "time_zone",
        "label",
        "kind",
        "modality",
        "status",
        "source_updated_at",
        "correlation_keys",
        "projected_at",
      ] as const;
      const values = columns.map((column) => formatValue(projection[column]));
      await conn.run(
        `INSERT INTO ${TEMPORAL_PROJECTIONS_TABLE} (${columns.map(quoteIdent).join(", ")})
         VALUES (${values.join(", ")})
         ON CONFLICT (id) DO UPDATE SET
           bound_document_external_id = EXCLUDED.bound_document_external_id,
           start_ms = EXCLUDED.start_ms,
           end_exclusive_ms = EXCLUDED.end_exclusive_ms,
           start_canonical = EXCLUDED.start_canonical,
           end_canonical = EXCLUDED.end_canonical,
           precision = EXCLUDED.precision,
           all_day = EXCLUDED.all_day,
           time_zone = EXCLUDED.time_zone,
           label = EXCLUDED.label,
           kind = EXCLUDED.kind,
           modality = EXCLUDED.modality,
           status = EXCLUDED.status,
           source_updated_at = EXCLUDED.source_updated_at,
           correlation_keys = EXCLUDED.correlation_keys,
           projected_at = EXCLUDED.projected_at`,
      );
    }
  }

  async deleteKeys(
    conn: DuckDBConnection,
    sourceId: string,
    tableName: string,
    recordKeys: string[],
  ): Promise<void> {
    if (recordKeys.length === 0) return;
    await conn.run(
      `DELETE FROM ${TEMPORAL_PROJECTIONS_TABLE}
       WHERE source_id = '${escapeStr(sourceId)}'
         AND table_name = '${escapeStr(tableName)}'
         AND record_key IN (${recordKeys.map((key) => `'${escapeStr(key)}'`).join(", ")})`,
    );
  }

  async recordCoverage(
    conn: DuckDBConnection,
    sourceId: string,
    tableName: string,
    schema: AnalyticsTableSchema,
  ): Promise<void> {
    if (!schema.temporalProjection) {
      // The schema declaration is authoritative. Contract retirement must
      // remove facts emitted under the old contract; merely hiding coverage
      // would leave stale projections queryable forever.
      await conn.run(
        `DELETE FROM ${TEMPORAL_PROJECTIONS_TABLE}
         WHERE source_id = '${escapeStr(sourceId)}'
           AND table_name = '${escapeStr(tableName)}'`,
      );
      await conn.run(
        `DELETE FROM ${TEMPORAL_PROJECTION_SOURCES_TABLE}
         WHERE source_id = '${escapeStr(sourceId)}'
           AND table_name = '${escapeStr(tableName)}'`,
      );
      return;
    }
    // A slot is part of projection identity. If a source replaces that slot,
    // retire facts from the previous declaration without deriving replacements
    // for rows the source did not emit on this page (the no-backfill rule).
    await conn.run(
      `DELETE FROM ${TEMPORAL_PROJECTIONS_TABLE}
       WHERE source_id = '${escapeStr(sourceId)}'
         AND table_name = '${escapeStr(tableName)}'
         AND slot <> '${escapeStr(schema.temporalProjection.slot)}'`,
    );
    const materializedAt = new Date().toISOString();
    await conn.run(
      `INSERT INTO ${TEMPORAL_PROJECTION_SOURCES_TABLE}
         (source_id, table_name, slots_json, last_materialized_at)
       VALUES (
         '${escapeStr(sourceId)}',
         '${escapeStr(tableName)}',
         '${escapeStr(JSON.stringify([schema.temporalProjection.slot]))}',
         '${materializedAt}'
       )
       ON CONFLICT (source_id, table_name) DO UPDATE SET
         slots_json = EXCLUDED.slots_json,
         last_materialized_at = EXCLUDED.last_materialized_at`,
    );
  }

  async deleteForSource(conn: DuckDBConnection, sourceId: string): Promise<void> {
    await conn.run(
      `DELETE FROM ${TEMPORAL_PROJECTIONS_TABLE}
       WHERE source_id = '${escapeStr(sourceId)}'`,
    );
    await conn.run(
      `DELETE FROM ${TEMPORAL_PROJECTION_SOURCES_TABLE}
       WHERE source_id = '${escapeStr(sourceId)}'`,
    );
  }

  async query(input: AnalyticsTemporalProjectionQuery): Promise<AnalyticsTemporalProjectionRow[]> {
    return this.pool.withConn(async (p) => {
      // DATE projections are stored canonically and interpreted in the query's
      // time zone by the federation layer, so a UTC-materialized boundary can
      // sit up to one zone shift away from the same calendar day in the
      // reader's zone. Widen by that bound on both sides; the exact overlap
      // test is applied afterwards in the reader's zone.
      const where = [
        `start_ms < ${Math.trunc(input.toMs + MAX_TIME_ZONE_SHIFT_MS)}`,
        `end_exclusive_ms > ${Math.trunc(input.fromMs - MAX_TIME_ZONE_SHIFT_MS)}`,
      ];
      const inList = (values: string[]) =>
        values.map((value) => `'${escapeStr(value)}'`).join(", ");
      if (input.sourceIds?.length) where.push(`source_id IN (${inList(input.sourceIds)})`);
      if (input.kinds?.length) where.push(`kind IN (${inList(input.kinds)})`);
      if (input.modalities?.length) where.push(`modality IN (${inList(input.modalities)})`);
      if (input.statuses?.length) where.push(`status IN (${inList(input.statuses)})`);
      if (input.ids !== undefined) {
        const entityTerms: string[] = [];
        if (input.ids.length > 0) entityTerms.push(`id IN (${inList(input.ids)})`);
        if (input.entityDocumentRefs?.length) {
          entityTerms.push(
            input.entityDocumentRefs
              .map(
                (ref) =>
                  `(source_id = '${escapeStr(ref.sourceId)}' AND ` +
                  `bound_document_external_id = '${escapeStr(ref.externalId)}')`,
              )
              .join(" OR "),
          );
        }
        if (entityTerms.length === 0) return [];
        where.push(`(${entityTerms.join(" OR ")})`);
      }
      if (input.documentRefs) {
        if (input.documentRefs.length === 0) return [];
        where.push(
          `(${input.documentRefs
            .map(
              (ref) =>
                `(source_id = '${escapeStr(ref.sourceId)}' AND ` +
                `bound_document_external_id = '${escapeStr(ref.externalId)}')`,
            )
            .join(" OR ")})`,
        );
      }
      if (input.after) {
        const after = input.after;
        const sameEndTail =
          after.originRank < 0
            ? "TRUE"
            : after.originRank === 0
              ? `id > '${escapeStr(after.id)}'`
              : "FALSE";
        where.push(
          `(start_ms > ${Math.trunc(after.startMs)}
            OR (start_ms = ${Math.trunc(after.startMs)} AND end_exclusive_ms > ${Math.trunc(after.endExclusiveMs)})
            OR (start_ms = ${Math.trunc(after.startMs)}
                AND end_exclusive_ms = ${Math.trunc(after.endExclusiveMs)}
                AND ${sameEndTail}))`,
        );
      }

      const limitClause =
        input.limit === undefined ? "" : `\n         LIMIT ${Math.max(1, Math.trunc(input.limit))}`;
      const reader = await p.conn.runAndReadAll(
        `SELECT
           id, source_id, table_name, record_key, slot,
           bound_document_external_id, start_ms, end_exclusive_ms,
           start_canonical, end_canonical, precision, all_day, time_zone,
           label, kind, modality, status, source_updated_at,
           correlation_keys, projected_at
         FROM ${TEMPORAL_PROJECTIONS_TABLE}
         WHERE ${where.join(" AND ")}
         ORDER BY start_ms, end_exclusive_ms, id${limitClause}`,
      );
      return (reader.getRows() as unknown[][]).map((row) => ({
        id: String(row[0]),
        sourceId: String(row[1]),
        tableName: String(row[2]),
        recordKey: String(row[3]),
        slot: String(row[4]),
        documentExternalId: row[5] == null ? null : String(row[5]),
        startMs: Number(row[6]),
        endExclusiveMs: Number(row[7]),
        startCanonical: String(row[8]),
        endCanonical: String(row[9]),
        precision: String(row[10]) === "day" ? "day" : "instant",
        allDay: row[11] === true,
        timeZone: row[12] == null ? null : String(row[12]),
        label: String(row[13]),
        kind: String(row[14]),
        modality: String(row[15]),
        status: String(row[16]),
        sourceUpdatedAt: row[17] == null ? null : String(row[17]),
        correlationKeys: row[18] == null ? null : String(row[18]),
        projectedAt: String(row[19]),
      }));
    });
  }

  async getCoverage(): Promise<AnalyticsTemporalProjectionCoverageRow[]> {
    return this.pool.withConn(async (p) => {
      const reader = await p.conn.runAndReadAll(
        `SELECT source_id, table_name, slots_json, last_materialized_at
         FROM ${TEMPORAL_PROJECTION_SOURCES_TABLE}
         ORDER BY source_id, table_name`,
      );
      return (reader.getRows() as unknown[][]).map((row) => {
        let slots: string[] = [];
        try {
          const parsed = JSON.parse(String(row[2]));
          if (Array.isArray(parsed)) {
            slots = parsed.filter((value): value is string => typeof value === "string");
          }
        } catch {
          // Corrupt internal coverage should not hide otherwise valid facts.
        }
        return {
          sourceId: String(row[0]),
          tableName: String(row[1]),
          slots,
          lastMaterializedAt: row[3] == null ? null : String(row[3]),
        };
      });
    });
  }

  async getSpecialistSources(): Promise<
    Array<{ sourceId: string; tableName: string; semanticTime: boolean }>
  > {
    return this.pool.withConn(async (p) => {
      const reader = await p.conn.runAndReadAll(
        "SELECT table_name, source_id, schema_json FROM _analytics_catalog ORDER BY source_id, table_name",
      );
      const result: Array<{ sourceId: string; tableName: string; semanticTime: boolean }> = [];
      for (const row of reader.getRows() as unknown[][]) {
        const tableName = String(row[0]);
        const schema = parseSchemaJson(String(row[2]), tableName);
        if (!schema || schema.temporalProjection) continue;
        result.push({
          sourceId: String(row[1]),
          tableName,
          semanticTime: schema.semanticTimeColumn != null,
        });
      }
      return result;
    });
  }
}
