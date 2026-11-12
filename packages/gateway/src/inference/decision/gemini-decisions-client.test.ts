// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  GeminiDecisionsDecision,
  fromGeminiDecisionsResponse,
  toGeminiDecisionsRequest,
} from "./gemini-decisions-client.js";
import type { DecisionRequest } from "@omnesis/core";

const REQUEST: DecisionRequest = {
  state: {
    subject: "Invoice 1042 due Friday",
    from: "billing@example.com",
    body: "Amount due: €40.",
  },
  questions: {
    worth: {
      type: "score",
      instructions: "Worth recording?",
      criteria: ["Nothing", "Minor", "Worth recording", { level: "Important" }],
    },
    money: {
      type: "noul",
      instructions: "Does the recipient owe money?",
      criteria: { true: "A bill or invoice they must pay", false: "Anything else" },
    },
    route: {
      type: "choice",
      instructions: "Where does it go?",
      criteria: { ask: "A question", note: null },
    },
  },
};

/** A reply in the shape Google's Decisions API documents. */
const REPLY = {
  answers: {
    worth: {
      type: "score",
      score: 2.2,
      legend: { "0": "Nothing", "1": "Minor", "2": "Worth recording", "3": "Important" },
      probabilities: { "0": 0.1, "1": 0.1, "2": 0.3, "3": 0.5 },
      confidence: 0.5,
    },
    money: { type: "noul", noul: 0.93, confidence: 0.93 },
    route: {
      type: "choice",
      choice: "note",
      probabilities: { ask: 0.2, note: 0.8 },
      confidence: 0.8,
    },
  },
  usage: {
    total_input_tokens: 77,
    input_tokens_by_modality: [{ modality: "text", tokens: 77 }],
    total_output_tokens: 0,
    total_tokens: 77,
  },
};

describe("toGeminiDecisionsRequest", () => {
  it("sends state as input text and maps each question's criteria onto Gemini's fields", () => {
    expect(toGeminiDecisionsRequest("gemini-decision-1", REQUEST)).toEqual({
      model: "gemini-decision-1",
      input: JSON.stringify(REQUEST.state),
      questions: {
        worth: {
          type: "score",
          instructions: "Worth recording?",
          criteria: ["Nothing", "Minor", "Worth recording", '{"level":"Important"}'],
        },
        money: {
          type: "noul",
          instructions: "Does the recipient owe money?",
          criteria: {
            true_description: "A bill or invoice they must pay",
            false_description: "Anything else",
          },
        },
        route: {
          type: "choice",
          instructions: "Where does it go?",
          criteria: { ask: "A question", note: "" },
        },
      },
    });
  });

  it("sends a string state as it is", () => {
    expect(toGeminiDecisionsRequest("m", { ...REQUEST, state: "plain" }).input).toBe("plain");
  });

  it("folds a lone yes or no description into the instructions", () => {
    const body = toGeminiDecisionsRequest("m", {
      state: "x",
      questions: { q: { type: "noul", instructions: "Paid?", criteria: { true: "Receipt" } } },
    });
    expect(body.questions).toEqual({
      q: { type: "noul", instructions: "Paid?\nYes means: Receipt" },
    });
  });

  it("refuses a question the API cannot take", () => {
    expect(() =>
      toGeminiDecisionsRequest("m", {
        state: "x",
        questions: { one: { type: "choice", instructions: "?", criteria: { only: null } } },
      }),
    ).toThrow('at least two options for "one"');
    expect(() =>
      toGeminiDecisionsRequest("m", {
        state: "x",
        questions: { "has space": { type: "noul", instructions: "?" } },
      }),
    ).toThrow('cannot take the question key "has space"');
  });
});

describe("fromGeminiDecisionsResponse", () => {
  it("reads the answers by key and the billed input tokens", () => {
    expect(fromGeminiDecisionsResponse(REPLY, REQUEST, "Google", "gemini-decision-1")).toEqual({
      model: "gemini-decision-1",
      answers: {
        worth: {
          type: "score",
          score: 2.2,
          confidence: 0.5,
          probabilities: { "0": 0.1, "1": 0.1, "2": 0.3, "3": 0.5 },
        },
        money: { type: "noul", noul: 0.93 },
        route: {
          type: "choice",
          choice: "note",
          confidence: 0.8,
          probabilities: { ask: 0.2, note: 0.8 },
        },
      },
      inputTokens: 77,
    });
  });

  it("fails on a missing or mismatched answer", () => {
    const missing = { ...REPLY, answers: { ...REPLY.answers, money: undefined } };
    expect(() => fromGeminiDecisionsResponse(missing, REQUEST, "Google", "m")).toThrow(
      'Google reply lacks a noul answer for "money"',
    );
    const wrong = { ...REPLY, answers: { ...REPLY.answers, worth: { type: "noul", noul: 0.5 } } };
    expect(() => fromGeminiDecisionsResponse(wrong, REQUEST, "Google", "m")).toThrow(
      'lacks a score answer for "worth"',
    );
  });
});

describe("GeminiDecisionsDecision", () => {
  it("posts to the Decisions URL with the key in x-goog-api-key", async () => {
    let seen: { url: string; headers: Headers; body: unknown } | null = null;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      seen = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      };
      return new Response(JSON.stringify(REPLY));
    }) as typeof fetch;
    const client = new GeminiDecisionsDecision({
      url: "http://127.0.0.1:9/v1beta/decisions",
      model: "gemini-decision-1",
      apiKey: "gm-test-key",
      auth: "x-goog-api-key",
      allowRemoteInference: false,
      fetchFn,
    });
    const result = await client.decide(REQUEST);
    expect(seen!.url).toBe("http://127.0.0.1:9/v1beta/decisions");
    expect(seen!.headers.get("x-goog-api-key")).toBe("gm-test-key");
    expect(seen!.headers.get("authorization")).toBeNull();
    expect((seen!.body as { model: string }).model).toBe("gemini-decision-1");
    expect(result.answers.money).toEqual({ type: "noul", noul: 0.93 });
    expect(result.inputTokens).toBe(77);
  });

  it("fails the decision when Google blocks the input for safety", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: { code: "safety", message: "Blocked" } }), {
        status: 400,
      })) as unknown as typeof fetch;
    const client = new GeminiDecisionsDecision({
      url: "http://127.0.0.1:9/v1beta/decisions",
      model: "gemini-decision-1",
      apiKey: "gm-test-key",
      auth: "x-goog-api-key",
      allowRemoteInference: false,
      maxRetries: 0,
      fetchFn,
    });
    await expect(client.decide(REQUEST)).rejects.toThrow("Google HTTP 400");
  });
});
