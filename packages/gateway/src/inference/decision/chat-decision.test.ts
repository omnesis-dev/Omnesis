// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  answerFromTokenProbabilities,
  decisionOptions,
  renderDecisionPrompt,
} from "./chat-decision.js";
import type { DecisionQuestion } from "@omnesis/core";

const noul: DecisionQuestion = {
  type: "noul",
  instructions: "Is this a bill to pay?",
  criteria: { true: "It asks for payment.", false: "It does not." },
};
const score: DecisionQuestion = {
  type: "score",
  instructions: "Worth recording?",
  criteria: ["No.", "Minor.", "Yes.", "Important."],
};
const choice: DecisionQuestion = {
  type: "choice",
  instructions: "Route the capture.",
  criteria: { ask: "A question to answer.", tell: "A note to save.", needs_review: null },
};

describe("decisionOptions", () => {
  it("labels each question type with single-token labels", () => {
    expect(decisionOptions(noul).map((o) => [o.label, o.key])).toEqual([
      ["yes", "true"],
      ["no", "false"],
    ]);
    expect(decisionOptions(score).map((o) => o.label)).toEqual(["0", "1", "2", "3"]);
    expect(decisionOptions(choice).map((o) => [o.label, o.key])).toEqual([
      ["A", "ask"],
      ["B", "tell"],
      ["C", "needs_review"],
    ]);
  });

  it("refuses a score with more levels than single digits can label", () => {
    const wide: DecisionQuestion = {
      type: "score",
      instructions: "x",
      criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`),
    };
    expect(() => decisionOptions(wide)).toThrow(/2–10 levels/);
  });
});

describe("renderDecisionPrompt", () => {
  it("puts the content first, then the question, then the labels", () => {
    const state = { subject: "Invoice due", from: "billing@example.com" };
    const { system, user } = renderDecisionPrompt(state, score, decisionOptions(score));
    expect(system).toMatch(/exactly one of the listed labels/);
    const content = user.indexOf('{"from":"billing@example.com","subject":"Invoice due"}');
    const question = user.indexOf("Worth recording?");
    const labels = user.indexOf("3: Important.");
    expect(content).toBeGreaterThanOrEqual(0);
    expect(question).toBeGreaterThan(content);
    expect(labels).toBeGreaterThan(question);
    expect(user).toMatch(/Answer with exactly one label \(0, 1, 2, 3\)\.$/);
  });

  it("renders the content identically for every question of a request", () => {
    const state = { body: "Due 12 Nov." };
    const a = renderDecisionPrompt(state, noul, decisionOptions(noul)).user;
    const b = renderDecisionPrompt(state, choice, decisionOptions(choice)).user;
    const prefix = "Content:\n" + '{"body":"Due 12 Nov."}' + "\n";
    expect(a.startsWith(prefix)).toBe(true);
    expect(b.startsWith(prefix)).toBe(true);
  });

  it("shows a bare label for an option without a description", () => {
    const { user } = renderDecisionPrompt("text", choice, decisionOptions(choice));
    expect(user).toContain("\nC\n");
  });
});

describe("answerFromTokenProbabilities", () => {
  it("reads a noul as the probability of yes, merging spellings", () => {
    const answer = answerFromTokenProbabilities(noul, decisionOptions(noul), [
      { token: "yes", probability: 0.5 },
      { token: " Yes", probability: 0.2 },
      { token: "no", probability: 0.2 },
      { token: "The", probability: 0.1 },
    ]);
    expect(answer.type).toBe("noul");
    expect((answer as { noul: number }).noul).toBeCloseTo(0.7 / 0.9);
  });

  it("reads a score as the probability-weighted level", () => {
    const answer = answerFromTokenProbabilities(score, decisionOptions(score), [
      { token: "2", probability: 0.4 },
      { token: "3", probability: 0.4 },
      { token: "1", probability: 0.2 },
    ]);
    expect(answer).toMatchObject({ type: "score", confidence: 0.4 });
    if (answer.type !== "score") throw new Error("unreachable");
    expect(answer.score).toBeCloseTo(0.2 + 0.8 + 1.2);
    expect(answer.probabilities).toEqual({ "0": 0, "1": 0.2, "2": 0.4, "3": 0.4 });
  });

  it("reads a choice as the most probable key, mapped back from its letter", () => {
    const answer = answerFromTokenProbabilities(choice, decisionOptions(choice), [
      { token: "B", probability: 0.6 },
      { token: "a", probability: 0.3 },
      { token: "C", probability: 0.1 },
    ]);
    expect(answer).toMatchObject({ type: "choice", choice: "tell" });
    if (answer.type !== "choice") throw new Error("unreachable");
    expect(answer.confidence).toBeCloseTo(0.6);
    expect(answer.probabilities?.ask).toBeCloseTo(0.3);
    expect(answer.probabilities?.needs_review).toBeCloseTo(0.1);
  });

  it("throws when no label is among the candidates", () => {
    expect(() =>
      answerFromTokenProbabilities(noul, decisionOptions(noul), [
        { token: "<think>", probability: 0.99 },
      ]),
    ).toThrow(/none of the answer labels/);
  });

  it("throws when the labels hold too little of the distribution", () => {
    expect(() =>
      answerFromTokenProbabilities(noul, decisionOptions(noul), [
        { token: "Sure", probability: 0.7 },
        { token: "yes", probability: 0.2 },
        { token: "no", probability: 0.1 },
      ]),
    ).toThrow(/hold only 30%/);
  });
});
