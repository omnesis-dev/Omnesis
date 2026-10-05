// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { TypeSafeDecision, parseResponse } from "./typesafe-client.js";
import type { DecisionRequest } from "@omnesis/core";

const request: DecisionRequest = {
  state: {
    subject: "Invoice due",
    from: "Studio Northstar <billing@example.com>",
    body: "Due 12 Nov.",
  },
  questions: {
    worth_score: {
      type: "score",
      instructions: "Worth recording?",
      criteria: ["No.", "Minor.", "Yes.", "Important."],
    },
  },
};

const okBody = {
  model: "jev-1.13.0",
  answers: {
    worth_score: {
      type: "score",
      score: 2.4,
      confidence: 0.7,
      legend: { "0": "No." },
      probabilities: { "0": 0.01, "1": 0.09, "2": 0.4, "3": 0.5 },
    },
  },
  usage: { input_tokens: 321, output_tokens: 20 },
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const TEST_KEY = "apikey_test_0123456789abcdef";

function client(
  fetchFn: typeof fetch,
  extra: Partial<ConstructorParameters<typeof TypeSafeDecision>[0]> = {},
) {
  return new TypeSafeDecision({
    url: "http://127.0.0.1:9/v1/systemone",
    model: "jev-1.13.0",
    apiKey: TEST_KEY,
    allowRemoteInference: false,
    fetchFn,
    sleep: async () => {},
    ...extra,
  });
}

describe("TypeSafeDecision", () => {
  it("posts model, state and questions with the bearer key and parses the typed answer", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, okBody));
    const result = await client(fetchFn as unknown as typeof fetch).decide(request);
    expect(result).toEqual({
      model: "jev-1.13.0",
      answers: {
        worth_score: {
          type: "score",
          score: 2.4,
          confidence: 0.7,
          probabilities: { "0": 0.01, "1": 0.09, "2": 0.4, "3": 0.5 },
        },
      },
      inputTokens: 321,
    });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({
      model: "jev-1.13.0",
      state: request.state,
      questions: request.questions,
    });
  });

  it("retries rate limits and overload, honouring retry-after", async () => {
    const sleeps: number[] = [];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, "slow down", { "retry-after": "2" }))
      .mockResolvedValueOnce(jsonResponse(529, "overloaded"))
      .mockResolvedValueOnce(jsonResponse(200, okBody));
    const result = await client(fetchFn as unknown as typeof fetch, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).decide(request);
    expect(result.answers.worth_score).toMatchObject({ type: "score", score: 2.4 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, 1000]);
  });

  it("stops waiting out a rate limit when the caller cancels", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(429, "slow down", { "retry-after": "10" }));
    const controller = new AbortController();
    const started = Date.now();
    // The production sleep, not the helper's instant one: the wait itself must end on abort.
    const decided = new TypeSafeDecision({
      url: "http://127.0.0.1:9/v1/systemone",
      model: "jev-1.13.0",
      apiKey: TEST_KEY,
      allowRemoteInference: false,
      fetchFn: fetchFn as unknown as typeof fetch,
    }).decide(request, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("search canceled")), 20);
    await expect(decided).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws on a rejected key without retrying", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(401, "invalid key", { "x-typesafe-request-id": "req_abc" }),
    );
    await expect(client(fetchFn as unknown as typeof fetch).decide(request)).rejects.toThrow(
      /TypeSafe HTTP 401 \(request req_abc\): invalid key/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget and throws the last error", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(503, "down"));
    await expect(
      client(fetchFn as unknown as typeof fetch, { maxRetries: 1 }).decide(request),
    ).rejects.toThrow(/HTTP 503/);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries network errors", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, okBody));
    await expect(client(fetchFn as unknown as typeof fetch).decide(request)).resolves.toMatchObject(
      {
        model: "jev-1.13.0",
      },
    );
  });

  it("refuses a remote endpoint when remote inference is off", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, okBody));
    const remote = client(fetchFn as unknown as typeof fetch, {
      url: "https://api.typesafe.ai/v1/systemone",
      maxRetries: 0,
    });
    await expect(remote.decide(request)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("parseResponse", () => {
  it("rejects a reply that lacks an answer for an asked question", () => {
    expect(() => parseResponse({ model: "jev", answers: {} }, request)).toThrow(
      /lacks a score answer for "worth_score"/,
    );
  });

  it("rejects an answer of the wrong type", () => {
    expect(() =>
      parseResponse(
        { model: "jev", answers: { worth_score: { type: "noul", noul: 0.4 } } },
        request,
      ),
    ).toThrow(/lacks a score answer/);
  });

  it("rejects a reply without a model id", () => {
    expect(() => parseResponse({ answers: {} }, request)).toThrow(/no model id/);
  });

  it("parses noul and choice answers", () => {
    const req: DecisionRequest = {
      state: "x",
      questions: {
        a: { type: "noul", instructions: "?" },
        b: { type: "choice", instructions: "?", criteria: { yes: null, no: null } },
      },
    };
    expect(
      parseResponse(
        {
          model: "jev",
          answers: {
            a: { type: "noul", noul: 0.9 },
            b: {
              type: "choice",
              choice: "yes",
              confidence: 0.8,
              probabilities: { yes: 0.9, no: 0.1 },
            },
          },
        },
        req,
      ).answers,
    ).toEqual({
      a: { type: "noul", noul: 0.9 },
      b: { type: "choice", choice: "yes", confidence: 0.8, probabilities: { yes: 0.9, no: 0.1 } },
    });
  });
});
