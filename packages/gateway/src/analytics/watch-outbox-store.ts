// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Durable hand-off from analytics ingest to the Watch journal.
 *
 * The page is inserted on the analytics writer's existing transaction. A
 * committed analytics mutation therefore always has the durable input Watch
 * needs, while a rolled-back mutation leaves neither. The internal schema
 * keeps these payloads out of corpus exports, including from older binaries
 * that know nothing about this table and export only `main`.
 */

import { escapeStr } from "./internal.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { AnalyticsConnectionPool } from "./connection-pool.js";

const SCHEMA = "_omnesis_internal";
const TABLE = `${SCHEMA}.watch_analytics_outbox`;
const SEQUENCE = `${SCHEMA}.watch_analytics_outbox_seq`;
/** Keep every read/JSON decode bounded independently of provider page size. */
const CHUNK_ROWS = 500;

export interface WatchOutboxCapture {
  readonly observedAt: number;
  readonly backfill: boolean;
}

export interface WatchOutboxCursor {
  readonly pageSeq: number;
  readonly rowOffset: number;
}

export interface WatchOutboxRow {
  readonly at: number;
  readonly table: string;
  readonly sourceId: string;
  readonly row: Record<string, unknown>;
  readonly schema: AnalyticsTableSchema;
  readonly backfill: boolean;
}

export interface WatchOutboxBatch {
  readonly rows: WatchOutboxRow[];
  readonly next: WatchOutboxCursor;
  readonly pending: boolean;
}

export interface WatchOutboxStats {
  readonly committedCursor: WatchOutboxCursor;
  readonly producerHead: number;
  readonly pendingChunks: number;
  readonly pendingRows: number;
  readonly oldestPendingAtMs: number | null;
  readonly retainedChunks: number;
  readonly retainedRows: number;
  readonly retainedBytes: number;
}

interface StoredPage {
  pageSeq: number;
  table: string;
  sourceId: string;
  streamId: string;
  observedAt: number;
  backfill: boolean;
  schema: AnalyticsTableSchema;
  records: Record<string, unknown>[];
}

export class WatchAnalyticsOutboxStore {
  constructor(private readonly pool: AnalyticsConnectionPool) {}

