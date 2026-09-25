// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { escapeStr } from "./internal.js";
import type { DuckDBConnection } from "@duckdb/node-api";

const TABLE = "_omnesis_internal.analytics_page_receipts";
export interface AnalyticsPageReceipt {
  pageId: string;
  ordinal: number;
  cursorRow: string;
  digest: string;
}
export class AnalyticsPageReceiptConflict extends Error {}

export async function ensureAnalyticsPageReceipts(conn: DuckDBConnection): Promise<void> {
  await conn.run(`CREATE SCHEMA IF NOT EXISTS _omnesis_internal`);
  await conn.run(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    source_id VARCHAR NOT NULL, cursor_row VARCHAR NOT NULL, stream_id VARCHAR NOT NULL,
    page_id VARCHAR NOT NULL, ordinal INTEGER NOT NULL, digest VARCHAR NOT NULL,
    ingested INTEGER NOT NULL, deleted INTEGER NOT NULL,
    PRIMARY KEY (source_id, cursor_row, stream_id, page_id, ordinal)
  )`);
}

const quote = (s: string) => `'${escapeStr(s)}'`;
function scope(sourceId: string, streamId: string, receipt: AnalyticsPageReceipt): string {
  return `source_id = ${quote(sourceId)} AND cursor_row = ${quote(receipt.cursorRow)} AND stream_id = ${quote(streamId)}`;
}

/** Read before ANY row, catalog, or replica-ledger mutation. */
export async function readAnalyticsPageReceipt(
  conn: DuckDBConnection,
  sourceId: string,
  streamId: string,
  receipt: AnalyticsPageReceipt,
): Promise<{ ingested: number; deleted: number; streamRekeyed: boolean } | undefined> {
  const reader = await conn.runAndReadAll(`SELECT digest, ingested, deleted FROM ${TABLE}
    WHERE ${scope(sourceId, streamId, receipt)} AND page_id = ${quote(receipt.pageId)} AND ordinal = ${receipt.ordinal}`);
  const row = reader.getRows()[0];
  if (!row) return undefined;
  if (row[0] !== receipt.digest)
    throw new AnalyticsPageReceiptConflict(
      "A retained source page changed during replay; restart the collector to reload its exact pending page",
    );
  return { ingested: Number(row[1]), deleted: Number(row[2]), streamRekeyed: false };
}

/** The receipt shares the mutation's DuckDB COMMIT, never merely its HTTP response. */
export async function recordAnalyticsPageReceipt(
  conn: DuckDBConnection,
  sourceId: string,
  streamId: string,
  receipt: AnalyticsPageReceipt,
  result: { ingested: number; deleted: number },
): Promise<void> {
  // A new active journal page makes older receipts in this cursor scope
  // unreachable. Never expire the active page: an offline collector may
  // return much later, and repeating its tombstones would destroy new rows.
  await conn.run(
    `DELETE FROM ${TABLE} WHERE ${scope(sourceId, streamId, receipt)} AND page_id <> ${quote(receipt.pageId)}`,
  );
  await conn.run(
    `INSERT INTO ${TABLE} VALUES (${quote(sourceId)}, ${quote(receipt.cursorRow)}, ${quote(streamId)}, ${quote(receipt.pageId)}, ${receipt.ordinal}, ${quote(receipt.digest)}, ${result.ingested}, ${result.deleted})`,
  );
}

export async function clearAnalyticsPageReceipts(
  conn: DuckDBConnection,
  sourceId: string,
  streamId?: string,
): Promise<void> {
  await conn.run(
    `DELETE FROM ${TABLE} WHERE source_id = ${quote(sourceId)}${streamId === undefined ? "" : ` AND stream_id = ${quote(streamId)}`}`,
  );
}
