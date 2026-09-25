// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BACKGROUND_RATE_LIMIT_PATIENCE, type AgentEvent, type ToolResult } from "@omnesis/core";
import { HttpChatBackend, convertHistoryToOpenAI, convertToolsToOpenAI } from "./http-backend.js";
import type { ToolHandle } from "./backend.js";

// ─── Helpers ────────────────────────────────────────────────────────────

function fakeToolHandle(name: string, fn: (args: unknown) => ToolResult): ToolHandle {
  return {
    name,
    description: `mock ${name}`,
    schema: z.object({ query: z.string() }),
    async invoke(args) {
      return fn(args);
    },
  };
}

const baseInput = (overrides: Partial<Parameters<HttpChatBackend["runTurn"]>[0]> = {}) => ({
  sessionId: "S",
  messageId: "M",
  history: [],
  userMessage: "hi",
  tools: [],
  systemPrompt: "you are an agent",
  ...overrides,
});

/**
 * Encode an array of SSE chunks into a ReadableStream body, as a server
 * would send them over the wire.
 */
function sseBody(chunks: Array<Record<string, unknown> | "[DONE]">): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map((c) => {
    if (c === "[DONE]") return "data: [DONE]\n\n";
    return `data: ${JSON.stringify(c)}\n\n`;
  });
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

/** Build a text-only SSE response (no tool calls). */
function textOnlySSE(fragments: string[]): Array<Record<string, unknown> | "[DONE]"> {
  const chunks: Array<Record<string, unknown> | "[DONE]"> = [];
  for (const frag of fragments) {
    chunks.push({
      choices: [{ delta: { content: frag }, finish_reason: null }],
    });
  }
  chunks.push({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  });
  chunks.push("[DONE]");
  return chunks;
}

/**
 * Build SSE chunks for a tool_calls finish_reason response. The model
 * requests a single tool call.
 */
function toolUseSSE(
  toolCallId: string,
  toolName: string,
  args: unknown,
): Array<Record<string, unknown> | "[DONE]"> {
  const argsStr = JSON.stringify(args);
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: toolCallId,
                function: { name: toolName, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: argsStr },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 30, completion_tokens: 15 },
    },
    "[DONE]",
  ];
}

function mockFetchResponse(body: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** A non-streamed JSON chat-completions response (for the non-streaming fallback). */
function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("convertHistoryToOpenAI", () => {
  it("converts empty history to system + user message", () => {
    const out = convertHistoryToOpenAI([], "hello", "be helpful");
    expect(out).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hello" },
    ]);
  });

  it("converts user text parts to a user message", () => {
    const out = convertHistoryToOpenAI(
      [{ role: "user", parts: [{ kind: "text", text: "find something" }] }],
      "next question",
      "sys",
    );
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ role: "user", content: "find something" });
    expect(out[2]).toEqual({ role: "user", content: "next question" });
  });

  it("converts user tool_result parts to tool messages", () => {
    const result: ToolResult = {
      kind: "search.results",
      query: "x",
      durationMs: 1,
      results: [],
    };
    const out = convertHistoryToOpenAI(
      [
        {
          role: "user",
          parts: [{ kind: "tool_result", toolCallId: "tc_1", result }],
        },
      ],
      "ok",
      "sys",
    );
    const toolMsg = out.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("tc_1");
    expect(toolMsg!.content).toBe(JSON.stringify(result));
  });

  it("converts assistant text + tool_use to proper OpenAI shape", () => {
    const out = convertHistoryToOpenAI(
      [
        {
          role: "assistant",
          parts: [
            { kind: "text", text: "let me search" },
            {
              kind: "tool_use",
              toolCallId: "tc_1",
              tool: "search_documents",
              args: { query: "x" },
            },
          ],
        },
      ],
      "ok",
      "sys",
    );
    const assistantMsg = out.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("let me search");
    expect(assistantMsg!.tool_calls).toEqual([
      {
        id: "tc_1",
        type: "function",
        function: {
          name: "search_documents",
          arguments: '{"query":"x"}',
        },
      },
    ]);
  });

  it("replays a tool_use part's extraContent as extra_content across turns", () => {
    const sig = { google: { thought_signature: "c2lnbmF0dXJl" } };
    const out = convertHistoryToOpenAI(
      [
        {
          role: "assistant",
          parts: [
            {
              kind: "tool_use",
              toolCallId: "tc_1",
              tool: "search_documents",
              args: { query: "x" },
              extraContent: sig,
            },
          ],
        },
      ],
      "ok",
      "sys",
    );
    const assistantMsg = out.find((m) => m.role === "assistant");
    expect(assistantMsg!.tool_calls).toHaveLength(1);
    expect(assistantMsg!.tool_calls![0].extra_content).toEqual(sig);
  });

  it("keeps per-call extraContent distinct when one turn has multiple tool calls", () => {
    const sigA = { google: { thought_signature: "QQ==" } };
    const sigB = { google: { thought_signature: "Qg==" } };
    const out = convertHistoryToOpenAI(
      [
        {
          role: "assistant",
          parts: [
            {
              kind: "tool_use",
              toolCallId: "tc_a",
              tool: "search_documents",
              args: {},
              extraContent: sigA,
            },
            { kind: "tool_use", toolCallId: "tc_b", tool: "search_documents", args: {} },
            {
              kind: "tool_use",
              toolCallId: "tc_c",
              tool: "search_documents",
              args: {},
              extraContent: sigB,
            },
          ],
        },
      ],
      "ok",
      "sys",
    );
    const calls = out.find((m) => m.role === "assistant")!.tool_calls!;
    expect(calls[0]!.extra_content).toEqual(sigA);
    expect("extra_content" in calls[1]!).toBe(false);
    expect(calls[2]!.extra_content).toEqual(sigB);
  });

  it("omits extra_content when a tool_use part has no extraContent", () => {
    const out = convertHistoryToOpenAI(
      [
        {
          role: "assistant",
          parts: [
            {
              kind: "tool_use",
              toolCallId: "tc_1",
              tool: "search_documents",
              args: { query: "x" },
            },
          ],
        },
      ],
      "ok",
      "sys",
    );
    const assistantMsg = out.find((m) => m.role === "assistant");
    expect("extra_content" in assistantMsg!.tool_calls![0]).toBe(false);
  });

  it("drops thinking parts from assistant messages", () => {
    const out = convertHistoryToOpenAI(
      [
        {
          role: "assistant",
          parts: [
            { kind: "thinking", text: "considering..." },
            { kind: "text", text: "here is my answer" },
          ],
        },
      ],
      "ok",
      "sys",
    );
    const assistantMsg = out.find((m) => m.role === "assistant");
    expect(assistantMsg!.content).toBe("here is my answer");
    expect(assistantMsg!.tool_calls).toBeUndefined();
  });

  it("sets assistant content to null when only tool_use parts are present", () => {
    const out = convertHistoryToOpenAI(
      [
        {
          role: "assistant",
          parts: [
            {
              kind: "tool_use",
              toolCallId: "tc_1",
              tool: "search_documents",
              args: { query: "x" },
            },
          ],
        },
      ],
      "ok",
      "sys",
    );
    const assistantMsg = out.find((m) => m.role === "assistant");
    expect(assistantMsg!.content).toBeNull();
    expect(assistantMsg!.tool_calls).toHaveLength(1);
  });

  it("round-trips a full text -> tool_use -> tool_result -> text history", () => {
    const result: ToolResult = {
      kind: "search.results",
      query: "x",
      durationMs: 1,
      results: [],
    };
    const out = convertHistoryToOpenAI(
      [
        { role: "user", parts: [{ kind: "text", text: "find x" }] },
        {
          role: "assistant",
          parts: [
            { kind: "text", text: "let me search" },
            {
              kind: "tool_use",
              toolCallId: "tc_1",
              tool: "search_documents",
              args: { query: "x" },
            },
          ],
        },
        {
          role: "user",
          parts: [{ kind: "tool_result", toolCallId: "tc_1", result }],
        },
        { role: "assistant", parts: [{ kind: "text", text: "found nothing" }] },
      ],
      "anything else?",
      "sys",
    );
    // system + user("find x") + assistant(text+tool) + tool_result + assistant(text) + user("anything else?")
    expect(out).toHaveLength(6);
    expect(out[0]!.role).toBe("system");
    expect(out[1]!.role).toBe("user");
    expect(out[2]!.role).toBe("assistant");
    expect(out[3]!.role).toBe("tool");
    expect(out[4]!.role).toBe("assistant");
    expect(out[5]!.role).toBe("user");
  });
});

