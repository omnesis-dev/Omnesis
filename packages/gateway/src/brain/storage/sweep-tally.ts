// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-sweep production — how often each theme ran, what it cost, and what it
 * left behind.
 *
 * This has to be its own durable tally rather than a query, for two reasons
 * that both bite silently:
 *
 *   - Run rows are PRUNED. `cognition_runs` carries the sweep id in its
 *     payload and every artifact carries `created_by_run`, so today's numbers
 *     are joinable — but only until the prune. A page that answered "what has
 *     this sweep produced?" from those joins would quietly start reporting
 *     less the longer a sweep had been running, which is the opposite of what
 *     the reader is asking.
 *   - `cognition_spend` buckets by MECHANISM, and every sweep shares the one
 *     mechanism id `thematic-sweep`. Widening that id to carry the sweep would
 *     split the existing history of a mechanism that is never renamed in
 *     place (see `storage/schema.ts`), so the per-sweep dimension has to live
 *     somewhere else.
 *
 * Rows are keyed on the sweep id and survive everything: deleting a sweep file
 * leaves its tally, and re-creating the file resumes the same row. That is
 * deliberate — the question the operator asks of this table is "was this sweep
 * ever worth it", and zeroing the history on an edit would destroy the only
 * evidence.
 *
 * Reporting only. Nothing on the scheduling or selection path reads it.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

export interface SweepTallyRow {
  sweepId: string;
  runs: number;
  failedRuns: number;
  promptTokens: number;
  completionTokens: number;
  briefsCreated: number;
  /**
   * Times the judge held a card this sweep tried to ship. Counted as it
   * happens rather than at settle, because a hold leaves no trace in the
   * artifact stores to count back from — so a run that holds a card, fails
   * non-terminally and retries counts the hold once per attempt. It is
   * "how often this sweep was told no", not a count of distinct cards.
   */
  briefsHeld: number;
  loopsCreated: number;
  loopsTouched: number;
  annotationsCreated: number;
  firstRunAt: number | null;
  lastRunAt: number | null;
}

/** One increment. Absent counters are zero, so a caller names what it moved. */
export interface SweepTallyDelta {
  sweepId: string;
  runs?: number;
  failedRuns?: number;
  promptTokens?: number;
  completionTokens?: number;
  briefsCreated?: number;
  briefsHeld?: number;
  loopsCreated?: number;
  loopsTouched?: number;
  annotationsCreated?: number;
}

