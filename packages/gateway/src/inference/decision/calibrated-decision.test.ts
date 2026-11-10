// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { CalibratedDecision } from "./calibrated-decision.js";
import { ConcurrencyLimiter } from "./limiter.js";
import type { DecisionCapability, DecisionRequest } from "@omnesis/core";

const REQUEST: DecisionRequest = {
  state: "x",
  questions: {
    four: { type: "score", instructions: "?", criteria: ["a", "b", "c", "d"] },
    three: { type: "score", instructions: "?", criteria: ["a", "b", "c"] },
    yes: { type: "noul", instructions: "?" },
    pick: { type: "choice", instructions: "?", criteria: { a: null, b: null } },
  },
};

function inner(): DecisionCapability {
  return {
    modelId: "kev",
    decide: async () => ({
      model: "kev:latest",
      answers: {
        four: { type: "score", score: 1.5, probabilities: { "1": 0.5, "2": 0.5 } },
        three: { type: "score", score: 1 },
        yes: { type: "noul", noul: 0.4 },
        pick: { type: "choice", choice: "b" },
      },
      inputTokens: 12,
    }),
    dispose: vi.fn(),
  };
}

describe("CalibratedDecision", () => {
  // Raw 0.5 (normalised) maps to 0.25: the model rates things higher than Jev.
  const calibration = {
    points: [
      [0, 0],
      [0.5, 0.25],
      [1, 1],
    ] as [number, number][],
    reference: "jev-worth/email-worth-v1/jev-1.13.0",
    fittedAt: "2026-11-10T00:00:00.000Z",
  };

  it("moves score answers onto Jev's scale, per question's level count, and leaves the rest", async () => {
    const wrapped = new CalibratedDecision(inner(), calibration);
    expect(wrapped.modelId).toBe("kev+cal");
    const result = await wrapped.decide(REQUEST);
    expect(result.model).toBe("kev:latest+cal");
    expect(result.inputTokens).toBe(12);
    expect(result.answers.four).toEqual({
      type: "score",
      score: 0.75,
      probabilities: { "1": 0.5, "2": 0.5 },
    });
    expect(result.answers.three).toEqual({ type: "score", score: 0.5 });
    expect(result.answers.yes).toEqual({ type: "noul", noul: 0.4 });
    expect(result.answers.pick).toEqual({ type: "choice", choice: "b" });
  });

  it("disposes the model it wraps", async () => {
    const model = inner();
    await new CalibratedDecision(model, calibration).dispose();
    expect(model.dispose).toHaveBeenCalled();
  });
});

describe("ConcurrencyLimiter", () => {
  it("lets a waiting request go when its caller gives up", async () => {
    const limiter = new ConcurrencyLimiter(1);
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((r) => (release = r)));
    const controller = new AbortController();
    const second = limiter.run(async () => "ran", controller.signal);
    expect(limiter.queued).toBe(1);
    controller.abort(new Error("gave up"));
    await expect(second).rejects.toThrow("gave up");
    expect(limiter.queued).toBe(0);
    release();
    await first;
    expect(limiter.running).toBe(0);
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });

  it("frees the slot when a task throws", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(limiter.run(async () => 1)).resolves.toBe(1);
  });

  it("refuses a limit below one", () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
  });
});
