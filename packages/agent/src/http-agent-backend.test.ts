// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HttpAgentBackend } from "./http-agent-backend.js";
import type { AgentEvent } from "@omnesis/core";
import type { ModelControls } from "@omnesis/core/models";

// ─── Helpers ────────────────────────────────────────────────────────────

const baseInput = () => ({
  sessionId: "S",
  messageId: "M",
  history: [],
  userMessage: "hi",
  tools: [],
  systemPrompt: "sys",
});

/** Chat-completions SSE (data: only). */
function chatSSE(frames: Array<Record<string, unknown> | "[DONE]">): Response {
  const encoder = new TextEncoder();
  const body = frames
    .map((f) => (f === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(f)}\n\n`))
    .join("");
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(body));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

/** Responses SSE (event:/data: frames). */
function responsesSSE(frames: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const body = frames
    .map((f) => `event: ${f.type as string}\ndata: ${JSON.stringify(f)}\n\n`)
    .join("");
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(body));
        c.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const textOf = (events: AgentEvent[]) =>
  events
    .filter((e) => e.type === "agent.text.delta")
    .map((e) => (e.payload as { delta: string }).delta)
    .join("");

const urlsOf = (m: ReturnType<typeof vi.fn>) => m.mock.calls.map((c) => String(c[0]));

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const newRouter = (protocol?: "chat-completions" | "responses") =>
  new HttpAgentBackend({
    baseUrl: "http://localhost:18084",
    model: "o1-pro",
    apiKey: "k",
    protocol,
  });

const openAIReasoningControls: ModelControls = {
  providerId: "openai",
  source: "models.dev",
  reasoning: true,
  controls: [
    {
      key: "reasoningEffort",
      type: "enum",
      label: "Reasoning effort",
      values: ["low", "medium", "high"],
    },
  ],
  logoUrl: "/model-logos/openai.svg",
};

describe("HttpAgentBackend protocol routing", () => {
  it("auto-detects a Responses-only model from the chat-completions 404 and reroutes", async () => {
    const fetchMock = vi
      .fn()
      // chat-completions 404 — the real o1-pro body points at v1/responses.
      .mockResolvedValueOnce(
        json(
          {
            error: {
              message:
                "This model is only supported in v1/responses and not in v1/chat/completions.",
            },
          },
          404,
        ),
      )
      // Responses input counting is unsupported by this compatible endpoint.
      .mockResolvedValueOnce(json({ error: { message: "not found" } }, 404))
      // responses stream succeeds
      .mockResolvedValueOnce(
        responsesSSE([
          { type: "response.created", response: { id: "r" } },
          { type: "response.output_text.delta", delta: "Hello from Responses" },
          {
            type: "response.completed",
            response: { id: "r", usage: { input_tokens: 1, output_tokens: 2 } },
          },
        ]),
      );
    globalThis.fetch = fetchMock;

    const events = await collect(newRouter().runTurn(baseInput()));

    // The chat-completions 404 error is NOT surfaced; the responses answer is.
    expect(events.some((e) => e.type === "agent.error")).toBe(false);
    expect(textOf(events)).toBe("Hello from Responses");
    // Exactly one message.start (the chat attempt's was discarded on reroute).
    expect(events.filter((e) => e.type === "agent.message.start")).toHaveLength(1);
    const urls = urlsOf(fetchMock);
    expect(urls[0]).toContain("/chat/completions");
    expect(urls[1]).toContain("/responses/input_tokens");
    expect(urls[2]).toMatch(/\/responses$/);
  });

  it("remembers the responses decision so later turns skip chat-completions", async () => {
    let chatCalls = 0;
    let countCalls = 0;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        chatCalls++;
        return Promise.resolve(json({ error: { message: "This is not a chat model" } }, 404));
      }
      if (url.endsWith("/responses/input_tokens")) {
        countCalls++;
        return Promise.resolve(json({ error: { message: "not found" } }, 404));
      }
      return Promise.resolve(
        responsesSSE([
          { type: "response.created", response: { id: "r" } },
          { type: "response.output_text.delta", delta: "ok" },
          { type: "response.completed", response: { id: "r", usage: {} } },
        ]),
      );
    });
    globalThis.fetch = fetchMock;

    const router = newRouter();
    await collect(router.runTurn(baseInput())); // detects → responses
    await collect(router.runTurn(baseInput())); // should go straight to responses

    const urls = urlsOf(fetchMock);
    expect(chatCalls).toBe(1);
    expect(countCalls).toBe(1);
    expect(urls.filter((u) => /\/responses$/.test(u))).toHaveLength(2);
  });

  it("stays on chat-completions when the model streams normally", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      chatSSE([
        { choices: [{ delta: { content: "hi from chat" }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        "[DONE]",
      ]),
    );
    globalThis.fetch = fetchMock;

    const events = await collect(newRouter().runTurn(baseInput()));
    expect(textOf(events)).toBe("hi from chat");
    expect(urlsOf(fetchMock).every((u) => u.includes("/chat/completions"))).toBe(true);
  });

  it("surfaces a non-protocol error (e.g. 401) without rerouting to responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ error: { message: "invalid api key" } }, 401));
    globalThis.fetch = fetchMock;

    const events = await collect(newRouter().runTurn(baseInput()));
    const err = events.find((e) => e.type === "agent.error");
    expect((err!.payload as { message: string }).message).toBe(
      "The model provider rejected the API credentials — check the key for this backend (HTTP 401).",
    );
    expect((err!.payload as { message: string }).message).not.toContain("invalid api key");
    expect(urlsOf(fetchMock).some((u) => u.includes("/responses"))).toBe(false);
  });

  it("does NOT reroute when a chat model streams content and then the stream errors", async () => {
    // Once content has streamed the router has committed to chat-completions;
    // a later error must surface, not trigger a reroute (the `!sawContent`
    // guard). A real protocol-mismatch 404 only ever arrives before any output.
    const encoder = new TextEncoder();
    let pulls = 0;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        // Pull-based so the content frame is delivered before the error (a
        // synchronous error() in start() would discard the queued chunk).
        new ReadableStream({
          pull(c) {
            if (pulls++ === 0) {
              c.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
                ),
              );
            } else {
              c.error(new Error("connection reset"));
            }
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    globalThis.fetch = fetchMock;

    const events = await collect(newRouter().runTurn(baseInput()));
    expect(textOf(events)).toBe("partial"); // content streamed before the error
    expect(events.some((e) => e.type === "agent.error")).toBe(true); // error surfaced
    expect(urlsOf(fetchMock).some((u) => u.includes("/responses"))).toBe(false); // no reroute
  });

  it("honors an explicit protocol:responses (no chat-completions probe)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      responsesSSE([
        { type: "response.created", response: { id: "r" } },
        { type: "response.output_text.delta", delta: "direct" },
        { type: "response.completed", response: { id: "r", usage: {} } },
      ]),
    );
    globalThis.fetch = fetchMock;

    const events = await collect(newRouter("responses").runTurn(baseInput()));
    expect(textOf(events)).toBe("direct");
    expect(urlsOf(fetchMock).every((u) => u.includes("/responses"))).toBe(true);
  });

  it("uses Responses directly for saved reasoning effort on the official OpenAI endpoint", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        String(input).endsWith("/responses/input_tokens")
          ? json({ error: { message: "not found" } }, 404)
          : responsesSSE([
              { type: "response.created", response: { id: "r" } },
              { type: "response.output_text.delta", delta: "direct reasoning" },
              { type: "response.completed", response: { id: "r", usage: {} } },
            ]),
      ),
    );
    globalThis.fetch = fetchMock;

    const router = new HttpAgentBackend({
      baseUrl: "https://api.openai.com",
      model: "gpt-5.6-luna",
      apiKey: "k",
      allowRemoteInference: true,
      modelControls: openAIReasoningControls,
      modelBehavior: { reasoningEffort: "low" },
    });
    const events = await collect(router.runTurn(baseInput()));

    expect(textOf(events)).toBe("direct reasoning");
    expect(urlsOf(fetchMock).every((url) => url.includes("/responses"))).toBe(true);
    const request = JSON.parse(
      String(
        (fetchMock.mock.calls.at(-1) as [RequestInfo | URL, RequestInit] | undefined)?.[1].body,
      ),
    ) as {
      reasoning?: { effort?: string };
    };
    expect(request.reasoning).toEqual({ effort: "low" });
  });

  it("honors an explicitly pinned protocol even when OpenAI reasoning effort is saved", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        chatSSE([
          { choices: [{ delta: { content: "pinned" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          "[DONE]",
        ]),
      );
    globalThis.fetch = fetchMock;

    const router = new HttpAgentBackend({
      baseUrl: "https://api.openai.com",
      model: "gpt-5.6-luna",
      apiKey: "k",
      protocol: "chat-completions",
      allowRemoteInference: true,
      modelControls: openAIReasoningControls,
      modelBehavior: { reasoningEffort: "low" },
    });

    expect(textOf(await collect(router.runTurn(baseInput())))).toBe("pinned");
    expect(urlsOf(fetchMock).every((url) => url.includes("/chat/completions"))).toBe(true);
  });

  it("keeps auto-detection for an OpenAI-compatible endpoint with saved effort", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        chatSSE([
          { choices: [{ delta: { content: "compatible" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          "[DONE]",
        ]),
      );
    globalThis.fetch = fetchMock;

    const router = new HttpAgentBackend({
      baseUrl: "http://localhost:18084/v1",
      model: "gpt-example",
      apiKey: "k",
      allowRemoteInference: true,
      modelControls: openAIReasoningControls,
      modelBehavior: { reasoningEffort: "low" },
    });
    const events = await collect(router.runTurn(baseInput()));

    expect(textOf(events)).toBe("compatible");
    expect(urlsOf(fetchMock).every((url) => url.includes("/chat/completions"))).toBe(true);
  });
});
