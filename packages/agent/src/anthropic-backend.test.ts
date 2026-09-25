// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AnthropicBackend,
  anthropicErrorMetadata,
  anthropicFailureMessage,
  anthropicProviderFailure,
  convertHistoryToAnthropic,
  supportsAdaptiveThinking,
  type AnthropicClientLike,
} from "./anthropic-backend.js";
import type {
  MessageCountTokensParams,
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

import type { AgentEvent, ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "./backend.js";

interface RecordedCall {
  messages: MessageCreateParamsStreaming["messages"];
  tools: MessageCreateParamsStreaming["tools"];
  system: MessageCreateParamsStreaming["system"];
  model: string;
  maxTokens: number;
  thinking: MessageCreateParamsStreaming["thinking"];
}

function stubClient(
  scripts: RawMessageStreamEvent[][],
  tokenCounts?: Array<number | Error>,
): {
  client: AnthropicClientLike;
  calls: RecordedCall[];
  countCalls: MessageCountTokensParams[];
} {
  const calls: RecordedCall[] = [];
  const countCalls: MessageCountTokensParams[] = [];
  let i = 0;
  let countIndex = 0;
  const messages: AnthropicClientLike["messages"] = {
    create(params: MessageCreateParamsStreaming) {
      // Deep-clone the messages snapshot — the backend mutates its own
      // `messages` array between iterations.
      calls.push({
        messages: JSON.parse(JSON.stringify(params.messages)),
        tools: params.tools,
        system: params.system,
        model: params.model,
        maxTokens: params.max_tokens,
        thinking: params.thinking,
      });
      const events = scripts[i++];
      if (!events) throw new Error("script exhausted");
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
  if (tokenCounts) {
    messages.countTokens = (params) => {
      countCalls.push(JSON.parse(JSON.stringify(params)) as MessageCountTokensParams);
      const next = tokenCounts[countIndex++];
      if (next instanceof Error) return Promise.reject(next);
      if (next === undefined) return Promise.reject(new Error("count script exhausted"));
      return Promise.resolve({ input_tokens: next });
    };
  }
  const client: AnthropicClientLike = {
    messages,
  };
  return { client, calls, countCalls };
}

function fakeToolHandle(
  name: string,
  fn: (args: unknown, context: ToolContext) => ToolResult,
): ToolHandle {
  return {
    name,
    description: `mock ${name}`,
    schema: z.object({ query: z.string() }),
    async invoke(args, context) {
      return fn(args, context);
    },
  };
}

const baseInput = (overrides: Partial<Parameters<AnthropicBackend["runTurn"]>[0]> = {}) => ({
  sessionId: "S",
  messageId: "M",
  history: [],
  userMessage: "hi",
  tools: [],
  systemPrompt: "you are an agent",
  ...overrides,
});

// Build a synthetic text-only Anthropic stream.
function textOnlyStream(fragments: string[]): RawMessageStreamEvent[] {
  return [
    {
      type: "message_start",
      message: {
        id: "m_anthropic",
        type: "message",
        role: "assistant",
        model: "test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 50,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: null,
          server_tool_use: null,
          service_tier: null,
        },
        container: null,
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    },
    ...fragments.map(
      (text) =>
        ({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        }) as RawMessageStreamEvent,
    ),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        input_tokens: 0,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
        server_tool_use: null,
      },
    },
    { type: "message_stop" },
  ];
}

function outputUsageStream(
  values: number[],
  stopReason: "end_turn" | "max_tokens" | "model_context_window_exceeded" = "end_turn",
): RawMessageStreamEvent[] {
  const base = textOnlyStream(["partial"]).filter((event) => event.type !== "message_delta");
  const stopIndex = base.findIndex((event) => event.type === "message_stop");
  base.splice(
    stopIndex,
    0,
    ...values.map(
      (outputTokens) =>
        ({
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: {
            input_tokens: 0,
            output_tokens: outputTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
            server_tool_use: null,
          },
        }) as RawMessageStreamEvent,
    ),
  );
  return base;
}

// Build a synthetic tool-use stream that calls `toolName` with `args` then stops.
function toolUseStream(toolName: string, args: unknown): RawMessageStreamEvent[] {
  const argsJson = JSON.stringify(args);
  return [
    {
      type: "message_start",
      message: {
        id: "m_a",
        type: "message",
        role: "assistant",
        model: "test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 30,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: null,
          server_tool_use: null,
          service_tier: null,
        },
        container: null,
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_1",
        name: toolName,
        input: {},
        caller: { type: "code" },
      } as unknown as RawMessageStreamEvent["content_block"] extends never
        ? never
        : Extract<RawMessageStreamEvent, { type: "content_block_start" }>["content_block"],
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: argsJson },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: {
        input_tokens: 0,
        output_tokens: 15,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
        server_tool_use: null,
      },
    },
    { type: "message_stop" },
  ];
}

