// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { yieldToEventLoop } from "../async-yield.js";
import type Database from "better-sqlite3";

export interface StorageMonthUsage {
  month: string;
  documents: number;
  payloadBytes: number;
  trimmableDocuments?: number;
}
export interface StorageSourceUsage {
  sourceId: string;
  documents: number;
  payloadBytes: number;
  months: StorageMonthUsage[];
}
export interface StorageTableUsage {
  name: string;
  bytes: number;
}
export interface StorageAccounting {
  measuredAt: string;
  /** UTF-8 document fields only; shared database/index overhead is not attributed to a source. */
  attribution: "logical-payload";
  sources: StorageSourceUsage[];
  database: { allocatedBytes: number; reusableBytes: number; tables: StorageTableUsage[] | null };
}
export interface StorageAccountingMetadata {
  sourceIds: string[];
  upperRowid: number;
  database: StorageAccounting["database"];
}
export interface StorageAccountingPageRow {
  rowid: number;
  sourceId: string;
  month: string;
  payloadBytes: number;
  trimmableDocuments?: number;
}
export interface StorageAccountingReads {
  storageAccountingMetadata(): Promise<StorageAccountingMetadata>;
  storageAccountingPage(
    afterRowid: number,
    upperRowid: number,
  ): Promise<StorageAccountingPageRow[]>;
}

/** The read worker releases each statement's shared lock before the next page is requested. */
export function storageAccountingPage(
  db: Database.Database,
  afterRowid: number,
  upperRowid: number,
): StorageAccountingPageRow[] {
  return db
    .prepare<[number, number], StorageAccountingPageRow>(
      `SELECT rowid, source_id AS sourceId,
      COALESCE(strftime('%Y-%m', source_created_at), 'unknown') AS month,
      octet_length(content) + octet_length(title) + octet_length(metadata) AS payloadBytes,
      CASE WHEN COALESCE(json_extract(metadata, '$.documentType'), '') <> 'contact'
        AND (source_created_at = strftime('%Y-%m-%dT%H:%M:%fZ', source_created_at)
          OR source_created_at = strftime('%Y-%m-%dT%H:%M:%SZ', source_created_at))
        THEN 1 ELSE 0 END AS trimmableDocuments
     FROM documents WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT 500`,
    )
    .all(afterRowid, upperRowid);
}

/** Cheap metadata never scans Btrees; physical table allocation is published independently. */
export function storageAccountingMetadata(db: Database.Database): StorageAccountingMetadata {
  const sourceIds = db
    .prepare<[], { id: string }>("SELECT id FROM sources ORDER BY id")
    .all()
    .map((row) => row.id);
  const upperRowid = db
    .prepare<[], { maximum: number }>("SELECT COALESCE(MAX(rowid), 0) AS maximum FROM documents")
    .get()!.maximum;
  const pageSize = Number(db.pragma("page_size", { simple: true }));
  const pages = Number(db.pragma("page_count", { simple: true }));
  const freePages = Number(db.pragma("freelist_count", { simple: true }));
  return {
    sourceIds,
    upperRowid,
    database: {
      allocatedBytes: pageSize * pages,
      reusableBytes: pageSize * freePages,
      tables: null,
    },
  };
}

/**
 * Aggregate bounded read-worker pages without holding a corpus-wide SQLite
 * snapshot. The initial rowid ceiling makes continuous ingestion finite;
 * concurrent edits/deletions make this a dated estimate, not a transactionally
 * exact inventory. No document contents cross the worker boundary.
 */
export async function measureStorageAccounting(
  reads: StorageAccountingReads,
  now: () => Date = () => new Date(),
): Promise<StorageAccounting> {
  const metadata = await reads.storageAccountingMetadata();
  const sources = new Map<
    string,
    {
      sourceId: string;
      documents: number;
      payloadBytes: number;
      months: Map<string, StorageMonthUsage>;
    }
  >();
  const sourceEntry = (sourceId: string) => {
    let entry = sources.get(sourceId);
    if (!entry) {
      entry = { sourceId, documents: 0, payloadBytes: 0, months: new Map() };
      sources.set(sourceId, entry);
    }
    return entry;
  };
  for (const sourceId of metadata.sourceIds) sourceEntry(sourceId);
  let after = 0;
  while (after < metadata.upperRowid) {
    const rows = await reads.storageAccountingPage(after, metadata.upperRowid);
    if (rows.length === 0) break;
    for (const row of rows) {
      const source = sourceEntry(row.sourceId);
      source.documents++;
      source.payloadBytes += row.payloadBytes;
      const month = source.months.get(row.month) ?? {
        month: row.month,
        documents: 0,
        payloadBytes: 0,
        trimmableDocuments: 0,
      };
      month.documents++;
      month.payloadBytes += row.payloadBytes;
      month.trimmableDocuments = (month.trimmableDocuments ?? 0) + (row.trimmableDocuments ?? 0);
      source.months.set(row.month, month);
    }
    after = rows[rows.length - 1]!.rowid;
    await yieldToEventLoop();
  }
  return {
    measuredAt: now().toISOString(),
    attribution: "logical-payload",
    database: metadata.database,
    sources: [...sources.values()]
      .map((source) => ({
        ...source,
        months: [...source.months.values()].sort((a, b) => a.month.localeCompare(b.month)),
      }))
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
  };
}
