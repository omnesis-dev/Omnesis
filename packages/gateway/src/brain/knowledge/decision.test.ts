// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { judgeKnowledge } from "./decision.js";

describe("knowledge decision scores", () => {
  it("distinguishes general information from personal evidence while preserving uncertainty and threshold", async () => {
    const record = vi.fn();
    const decision: DecisionCapability = {
      modelId: "scripted",
      dispose() {},
      async decide(request) {
        const question = request.questions.discovery;
        expect(question).toMatchObject({
          type: "score",
          instructions: expect.stringContaining(
            "uncertainty must receive at least the middle level",
          ),
        });
        expect(question.instructions).toContain(
          "broadcast sales offer, curated recommendation, or suggested contact alone",
        );
        expect(question.instructions).toContain("recipient-specific access windows or constraints");
        expect(question.instructions).toContain(
          "routine sign-in or verification code by itself is transient operational data",
        );
        expect(question.instructions).toContain(
          "preserve actual anomalous access, permission grants or revocations, account changes",
        );
        expect(question.instructions).toContain(
          "An account or membership label, subscription footer, or generic sales copy",
        );
        expect(question.instructions).toContain(
          "Forwarding or personal commentary can supply additional significance",
        );
        expect(question.instructions).toContain(
          "do not discard it merely because it is distributed widely",
        );
        expect(question.instructions).toContain(
          "General informative content requires affirmative personal or project relevance",
        );
        expect(question.instructions).toContain("evidence of deliberate curation for the owner");
        expect(question.instructions).toContain(
          "Delivery, subscription, or automatic storage alone does not establish deliberate curation",
        );
        expect(question.instructions).toContain(
          "Do not invent a possible personal connection just because no context rules one out",
        );
        expect(question.instructions).toContain(
          "concrete personal, account, transaction, relationship, or project signal",
        );
        expect(question.instructions).toContain("recipient's existing ownership or account");
        expect(question.instructions).toContain("a benefit already earned or assigned");
        expect(question.instructions).toContain("their saved search criteria");
        expect(question.instructions).toContain(
          "Inspect when their significance or truth is uncertain",
        );
        expect(question.instructions).toContain(
          "Inspection does not verify the advertised premise, create an obligation",
        );
        expect(question.instructions).toContain(
          "conditional purchase discount into a cash balance",
        );
        return { model: "scripted", answers: { discovery: { type: "score", score: 1 } } };
      },
    };
    expect(
      await judgeKnowledge(
        {
          getDecision: () => decision,
          record,
          recordSpend: async () => {},
          log: createLogger("test:knowledge-decision"),
        },
        "discovery",
        { source: { content: "Uncertain meaning" } },
        {
          runId: "run_sample",
          batchId: "batch_sample",
          nodeId: "source:doc_sample",
          threshold: 0.25,
        },
      ),
    ).toBe(0.5);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        rubricVersion: "knowledge-discovery-value-v7",
        runId: "run_sample",
        batchId: "batch_sample",
        nodeId: "source:doc_sample",
        threshold: 0.25,
      }),
    );
  });
  it.each([
    [0, 0],
    [1, 0.5],
    [2, 1],
    [-1, null],
    [3, null],
    [NaN, null],
  ])(
    "normalizes the model's level %s to %s, including its recorded verdict",
    async (raw, expected) => {
      const record = vi.fn();
      const spend = vi.fn();
      const decision: DecisionCapability = {
        modelId: "scripted",
        dispose() {},
        async decide(request) {
          expect(request.questions.urgency).toMatchObject({ type: "score" });
          return {
            model: "scripted",
            inputTokens: 7,
            answers: { urgency: { type: "score", score: raw } },
          };
        },
      };
      expect(
        await judgeKnowledge(
          {
            getDecision: () => decision,
            record,
            recordSpend: spend,
            log: createLogger("test:knowledge-decision"),
          },
          "urgency",
          { title: "Changed workshop time" },
        ),
      ).toBe(expected);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: "urgency",
          score: expected,
          rubricVersion: "knowledge-decisions-v2",
        }),
      );
      expect(spend).toHaveBeenCalledWith("scripted", 7);
    },
  );
});

it.each(["discovery", "impact", "review"] as const)(
  "captures the exact %s question/result and failed reply metadata only when a model was called",
  async (purpose) => {
    const record = vi.fn();
    const capture = {
      erasureGeneration: 0,
      subjects: [{ kind: "source" as const, id: "fictional-source" }],
    };
    const decision: DecisionCapability = {
      modelId: "scripted",
      dispose() {},
      async decide() {
        return { model: "scripted", answers: {}, inputTokens: 7 };
      },
    };
    const deps = {
      getDecision: () => decision,
      record,
      recordSpend: async () => {},
      log: createLogger("test:knowledge-decision"),
    };
    expect(
      await judgeKnowledge(
        deps,
        purpose,
        { fact: "The observatory closes at noon." },
        { payloadCapture: capture },
      ),
    ).toBeNull();
    const entry = record.mock.calls[0]![0];
    expect(JSON.parse(entry.payload.requestJson)).toMatchObject({
      state: { fact: "The observatory closes at noon." },
      questions: { [purpose]: { type: "score" } },
    });
    expect(JSON.parse(entry.payload.responseJson)).toEqual({ model: "scripted", answers: {} });
    expect(entry.payload.error).toContain("no score");
    expect(entry.inputTokens).toBe(7);
    record.mockClear();
    await judgeKnowledge(
      { ...deps, getDecision: () => null },
      purpose,
      { fact: "Unsent context." },
      { payloadCapture: capture },
    );
    if (purpose === "discovery") {
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          score: null,
          inputTokens: 0,
          bypass: expect.objectContaining({ reason: "decision_unavailable" }),
        }),
      );
      expect(record.mock.calls[0]![0].payload).toBeUndefined();
    } else expect(record).not.toHaveBeenCalled();
  },
);

it("gives review decisions numeric editorial growth context without treating unchanged prose as new work", async () => {
  const record = vi.fn();
  const decision: DecisionCapability = {
    modelId: "scripted",
    dispose() {},
    async decide(request) {
      expect(request.questions.review.instructions).toContain(
        "substantial growth warrants consolidation",
      );
      expect(request.questions.review.instructions).toContain("unchanged");
      return { model: "scripted", answers: { review: { type: "score", score: 0 } } };
    },
  };
  await judgeKnowledge(
    {
      getDecision: () => decision,
      record,
      recordSpend: async () => {},
      log: createLogger("review-test"),
    },
    "review",
    { editorial: { substantialGrowth: true, currentClaims: 8, reviewedClaims: 3 } },
  );
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({ rubricVersion: "knowledge-review-timing-v4" }),
  );
});
