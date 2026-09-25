// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Durable attribution for the runs that wrote cognitive state: which workflow
 * produced an artifact, at which version of that workflow, on which model.
 *
 * Every durable artifact — loops, briefs, doc/person/temporal annotations —
 * already carries `created_by_run`. That was enough to answer "what made
 * this?" only for as long as the run row survived, and settled run rows are
 * deleted once past the retention window. Artifacts are permanent; their
 * provenance was not. An operator asking why a two-month-old loop exists, or
 * a workflow wanting to declare the artifacts of its previous version stale,
 * both landed on a dangling id.
 *
 * One row per run, written when the run settles and never pruned. Artifacts
 * keep pointing at the run id, so attribution survives through a join and a
 * new artifact type needs no schema change — the alternative, stamping three
 * more columns onto every artifact table, denormalises the same facts five
 * times and still misses the sixth table someone adds later.
 */

import type { CognitiveWorkflowId } from "../cognition/workflows.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface RunAttribution {
  runId: string;
  /** The semantic procedure the run performed. */
  workflowId: CognitiveWorkflowId;
  /**
   * The workflow's contract version at the time it ran. A bump means the
   * prompt, tools, or output shape changed enough that older artifacts were
   * produced under different rules.
   */
  workflowVersion: number;
  /** Resolved backend model id; `''` when the backend reported none. */
  modelId: string;
  /** When the run settled (unix ms). */
  settledAt: number;
}

export function createRunAttributionTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_run_attribution (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_version INTEGER NOT NULL,
      model_id TEXT NOT NULL DEFAULT '',
      settled_at INTEGER NOT NULL
    )
  `);
  // "Which runs of workflow X ran below version N" — the staleness sweep.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_run_attribution_workflow ON cognition_run_attribution(workflow_id, workflow_version)",
  );
}

/**
 * Record what produced a run's output. Idempotent on the run id so a
 * re-attempt that settles twice does not duplicate, and so a retried run ends
 * attributed to the attempt that actually finished.
 */
export function recordRunAttribution(db: Db, row: RunAttribution): void {
  db.prepare<[string, string, number, string, number]>(
    `INSERT INTO cognition_run_attribution (run_id, workflow_id, workflow_version, model_id, settled_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       workflow_id = excluded.workflow_id,
       workflow_version = excluded.workflow_version,
       model_id = excluded.model_id,
       settled_at = excluded.settled_at`,
  ).run(row.runId, row.workflowId, row.workflowVersion, row.modelId, row.settledAt);
}

/** What produced one run's output; null when the run predates attribution. */
export function getRunAttribution(db: Db, runId: string): RunAttribution | null {
  const row = db
    .prepare<
      [string],
      {
        run_id: string;
        workflow_id: string;
        workflow_version: number;
        model_id: string;
        settled_at: number;
      }
    >("SELECT * FROM cognition_run_attribution WHERE run_id = ?")
    .get(runId);
  if (!row) return null;
  return {
    runId: row.run_id,
    workflowId: row.workflow_id as CognitiveWorkflowId,
    workflowVersion: row.workflow_version,
    modelId: row.model_id,
    settledAt: row.settled_at,
  };
}

/**
 * Runs of a workflow that executed below a given contract version — the set
 * whose artifacts were produced under superseded rules.
 *
 * Returning run ids rather than artifacts keeps this store ignorant of what
 * cites it: a caller joins against whichever artifact table it maintains.
 * Runs with no attribution row are deliberately absent — "we cannot tell what
 * produced this" is not the same claim as "this is stale", and treating it as
 * such would re-derive a corpus's worth of state on the first version bump.
 */
export function runIdsBelowWorkflowVersion(
  db: Db,
  workflowId: CognitiveWorkflowId,
  version: number,
): string[] {
  return db
    .prepare<[string, number], { run_id: string }>(
      "SELECT run_id FROM cognition_run_attribution WHERE workflow_id = ? AND workflow_version < ? ORDER BY settled_at",
    )
    .all(workflowId, version)
    .map((r) => r.run_id);
}

/** How many runs are attributed, per workflow — operator telemetry. */
export function countAttributedRunsByWorkflow(db: Db): Array<{ workflowId: string; runs: number }> {
  return db
    .prepare<[], { workflow_id: string; runs: number }>(
      "SELECT workflow_id, COUNT(*) AS runs FROM cognition_run_attribution GROUP BY workflow_id ORDER BY runs DESC",
    )
    .all()
    .map((r) => ({ workflowId: r.workflow_id, runs: r.runs }));
}
