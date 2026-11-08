// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The durable position of an in-progress indexing scan.
 *
 * `indexUpdated` walks the documents updated at or after its watermark in id
 * order. The walk used to live only in memory, so a restart discarded it: the
 * next boot started the walk again from the first id, and on a large backlog
 * a pass that takes longer than the gap between restarts never finished.
 *
 * The scan now records, in index.db's `watermark` table under one key, the
 * bounds it was started with and the last id through which every page is
 * committed. A later `indexUpdated` — after a restart or a cooperative stop —
 * resumes from that id with the same bounds, so it neither repeats the pages
 * already committed nor skips the ones it never reached:
 *
 *  - `since` is the watermark the scan began from (null: the whole corpus).
 *    Keeping it fixed keeps the resumed walk over the same set of documents.
 *  - `boundary` is the highest committed `updated_at` when the scan began. The
 *    watermark the finished scan publishes is capped at it, so every write
 *    after the scan began — including one to a document the cursor had already
 *    passed — is at or after the next scan's watermark.
 *  - `afterId` only ever names a page whose writes are committed: a page whose
 *    embedding is still in flight is not counted until it is written.
 *  - `maxSeen` is the running maximum `updated_at` of the documents the scan
 *    completed, which the finished scan publishes (capped at `boundary`).
 *
 * The record lives in the `watermark` table on purpose: every path that
 * invalidates the index (`invalidateSemanticIndex`) clears that table, and
 * with it any scan whose committed prefix would no longer be true.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;

export const SCAN_PROGRESS_KEY = "scan_progress";

/**
 * The `last_updated_at` value a complete scan published, when that scan
 * covered everything before it: a scan of the whole corpus, or one that began
 * from a watermark already verified this way. Earlier versions also advanced
 * `last_updated_at` when a scan was interrupted, past documents it never
 * reached, so a watermark without this mark may be one of those; the boot-time
 * reset only distrusts a watermark that lacks it.
 */
export const VERIFIED_WATERMARK_KEY = "last_updated_at_verified";

export type ScanPressure = "none" | "user" | "wal";

export interface ScanProgress {
  version: 1;
  /** Watermark the scan began from; null scans the whole corpus. */
  since: string | null;
  /** Highest committed `updated_at` when the scan began. */
  boundary: string | null;
  /** Last id through which every page is committed; null before the first page. */
  afterId: string | null;
  /** Highest `updated_at` among the documents the scan completed. */
  maxSeen: string | null;
  /** When the scan began, ISO. */
  startedAt: string;
  /** Times the scan was resumed after a stop or restart. */
  resumes: number;
  /** When the current run of the scan began (start or last resume), ISO. */
  runStartedAt: string;
  /** Documents the scan has completed, across every run. */
  scanned: number;
  /** Documents newly indexed by the scan, across every run. */
  indexed: number;
  /** Documents completed by the current run. */
  runScanned: number;
  /** Documents newly indexed by the current run. */
  runIndexed: number;
  /** Scan page size and pause in effect for the last page. */
  pageSize: number;
  sleepMs: number;
  /** What, if anything, held the last page to the configured pace. */
  pressure: ScanPressure;
  /** When this record was last written, ISO. */
  updatedAt: string;
}

export function readScanProgress(db: Db): ScanProgress | null {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM watermark WHERE key = ?")
    .get(SCAN_PROGRESS_KEY);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<ScanProgress>;
    if (parsed.version !== 1 || typeof parsed.startedAt !== "string") return null;
    return parsed as ScanProgress;
  } catch {
    return null;
  }
}

export function writeScanProgress(db: Db, progress: ScanProgress): void {
  db.prepare(
    `INSERT INTO watermark (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SCAN_PROGRESS_KEY, JSON.stringify(progress));
}

export function clearScanProgress(db: Db): void {
  db.prepare("DELETE FROM watermark WHERE key = ?").run(SCAN_PROGRESS_KEY);
}

/**
 * The read-only view `/status` and `/index/stats` serve, derived from the
 * durable record so it survives the worker and is the same on every reader.
 */
export interface ScanProgressView {
  active: true;
  full: boolean;
  startedAt: string;
  updatedAt: string;
  resumes: number;
  scanned: number;
  indexed: number;
  afterId: string | null;
  /**
   * How far through the id space the cursor is, 0..1. Document ids are random
   * UUIDs, so the leading 32 bits of the cursor are a uniform position in any
   * id-ordered walk. Null when the cursor is not hex.
   */
  position: number | null;
  /** Documents the current run completes per second. */
  scannedPerSec: number | null;
  /** Documents the current run newly indexes per second. */
  indexedPerSec: number | null;
  pageSize: number;
  sleepMs: number;
  pressure: ScanPressure;
}

export function scanPositionOf(afterId: string | null): number | null {
  if (!afterId) return 0;
  const hex = afterId.replace(/-/g, "").slice(0, 8);
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null;
  return Number.parseInt(hex, 16) / 0x1_0000_0000;
}

export function describeScanProgress(progress: ScanProgress): ScanProgressView {
  const elapsedSec = (Date.parse(progress.updatedAt) - Date.parse(progress.runStartedAt)) / 1000;
  const rate = (n: number): number | null =>
    elapsedSec > 0 && Number.isFinite(elapsedSec) ? Math.round((n / elapsedSec) * 100) / 100 : null;
  return {
    active: true,
    full: progress.since === null,
    startedAt: progress.startedAt,
    updatedAt: progress.updatedAt,
    resumes: progress.resumes,
    scanned: progress.scanned,
    indexed: progress.indexed,
    afterId: progress.afterId,
    position: scanPositionOf(progress.afterId),
    scannedPerSec: rate(progress.runScanned),
    indexedPerSec: rate(progress.runIndexed),
    pageSize: progress.pageSize,
    sleepMs: progress.sleepMs,
    pressure: progress.pressure,
  };
}

/** The view for a reader holding an index.db handle; null when no scan is in progress. */
export function readScanProgressView(db: Db): ScanProgressView | null {
  const progress = readScanProgress(db);
  return progress ? describeScanProgress(progress) : null;
}
