// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readOccMeta } from "../data/occ-materialized.js";
import type { Db } from "../data/types.js";

/**
 * Read/write helpers for the singleton `near_dup_df_meta` row. Lives
 * in its own module so callers don't need to know whether the row
 * exists yet — `readActiveAlgoVersion` returns null on a fresh DB.
 *
 * The row is seeded lazily by `setActiveAlgoVersion` on boot. We
 * deliberately keep `near_dup_df_meta` empty on a fresh DB so the
 * boot algo-bump path (see `bumpNearDupAlgo` in `NearDupWriterOps`)
 * can detect "first run" vs "ongoing" via the absence of any row.
 */

export interface NearDupMetaRow {
  algoVersion: string;
  totalDocs: number;
  uniqueShingles: number;
  builtAt: number | null;
  sweepWatermark: string | null;
}

export function readNearDupMeta(db: Db): NearDupMetaRow | null {
  const row = db
    .prepare<
      [],
      {
        algo_version: string;
        total_docs: number;
        unique_shingles: number;
        built_at: number | null;
        sweep_watermark: string | null;
      }
    >(
      `SELECT algo_version, total_docs, unique_shingles, built_at, sweep_watermark
       FROM near_dup_df_meta
       LIMIT 1`,
    )
    .get();
  if (!row) return null;
  return {
    algoVersion: row.algo_version,
    totalDocs: row.total_docs,
    uniqueShingles: row.unique_shingles,
    builtAt: row.built_at,
    sweepWatermark: row.sweep_watermark,
  };
}

export function readActiveAlgoVersion(db: Db): string | null {
  return readNearDupMeta(db)?.algoVersion ?? null;
}

export function setActiveAlgoVersion(db: Db, algoVersion: string): void {
  // INSERT OR REPLACE on the algo_version PK semantics: if the row
  // exists under a different algo_version, we clear it and re-seed.
  // The caller is the algo-bump path which expects the DF + sweep
  // counters to start fresh under the new algo.
  db.prepare(`DELETE FROM near_dup_df_meta`).run();
  db.prepare(
    `INSERT INTO near_dup_df_meta (algo_version, total_docs, unique_shingles, built_at, sweep_watermark)
     VALUES (?, 0, 0, NULL, NULL)`,
  ).run(algoVersion);
}

export function setSweepWatermark(db: Db, algoVersion: string, watermark: string): void {
  db.prepare(`UPDATE near_dup_df_meta SET sweep_watermark = ? WHERE algo_version = ?`).run(
    watermark,
    algoVersion,
  );
}

/**
 * The generation of `near_dup_df` readers must use for this algo. A rebuild
 * writes into a later one (see {@link nextDfGeneration}) and publishes
 * itself by moving this pointer, so a build in flight is never what readers
 * are reading.
 */
export function readLiveDfGeneration(db: Db, algoVersion: string): number {
  const row = db
    .prepare<
      [string],
      { live_generation: number }
    >("SELECT live_generation FROM near_dup_df_meta WHERE algo_version = ?")
    .get(algoVersion);
  return row?.live_generation ?? 0;
}

/**
 * The generation a new build should write into: past the live one, and past
 * anything already in the table.
 *
 * The second half is what stops a build that died mid-write from being
 * merged into the next one — its rows are still there under a generation
 * nothing published, and reusing that number would fold them into a build
 * that then publishes them as its own. Skipping past leaves them older than
 * the next published generation, which is when the sweep may reclaim them.
 */
export function nextDfGeneration(db: Db, algoVersion: string): number {
  const row = db
    .prepare<
      [string],
      { highest: number | null }
    >("SELECT MAX(generation) AS highest FROM near_dup_df WHERE algo_version = ?")
    .get(algoVersion);
  return Math.max(row?.highest ?? 0, readLiveDfGeneration(db, algoVersion)) + 1;
}

export function setDfBuiltAt(
  db: Db,
  algoVersion: string,
  totalDocs: number,
  uniqueShingles: number,
  builtAt: number,
): void {
  db.prepare(
    `UPDATE near_dup_df_meta
        SET total_docs = ?, unique_shingles = ?, built_at = ?
      WHERE algo_version = ?`,
  ).run(totalDocs, uniqueShingles, builtAt, algoVersion);
}

/**
 * Publish a completed rebuild: stamp what it measured and point readers at
 * it, in one statement. This is the entire cost of a swap on the writer —
 * a single row — however many million shingles the new generation holds.
 */
export function publishDfGeneration(
  db: Db,
  algoVersion: string,
  generation: number,
  totalDocs: number,
  uniqueShingles: number,
  builtAt: number,
): void {
  // Upsert, not update. The pointer is what readers follow, so a publish
  // that quietly matched no row would leave a finished build invisible and
  // the table looking unbuilt — the one outcome worse than a slow rebuild.
  db.prepare(
    `INSERT INTO near_dup_df_meta (algo_version, total_docs, unique_shingles, built_at, live_generation)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(algo_version) DO UPDATE SET
       total_docs = excluded.total_docs,
       unique_shingles = excluded.unique_shingles,
       built_at = excluded.built_at,
       live_generation = excluded.live_generation`,
  ).run(algoVersion, totalDocs, uniqueShingles, builtAt, generation);
}

/**
 * Read the OCC meta snapshot for the DF refresh job. Used by the
 * periodic `nearDupDfRefresh` task to decide whether the DF table is
 * stale (dirtyVersion > lastAppliedVersion).
 *
 * Note: this row is global (one per job), not per-algorithm. After
 * an algo bump the row still claims "applied" even though the DF
 * rows for the new active algo don't exist (algo sweep wiped the
 * old algo's rows). For per-algo DF-readiness on the compute drip,
 * use `readNearDupDfBuiltAt` instead.
 */
export function readNearDupDfMeta(db: Db): {
  dirtyVersion: number;
  lastAppliedVersion: number;
  lastAppliedAt: number | null;
} {
  const meta = readOccMeta(db, "near_dup_df");
  return {
    dirtyVersion: meta.dirtyVersion,
    lastAppliedVersion: meta.lastComputedVersion,
    lastAppliedAt: meta.lastComputedAt,
  };
}

/**
 * Per-algo DF readiness check. Returns `built_at` of the row matching
 * `algoVersion` (null = DF for this algo hasn't been computed yet, so
 * the compute drip should park rather than emit degenerate
 * zero-weight signatures). `setActiveAlgoVersion` clears this on every
 * algo bump, so it's the right signal across algo transitions.
 */
export function readNearDupDfBuiltAt(db: Db, algoVersion: string): number | null {
  const row = db
    .prepare<
      [string],
      { built_at: number | null }
    >(`SELECT built_at FROM near_dup_df_meta WHERE algo_version = ?`)
    .get(algoVersion);
  return row?.built_at ?? null;
}