describe("convertToolsToOpenAI", () => {
  it("converts tool handles to OpenAI function definitions", () => {
    const tools: ToolHandle[] = [
      {
        name: "search_documents",
        description: "Search the corpus",
        schema: z.object({
          query: z.string().describe("The search query"),
          limit: z.number().optional().describe("Max results"),
        }),
        async invoke() {
          return { kind: "search.results", query: "", durationMs: 0, results: [] };
        },
      },
    ];
    const out = convertToolsToOpenAI(tools);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("function");
    expect(out[0]!.function.name).toBe("search_documents");
    expect(out[0]!.function.description).toBe("Search the corpus");
    expect(out[0]!.function.parameters).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "number", description: "Max results" },
      },
      required: ["query"],
    });
  });

  it("returns empty array for no tools", () => {
    expect(convertToolsToOpenAI([])).toEqual([]);
  });
});

describe("HttpChatBackend", () => {
  it("translates a text-only SSE stream into agent.text.delta + agent.message.end", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(mockFetchResponse(sseBody(textOnlySSE(["Hello, ", "world."]))));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test-model" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    expect(events.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.text.delta",
      "agent.text.delta",
      "agent.usage.update",
      "agent.message.end",
    ]);

    const deltas = events
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => (e as Extract<AgentEvent, { type: "agent.text.delta" }>).payload.delta);
    expect(deltas).toEqual(["Hello, ", "world."]);

    const end = events[events.length - 1]!;
    if (end.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.stopReason).toBe("end_turn");
    expect(end.payload.usage).toEqual({ inputTokens: 50, outputTokens: 20, cacheReadTokens: 0 });
  });

  it("reports one llmProbe timing per request with tokens and TTFT", async () => {
    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "q",
      durationMs: 0,
      results: [],
    }));
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      // First request ends in a tool call, the second in text.
      if (callCount === 1)
        return Promise.resolve(
          mockFetchResponse(sseBody(toolUseSSE("call_1", "search_documents", { query: "q" }))),
        );
      return Promise.resolve(mockFetchResponse(sseBody(textOnlySSE(["done"]))));
    });

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const timings: Array<{
      requestIndex: number;
      ttftMs: number | null;
      wallMs: number;
      inputTokens?: number;
      outputTokens?: number;
    }> = [];
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(
      baseInput({ tools: [tool], llmProbe: (timing) => timings.push(timing) }),
    )) {
      events.push(e);
    }

    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.stopReason).toBe("end_turn");
    // One span per model request: the tool-use round, then the text round.
    expect(timings.map((timing) => timing.requestIndex)).toEqual([1, 2]);
    expect(timings[0]).toMatchObject({ inputTokens: 30, outputTokens: 15 });
    expect(timings[1]).toMatchObject({ inputTokens: 50, outputTokens: 20 });
    for (const timing of timings) {
      expect(timing.ttftMs).not.toBeNull();
      expect(timing.wallMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("emits no llmProbe timings when no probe is installed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(textOnlySSE(["hi"]))));
    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    // Absence of llmProbe must not change the event stream.
    for await (const e of backend.runTurn(baseInput())) events.push(e);
    expect(events.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.text.delta",
      "agent.usage.update",
      "agent.message.end",
    ]);
  });

  it("splits prompt-cache-hit tokens out of input (DeepSeek convention)", async () => {
    // prompt_tokens is the TOTAL input; prompt_cache_hit_tokens is the cached subset.
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(
        sseBody([
          {
            choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5000, completion_tokens: 40, prompt_cache_hit_tokens: 4600 },
          },
          "[DONE]",
        ]),
      ),
    );
    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test-model" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    // fresh input = 5000 - 4600 = 400; cached = 4600.
    expect(end.payload.usage).toEqual({
      inputTokens: 400,
      outputTokens: 40,
      cacheReadTokens: 4600,
    });
  });

  it("reads OpenAI-style cached_tokens from prompt_tokens_details", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(
        sseBody([
          {
            choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 3000,
              completion_tokens: 10,
              prompt_tokens_details: { cached_tokens: 2500 },
            },
          },
          "[DONE]",
        ]),
      ),
    );
    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test-model" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.usage).toEqual({
      inputTokens: 500,
      outputTokens: 10,
      cacheReadTokens: 2500,
    });
  });

  it("reads Moonshot/Kimi-style top-level cached_tokens", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(
        sseBody([
          {
            choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2000, completion_tokens: 8, cached_tokens: 1500 },
          },
          "[DONE]",
        ]),
      ),
    );
    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test-model" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.usage).toEqual({
      inputTokens: 500,
      outputTokens: 8,
      cacheReadTokens: 1500,
    });
  });

  it("prefers prompt_cache_hit_tokens when a provider sends more than one convention", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(
        sseBody([
          {
            choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 5,
              prompt_cache_hit_tokens: 700,
              prompt_tokens_details: { cached_tokens: 100 },
            },
          },
          "[DONE]",
        ]),
      ),
    );
    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test-model" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.usage).toEqual({
      inputTokens: 300,
      outputTokens: 5,
      cacheReadTokens: 700,
    });
  });

  it("accumulates usage (incl. cache hits) across tool-loop iterations", async () => {
    // Iteration 1 (tool call): 1000 total input of which 800 cached.
    // Iteration 2 (final text): 1200 total input of which 1100 cached —
    // the growth pattern a within-run prefix cache produces.
    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "q",
      durationMs: 0,
      results: [],
    }));
    const toolChunks = toolUseSSE("call_1", "search_documents", { query: "q" });
    // Replace the helper's flat usage with a cache-carrying one.
    toolChunks[2] = {
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1000, completion_tokens: 15, prompt_cache_hit_tokens: 800 },
    };
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(mockFetchResponse(sseBody(toolChunks)));
      return Promise.resolve(
        mockFetchResponse(
          sseBody([
            {
              choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1200, completion_tokens: 20, prompt_cache_hit_tokens: 1100 },
            },
            "[DONE]",
          ]),
        ),
      );
    });

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.usage).toEqual({
      inputTokens: 300, // (1000-800) + (1200-1100)
      outputTokens: 35,
      cacheReadTokens: 1900,
    });
  });

  it("streams batch child progress and provider usage before the terminal tool result", async () => {
    const batchTool: ToolHandle = {
      name: "search_many",
      description: "mock batch search",
      schema: z.object({ queries: z.array(z.string()) }),
      async invoke(_args, ctx) {
        ctx.onChildStart?.({ index: 0, tool: "search_documents", argsSummary: "ledger" });
        ctx.onChildResult?.({
          index: 0,
          result: {
            kind: "search.results",
            query: "ledger",
            durationMs: 1,
            results: [{ documentId: "d1", title: "Ledger", sourceId: "drive:acct" }],
          },
        });
        return { kind: "search.batch", items: [] };
      },
    };
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockFetchResponse(sseBody(toolUseSSE("call_1", "search_many", { queries: ["ledger"] }))),
        );
      }
      return Promise.resolve(mockFetchResponse(sseBody(textOnlySSE(["done"]))));
    });

    const events: AgentEvent[] = [];
    for await (const event of new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test",
    }).runTurn(baseInput({ tools: [batchTool] }))) {
      events.push(event);
    }
    const types = events.map((event) => event.type);
    expect(types.indexOf("agent.usage.update")).toBeGreaterThan(-1);
    expect(types.indexOf("agent.tool.child.start")).toBeGreaterThan(
      types.indexOf("agent.tool.start"),
    );
    expect(types.indexOf("agent.tool.child.result")).toBeGreaterThan(
      types.indexOf("agent.tool.child.start"),
    );
    expect(types.indexOf("agent.tool.result")).toBeGreaterThan(
      types.indexOf("agent.tool.child.result"),
    );
  });

  // A backend builds the ToolContext for every call the model makes, so it is
  // the seam where the caller's zone either reaches a time-aware tool or is
  // silently dropped — with no type error and no visible symptom until an
  // answer comes back an hour out.
  it("puts the turn's time zone on the ToolContext it builds", async () => {
    const seen: Array<string | undefined> = [];
    const zoneProbe: ToolHandle = {
      name: "zone_probe",
      description: "records the zone its context carried",
      schema: z.object({}),
      async invoke(_args, ctx) {
        seen.push(ctx.timeZone);
        return { kind: "text", text: "ok" };
      },
    };
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(mockFetchResponse(sseBody(toolUseSSE("call_1", "zone_probe", {}))));
      }
      return Promise.resolve(mockFetchResponse(sseBody(textOnlySSE(["done"]))));
    });

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    for await (const _ of backend.runTurn(
      baseInput({ tools: [zoneProbe], timeZone: "Asia/Tokyo" }),
    )) {
      // drain
    }

    expect(seen).toEqual(["Asia/Tokyo"]);
  });

  it("surfaces an empty successful SSE response as agent.error + clean end", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(
        sseBody([
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 0 },
          },
          "[DONE]",
        ]),
      ),
    );

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test-model" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    expect(events.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.usage.update",
      "agent.error",
      "agent.message.end",
    ]);
    const err = events.find((e) => e.type === "agent.error");
    if (err && err.type === "agent.error") {
      expect(err.payload.code).toBe("http_empty_response");
      expect(err.payload.message).toBe("Model returned an empty response (finish_reason=stop).");
    }
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.stopReason).toBe("error");
    expect(end.payload.usage).toEqual({ inputTokens: 12, outputTokens: 0, cacheReadTokens: 0 });
  });

  it("retries one empty length SSE response with a larger output budget", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse(
          sseBody([
            {
              choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: "length" }],
              usage: { prompt_tokens: 12, completion_tokens: 4096 },
            },
            "[DONE]",
          ]),
        ),
      )
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["recovered answer"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test-model",
      maxToolIterations: 1,
    });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const first = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    const second = JSON.parse((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(first.max_tokens).toBe(4096);
    // The dedicated reasoning field identifies an unconfigured reasoner, so
    // its one recovery attempt gets the reasoning-sized budget.
    expect(second.max_tokens).toBe(32768);
    expect(timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([120_000, 600_000]);
    expect(events.some((event) => event.type === "agent.error")).toBe(false);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.stopReason).toBe("end_turn");
    expect(end.payload.usage).toEqual({ inputTokens: 62, outputTokens: 4116, cacheReadTokens: 0 });
  });

  it("does not retry an output-limited response that contains a valid tool call", async () => {
    const toolResponse = toolUseSSE("call_1", "search_documents", { query: "x" });
    const finish = toolResponse[2] as { choices: Array<{ finish_reason: string }> };
    finish.choices[0]!.finish_reason = "length";
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(mockFetchResponse(sseBody(toolResponse)))
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["done"]))));
    globalThis.fetch = fetchSpy;
    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "x",
      durationMs: 0,
      results: [],
    }));
    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });

    const events: AgentEvent[] = [];
    for await (const event of backend.runTurn(baseInput({ tools: [tool] }))) events.push(event);

    const bodies = fetchSpy.mock.calls.map((call) =>
      JSON.parse((call as [string, RequestInit])[1].body as string),
    );
    expect(bodies.map((body) => body.max_tokens)).toEqual([4_096, 4_096]);
    expect(events.some((event) => event.type === "agent.tool.result")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "end_turn" },
    });
  });

  it("fails after a second empty length response instead of retrying unboundedly", async () => {
    const emptyLength = () =>
      mockFetchResponse(
        sseBody([
          {
            choices: [{ delta: {}, finish_reason: "length" }],
            usage: { prompt_tokens: 12, completion_tokens: 4096 },
          },
          "[DONE]",
        ]),
      );
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(emptyLength())
      .mockResolvedValueOnce(emptyLength());
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test-model" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.type === "agent.error")).toBe(false);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.stopReason).toBe("max_tokens");
    expect(end.payload.usage).toEqual({ inputTokens: 24, outputTokens: 8192, cacheReadTokens: 0 });
    expect(end.payload.failure).toMatchObject({ code: "output_truncated", retryable: false });
    expect(end.payload.context?.reservedOutputTokens).toBe(32_768);
  });

  it("remembers exposed reasoning and starts the next turn at 16K", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse(
          sseBody([
            {
              choices: [
                {
                  delta: { reasoning_content: "thinking", content: "first answer" },
                  finish_reason: "stop",
                },
              ],
            },
            "[DONE]",
          ]),
        ),
      )
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["finished"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "reasoning-model",
    });
    for await (const _ of backend.runTurn(baseInput())) {
      // drain first turn
    }
    for await (const _ of backend.runTurn(baseInput({ messageId: "m2" }))) {
      // drain second turn
    }

    const bodies = fetchSpy.mock.calls.map((call) =>
      JSON.parse((call as [string, RequestInit])[1].body as string),
    );
    expect(bodies.map((body) => body.max_tokens)).toEqual([4096, 16_384]);
  });

  it("learns extended output from provider-reported reasoning token usage", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse(
          sseBody([
            { choices: [{ delta: { content: "first answer" }, finish_reason: "stop" }] },
            {
              choices: [],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                completion_tokens_details: { reasoning_tokens: 12 },
              },
            },
            "[DONE]",
          ]),
        ),
      )
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["second answer"]))));
    globalThis.fetch = fetchSpy;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "reasoning-model",
    });

    for await (const _ of backend.runTurn(baseInput())) {
      // observe provider-reported reasoning usage
    }
    for await (const _ of backend.runTurn(baseInput({ messageId: "m2" }))) {
      // drain the next turn
    }

    const bodies = fetchSpy.mock.calls.map((call) =>
      JSON.parse((call as [string, RequestInit])[1].body as string),
    );
    expect(bodies.map((body) => body.max_tokens)).toEqual([4096, 16_384]);
  });

  it("never lowers an explicitly configured output allowance after observation", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse(
          sseBody([
            {
              choices: [
                {
                  delta: { reasoning_content: "thinking", content: "first answer" },
                  finish_reason: "stop",
                },
              ],
            },
            "[DONE]",
          ]),
        ),
      )
      .mockResolvedValue(
        mockFetchResponse(
          sseBody([{ choices: [{ delta: {}, finish_reason: "length" }] }, "[DONE]"]),
        ),
      );
    globalThis.fetch = fetchSpy;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "reasoning-model",
      modelLimits: { maxOutputTokens: 20_000 },
    });
    for await (const _ of backend.runTurn(baseInput())) {
      // learn from first turn
    }
    for await (const _ of backend.runTurn(baseInput({ messageId: "m2" }))) {
      // drain truncated second turn
    }
    const bodies = fetchSpy.mock.calls.map((call) =>
      JSON.parse((call as [string, RequestInit])[1].body as string),
    );
    expect(bodies.map((body) => body.max_tokens)).toEqual([20_000, 20_000]);
  });

  it("sends the correct request body to the endpoint", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(textOnlySSE(["ok"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "Qwen/Qwen3-32B",
    });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ systemPrompt: "be helpful" }))) {
      events.push(e);
    }

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8000/v1/chat/completions");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe("Qwen/Qwen3-32B");
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: "system", content: "be helpful" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(body.tools).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("uses a configured output-token cap", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(textOnlySSE(["ok"]))));
    globalThis.fetch = fetchSpy;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test",
      modelLimits: { maxOutputTokens: 777 },
    });
    for await (const _ of backend.runTurn(baseInput())) {
      // drain
    }
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.max_tokens).toBe(777);
  });

  it("includes tools in the request body when provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(textOnlySSE(["ok"]))));
    globalThis.fetch = fetchSpy;

    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "x",
      durationMs: 0,
      results: [],
    }));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    for await (const _ of backend.runTurn(baseInput({ tools: [tool] }))) {
      /* drain */
    }

    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("search_documents");
  });

  it("requests usage in the stream via stream_options", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(textOnlySSE(["ok"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    for await (const _ of backend.runTurn(baseInput())) {
      /* drain */
    }

    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("preserves a tool call's extra_content (Gemini thought_signature) on the follow-up request", async () => {
    const sig = { google: { thought_signature: "c2lnbmF0dXJl" } };
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockFetchResponse(
            sseBody([
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          function: { name: "search_documents", arguments: '{"query":"x"}' },
                          extra_content: sig,
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              "[DONE]",
            ]),
          ),
        );
      }
      return Promise.resolve(mockFetchResponse(sseBody(textOnlySSE(["done"]))));
    });

    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "x",
      durationMs: 0,
      results: [],
    }));
    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "gemini-x" });
    for await (const _ of backend.runTurn(baseInput({ tools: [tool] }))) {
      /* drain */
    }

    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string,
    );
    const assistantMsg = secondBody.messages.find(
      (m: Record<string, unknown>) => m.role === "assistant" && m.tool_calls,
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.tool_calls[0].extra_content).toEqual(sig);
  });

  it("omits extra_content on the follow-up request when the provider sends none", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockFetchResponse(sseBody(toolUseSSE("call_1", "search_documents", { query: "x" }))),
        );
      }
      return Promise.resolve(mockFetchResponse(sseBody(textOnlySSE(["done"]))));
    });

    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "x",
      durationMs: 0,
      results: [],
    }));
    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    for await (const _ of backend.runTurn(baseInput({ tools: [tool] }))) {
      /* drain */
    }

    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;
    const secondBody = JSON.parse(
      (fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string,
    );
    const assistantMsg = secondBody.messages.find(
      (m: Record<string, unknown>) => m.role === "assistant" && m.tool_calls,
    );
    expect(assistantMsg).toBeDefined();
    expect("extra_content" in assistantMsg.tool_calls[0]).toBe(false);
  });

  it("runs the tool-use loop: invoke handle, feed result back, get final text", async () => {
    const toolResult: ToolResult = {
      kind: "search.results",
      query: "test",
      durationMs: 11,
      results: [{ documentId: "d1", sourceType: "gmail", sourceId: "gmail:me", title: "hi" }],
    };
    let invokedWith: unknown;
    const tool = fakeToolHandle("search_documents", (args) => {
      invokedWith = args;
      return toolResult;
    });

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockFetchResponse(sseBody(toolUseSSE("call_1", "search_documents", { query: "test" }))),
        );
      }
      return Promise.resolve(mockFetchResponse(sseBody(textOnlySSE(["I found one result."]))));
    });

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);

    expect(events.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.tool.input_start",
      "agent.usage.update",
      "agent.tool.start",
      "agent.tool.result",
      "agent.text.delta",
      "agent.usage.update",
      "agent.message.end",
    ]);

    expect(invokedWith).toEqual({ query: "test" });

    // Verify the second fetch call includes the tool result.
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string,
    );
    const toolMsg = secondBody.messages.find((m: Record<string, unknown>) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(JSON.parse(toolMsg.content as string)).toEqual(toolResult);
  });

  it("emits an error tool-result when the model calls an unknown tool", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          mockFetchResponse(sseBody(toolUseSSE("call_1", "nonexistent_tool", { x: 1 }))),
        );
      }
      return Promise.resolve(mockFetchResponse(sseBody(textOnlySSE(["sorry"]))));
    });

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    const toolResultEvt = events.find((e) => e.type === "agent.tool.result");
    expect(toolResultEvt).toBeDefined();
    if (toolResultEvt && toolResultEvt.type === "agent.tool.result") {
      expect(toolResultEvt.payload.result.kind).toBe("error");
      if (toolResultEvt.payload.result.kind === "error") {
        expect(toolResultEvt.payload.result.code).toBe("unknown_tool");
      }
    }
  });

  it("surfaces a fetch rejection as agent.error + clean end", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    const types = events.map((e) => e.type);
    expect(types).toContain("agent.error");
    expect(types[types.length - 1]).toBe("agent.message.end");
    const err = events.find((e) => e.type === "agent.error");
    if (err && err.type === "agent.error") {
      expect(err.payload.code).toBe("http_request_error");
      expect(err.payload.message).toBe("HTTP model request failed.");
      expect(err.payload.message).not.toContain("ECONNREFUSED");
    }
  });

  it("distinguishes the model request deadline from a connection failure", async () => {
    globalThis.fetch = vi.fn(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const requestSignal = init?.signal;
          if (requestSignal?.aborted) {
            reject(requestSignal.reason);
            return;
          }
          requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), {
            once: true,
          });
        }),
    );

    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test",
      timeoutMs: 5,
    });
    const events: AgentEvent[] = [];
    for await (const event of backend.runTurn(baseInput())) events.push(event);

    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: {
        stopReason: "error",
        failure: { code: "http_request_timeout", retryable: true },
      },
    });
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

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const event of backend.runTurn(baseInput(), controller.signal)) events.push(event);

    expect(events.some((event) => event.type === "agent.error")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "canceled" },
    });
  });

  it("reports cancellation while a response stream is open without an agent error", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: null }] })}\n\n`,
            ),
          );
          init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), {
            once: true,
          });
          queueMicrotask(() => controller.abort());
        },
      });
      return Promise.resolve(mockFetchResponse(body));
    });

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const event of backend.runTurn(baseInput(), controller.signal)) events.push(event);

    expect(events.some((event) => event.type === "agent.error")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "canceled" },
    });
  });

  it("types a deadline that expires after streaming headers arrive", async () => {
    globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return Promise.resolve(mockFetchResponse(body));
    });
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test",
      timeoutMs: 5,
    });
    const events: AgentEvent[] = [];
    for await (const event of backend.runTurn(baseInput())) events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { failure: { code: "http_request_timeout" } },
    });
  });

  it("types deadlines while reading non-streamed and rejected response bodies", async () => {
    for (const stalledStatus of [200, 503]) {
      globalThis.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { stream?: boolean };
        if (stalledStatus === 200 && request.stream) {
          return Promise.resolve(new Response("{}", { status: 400 }));
        }
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), {
              once: true,
            });
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: stalledStatus,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });
      const backend = new HttpChatBackend({
        baseUrl: "http://localhost:8000",
        model: "test",
        timeoutMs: 5,
      });
      const events: AgentEvent[] = [];
      for await (const event of backend.runTurn(baseInput())) events.push(event);
      expect(events.at(-1)).toMatchObject({
        type: "agent.message.end",
        payload: { failure: { code: "http_request_timeout" } },
      });
    }
  });

  it("surfaces a non-200 response as agent.error + clean end", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    const run = (async () => {
      for await (const e of backend.runTurn(baseInput())) events.push(e);
    })();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(3_000);
    await run;

    const err = events.find((e) => e.type === "agent.error");
    expect(err).toBeDefined();
    if (err && err.type === "agent.error") {
      expect(err.payload.code).toBe("http_api_error");
      expect(err.payload.message).toMatch(/429/);
      expect(err.payload.message).toContain("rate-limited");
    }
    const end = events[events.length - 1]!;
    expect(end.type).toBe("agent.message.end");
    // The status travels with the terminal failure so a caller can tell a rate
    // limit from a dead model without parsing the sentence.
    if (end.type === "agent.message.end") {
      expect(end.payload.failure?.provider).toEqual({ status: 429 });
    }
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  describe("rate-limit patience", () => {
    const quotaExceeded = (): Response =>
      new Response(JSON.stringify({ error: { message: "quota", code: "token_quota_exceeded" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      });

    it("fails fast on a minute-long quota reset by default", async () => {
      globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(quotaExceeded()));
      const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
      const events: AgentEvent[] = [];
      for await (const e of backend.runTurn(baseInput())) events.push(e);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({
        type: "agent.message.end",
        payload: { stopReason: "error", failure: { provider: { status: 429 } } },
      });
    });

    it("waits out a minute-long quota reset when the turn is patient", async () => {
      vi.useFakeTimers();
      const responses = [quotaExceeded(), mockFetchResponse(sseBody(textOnlySSE(["done"])))];
      globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!));
      const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
      const events: AgentEvent[] = [];
      const run = (async () => {
        for await (const e of backend.runTurn(
          baseInput({ rateLimitPatience: BACKGROUND_RATE_LIMIT_PATIENCE }),
        )) {
          events.push(e);
        }
      })();

      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(59_000);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(7_000);
      await run;

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(events.at(-1)).toMatchObject({
        type: "agent.message.end",
        payload: { stopReason: "end_turn" },
      });
    });

    it("fails a patient turn at once when the reset is beyond its patience", async () => {
      globalThis.fetch = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            new Response("limited", { status: 429, headers: { "Retry-After": "3600" } }),
          ),
        );
      const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
      const events: AgentEvent[] = [];
      for await (const e of backend.runTurn(
        baseInput({ rateLimitPatience: BACKGROUND_RATE_LIMIT_PATIENCE }),
      )) {
        events.push(e);
      }

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({
        type: "agent.message.end",
        payload: { stopReason: "error", failure: { provider: { status: 429 } } },
      });
    });

    it("ends a patient turn promptly when it is cancelled mid-wait", async () => {
      vi.useFakeTimers();
      globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(quotaExceeded()));
      const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const run = (async () => {
        for await (const e of backend.runTurn(
          baseInput({ rateLimitPatience: BACKGROUND_RATE_LIMIT_PATIENCE }),
          controller.signal,
        )) {
          events.push(e);
        }
      })();

      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5_000);
      controller.abort();
      await run;

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({
        type: "agent.message.end",
        payload: { stopReason: "canceled" },
      });
    });

    it("gives the retried request its own response deadline", async () => {
      // The rate-limit wait (about a second) outlasts the whole response
      // deadline, so a deadline shared across attempts would expire mid-wait.
      const responses = [
        new Response("limited", { status: 429 }),
        mockFetchResponse(sseBody(textOnlySSE(["done"]))),
      ];
      globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!));
      const backend = new HttpChatBackend({
        baseUrl: "http://localhost:8000",
        model: "test",
        timeoutMs: 300,
      });
      const events: AgentEvent[] = [];
      for await (const e of backend.runTurn(baseInput({ rateLimitPatience: { maxAttempts: 2 } }))) {
        events.push(e);
      }

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(events.at(-1)).toMatchObject({
        type: "agent.message.end",
        payload: { stopReason: "end_turn" },
      });
    });
  });

  it("surfaces the structured error message from an OpenAI-style error body", async () => {
    const body = JSON.stringify({
      error: {
        message: "This is not a chat model. Did you mean to use v1/completions?",
        type: "invalid_request_error",
        param: "model",
        code: null,
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 404 }));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    const err = events.find((e) => e.type === "agent.error");
    expect(err).toBeDefined();
    if (err && err.type === "agent.error") {
      expect(err.payload.code).toBe("http_protocol_mismatch");
      expect(err.payload.message).toBe("The selected model requires the Responses API.");
      expect(err.payload.message).not.toContain("Did you mean");
    }
    expect(events[events.length - 1]!.type).toBe("agent.message.end");
  });

  it("falls back to the raw body when an error response isn't JSON", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("upstream gateway timeout", { status: 504 }));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    const err = events.find((e) => e.type === "agent.error");
    expect(err).toBeDefined();
    if (err && err.type === "agent.error") {
      expect(err.payload.code).toBe("http_api_error");
      expect(err.payload.message).toBe(
        "The model provider failed while handling the request (HTTP 504).",
      );
      expect(err.payload.message).not.toContain("upstream gateway timeout");
    }
  });

  it("never quotes the unparseable body, whose bytes are the model's own answer", async () => {
    // The runtime's own parse error embeds an excerpt of the offending input.
    // That input is corpus-derived, and this message reaches external callers
    // and the voice surfaces, so the condition is reported without it.
    // Sits at the parse offence so it lands inside the excerpt the runtime
    // quotes, rather than just outside its window.
    const answerFragment = "payroll was approved";
    const verifyErr = () =>
      jsonResponse({ error: { message: "must be verified to stream this model" } }, 400);
    // Malformed on purpose: the unquoted value makes JSON.parse throw, and the
    // runtime's message quotes the bytes around the offence.
    const truncated = new Response(`{"choices":[{"message":{"content": ${answerFragment}}}]}`, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(verifyErr())
      .mockResolvedValueOnce(verifyErr())
      .mockResolvedValueOnce(truncated);

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    const err = events.find((e) => e.type === "agent.error");
    expect(err).toBeDefined();
    if (err && err.type === "agent.error") {
      expect(err.payload.code).toBe("http_stream_error");
      expect(err.payload.message).toBe("The model returned a response Omnesis could not parse.");
    }
    expect(JSON.stringify(events)).not.toContain("payroll");
  });

  it("truncates a very long error body to keep the transcript bounded", async () => {
    const body = "x".repeat(2000);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 502 }));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    const err = events.find((e) => e.type === "agent.error");
    expect(err).toBeDefined();
    if (err && err.type === "agent.error") {
      expect(err.payload.message).toBe(
        "The model provider failed while handling the request (HTTP 502).",
      );
      expect(err.payload.message).not.toContain("xxx");
    }
  });

  it("hits the iteration cap when the model loops on tool_calls", async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          mockFetchResponse(sseBody(toolUseSSE("call_n", "search_documents", { query: "x" }))),
        ),
      );

    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "x",
      durationMs: 0,
      results: [],
    }));

    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test",
      maxToolIterations: 2,
    });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);

    const error = events.find((e) => e.type === "agent.error");
    expect(error).toBeDefined();
    if (error && error.type === "agent.error") {
      expect(error.payload.code).toBe("tool_iteration_cap");
    }
    const end = events[events.length - 1]!;
    if (end.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.stopReason).toBe("error");
  });

  it("maps finish_reason 'length' to stopReason 'max_tokens'", async () => {
    const chunks: Array<Record<string, unknown> | "[DONE]"> = [
      { choices: [{ delta: { content: "trunca" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 100, completion_tokens: 4096 },
      },
      "[DONE]",
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(chunks)));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    const end = events.find((e) => e.type === "agent.message.end");
    expect(end).toBeDefined();
    if (end && end.type === "agent.message.end") {
      expect(end.payload.stopReason).toBe("max_tokens");
      expect(end.payload.failure).toMatchObject({
        code: "output_truncated",
        retryable: false,
      });
    }
  });

  it("sends Authorization header when apiKey is provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(textOnlySSE(["ok"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test",
      apiKey: "sk-test-key-123",
    });
    for await (const _ of backend.runTurn(baseInput())) {
      /* drain */
    }

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test-key-123");
  });

  it("does not send Authorization header when apiKey is omitted", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(textOnlySSE(["ok"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test",
    });
    for await (const _ of backend.runTurn(baseInput())) {
      /* drain */
    }

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("strips trailing slashes from baseUrl", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(textOnlySSE(["ok"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000///",
      model: "test",
    });
    for await (const _ of backend.runTurn(baseInput())) {
      /* drain */
    }

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8000/v1/chat/completions");
  });

  it("honors a custom apiPathPrefix in the endpoint URL", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(textOnlySSE(["ok"]))));
    globalThis.fetch = fetchSpy;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:18085",
      apiPathPrefix: "/v1beta/openai",
      model: "gemini-2.5-flash",
    });
    for await (const _ of backend.runTurn(baseInput())) {
      /* drain */
    }
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:18085/v1beta/openai/chat/completions");
  });
});

describe("HttpChatBackend — tool-call argument robustness", () => {
  /** Encode pre-rendered SSE lines verbatim (lets a test send a broken frame). */
  function rawSSEBody(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
  }

  /** One streamed tool call carrying `argsStr` verbatim, ending in `finishReason`. */
  function rawArgsToolCallSSE(
    argsStr: string,
    finishReason: string,
  ): Array<Record<string, unknown> | "[DONE]"> {
    return [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "search_documents", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: argsStr } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: finishReason }],
        usage: { prompt_tokens: 30, completion_tokens: 15 },
      },
      "[DONE]",
    ];
  }

  it("returns tool_args_unparseable instead of invoking when arguments are malformed", async () => {
    const truncated = '{"query":"unfini';
    let invoked = false;
    const tool = fakeToolHandle("search_documents", () => {
      invoked = true;
      return { kind: "search.results", query: "x", durationMs: 0, results: [] };
    });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse(sseBody(rawArgsToolCallSSE(truncated, "tool_calls"))),
      )
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["understood"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);

    expect(invoked).toBe(false);
    const start = events.find((e) => e.type === "agent.tool.start");
    if (start?.type !== "agent.tool.start") throw new Error("expected tool.start");
    expect(start.payload.args).toEqual({});
    const resultEvt = events.find((e) => e.type === "agent.tool.result");
    if (resultEvt?.type !== "agent.tool.result") throw new Error("expected tool.result");
    const result = resultEvt.payload.result;
    if (result.kind !== "error") throw new Error("expected error result");
    expect(result.code).toBe("tool_args_unparseable");
    expect(result.message).toContain("not valid JSON");
    expect(result.message).toContain(truncated);

    // The fabricated error flows back to the model as an ordinary tool
    // message, and a non-length finish leaves the output budget alone.
    const bodies = fetchSpy.mock.calls.map((call) =>
      JSON.parse((call as [string, RequestInit])[1].body as string),
    );
    expect(bodies.map((body) => body.max_tokens)).toEqual([4096, 4096]);
    const toolMsg = bodies[1].messages.find((m: Record<string, unknown>) => m.role === "tool");
    expect(toolMsg.content).toContain("tool_args_unparseable");
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.stopReason).toBe("end_turn");
  });

  it("answers a length-truncated call with an error result and raises the budget for the next request", async () => {
    const invocations: unknown[] = [];
    const tool = fakeToolHandle("search_documents", (args) => {
      invocations.push(args);
      return { kind: "search.results", query: "test", durationMs: 0, results: [] };
    });
    // First response: visible prose, then a tool call cut mid-arguments by
    // the output budget (finish_reason=length).
    const truncatedResponse: Array<Record<string, unknown> | "[DONE]"> = [
      { choices: [{ delta: { content: "Checking the index." }, finish_reason: null }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "search_documents", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"te' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 30, completion_tokens: 15 },
      },
      "[DONE]",
    ];
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(mockFetchResponse(sseBody(truncatedResponse)))
      .mockResolvedValueOnce(
        mockFetchResponse(sseBody(toolUseSSE("call_2", "search_documents", { query: "test" }))),
      )
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["done"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const bodies = fetchSpy.mock.calls.map((call) =>
      JSON.parse((call as [string, RequestInit])[1].body as string),
    );
    // The raised budget arms the request AFTER the truncated response — the
    // truncated response itself is never re-requested.
    expect(bodies.map((body) => body.max_tokens)).toEqual([4096, 32768, 4096]);
    // The truncated call is answered with an error result, never invoked;
    // the re-issued call is the only invocation.
    const unparseableEvents = events.filter(
      (e) =>
        e.type === "agent.tool.result" &&
        e.payload.result.kind === "error" &&
        e.payload.result.code === "tool_args_unparseable",
    );
    expect(unparseableEvents).toHaveLength(1);
    const unparseable = unparseableEvents[0]!;
    if (unparseable.type !== "agent.tool.result") throw new Error("expected tool.result");
    expect(unparseable.payload.toolCallId).toBe("call_1");
    expect(invocations).toEqual([{ query: "test" }]);
    // The already-streamed prose stands and is not duplicated.
    const proseDeltas = events.filter(
      (e) => e.type === "agent.text.delta" && e.payload.delta === "Checking the index.",
    );
    expect(proseDeltas).toHaveLength(1);
    // The second request extends history with the truncated call and its
    // fabricated tool error — it is not a replay of the first.
    const toolMsg = bodies[1].messages.find((m: Record<string, unknown>) => m.role === "tool");
    expect(toolMsg.content).toContain("tool_args_unparseable");
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.stopReason).toBe("end_turn");
  });

  it("raises the budget only once when truncation repeats", async () => {
    let invoked = false;
    const tool = fakeToolHandle("search_documents", () => {
      invoked = true;
      return { kind: "search.results", query: "x", durationMs: 0, results: [] };
    });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse(sseBody(rawArgsToolCallSSE('{"query":"te', "length"))),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(sseBody(rawArgsToolCallSSE('{"query":"tr', "length"))),
      )
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["giving up"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const bodies = fetchSpy.mock.calls.map((call) =>
      JSON.parse((call as [string, RequestInit])[1].body as string),
    );
    // The one-shot flag is spent on the first truncation; the second no
    // longer raises the budget.
    expect(bodies.map((body) => body.max_tokens)).toEqual([4096, 32768, 4096]);
    expect(invoked).toBe(false);
    // Each truncated call is answered with its own error result.
    const unparseableEvents = events.filter(
      (e) =>
        e.type === "agent.tool.result" &&
        e.payload.result.kind === "error" &&
        e.payload.result.code === "tool_args_unparseable",
    );
    expect(unparseableEvents).toHaveLength(2);
  });

  it("still invokes a no-argument tool when the arguments string is empty", async () => {
    let invokedWith: unknown = "never";
    const tool = fakeToolHandle("search_documents", (args) => {
      invokedWith = args;
      return { kind: "search.results", query: "", durationMs: 0, results: [] };
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(mockFetchResponse(sseBody(rawArgsToolCallSSE("", "tool_calls"))))
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["ok"]))));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    for await (const _ of backend.runTurn(baseInput({ tools: [tool] }))) {
      /* drain */
    }

    expect(invokedWith).toEqual({});
  });

  it("returns an error result when a dropped SSE frame leaves the argument buffer unparseable", async () => {
    let invoked = false;
    const tool = fakeToolHandle("search_documents", () => {
      invoked = true;
      return { kind: "search.results", query: "x", durationMs: 0, results: [] };
    });
    const firstFrame = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "search_documents", arguments: '{"query":"a' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const finishFrame = { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse(
          rawSSEBody([
            `data: ${JSON.stringify(firstFrame)}\n\n`,
            // A corrupted frame the SSE parser drops — the argument deltas it
            // carried never reach the accumulator.
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":\n\n`,
            `data: ${JSON.stringify(finishFrame)}\n\n`,
            "data: [DONE]\n\n",
          ]),
        ),
      )
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["recovered"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "test" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);

    expect(invoked).toBe(false);
    const resultEvt = events.find((e) => e.type === "agent.tool.result");
    if (resultEvt?.type !== "agent.tool.result") throw new Error("expected tool.result");
    const result = resultEvt.payload.result;
    if (result.kind !== "error") throw new Error("expected error result");
    expect(result.code).toBe("tool_args_unparseable");
    expect(result.message).toContain('{"query":"a');
  });
});