// A stream that emits a `thinking` block (with a signature) at index 0, then a
// `tool_use` block at index 1, and stops with `tool_use` — the shape adaptive
// thinking produces when the model reasons before calling a tool.
function thinkingThenToolUseStream(
  thinkingText: string,
  signature: string,
  toolName: string,
  args: unknown,
): RawMessageStreamEvent[] {
  return [
    {
      type: "message_start",
      message: {
        id: "m_a",
        type: "message",
        role: "assistant",
        model: "test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 30,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: null,
          server_tool_use: null,
          service_tier: null,
        },
        container: null,
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: thinkingText },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_1",
        name: toolName,
        input: {},
      } as unknown as Extract<
        RawMessageStreamEvent,
        { type: "content_block_start" }
      >["content_block"],
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: {
        input_tokens: 0,
        output_tokens: 15,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
        server_tool_use: null,
      },
    },
    { type: "message_stop" },
  ];
}

// A stream that emits a `redacted_thinking` block (delivered whole, no deltas)
// at index 0, then a `tool_use` at index 1, and stops with `tool_use`.
function redactedThinkingThenToolUseStream(
  data: string,
  toolName: string,
  args: unknown,
): RawMessageStreamEvent[] {
  return [
    {
      type: "message_start",
      message: {
        id: "m_a",
        type: "message",
        role: "assistant",
        model: "test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 30,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_creation: null,
          server_tool_use: null,
          service_tier: null,
        },
        container: null,
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_1",
        name: toolName,
        input: {},
      } as unknown as Extract<
        RawMessageStreamEvent,
        { type: "content_block_start" }
      >["content_block"],
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: {
        input_tokens: 0,
        output_tokens: 15,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_creation: null,
        server_tool_use: null,
      },
    },
    { type: "message_stop" },
  ];
}

