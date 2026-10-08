// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { judgeKnowledge } from "./decision.js";

describe("knowledge decision scores", () => {
  it("versions only discovery's rubric and explicitly keeps uncertain evidence", async () => {
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
          "Forwarding or personal commentary can supply additional significance",
        );
        expect(question.instructions).toContain(
          "do not discard it merely because it is distributed widely",
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
        rubricVersion: "knowledge-discovery-value-v5",
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
    expect(record).not.toHaveBeenCalled();
  },
);