describe("HttpChatBackend — resilience ladder", () => {
  it("switches output-limit fields only after a precise unsupported-parameter response", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              type: "invalid_request_error",
              code: "unsupported_parameter",
              param: "max_tokens",
              message: "unsupported parameter: max_tokens",
            },
          },
          400,
        ),
      )
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["first"]))))
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["second"]))));
    globalThis.fetch = fetchSpy;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "reasoning-model",
    });

    for await (const _ of backend.runTurn(baseInput())) {
      // drain
    }
    for await (const _ of backend.runTurn(baseInput({ messageId: "M2" }))) {
      // drain
    }

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const bodies = fetchSpy.mock.calls.map((call) =>
      JSON.parse((call as [string, RequestInit])[1].body as string),
    );
    expect(bodies[0]).toMatchObject({ max_tokens: 4096 });
    expect(bodies[1]).toMatchObject({ max_completion_tokens: 4096 });
    expect(bodies[2]).toMatchObject({ max_completion_tokens: 4096 });
    expect(bodies[1].max_tokens).toBeUndefined();
    expect(bodies[2].max_tokens).toBeUndefined();
  });

  it("does not negotiate output fields from an ordinary max_tokens validation error", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            type: "invalid_request_error",
            param: "max_tokens",
            message: "max_tokens must be positive",
          },
        },
        400,
      ),
    );
    globalThis.fetch = fetchSpy;

    const events: AgentEvent[] = [];
    for await (const event of new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test",
    }).runTurn(baseInput())) {
      events.push(event);
    }

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const call of fetchSpy.mock.calls) {
      const body = JSON.parse((call as [string, RequestInit])[1].body as string);
      expect(body.max_tokens).toBe(4096);
      expect(body.max_completion_tokens).toBeUndefined();
    }
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.failure?.code).toBe("http_api_error");
  });

  it("treats a context rejection as terminal without walking the request-shape ladder", async () => {
    const secret = "private echoed prompt";
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            type: "invalid_request_error",
            code: "context_length_exceeded",
            message: `maximum context length exceeded: ${secret}`,
          },
        },
        400,
      ),
    );
    globalThis.fetch = fetchSpy;

    const events: AgentEvent[] = [];
    for await (const event of new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test",
      modelLimits: { maxInputTokens: 4_096 },
    }).runTurn(baseInput())) {
      events.push(event);
    }

    expect(fetchSpy).toHaveBeenCalledOnce();
    const error = events.find((event) => event.type === "agent.error");
    if (error?.type !== "agent.error") throw new Error("expected agent error");
    expect(error.payload.code).toBe("context_window_exceeded");
    expect(error.payload.message).not.toContain(secret);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.failure).toMatchObject({
      code: "context_window_exceeded",
      retryable: false,
      backend: "http",
      model: "test",
    });
    expect(end.payload.context?.maxInputTokens).toBe(4_096);
    expect(end.payload.context?.contextWindowTokens).toBeUndefined();
  });

  it("clears stale current input when a later tool iteration fails before reporting usage", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse(sseBody(toolUseSSE("call_1", "search_documents", { query: "x" }))),
      )
      .mockResolvedValueOnce(
        jsonResponse(
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
    globalThis.fetch = fetchSpy;
    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "x",
      durationMs: 0,
      results: [],
    }));
    const events: AgentEvent[] = [];
    for await (const event of new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test",
    }).runTurn(baseInput({ tools: [tool] }))) {
      events.push(event);
    }

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.context).toMatchObject({
      peakInputTokens: 30,
      measurement: "unknown",
      requestIteration: 2,
    });
    expect(end.payload.context?.inputTokens).toBeUndefined();
  });

  it("uses the last cumulative usage chunk for each streamed request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse(
        sseBody([
          {
            choices: [{ delta: { content: "ok" }, finish_reason: null }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 90, completion_tokens: 40 },
          },
          "[DONE]",
        ]),
      ),
    );
    const events: AgentEvent[] = [];
    for await (const event of new HttpChatBackend({
      baseUrl: "http://localhost:8000",
      model: "test",
    }).runTurn(baseInput())) {
      events.push(event);
    }
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

  it("drops stream_options and retries on a 422 (Mistral), keeping streaming", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: "Extra inputs are not permitted", type: "extra_forbidden" } },
          422,
        ),
      )
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["hello from mistral"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "mistral" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    const body2 = JSON.parse((fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(body1.stream_options).toBeDefined();
    expect(body2.stream_options).toBeUndefined();
    expect(body2.stream).toBe(true);
    // The turn produced real text and ended cleanly — no error event.
    expect(events.some((e) => e.type === "agent.error")).toBe(false);
    expect(events.at(-1)?.type).toBe("agent.message.end");
    const deltas = events
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => (e as Extract<AgentEvent, { type: "agent.text.delta" }>).payload.delta);
    expect(deltas.join("")).toBe("hello from mistral");
  });

  it("falls back to a non-streamed request when streaming keeps 400ing (OpenAI verify gate)", async () => {
    const verifyErr = () =>
      jsonResponse({ error: { message: "must be verified to stream this model" } }, 400);
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(verifyErr())
      .mockResolvedValueOnce(verifyErr())
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "non-streamed answer" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      );
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "gpt-5.5" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const body3 = JSON.parse((fetchSpy.mock.calls[2] as [string, RequestInit])[1].body as string);
    expect(body3.stream).toBe(false);
    expect(events.some((e) => e.type === "agent.error")).toBe(false);
    const deltas = events
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => (e as Extract<AgentEvent, { type: "agent.text.delta" }>).payload.delta);
    expect(deltas.join("")).toBe("non-streamed answer");
    const end = events.at(-1)!;
    if (end.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.usage).toEqual({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 0 });
    // message.start emitted exactly once across the whole retry ladder.
    expect(events.filter((e) => e.type === "agent.message.start")).toHaveLength(1);
  });

  it("splits cached tokens out of input on the non-streamed fallback path", async () => {
    const verifyErr = () =>
      jsonResponse({ error: { message: "must be verified to stream this model" } }, 400);
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(verifyErr())
      .mockResolvedValueOnce(verifyErr())
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4000, completion_tokens: 12, prompt_cache_hit_tokens: 3600 },
        }),
      );
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "gpt-5.5" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    const end = events.at(-1)!;
    if (end.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.usage).toEqual({
      inputTokens: 400,
      outputTokens: 12,
      cacheReadTokens: 3600,
    });
  });

  it("surfaces an empty successful non-streamed response as agent.error + clean end", async () => {
    const verifyErr = () =>
      jsonResponse({ error: { message: "must be verified to stream this model" } }, 400);
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(verifyErr())
      .mockResolvedValueOnce(verifyErr())
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 9, completion_tokens: 0 },
        }),
      );
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "gpt-5.5" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(events.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.error",
      "agent.message.end",
    ]);
    const err = events.find((e) => e.type === "agent.error");
    if (err && err.type === "agent.error") {
      expect(err.payload.code).toBe("http_empty_response");
      expect(err.payload.message).toBe("Model returned an empty response (finish_reason=stop).");
    }
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.stopReason).toBe("error");
    expect(end.payload.usage).toEqual({ inputTokens: 9, outputTokens: 0, cacheReadTokens: 0 });
  });

  it("runs tool calls returned by the non-streamed fallback", async () => {
    let toolRan = false;
    const tool = fakeToolHandle("search_documents", () => {
      toolRan = true;
      return { kind: "search.results", query: "x", durationMs: 0, results: [] };
    });
    const fetchSpy = vi
      .fn()
      // First (streaming) attempt fails so we fall straight to non-streamed.
      .mockResolvedValueOnce(jsonResponse({ error: { message: "stream not allowed" } }, 400))
      .mockResolvedValueOnce(jsonResponse({ error: { message: "stream not allowed" } }, 400))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "search_documents", arguments: '{"query":"x"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
      )
      // After the tool result is appended, the next turn streams the answer.
      .mockResolvedValueOnce(mockFetchResponse(sseBody(textOnlySSE(["done"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "m" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);

    expect(toolRan).toBe(true);
    expect(events.some((e) => e.type === "agent.tool.start")).toBe(true);
    expect(events.some((e) => e.type === "agent.tool.result")).toBe(true);
    expect(events.at(-1)?.type).toBe("agent.message.end");
  });

  it("does not retry body shapes on a non-400/422 status (terminates once)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "nope" } }, 401));
    globalThis.fetch = fetchSpy;
    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "m" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "agent.error")).toHaveLength(1);
    expect(events.filter((e) => e.type === "agent.message.start")).toHaveLength(1);
  });

  it("strips a <think> block split across SSE deltas from the visible text", async () => {
    const chunks: Array<Record<string, unknown> | "[DONE]"> = [
      { choices: [{ delta: { content: "<thi" }, finish_reason: null }] },
      { choices: [{ delta: { content: "nk>secret rea" }, finish_reason: null }] },
      { choices: [{ delta: { content: "soning</thi" }, finish_reason: null }] },
      { choices: [{ delta: { content: "nk>the answer" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      "[DONE]",
    ];
    const fetchSpy = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(chunks)));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "deepseek-r1" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    const text = events
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => (e as Extract<AgentEvent, { type: "agent.text.delta" }>).payload.delta)
      .join("");
    expect(text).toBe("the answer");

    for await (const _ of backend.runTurn(baseInput({ messageId: "m2" }))) {
      // drain the turn after inline reasoning was observed
    }
    const secondBody = JSON.parse(
      (fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string,
    );
    expect(secondBody.max_tokens).toBe(16_384);
  });

  it("surfaces reasoning_content as agent.thinking.delta", async () => {
    const chunks: Array<Record<string, unknown> | "[DONE]"> = [
      { choices: [{ delta: { reasoning_content: "let me think" }, finish_reason: null }] },
      { choices: [{ delta: { content: "answer" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      "[DONE]",
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(chunks)));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "deepseek" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    expect(events.some((e) => e.type === "agent.thinking.delta")).toBe(true);
    const text = events
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => (e as Extract<AgentEvent, { type: "agent.text.delta" }>).payload.delta)
      .join("");
    expect(text).toBe("answer");
  });

  it("surfaces OpenRouter-style reasoning as agent.thinking.delta", async () => {
    const chunks: Array<Record<string, unknown> | "[DONE]"> = [
      { choices: [{ delta: { reasoning: "let me think" }, finish_reason: null }] },
      { choices: [{ delta: { content: "answer" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      "[DONE]",
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(chunks)));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "openrouter" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    const thinking = events
      .filter((e) => e.type === "agent.thinking.delta")
      .map((e) => (e as Extract<AgentEvent, { type: "agent.thinking.delta" }>).payload.delta)
      .join("");
    expect(thinking).toBe("let me think");
    const text = events
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => (e as Extract<AgentEvent, { type: "agent.text.delta" }>).payload.delta)
      .join("");
    expect(text).toBe("answer");
  });

  it("prefers reasoning_content over reasoning when both are present", async () => {
    const chunks: Array<Record<string, unknown> | "[DONE]"> = [
      {
        choices: [
          {
            delta: { reasoning_content: "native trace", reasoning: "normalized trace" },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      "[DONE]",
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse(sseBody(chunks)));

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "openrouter" });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    const thinking = events
      .filter((e) => e.type === "agent.thinking.delta")
      .map((e) => (e as Extract<AgentEvent, { type: "agent.thinking.delta" }>).payload.delta)
      .join("");
    expect(thinking).toBe("native trace");
  });

  it("remembers stream_options is unsupported so a later turn skips it", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "extra_forbidden" } }, 422))
      .mockResolvedValue(mockFetchResponse(sseBody(textOnlySSE(["ok"]))));
    globalThis.fetch = fetchSpy;

    const backend = new HttpChatBackend({ baseUrl: "http://localhost:8000", model: "mistral" });
    for await (const _ of backend.runTurn(baseInput())) {
      /* turn 1: learns stream_options is rejected */
    }
    fetchSpy.mockClear();
    for await (const _ of backend.runTurn(baseInput())) {
      /* turn 2 */
    }
    // Turn 2's first (and only) request already omits stream_options.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.stream_options).toBeUndefined();
  });
});
