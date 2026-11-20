// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { yieldToEventLoop } from "../async-yield.js";
import type Database from "better-sqlite3";

export interface IndexSourceStorage {
  sourceId: string;
  /** Source creation month; unknown dates are kept in an explicit bucket. */
  month: string;
  chunkCount: number;
  textBytes: number;
  embeddingBytes: number;
}

export interface IndexStorageAccounting {
  measuredAt: string;
  /** Independently measured SQLite allocation; null until a complete scan is available. */
  tables: { name: string; bytes: number }[] | null;
  lexicalBytes: number | null;
  /** Logical vector payload, separate from graph files and SQLite page overhead. */
  embeddingBytes: number;
  sources: IndexSourceStorage[];
}

export interface IndexAccountingPageRow {
  rowid: number;
  sourceId: string;
  month: string;
  textBytes: number;
  embeddingBytes: number;
}
export interface IndexAccountingReads {
  storageIndexAccountingMetadata(): Promise<{ upperRowid: number }>;
  storageIndexAccountingPage(
    afterRowid: number,
    upperRowid: number,
  ): Promise<IndexAccountingPageRow[]>;
}

export function storageIndexAccountingMetadata(db: Database.Database): { upperRowid: number } {
  return {
    upperRowid: db
      .prepare<[], { maximum: number }>("SELECT COALESCE(MAX(rowid),0) AS maximum FROM chunks")
      .get()!.maximum,
  };
}

/** Each keyset page releases its read transaction before another scheduler turn. */
export function storageIndexAccountingPage(
  db: Database.Database,
  afterRowid: number,
  upperRowid: number,
): IndexAccountingPageRow[] {
  return db
    .prepare<[number, number], IndexAccountingPageRow>(
      `SELECT rowid, source_id AS sourceId,
    COALESCE(strftime('%Y-%m', source_created_at), 'unknown') AS month,
    octet_length(content) + octet_length(title) AS textBytes,
    COALESCE(LENGTH(embedding), 0) AS embeddingBytes
    FROM chunks WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 1000`,
    )
    .all(afterRowid, upperRowid);
}

/**
 * Physical allocation is independent; logical payload never waits on dbstat.
 * Each page releases its snapshot. Concurrent ingestion, deletion or embedding
 * generation changes make the bounded result a dated estimate.
 */
export async function measureIndexStorageAccounting(
  reads: IndexAccountingReads,
  now: () => Date = () => new Date(),
): Promise<IndexStorageAccounting> {
  const { upperRowid: upper } = await reads.storageIndexAccountingMetadata();
  const sources = new Map<string, IndexSourceStorage>();
  let after = 0;
  let embeddingBytes = 0;
  while (after < upper) {
    const rows = await reads.storageIndexAccountingPage(after, upper);
    if (rows.length === 0) break;
    for (const row of rows) {
      const key = JSON.stringify([row.sourceId, row.month]);
      const source = sources.get(key) ?? {
        sourceId: row.sourceId,
        month: row.month,
        chunkCount: 0,
        textBytes: 0,
        embeddingBytes: 0,
      };
      source.chunkCount++;
      source.textBytes += row.textBytes;
      source.embeddingBytes += row.embeddingBytes;
      embeddingBytes += row.embeddingBytes;
      sources.set(key, source);
    }
    after = rows[rows.length - 1]!.rowid;
    await yieldToEventLoop();
  }
  return {
    measuredAt: now().toISOString(),
    tables: null,
    lexicalBytes: null,
    embeddingBytes,
    sources: [...sources.values()].sort(
      (a, b) => a.sourceId.localeCompare(b.sourceId) || a.month.localeCompare(b.month),
    ),
  };
}