describe("AnthropicBackend", () => {
  it("drops hostile provider metadata from the log line instead of truncating it", () => {
    const metadata = anthropicErrorMetadata({
      status: 400,
      type: `invalid\nrequest ${"x".repeat(200)}`,
      requestID: `req\r\n${"y".repeat(200)}`,
    });

    expect(metadata).not.toMatch(/[\r\n]/);
    // Truncating would have kept the first 120 characters of whatever the
    // provider echoed. A field that is prose, or merely too long to be an
    // identifier, is not a field worth reporting at all.
    expect(metadata).toBe("status=400 type=none requestId=none");
  });

  it("keeps well-formed provider metadata on the failure and the log line", () => {
    const err = { status: 429, type: "rate_limit_error", requestID: "req_01ABC" };
    expect(anthropicErrorMetadata(err)).toBe(
      "status=429 type=rate_limit_error requestId=req_01ABC",
    );
    expect(anthropicProviderFailure(err)).toEqual({
      status: 429,
      type: "rate_limit_error",
      requestId: "req_01ABC",
    });
    expect(anthropicFailureMessage(err)).toContain("rate-limited");
    expect(anthropicFailureMessage(err)).toContain("HTTP 429");
  });

  it("translates a text-only stream into agent.text.delta + agent.message.end", async () => {
    const { client, calls } = stubClient([textOnlyStream(["Hello, ", "world."])]);
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-test", client });

    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);

    expect(events.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.text.delta",
      "agent.text.delta",
      "agent.message.end",
    ]);
    const end = events[events.length - 1]!;
    if (end.type !== "agent.message.end") throw new Error("expected end");
    expect(end.payload.stopReason).toBe("end_turn");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("claude-test");
    expect(calls[0]!.system).toBeDefined();
  });

  it("runs the tool-use loop, invokes the handle, and feeds the result back", async () => {
    const toolResult: ToolResult = {
      kind: "search.results",
      query: "Quentin",
      durationMs: 11,
      results: [{ documentId: "d1", sourceType: "gmail", sourceId: "gmail:me", title: "hi" }],
    };
    let invokedWith: unknown;
    const tool = fakeToolHandle("search_documents", (args) => {
      invokedWith = args;
      return toolResult;
    });
    const { client, calls } = stubClient([
      toolUseStream("search_documents", { query: "Quentin" }),
      textOnlyStream(["I found one email from Quentin."]),
    ]);
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-test", client });

    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);

    expect(events.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.tool.input_start",
      "agent.tool.start",
      "agent.tool.result",
      "agent.text.delta",
      "agent.message.end",
    ]);
    expect(invokedWith).toEqual({ query: "Quentin" });
    expect(calls).toHaveLength(2);
    // Second call's messages should include the tool_use + tool_result pair.
    const secondCallMessages = calls[1]!.messages;
    expect(secondCallMessages.length).toBeGreaterThan(1);
    const lastUser = secondCallMessages[secondCallMessages.length - 1]!;
    expect(lastUser.role).toBe("user");
  });

  it("streams batch child progress before its durable tool result", async () => {
    const tool = fakeToolHandle("search_many", (_args, context) => {
      context.onChildStart?.({ index: 0, tool: "search_documents", argsSummary: "budget" });
      context.onChildResult?.({
        index: 0,
        result: { kind: "search.results", query: "budget", durationMs: 1, results: [] },
      });
      return { kind: "search.batch", items: [] };
    });
    const { client } = stubClient([
      toolUseStream("search_many", { query: "budget" }),
      textOnlyStream(["Done."]),
    ]);

    const events: AgentEvent[] = [];
    for await (const event of new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      client,
    }).runTurn(baseInput({ tools: [tool] }))) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "agent.tool.child.start",
        "agent.tool.child.result",
        "agent.tool.result",
      ]),
    );
    expect(events.findIndex((event) => event.type === "agent.tool.child.start")).toBeLessThan(
      events.findIndex((event) => event.type === "agent.tool.result"),
    );
    expect(events.findIndex((event) => event.type === "agent.tool.child.result")).toBeLessThan(
      events.findIndex((event) => event.type === "agent.tool.result"),
    );
  });

  it("marks a batch containing a child error as an error for the model", async () => {
    const tool = fakeToolHandle("annotate_many", () => ({
      kind: "annotate.batch",
      items: [
        {
          kind: "error",
          code: "document_not_found",
          message: "Resolve the canonical document id and retry.",
        },
      ],
    }));
    const { client, calls } = stubClient([
      toolUseStream("annotate_many", { query: "cite the project plan" }),
      textOnlyStream(["I corrected the citation."]),
    ]);
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-test", client });

    for await (const _event of backend.runTurn(baseInput({ tools: [tool] }))) {
      // Consume the full turn so the second provider request is captured.
    }

    const lastUser = calls[1]!.messages.at(-1);
    expect(lastUser?.role).toBe("user");
    const resultBlock = Array.isArray(lastUser?.content) ? lastUser.content[0] : undefined;
    expect(resultBlock).toMatchObject({
      type: "tool_result",
      is_error: true,
    });
    expect(JSON.parse(String("content" in (resultBlock ?? {}) ? resultBlock.content : ""))).toEqual(
      {
        kind: "annotate.batch",
        items: [
          {
            kind: "error",
            code: "document_not_found",
            message: "Resolve the canonical document id and retry.",
          },
        ],
      },
    );
  });

  it("emits an error tool-result when the model calls an unknown tool", async () => {
    const { client } = stubClient([
      toolUseStream("never_registered", { query: "x" }),
      textOnlyStream(["sorry, that failed"]),
    ]);
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-test", client });

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

  // Like toolUseStream, but carries `rawArgs` verbatim as the accumulated
  // input JSON (lets a test stream malformed or empty arguments).
  function rawArgsToolUseStream(toolName: string, rawArgs: string): RawMessageStreamEvent[] {
    return toolUseStream(toolName, {}).map((event) =>
      event.type === "content_block_delta"
        ? ({
            ...event,
            delta: { type: "input_json_delta", partial_json: rawArgs },
          } as RawMessageStreamEvent)
        : event,
    );
  }

  it("returns tool_args_unparseable instead of invoking when arguments are malformed", async () => {
    const truncated = '{"query":"unfini';
    let invoked = false;
    const tool = fakeToolHandle("search_documents", () => {
      invoked = true;
      return { kind: "search.results", query: "x", durationMs: 0, results: [] };
    });
    const { client, calls } = stubClient([
      rawArgsToolUseStream("search_documents", truncated),
      textOnlyStream(["understood"]),
    ]);
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-test", client });

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
    expect(result.message).toContain(truncated);

    // The wire replay stays valid: the tool_use block carries `{}` input and
    // the fabricated error goes back as an is_error tool_result.
    const secondCallMessages = calls[1]!.messages;
    const assistantMsg = secondCallMessages.find((m) => m.role === "assistant");
    const toolUseBlock = Array.isArray(assistantMsg?.content)
      ? assistantMsg.content.find((block) => typeof block === "object" && block.type === "tool_use")
      : undefined;
    expect(toolUseBlock).toMatchObject({ type: "tool_use", input: {} });
    const lastUser = secondCallMessages.at(-1);
    const resultBlock = Array.isArray(lastUser?.content) ? lastUser.content[0] : undefined;
    expect(resultBlock).toMatchObject({ type: "tool_result", is_error: true });
    if (resultBlock && typeof resultBlock === "object" && "content" in resultBlock) {
      expect(String(resultBlock.content)).toContain("tool_args_unparseable");
    }
  });

  it("still invokes a no-argument tool when the accumulated input JSON is empty", async () => {
    let invokedWith: unknown = "never";
    const tool = fakeToolHandle("search_documents", (args) => {
      invokedWith = args;
      return { kind: "search.results", query: "", durationMs: 0, results: [] };
    });
    const { client } = stubClient([
      rawArgsToolUseStream("search_documents", ""),
      textOnlyStream(["ok"]),
    ]);
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-test", client });

    for await (const _ of backend.runTurn(baseInput({ tools: [tool] }))) {
      // Consume the full turn.
    }

    expect(invokedWith).toEqual({});
  });

  it("surfaces a create() rejection as agent.error + clean end", async () => {
    const client: AnthropicClientLike = {
      messages: {
        create() {
          throw new Error("rate_limited: try again in 30s");
        },
      },
    };
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-test", client });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);
    const types = events.map((e) => e.type);
    expect(types).toContain("agent.error");
    expect(types[types.length - 1]).toBe("agent.message.end");
    const err = events.find((e) => e.type === "agent.error");
    if (err && err.type === "agent.error") {
      expect(err.payload.code).toBe("anthropic_api_error");
      expect(err.payload.message).toBe("Anthropic API request failed.");
      expect(err.payload.message).not.toContain("rate_limited");
    }
  });

  it("classifies an abort while create() is pending as canceled", async () => {
    const controller = new AbortController();
    const client: AnthropicClientLike = {
      messages: {
        create(_params, opts) {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted", "AbortError")),
              { once: true },
            );
          });
        },
      },
    };
    const events: AgentEvent[] = [];
    const collecting = (async () => {
      for await (const event of new AnthropicBackend({
        apiKey: "test",
        model: "claude-test",
        client,
      }).runTurn(baseInput(), controller.signal)) {
        events.push(event);
      }
    })();
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await collecting;

    expect(events.some((event) => event.type === "agent.error")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "canceled" },
    });
  });

  it("classifies an abort while countTokens() is pending as canceled", async () => {
    const controller = new AbortController();
    let markCounting!: () => void;
    const counting = new Promise<void>((resolve) => {
      markCounting = resolve;
    });
    const client: AnthropicClientLike = {
      messages: {
        create() {
          throw new Error("create must not run after token-count cancellation");
        },
        countTokens(_params, opts) {
          markCounting();
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted", "AbortError")),
              { once: true },
            );
          });
        },
      },
    };
    const events: AgentEvent[] = [];
    const collecting = (async () => {
      for await (const event of new AnthropicBackend({
        apiKey: "test",
        model: "claude-test",
        client,
      }).runTurn(baseInput(), controller.signal)) {
        events.push(event);
      }
    })();
    await counting;
    controller.abort();
    await collecting;

    expect(events.some((event) => event.type === "agent.error")).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["agent.message.start", "agent.message.end"]);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "canceled" },
    });
  });

  it.each([
    ["under", 3_999, "end_turn", 1],
    ["equal", 4_000, "end_turn", 1],
    ["over", 4_001, "error", 0],
  ] as const)(
    "enforces the counted context boundary when the request is %s",
    async (_label, count, expectedStop, expectedCreates) => {
      const { client, calls, countCalls } = stubClient(
        expectedCreates === 0 ? [] : [textOnlyStream(["ok"])],
        [count],
      );
      const backend = new AnthropicBackend({
        apiKey: "test",
        model: "claude-test",
        modelLimits: { contextWindowTokens: 5_000, maxOutputTokens: 1_000 },
        contextSafetyMarginTokens: 0,
        client,
      });

      const events: AgentEvent[] = [];
      for await (const event of backend.runTurn(baseInput())) events.push(event);

      expect(countCalls).toHaveLength(1);
      expect(calls).toHaveLength(expectedCreates);
      const end = events.at(-1);
      if (end?.type !== "agent.message.end") throw new Error("expected message end");
      expect(end.payload.stopReason).toBe(expectedStop);
      if (expectedStop === "error") {
        expect(end.payload.context).toMatchObject({
          inputTokens: count,
          peakInputTokens: count,
          measurement: "provider_count",
          contextWindowTokens: 5_000,
          limitSource: "provider",
        });
        expect(end.payload.failure).toMatchObject({
          code: "context_window_exceeded",
          retryable: false,
        });
      } else {
        expect(end.payload.context).toMatchObject({
          inputTokens: 50,
          peakInputTokens: count,
          measurement: "provider_reported",
          contextWindowTokens: 5_000,
          limitSource: "provider",
        });
      }
    },
  );

  it("does not subtract the output reserve from an Anthropic input-only ceiling", async () => {
    const { client, calls } = stubClient([textOnlyStream(["ok"])], [5_000]);
    const backend = new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      modelLimits: { maxInputTokens: 5_000, maxOutputTokens: 1_000 },
      contextSafetyMarginTokens: 0,
      client,
    });

    const events: AgentEvent[] = [];
    for await (const event of backend.runTurn(baseInput())) events.push(event);

    expect(calls).toHaveLength(1);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.stopReason).toBe("end_turn");
    expect(end.payload.context?.maxInputTokens).toBe(5_000);
    expect(end.payload.context?.contextWindowTokens).toBeUndefined();
  });

  it("publishes the input-only ceiling when Anthropic preflight rejects a request", async () => {
    const { client, calls } = stubClient([], [5_001]);
    const events: AgentEvent[] = [];
    for await (const event of new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      modelLimits: { maxInputTokens: 5_000, maxOutputTokens: 1_000 },
      contextSafetyMarginTokens: 0,
      client,
    }).runTurn(baseInput())) {
      events.push(event);
    }

    expect(calls).toHaveLength(0);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.failure?.code).toBe("context_window_exceeded");
    expect(end.payload.context).toMatchObject({
      inputTokens: 5_001,
      peakInputTokens: 5_001,
      maxInputTokens: 5_000,
      measurement: "provider_count",
      limitSource: "provider",
    });
    expect(end.payload.context?.contextWindowTokens).toBeUndefined();
  });

  it("counts the complete tool-loop request and blocks growth before the second create", async () => {
    const { client, calls, countCalls } = stubClient(
      [toolUseStream("search_documents", { query: "x" })],
      [100, 4_901],
    );
    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "x",
      durationMs: 0,
      results: [],
    }));
    const backend = new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      modelLimits: { contextWindowTokens: 5_000, maxOutputTokens: 100 },
      contextSafetyMarginTokens: 0,
      client,
    });

    const events: AgentEvent[] = [];
    for await (const event of backend.runTurn(baseInput({ tools: [tool] }))) events.push(event);

    expect(countCalls).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(countCalls[1]!.messages.at(-1)?.role).toBe("user");
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.failure?.code).toBe("context_window_exceeded");
    expect(end.payload.context).toMatchObject({
      inputTokens: 4_901,
      peakInputTokens: 4_901,
      requestIteration: 2,
    });
  });

  it("falls through to the real request when token counting fails", async () => {
    const { client, calls } = stubClient(
      [textOnlyStream(["ok"])],
      [new Error("count endpoint unavailable")],
    );
    const backend = new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      modelLimits: { contextWindowTokens: 5_000 },
      client,
    });

    const events: AgentEvent[] = [];
    for await (const event of backend.runTurn(baseInput())) events.push(event);

    expect(calls).toHaveLength(1);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.stopReason).toBe("end_turn");
    expect(end.payload.context).toMatchObject({
      inputTokens: 50,
      peakInputTokens: 50,
      measurement: "provider_reported",
    });
  });

  it("classifies only a structured Anthropic context rejection as terminal context overflow", async () => {
    const rawMessage = "prompt is too long; private provider detail";
    const client: AnthropicClientLike = {
      messages: {
        create() {
          throw {
            status: 400,
            type: "invalid_request_error",
            error: { message: rawMessage },
            requestID: "req_test",
          };
        },
      },
    };
    const events: AgentEvent[] = [];
    for await (const event of new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      client,
    }).runTurn(baseInput())) {
      events.push(event);
    }

    const error = events.find((event) => event.type === "agent.error");
    if (error?.type !== "agent.error") throw new Error("expected agent error");
    expect(error.payload.code).toBe("context_window_exceeded");
    expect(error.payload.message).not.toContain(rawMessage);
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.failure).toMatchObject({
      code: "context_window_exceeded",
      retryable: false,
      backend: "anthropic",
      model: "claude-test",
    });
  });

  it("does not misclassify an unrelated invalid Anthropic request as context overflow", async () => {
    const client: AnthropicClientLike = {
      messages: {
        create() {
          throw {
            status: 400,
            type: "invalid_request_error",
            error: { message: "temperature must be between zero and one" },
          };
        },
      },
    };
    const events: AgentEvent[] = [];
    for await (const event of new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      client,
    }).runTurn(baseInput())) {
      events.push(event);
    }
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.failure?.code).toBe("anthropic_api_error");
  });

  it("preserves partial output when Anthropic reports model_context_window_exceeded", async () => {
    const { client } = stubClient([outputUsageStream([7], "model_context_window_exceeded")]);
    const events: AgentEvent[] = [];
    for await (const event of new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      client,
    }).runTurn(baseInput())) {
      events.push(event);
    }

    expect(
      events
        .filter((event) => event.type === "agent.text.delta")
        .map((event) => (event as Extract<AgentEvent, { type: "agent.text.delta" }>).payload.delta)
        .join(""),
    ).toBe("partial");
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.failure?.code).toBe("context_window_exceeded");
    expect(end.payload.usage.outputTokens).toBe(7);
  });

  it("uses the last cumulative Anthropic output usage value even when deltas repeat or decrease", async () => {
    const { client } = stubClient([outputUsageStream([20, 20, 15])]);
    const events: AgentEvent[] = [];
    for await (const event of new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      client,
    }).runTurn(baseInput())) {
      events.push(event);
    }
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.usage.outputTokens).toBe(15);
  });

  it("marks an Anthropic max_tokens stop as a non-retryable truncation failure", async () => {
    const { client } = stubClient([outputUsageStream([1_000], "max_tokens")]);
    const events: AgentEvent[] = [];
    for await (const event of new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      modelLimits: { maxOutputTokens: 1_000 },
      client,
    }).runTurn(baseInput())) {
      events.push(event);
    }
    const end = events.at(-1);
    if (end?.type !== "agent.message.end") throw new Error("expected message end");
    expect(end.payload.stopReason).toBe("max_tokens");
    expect(end.payload.failure).toMatchObject({
      code: "output_truncated",
      retryable: false,
    });
  });

  it("surfaces a mid-stream throw as agent.error + clean end", async () => {
    const client: AnthropicClientLike = {
      messages: {
        create() {
          // eslint-disable-next-line require-yield
          return (async function* (): AsyncGenerator<RawMessageStreamEvent> {
            throw new Error("connection reset");
          })();
        },
      },
    };
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-test", client });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput())) events.push(e);
    const err = events.find((e) => e.type === "agent.error");
    expect(err).toBeDefined();
    if (err && err.type === "agent.error") {
      expect(err.payload.code).toBe("anthropic_stream_error");
    }
  });

  it("classifies an abort-rejected response stream as canceled", async () => {
    const controller = new AbortController();
    const client: AnthropicClientLike = {
      messages: {
        create(_params, opts) {
          return (async function* (): AsyncGenerator<RawMessageStreamEvent> {
            yield textOnlyStream(["partial"])[0]!;
            await new Promise<void>((_resolve, reject) => {
              opts?.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("The operation was aborted", "AbortError")),
                { once: true },
              );
            });
          })();
        },
      },
    };
    const events: AgentEvent[] = [];
    const collecting = (async () => {
      for await (const event of new AnthropicBackend({
        apiKey: "test",
        model: "claude-test",
        client,
      }).runTurn(baseInput(), controller.signal)) {
        events.push(event);
      }
    })();
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await collecting;

    expect(events.some((event) => event.type === "agent.error")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "canceled" },
    });
  });

  it("uses the tool handle's own summarize() to render argsSummary", async () => {
    const tool: ToolHandle = {
      name: "search_documents",
      description: "mock search_documents",
      schema: z.object({ query: z.string() }),
      async invoke() {
        return { kind: "search.results", query: "x", durationMs: 0, results: [] };
      },
      summarize(args: unknown): string | undefined {
        if (!args || typeof args !== "object") return undefined;
        const a = args as Record<string, unknown>;
        const extras: string[] = [];
        if (typeof a.limit === "number") extras.push(`limit=${a.limit}`);
        return extras.length > 0 ? `${a.query} (${extras.join(", ")})` : String(a.query);
      },
    };
    const { client } = stubClient([
      toolUseStream("search_documents", { query: "Quentin", limit: 3 }),
      textOnlyStream(["done"]),
    ]);
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-test", client });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);
    const start = events.find((e) => e.type === "agent.tool.start");
    if (!start || start.type !== "agent.tool.start") throw new Error("no tool.start");
    expect(start.payload.argsSummary).toBe("Quentin (limit=3)");
  });

  it("falls back to a truncated JSON dump when the handle declines to summarize", async () => {
    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "x",
      durationMs: 0,
      results: [],
    }));
    const { client } = stubClient([
      toolUseStream("search_documents", { query: "Quentin" }),
      textOnlyStream(["done"]),
    ]);
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-test", client });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);
    const start = events.find((e) => e.type === "agent.tool.start");
    if (!start || start.type !== "agent.tool.start") throw new Error("no tool.start");
    expect(start.payload.argsSummary).toBe('{"query":"Quentin"}');
  });

  it("places exactly one cache_control marker per request and shifts it across iterations", async () => {
    // Tests the history-prefix caching: the system prompt already carries
    // one cache_control marker; the messages array should carry exactly
    // one more (on the last block of the last message). Across the
    // multi-iteration tool-use loop the marker should advance, not
    // accumulate — Anthropic caps breakpoints at 4 per request and we
    // want budget for future features.
    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "x",
      durationMs: 0,
      results: [],
    }));
    const { client, calls } = stubClient([
      toolUseStream("search_documents", { query: "x" }),
      textOnlyStream(["ok"]),
    ]);
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-test", client });
    for await (const _ of backend.runTurn(baseInput({ tools: [tool] }))) {
      /* drain */
    }
    expect(calls).toHaveLength(2);

    function countMarkers(messages: unknown): number {
      let n = 0;
      for (const m of messages as Array<{ content: unknown }>) {
        if (typeof m.content === "string") continue;
        for (const b of m.content as Array<{ cache_control?: unknown }>) {
          if (b?.cache_control) n++;
        }
      }
      return n;
    }

    expect(countMarkers(calls[0]!.messages)).toBe(1);
    expect(countMarkers(calls[1]!.messages)).toBe(1);

    // Marker on call 2 is on the tool_result (user-role) message, not on
    // the prior assistant block.
    const c2 = calls[1]!.messages as Array<{ role: string; content: unknown }>;
    const last = c2[c2.length - 1]!;
    expect(last.role).toBe("user");
    const lastBlocks = last.content as Array<{ cache_control?: unknown }>;
    expect(lastBlocks[lastBlocks.length - 1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("hits the iteration cap when the model loops on tool_use", async () => {
    const looping = Array.from({ length: 5 }, () =>
      toolUseStream("search_documents", { query: "x" }),
    );
    const { client } = stubClient(looping);
    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "x",
      durationMs: 0,
      results: [],
    }));
    const backend = new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      client,
      maxToolIterations: 2,
    });

    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);

    const error = events.find((e) => e.type === "agent.error");
    expect(error).toBeDefined();
    if (error && error.type === "agent.error") {
      expect(error.payload.code).toBe("tool_iteration_cap");
    }
  });

  it("requests adaptive+summarized thinking on a model that supports it", async () => {
    const { client, calls } = stubClient([textOnlyStream(["ok"])]);
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-sonnet-4-6", client });

    for await (const _ of backend.runTurn(baseInput())) {
      // drain
    }

    expect(calls[0].thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("omits thinking on a model that does not support adaptive thinking", async () => {
    const { client, calls } = stubClient([textOnlyStream(["ok"])]);
    const backend = new AnthropicBackend({
      apiKey: "test",
      model: "claude-haiku-4-5-20251001",
      client,
    });

    for await (const _ of backend.runTurn(baseInput())) {
      // drain
    }

    expect(calls[0].thinking).toBeUndefined();
  });

  it("prefers live Models API capability metadata over model-name detection", async () => {
    const enabled = stubClient([textOnlyStream(["ok"])]);
    const disabled = stubClient([textOnlyStream(["ok"])]);
    const enabledBackend = new AnthropicBackend({
      apiKey: "test",
      model: "claude-future-model",
      adaptiveThinking: true,
      client: enabled.client,
    });
    const disabledBackend = new AnthropicBackend({
      apiKey: "test",
      model: "claude-sonnet-5",
      adaptiveThinking: false,
      client: disabled.client,
    });

    for await (const _ of enabledBackend.runTurn(baseInput())) {
      // drain
    }
    for await (const _ of disabledBackend.runTurn(baseInput())) {
      // drain
    }

    expect(enabled.calls[0].thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect(disabled.calls[0].thinking).toBeUndefined();
  });

  it("caps the requested output tokens to the model-advertised maximum", async () => {
    const { client, calls } = stubClient([textOnlyStream(["ok"])]);
    const backend = new AnthropicBackend({
      apiKey: "test",
      model: "claude-specialized",
      maxTokens: 16_000,
      modelMaxTokens: 4_096,
      client,
    });

    for await (const _ of backend.runTurn(baseInput())) {
      // drain
    }

    expect(calls[0].maxTokens).toBe(4_096);
  });

  it("uses a conservative output limit until an unknown model is discovered", async () => {
    const { client, calls } = stubClient([textOnlyStream(["ok"])]);
    const backend = new AnthropicBackend({
      apiKey: "test",
      model: "claude-account-specific",
      client,
    });

    for await (const _ of backend.runTurn(baseInput())) {
      // drain
    }

    expect(calls[0].maxTokens).toBe(4_096);
  });

  it("emits thinking deltas and replays the signed thinking block before the tool_use", async () => {
    // Turn 1: reason (thinking + signature) → call a tool. Turn 2: answer.
    const { client, calls } = stubClient([
      thinkingThenToolUseStream("weighing options", "sig-abc", "search_documents", { query: "x" }),
      textOnlyStream(["done"]),
    ]);
    const tool = fakeToolHandle("search_documents", () => ({ kind: "ok", data: { hits: [] } }));
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-sonnet-4-6", client });

    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(baseInput({ tools: [tool] }))) events.push(e);

    // The summarized reasoning streamed to the client.
    const thinkingDeltas = events.filter((e) => e.type === "agent.thinking.delta");
    expect(thinkingDeltas.length).toBe(1);

    // The follow-up request replays the assistant turn with the thinking block
    // (carrying its signature) positioned BEFORE the tool_use block — omitting
    // it would 400 the request under adaptive/interleaved thinking.
    const replayedAssistant = calls[1].messages.find((m) => m.role === "assistant");
    expect(replayedAssistant).toBeDefined();
    const content = replayedAssistant?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      const kinds = content.map((b) => (typeof b === "object" && b && "type" in b ? b.type : ""));
      expect(kinds).toEqual(["thinking", "tool_use"]);
      const thinkingBlock = content[0] as { type: string; thinking: string; signature: string };
      expect(thinkingBlock.thinking).toBe("weighing options");
      expect(thinkingBlock.signature).toBe("sig-abc");
    }
  });

  it("replays a redacted_thinking block before the tool_use", async () => {
    const { client, calls } = stubClient([
      redactedThinkingThenToolUseStream("REDACTED_PAYLOAD", "search_documents", { query: "x" }),
      textOnlyStream(["done"]),
    ]);
    const tool = fakeToolHandle("search_documents", () => ({ kind: "ok", data: { hits: [] } }));
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-sonnet-4-6", client });

    for await (const _ of backend.runTurn(baseInput({ tools: [tool] }))) {
      // drain
    }

    const replayedAssistant = calls[1].messages.find((m) => m.role === "assistant");
    const content = replayedAssistant?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      const kinds = content.map((b) => (typeof b === "object" && b && "type" in b ? b.type : ""));
      expect(kinds).toEqual(["redacted_thinking", "tool_use"]);
      const redacted = content[0] as { type: string; data: string };
      expect(redacted.data).toBe("REDACTED_PAYLOAD");
    }
  });

  it("retains each iteration's signed thinking across a multi-step tool loop", async () => {
    // Two consecutive reason→tool iterations (interleaved thinking) then an
    // answer. Each assistant turn must carry ITS OWN signed thinking block.
    const { client, calls } = stubClient([
      thinkingThenToolUseStream("first pass", "sig-1", "search_documents", { query: "a" }),
      thinkingThenToolUseStream("second pass", "sig-2", "search_documents", { query: "b" }),
      textOnlyStream(["answer"]),
    ]);
    const tool = fakeToolHandle("search_documents", () => ({ kind: "ok", data: { hits: [] } }));
    const backend = new AnthropicBackend({ apiKey: "test", model: "claude-sonnet-4-6", client });

    for await (const _ of backend.runTurn(baseInput({ tools: [tool] }))) {
      // drain
    }

    // The final request carries both prior assistant turns, each led by its own
    // signed thinking block in the right order.
    const assistants = calls[2].messages.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(2);
    const leadThinking = (m: (typeof assistants)[number]) => {
      const c = m.content;
      if (!Array.isArray(c)) return undefined;
      return c[0] as { type: string; thinking: string; signature: string };
    };
    expect(leadThinking(assistants[0])).toMatchObject({
      type: "thinking",
      thinking: "first pass",
      signature: "sig-1",
    });
    expect(leadThinking(assistants[1])).toMatchObject({
      type: "thinking",
      thinking: "second pass",
      signature: "sig-2",
    });
  });
});

