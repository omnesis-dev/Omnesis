// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { judgeKnowledge, knowledgeUrgencyState } from "./decision.js";
import type { OwnerInterest } from "../interest/lookup.js";

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
          rubricVersion: "knowledge-decisions-v3",
        }),
      );
      expect(spend).toHaveBeenCalledWith("scripted", 7);
    },
  );

  it("names the urgency rubric that reads owner_interest while impact keeps its own", async () => {
    const record = vi.fn();
    const decision: DecisionCapability = {
      modelId: "scripted",
      dispose() {},
      async decide(request) {
        const [purpose] = Object.keys(request.questions);
        if (purpose === "urgency")
          expect(request.questions.urgency!.instructions).toContain("`owner_interest`");
        return { model: "scripted", answers: { [purpose!]: { type: "score", score: 1 } } };
      },
    };
    const deps = {
      getDecision: () => decision,
      record,
      recordSpend: async () => {},
      log: createLogger("test:knowledge-decision"),
    };
    await judgeKnowledge(deps, "urgency", { title: "Changed workshop time" });
    await judgeKnowledge(deps, "impact", { nodeId: "node_sample" });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "urgency", rubricVersion: "knowledge-decisions-v3" }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "impact", rubricVersion: "knowledge-decisions-v2" }),
    );
  });

  it("records an unavailable urgency verdict under the same rubric as a judged one", async () => {
    const record = vi.fn();
    await judgeKnowledge(
      {
        getDecision: () => null,
        record,
        recordSpend: async () => {},
        log: createLogger("test:knowledge-decision"),
      },
      "urgency",
      { title: "Changed workshop time" },
      {
        urgencyCapture: {
          sourceId: "doc_sample",
          inputRevision: "v1",
          erasureGeneration: 0,
          policy: {
            immediateThreshold: 0.75,
            soonThreshold: 0.5,
            soonDelayMs: 1,
            routineDelayMs: 2,
          },
        },
      },
    );
    expect(record).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        purpose: "urgency",
        score: null,
        modelId: "unavailable",
        rubricVersion: "knowledge-decisions-v3",
      }),
    );
  });
});

describe("knowledgeUrgencyState", () => {
  const source = {
    documentId: "doc_sample",
    title: "Workshop booking moved",
    content: "The reserved workshop now starts on Thursday. ".repeat(600),
  };
  const ownerInterest: OwnerInterest = {
    positive: [
      {
        text: "Workshop booking confirmed",
        source: "task_created",
        ageDays: 5,
        similarity: 0.7,
        basis: "words",
      },
    ],
    negative: [],
    statements: [],
  };

  it("asks the ledger about the title and the head of the content and adds what it finds", async () => {
    const lookup = vi.fn(async () => ownerInterest);
    const state = await knowledgeUrgencyState(source, { lookup });
    expect(lookup).toHaveBeenCalledExactlyOnceWith({
      text: `${source.title}\n${source.content.slice(0, 2000)}`,
    });
    expect(state).toEqual({
      documentId: source.documentId,
      title: source.title,
      content: source.content.slice(0, 24000),
      owner_interest: ownerInterest,
    });
  });

  it("leaves the state as it was without a ledger or without anything similar in it", async () => {
    const bare = await knowledgeUrgencyState(source, undefined);
    expect(bare).toEqual({
      documentId: source.documentId,
      title: source.title,
      content: source.content.slice(0, 24000),
    });
    const lookup = vi.fn(async () => null);
    expect(await knowledgeUrgencyState(source, { lookup })).toEqual(bare);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
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
