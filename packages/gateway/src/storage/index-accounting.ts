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
  /** SQLite page allocation; null when this SQLite build has no dbstat support. */
  tables: { name: string; bytes: number }[] | null;
  lexicalBytes: number | null;
  /** Logical vector payload, separate from graph files and SQLite page overhead. */
  embeddingBytes: number;
  sources: IndexSourceStorage[];
}

/**
 * Runs on the index worker, never the HTTP thread. Source attribution measures
 * logical payload; physical tables include shared overhead and cannot be added
 * to payload. Bounded keyset pages yield without keeping SQLite iterators open.
 * Concurrent indexing may change the inventory while this estimate is gathered.
 */
export async function readIndexStorageAccounting(
  db: Database.Database,
  now: () => Date = () => new Date(),
): Promise<IndexStorageAccounting> {
  let tables: IndexStorageAccounting["tables"] = null;
  try {
    tables = db
      .prepare<[], { name: string; bytes: number }>(
        "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name",
      )
      .all();
  } catch (error) {
    if (!(error instanceof Error) || !/no such (table|module).*dbstat/i.test(error.message))
      throw error;
  }
  const lexicalBytes =
    tables === null
      ? null
      : tables.reduce(
          (total, table) => total + (table.name.startsWith("chunks_fts") ? table.bytes : 0),
          0,
        );
  const page = db.prepare<
    [number, number],
    {
      rowid: number;
      sourceId: string;
      month: string;
      textBytes: number;
      embeddingBytes: number;
    }
  >(`SELECT rowid, source_id AS sourceId,
    COALESCE(strftime('%Y-%m', source_created_at), 'unknown') AS month,
    LENGTH(CAST(content AS BLOB)) + LENGTH(CAST(title AS BLOB)) AS textBytes,
    COALESCE(LENGTH(embedding), 0) AS embeddingBytes
    FROM chunks WHERE rowid > ? ORDER BY rowid LIMIT ?`);
  const upper = db
    .prepare<[], { maximum: number }>("SELECT COALESCE(MAX(rowid), 0) AS maximum FROM chunks")
    .get()!.maximum;
  const sources = new Map<string, IndexSourceStorage>();
  let after = 0;
  let embeddingBytes = 0;
  while (after < upper) {
    const rows = page.all(after, 1000);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.rowid > upper) break;
      const key = JSON.stringify([row.sourceId, row.month]);
      const source = sources.get(key) ?? {
        sourceId: row.sourceId,
        month: row.month,
        chunkCount: 0,
        textBytes: 0,
        embeddingBytes: 0,
      };
      source.chunkCount += 1;
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
    tables,
    lexicalBytes,
    embeddingBytes,
    sources: [...sources.values()].sort(
      (a, b) => a.sourceId.localeCompare(b.sourceId) || a.month.localeCompare(b.month),
    ),
  };
}
