// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  decisionFingerprint,
  formatDecisionCassetteEntry,
  parseDecisionCassette,
} from "./decision-cassette.js";
import type { DecisionRequest } from "./decision.js";

const request: DecisionRequest = {
  state: {
    subject: "Your table is booked",
    from: "Riverside Estate <bookings@example.com>",
    body: "See you Friday.",
  },
  questions: {
    worth_score: {
      type: "score",
      instructions: "How much would an assistant want to record?",
      criteria: ["Nothing.", "Minor.", "Worth recording.", "Important."],
    },
  },
};

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 2 } })).toBe('{"a":{"c":2,"d":[3,1]},"b":1}');
  });

  it("drops undefined members like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("decisionFingerprint", () => {
  it("is independent of key order", () => {
    const reordered: DecisionRequest = {
      questions: request.questions,
      state: {
        body: "See you Friday.",
        from: "Riverside Estate <bookings@example.com>",
        subject: "Your table is booked",
      },
    };
    expect(decisionFingerprint(reordered)).toBe(decisionFingerprint(request));
  });

  it("changes when the state or the questions change", () => {
    const fp = decisionFingerprint(request);
    expect(
      decisionFingerprint({ ...request, state: { ...(request.state as object), body: "Other." } }),
    ).not.toBe(fp);
    expect(
      decisionFingerprint({
        ...request,
        questions: { worth_score: { type: "noul", instructions: "Worth it?" } },
      }),
    ).not.toBe(fp);
  });

  it("ignores the model id, so a recording replays under any assignment", () => {
    const withModel = { ...request, model: "jev-1.13.0" } as DecisionRequest;
    expect(decisionFingerprint(withModel)).toBe(decisionFingerprint(request));
  });
});

describe("decision cassettes", () => {
  const response = {
    model: "jev-1.13.0",
    answers: { worth_score: { type: "score" as const, score: 2.6 } },
    inputTokens: 412,
  };

  it("round-trips an entry through format and parse", () => {
    const text = `${formatDecisionCassetteEntry(request, response)}\n\n`;
    const entries = parseDecisionCassette(text);
    expect(entries.size).toBe(1);
    const entry = entries.get(decisionFingerprint(request));
    expect(entry?.response).toEqual(response);
  });

  it("rejects a line whose fp does not match its request", () => {
    const line = JSON.parse(formatDecisionCassetteEntry(request, response));
    line.fp = "sha256:0000";
    expect(() => parseDecisionCassette(JSON.stringify(line), "fixture.jsonl")).toThrow(
      /fixture\.jsonl:1: fp does not match/,
    );
  });

  it("names the line of a malformed entry", () => {
    expect(() => parseDecisionCassette("\n{not json", "c.jsonl")).toThrow(
      /c\.jsonl:2: not valid JSON/,
    );
    expect(() => parseDecisionCassette('{"fp":"x"}', "c.jsonl")).toThrow(/c\.jsonl:1: expected/);
  });
});