describe("supportsAdaptiveThinking", () => {
  it("accepts Claude 4.6+ Opus/Sonnet and the 5 family", () => {
    for (const m of [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-mythos-5",
    ]) {
      expect(supportsAdaptiveThinking(m)).toBe(true);
    }
  });

  it("rejects older tiers that would 400 on adaptive thinking", () => {
    for (const m of [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-5",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-3-5-sonnet",
      "claude-test",
      "some-other-model",
    ]) {
      expect(supportsAdaptiveThinking(m)).toBe(false);
    }
  });
});

describe("iteration-cap pairs every tool_use with a tool_result in history", () => {
  it("session.runTurnLoop closes orphan tool_uses when backend hits the cap", async () => {
    // Drive the backend through the agent session so the session's
    // history reducer applies. After the cap fires, every tool_use in
    // the session's history must have a matching tool_result in the
    // next user message — convertHistoryToAnthropic on that history
    // must produce a valid Anthropic input shape.
    const { AgentSession } = await import("./session.js");
    const looping = Array.from({ length: 5 }, () =>
      toolUseStream("search_documents", { query: "x" }),
    );
    const { client } = stubClient(looping);
    const tool = fakeToolHandle("search_documents", () => ({
      kind: "search.results",
      query: "x",
      durationMs: 0,
      results: [],
    }));
    const backend = new AnthropicBackend({
      apiKey: "test",
      model: "claude-test",
      client,
      maxToolIterations: 2,
    });
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [tool],
      systemPrompt: "x",
      idGen: () => "M",
    });
    await session.send("go").completion;

    const history = session.historySnapshot();
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of history) {
      for (const part of msg.parts) {
        if (part.kind === "tool_use") toolUseIds.add(part.toolCallId);
        if (part.kind === "tool_result") toolResultIds.add(part.toolCallId);
      }
    }
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
    // The converter must emit messages that Anthropic would accept (no
    // empty-content assistant messages, no orphan tool_use blocks).
    const out = convertHistoryToAnthropic(history);
    for (const m of out) {
      const blocks = m.content as Array<{ type: string; id?: string }>;
      expect(blocks.length).toBeGreaterThan(0);
      if (m.role === "assistant") {
        for (const b of blocks) {
          if (b.type === "tool_use") {
            expect(toolResultIds.has(b.id!)).toBe(true);
          }
        }
      }
    }
  });
});

