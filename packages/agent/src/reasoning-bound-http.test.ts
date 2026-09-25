// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a bounded turn is actually bounded on an OpenAI-compatible server.
 *
 * A bound is only real on the backend that runs the turn, and an agent role can
 * point at any of several — so a knob honoured by one of them is a knob an
 * operator can set, read back, and change nothing with. This file holds the
 * OpenAI-compatible path to it.
 *
 * What is asserted is therefore not "a field is sent" but that it is sized
 * against the budget it shares with the answer, that it holds for every request
 * of a turn rather than only the first, that it never reaches a turn that did
 * not ask for one, and that a server which will not take the field loses the
 * bound rather than the turn.
 *
 * Fixture data is invented — no corpus content.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { z } from "zod";
import { HttpChatBackend } from "./http-backend.js";

import type { ToolResult } from "@omnesis/core";
import type { TurnInput } from "./backend.js";

const MODEL = "a-thinking-model";

function turn(reasoning?: { maxTokens: number }): TurnInput {
  return {
    sessionId: "S",
    messageId: "M",
    history: [],
    userMessage: "compile something",
    tools: [],
    systemPrompt: "a contract",
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/** A finished, text-only turn, in the streamed shape the backend asks for first. */
function answered(): Response {
  const chunks = [
    {
      choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    "[DONE]",
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(
            chunk === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(chunk)}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** A turn that calls a tool once, then answers — two requests, one turn. */
function calledTool(): Response {
  const chunks = [
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "look", arguments: "{}" } }],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    "[DONE]",
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(
            chunk === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(chunk)}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** The provider's answer when it does not accept a `thinking` block at all. */
function rejectsThinking(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "Extra inputs are not permitted, field: 'thinking'",
        type: "invalid_request_error",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** Every request body the backend sent, in order. */
function sentBodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map((call) => {
    const init = call[1] as { body?: string };
    return JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
  });
}

/**
 * A backend with an output ceiling wide enough for a bound to fit under.
 *
 * Stated rather than left implicit, because the default matters: a server with
 * no configured ceiling gets 4,096 output tokens, and what a bound comes to
 * under that ceiling is its own case below.
 */
function backend(opts: { maxOutputTokens?: number } = {}): HttpChatBackend {
  return new HttpChatBackend({
    baseUrl: "http://localhost:8000",
    model: MODEL,
    modelLimits: { maxOutputTokens: opts.maxOutputTokens ?? 32_000 },
  });
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("a reasoning bound on an OpenAI-compatible server", () => {
  it("keeps the same thinking budget while retrying a rate limit", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("limited", { status: 429 }))
      .mockResolvedValueOnce(answered());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const run = (async () => {
      for await (const _e of backend().runTurn(turn({ maxTokens: 8_000 }))) {
        // Drain.
      }
    })();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(3_000);
    await run;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentBodies(fetchMock).map((body) => body["thinking"])).toEqual([
      { type: "enabled", budget_tokens: 8_000 },
      { type: "enabled", budget_tokens: 8_000 },
      { type: "enabled", budget_tokens: 8_000 },
    ]);
  });

  it("reaches the provider as a thinking budget", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answered());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    for await (const _e of backend().runTurn(turn({ maxTokens: 8_000 }))) {
      // Drain.
    }
    const thinking = sentBodies(fetchMock)[0]?.["thinking"];
    expect(thinking).toEqual({ type: "enabled", budget_tokens: 8_000 });
  });

  it("leaves a turn that asked for nothing exactly as it was", async () => {
    // The discriminating half. Every interactive turn takes this path, and a
    // field that leaked into them would change what the product sends on every
    // request to buy a compile a few seconds.
    const fetchMock = vi.fn().mockResolvedValue(answered());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    for await (const _e of backend().runTurn(turn())) {
      // Drain.
    }
    expect(sentBodies(fetchMock)[0]).not.toHaveProperty("thinking");
  });

  it("keeps room for the answer inside the budget the two of them share", async () => {
    // Measured against a reasoning model behind an OpenAI-compatible server:
    // given 8,000 output tokens and no bound, the turn spent all 8,000 of them
    // reasoning and emitted no answer. A bound set at the whole budget
    // reproduces exactly that, so the exact figure is asserted — a headroom
    // mutated to one token would still pass a merely-less-than check while
    // leaving one token for the answer.
    const fetchMock = vi.fn().mockResolvedValue(answered());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    for await (const _e of backend({ maxOutputTokens: 16_000 }).runTurn(
      turn({ maxTokens: 1_000_000 }),
    )) {
      // Drain.
    }
    const body = sentBodies(fetchMock)[0] ?? {};
    const budget = (body["thinking"] as { budget_tokens?: number }).budget_tokens;
    const outputBudget = body["max_tokens"] as number;
    expect(budget).toBe(outputBudget - 4_096);
  });

  it("raises a budget under the floor instead of failing the turn", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answered());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    for await (const _e of backend().runTurn(turn({ maxTokens: 10 }))) {
      // Drain.
    }
    expect(sentBodies(fetchMock)[0]?.["thinking"]).toEqual({
      type: "enabled",
      budget_tokens: 1_024,
    });
  });

  it("still bounds a server that declares no output ceiling at all", async () => {
    // The common case, and the one a fixed answer-headroom would have made a
    // no-op: with no configured ceiling the default output budget is 4,096, so
    // a share-based headroom leaves half of it — a real bound — where a fixed
    // 4,096 would have consumed the whole budget and sent none.
    const fetchMock = vi.fn().mockResolvedValue(answered());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const bare = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: MODEL });
    for await (const _e of bare.runTurn(turn({ maxTokens: 8_000 }))) {
      // Drain.
    }
    const body = sentBodies(fetchMock)[0] ?? {};
    expect((body["thinking"] as { budget_tokens?: number }).budget_tokens).toBe(
      (body["max_tokens"] as number) / 2,
    );
  });

  it("leaves the turn unbounded when the ceiling cannot fit floor and answer both", async () => {
    // Below this the answer's share leaves less than the provider's floor.
    // Clamping to the floor anyway would hand the model a bound nobody chose,
    // on a turn nobody could have sized.
    const fetchMock = vi.fn().mockResolvedValue(answered());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    for await (const _e of backend({ maxOutputTokens: 2_000 }).runTurn(
      turn({ maxTokens: 8_000 }),
    )) {
      // Drain.
    }
    expect(sentBodies(fetchMock)[0]).not.toHaveProperty("thinking");
  });

  it("gives up the bound, not the turn, when the server does not take the field", async () => {
    // Only some OpenAI-compatible servers accept a thinking block, and one that
    // does not rejects the whole request. Withdrawing the field and re-issuing
    // is the difference between a bound that does nothing on those installs and
    // a bound that breaks them.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rejectsThinking())
      .mockResolvedValue(answered());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const events: string[] = [];
    const be = backend();
    for await (const e of be.runTurn(turn({ maxTokens: 8_000 }))) {
      events.push(e.type);
    }
    const bodies = sentBodies(fetchMock);
    expect(bodies[0]).toHaveProperty("thinking");
    expect(bodies[1], "the turn was not re-issued without the field").not.toHaveProperty(
      "thinking",
    );
    expect(events).toContain("agent.message.end");
    expect(events).not.toContain("agent.error");

    // And the refusal is remembered: a second turn must not pay the rejected
    // request again.
    fetchMock.mockClear();
    for await (const _e of be.runTurn(turn({ maxTokens: 8_000 }))) {
      // Drain.
    }
    expect(sentBodies(fetchMock).every((b) => !("thinking" in b))).toBe(true);
  });
});

describe("a bound across the whole turn", () => {
  it("rides every request the turn makes, not only its first", async () => {
    // A turn that uses a tool makes several requests, and a bound applied to
    // one of them means the model reasons under one rule before it reads
    // anything and another afterwards. For a compiler that is the wrong half to
    // leave unbounded: the deciding it runs out of time on happens after the
    // reading, not before it.
    const fetchMock = vi.fn().mockResolvedValueOnce(calledTool()).mockResolvedValue(answered());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const tools = [
      {
        name: "look",
        description: "look something up",
        schema: z.object({}),
        invoke: async () => ({ content: "found" }) as unknown as ToolResult,
      },
    ] as unknown as TurnInput["tools"];
    for await (const _e of backend().runTurn({ ...turn({ maxTokens: 8_000 }), tools })) {
      // Drain.
    }
    const bodies = sentBodies(fetchMock);
    expect(bodies.length, "the turn made one request, so this proves nothing").toBeGreaterThan(1);
    for (const body of bodies) {
      expect(body).toHaveProperty("thinking");
    }
  });
});
