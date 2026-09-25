// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HttpCompleter } from "./http-completer.js";

const FAKE_URL = "http://localhost:55555";
const FAKE_MODEL = "test-model";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init ?? {});
  }) as typeof globalThis.fetch;
}

function completionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── Success path ─────────────────────────────────────────────────────

describe("HttpCompleter.complete — success", () => {
  it("uses Responses and nested reasoning effort on OpenAI's official endpoint", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    mockFetch((url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: "verified answer" }] }],
          usage: { input_tokens: 12, output_tokens: 7 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const completer = new HttpCompleter({
      baseUrl: "https://api.openai.com",
      model: "gpt-5.6-luna",
      allowRemoteInference: true,
      modelControls: {
        providerId: "openai",
        source: "models.dev",
        reasoning: true,
        controls: [
          {
            key: "reasoningEffort",
            type: "enum",
            label: "Reasoning effort",
            values: ["low", "high"],
          },
        ],
        logoUrl: "/model-logos/openai.svg",
      },
      modelBehavior: { reasoningEffort: "low" },
    });

    await expect(completer.completeWithUsage("invented prompt")).resolves.toEqual({
      text: "verified answer",
      usage: { promptTokens: 12, completionTokens: 7 },
    });
    expect(capturedUrl).toBe("https://api.openai.com/v1/responses");
    expect(capturedBody).toMatchObject({
      model: "gpt-5.6-luna",
      input: "invented prompt",
      max_output_tokens: 2048,
      reasoning: { effort: "low" },
    });
    expect(capturedBody.reasoning_effort).toBeUndefined();
  });

  it("honors an explicitly pinned chat-completions protocol on OpenAI", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return completionResponse("pinned answer");
    });
    const completer = new HttpCompleter({
      baseUrl: "https://api.openai.com",
      model: "gpt-5.6-luna",
      protocol: "chat-completions",
      allowRemoteInference: true,
      modelControls: {
        providerId: "openai",
        source: "models.dev",
        reasoning: true,
        controls: [
          {
            key: "reasoningEffort",
            type: "enum",
            label: "Reasoning effort",
            values: ["low", "high"],
          },
        ],
        logoUrl: "/model-logos/openai.svg",
      },
      modelBehavior: { reasoningEffort: "low" },
    });

    await expect(completer.complete("invented prompt")).resolves.toBe("pinned answer");
    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("sends saved provider-native reasoning fields on a completion role and preserves them on retry", async () => {
    const bodies: Record<string, unknown>[] = [];
    mockFetch((_url, init) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return bodies.length === 1
        ? new Response("unsupported max_tokens", { status: 400 })
        : completionResponse("verified answer");
    });
    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: "gpt-example",
      modelControls: {
        providerId: "openai",
        source: "models.dev",
        reasoning: true,
        controls: [
          {
            key: "reasoningEffort",
            type: "enum",
            label: "Reasoning effort",
            values: ["low", "high"],
          },
        ],
        logoUrl: "/model-logos/openai.svg",
      },
      modelBehavior: { reasoningEffort: "high" },
    });
    expect(await completer.complete("invented prompt")).toBe("verified answer");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.reasoning_effort).toBe("high");
    expect(bodies[1]?.reasoning_effort).toBe("high");
    expect(bodies[1]?.max_completion_tokens).toBe(2048);
  });

  it("sends the correct request shape and extracts content", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};
    let capturedMethod = "";

    mockFetch((url, init) => {
      capturedUrl = url;
      capturedMethod = init.method ?? "";
      capturedHeaders = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return completionResponse("completion text");
    });

    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: FAKE_MODEL,
    });

    const result = await completer.complete("tell me about X");

    expect(result).toBe("completion text");
    expect(capturedUrl).toBe(`${FAKE_URL}/v1/chat/completions`);
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedBody.model).toBe(FAKE_MODEL);
    expect(capturedBody.messages).toEqual([{ role: "user", content: "tell me about X" }]);
    expect(capturedBody.max_tokens).toBe(150);
    expect(capturedBody.temperature).toBe(0.3);
    // stop should not be present when not provided
    expect(capturedBody.stop).toBeUndefined();
  });

  it("passes custom maxTokens, temperature, and stop sequences", async () => {
    let capturedBody: Record<string, unknown> = {};

    mockFetch((_url, init) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return completionResponse("ok");
    });

    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: FAKE_MODEL,
    });

    await completer.complete("query", {
      maxTokens: 300,
      temperature: 0.7,
      stop: ["\n", "###"],
    });

    expect(capturedBody.max_tokens).toBe(300);
    expect(capturedBody.temperature).toBe(0.7);
    expect(capturedBody.stop).toEqual(["\n", "###"]);
  });

  it("returns empty string when choices are empty", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: FAKE_MODEL,
    });

    const result = await completer.complete("query");
    expect(result).toBe("");
  });

  it("sends Authorization header when apiKey is provided", async () => {
    let capturedHeaders: Record<string, string> = {};

    mockFetch((_url, init) => {
      capturedHeaders = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
      return completionResponse("ok");
    });

    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: FAKE_MODEL,
      apiKey: "sk-test-key",
    });

    await completer.complete("query");
    expect(capturedHeaders["Authorization"]).toBe("Bearer sk-test-key");
  });

  it("does not send Authorization header when apiKey is omitted", async () => {
    let capturedHeaders: Record<string, string> = {};

    mockFetch((_url, init) => {
      capturedHeaders = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
      return completionResponse("ok");
    });

    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: FAKE_MODEL,
    });

    await completer.complete("query");
    expect(capturedHeaders["Authorization"]).toBeUndefined();
  });

  it("strips trailing slashes from the base URL", async () => {
    let capturedUrl = "";

    mockFetch((url) => {
      capturedUrl = url;
      return completionResponse("ok");
    });

    const completer = new HttpCompleter({
      baseUrl: "http://localhost:8000///",
      model: FAKE_MODEL,
    });

    await completer.complete("query");
    expect(capturedUrl).toBe("http://localhost:8000/v1/chat/completions");
  });
});

