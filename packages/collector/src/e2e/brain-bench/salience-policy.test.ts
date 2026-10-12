// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { salienceDecisionPolicy } from "./salience-policy.js";
import type { DecisionServerRequest } from "./decision-server.js";

const score = (levels: number) => ({
  type: "score" as const,
  instructions: "q",
  criteria: Array.from({ length: levels }, (_, i) => `level ${i}`),
});

function salienceRequest(observation: string): DecisionServerRequest {
  return {
    model: "jev",
    state: { observation },
    questions: { consequence: score(5), timing: score(4), already_known: score(2) },
  };
}

describe("salienceDecisionPolicy", () => {
  const policy = salienceDecisionPolicy([
    ["boiler", { consequence: 4, timing: 3, alreadyKnown: 0 }],
    ["outage", { httpError: 503 }],
  ]);
  if (typeof policy !== "function") throw new Error("expected a policy function");

  test("scores an observation by the first marker in its summary", () => {
    expect(policy(salienceRequest("The boiler service needs booking."))).toEqual({
      consequence: { type: "score", score: 4 },
      timing: { type: "score", score: 3 },
      already_known: { type: "score", score: 0 },
    });
  });

  test("a scripted outage is a provider error, and an unmatched summary uses the fallback", () => {
    expect(policy(salienceRequest("A power outage is planned."))).toEqual({ httpError: 503 });
    expect(policy(salienceRequest("Something else."))).toEqual({
      consequence: { type: "score", score: 2 },
      timing: { type: "score", score: 1 },
      already_known: { type: "score", score: 0 },
    });
  });

  test("any other decision is answered at the top level of each question", () => {
    expect(
      policy({
        model: "jev",
        state: { subject: "An email" },
        questions: {
          worth: score(5),
          yes: { type: "noul", instructions: "q" },
          pick: { type: "choice", instructions: "q", criteria: { a: null, b: null } },
        },
      }),
    ).toEqual({
      worth: { type: "score", score: 4 },
      yes: { type: "noul", noul: 1 },
      pick: { type: "choice", choice: "a" },
    });
  });
});