export function createSweepTallyTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_sweep_tally (
      sweep_id TEXT PRIMARY KEY,
      runs INTEGER NOT NULL DEFAULT 0,
      failed_runs INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      briefs_created INTEGER NOT NULL DEFAULT 0,
      briefs_held INTEGER NOT NULL DEFAULT 0,
      loops_created INTEGER NOT NULL DEFAULT 0,
      loops_touched INTEGER NOT NULL DEFAULT 0,
      annotations_created INTEGER NOT NULL DEFAULT 0,
      first_run_at INTEGER,
      last_run_at INTEGER
    )
  `);
}

/**
 * Apply a tally increment. Runs on the single writer.
 *
 * `now` stamps `last_run_at` only when the delta actually settles a run, so a
 * mid-run judge hold does not make a sweep look like it ran twice.
 */
export function recordSweepTally(db: Db, delta: SweepTallyDelta, now: number): void {
  const settlesRun = (delta.runs ?? 0) + (delta.failedRuns ?? 0) > 0;
  db.prepare(
    `INSERT INTO cognition_sweep_tally (
       sweep_id, runs, failed_runs, prompt_tokens, completion_tokens,
       briefs_created, briefs_held, loops_created, loops_touched,
       annotations_created, first_run_at, last_run_at
     )
     VALUES (@sweepId, @runs, @failedRuns, @promptTokens, @completionTokens,
       @briefsCreated, @briefsHeld, @loopsCreated, @loopsTouched,
       @annotationsCreated, @stamp, @stamp)
     ON CONFLICT(sweep_id) DO UPDATE SET
       runs = cognition_sweep_tally.runs + excluded.runs,
       failed_runs = cognition_sweep_tally.failed_runs + excluded.failed_runs,
       prompt_tokens = cognition_sweep_tally.prompt_tokens + excluded.prompt_tokens,
       completion_tokens = cognition_sweep_tally.completion_tokens + excluded.completion_tokens,
       briefs_created = cognition_sweep_tally.briefs_created + excluded.briefs_created,
       briefs_held = cognition_sweep_tally.briefs_held + excluded.briefs_held,
       loops_created = cognition_sweep_tally.loops_created + excluded.loops_created,
       loops_touched = cognition_sweep_tally.loops_touched + excluded.loops_touched,
       annotations_created =
         cognition_sweep_tally.annotations_created + excluded.annotations_created,
       first_run_at = COALESCE(cognition_sweep_tally.first_run_at, excluded.first_run_at),
       last_run_at = COALESCE(excluded.last_run_at, cognition_sweep_tally.last_run_at)`,
  ).run({
    sweepId: delta.sweepId,
    runs: delta.runs ?? 0,
    failedRuns: delta.failedRuns ?? 0,
    promptTokens: delta.promptTokens ?? 0,
    completionTokens: delta.completionTokens ?? 0,
    briefsCreated: delta.briefsCreated ?? 0,
    briefsHeld: delta.briefsHeld ?? 0,
    loopsCreated: delta.loopsCreated ?? 0,
    loopsTouched: delta.loopsTouched ?? 0,
    annotationsCreated: delta.annotationsCreated ?? 0,
    stamp: settlesRun ? now : null,
  });
}

/** Every tally row, keyed by sweep id. */
export function listSweepTallies(db: Db): Map<string, SweepTallyRow> {
  const rows = db
    .prepare<[], Record<string, number | string | null>>(
      `SELECT sweep_id, runs, failed_runs, prompt_tokens, completion_tokens,
              briefs_created, briefs_held, loops_created, loops_touched,
              annotations_created, first_run_at, last_run_at
         FROM cognition_sweep_tally`,
    )
    .all();
  const out = new Map<string, SweepTallyRow>();
  for (const r of rows) {
    out.set(String(r.sweep_id), {
      sweepId: String(r.sweep_id),
      runs: Number(r.runs),
      failedRuns: Number(r.failed_runs),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      briefsCreated: Number(r.briefs_created),
      briefsHeld: Number(r.briefs_held),
      loopsCreated: Number(r.loops_created),
      loopsTouched: Number(r.loops_touched),
      annotationsCreated: Number(r.annotations_created),
      firstRunAt: r.first_run_at === null ? null : Number(r.first_run_at),
      lastRunAt: r.last_run_at === null ? null : Number(r.last_run_at),
    });
  }
  return out;
}

/**
 * What one settled run left behind, counted from the artifact stores.
 *
 * Counted at settle time rather than accumulated as the run works, because
 * `created_by_run` is already the authoritative record of authorship and
 * re-deriving from it cannot drift. A run settles once however many attempts
 * it took, and every attempt's artifacts carry the same run id, so a retry
 * neither double-counts nor loses the work of an earlier attempt.
 *
 * Judge holds are the one thing this cannot see — they leave nothing behind —
 * so they are counted at the moment they happen; see `briefsHeld`.
 */
export function countRunArtifacts(
  db: Db,
  runId: string,
): Pick<SweepTallyDelta, "briefsCreated" | "loopsCreated" | "loopsTouched" | "annotationsCreated"> {
  const one = (sql: string): number =>
    Number((db.prepare<[string], { n: number }>(sql).get(runId) ?? { n: 0 }).n);
  return {
    briefsCreated: one("SELECT COUNT(*) AS n FROM briefs WHERE created_by_run = ?"),
    loopsCreated: one("SELECT COUNT(*) AS n FROM open_loops WHERE created_by_run = ?"),
    loopsTouched: one("SELECT COUNT(DISTINCT loop_id) AS n FROM open_loop_ledger WHERE run_id = ?"),
    annotationsCreated:
      one("SELECT COUNT(*) AS n FROM doc_annotations WHERE created_by_run = ?") +
      one("SELECT COUNT(*) AS n FROM person_annotations WHERE created_by_run = ?") +
      one("SELECT COUNT(*) AS n FROM temporal_annotations WHERE created_by_run = ?"),
  };
}
