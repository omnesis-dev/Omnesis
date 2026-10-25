// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import {
  claimDueCognitionRuns,
  enqueueCognitionRun,
  getCognitionRun,
} from "../storage/run-queue.js";
import { cognitionSpendDay } from "../storage/spend.js";
import {
  continueKnowledgeRun,
  knowledgeContinuationProgress,
  type ContinueKnowledgeRunInput,
} from "./continuation.js";

let db: ReturnType<typeof createDatabase>;
beforeEach(() => {
  db = createDatabase(":memory:");
  enqueueCognitionRun(
    db,
    {
      id: "run",
      kind: "synthesis",
      dedupeKey: "batch-run",
      payload: { focus: "knowledge-maintenance", batchId: "batch" },
    },
    1,
  );
  db.exec(`INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','fp','routine','running',1,1);
    INSERT INTO knowledge_batch_regions VALUES('batch','source:first'),('batch','source:second');
    INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status) VALUES('batch','source:first','first','{}',0,'offered'),('batch','source:second','second','{}',0,'offered');`);
});
afterEach(() => db.close());
function continuation(): ContinueKnowledgeRunInput {
  const [run] = claimDueCognitionRuns(db, { now: 2, limit: 1 });
  return {
    progress: knowledgeContinuationProgress(db, run!)!,
    successorId: "successor",
    settlement: {
      runId: "run",
      claimedPayloadJson: run!.payloadJson,
      now: 3,
      day: cognitionSpendDay(3),
      mechanism: "knowledge-maintenance",
      modelId: "scripted",
      usage: { promptTokens: 100, completionTokens: 20 },
    },
  };
}
function settleFirst() {
  db.exec("UPDATE knowledge_frontier SET status='unchanged' WHERE node_id='source:first'");
}

it("atomically hands off the same frontier and reservations and bills the paid segment", () => {
  const input = continuation();
  settleFirst();
  expect(continueKnowledgeRun(db, input)).toBe(true);
  expect(getCognitionRun(db, "run")).toMatchObject({
    status: "completed",
    attempts: 1,
    usage: { promptTokens: 100, completionTokens: 20 },
    payload: { continuedByRunId: "successor" },
  });
  expect(getCognitionRun(db, "successor")).toMatchObject({
    status: "pending",
    attempts: 0,
    nextAttemptAt: 3,
    payload: { batchId: "batch", continuedFromRunId: "run" },
  });
  expect(db.prepare("SELECT run_id,status FROM knowledge_batches").get()).toEqual({
    run_id: "successor",
    status: "pending",
  });
  expect(
    db.prepare("SELECT node_id,status FROM knowledge_frontier ORDER BY node_id").all(),
  ).toEqual([
    { node_id: "source:first", status: "unchanged" },
    { node_id: "source:second", status: "offered" },
  ]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_batch_regions").get()).toEqual({
    count: 2,
  });
  expect(
    db
      .prepare(
        "SELECT SUM(runs) AS runs,SUM(prompt_tokens) AS prompt,SUM(completion_tokens) AS completion FROM cognition_spend",
      )
      .get(),
  ).toEqual({ runs: 1, prompt: 100, completion: 20 });
  expect(continueKnowledgeRun(db, input)).toBe(false);
  expect(db.prepare("SELECT SUM(runs) AS runs FROM cognition_spend").get()).toEqual({ runs: 1 });
});

it.each([
  "no-progress",
  "offering-only",
  "wrong-owner",
  "wrong-batch",
  "existing-successor",
  "folded-payload",
] as const)("refuses continuation without trusted progress: %s", (scenario) => {
  const input = continuation();
  if (scenario !== "no-progress" && scenario !== "offering-only") settleFirst();
  if (scenario === "offering-only") db.exec("UPDATE knowledge_batches SET revision=revision+1");
  if (scenario === "wrong-owner") db.exec("UPDATE knowledge_batches SET run_id='other'");
  if (scenario === "wrong-batch") input.progress.batchId = "different";
  if (scenario === "existing-successor") input.successorId = "run";
  if (scenario === "folded-payload")
    db.exec("UPDATE cognition_runs SET payload_json=json_set(payload_json,'$.newInput',1)");
  expect(continueKnowledgeRun(db, input)).toBe(false);
  expect(getCognitionRun(db, "run")?.status).toBe("pending");
  expect(db.prepare("SELECT COUNT(*) AS count FROM cognition_spend").get()).toEqual({ count: 0 });
});

it("counts a paid continuation against the run budget even when usage was omitted", () => {
  const input = continuation();
  input.settlement.usage = null;
  settleFirst();
  expect(continueKnowledgeRun(db, input)).toBe(true);
  expect(db.prepare("SELECT SUM(runs) AS runs FROM cognition_spend").get()).toEqual({ runs: 1 });
});

it("records why the segment ended on the settled run", () => {
  const input = { ...continuation(), reason: "context_budget" as const };
  settleFirst();
  expect(continueKnowledgeRun(db, input)).toBe(true);
  expect(getCognitionRun(db, "run")).toMatchObject({
    payload: { continuedByRunId: "successor", handoffReason: "context_budget" },
    lastError: "Context budget reached; remaining durable frontier continues in the linked run",
  });
  // A segment that settled input starts its successor with a clean stall count.
  expect(getCognitionRun(db, "successor")?.payload).not.toHaveProperty("stalledHandoffs");
  expect(getCognitionRun(db, "successor")?.payload).not.toHaveProperty("handoffReason");
});

it("bounds consecutive context handoffs that settle nothing", () => {
  const segment = (runId: string, successorId: string, now: number) => {
    const [run] = claimDueCognitionRuns(db, { now, limit: 1 });
    expect(run?.id).toBe(runId);
    return continueKnowledgeRun(db, {
      progress: knowledgeContinuationProgress(db, run!)!,
      successorId,
      reason: "context_window_exceeded",
      maxStalledHandoffs: 2,
      settlement: {
        runId,
        claimedPayloadJson: run!.payloadJson,
        now: now + 1,
        day: cognitionSpendDay(now + 1),
        mechanism: "knowledge-maintenance",
        modelId: "scripted",
        usage: { promptTokens: 100, completionTokens: 20 },
      },
    });
  };
  expect(segment("run", "second", 2)).toBe(true);
  expect(getCognitionRun(db, "second")?.payload).toMatchObject({ stalledHandoffs: 1 });
  expect(segment("second", "third", 4)).toBe(true);
  expect(getCognitionRun(db, "third")?.payload).toMatchObject({ stalledHandoffs: 2 });
  // The third stalled segment takes the ordinary failure path instead.
  expect(segment("third", "fourth", 6)).toBe(false);
  expect(getCognitionRun(db, "third")?.status).toBe("pending");
  expect(getCognitionRun(db, "fourth")).toBeNull();
});

it("never continues a tool-capped segment that settled nothing, whatever the stall allowance", () => {
  const input = { ...continuation(), maxStalledHandoffs: 5 };
  expect(continueKnowledgeRun(db, input)).toBe(false);
});
