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
      ),
    ).toBe(0.5);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ rubricVersion: "knowledge-discovery-value-v3" }),
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
