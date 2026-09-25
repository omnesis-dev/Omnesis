// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Callers treat a null return as "this pass is unavailable" and skip their
 * work, so every branch that cannot produce a usable provider must return
 * null rather than throwing or handing back something that fails on first use.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { loadCompletionFromResolved } from "./completion-loader.js";
import { LlamaCppCompleter } from "./llama-cpp-completer.js";
import { CodexCompleter } from "./codex-completer.js";
import { HttpCompleter } from "./http-completer.js";

const deps = { configDir: "/tmp/omnesis-completion-loader-test" };

describe("loadCompletionFromResolved", () => {
  test("local + available → an LlamaCppCompleter over the resolved path", async () => {
    const provider = loadCompletionFromResolved(
      {
        role: "background-agent",
        kind: "local",
        catalogId: "qwen2.5-1.5b-instruct-q4_k_m",
        modelPath: "/models/qwen2.5-1.5b-instruct-q4_k_m.gguf",
        available: true,
      },
      deps,
    );
    expect(provider).toBeInstanceOf(LlamaCppCompleter);
    await provider?.dispose();
  });

  test("local + unavailable → null (model not on disk)", () => {
    expect(
      loadCompletionFromResolved(
        {
          role: "background-agent",
          kind: "local",
          catalogId: "qwen2.5-1.5b-instruct-q4_k_m",
          modelPath: "/models/missing.gguf",
          available: false,
        },
        deps,
      ),
    ).toBeNull();
  });

  test("http + reachable → an HttpCompleter carrying the backend's key", async () => {
    const provider = loadCompletionFromResolved(
      {
        role: "background-agent",
        kind: "http",
        backendKey: "local-vllm",
        url: "http://127.0.0.1:8001",
        model: "qwen-example",
        allowRemoteInference: false,
        available: true,
      },
      { ...deps, getBackendApiKey: () => "key-from-backend" },
    );
    expect(provider).toBeInstanceOf(HttpCompleter);
    await provider?.dispose();
  });

  test("http + unreachable → null", () => {
    expect(
      loadCompletionFromResolved(
        {
          role: "background-agent",
          kind: "http",
          backendKey: "local-vllm",
          url: "http://127.0.0.1:8001",
          model: "qwen-example",
          allowRemoteInference: false,
          available: false,
          reason: "connection refused",
        },
        deps,
      ),
    ).toBeNull();
  });

  test("http pinned to the Responses API → an HttpCompleter", async () => {
    const provider = loadCompletionFromResolved(
      {
        role: "background-agent",
        kind: "http",
        backendKey: "openai",
        url: "https://api.example.com",
        model: "example-responses-only",
        protocol: "responses",
        allowRemoteInference: true,
        available: true,
      },
      deps,
    );
    expect(provider).toBeInstanceOf(HttpCompleter);
    await provider?.dispose();
  });

  test("anthropic with remote inference off → null", () => {
    expect(
      loadCompletionFromResolved(
        {
          role: "background-agent",
          kind: "anthropic",
          catalogId: "anthropic/claude-haiku-4-5-20251001",
          apiModelId: "claude-haiku-4-5-20251001",
          available: true,
          allowRemoteInference: false,
        },
        deps,
      ),
    ).toBeNull();
  });

  test("anthropic with no API key on disk → null", () => {
    expect(
      loadCompletionFromResolved(
        {
          role: "background-agent",
          kind: "anthropic",
          catalogId: "anthropic/claude-haiku-4-5-20251001",
          apiModelId: "claude-haiku-4-5-20251001",
          available: true,
          allowRemoteInference: true,
        },
        { configDir: "/tmp/omnesis-completion-loader-no-such-dir" },
      ),
    ).toBeNull();
  });

  test("disabled → null", () => {
    expect(
      loadCompletionFromResolved({ role: "background-agent", kind: "disabled" }, deps),
    ).toBeNull();
  });

  test("unresolved → null", () => {
    expect(
      loadCompletionFromResolved(
        { role: "background-agent", kind: "unresolved", reason: 'Unknown backend "foo"' },
        deps,
      ),
    ).toBeNull();
  });

  test("replay → null (agent-only backend)", () => {
    expect(
      loadCompletionFromResolved({ role: "background-agent", kind: "replay" }, deps),
    ).toBeNull();
  });

  test("Codex requires egress and availability, and uses the independent inference lane", async () => {
    const createBackend = vi.fn().mockReturnValue({ model: "example-model" });
    const codexDeps = { ...deps, codexRuntimeService: { createBackend } };
    const resolved = {
      role: "background-agent",
      kind: "codex",
      model: "example-model",
      modelBehavior: { reasoningEffort: "high" },
      available: true,
      allowRemoteInference: true,
    } as const;
    const provider = loadCompletionFromResolved(resolved, codexDeps);
    expect(provider).toBeInstanceOf(CodexCompleter);
    expect(createBackend).toHaveBeenCalledWith({
      model: "example-model",
      reasoningEffort: "high",
      lane: "inference",
    });
    await provider?.dispose();
    createBackend.mockClear();
    expect(
      loadCompletionFromResolved({ ...resolved, allowRemoteInference: false }, codexDeps),
    ).toBeNull();
    expect(loadCompletionFromResolved({ ...resolved, available: false }, codexDeps)).toBeNull();
    expect(createBackend).not.toHaveBeenCalled();
  });

  test("codex without a runtime → null", () => {
    expect(
      loadCompletionFromResolved(
        { role: "background-agent", kind: "codex", model: "gpt-example", available: true },
        deps,
      ),
    ).toBeNull();
  });
});

describe("the deadline a caller states", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A backend that accepts the connection and then never answers. */
  function stalls(): void {
    globalThis.fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        }),
    ) as unknown as typeof globalThis.fetch;
  }

  const backend = {
    role: "background-agent",
    kind: "http",
    backendKey: "fictional",
    url: "http://127.0.0.1:9",
    model: "fictional-model",
    available: true,
    allowRemoteInference: false,
    protocol: "chat" as const,
  };

  test("reaches the call, so a long compile is not cut off by a short default", async () => {
    // The compile path sends tens of thousands of tokens and waits for a
    // document back. Left on the completion default — sized for a query
    // expansion — a real compile aborted mid-answer and surfaced as a failure
    // of the request rather than of the deadline.
    stalls();
    const provider = loadCompletionFromResolved(backend as never, { ...deps, timeoutMs: 40 });
    expect(provider).toBeInstanceOf(HttpCompleter);

    const started = Date.now();
    await expect(provider!.complete("anything")).rejects.toThrow();
    expect(Date.now() - started, "the caller's deadline was not the one that fired").toBeLessThan(
      5_000,
    );
  });

  test("leaves the default in place when no deadline is stated", () => {
    stalls();
    expect(loadCompletionFromResolved(backend as never, deps)).toBeInstanceOf(HttpCompleter);
  });
});
