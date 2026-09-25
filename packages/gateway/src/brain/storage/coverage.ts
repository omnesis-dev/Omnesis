// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-source cognitive coverage — how much of each source's corpus the
 * background agent has reasoned over, per workflow, and what it cost.
 *
 * **Reporting only.** Nothing on the selection path reads this table. Which
 * documents each lane takes is decided by the datum's own timestamp against
 * the waker's recency window (`storage/bootstrap.ts`), and that shared-clock
 * partition remains the sole correctness mechanism. A coverage row is a tally
 * of work that happened, kept so a negative claim — "this source's history has
 * not been reviewed" — can be made honestly instead of guessed at. Gating
 * selection on a tally would make a counting error a correctness bug.
 *
 * **What the columns mean.** `eligible` counts documents a lane selected as
 * needing cognition (bumped when the run is enqueued); `processed` and
 * `skipped` count the runs that then settled, completed or terminally failed
 * (bumped when the run settles). Token columns carry the settled attempts'
 * usage — a best-effort cost figure, not a bill: `cognition_spend` is the
 * authoritative accounting and records retried attempts too. `status` is
 * derived from the counters on every write:
 *
 *   - `live`        — no eligible count (the real-time lane has no backlog to
 *                     finish; it covers datums as they arrive);
 *   - `in-progress` — selected documents remain unsettled;
 *   - `settled`     — every document the lane has SELECTED so far has
 *                     settled. Deliberately not `covered`: it is not a claim
 *                     that the source's corpus has been reasoned over, only
 *                     that nothing selected is still outstanding. A source
 *                     with a large unselected backlog reports `settled`.
 *
 * **Generation.** The row is keyed by the source id, and that id is the
 * source's generation: the id and the documents beneath it live and die
 * together. Removing a source purges its documents, and this table is
 * retracted in that same cascade, so a re-added source starts from zero
 * coverage — the honest answer, since its corpus was rebuilt from scratch.
 * Anything short of removal — a re-auth, a resync that empties and refills the
 * corpus — touches the id not at all, so its coverage survives untouched. That
 * asymmetry is the whole point of keying on the id: re-authenticating a
 * mailbox must never re-spend the operator's money over its entire history.
 *
 * Rows are also keyed by workflow id AND its contract version, so a workflow
 * whose rules change starts a fresh tally rather than blending two different
 * procedures' coverage into one number.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

/** Coverage status, derived from the counters — see the module doc. */
type CognitionCoverageStatus = "live" | "in-progress" | "settled";

export interface CognitionCoverageRow {
  sourceId: string;
  workflowId: string;
  workflowVersion: number;
  eligible: number;
  processed: number;
  skipped: number;
  promptTokens: number;
  completionTokens: number;
  /** When a counter last moved (unix ms). */
  lastProgressAt: number;
  status: CognitionCoverageStatus;
}

/**
 * One increment against a coverage row. Absent counters are zero, so a caller
 * names only the dimension it moved.
 */