// ── Error handling ───────────────────────────────────────────────────

describe("HttpCompleter.complete — errors", () => {
  it("throws with a descriptive message on non-OK HTTP status", async () => {
    mockFetch(() => new Response("Internal Server Error", { status: 500 }));

    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: FAKE_MODEL,
    });

    await expect(completer.complete("query")).rejects.toThrow(/HTTP completer 500/);
  });

  it("does not leak the upstream response body into the error (SEC-16)", async () => {
    // The prompt carries the user's query; a hostile/misconfigured backend can
    // echo it back in its error body. The thrown (and logged) error must report
    // only metadata — status, model, byte length, content-type — never the body.
    const echoed = "detailed error echoing the private query back";
    mockFetch(() => new Response(echoed, { status: 422 }));

    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: FAKE_MODEL,
    });

    const err = await completer.complete("query").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toContain(echoed);
    // ...but still carries the status and model for diagnostics.
    expect(err?.message).toMatch(/HTTP completer 422/);
  });

  it("propagates network errors", async () => {
    mockFetch(() => {
      throw new Error("Connection refused");
    });

    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: FAKE_MODEL,
    });

    await expect(completer.complete("query")).rejects.toThrow(/Connection refused/);
  });
});

// ── Reasoning-model parameter retry ──────────────────────────────────

