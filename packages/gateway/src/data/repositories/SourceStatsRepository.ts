// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import type { SourceStats } from "@omnesis/source-sdk";
import type { SourceStatsAggregation } from "../types.js";

/**
 * Per-source stats. Served from the materialized `source_stats` table as a
 * single-row PK lookup (microseconds). The heavy aggregation that populates
 * it — `SUM(LENGTH(content + title + metadata))` over all rows for a source —
 * is a full-content scan that routinely takes tens of seconds on large
 * sources (146k Gmail docs → ~100s). That computation lives off the main
 * thread, driven by the backfill worker via `refreshSourceStatsRow` below.
 *
 * Upsert/delete paths call `markSourceStatsDirty` so the next worker pass
 * refreshes the affected sources. Readers get a stale-but-cheap answer in
 * the meantime; a few seconds of staleness is fine for a status display.
 */

/**
 * Mark one or all sources dirty. Called from write paths.
 *
 * Only updates existing rows — a brand-new source with no row yet is
 * detected by `listDirtyStatsSourceIds` via `UNION DISTINCT source_id
 * FROM documents WHERE source_id NOT IN source_stats`, so the worker
 * will refresh it on the next tick. Skipping the INSERT here means
 * `getSourceStats` can't see a zero-valued placeholder and fall back
 * to a live aggregation when the first HTTP call arrives.
 */
export function markSourceStatsDirty(db: Db, sourceId?: string): void {
  // dirty_version increment is the optimistic-concurrency token — see
  // `computeSourceStatsRow` / `upsertSourceStatsRow` for how the
  // split refresh path uses it.
  if (sourceId === undefined) {
    db.prepare(
      "UPDATE source_stats SET needs_refresh = 1, dirty_version = dirty_version + 1",
    ).run();
    return;
  }
  db.prepare(
    "UPDATE source_stats SET needs_refresh = 1, dirty_version = dirty_version + 1 WHERE source_id = ?",
  ).run(sourceId);
}

/**
 * Account for `removed` documents deleted from one source: the count drops by
 * exactly that many in the deleting transaction, and the row is marked dirty
 * so the backfill reconciles the size and date range off the writer.
 */
export function recordSourceDocumentsDeleted(db: Db, sourceId: string, removed: number): void {
  db.prepare(
    `UPDATE source_stats
        SET doc_count = MAX(doc_count - ?, 0), needs_refresh = 1, dirty_version = dirty_version + 1
      WHERE source_id = ?`,
  ).run(removed, sourceId);
}

/** List source IDs whose cached row is dirty (needs a refresh). */
export function listDirtyStatsSourceIds(db: Db): string[] {
  // Also pull any source_id present in `documents` without a source_stats
  // row — happens on a fresh DB before the first dirty-mark fires, and on
  // pre-existing databases where we just added the table.
  const rows = db
    .prepare<[], { source_id: string }>(
      `SELECT source_id FROM source_stats WHERE needs_refresh = 1
       UNION
       SELECT DISTINCT source_id FROM documents
         WHERE source_id NOT IN (SELECT source_id FROM source_stats)`,
    )
    .all();
  return rows.map((r) => r.source_id);
}

/** Documents each statement of the per-source aggregation reads. */
export const SOURCE_STATS_CHUNK_ROWS = 500;

interface SourceStatsChunk {
  count: number;
  lastRowid: number | null;
  earliest: string | null;
  latest: string | null;
  dataSize: number | null;
  totalUnits: number | null;
}

/** SQLite's BINARY collation: byte order of the UTF-8 text. */
function binaryLess(a: string, b: string): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0;
}