export interface CognitionCoverageDelta {
  sourceId: string;
  workflowId: string;
  workflowVersion: number;
  eligible?: number;
  processed?: number;
  skipped?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export function createCognitionCoverageTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_coverage (
      source_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_version INTEGER NOT NULL,
      eligible INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      last_progress_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'live',
      PRIMARY KEY (source_id, workflow_id, workflow_version)
    )
  `);
}

/**
 * Apply coverage increments. A delta is an increment, so a caller invokes this
 * once per event it counts. `status` is recomputed from the resulting counters
 * in the same statement, so a reader never re-derives it and the surface and
 * the store cannot disagree. Runs on the single writer.
 */
export function recordCognitionCoverage(
  db: Db,
  deltas: readonly CognitionCoverageDelta[],
  now: number,
): number {
  if (deltas.length === 0) return 0;
  // Named parameters, because the insert-time status has to read the bound
  // increments a second time: `excluded.*` is only in scope inside the
  // conflict clause, not in the VALUES list.
  const stmt = db.prepare(
    `INSERT INTO cognition_coverage (
       source_id, workflow_id, workflow_version,
       eligible, processed, skipped, prompt_tokens, completion_tokens,
       last_progress_at, status
     )
     VALUES (@sourceId, @workflowId, @workflowVersion,
       @eligible, @processed, @skipped, @promptTokens, @completionTokens, @now,
       CASE WHEN @eligible = 0 THEN 'live'
            WHEN @processed + @skipped >= @eligible THEN 'settled'
            ELSE 'in-progress' END)
     ON CONFLICT(source_id, workflow_id, workflow_version) DO UPDATE SET
       eligible = cognition_coverage.eligible + excluded.eligible,
       processed = cognition_coverage.processed + excluded.processed,
       skipped = cognition_coverage.skipped + excluded.skipped,
       prompt_tokens = cognition_coverage.prompt_tokens + excluded.prompt_tokens,
       completion_tokens = cognition_coverage.completion_tokens + excluded.completion_tokens,
       last_progress_at = excluded.last_progress_at,
       status =
         CASE WHEN cognition_coverage.eligible + excluded.eligible = 0 THEN 'live'
              WHEN cognition_coverage.processed + excluded.processed
                   + cognition_coverage.skipped + excluded.skipped
                   >= cognition_coverage.eligible + excluded.eligible THEN 'settled'
              ELSE 'in-progress' END`,
  );
  const run = db.transaction((rows: readonly CognitionCoverageDelta[]) => {
    for (const d of rows) {
      stmt.run({
        sourceId: d.sourceId,
        workflowId: d.workflowId,
        workflowVersion: d.workflowVersion,
        eligible: d.eligible ?? 0,
        processed: d.processed ?? 0,
        skipped: d.skipped ?? 0,
        promptTokens: d.promptTokens ?? 0,
        completionTokens: d.completionTokens ?? 0,
        now,
      });
    }
  });
  run(deltas);
  return deltas.length;
}

export interface ListCognitionCoverageOptions {
  limit?: number;
  before?: {
    lastProgressAt: number;
    sourceId: string;
    workflowId: string;
    workflowVersion: number;
  };
}

/** Coverage rows, most-recent progress first — the operator surface. */
export function listCognitionCoverage(
  db: Db,
  opts: ListCognitionCoverageOptions = {},
): CognitionCoverageRow[] {
  const conditions: string[] = [];
  const params: Array<number | string> = [];
  if (opts.before) {
    conditions.push(
      `(last_progress_at < ?
        OR (last_progress_at = ? AND source_id > ?)
        OR (last_progress_at = ? AND source_id = ? AND workflow_id > ?)
        OR (last_progress_at = ? AND source_id = ? AND workflow_id = ?
            AND workflow_version > ?))`,
    );
    params.push(
      opts.before.lastProgressAt,
      opts.before.lastProgressAt,
      opts.before.sourceId,
      opts.before.lastProgressAt,
      opts.before.sourceId,
      opts.before.workflowId,
      opts.before.lastProgressAt,
      opts.before.sourceId,
      opts.before.workflowId,
      opts.before.workflowVersion,
    );
  }
  const limit = Math.max(1, opts.limit ?? 100);
  params.push(limit);
  return db
    .prepare<
      Array<number | string>,
      {
        source_id: string;
        workflow_id: string;
        workflow_version: number;
        eligible: number;
        processed: number;
        skipped: number;
        prompt_tokens: number;
        completion_tokens: number;
        last_progress_at: number;
        status: string;
      }
    >(
      `SELECT * FROM cognition_coverage
        ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY last_progress_at DESC, source_id, workflow_id, workflow_version
        LIMIT ?`,
    )
    .all(...params)
    .map((r) => ({
      sourceId: r.source_id,
      workflowId: r.workflow_id,
      workflowVersion: r.workflow_version,
      eligible: r.eligible,
      processed: r.processed,
      skipped: r.skipped,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      lastProgressAt: r.last_progress_at,
      status: r.status as CognitionCoverageStatus,
    }));
}

/**
 * Drop coverage for sources the gateway no longer knows about at all.
 *
 * A row survives as long as its source exists in either sense the gateway
 * recognises: a `sources` registration, or documents in the corpus. Both have
 * to be gone, because either one alone is a lie in one direction. Keying only
 * on documents retracts a still-connected source that was merely emptied —
 * a resync, a provider-side purge — and the next settled run then rebuilds the
 * row from a `processed` increment with no `eligible` beside it, which reads
 * as `live`: "this is the real-time lane, it has no backlog", about a source
 * whose whole history is waiting. Keying only on the registration would strand
 * the gateway-internal sources, which mirror documents into the corpus without
 * ever appearing in `sources`.
 *
 * Called from the one cognitive-state cascade every document-delete path
 * already runs, rather than from each of those paths — the delete path that
 * forgets a step is the failure mode that design exists to rule out. Source
 * removal drops the `sources` row before it sweeps the documents, so by the
 * time the cascade runs both halves of the predicate hold. Returns the number
 * of rows dropped.
 */
export function retractOrphanCognitionCoverage(db: Db): number {
  return db
    .prepare(
      `DELETE FROM cognition_coverage
        WHERE NOT EXISTS (
                SELECT 1 FROM sources s WHERE s.id = cognition_coverage.source_id
              )
          AND NOT EXISTS (
                SELECT 1 FROM documents d WHERE d.source_id = cognition_coverage.source_id
              )`,
    )
    .run().changes;
}

/** Cheap guard so an install that never enabled the Brain pays nothing. */
export function hasAnyCognitionCoverage(db: Db): boolean {
  return db.prepare("SELECT 1 FROM cognition_coverage LIMIT 1").get() !== undefined;
}

/**
 * The source a document belongs to, or null when the document is gone. The
 * key coverage is tallied under: a run names a document, and the source is
 * what an operator asks coverage questions about.
 */
export function documentSourceId(db: Db, docId: string): string | null {
  return (
    db
      .prepare<[string], { source_id: string }>("SELECT source_id FROM documents WHERE id = ?")
      .get(docId)?.source_id ?? null
  );
}