describe("HttpCompleter.complete — 400 retry", () => {
  it("retries once with max_completion_tokens and no temperature on a 400", async () => {
    const bodies: Record<string, unknown>[] = [];
    mockFetch((_url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'" } }),
          { status: 400 },
        );
      }
      return completionResponse("completion after retry");
    });

    const completer = new HttpCompleter({ baseUrl: FAKE_URL, model: FAKE_MODEL });
    const result = await completer.complete("query", { stop: ["###"] });

    expect(result).toBe("completion after retry");
    expect(bodies).toHaveLength(2);
    // First attempt: the preferred shape.
    expect(bodies[0].max_tokens).toBe(150);
    expect(bodies[0].temperature).toBe(0.3);
    expect(bodies[0].stop).toEqual(["###"]);
    // Retry: the reasoning-model-safe shape, with a budget large enough to fit
    // hidden reasoning tokens before the visible answer.
    expect(bodies[1].max_completion_tokens).toBe(2048);
    expect(bodies[1].max_tokens).toBeUndefined();
    expect(bodies[1].temperature).toBeUndefined();
    expect(bodies[1].stop).toBeUndefined();
  });

  it("re-issues with a larger budget when a 200 returns empty content + finish_reason length", async () => {
    const bodies: Record<string, unknown>[] = [];
    mockFetch((_url, init) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      if (bodies.length === 1) {
        // Reasoning model accepted the request but spent the whole budget on
        // hidden chain-of-thought: empty content, finish_reason "length".
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return completionResponse("completion after budget bump");
    });

    const completer = new HttpCompleter({ baseUrl: FAKE_URL, model: FAKE_MODEL });
    const result = await completer.complete("query");

    expect(result).toBe("completion after budget bump");
    expect(bodies).toHaveLength(2);
    expect(bodies[1].max_completion_tokens).toBe(2048);
  });

  it("does not re-issue on a normal empty-but-stopped response", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const completer = new HttpCompleter({ baseUrl: FAKE_URL, model: FAKE_MODEL });
    await completer.complete("query");
    expect(calls).toBe(1);
  });

  it("strips inline <think>…</think> reasoning from the returned content", async () => {
    mockFetch(() => completionResponse("<think>let me reason</think>SUBJECT: cats"));
    const completer = new HttpCompleter({ baseUrl: FAKE_URL, model: FAKE_MODEL });
    const result = await completer.complete("query");
    expect(result).toBe("SUBJECT: cats");
  });

  it("honors a custom apiPathPrefix in the request URL", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return completionResponse("ok");
    });
    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: FAKE_MODEL,
      apiPathPrefix: "/v1beta/openai",
    });
    await completer.complete("query");
    expect(capturedUrl).toBe(`${FAKE_URL}/v1beta/openai/chat/completions`);
  });

  it("does not retry when the first attempt succeeds", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return completionResponse("ok");
    });
    const completer = new HttpCompleter({ baseUrl: FAKE_URL, model: FAKE_MODEL });
    await completer.complete("query");
    expect(calls).toBe(1);
  });

  it("throws when both the primary request and the retry 400", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return new Response("bad request", { status: 400 });
    });
    const completer = new HttpCompleter({ baseUrl: FAKE_URL, model: FAKE_MODEL });
    await expect(completer.complete("query")).rejects.toThrow(/HTTP completer 400/);
    expect(calls).toBe(2);
  });

  it("does not retry on non-400 errors", async () => {
    let calls = 0;
    mockFetch(() => {
      calls++;
      return new Response("server error", { status: 500 });
    });
    const completer = new HttpCompleter({ baseUrl: FAKE_URL, model: FAKE_MODEL });
    await expect(completer.complete("query")).rejects.toThrow(/HTTP completer 500/);
    expect(calls).toBe(1);
  });

  it("retries a rate limit twice before succeeding", async () => {
    vi.useFakeTimers();
    let calls = 0;
    mockFetch(() => {
      calls++;
      return calls < 3 ? new Response("limited", { status: 429 }) : completionResponse("ok");
    });
    const completer = new HttpCompleter({ baseUrl: FAKE_URL, model: FAKE_MODEL });
    const pending = completer.complete("query");
    await vi.waitFor(() => expect(calls).toBe(1));
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toBe("ok");
    expect(calls).toBe(3);
  });
});

// ── Metadata ─────────────────────────────────────────────────────────

describe("HttpCompleter metadata", () => {
  it("exposes name and modelId", () => {
    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: "my-model-id",
    });
    expect(completer.name).toBe("http");
    expect(completer.modelId).toBe("my-model-id");
  });

  it("dispose resolves without error", async () => {
    const completer = new HttpCompleter({
      baseUrl: FAKE_URL,
      model: FAKE_MODEL,
    });
    await expect(completer.dispose()).resolves.toBeUndefined();
  });
});
