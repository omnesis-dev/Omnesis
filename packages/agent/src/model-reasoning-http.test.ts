// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpChatBackend, convertHistoryToOpenAI } from "./http-backend.js";
import { OpenAIResponsesBackend } from "./openai-responses-backend.js";
import type { ModelControls, ModelBehaviorValues } from "@omnesis/core/models";
import type { TurnInput } from "./backend.js";

const oldFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = oldFetch;
  vi.restoreAllMocks();
});

function controls(
  providerId: string,
  values: ModelBehaviorValues,
  interleavedReasoningField?: ModelControls["interleavedReasoningField"],
): ModelControls {
  return {
    providerId,
    source: "models.dev",
    reasoning: true,
    ...(interleavedReasoningField ? { interleavedReasoningField } : {}),
    controls: [
      ...(values.reasoningEnabled === undefined
        ? []
        : [{ key: "reasoningEnabled" as const, type: "boolean" as const, label: "Reasoning" }]),
      ...(values.reasoningEffort === undefined
        ? []
        : [
            {
              key: "reasoningEffort" as const,
              type: "enum" as const,
              label: "Effort",
              values: [values.reasoningEffort],
            },
          ]),
      ...(values.reasoningBudgetTokens === undefined
        ? []
        : [{ key: "reasoningBudgetTokens" as const, type: "integer" as const, label: "Budget" }]),
    ],
    logoUrl: `/model-logos/${providerId}.svg`,
  };
}

