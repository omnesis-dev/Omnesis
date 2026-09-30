// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { createLogger, type DecisionCapability, type DecisionRequest } from "@omnesis/core";

import { QueueTracker } from "../../background-jobs/trackers.js";
import { WORTH_GATE_RUBRIC_VERSION } from "../../brain/worth-gate/rubric.js";
import { DATE_ENRICHMENT_DEFAULTS } from "./config.js";
import { mentionWorthGateTask } from "./worth-gate-task.js";
import type {
  MentionJudgementDeferral,
  MentionJudgementRecord,
  PendingMentionJudgement,
} from "./mention-judgements.js";

const log = createLogger("test");

const STATE = { subject: "Your order ships Friday", from: "Shop <shop@example.com>", body: "…" };

type Ask = Extract<PendingMentionJudgement, { kind: "ask" }>;

/** One tick, as the scheduler runs it. */
const tick = (task: ReturnType<typeof mentionWorthGateTask>) => task.run(undefined, {} as never);

function ask(documentId: string, subjectDocumentId = documentId): Ask {
  return {
    documentId,
    generation: 3,
    attempts: 0,
    kind: "ask",
    subjectDocumentId,
    contentHash: `hash-${subjectDocumentId}`,
    state: STATE,
  };
}

/** A decision model answering each subject from a table; a missing entry throws. */
function scripted(scores: Record<string, number>): DecisionCapability & {
  calls: DecisionRequest[];
} {
  const calls: DecisionRequest[] = [];
  return {
    modelId: "jev-test",
    calls,
    async decide(request) {
      calls.push(request);
      const score = scores[String((request.state as { subject?: unknown }).subject)];
      if (score === undefined) throw new Error("TypeSafe HTTP 503");
      return {
        model: "jev-test",
        answers: { worth_score: { type: "score", score } },
        inputTokens: 1000,
      };
    },
    dispose() {},
  };
}

function build(opts: {
  worthGate?: boolean;
  decision: DecisionCapability | null;
  batches: PendingMentionJudgement[][];
}) {
  const applied: MentionJudgementRecord[] = [];
  const deferred: MentionJudgementDeferral[] = [];
  const requeued: string[] = [];
  const spend: Array<{ modelId: string; inputTokens: number }> = [];
  const tracker = new QueueTracker();
  const task = mentionWorthGateTask({
    ioGate: {
      fetchPendingMentionJudgements: async () => opts.batches.shift() ?? [],
    },
    writeGate: {
      applyMentionJudgements: async (records, deferrals) => {
        applied.push(...records);
        deferred.push(...deferrals);
        return records.length;
      },
      requeueStaleMentionJudgements: async (version) => {
        requeued.push(version);
        return 0;
      },
    },
    getSettings: () => ({ ...DATE_ENRICHMENT_DEFAULTS, worthGate: opts.worthGate ?? true }),
    getDecision: () => opts.decision,
    recordSpend: async (modelId, inputTokens) => {
      spend.push({ modelId, inputTokens });
    },
    tracker,
    clock: () => 42,
    log,
  });
  return { task, applied, deferred, requeued, spend };
}

