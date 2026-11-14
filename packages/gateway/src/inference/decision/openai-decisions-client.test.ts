// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  OpenAIDecisionsDecision,
  fromOpenAIDecisionsResponse,
  toOpenAIDecisionsRequest,
} from "./openai-decisions-client.js";
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

describe("toOpenAIDecisionsRequest", () => {
  it("maps state and the three question kinds onto the Decisions schema", () => {
    expect(toOpenAIDecisionsRequest("gpt-6-luna", REQUEST)).toEqual({
      model: "gpt-6-luna",
      input: [{ role: "user", content: [{ type: "input_json", data: REQUEST.state }] }],
      questions: [
        {
          type: "score",
          name: "worth",
          instructions: "Worth recording?",
          levels: [
            { label: "Nothing" },
            { label: "Minor" },
            { label: "Worth recording" },
            { label: '{"level":"Important"}' },
          ],
        },
        {
          type: "predicate",
          name: "money",
          instructions:
            "Does the recipient owe money?\nYes means: A bill or invoice they must pay\nNo means: Anything else",
        },
        {
          type: "choice",
          name: "route",
          instructions: "Where does it go?",
          choices: [{ value: "ask", description: "A question" }, { value: "note" }],
        },
      ],
    });
  });

  it("sends a string state as input and stringifies anything else that is not JSON objects", () => {
    expect(toOpenAIDecisionsRequest("m", { ...REQUEST, state: "plain" }).input).toBe("plain");
    expect(toOpenAIDecisionsRequest("m", { ...REQUEST, state: ["a", "b"] }).input).toBe(
      '["a","b"]',
    );
    expect(toOpenAIDecisionsRequest("m", { ...REQUEST, state: [{ a: 1 }] }).input).toEqual([
      { role: "user", content: [{ type: "input_json", data: [{ a: 1 }] }] },
    ]);
  });

  it("refuses a question the API cannot take", () => {
    expect(() =>
      toOpenAIDecisionsRequest("m", {
        state: "x",
        questions: { one: { type: "choice", instructions: "?", criteria: { only: null } } },
      }),
    ).toThrow('at least two options for "one"');
  });
});

describe("fromOpenAIDecisionsResponse", () => {
  const reply = {
    model: "gpt-6-luna",
    answers: [
      {
        type: "score",
        name: "worth",
        score: 2.2,
        confidence: 0.5,
        probabilities: [
          { value: 0, label: "Nothing", probability: 0.1 },
          { value: 3, label: "Important", probability: 0.4 },
        ],
      },
      { type: "predicate", name: "money", probability: 0.93 },
      {
        type: "choice",
        name: "route",
        choice: "note",
        confidence: 0.8,
        probabilities: [
          { value: "ask", probability: 0.2 },
          { value: "note", probability: 0.8 },
        ],
      },
    ],
    usage: { input_tokens: 77, output_tokens: 0, total_tokens: 77 },
  };

  it("maps answers back by name", () => {
    expect(fromOpenAIDecisionsResponse(reply, REQUEST, "OpenAI", "gpt-6-luna")).toEqual({
      model: "gpt-6-luna",
      answers: {
        worth: {
          type: "score",
          score: 2.2,
          confidence: 0.5,
          probabilities: { "0": 0.1, "3": 0.4 },
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

  it("falls back to question order when names are not echoed", () => {
    const unnamed = { ...reply, answers: reply.answers.map((a) => ({ ...a, name: null })) };
    const result = fromOpenAIDecisionsResponse(unnamed, REQUEST, "OpenAI", "gpt-6-luna");
    expect(result.answers.money).toEqual({ type: "noul", noul: 0.93 });
  });

  it("fails on a refusal or a mismatched answer", () => {
    const refused = {
      ...reply,
      answers: [{ type: "refusal", name: "worth" }, ...reply.answers.slice(1)],
    };
    expect(() => fromOpenAIDecisionsResponse(refused, REQUEST, "OpenAI", "m")).toThrow(
      'OpenAI refused to answer "worth"',
    );
    const wrong = {
      ...reply,
      answers: [{ type: "predicate", name: "worth", probability: 0.5 }, ...reply.answers.slice(1)],
    };
    expect(() => fromOpenAIDecisionsResponse(wrong, REQUEST, "OpenAI", "m")).toThrow(
      'lacks a score answer for "worth"',
    );
  });
});

describe("OpenAIDecisionsDecision", () => {
  it("posts to the Decisions URL with a bearer key", async () => {
    let seen: { url: string; headers: Headers; body: unknown } | null = null;
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      seen = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      };
      return new Response(
        JSON.stringify({
          model: "gpt-6-luna",
          answers: [
            { type: "score", name: "worth", score: 1 },
            { type: "predicate", name: "money", probability: 0.5 },
            { type: "choice", name: "route", choice: "ask" },
          ],
        }),
      );
    }) as typeof fetch;
    const client = new OpenAIDecisionsDecision({
      url: "http://127.0.0.1:9/v1/decisions",
      model: "gpt-6-luna",
      apiKey: "sk-openai",
      allowRemoteInference: false,
      fetchFn,
    });
    const result = await client.decide(REQUEST);
    expect(seen!.url).toBe("http://127.0.0.1:9/v1/decisions");
    expect(seen!.headers.get("authorization")).toBe("Bearer sk-openai");
    expect(result.answers.route).toEqual({ type: "choice", choice: "ask" });
  });
});

describe("fromOpenAIDecisionsResponse — a named reply missing one answer", () => {
  it("fails rather than taking another question's answer by position", () => {
    const reply = {
      model: "gpt-6-luna",
      answers: [
        { type: "predicate", name: "money", probability: 0.4 },
        { type: "choice", name: "route", choice: "ask" },
        { type: "score", name: "other", score: 2 },
      ],
    };
    expect(() => fromOpenAIDecisionsResponse(reply, REQUEST, "OpenAI", "m")).toThrow(
      'OpenAI reply lacks an answer for "worth"',
    );
  });
});