function sse(frames: Array<Record<string, unknown>>): Response {
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const input: TurnInput = {
  sessionId: "session-example",
  messageId: "message-example",
  history: [],
  userMessage: "Look up the example record.",
  systemPrompt: "Use the provided tool.",
  tools: [],
};

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

function requestBody(call: [RequestInfo | URL, RequestInit?]): string {
  const body = call[1]?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON request body");
  return body;
}

describe("reasoning controls through scripted HTTP", () => {
  it("sends the exact OpenAI effort on chat completions and does not add a generic thinking budget", async () => {
    const values = { reasoningEffort: "xhigh" };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]),
    );
    globalThis.fetch = fetchMock;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:18081",
      model: "gpt-5.6-sol",
      modelControls: controls("openai", values),
      modelBehavior: values,
    });
    await collect(backend.runTurn({ ...input, reasoning: { maxTokens: 3000 } }));
    const sent = JSON.parse(requestBody(fetchMock.mock.calls[0]!));
    expect(sent.reasoning_effort).toBe("xhigh");
    expect(sent).not.toHaveProperty("thinking");
  });

  it("keeps an explicit DeepSeek toggle on shape retries even if the server rejects it", async () => {
    const values = { reasoningEnabled: false };
    const rejected = () =>
      new Response(JSON.stringify({ error: { message: "thinking is unsupported" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => rejected());
    globalThis.fetch = fetchMock;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:18081",
      model: "deepseek-example",
      modelControls: controls("deepseek", values),
      modelBehavior: values,
    });
    const events = (await collect(backend.runTurn(input))) as Array<{
      type: string;
      payload: { code?: string };
    }>;
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetchMock.mock.calls) {
      const sent = JSON.parse(requestBody(call));
      expect(sent.thinking).toEqual({ type: "disabled" });
    }
    expect(
      events.some(
        (event) => event.type === "agent.error" && event.payload.code === "http_api_error",
      ),
    ).toBe(true);
  });

  it("reserves answer tokens beyond a selected reasoning budget", async () => {
    const values = { reasoningBudgetTokens: 8000 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]),
    );
    globalThis.fetch = fetchMock;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:18081",
      model: "router-example",
      modelControls: controls("openrouter", values),
      modelBehavior: values,
    });
    await collect(backend.runTurn(input));
    const sent = JSON.parse(requestBody(fetchMock.mock.calls[0]!));
    expect(sent.reasoning.max_tokens).toBe(8000);
    expect(sent.max_tokens).toBe(12_096);
  });

  it("fails before inference when a configured output ceiling cannot fit a selected budget", async () => {
    const values = { reasoningBudgetTokens: 8000 };
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:18081",
      model: "router-example",
      modelControls: controls("openrouter", values),
      modelBehavior: values,
      modelLimits: { maxOutputTokens: 8000 },
    });
    const events = (await collect(backend.runTurn(input))) as Array<{
      type: string;
      payload: { failure?: { retryable?: boolean } };
    }>;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.at(-1)?.payload.failure?.retryable).toBe(false);
  });

  it("replays DeepSeek reasoning_content unchanged after a tool call", async () => {
    const values = { reasoningEffort: "high" };
    const responses = [
      sse([
        { choices: [{ delta: { reasoning_content: "first " }, finish_reason: null }] },
        { choices: [{ delta: { reasoning_content: "thought" }, finish_reason: null }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "tool-example", function: { name: "lookup", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
      sse([{ choices: [{ delta: { content: "found" }, finish_reason: "stop" }] }]),
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift() ?? sse([]),
    );
    globalThis.fetch = fetchMock;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:18081",
      model: "deepseek-example",
      modelControls: controls("deepseek", values, "reasoning_content"),
      modelBehavior: values,
    });
    const tool = {
      name: "lookup",
      description: "Invented lookup",
      schema: z.object({}),
      async invoke() {
        return { kind: "error" as const, code: "example", message: "synthetic result" };
      },
    };
    await collect(backend.runTurn({ ...input, tools: [tool] }));
    const second = JSON.parse(requestBody(fetchMock.mock.calls[1]!));
    expect(
      second.messages.find((message: { role: string }) => message.role === "assistant")
        .reasoning_content,
    ).toBe("first thought");
    expect(second.reasoning_effort).toBe("high");
  });

  it("uses model-specific replay facts rather than the serving provider name", async () => {
    const tool = {
      name: "lookup",
      description: "Invented lookup",
      schema: z.object({}),
      async invoke() {
        return { kind: "error" as const, code: "example", message: "synthetic result" };
      },
    };
    for (const [providerId, field, expected] of [
      ["deepseek", undefined, false],
      ["openrouter", "reasoning_content", true],
    ] as const) {
      const responses = [
        sse([
          {
            choices: [
              {
                delta:
                  providerId === "openrouter"
                    ? { reasoning: "exact trace" }
                    : { reasoning_content: "exact trace" },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "tool-example", function: { name: "lookup", arguments: "{}" } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]),
        sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]),
      ];
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift() ?? sse([]),
      );
      globalThis.fetch = fetchMock;
      const backend = new HttpChatBackend({
        baseUrl: "http://localhost:18081",
        model: "example-model",
        modelControls: controls(providerId, {}, field),
      });
      await collect(backend.runTurn({ ...input, tools: [tool] }));
      const second = JSON.parse(requestBody(fetchMock.mock.calls[1]!));
      const assistant = second.messages.find(
        (message: { role: string }) => message.role === "assistant",
      );
      if (expected) expect(assistant.reasoning_content).toBe("exact trace");
      else expect(assistant).not.toHaveProperty("reasoning_content");
    }
  });

  it("replays structured reasoning_details without converting signatures to text", async () => {
    const blocks = [
      { type: "reasoning.text", text: "synthetic trace", signature: "example-signature", index: 0 },
      { type: "reasoning.encrypted", data: "example-opaque-data", index: 1 },
    ];
    const responses = [
      sse([
        { choices: [{ delta: { reasoning_details: [blocks[0]] }, finish_reason: null }] },
        { choices: [{ delta: { reasoning_details: [blocks[1]] }, finish_reason: null }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "tool-example", function: { name: "lookup", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
      sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]),
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift() ?? sse([]),
    );
    globalThis.fetch = fetchMock;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:18081",
      model: "minimax/example",
      modelControls: controls("openrouter", {}, "reasoning_details"),
    });
    const tool = {
      name: "lookup",
      description: "Invented lookup",
      schema: z.object({}),
      async invoke() {
        return { kind: "error" as const, code: "example", message: "synthetic result" };
      },
    };
    const events = (await collect(backend.runTurn({ ...input, tools: [tool] }))) as Array<{
      type: string;
      payload?: { delta?: string; reasoningDetails?: unknown[] };
    }>;
    const second = JSON.parse(requestBody(fetchMock.mock.calls[1]!));
    const assistant = second.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant.reasoning_details).toEqual(blocks);
    expect(assistant).not.toHaveProperty("reasoning_content");
    expect(
      events
        .filter((event) => event.type === "agent.thinking.delta")
        .map((event) => event.payload?.delta),
    ).toEqual(["synthetic trace"]);
    expect(
      events.find((event) => event.type === "agent.tool.start")?.payload?.reasoningDetails,
    ).toEqual(blocks);

    const history = [
      {
        role: "assistant" as const,
        parts: [
          {
            kind: "tool_use" as const,
            toolCallId: "tool-example",
            tool: "lookup",
            args: {},
            reasoningDetails: blocks,
          },
        ],
      },
    ];
    expect(
      convertHistoryToOpenAI(history, "next", "system", false, true)[1]?.reasoning_details,
    ).toEqual(blocks);
    expect(convertHistoryToOpenAI(history, "next", "system")[1]).not.toHaveProperty(
      "reasoning_details",
    );
  });

  it("preserves reasoning_details on the non-streaming tool-call fallback", async () => {
    const details = [
      { type: "reasoning.encrypted", data: "example-opaque-data", format: "example-format" },
    ];
    const rejected = new Response(JSON.stringify({ error: { message: "stream unavailable" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    const responses = [
      rejected,
      new Response(JSON.stringify({ error: { message: "stream unavailable" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                reasoning_details: details,
                tool_calls: [
                  {
                    id: "tool-example",
                    function: { name: "lookup", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]),
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift() ?? sse([]),
    );
    globalThis.fetch = fetchMock;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:18081",
      model: "minimax/example",
      modelControls: controls("openrouter", {}, "reasoning_details"),
    });
    const tool = {
      name: "lookup",
      description: "Invented lookup",
      schema: z.object({}),
      async invoke() {
        return { kind: "error" as const, code: "example", message: "synthetic result" };
      },
    };
    const events = (await collect(backend.runTurn({ ...input, tools: [tool] }))) as Array<{
      type: string;
      payload?: { reasoningDetails?: unknown[] };
    }>;
    const followUp = JSON.parse(requestBody(fetchMock.mock.calls[3]!));
    const assistant = followUp.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant.reasoning_details).toEqual(details);
    expect(
      events.find((event) => event.type === "agent.tool.start")?.payload?.reasoningDetails,
    ).toEqual(details);
  });

  it("replays persisted reasoning only for models declaring the field", () => {
    const history = [
      {
        role: "assistant" as const,
        parts: [
          { kind: "thinking" as const, text: "exact trace" },
          { kind: "tool_use" as const, toolCallId: "tool-example", tool: "lookup", args: {} },
        ],
      },
    ];
    expect(convertHistoryToOpenAI(history, "next", "system", true)[1]).toHaveProperty(
      "reasoning_content",
      "exact trace",
    );
    expect(convertHistoryToOpenAI(history, "next", "system")[1]).not.toHaveProperty(
      "reasoning_content",
    );
  });

  it("separates Mistral structured thinking chunks from the visible answer", async () => {
    const values = { reasoningEffort: "high" };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      sse([
        {
          choices: [
            {
              delta: {
                content: [
                  {
                    type: "thinking",
                    thinking: [{ type: "text", text: "internal example trace" }],
                  },
                  { type: "text", text: "visible answer" },
                ],
              },
              finish_reason: "stop",
            },
          ],
        },
      ]),
    );
    globalThis.fetch = fetchMock;
    const backend = new HttpChatBackend({
      baseUrl: "http://localhost:18081",
      model: "mistral-example",
      modelControls: controls("mistral", values),
      modelBehavior: values,
    });
    const events = (await collect(backend.runTurn(input))) as Array<{
      type: string;
      payload: { delta?: string };
    }>;
    expect(
      events
        .filter((event) => event.type === "agent.thinking.delta")
        .map((event) => event.payload.delta),
    ).toEqual(["internal example trace"]);
    expect(
      events
        .filter((event) => event.type === "agent.text.delta")
        .map((event) => event.payload.delta),
    ).toEqual(["visible answer"]);
  });

  it("sends Responses reasoning effort to both token count and generation", async () => {
    const values = { reasoningEffort: "high" };
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) =>
      String(url).endsWith("/input_tokens")
        ? new Response(JSON.stringify({ input_tokens: 8 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : sse([
            { type: "response.output_text.delta", delta: "done" },
            {
              type: "response.completed",
              response: { id: "response-example", usage: { input_tokens: 8, output_tokens: 1 } },
            },
          ]),
    );
    globalThis.fetch = fetchMock;
    const backend = new OpenAIResponsesBackend({
      baseUrl: "http://localhost:18081",
      model: "gpt-5.6-sol",
      modelControls: controls("openai", values),
      modelBehavior: values,
    });
    await collect(backend.runTurn(input));
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(requestBody(call)));
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.reasoning?.effort === "high")).toBe(true);
  });
});
