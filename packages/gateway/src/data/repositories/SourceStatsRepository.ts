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
 * Single aggregation statement; plan-driven by
 * `idx_documents_source_id_created_at` — measured at ~1.15s for
 * Gmail's 146k docs against the live gateway DB. That's well under
 * the writer's `busy_timeout = 5000ms`, so concurrent commits on the
 * writer connection queue past it cleanly without `SQLITE_BUSY`.
 *
 * (A previous version chunked by id in 500-doc batches to release
 * SHARED between iterations. Without a `(source_id, id)` compound
 * index, each chunk did a full source-id index scan + sort, making
 * the aggregation ~44× slower on Gmail. Single statement won.)
 */
export function computeSourceStatsRow(db: Db, sourceId: string): SourceStatsAggregation {
  // Capture the dirty_version FIRST. If the row doesn't exist yet
  // (brand-new source the worker hasn't materialized) the captured
  // value is 0 and the matching INSERT path in upsertSourceStatsRow
  // also writes 0 — consistent.
  const versionRow = db
    .prepare<
      [string],
      { dirty_version: number }
    >("SELECT dirty_version FROM source_stats WHERE source_id = ?")
    .get(sourceId);
  const capturedVersion = versionRow?.dirty_version ?? 0;

  const row = db
    .prepare<
      [string],
      {
        count: number;
        earliest: string | null;
        latest: string | null;
        dataSize: number | null;
        totalUnits: number | null;
      }
    >(
      `SELECT
         COUNT(*) AS count,
         MIN(source_created_at) AS earliest,
         MAX(source_created_at) AS latest,
         SUM(LENGTH(content) + LENGTH(title) + LENGTH(metadata)) AS dataSize,
         SUM(COALESCE(
           json_extract(metadata, '$.extra.unitCount'),
           json_extract(metadata, '$.extra.messageCount')
         )) AS totalUnits
       FROM documents
       WHERE source_id = ?`,
    )
    .get(sourceId);

  return {
    count: row?.count ?? 0,
    earliest: row?.earliest ?? null,
    latest: row?.latest ?? null,
    dataSize: row?.dataSize ?? 0,
    totalUnits: row?.totalUnits ?? null,
    capturedVersion,
  };
}

/**
 * Pure-write companion to `computeSourceStatsRow`. Upserts the
 * aggregation into `source_stats` only if `dirty_version` hasn't
 * moved since `compute` captured it. If a concurrent
 * `markSourceStatsDirty` (or `upsertDocuments`'s inline dirty-bump)
 * fired during compute, the aggregation is stale: we skip the row
 * data update AND leave `needs_refresh = 1` so the backfill worker
 * picks the source up again on the next tick and re-computes.
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
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       doc_count = excluded.doc_count,
       data_size_bytes = excluded.data_size_bytes,
       total_units = excluded.total_units,
       earliest_source_date = excluded.earliest_source_date,
       latest_source_date = excluded.latest_source_date,
       needs_refresh = 0,
       last_computed_at = excluded.last_computed_at
     WHERE source_stats.dirty_version = excluded.dirty_version`,
  ).run(
    sourceId,
    agg.count,
    agg.dataSize,
    agg.totalUnits,
    agg.earliest,
    agg.latest,
    now,
    agg.capturedVersion,
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
 * writer.
 */
export function refreshSourceStatsRow(db: Db, sourceId: string): void {
  upsertSourceStatsRow(db, sourceId, computeSourceStatsRow(db, sourceId));
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
