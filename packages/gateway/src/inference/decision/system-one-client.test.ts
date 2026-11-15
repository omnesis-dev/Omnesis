// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "./limiter.js";
import {
  SystemOneDecision,
  parseSystemOneResponse,
  workersAiModelPath,
} from "./system-one-client.js";
import { DecisionHttpError } from "./transport.js";
import type { DecisionRequest } from "@omnesis/core";

const REQUEST: DecisionRequest = {
  state: "Your table for two is booked for Friday at 8pm.",
  questions: {
    worth: {
      type: "score",
      instructions: "Worth recording?",
      criteria: ["No", "Minor", "Yes", "Very"],
    },
    booking: { type: "noul", instructions: "Is this a booking?" },
    kind: { type: "choice", instructions: "Which kind?", criteria: { ask: null, note: null } },
  },
};

const ANSWERS = {
  worth: {
    type: "score",
    score: 2.4,
    confidence: 0.6,
    probabilities: { "0": 0.05, "1": 0.05, "2": 0.35, "3": 0.55 },
  },
  booking: { type: "noul", noul: 0.97 },
  kind: { type: "choice", choice: "note", confidence: 0.9, probabilities: { ask: 0.1, note: 0.9 } },
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function server(
  replies: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const noSleep = async () => {};

describe("SystemOneDecision", () => {
  it("posts {model, state, questions} and returns the typed answers", async () => {
    const { calls, fetchFn } = server([
      { body: { model: "kev:latest", answers: ANSWERS, usage: { input_tokens: 61 } } },
    ]);
    const client = new SystemOneDecision({
      url: "http://127.0.0.1:11435/v1/systemone",
      model: "kev",
      allowRemoteInference: false,
      fetchFn,
    });
    const result = await client.decide(REQUEST);
    expect(calls[0]!.url).toBe("http://127.0.0.1:11435/v1/systemone");
    expect(calls[0]!.body).toEqual({
      model: "kev",
      state: REQUEST.state,
      questions: REQUEST.questions,
    });
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(result).toEqual({
      model: "kev:latest",
      answers: {
        worth: ANSWERS.worth,
        booking: { type: "noul", noul: 0.97 },
        kind: ANSWERS.kind,
      },
      inputTokens: 61,
    });
  });

  it.each([
    ["bearer", "authorization", "Bearer sk-1"],
    ["api-key", "api-key", "sk-1"],
    ["x-api-key", "x-api-key", "sk-1"],
  ] as const)("sends the key the %s way", async (auth, header, value) => {
    const { calls, fetchFn } = server([{ body: { model: "m", answers: ANSWERS } }]);
    const client = new SystemOneDecision({
      url: "http://127.0.0.1:9/v1/systemone",
      model: "m",
      apiKey: "sk-1",
      auth,
      allowRemoteInference: false,
      fetchFn,
    });
    await client.decide(REQUEST);
    expect(calls[0]!.headers[header]).toBe(value);
    const others = ["authorization", "api-key", "x-api-key"].filter((h) => h !== header);
    for (const other of others) expect(calls[0]!.headers[other]).toBeUndefined();
  });

  it("posts Workers AI requests to <url>/<model id> with the short name in the body, and unwraps {result}", async () => {
    const { calls, fetchFn } = server([
      {
        body: {
          result: { model: "clef-flash", answers: ANSWERS, usage: { input_tokens: 9 } },
          success: true,
          errors: [],
          messages: [],
        },
      },
    ]);
    const client = new SystemOneDecision({
      url: "http://127.0.0.1:9/client/v4/accounts/abc/ai/run/",
      model: "@cf/cloudflare/clef-flash",
      protocol: "workers-ai",
      allowRemoteInference: false,
      fetchFn,
    });
    const result = await client.decide(REQUEST);
    expect(calls[0]!.url).toBe(
      "http://127.0.0.1:9/client/v4/accounts/abc/ai/run/@cf/cloudflare/clef-flash",
    );
    expect(calls[0]!.body.model).toBe("clef-flash");
    expect(result.model).toBe("clef-flash");
    expect(result.inputTokens).toBe(9);
  });

  it("refuses a Workers AI model id that would leave the model path", () => {
    expect(workersAiModelPath("@cf/cloudflare/clef")).toBe("@cf/cloudflare/clef");
    for (const bad of ["../../user/tokens", "@cf/x?y=1", "a//b", "", "@cf/x#y"]) {
      expect(() => workersAiModelPath(bad)).toThrow(/not a Workers AI model id/);
    }
  });

  it("reads Fastino's weighted level from expected_level, not its argmax score", async () => {
    const { fetchFn } = server([
      {
        body: {
          model: "glide",
          answers: { ...ANSWERS, worth: { type: "score", score: 3, expected_level: 2.31 } },
        },
      },
    ]);
    const client = new SystemOneDecision({
      url: "http://127.0.0.1:9/v1/systemone",
      model: "fastino/GLiDE",
      scoreField: "expected_level",
      allowRemoteInference: false,
      fetchFn,
    });
    const result = await client.decide(REQUEST);
    expect(result.answers.worth).toEqual({ type: "score", score: 2.31 });
  });

  it("reports the model asked when the reply names none", async () => {
    const { fetchFn } = server([{ body: { answers: ANSWERS } }]);
    const client = new SystemOneDecision({
      url: "http://127.0.0.1:9/v1/systemone",
      model: "d3:4b",
      allowRemoteInference: false,
      fetchFn,
    });
    expect((await client.decide(REQUEST)).model).toBe("d3:4b");
  });

  it("retries 425, 429 and 529 and gives up on a refused request with the provider's name", async () => {
    const { calls, fetchFn } = server([
      { status: 425, body: "warming" },
      { status: 529, body: "busy" },
      { body: { model: "m", answers: ANSWERS } },
    ]);
    const client = new SystemOneDecision({
      url: "http://127.0.0.1:9/v1/systemone",
      model: "m",
      allowRemoteInference: false,
      fetchFn,
      sleep: noSleep,
    });
    await client.decide(REQUEST);
    expect(calls).toHaveLength(3);

    const refused = server([
      { status: 404, body: '{"error":"model not found"}', headers: { "x-request-id": "r-1" } },
    ]);
    const missing = new SystemOneDecision({
      url: "http://127.0.0.1:9/v1/systemone",
      model: "kevv",
      label: "Ollaya",
      allowRemoteInference: false,
      fetchFn: refused.fetchFn,
      sleep: noSleep,
    });
    const err = await missing.decide(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionHttpError);
    expect((err as DecisionHttpError).status).toBe(404);
    expect((err as Error).message).toBe("Ollaya HTTP 404 (request r-1): model not found");
    expect(refused.calls).toHaveLength(1);
  });

  it("blocks a remote endpoint without consent before sending anything", async () => {
    const { calls, fetchFn } = server([{ body: { model: "m", answers: ANSWERS } }]);
    const client = new SystemOneDecision({
      url: "https://openrouter.ai/api/v1/systemone",
      model: "liquid/d1",
      allowRemoteInference: false,
      maxRetries: 0,
      fetchFn,
    });
    await expect(client.decide(REQUEST)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("queues requests beyond the backend's limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ model: "m", answers: ANSWERS }));
    }) as typeof fetch;
    const client = new SystemOneDecision({
      url: "http://127.0.0.1:9/v1/systemone",
      model: "m",
      allowRemoteInference: false,
      limiter: new ConcurrencyLimiter(2),
      fetchFn,
    });
    await Promise.all(Array.from({ length: 7 }, () => client.decide(REQUEST)));
    expect(peak).toBe(2);
  });
});

describe("parseSystemOneResponse", () => {
  const ctx = { label: "Ollama", model: "d3:4b", scoreField: "score" as const };

  it.each([
    [
      { answers: { ...ANSWERS, worth: undefined } },
      'Ollama reply lacks a score answer for "worth"',
    ],
    [
      { answers: { ...ANSWERS, booking: { type: "score", score: 1 } } },
      'lacks a noul answer for "booking"',
    ],
    [{ answers: { ...ANSWERS, booking: { type: "noul" } } }, 'Ollama noul "booking" has no value'],
    [{ answers: { ...ANSWERS, kind: { type: "choice" } } }, 'Ollama choice "kind" has no value'],
    [{ model: "x" }, "Ollama reply has no answers"],
    [null, "Ollama reply is not an object"],
  ])("refuses a malformed reply (%#)", (raw, message) => {
    expect(() => parseSystemOneResponse(raw, REQUEST, ctx)).toThrow(message);
  });

  it("ignores fields a provider adds", () => {
    const result = parseSystemOneResponse(
      {
        id: "gen-1",
        provider: "Liquid",
        model: "liquid/d1-20261101",
        answers: { ...ANSWERS, worth: { ...ANSWERS.worth, legend: { "0": "No" } } },
        usage: { input_tokens: 5, output_tokens: 0, cost: 0.0001 },
        search_results: [],
      },
      REQUEST,
      ctx,
    );
    expect(result.model).toBe("liquid/d1-20261101");
    expect(result.answers.worth).toEqual(ANSWERS.worth);
  });
});

describe("parseSystemOneResponse — a score field the provider left out", () => {
  it("fails rather than read the most likely level as the weighted one", () => {
    expect(() =>
      parseSystemOneResponse(
        { model: "glide", answers: { ...ANSWERS, worth: { type: "score", score: 3 } } },
        REQUEST,
        { label: "Fastino", model: "fastino/GLiDE", scoreField: "expected_level" },
      ),
    ).toThrow('Fastino score "worth" has no expected_level');
  });
});