  async ensureTable(conn: DuckDBConnection): Promise<void> {
    await conn.run(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await conn.run(`CREATE SEQUENCE IF NOT EXISTS ${SEQUENCE} START 1`);
    await conn.run(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
         page_seq BIGINT PRIMARY KEY,
         table_name VARCHAR NOT NULL,
         source_id VARCHAR NOT NULL,
         stream_id VARCHAR NOT NULL,
         observed_at_ms BIGINT NOT NULL,
         backfill BOOLEAN NOT NULL,
         schema_json VARCHAR NOT NULL,
         records_json VARCHAR NOT NULL,
         row_count INTEGER NOT NULL,
         consumed_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
       )`,
    );
  }

  /** Called inside `AnalyticsTableManager.ingestPage`'s open transaction. */
  async append(
    conn: DuckDBConnection,
    input: {
      table: string;
      sourceId: string;
      streamId: string;
      schema: AnalyticsTableSchema;
      records: readonly Record<string, unknown>[];
      capture: WatchOutboxCapture;
    },
  ): Promise<void> {
    if (input.records.length === 0) return;
    for (let offset = 0; offset < input.records.length; offset += CHUNK_ROWS) {
      const records = input.records.slice(offset, offset + CHUNK_ROWS);
      await conn.run(
        `INSERT INTO ${TABLE}
           (page_seq, table_name, source_id, stream_id, observed_at_ms, backfill, schema_json, records_json, row_count)
         VALUES (
           nextval('${SEQUENCE}'),
           '${escapeStr(input.table)}',
           '${escapeStr(input.sourceId)}',
           '${escapeStr(input.streamId)}',
           ${input.capture.observedAt},
           ${input.capture.backfill ? "TRUE" : "FALSE"},
           '${escapeStr(JSON.stringify(input.schema))}',
           '${escapeStr(JSON.stringify(records))}',
           ${records.length}
         )`,
      );
    }
  }

  async read(cursor: WatchOutboxCursor, limit: number): Promise<WatchOutboxBatch> {
    return this.pool.withConn(async (p) => {
      const maxReader = await p.conn.runAndReadAll(`SELECT max(page_seq) FROM ${TABLE}`);
      const max = Number((maxReader.getRows() as unknown[][])[0]?.[0] ?? 0);
      // `max + 1` is the ordinary completed cursor. Anything beyond it came
      // from a newer watch.db restore and must be clamped. An empty outbox
      // paired with a non-zero cursor is the inverse mismatched restore.
      const start =
        max === 0
          ? { pageSeq: 0, rowOffset: 0 }
          : cursor.pageSeq > max + 1
            ? { pageSeq: max, rowOffset: 0 }
            : cursor;
      const reader = await p.conn.runAndReadAll(
        `SELECT page_seq, table_name, source_id, stream_id, observed_at_ms, backfill, schema_json, records_json
           FROM ${TABLE}
          WHERE page_seq >= ${Math.max(0, start.pageSeq)}
          ORDER BY page_seq
          LIMIT ${Math.max(1, Math.ceil((limit + start.rowOffset) / CHUNK_ROWS) + 1)}`,
      );
      const pages = (reader.getRows() as unknown[][]).map(toPage);
      if (pages.length === 0) return { rows: [], next: start, pending: false };
      const rows: WatchOutboxRow[] = [];
      let next = start;
      for (const page of pages) {
        if (rows.length >= limit) break;
        const offset = page.pageSeq === next.pageSeq ? next.rowOffset : 0;
        const records = page.records.slice(offset, offset + (limit - rows.length));
        rows.push(
          ...records.map((row) => ({
            at: page.observedAt,
            table: page.table,
            sourceId: page.sourceId,
            row,
            schema: page.schema,
            backfill: page.backfill,
          })),
        );
        const finished = offset + records.length >= page.records.length;
        next = finished
          ? { pageSeq: page.pageSeq + 1, rowOffset: 0 }
          : { pageSeq: page.pageSeq, rowOffset: offset + records.length };
        if (!finished) break;
      }
      return {
        rows,
        next,
        pending: next.pageSeq <= max,
      };
    });
  }

  async stats(cursor: WatchOutboxCursor): Promise<WatchOutboxStats> {
    return this.pool.withConn(async (p) => {
      const reader = await p.conn.runAndReadAll(
        `SELECT
           COALESCE(max(page_seq), 0),
           count(*),
           COALESCE(sum(row_count), 0),
           COALESCE(sum(length(records_json)), 0),
           count(*) FILTER (WHERE page_seq >= ${cursor.pageSeq}),
           COALESCE(sum(row_count) FILTER (WHERE page_seq >= ${cursor.pageSeq}), 0),
           epoch_ms(min(created_at) FILTER (WHERE page_seq >= ${cursor.pageSeq}))
         FROM ${TABLE}`,
      );
      const row = (reader.getRows() as unknown[][])[0] ?? [];
      return {
        committedCursor: cursor,
        producerHead: Number(row[0] ?? 0),
        retainedChunks: Number(row[1] ?? 0),
        retainedRows: Number(row[2] ?? 0),
        retainedBytes: Number(row[3] ?? 0),
        pendingChunks: Number(row[4] ?? 0),
        pendingRows: Math.max(0, Number(row[5] ?? 0) - cursor.rowOffset),
        oldestPendingAtMs: row[6] === null || row[6] === undefined ? null : Number(row[6]),
      };
    });
  }

  /** Mark pages consumed only after the Watch transaction committed. */
  async acknowledge(beforePageSeq: number): Promise<void> {
    await this.pool.serializeWrite(() =>
      this.pool.withConn(async (p) => {
        await p.conn.run(
          `UPDATE ${TABLE}
              SET consumed_at = COALESCE(consumed_at, current_timestamp)
            WHERE page_seq < ${Math.max(0, beforePageSeq)}
              AND consumed_at IS NULL`,
        );
      }),
    );
  }

  /** Remove retained personal rows when their owning source is removed. */
  async deleteSource(conn: DuckDBConnection, sourceId: string): Promise<void> {
    await conn.run(`DELETE FROM ${TABLE} WHERE source_id = '${escapeStr(sourceId)}'`);
  }

  async deleteStream(conn: DuckDBConnection, sourceId: string, streamId: string): Promise<void> {
    await conn.run(
      `DELETE FROM ${TABLE}
        WHERE source_id = '${escapeStr(sourceId)}'
          AND stream_id = '${escapeStr(streamId)}'`,
    );
  }

  /**
   * Retire pages Watch has committed, after a backup-safe grace period.
   * The newest page is always retained so a restored cursor can be clamped to
   * an unambiguous sequence watermark.
   */
  async prune(beforePageSeq: number, olderThanMs: number): Promise<void> {
    await this.pool.serializeWrite(() =>
      this.pool.withConn(async (p) => {
        await p.conn.run(
          `DELETE FROM ${TABLE}
            WHERE page_seq < ${Math.max(0, beforePageSeq)}
              AND consumed_at < to_timestamp(${olderThanMs} / 1000.0)`,
        );
      }),
    );
  }

  /** Startup cleanup also runs when the experimental Watch host stays off. */
  async pruneOnConnection(conn: DuckDBConnection, olderThanMs: number): Promise<void> {
    await conn.run(
      `DELETE FROM ${TABLE}
        WHERE consumed_at < to_timestamp(${olderThanMs} / 1000.0)`,
    );
  }
}

function toPage(row: unknown[]): StoredPage {
  return {
    pageSeq: Number(row[0]),
    table: String(row[1]),
    sourceId: String(row[2]),
    streamId: String(row[3]),
    observedAt: Number(row[4]),
    backfill: Boolean(row[5]),
    schema: JSON.parse(String(row[6])) as AnalyticsTableSchema,
    records: JSON.parse(String(row[7])) as Record<string, unknown>[],
  };
}
