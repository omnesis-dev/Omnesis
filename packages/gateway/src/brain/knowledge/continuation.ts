// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  enqueueCognitionRun,
  finalizeCognitionRun,
  type FinalizeCognitionRunInput,
} from "../storage/run-queue.js";
import { parseCognitionSynthesisRunPayload } from "../run-payloads.js";
import type { ClaimedCognitionRun } from "../storage/types.js";
import type { CognitionContextHandoffReason } from "../run-driver.js";
import type Database from "better-sqlite3";

export interface KnowledgeContinuationProgress {
  batchId: string;
  settled: number;
}

/** Offering inputs and changing a batch revision are not completed work. */
function settledFrontier(db: Database.Database, batchId: string): number {
  return db
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM knowledge_frontier WHERE batch_id=? AND status IN ('changed','unchanged','skipped')",
    )
    .get(batchId)!.count;
}

export function knowledgeContinuationProgress(
  db: Database.Database,
  run: Pick<ClaimedCognitionRun, "id" | "kind" | "payload">,
): KnowledgeContinuationProgress | null {
  const payload = run.kind === "synthesis" ? parseCognitionSynthesisRunPayload(run.payload) : null;
  if (payload?.focus !== "knowledge-maintenance" || !payload.batchId) return null;
  if (
    !db
      .prepare(
        "SELECT 1 FROM knowledge_batches WHERE id=? AND run_id=? AND status IN ('pending','running','deferred')",
      )
      .get(payload.batchId, run.id)
  )
    return null;
  return { batchId: payload.batchId, settled: settledFrontier(db, payload.batchId) };
}

/** Why a maintenance segment ended before its batch did. */
export type KnowledgeHandoffReason = "tool_iteration_cap" | CognitionContextHandoffReason;

export interface ContinueKnowledgeRunInput {
  progress: KnowledgeContinuationProgress;
  successorId: string;
  settlement: Omit<FinalizeCognitionRunInput, "outcome">;
  /** Defaults to the tool-call budget. */
  reason?: KnowledgeHandoffReason;
  /**
   * Consecutive context handoffs a batch may take without settling a frontier
   * input. A fresh context can succeed where a full one failed, but a segment
   * that overflows before saving anything would otherwise repeat forever.
   * A tool-call cap always needs progress. Defaults to none.
   */
  maxStalledHandoffs?: number;
}

const HANDOFF_MESSAGES: Record<KnowledgeHandoffReason, string> = {
  tool_iteration_cap:
    "Tool-call limit reached; remaining durable frontier continues in the linked run",
  context_budget: "Context budget reached; remaining durable frontier continues in the linked run",
  context_window_exceeded:
    "Model context window exceeded; remaining durable frontier continues in the linked run",
};

/**
 * Keep frontier progress and reservations while giving a paid segment its own
 * history. A segment continues when it settled frontier inputs, or — after a
 * context handoff — while its batch has stalled fewer than the allowed number
 * of consecutive times; the successor carries the stall count.
 */
export function continueKnowledgeRun(
  db: Database.Database,
  input: ContinueKnowledgeRunInput,
): boolean {
  return db.transaction(() => {
    const { settlement, progress } = input;
    if (db.prepare("SELECT 1 FROM cognition_runs WHERE id=?").get(input.successorId)) return false;
    const run = db
      .prepare<[string], { payload_json: string; dedupe_key: string | null }>(
        "SELECT payload_json,dedupe_key FROM cognition_runs WHERE id=? AND kind='synthesis' AND status='pending'",
      )
      .get(settlement.runId);
    if (!run || run.payload_json !== settlement.claimedPayloadJson) return false;
    const payload = parseCognitionSynthesisRunPayload(JSON.parse(run.payload_json));
    if (payload?.focus !== "knowledge-maintenance" || payload.batchId !== progress.batchId)
      return false;
    if (
      !db
        .prepare(
          "SELECT 1 FROM knowledge_batches WHERE id=? AND run_id=? AND status IN ('pending','running','deferred')",
        )
        .get(progress.batchId, settlement.runId)
    )
      return false;
    if (!Number.isSafeInteger(progress.settled) || progress.settled < 0) return false;
    const reason = input.reason ?? "tool_iteration_cap";
    const advanced = settledFrontier(db, progress.batchId) > progress.settled;
    const stalled = advanced ? 0 : (payload.stalledHandoffs ?? 0) + 1;
    if (!advanced && (reason === "tool_iteration_cap" || stalled > (input.maxStalledHandoffs ?? 0)))
      return false;
    finalizeCognitionRun(db, {
      ...settlement,
      // The segment bought a model turn even if its provider omitted usage.
      usage: settlement.usage ?? { promptTokens: 0, completionTokens: 0 },
      outcome: { kind: "completed" },
    });
    // The stall count is the successor's own; the predecessor's is replaced.
    const { stalledHandoffs: _stalled, ...inherited } = JSON.parse(run.payload_json) as Record<
      string,
      unknown
    >;
    enqueueCognitionRun(
      db,
      {
        id: input.successorId,
        kind: "synthesis",
        payload: {
          ...inherited,
          continuedFromRunId: settlement.runId,
          ...(stalled > 0 ? { stalledHandoffs: stalled } : {}),
        },
        ...(run.dedupe_key ? { dedupeKey: run.dedupe_key } : {}),
        notBefore: settlement.now,
      },
      settlement.now,
    );
    db.prepare(
      "UPDATE knowledge_batches SET run_id=?,status='pending',updated_at=?,revision=revision+1 WHERE id=?",
    ).run(input.successorId, settlement.now, progress.batchId);
    db.prepare(
      "UPDATE cognition_runs SET payload_json=json_set(payload_json,'$.continuedByRunId',?,'$.handoffReason',?),last_error=? WHERE id=?",
    ).run(input.successorId, reason, HANDOFF_MESSAGES[reason], settlement.runId);
    return true;
  })();
}
