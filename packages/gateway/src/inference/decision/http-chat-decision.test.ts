// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { HttpChatDecision } from "./http-chat-decision.js";
import type { DecisionRequest } from "@omnesis/core";

const request: DecisionRequest = {
  state: {
    subject: "Invoice due",
    from: "Northstar <billing@example.com>",
    body: "Due 12 Nov.",
  },
  questions: {
    worth_score: {
      type: "score",
      instructions: "Worth recording?",
      criteria: ["No.", "Minor.", "Yes.", "Important."],
    },
    is_bill: { type: "noul", instructions: "Is this a bill to pay?" },
    route: {
      type: "choice",
      instructions: "Route it.",
      criteria: { record: "Record it.", skip: "Skip it." },
    },
  },
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** An OpenAI-style one-token reply whose first token has these candidates. */
function logprobsReply(candidates: Record<string, number>, promptTokens = 100) {
  const top = Object.entries(candidates).map(([token, p]) => ({ token, logprob: Math.log(p) }));
  return {
    choices: [
      {
        logprobs: {
          content: [{ token: top[0]!.token, logprob: top[0]!.logprob, top_logprobs: top }],
        },
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: 1 },
  };
}

/** Answer each question by the labels its prompt lists. */
function scriptedFetch() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    const user = body.messages[1]!.content;
    if (user.includes("(0, 1, 2, 3)"))
      return jsonResponse(200, logprobsReply({ "2": 0.5, "3": 0.5 }));
    if (user.includes("(yes, no)")) return jsonResponse(200, logprobsReply({ yes: 0.8, no: 0.2 }));
    return jsonResponse(200, logprobsReply({ B: 0.9, A: 0.1 }));
  });
}

function client(
  fetchFn: unknown,
  extra: Partial<ConstructorParameters<typeof HttpChatDecision>[0]> = {},
) {
  return new HttpChatDecision({
    backendKey: "llama",
    baseUrl: "http://127.0.0.1:9",
    model: "decider-7b",
    allowRemoteInference: false,
    fetchFn: fetchFn as typeof fetch,
    sleep: async () => {},
    ...extra,
  });
}

describe("HttpChatDecision", () => {
  it("asks one single-token question per question and reads typed answers from logprobs", async () => {
    const fetchFn = scriptedFetch();
    const result = await client(fetchFn, { apiKey: "sk-test-0000" }).decide(request);

    expect(result.model).toBe("http:llama/decider-7b");
    expect(result.inputTokens).toBe(300);
    expect(result.answers.worth_score).toMatchObject({
      type: "score",
      score: 2.5,
      confidence: 0.5,
    });
    expect(result.answers.is_bill).toMatchObject({ type: "noul" });
    expect((result.answers.is_bill as { noul: number }).noul).toBeCloseTo(0.8);
    expect(result.answers.route).toMatchObject({ type: "choice", choice: "skip" });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-0000");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "decider-7b",
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: 20,
    });
  });

  it("sends no authorization header without a key", async () => {
    const fetchFn = scriptedFetch();
    await client(fetchFn).decide(request);
    const [, init] = fetchFn.mock.calls[0]!;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("throws when the server returns no logprobs", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, { choices: [{ message: { content: "2" }, logprobs: null }] }),
    );
    await expect(client(fetchFn).decide(request)).rejects.toThrow(/returned no logprobs/);
  });

  it("throws when the next token is not a label, naming the likely cause", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, logprobsReply({ "<think>": 0.99 })));
    await expect(client(fetchFn).decide(request)).rejects.toThrow(
      /none of the answer labels.*reasoning off/,
    );
  });

  it("throws on an HTTP error without echoing the body", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500, "echo: Invoice due"));
    const error = await client(fetchFn)
      .decide(request)
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/HTTP 500/);
    expect((error as Error).message).not.toMatch(/Invoice/);
  });

  it("retries a rate limit", async () => {
    const answers = scriptedFetch();
    let limited = false;
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (!limited) {
        limited = true;
        return jsonResponse(429, "slow down", { "retry-after": "1" });
      }
      return answers(url, init);
    });
    const result = await client(fetchFn).decide(request);
    expect(result.answers.route).toMatchObject({ choice: "skip" });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort(new Error("canceled"));
    const fetchFn = scriptedFetch();
    await expect(client(fetchFn).decide(request, { signal: controller.signal })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a remote endpoint when remote inference is off", async () => {
    const fetchFn = scriptedFetch();
    await expect(
      client(fetchFn, { baseUrl: "https://203.0.113.10" }).decide(request),
    ).rejects.toThrow(/allowRemoteInference/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
