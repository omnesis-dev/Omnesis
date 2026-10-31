// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
import type { ExecutedTool } from "./brain-bench/obs.js";

/** Failed-action ordinals belonging to a verified, completed ownership handoff.
 * A tool's error code alone proves nothing: require the driver's durable batch
 * fence and completion of every original batch work obligation (including source
 * seeds), either already settled or replaced at the same revision. This does not
 * prove every inherited frontier mutation executed; the scorecard's semantic gold
 * assertions check its outcomes. Missing transcripts, pending source retries and
 * unrelated completions remain failures.
 */
export function verifiedMaintenanceHandoffs(
  db: Database.Database,
  decision: {
    runId: string;
    attempt: number;
    actions: ReadonlyArray<{ tool: string; ok: boolean }>;
  },
  steps: readonly ExecutedTool[],
): Set<number> {
  const verified = new Set<number>();
  const failures = decision.actions.filter((action) => !action.ok);
  const errors = steps.filter((step) => step.result?.kind === "error");
  if (!errors.some((step) => step.result?.code === "maintenance_handoff")) return verified;
  if (
    errors.length !== failures.length ||
    errors.some((step, i) => step.tool !== failures[i]?.tool)
  )
    return verified;
  const batch = db
    .prepare<[string, number], { id: string }>(
      `
    SELECT b.id FROM knowledge_batches b JOIN cognition_runs r ON r.id=b.run_id
    WHERE r.id=? AND r.attempts=? AND r.status='completed' AND r.kind='synthesis'
      AND json_extract(r.payload_json,'$.focus')='knowledge-maintenance'
      AND json_extract(r.payload_json,'$.batchId')=b.id AND b.status='abandoned'
  `,
    )
    .get(decision.runId, decision.attempt);
  if (!batch) return verified;
  const work = db
    .prepare<[string], { status: string; recovered: number }>(
      `
    SELECT w.status, EXISTS (
      SELECT 1 FROM knowledge_work next JOIN knowledge_batches b ON b.id=next.batch_id
        JOIN cognition_runs r ON r.id=b.run_id
      WHERE next.subject_kind=w.subject_kind AND next.subject_id=w.subject_id
        AND next.reason=w.reason AND next.input_revision=w.input_revision
        AND next.id!=w.id AND next.created_at>=w.created_at
        AND next.status='completed' AND b.status='completed' AND r.status='completed'
        AND r.kind='synthesis' AND json_extract(r.payload_json,'$.focus')='knowledge-maintenance'
        AND json_extract(r.payload_json,'$.batchId')=b.id
    ) AS recovered FROM knowledge_work w WHERE w.batch_id=?
  `,
    )
    .all(batch.id);
  if (
    !work.length ||
    work.some(
      (item) => item.status !== "completed" && (item.status !== "deferred" || !item.recovered),
    )
  )
    return verified;
  for (const [ordinal, step] of errors.entries()) {
    if (step.result?.code === "maintenance_handoff") verified.add(ordinal);
  }
  return verified;
}