describe("convertHistoryToAnthropic", () => {
  it("drops a thinking-only assistant turn", () => {
    const out = convertHistoryToAnthropic([
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
      { role: "assistant", parts: [{ kind: "thinking", text: "considering…" }] },
      { role: "user", parts: [{ kind: "text", text: "still there?" }] },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("round-trips an alternating text → tool_use → tool_result → text history", () => {
    const out = convertHistoryToAnthropic([
      { role: "user", parts: [{ kind: "text", text: "find x" }] },
      {
        role: "assistant",
        parts: [
          { kind: "text", text: "let me search" },
          { kind: "tool_use", toolCallId: "tc_1", tool: "search_documents", args: { query: "x" } },
        ],
      },
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "tc_1",
            result: { kind: "search.results", query: "x", durationMs: 1, results: [] },
          },
        ],
      },
      { role: "assistant", parts: [{ kind: "text", text: "found nothing" }] },
    ]);
    expect(out).toHaveLength(4);
    expect(out[0]!.role).toBe("user");
    expect(out[1]!.role).toBe("assistant");
    const asst1 = out[1]!.content as Array<{ type: string }>;
    expect(asst1.map((b) => b.type)).toEqual(["text", "tool_use"]);
    const userToolResult = out[2]!.content as Array<{ type: string }>;
    expect(userToolResult[0]!.type).toBe("tool_result");
    const asst2 = out[3]!.content as Array<{ type: string }>;
    expect(asst2.map((b) => b.type)).toEqual(["text"]);
  });

  it("preserves batch child failures as an Anthropic error in restored history", () => {
    const out = convertHistoryToAnthropic([
      {
        role: "assistant",
        parts: [
          {
            kind: "tool_use",
            toolCallId: "tc_batch",
            tool: "annotate_many",
            args: { annotations: [{ documentId: "analytics-row-17" }] },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "tc_batch",
            result: {
              kind: "annotate.batch",
              items: [
                {
                  kind: "error",
                  code: "document_not_found",
                  message: "Resolve the canonical document id and retry.",
                },
              ],
            },
          },
        ],
      },
    ]);
    const user = out[1];
    expect(user?.role).toBe("user");
    const resultBlock = Array.isArray(user?.content) ? user.content[0] : undefined;
    expect(resultBlock).toMatchObject({ type: "tool_result", is_error: true });
  });

  it("preserves the order of parallel tool_use blocks at indices 0 and 1", () => {
    const out = convertHistoryToAnthropic([
      {
        role: "assistant",
        parts: [
          { kind: "tool_use", toolCallId: "tc_a", tool: "search_documents", args: { query: "a" } },
          {
            kind: "tool_use",
            toolCallId: "tc_b",
            tool: "fetch_document",
            args: { documentId: "d" },
          },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    const blocks = out[0]!.content as Array<{ type: string; id?: string; name?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.id).toBe("tc_a");
    expect(blocks[0]!.name).toBe("search_documents");
    expect(blocks[1]!.id).toBe("tc_b");
    expect(blocks[1]!.name).toBe("fetch_document");
  });

  it("does not introduce string-content assistant messages (block form preserved)", () => {
    // The canonical session shape never produces string-content; the
    // converter always emits the block-array form even for a single
    // text part, which keeps the downstream cache-marker pass happy.
    const out = convertHistoryToAnthropic([
      { role: "assistant", parts: [{ kind: "text", text: "hello" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(Array.isArray(out[0]!.content)).toBe(true);
    const blocks = out[0]!.content as Array<{ type: string; text?: string }>;
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe("hello");
  });
});
