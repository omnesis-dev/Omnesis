// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, vi } from "vitest";
import { createLogger, type DecisionCapability, type DecisionRequest } from "@omnesis/core";
import { askScore } from "./decision-call.js";

const request: DecisionRequest = {
  state: { subject: "A fictional workshop plan" },
  questions: {
    useful: { type: "score", instructions: "Assess usefulness", criteria: ["Low", "High"] },
  },
};
const log = createLogger("test").child("decision-call");

it("retains a returned result and its spend when the requested score is missing", async () => {
  const recordSpend = vi.fn(async () => {});
  const decision: DecisionCapability = {
    modelId: "scripted-requested",
    decide: async () => ({ model: "scripted-returned", answers: {}, inputTokens: 17 }),
    dispose() {},
  };
  const result = await askScore(decision, request, "useful", { recordSpend, log });
  expect(result).toMatchObject({ modelId: "scripted-returned", score: null, inputTokens: 17 });
  expect(result.error).toContain('no score for "useful"');
  expect(JSON.parse(result.requestJson)).toEqual({ model: decision.modelId, ...request });
  expect(JSON.parse(result.responseJson!)).toEqual({ model: "scripted-returned", answers: {} });
  expect(recordSpend).toHaveBeenCalledExactlyOnceWith("scripted-returned", 17);
});

it("rejects non-finite scores without hiding their known inference cost", async () => {
  const recordSpend = vi.fn(async () => {});
  const decision: DecisionCapability = {
    modelId: "scripted",
    decide: async () => ({
      model: "scripted",
      answers: { useful: { type: "score", score: NaN } },
      inputTokens: 11,
    }),
    dispose() {},
  };
  const result = await askScore(decision, request, "useful", { recordSpend, log });
  expect(result.score).toBeNull();
  expect(result.error).not.toBeNull();
  expect(result.inputTokens).toBe(11);
  expect(recordSpend).toHaveBeenCalledExactlyOnceWith("scripted", 11);
});

it("keeps a failed call's request but does not invent a response or usage", async () => {
  const recordSpend = vi.fn(async () => {});
  const decision: DecisionCapability = {
    modelId: "scripted",
    decide: async () => {
      throw new Error("Scripted service unavailable");
    },
    dispose() {},
  };
  const result = await askScore(decision, request, "useful", { recordSpend, log });
  expect(result).toMatchObject({
    score: null,
    responseJson: null,
    inputTokens: null,
    error: "Scripted service unavailable",
  });
  expect(JSON.parse(result.requestJson).state).toEqual(request.state);
  expect(recordSpend).not.toHaveBeenCalled();
});

it.each([-0.01, 1.01])(
  "rejects score %s outside the requested scale while retaining the answer and spend",
  async (score) => {
    const recordSpend = vi.fn(async () => {});
    const decision: DecisionCapability = {
      modelId: "scripted",
      decide: async () => ({
        model: "scripted",
        answers: { useful: { type: "score", score } },
        inputTokens: 5,
      }),
      dispose() {},
    };
    const result = await askScore(decision, request, "useful", { recordSpend, log });
    expect(result.score).toBeNull();
    expect(result.error).toContain("out-of-range");
    expect(JSON.parse(result.responseJson!).answers.useful.score).toBe(score);
    expect(recordSpend).toHaveBeenCalledExactlyOnceWith("scripted", 5);
  },
);