function pick(a: string | null, b: string | null, keepA: (a: string, b: string) => boolean) {
  if (a === null) return b;
  if (b === null) return a;
  return keepA(a, b) ? a : b;
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/**
 * Pure-read aggregation over `documents` for one source. Designed to
 * run on a read-only handle (the backfill worker's `openReadConn`)
 * so the heavy scan doesn't park the writer worker.
 *
 * Captures `dirty_version` BEFORE running the aggregation. Anything
 * that bumps `dirty_version` after this point — concurrent
 * `markSourceStatsDirty`, concurrent `upsertDocuments` for this source
 * — will be detected by `upsertSourceStatsRow` and prevent us from
 * (a) overwriting fresher data and (b) clearing `needs_refresh`.
 *
 * The aggregation reads every byte of the source's content, so one
 * statement over a large source held a single WAL snapshot for tens of
 * seconds (see `docs/conventions.md`, "A long read holds the WAL open").
 * It reads `chunkRows` documents per statement instead, walking
 * `idx_documents_source_id` by rowid: that index is `(source_id, rowid)`,
 * so each chunk is a seek and a range, with no sort. (Chunking by `id`
 * needed a sort per chunk and was ~44× slower.) Count, sums, minimum and
 * maximum combine exactly across chunks.
 *
 * Statements in separate snapshots can mix states. The captured version
 * is what makes that safe: every write to a source's documents bumps
 * `dirty_version`, so a result `upsertSourceStatsRow` accepts saw no
 * write between the capture and the upsert, and is the result one
 * snapshot would have given. A source with no stats row has no version
 * to check, so a result read in more than one statement outside a
 * transaction is `provisional`: it is stored with `needs_refresh` still
 * set, and the next pass, which has a version, computes it again.
 */
export function computeSourceStatsRow(
  db: Db,
  sourceId: string,
  chunkRows: number = SOURCE_STATS_CHUNK_ROWS,
): SourceStatsAggregation {
  // Capture the dirty_version FIRST. If the row doesn't exist yet
  // (brand-new source the worker hasn't materialized) the captured
  // value is 0 and the matching INSERT path in upsertSourceStatsRow
  // also writes 0 — consistent.
  const versionRow = db
    .prepare<[string], { dirty_version: number; doc_count: number }>(
      "SELECT dirty_version, doc_count FROM source_stats WHERE source_id = ?",
    )
    .get(sourceId);
  const capturedVersion = versionRow?.dirty_version ?? 0;
  const capturedDocCount = versionRow?.doc_count ?? 0;

  const chunk = db.prepare<[string, number, number], SourceStatsChunk>(
    `SELECT
       COUNT(*) AS count,
       MAX(rid) AS lastRowid,
       MIN(created) AS earliest,
       MAX(created) AS latest,
       SUM(size) AS dataSize,
       SUM(units) AS totalUnits
     FROM (
       SELECT rowid AS rid,
              source_created_at AS created,
              LENGTH(content) + LENGTH(title) + LENGTH(metadata) AS size,
              COALESCE(
                json_extract(metadata, '$.extra.unitCount'),
                json_extract(metadata, '$.extra.messageCount')
              ) AS units
         FROM documents INDEXED BY idx_documents_source_id
        WHERE source_id = ? AND rowid > ?
        ORDER BY rowid
        LIMIT ?
     )`,
  );

  const limit = Math.max(1, Math.floor(chunkRows));
  let count = 0;
  let earliest: string | null = null;
  let latest: string | null = null;
  let dataSize: number | null = null;
  let totalUnits: number | null = null;
  let statements = 0;
  let afterRowid = 0;
  for (;;) {
    const row = chunk.get(sourceId, afterRowid, limit)!;
    statements += 1;
    count += row.count;
    earliest = pick(earliest, row.earliest, (a, b) => !binaryLess(b, a));
    latest = pick(latest, row.latest, (a, b) => !binaryLess(a, b));
    dataSize = addNullable(dataSize, row.dataSize);
    totalUnits = addNullable(totalUnits, row.totalUnits);
    if (row.count < limit || row.lastRowid === null) break;
    afterRowid = row.lastRowid;
  }

  return {
    count,
    earliest,
    latest,
    dataSize: dataSize ?? 0,
    totalUnits,
    capturedVersion,
    ...(versionRow === undefined && statements > 1 && !db.inTransaction
      ? { provisional: true }
      : {}),
    capturedDocCount,
  };
}

/**
 * Pure-write companion to `computeSourceStatsRow`. Upserts the aggregation
 * into `source_stats`. When `dirty_version` has not moved since `compute`
 * captured it, the row is current and `needs_refresh` clears. When it has —
 * a concurrent `markSourceStatsDirty`, or `upsertDocuments` for this source
 * — the aggregation is still written: its size, units and date range are at
 * most a few documents behind, and the writes that landed during the scan
 * are folded into the count from the inline `doc_count` bumps they made
 * (`count + (doc_count now − doc_count at capture)`). `needs_refresh` stays
 * set so the source is scanned again. Discarding the scan instead left a
 * source that is always ingesting with numbers from before its first scan,
 * however many scans it got.
 *
 * The `INSERT` path (no existing row) is unconditional — there's no
 * existing row to race against; the brand-new-source case is handled
 * separately by `upsertDocuments`'s inline `refreshSourceStatsRow`
 * which runs on the writer connection before the backfill loop can
 * see the source.
 */
export function upsertSourceStatsRow(db: Db, sourceId: string, agg: SourceStatsAggregation): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO source_stats (
       source_id, doc_count, data_size_bytes, total_units,
       earliest_source_date, latest_source_date,
       needs_refresh, last_computed_at, dirty_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       doc_count = CASE
         WHEN source_stats.dirty_version = excluded.dirty_version THEN excluded.doc_count
         ELSE MAX(excluded.doc_count + source_stats.doc_count - ?, 0)
       END,
       data_size_bytes = excluded.data_size_bytes,
       total_units = excluded.total_units,
       earliest_source_date = excluded.earliest_source_date,
       latest_source_date = excluded.latest_source_date,
       needs_refresh = CASE
         WHEN source_stats.dirty_version = excluded.dirty_version THEN excluded.needs_refresh
         ELSE 1
       END,
       last_computed_at = excluded.last_computed_at`,
  ).run(
    sourceId,
    agg.count,
    agg.dataSize,
    agg.totalUnits,
    agg.earliest,
    agg.latest,
    agg.provisional ? 1 : 0,
    now,
    agg.capturedVersion,
    agg.capturedDocCount,
  );
}

/**
 * Recompute the stats row for a single source. Runs the expensive scan
 * AND the upsert on the same handle — preserved for callers that
 * already have a writable handle and don't want to split the work
 * (`upsertDocuments`'s brand-new-source seed, `getSourceStats`'s
 * first-read fallback). The backfill worker should split into
 * `computeSourceStatsRow` (read handle) + `upsertSourceStatsRow`
 * (writer worker) instead, so the heavy aggregation doesn't park the
 * writer. One transaction, so the chunks read one snapshot and the
 * result is never provisional.
 */
export function refreshSourceStatsRow(db: Db, sourceId: string): void {
  db.transaction(() => {
    upsertSourceStatsRow(db, sourceId, computeSourceStatsRow(db, sourceId));
  })();
}

export function getSourceStats(db: Db, sourceId: string): SourceStats {
  const row = db
    .prepare<
      [string],
      {
        doc_count: number;
        data_size_bytes: number;
        total_units: number | null;
        earliest_source_date: string | null;
        latest_source_date: string | null;
        needs_refresh: number;
      }
    >(
      `SELECT doc_count, data_size_bytes, total_units,
              earliest_source_date, latest_source_date, needs_refresh
       FROM source_stats WHERE source_id = ?`,
    )
    .get(sourceId);

  if (row) {
    // Placeholder rows planted by `upsertDocuments` carry doc_count
    // (cheap inline COUNT) but zero `data_size_bytes` / null dates
    // until the backfill worker runs the heavy SUM(LENGTH) + MIN/MAX
    // scan off-thread. Detect that case here and
    // compute on the read handle so callers polling immediately
    // after ingest still see real numbers — the aggregation runs
    // on the read-only HTTP handle, never blocks the writer.
    if (row.needs_refresh === 1 && row.data_size_bytes === 0 && row.doc_count > 0) {
      const computed = computeSourceStatsRow(db, sourceId);
      return {
        documentCount: computed.count,
        earliestSourceDate: computed.earliest,
        latestSourceDate: computed.latest,
        totalUnitCount: computed.totalUnits,
        dataSizeBytes: computed.dataSize,
      };
    }
    // Return whatever the materialized row has — even if the worker
    // has marked it dirty from a recent upsert. Callers tolerate up
    // to one worker-tick of staleness (the /portal/* status displays
    // are informational); serving a slightly-old number beats running
    // a multi-second aggregation on the HTTP thread for every read
    // while the collector is actively ingesting (which marks rows
    // dirty continuously).
    return {
      documentCount: row.doc_count,
      earliestSourceDate: row.earliest_source_date,
      latestSourceDate: row.latest_source_date,
      totalUnitCount: row.total_units,
      dataSizeBytes: row.data_size_bytes,
    };
  }

  // No row yet. The HTTP path runs on a read-only handle
  // so we can't seed inline — that threw `SqliteError: attempt to
  // write a readonly database` on every poll for sources whose
  // source_stats row had not yet been materialized. The backfill
  // worker's `listDirtyStatsSourceIds` UNIONs in any source_id
  // present in `documents` without a stats row, so the row will be
  // populated on its next tick (≤ a few seconds). Until then,
  // serving zeros is correct for "source exists but no docs yet"
  // and ≤ a worker-tick stale for "row not yet materialized".
  return {
    documentCount: 0,
    earliestSourceDate: null,
    latestSourceDate: null,
    totalUnitCount: null,
    dataSizeBytes: 0,
  };
}

/**
 * Batch variant of `getSourceStats`: one read of `source_stats`, returns
 * a `Record<sourceId, SourceStats>`. Lets `omnesis status` fan out N+1
 * per-source requests as a single round-trip. Sources without a row
 * (or with placeholder rows where the heavy aggregation hasn't
 * materialized yet) are filled in via `computeSourceStatsRow` on the
 * same read handle — same fallback shape as `getSourceStats`.
 *
 * `sourceIds` is deduplicated; missing IDs simply aren't present in
 * the result. The caller is expected to merge with whatever shape it
 * already has (the CLI's `status` command keeps a row per descriptor;
 * a missing key here means "we have no stats yet" → render zeros).
 */
export function getSourceStatsBulk(
  db: Db,
  sourceIds: readonly string[],
): Record<string, SourceStats> {
  if (sourceIds.length === 0) return {};
  const unique = Array.from(new Set(sourceIds));
  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare<
      string[],
      {
        source_id: string;
        doc_count: number;
        data_size_bytes: number;
        total_units: number | null;
        earliest_source_date: string | null;
        latest_source_date: string | null;
        needs_refresh: number;
      }
    >(
      `SELECT source_id, doc_count, data_size_bytes, total_units,
              earliest_source_date, latest_source_date, needs_refresh
       FROM source_stats
       WHERE source_id IN (${placeholders})`,
    )
    .all(...unique);

  const result: Record<string, SourceStats> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.source_id);
    if (row.needs_refresh === 1 && row.data_size_bytes === 0 && row.doc_count > 0) {
      const computed = computeSourceStatsRow(db, row.source_id);
      result[row.source_id] = {
        documentCount: computed.count,
        earliestSourceDate: computed.earliest,
        latestSourceDate: computed.latest,
        totalUnitCount: computed.totalUnits,
        dataSizeBytes: computed.dataSize,
      };
    } else {
      result[row.source_id] = {
        documentCount: row.doc_count,
        earliestSourceDate: row.earliest_source_date,
        latestSourceDate: row.latest_source_date,
        totalUnitCount: row.total_units,
        dataSizeBytes: row.data_size_bytes,
      };
    }
  }
  // For source IDs with no row yet, fall back to the same zero-shape
  // `getSourceStats` returns — the worker will materialize a real row
  // within one tick.
  for (const id of unique) {
    if (seen.has(id)) continue;
    result[id] = {
      documentCount: 0,
      earliestSourceDate: null,
      latestSourceDate: null,
      totalUnitCount: null,
      dataSizeBytes: 0,
    };
  }
  return result;
}