describe("mentionWorthGateTask", () => {
  it("idles without asking while the setting is off or no decision model is ready", async () => {
    const decision = scripted({});
    for (const setup of [
      { worthGate: false, decision },
      { worthGate: true, decision: null },
    ]) {
      const { task, applied } = build({ ...setup, batches: [[ask("d1")]] });
      expect(await tick(task)).toMatchObject({ value: { idle: true } });
      expect(applied).toEqual([]);
    }
    expect(decision.calls).toEqual([]);
  });

  it("keeps a document scored at the threshold and drops one below it", async () => {
    const decision = scripted({ keep: 1.08, drop: 1.07 });
    const { task, applied, requeued, spend } = build({
      decision,
      batches: [
        [
          { ...ask("a"), state: { ...STATE, subject: "keep" } },
          { ...ask("b"), state: { ...STATE, subject: "drop" } },
        ],
      ],
    });
    expect(await tick(task)).toMatchObject({ value: { idle: false } });
    expect(requeued).toEqual([WORTH_GATE_RUBRIC_VERSION]);
    const verdicts = Object.fromEntries(applied.map((r) => [r.documentId, r.verdict]));
    expect(verdicts).toEqual({ a: "keep", b: "drop" });
    expect(applied.find((r) => r.documentId === "a")).toMatchObject({
      generation: 3,
      rubricVersion: WORTH_GATE_RUBRIC_VERSION,
      requestedModelId: "jev-test",
      modelId: "jev-test",
      inputTokens: 1000,
      judgedAt: 42,
    });
    expect(spend).toEqual([
      { modelId: "jev-test", inputTokens: 1000 },
      { modelId: "jev-test", inputTokens: 1000 },
    ]);
  });

  it("asks once for an email and its attachments", async () => {
    const decision = scripted({ [STATE.subject]: 0.3 });
    const { task, applied, spend } = build({
      decision,
      // The attachment comes first; the email still carries the call.
      batches: [[ask("attachment", "email"), ask("email")]],
    });
    await tick(task);
    expect(decision.calls).toHaveLength(1);
    expect(spend).toHaveLength(1);
    const attachment = applied.find((r) => r.documentId === "attachment");
    expect(attachment).toMatchObject({
      verdict: "drop",
      subjectDocumentId: "email",
      reusedDocumentId: "email",
      inputTokens: null,
    });
    expect(applied.find((r) => r.documentId === "email")).toMatchObject({
      reusedDocumentId: null,
      inputTokens: 1000,
    });
  });

  it("settles exemptions and reused answers without asking", async () => {
    const decision = scripted({});
    const { task, applied } = build({
      decision,
      batches: [
        [
          {
            documentId: "note",
            generation: 1,
            attempts: 0,
            kind: "exempt",
            subjectDocumentId: null,
          },
          {
            documentId: "seen",
            generation: 1,
            attempts: 0,
            kind: "reuse",
            subjectDocumentId: "seen",
            contentHash: "hash-seen",
            score: 2.5,
            modelId: "jev-test",
            reusedDecisionId: "dec_1",
            reusedDocumentId: null,
          },
        ],
      ],
    });
    await tick(task);
    expect(decision.calls).toEqual([]);
    expect(applied.map((r) => [r.documentId, r.verdict, r.reusedDecisionId])).toEqual([
      ["note", "exempt", null],
      ["seen", "keep", "dec_1"],
    ]);
  });

  it("defers a document the model failed on, and keeps settling the rest of the batch", async () => {
    const decision = scripted({ fine: 2 });
    const { task, applied, deferred } = build({
      decision,
      batches: [
        [
          { ...ask("failing"), attempts: 2, state: { ...STATE, subject: "unanswered" } },
          { ...ask("fine"), state: { ...STATE, subject: "fine" } },
        ],
      ],
    });
    expect(await tick(task)).toMatchObject({ value: { idle: false } });
    expect(applied.map((r) => r.documentId)).toEqual(["fine"]);
    // Third failure: four minutes after the clock.
    expect(deferred).toEqual([
      { documentId: "failing", generation: 3, nextAttemptAt: 42 + 240_000 },
    ]);
  });

  it("rests when nothing in reach could be settled", async () => {
    const decision = scripted({});
    const { task, applied, deferred } = build({ decision, batches: [[ask("d1")]] });
    expect(await tick(task)).toMatchObject({ value: { idle: true } });
    expect(applied).toEqual([]);
    expect(deferred).toHaveLength(1);
  });

  it("defers an attachment whose email has not arrived, without asking", async () => {
    const decision = scripted({});
    const { task, deferred } = build({
      decision,
      batches: [[{ documentId: "att", generation: 1, attempts: 0, kind: "wait" }]],
    });
    await tick(task);
    expect(decision.calls).toEqual([]);
    expect(deferred).toEqual([{ documentId: "att", generation: 1, nextAttemptAt: 42 + 60_000 }]);
  });

  it("requeues stale-rubric judgements a batch per tick before judging", async () => {
    const decision = scripted({});
    const requeueSizes = [500, 3];
    const calls: number[] = [];
    const task = mentionWorthGateTask({
      ioGate: { fetchPendingMentionJudgements: async () => [] },
      writeGate: {
        applyMentionJudgements: async () => 0,
        requeueStaleMentionJudgements: async (_version, limit) => {
          calls.push(limit);
          return requeueSizes.shift() ?? 0;
        },
      },
      getSettings: () => ({ ...DATE_ENRICHMENT_DEFAULTS, worthGate: true }),
      getDecision: () => decision,
      recordSpend: async () => {},
      tracker: new QueueTracker(),
      log,
    });
    expect(await tick(task)).toMatchObject({ value: { idle: false } });
    await tick(task);
    await tick(task);
    expect(calls).toEqual([500, 500]);
  });
});
