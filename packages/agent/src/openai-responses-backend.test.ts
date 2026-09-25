// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BACKGROUND_RATE_LIMIT_PATIENCE, type AgentEvent, type ToolResult } from "@omnesis/core";
import {
  OpenAIResponsesBackend,
  convertHistoryToResponsesInput,
  convertToolsToResponses,
} from "./openai-responses-backend.js";
import type { ToolContext, ToolHandle } from "./backend.js";

// ─── Helpers ────────────────────────────────────────────────────────────

function fakeToolHandle(
  name: string,
  fn: (args: unknown, context: ToolContext) => ToolResult,
): ToolHandle {
  return {
    name,
    description: `mock ${name}`,
    schema: z.object({ query: z.string() }),
    invoke: (args, context) => Promise.resolve(fn(args, context)),
  };
}

const baseInput = (overrides: Partial<Parameters<OpenAIResponsesBackend["runTurn"]>[0]> = {}) => ({
  sessionId: "S",
  messageId: "M",
  history: [],
  userMessage: "hi",
  tools: [],
  systemPrompt: "you are an agent",
  ...overrides,
});

/** Encode Responses `data:` SSE frames (the parser ignores the `event:` line). */
function responsesSSE(frames: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = frames
    .map((f) => `event: ${f.type as string}\ndata: ${JSON.stringify(f)}\n\n`)
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function sseResponse(frames: Array<Record<string, unknown>>, status = 200): Response {
  return new Response(responsesSSE(frames), {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function routedFetch(counts: Response[], responses: Response[]): ReturnType<typeof vi.fn> {
  let countIndex = 0;
  let responseIndex = 0;
  return vi.fn((input: string | URL | Request) => {
    const url = String(input);
    const response = url.endsWith("/responses/input_tokens")
      ? counts[countIndex++]
      : responses[responseIndex++];
    if (!response) throw new Error(`unexpected request to ${url}`);
    return Promise.resolve(response);
  });
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function textOf(events: AgentEvent[]): string {
  return events
    .filter((e) => e.type === "agent.text.delta")
    .map((e) => (e.payload as { delta: string }).delta)
    .join("");
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

// ─── Conversion ──────────────────────────────────────────────────────────

describe("convertHistoryToResponsesInput", () => {
  it("puts the system prompt in instructions and the user message last", () => {
    const { instructions, input } = convertHistoryToResponsesInput([], "hello", "be helpful");
    expect(instructions).toBe("be helpful");
    expect(input).toEqual([{ role: "user", content: "hello" }]);
  });

  it("maps tool_use → function_call and tool_result → function_call_output", () => {
    const result: ToolResult = { kind: "search.results", query: "x", durationMs: 1, results: [] };
    const { input } = convertHistoryToResponsesInput(
      [
        { role: "user", parts: [{ kind: "text", text: "find x" }] },
        {
          role: "assistant",
          parts: [
            { kind: "thinking", text: "hmm" },
            { kind: "text", text: "searching" },
            {
              kind: "tool_use",
              toolCallId: "call_1",
              tool: "search_documents",
              args: { query: "x" },
            },
          ],
        },
        { role: "user", parts: [{ kind: "tool_result", toolCallId: "call_1", result }] },
      ],
      "and now?",
      "sys",
    );
    expect(input).toEqual([
      { role: "user", content: "find x" },
      { role: "assistant", content: "searching" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "search_documents",
        arguments: '{"query":"x"}',
      },
      { type: "function_call_output", call_id: "call_1", output: JSON.stringify(result) },
      { role: "user", content: "and now?" },
    ]);
  });
});

describe("convertToolsToResponses", () => {
  it("produces flat function tools (name/description/parameters at top level)", () => {
    const tools = convertToolsToResponses([
      fakeToolHandle("search_documents", () => ({
        kind: "search.results",
        query: "",
        durationMs: 0,
        results: [],
      })),
    ]);
    expect(tools[0]!.type).toBe("function");
    expect(tools[0]!.name).toBe("search_documents");
    expect(tools[0]).toHaveProperty("parameters");
    expect(tools[0]).not.toHaveProperty("function");
  });
});

// ─── Streaming ─────────────────────────────────────────────────────────────

describe("OpenAIResponsesBackend.runTurn", () => {
  const newBackend = () =>
    new OpenAIResponsesBackend({ baseUrl: "http://localhost:18083", model: "o1-pro", apiKey: "k" });

  it("retries a rate limit before the response stream starts", async () => {
    vi.useFakeTimers();
    const responses = [
      new Response("limited", { status: 429 }),
      new Response("limited", { status: 429 }),
      sseResponse([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_text.delta", delta: "done" },
        {
          type: "response.completed",
          response: { id: "resp_1", usage: { input_tokens: 2, output_tokens: 1 } },
        },
      ]),
    ];
    const fetchSpy = vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith("/responses/input_tokens")) {
        return Promise.resolve(new Response("not supported", { status: 404 }));
      }
      return Promise.resolve(responses.shift()!);
    });
    globalThis.fetch = fetchSpy;

    const pending = collect(newBackend().runTurn(baseInput()));
    const generationCallCount = (): number =>
      fetchSpy.mock.calls.filter(([input]) => !String(input).endsWith("/responses/input_tokens"))
        .length;
    await vi.waitFor(() => expect(generationCallCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(generationCallCount()).toBe(2));
    await vi.advanceTimersByTimeAsync(3_000);
    const events = await pending;

    const generationCalls = fetchSpy.mock.calls.filter(
      ([input]) => !String(input).endsWith("/responses/input_tokens"),
    );
    expect(generationCalls).toHaveLength(3);
    expect(textOf(events)).toBe("done");
  });

  it("waits out a minute-long quota reset when the turn is patient", async () => {
    vi.useFakeTimers();
    const responses = [
      new Response("limited", { status: 429, headers: { "Retry-After": "60" } }),
      sseResponse([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_text.delta", delta: "done" },
        {
          type: "response.completed",
          response: { id: "resp_1", usage: { input_tokens: 2, output_tokens: 1 } },
        },
      ]),
    ];
    const fetchSpy = vi.fn((input: string | URL | Request) => {
      if (String(input).endsWith("/responses/input_tokens")) {
        return Promise.resolve(new Response("not supported", { status: 404 }));
      }
      return Promise.resolve(responses.shift()!);
    });
    globalThis.fetch = fetchSpy;
    const generationCallCount = (): number =>
      fetchSpy.mock.calls.filter(([input]) => !String(input).endsWith("/responses/input_tokens"))
        .length;

    const pending = collect(
      newBackend().runTurn(baseInput({ rateLimitPatience: BACKGROUND_RATE_LIMIT_PATIENCE })),
    );
    await vi.waitFor(() => expect(generationCallCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(66_000);
    const events = await pending;

    expect(generationCallCount()).toBe(2);
    expect(textOf(events)).toBe("done");
  });

  it("ends a patient turn promptly when it is cancelled mid-wait", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn((input: string | URL | Request) =>
      Promise.resolve(
        String(input).endsWith("/responses/input_tokens")
          ? new Response("not supported", { status: 404 })
          : new Response("limited", { status: 429, headers: { "Retry-After": "60" } }),
      ),
    );
    globalThis.fetch = fetchSpy;
    const generationCallCount = (): number =>
      fetchSpy.mock.calls.filter(([input]) => !String(input).endsWith("/responses/input_tokens"))
        .length;
    const controller = new AbortController();

    const pending = collect(
      newBackend().runTurn(
        baseInput({ rateLimitPatience: BACKGROUND_RATE_LIMIT_PATIENCE }),
        controller.signal,
      ),
    );
    await vi.waitFor(() => expect(generationCallCount()).toBe(1));
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    const events = await pending;

    expect(generationCallCount()).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "canceled" },
    });
  });

  it("streams output_text deltas and accounts usage from response.completed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_text.delta", delta: "Hello" },
        { type: "response.output_text.delta", delta: " there" },
        {
          type: "response.completed",
          response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ]),
    );
    const events = await collect(newBackend().runTurn(baseInput()));
    expect(textOf(events)).toBe("Hello there");
    const end = events.find((e) => e.type === "agent.message.end");
    expect(
      (end!.payload as { usage: { inputTokens: number; outputTokens: number } }).usage,
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
    });
  });

  it("posts to the /responses endpoint with input + instructions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        { type: "response.created", response: { id: "r" } },
        { type: "response.output_text.delta", delta: "hi" },
        { type: "response.completed", response: { id: "r", usage: {} } },
      ]),
    );
    globalThis.fetch = fetchMock;
    await collect(newBackend().runTurn(baseInput({ userMessage: "ping", systemPrompt: "SP" })));
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe("http://localhost:18083/v1/responses");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.instructions).toBe("SP");
    expect(body.input).toEqual([{ role: "user", content: "ping" }]);
    expect(body.stream).toBe(true);
    expect(body.truncation).toBe("disabled");
    expect(body.max_output_tokens).toBe(4096);
  });

  it("uses a configured output-token cap while keeping truncation disabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { id: "r", usage: {} } },
      ]),
    );
    globalThis.fetch = fetchMock;
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "o1-pro",
      modelLimits: { maxOutputTokens: 777 },
    });
    await collect(backend.runTurn(baseInput()));
    const body = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body);
    expect(body.max_output_tokens).toBe(777);
    expect(body.truncation).toBe("disabled");
  });

  it("retries any empty max-output response once with a bounded 32K allowance", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = routedFetch(
      [jsonResponse({ error: "unsupported" }, 404)],
      [
        sseResponse([
          {
            type: "response.incomplete",
            response: {
              id: "r1",
              incomplete_details: { reason: "max_output_tokens" },
              usage: { input_tokens: 4, output_tokens: 4_096 },
            },
          },
        ]),
        sseResponse([
          { type: "response.output_text.delta", delta: "finished" },
          {
            type: "response.completed",
            response: { id: "r2", usage: { input_tokens: 5, output_tokens: 7 } },
          },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "unclassified-model",
    });
    const events = await collect(backend.runTurn(baseInput()));
    const responseBodies = fetchMock.mock.calls
      .filter(([url]) => !String(url).endsWith("/input_tokens"))
      .map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(responseBodies.map((body) => body.max_output_tokens)).toEqual([4_096, 32_768]);
    expect(timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
      120_000, 120_000, 600_000,
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: {
        stopReason: "end_turn",
        usage: { inputTokens: 9, outputTokens: 4_103 },
        context: { reservedOutputTokens: 32_768 },
      },
    });
  });

  it("does not retry an output-limited response that contains a valid function call", async () => {
    const fetchMock = routedFetch(
      [jsonResponse({ error: "unsupported" }, 404)],
      [
        sseResponse([
          {
            type: "response.output_item.done",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "search_documents",
              arguments: '{"query":"x"}',
            },
          },
          {
            type: "response.incomplete",
            response: {
              id: "r1",
              incomplete_details: { reason: "max_output_tokens" },
              usage: { input_tokens: 4, output_tokens: 4_096 },
            },
          },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;

    const events = await collect(newBackend().runTurn(baseInput()));

    expect(
      fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/input_tokens")),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "max_tokens", failure: { code: "output_truncated" } },
    });
  });

  it("preflights the larger retry allowance against the context window", async () => {
    const fetchMock = routedFetch(
      [jsonResponse({ input_tokens: 1_000 }), jsonResponse({ input_tokens: 1_000 })],
      [
        sseResponse([
          {
            type: "response.incomplete",
            response: {
              id: "r1",
              incomplete_details: { reason: "max_output_tokens" },
              usage: { input_tokens: 1_000, output_tokens: 4_096 },
            },
          },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "unclassified-model",
      modelLimits: { contextWindowTokens: 20_000 },
      contextSafetyMarginTokens: 0,
    });

    const events = await collect(backend.runTurn(baseInput()));

    expect(
      fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/input_tokens")),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: {
        stopReason: "error",
        usage: { inputTokens: 1_000, outputTokens: 4_096 },
        context: { reservedOutputTokens: 32_768, requestIteration: 2 },
        failure: { code: "context_window_exceeded", retryable: false },
      },
    });
  });

  it("does not repeat a request already using its configured ceiling", async () => {
    const incomplete = (id: string, inputTokens: number, outputTokens: number) =>
      sseResponse([
        {
          type: "response.incomplete",
          response: {
            id,
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          },
        },
      ]);
    const fetchMock = routedFetch(
      [jsonResponse({ error: "unsupported" }, 404)],
      [incomplete("r1", 4, 4_096), incomplete("r2", 5, 20_000)],
    );
    globalThis.fetch = fetchMock;
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "unclassified-model",
      modelLimits: { maxOutputTokens: 20_000 },
    });

    const events = await collect(backend.runTurn(baseInput()));
    const responseBodies = fetchMock.mock.calls
      .filter(([url]) => !String(url).endsWith("/input_tokens"))
      .map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(responseBodies.map((body) => body.max_output_tokens)).toEqual([20_000]);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: {
        stopReason: "max_tokens",
        usage: { inputTokens: 4, outputTokens: 4_096 },
        failure: { code: "output_truncated", retryable: false },
      },
    });
  });

  it("stops after the single 32K recovery attempt is also empty", async () => {
    const incomplete = (id: string, inputTokens: number, outputTokens: number) =>
      sseResponse([
        {
          type: "response.incomplete",
          response: {
            id,
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          },
        },
      ]);
    const fetchMock = routedFetch(
      [jsonResponse({ error: "unsupported" }, 404)],
      [incomplete("r1", 4, 4_096), incomplete("r2", 5, 32_768)],
    );
    globalThis.fetch = fetchMock;

    const events = await collect(newBackend().runTurn(baseInput()));
    const responseBodies = fetchMock.mock.calls
      .filter(([url]) => !String(url).endsWith("/input_tokens"))
      .map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(responseBodies.map((body) => body.max_output_tokens)).toEqual([4_096, 32_768]);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: {
        stopReason: "max_tokens",
        usage: { inputTokens: 9, outputTokens: 36_864 },
        failure: { code: "output_truncated", retryable: false },
      },
    });
  });

  it("preserves a visible partial reasoning response without retrying it", async () => {
    const fetchMock = routedFetch(
      [jsonResponse({ error: "unsupported" }, 404)],
      [
        sseResponse([
          { type: "response.output_text.delta", delta: "grounded partial" },
          {
            type: "response.incomplete",
            response: {
              id: "r1",
              incomplete_details: { reason: "max_output_tokens" },
              usage: { input_tokens: 4, output_tokens: 16_384 },
            },
          },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "reasoning-model",
    });

    const events = await collect(backend.runTurn(baseInput()));
    expect(textOf(events)).toBe("grounded partial");
    expect(
      fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/input_tokens")),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "max_tokens", failure: { code: "output_truncated" } },
    });
  });

  it("treats whitespace-only output as empty when deciding whether to retry", async () => {
    const fetchMock = routedFetch(
      [jsonResponse({ error: "unsupported" }, 404)],
      [
        sseResponse([
          { type: "response.output_text.delta", delta: " \n" },
          {
            type: "response.incomplete",
            response: {
              id: "r1",
              incomplete_details: { reason: "max_output_tokens" },
              usage: { input_tokens: 4, output_tokens: 4_096 },
            },
          },
        ]),
        sseResponse([
          { type: "response.output_text.delta", delta: "recovered" },
          { type: "response.completed", response: { id: "r2", usage: {} } },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;

    const events = await collect(newBackend().runTurn(baseInput()));

    expect(textOf(events)).toBe(" \nrecovered");
    const responseBodies = fetchMock.mock.calls
      .filter(([url]) => !String(url).endsWith("/input_tokens"))
      .map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(responseBodies.map((body) => body.max_output_tokens)).toEqual([4_096, 32_768]);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "end_turn" },
    });
  });

  it.each([
    [
      "reasoning summary",
      [{ type: "response.reasoning_summary_text.delta", delta: "considering evidence" }],
    ],
    [
      "reasoning output item",
      [{ type: "response.output_item.added", item: { id: "rs_1", type: "reasoning" } }],
    ],
    [
      "inline think tag",
      [
        { type: "response.output_text.delta", delta: "<thi" },
        { type: "response.output_text.delta", delta: "nk>private</think>" },
      ],
    ],
  ])("remembers observed extended output from %s", async (_label, evidenceFrames) => {
    const fetchMock = routedFetch(
      [jsonResponse({ error: "unsupported" }, 404)],
      [
        sseResponse([
          ...evidenceFrames,
          { type: "response.output_text.delta", delta: "first" },
          { type: "response.completed", response: { id: "r1", usage: {} } },
        ]),
        sseResponse([
          { type: "response.output_text.delta", delta: "second" },
          { type: "response.completed", response: { id: "r2", usage: {} } },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const backend = newBackend();

    await collect(backend.runTurn(baseInput()));
    await collect(backend.runTurn(baseInput({ messageId: "M2" })));

    const responseBodies = fetchMock.mock.calls
      .filter(([url]) => !String(url).endsWith("/input_tokens"))
      .map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(responseBodies.map((body) => body.max_output_tokens)).toEqual([4_096, 16_384]);
    expect(timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs)).toContain(600_000);
  });

  it("remembers provider-reported reasoning token usage", async () => {
    const fetchMock = routedFetch(
      [jsonResponse({ error: "unsupported" }, 404)],
      [
        sseResponse([
          { type: "response.output_text.delta", delta: "first" },
          {
            type: "response.completed",
            response: {
              id: "r1",
              usage: {
                input_tokens: 4,
                output_tokens: 8,
                output_tokens_details: { reasoning_tokens: 6 },
              },
            },
          },
        ]),
        sseResponse([
          { type: "response.output_text.delta", delta: "second" },
          { type: "response.completed", response: { id: "r2", usage: {} } },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;
    const backend = newBackend();

    await collect(backend.runTurn(baseInput()));
    await collect(backend.runTurn(baseInput({ messageId: "M2" })));

    const responseBodies = fetchMock.mock.calls
      .filter(([url]) => !String(url).endsWith("/input_tokens"))
      .map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(responseBodies.map((body) => body.max_output_tokens)).toEqual([4_096, 16_384]);
  });

  it("keeps the configured timeout after extended output is observed", async () => {
    const fetchMock = routedFetch(
      [jsonResponse({ error: "unsupported" }, 404)],
      [
        sseResponse([
          { type: "response.reasoning_summary_text.delta", delta: "considering evidence" },
          { type: "response.output_text.delta", delta: "first" },
          { type: "response.completed", response: { id: "r1", usage: {} } },
        ]),
        sseResponse([
          { type: "response.output_text.delta", delta: "second" },
          { type: "response.completed", response: { id: "r2", usage: {} } },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "unclassified-model",
      timeoutMs: 345_000,
    });

    await collect(backend.runTurn(baseInput()));
    await collect(backend.runTurn(baseInput({ messageId: "M2" })));

    expect(timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
      345_000, 345_000, 345_000,
    ]);
  });

  it("runs a tool call, then continues via previous_response_id + function_call_output", async () => {
    const fetchMock = routedFetch(
      [jsonResponse({ error: { message: "not supported" } }, 404)],
      [
        // Round 1: model asks for a tool call.
        sseResponse([
          { type: "response.created", response: { id: "resp_1" } },
          {
            type: "response.output_item.added",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "search_documents",
              arguments: "",
            },
          },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"query":' },
          { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"x"}' },
          {
            type: "response.output_item.done",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "search_documents",
              arguments: '{"query":"x"}',
            },
          },
          {
            type: "response.completed",
            response: { id: "resp_1", usage: { input_tokens: 20, output_tokens: 8 } },
          },
        ]),
        // Round 2: final answer.
        sseResponse([
          { type: "response.created", response: { id: "resp_2" } },
          { type: "response.output_text.delta", delta: "Found it." },
          {
            type: "response.completed",
            response: { id: "resp_2", usage: { input_tokens: 30, output_tokens: 4 } },
          },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;

    const toolResult: ToolResult = {
      kind: "search.results",
      query: "x",
      durationMs: 1,
      results: [],
    };
    const events = await collect(
      newBackend().runTurn(
        baseInput({ tools: [fakeToolHandle("search_documents", () => toolResult)] }),
      ),
    );

    // Tool was surfaced and the final answer streamed.
    const toolStart = events.find((e) => e.type === "agent.tool.start");
    expect((toolStart!.payload as { tool: string }).tool).toBe("search_documents");
    expect(events.some((e) => e.type === "agent.tool.result")).toBe(true);
    expect(textOf(events)).toBe("Found it.");

    // Continuation request chains by previous_response_id and sends only the output.
    const secondBody = JSON.parse((fetchMock.mock.calls[2]![1] as { body: string }).body);
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toEqual([
      { type: "function_call_output", call_id: "call_1", output: JSON.stringify(toolResult) },
    ]);

    // Usage accumulates across both rounds.
    const end = events.find((e) => e.type === "agent.message.end");
    expect(
      (end!.payload as { usage: { inputTokens: number; outputTokens: number } }).usage,
    ).toEqual({
      inputTokens: 50,
      outputTokens: 12,
      cacheReadTokens: 0,
    });
  });

  it("returns tool_args_unparseable instead of invoking when arguments are malformed", async () => {
    const truncated = '{"query":"unfini';
    const fetchMock = routedFetch(
      [jsonResponse({ error: { message: "not supported" } }, 404)],
      [
        sseResponse([
          { type: "response.created", response: { id: "resp_1" } },
          {
            type: "response.output_item.done",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "search_documents",
              arguments: truncated,
            },
          },
          {
            type: "response.completed",
            response: { id: "resp_1", usage: { input_tokens: 20, output_tokens: 8 } },
          },
        ]),
        sseResponse([
          { type: "response.created", response: { id: "resp_2" } },
          { type: "response.output_text.delta", delta: "understood" },
          {
            type: "response.completed",
            response: { id: "resp_2", usage: { input_tokens: 30, output_tokens: 4 } },
          },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;

    let invoked = false;
    const events = await collect(
      newBackend().runTurn(
        baseInput({
          tools: [
            fakeToolHandle("search_documents", () => {
              invoked = true;
              return { kind: "search.results", query: "x", durationMs: 0, results: [] };
            }),
          ],
        }),
      ),
    );

    expect(invoked).toBe(false);
    const start = events.find((e) => e.type === "agent.tool.start");
    if (start?.type !== "agent.tool.start") throw new Error("expected tool.start");
    expect(start.payload.args).toEqual({});
    const resultEvt = events.find((e) => e.type === "agent.tool.result");
    if (resultEvt?.type !== "agent.tool.result") throw new Error("expected tool.result");
    const result = resultEvt.payload.result;
    if (result.kind !== "error") throw new Error("expected error result");
    expect(result.code).toBe("tool_args_unparseable");
    expect(result.message).toContain(truncated);

    // The fabricated error is fed back as the round's function_call_output.
    const secondBody = JSON.parse((fetchMock.mock.calls[2]![1] as { body: string }).body);
    expect(secondBody.input[0].type).toBe("function_call_output");
    expect(secondBody.input[0].output).toContain("tool_args_unparseable");
  });

  it("still invokes a no-argument tool when the arguments string is empty", async () => {
    const fetchMock = routedFetch(
      [jsonResponse({ error: { message: "not supported" } }, 404)],
      [
        sseResponse([
          { type: "response.created", response: { id: "resp_1" } },
          {
            type: "response.output_item.done",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "search_documents",
              arguments: "",
            },
          },
          { type: "response.completed", response: { id: "resp_1", usage: {} } },
        ]),
        sseResponse([
          { type: "response.created", response: { id: "resp_2" } },
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { id: "resp_2", usage: {} } },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;

    let invokedWith: unknown = "never";
    await collect(
      newBackend().runTurn(
        baseInput({
          tools: [
            fakeToolHandle("search_documents", (args) => {
              invokedWith = args;
              return { kind: "search.results", query: "", durationMs: 0, results: [] };
            }),
          ],
        }),
      ),
    );

    expect(invokedWith).toEqual({});
  });

  it("streams batch child progress before its durable tool result", async () => {
    globalThis.fetch = routedFetch(
      [jsonResponse({ error: { message: "not supported" } }, 404)],
      [
        sseResponse([
          { type: "response.created", response: { id: "resp_1" } },
          {
            type: "response.output_item.added",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "search_many",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            delta: '{"query":"budget"}',
          },
          {
            type: "response.output_item.done",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "search_many",
              arguments: '{"query":"budget"}',
            },
          },
          { type: "response.completed", response: { id: "resp_1", usage: {} } },
        ]),
        sseResponse([
          { type: "response.created", response: { id: "resp_2" } },
          { type: "response.output_text.delta", delta: "Done." },
          { type: "response.completed", response: { id: "resp_2", usage: {} } },
        ]),
      ],
    );
    const tool = fakeToolHandle("search_many", (_args, context) => {
      context.onChildStart?.({ index: 0, tool: "search_documents", argsSummary: "budget" });
      context.onChildResult?.({
        index: 0,
        result: { kind: "search.results", query: "budget", durationMs: 1, results: [] },
      });
      return { kind: "search.batch", items: [] };
    });

    const events = await collect(newBackend().runTurn(baseInput({ tools: [tool] })));

    expect(events.findIndex((event) => event.type === "agent.tool.child.start")).toBeLessThan(
      events.findIndex((event) => event.type === "agent.tool.result"),
    );
    expect(events.findIndex((event) => event.type === "agent.tool.child.result")).toBeLessThan(
      events.findIndex((event) => event.type === "agent.tool.result"),
    );
  });

  it("splits input_tokens_details.cached_tokens out of input", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        { type: "response.created", response: { id: "resp_1" } },
        { type: "response.output_text.delta", delta: "hi" },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            usage: {
              input_tokens: 3000,
              output_tokens: 6,
              input_tokens_details: { cached_tokens: 2800 },
            },
          },
        },
      ]),
    );
    const events = await collect(newBackend().runTurn(baseInput()));
    const end = events.find((e) => e.type === "agent.message.end");
    expect(
      (end!.payload as { usage: { inputTokens: number; outputTokens: number } }).usage,
    ).toEqual({
      inputTokens: 200,
      outputTokens: 6,
      cacheReadTokens: 2800,
    });
  });

  it("surfaces a non-2xx error via agent.error with the provider message", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: "model not found" } }, 404));
    const events = await collect(newBackend().runTurn(baseInput()));
    const err = events.find((e) => e.type === "agent.error");
    expect((err!.payload as { message: string }).message).toBe(
      "The model provider has no such endpoint or model (HTTP 404).",
    );
    expect((err!.payload as { message: string }).message).not.toContain("model not found");
    expect(events.at(-1)!.type).toBe("agent.message.end");
  });

  it("reports stopReason max_tokens when the response is incomplete (truncated)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        { type: "response.created", response: { id: "r" } },
        { type: "response.output_text.delta", delta: "partial" },
        {
          type: "response.incomplete",
          response: {
            id: "r",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 5, output_tokens: 9 },
          },
        },
      ]),
    );
    const events = await collect(newBackend().runTurn(baseInput()));
    const end = events.find((e) => e.type === "agent.message.end");
    expect((end!.payload as { stopReason: string }).stopReason).toBe("max_tokens");
    expect(
      (end!.payload as { failure?: { code: string; retryable: boolean } }).failure,
    ).toMatchObject({
      code: "output_truncated",
      retryable: false,
    });
  });

  it("probes input tokens without a configured limit and reports occupancy as provider-counted", async () => {
    const fetchMock = routedFetch(
      [jsonResponse({ input_tokens: 123 })],
      [
        sseResponse([
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { id: "r", usage: {} } },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;

    const events = await collect(newBackend().runTurn(baseInput()));

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "http://localhost:18083/v1/responses/input_tokens",
    );
    const countBody = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(countBody.stream).toBeUndefined();
    expect(countBody.max_output_tokens).toBeUndefined();
    expect(countBody.model).toBe("o1-pro");
    expect(countBody.input).toEqual([{ role: "user", content: "hi" }]);
    expect(countBody.instructions).toBe("you are an agent");
    expect(countBody.truncation).toBe("disabled");
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.context).toMatchObject({
      inputTokens: 123,
      peakInputTokens: 123,
      measurement: "provider_count",
      limitSource: "unknown",
      requestIteration: 1,
    });
    expect(end.payload.context?.contextWindowTokens).toBeUndefined();
  });

  it.each([
    ["under", 3_999, "end_turn", 1],
    ["equal", 4_000, "end_turn", 1],
    ["over", 4_001, "error", 0],
  ] as const)(
    "enforces the configured context boundary when the count is %s",
    async (_label, count, expectedStop, expectedCreates) => {
      const fetchMock = routedFetch(
        [jsonResponse({ input_tokens: count })],
        [
          sseResponse([
            { type: "response.output_text.delta", delta: "ok" },
            { type: "response.completed", response: { id: "r", usage: {} } },
          ]),
        ],
      );
      globalThis.fetch = fetchMock;
      const backend = new OpenAIResponsesBackend({
        baseUrl: "http://localhost:18083",
        model: "o1-pro",
        modelLimits: { contextWindowTokens: 5_000, maxOutputTokens: 1_000 },
        contextSafetyMarginTokens: 0,
      });

      const events = await collect(backend.runTurn(baseInput()));

      const creates = fetchMock.mock.calls.filter(
        ([url]) => !String(url).endsWith("/input_tokens"),
      );
      expect(creates).toHaveLength(expectedCreates);
      const end = events.at(-1);
      if (end?.type !== "agent.message.end") throw new Error("expected message end");
      expect(end.payload.stopReason).toBe(expectedStop);
      if (expectedStop === "error") {
        expect(end.payload.failure).toMatchObject({
          code: "context_window_exceeded",
          retryable: false,
        });
      }
    },
  );

  it("publishes the configured input-only ceiling on a Responses preflight failure", async () => {
    const fetchMock = routedFetch([jsonResponse({ input_tokens: 5_001 })], []);
    globalThis.fetch = fetchMock;
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "o1-pro",
      modelLimits: { maxInputTokens: 5_000, maxOutputTokens: 1_000 },
      contextSafetyMarginTokens: 0,
    });

    const events = await collect(backend.runTurn(baseInput()));

    expect(fetchMock).toHaveBeenCalledOnce();
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.failure?.code).toBe("context_window_exceeded");
    expect(end.payload.context).toMatchObject({
      inputTokens: 5_001,
      peakInputTokens: 5_001,
      maxInputTokens: 5_000,
      measurement: "provider_count",
      limitSource: "configured",
    });
    expect(end.payload.context?.contextWindowTokens).toBeUndefined();
  });

  it("counts chained tool input and blocks growth before the second model request", async () => {
    const fetchMock = routedFetch(
      [jsonResponse({ input_tokens: 100 }), jsonResponse({ input_tokens: 4_901 })],
      [
        sseResponse([
          {
            type: "response.output_item.added",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "search_documents",
              arguments: '{"query":"x"}',
            },
          },
          {
            type: "response.completed",
            response: { id: "resp_1", usage: { input_tokens: 100, output_tokens: 5 } },
          },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "o1-pro",
      modelLimits: { contextWindowTokens: 5_000, maxOutputTokens: 100 },
      contextSafetyMarginTokens: 0,
    });
    const events = await collect(
      backend.runTurn(
        baseInput({
          tools: [
            fakeToolHandle("search_documents", () => ({
              kind: "search.results",
              query: "x",
              durationMs: 1,
              results: [],
            })),
          ],
        }),
      ),
    );

    const creates = fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/input_tokens"));
    expect(creates).toHaveLength(1);
    const secondCountBody = JSON.parse((fetchMock.mock.calls[2]![1] as { body: string }).body);
    expect(secondCountBody.previous_response_id).toBe("resp_1");
    expect(secondCountBody.input[0]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
    });
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.failure?.code).toBe("context_window_exceeded");
    expect(end.payload.context).toMatchObject({
      inputTokens: 4_901,
      peakInputTokens: 4_901,
      requestIteration: 2,
    });
  });

  it("caches an unsupported input-count endpoint and continues without truncation", async () => {
    const fetchMock = routedFetch(
      [jsonResponse({ error: { message: "not found" } }, 404)],
      [
        sseResponse([
          {
            type: "response.output_item.added",
            item: {
              id: "fc_1",
              type: "function_call",
              call_id: "call_1",
              name: "search_documents",
              arguments: '{"query":"x"}',
            },
          },
          { type: "response.completed", response: { id: "resp_1", usage: {} } },
        ]),
        sseResponse([
          { type: "response.output_text.delta", delta: "done" },
          { type: "response.completed", response: { id: "resp_2", usage: {} } },
        ]),
      ],
    );
    globalThis.fetch = fetchMock;
    const events = await collect(
      newBackend().runTurn(
        baseInput({
          tools: [
            fakeToolHandle("search_documents", () => ({
              kind: "search.results",
              query: "x",
              durationMs: 1,
              results: [],
            })),
          ],
        }),
      ),
    );

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/responses/input_tokens")),
    ).toHaveLength(1);
    expect(textOf(events)).toBe("done");
  });

  it("clears stale current input when counting is transiently unavailable before a reactive overflow", async () => {
    let countCalls = 0;
    let createCalls = 0;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/responses/input_tokens")) {
        countCalls++;
        return countCalls === 1
          ? Promise.resolve(jsonResponse({ input_tokens: 100 }))
          : Promise.reject(new Error("count endpoint reset"));
      }
      createCalls++;
      return Promise.resolve(
        createCalls === 1
          ? sseResponse([
              {
                type: "response.output_item.added",
                item: {
                  id: "fc_1",
                  type: "function_call",
                  call_id: "call_1",
                  name: "search_documents",
                  arguments: '{"query":"x"}',
                },
              },
              {
                type: "response.completed",
                response: { id: "resp_1", usage: { input_tokens: 100, output_tokens: 5 } },
              },
            ])
          : jsonResponse(
              {
                error: {
                  type: "invalid_request_error",
                  code: "context_length_exceeded",
                  message: "maximum context length exceeded",
                },
              },
              400,
            ),
      );
    });
    globalThis.fetch = fetchMock;
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "o1-pro",
      modelLimits: { contextWindowTokens: 5_000, maxOutputTokens: 100 },
      contextSafetyMarginTokens: 0,
    });
    const events = await collect(
      backend.runTurn(
        baseInput({
          tools: [
            fakeToolHandle("search_documents", () => ({
              kind: "search.results",
              query: "x",
              durationMs: 1,
              results: [],
            })),
          ],
        }),
      ),
    );

    expect(countCalls).toBe(2);
    expect(createCalls).toBe(2);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.failure?.code).toBe("context_window_exceeded");
    expect(end.payload.context).toMatchObject({
      peakInputTokens: 100,
      measurement: "unknown",
      requestIteration: 2,
    });
    expect(end.payload.context?.inputTokens).toBeUndefined();
  });

  it("preserves partial text when a structured stream error reports context overflow", async () => {
    const secret = "private echoed provider text";
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        { type: "response.output_text.delta", delta: "partial" },
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            code: "context_length_exceeded",
            message: `maximum context length exceeded: ${secret}`,
          },
        },
      ]),
    );
    const events = await collect(newBackend().runTurn(baseInput()));
    expect(textOf(events)).toBe("partial");
    const error = events.find((event) => event.type === "agent.error");
    if (error?.type !== "agent.error") throw new Error("expected agent error");
    expect(error.payload.code).toBe("context_window_exceeded");
    expect(error.payload.message).not.toContain(secret);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.failure?.retryable).toBe(false);
  });

  it("uses the last cumulative usage event for a Responses request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        {
          type: "response.completed",
          response: { id: "r", usage: { input_tokens: 100, output_tokens: 50 } },
        },
        {
          type: "response.completed",
          response: { id: "r", usage: { input_tokens: 90, output_tokens: 40 } },
        },
      ]),
    );
    const events = await collect(newBackend().runTurn(baseInput()));
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.usage).toEqual({
      inputTokens: 90,
      outputTokens: 40,
      cacheReadTokens: 0,
    });
    expect(end.payload.context).toMatchObject({
      inputTokens: 90,
      peakInputTokens: 100,
      measurement: "provider_reported",
    });
  });

  it.each([
    ["max_output_tokens", "max_tokens", "output_truncated"],
    ["content_filter", "error", "http_response_incomplete"],
  ] as const)("classifies incomplete reason %s", async (reason, stopReason, failureCode) => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        sseResponse([
          {
            type: "response.incomplete",
            response: { id: "r", incomplete_details: { reason }, usage: {} },
          },
        ]),
      ),
    );
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "o1-pro",
      modelLimits: { maxOutputTokens: 4_096 },
    });
    const events = await collect(backend.runTurn(baseInput()));
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.stopReason).toBe(stopReason);
    expect(end.payload.failure?.code).toBe(failureCode);
  });

  it("emits canceled and never calls fetch when the signal is already aborted", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const events = await collect(newBackend().runTurn(baseInput(), AbortSignal.abort()));
    expect(fetchMock).not.toHaveBeenCalled();
    const end = events.find((e) => e.type === "agent.message.end");
    expect((end!.payload as { stopReason: string }).stopReason).toBe("canceled");
  });

  it("reports cancellation while a request is pending without an agent error", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), {
          once: true,
        });
        controller.abort();
      });
    });

    const events = await collect(newBackend().runTurn(baseInput(), controller.signal));
    expect(events.some((event) => event.type === "agent.error")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "canceled" },
    });
  });

  it("distinguishes the model request deadline from a connection failure", async () => {
    globalThis.fetch = vi.fn((input, init) => {
      if (String(input).endsWith("/input_tokens")) {
        return Promise.resolve(jsonResponse({ error: "unsupported" }, 404));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "o1-pro",
      timeoutMs: 5,
    });

    const events = await collect(backend.runTurn(baseInput()));
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: {
        stopReason: "error",
        failure: { code: "http_request_timeout", retryable: true },
      },
    });
  });

  it("reports cancellation while a response stream is open without an agent error", async () => {
    const controller = new AbortController();
    let requestCount = 0;
    globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/input_tokens")) {
        return Promise.resolve(jsonResponse({ error: "unsupported" }, 404));
      }
      requestCount += 1;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            encoder.encode(
              `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "thinking" })}\n\n`,
            ),
          );
          init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), {
            once: true,
          });
          queueMicrotask(() => controller.abort());
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      );
    });

    const events = await collect(newBackend().runTurn(baseInput(), controller.signal));
    expect(requestCount).toBe(1);
    expect(events.some((event) => event.type === "agent.error")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "canceled" },
    });
  });

  it("types a deadline that expires after streaming headers arrive", async () => {
    globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/input_tokens")) {
        return Promise.resolve(jsonResponse({ error: "unsupported" }, 404));
      }
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      );
    });
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "o1-pro",
      timeoutMs: 5,
    });
    const events = await collect(backend.runTurn(baseInput()));
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { failure: { code: "http_request_timeout" } },
    });
  });

  it("types a deadline while reading a rejected response body", async () => {
    globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/input_tokens")) {
        return Promise.resolve(jsonResponse({ error: "unsupported" }, 404));
      }
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return Promise.resolve(
        new Response(body, { status: 503, headers: { "Content-Type": "application/json" } }),
      );
    });
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18083",
      model: "o1-pro",
      timeoutMs: 5,
    });
    const events = await collect(backend.runTurn(baseInput()));
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { failure: { code: "http_request_timeout" } },
    });
  });

  it("parses an SSE frame split across stream chunks", async () => {
    // Encode one full text+completed stream, then split the bytes mid-frame so
    // the line buffer must stitch a `data:` JSON across two reads.
    const frames = [
      { type: "response.created", response: { id: "r" } },
      { type: "response.output_text.delta", delta: "Hello world" },
      {
        type: "response.completed",
        response: { id: "r", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];
    const full = frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join("");
    const bytes = new TextEncoder().encode(full);
    const mid = Math.floor(bytes.length / 2);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
      );
    const events = await collect(newBackend().runTurn(baseInput()));
    expect(textOf(events)).toBe("Hello world");
  });
});
