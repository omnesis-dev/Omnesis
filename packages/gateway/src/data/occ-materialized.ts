// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * OCC (optimistic-concurrency) primitives shared by the gateway's
 * compute/upsert tables.
 *
 * The three legacy per-job singleton tables
 * (`link_stats`'s OCC columns, `interaction_scores_meta`,
 * `merge_rules_meta`) collapsed into one `refresh_meta` table keyed
 * by job. The helpers here read/write that single table. Sibling
 * data lives elsewhere: `link_stats` for the `link_graph` job;
 * `people.*` columns for `interaction_scores`; `person_equivalences`
 * for `merge_rules`.
 *
 * The "capture-then-skip-on-race" dance still applies:
 *
 *   1. **Capture** — read `dirty_version` from the row before compute
 *      begins (`captureOccVersion`).
 *   2. **Read meta snapshot** — the `{dirtyVersion, lastComputedVersion,
 *      lastComputedAt}` triple periodic refresh tasks use to decide
 *      whether to fire (`readOccMeta`).
 *   3. **Advance the watermark** — the post-compute update that records
 *      the captured version + completion timestamp on success
 *      (`advanceOccWatermark`).
 *
 * The link_graph data write also uses `dirty_version` for an atomic
 * skip-on-race on the link_stats UPDATE — that path is folded into
 * `LinkStatsRepository.upsertLinkStats`, which now takes a transaction
 * across `refresh_meta` (skip-if-moved) and `link_stats` (data write).
 */

import type Database from "better-sqlite3";
type Db = Database.Database;

/** Refresh-job identity. Mirrors the `refresh_meta.job` CHECK clause. */
export type RefreshJob =
  | "link_graph"
  | "interaction_scores"
  | "merge_rules"
  | "near_dup_df"
  | "people_counts";

/**
 * Snapshot returned by `readOccMeta`. Field names match the columns
 * on `refresh_meta`.
 */
export interface OccMetaSnapshot {
  dirtyVersion: number;
  lastComputedVersion: number;
  lastComputedAt: number | null;
}

/**
 * Read the OCC token from the named refresh job's row. Returns 0 when
 * no row exists yet (brand-new DB or first call before any dirty mark).
 */
export function captureOccVersion(db: Db, job: RefreshJob): number {
  const row = db
    .prepare<
      [string],
      { dirty_version: number }
    >("SELECT dirty_version FROM refresh_meta WHERE job = ?")
    .get(job);
  return row?.dirty_version ?? 0;
}

/**
 * Read the {dirty, last_computed, last_computed_at} triple for a
 * refresh job. Used by the periodic refresh tasks to decide whether
 * `dirty_version` has moved past the last successful pass.
 */
export function readOccMeta(db: Db, job: RefreshJob): OccMetaSnapshot {
  const row = db
    .prepare<
      [string],
      {
        dirty_version: number;
        last_computed_version: number;
        last_computed_at: number | null;
      }
    >(
      `SELECT dirty_version, last_computed_version, last_computed_at
       FROM refresh_meta WHERE job = ?`,
    )
    .get(job);
  return {
    dirtyVersion: row?.dirty_version ?? 0,
    lastComputedVersion: row?.last_computed_version ?? -1,
    lastComputedAt: row?.last_computed_at ?? null,
  };
}

/**
 * Advance the watermark on a successful pass. Monotonic — the version
 * only ever moves forward, so a pass that raced a newer one (two apply
 * paths can compute concurrently) can never drag the watermark back
 * and make the newer pass's work look unapplied. Does not re-check
 * `dirty_version`; the caller is responsible for only invoking this
 * after `compute` and the per-row data writes finished cleanly —
 * partial passes must skip this call so the next tick re-runs.
 */
export function advanceOccWatermark(
  db: Db,
  opts: {
    /** Refresh-job name. */
    job: RefreshJob;
    /** Version captured at the start of compute (carried through the snapshot). */
    capturedVersion: number;
    /** Wall-clock time to record. Defaults to `Date.now()`. */
    nowMs?: number;
  },
): void {
  const ts = opts.nowMs ?? Date.now();
  db.prepare(
    `UPDATE refresh_meta
       SET last_computed_at = ?,
           last_computed_version = MAX(last_computed_version, ?)
     WHERE job = ?`,
  ).run(ts, opts.capturedVersion, opts.job);
}
