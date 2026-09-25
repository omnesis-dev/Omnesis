// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { CodexCompleter } from "./codex-completer.js";
import type { AgentEvent, AgentMessageEndEvent } from "@omnesis/core";
import type { ChatBackend } from "@omnesis/agent";

const ids = { sessionId: "session", messageId: "message" };
function backend(events: AgentEvent[]): ChatBackend {
  return {
    name: "codex",
    model: "example-model",
    runTurn: vi.fn(async function* () {
      yield* events;
    }),
    dispose: vi.fn(async () => {}),
  };
}
const delta: AgentEvent = {
  type: "agent.text.delta",
  payload: { ...ids, delta: "NEUTRAL STOP ignored" },
};
const end = (extra: Partial<AgentMessageEndEvent> = {}): AgentEvent => ({
  type: "agent.message.end",
  payload: { ...ids, stopReason: "end_turn", ...extra },
});

describe("CodexCompleter", () => {
  test("uses fresh tool-free turns, returns terminal usage and applies stop strings", async () => {
    const model = backend([delta, end({ usage: { inputTokens: 23, outputTokens: 7 } })]);
    const completer = new CodexCompleter({ backend: model });
    expect(
      await completer.completeWithUsage("Classify", {
        stop: [" STOP"],
        images: [{ url: "data:image/png;base64,AAAA" }],
      }),
    ).toEqual({ text: "NEUTRAL", usage: { promptTokens: 23, completionTokens: 7 } });
    await completer.complete("Again");
    const calls = vi.mocked(model.runTurn).mock.calls;
    expect(calls[0]![0]).toMatchObject({
      history: [],
      tools: [],
      userMessage: "Classify",
      images: [{ url: "data:image/png;base64,AAAA" }],
    });
    expect(calls[0]![0].sessionId).not.toEqual(calls[1]![0].sessionId);
    await completer.dispose();
    expect(model.dispose).not.toHaveBeenCalled();
  });

  test.each(["error", "canceled", "max_tokens", "tool_use"] as const)(
    "rejects partial text with terminal %s",
    async (stopReason) => {
      const completer = new CodexCompleter({ backend: backend([delta, end({ stopReason })]) });
      await expect(completer.complete("Classify")).rejects.toThrow();
    },
  );

  test("terminal failure is authoritative even with end_turn and output", async () => {
    const completer = new CodexCompleter({
      backend: backend([
        delta,
        end({
          failure: {
            code: "internal_error",
            message: "Failed to complete",
            retryable: true,
            backend: "codex",
            model: "example-model",
          },
        }),
      ]),
    });
    await expect(completer.complete("Classify")).rejects.toThrow("Failed to complete");
  });

  test("requires terminal result but permits successful empty output", async () => {
    await expect(
      new CodexCompleter({ backend: backend([delta]) }).complete("Classify"),
    ).rejects.toThrow("terminal result");
    expect(
      await new CodexCompleter({ backend: backend([end()]) }).completeWithUsage("Read blank image"),
    ).toEqual({ text: "", usage: null });
  });

  test("deadline interrupts even a queued backend that has not yielded", async () => {
    let signal: AbortSignal | undefined;
    const model: ChatBackend = {
      name: "codex",
      model: "example-model",
      async *runTurn(_input, cancellation) {
        yield* [];
        signal = cancellation;
        await new Promise<void>(() => {});
      },
    };
    const completer = new CodexCompleter({ backend: model, timeoutMs: 10 });
    await expect(completer.complete("Classify")).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
  });

  test("disposal cancels only this adapter's pending calls", async () => {
    const model: ChatBackend = {
      name: "codex",
      model: "example-model",
      async *runTurn() {
        yield* [];
        await new Promise<void>(() => {});
      },
      dispose: vi.fn(async () => {}),
    };
    const completer = new CodexCompleter({ backend: model });
    const pending = expect(completer.complete("Classify")).rejects.toThrow("disposed");
    await completer.dispose();
    await pending;
    await expect(completer.complete("Again")).rejects.toThrow("disposed");
    expect(model.dispose).not.toHaveBeenCalled();
  });

  test("caller cancellation aborts an active completion", async () => {
    const model: ChatBackend = {
      name: "codex",
      model: "example-model",
      async *runTurn() {
        yield* [];
        await new Promise<void>(() => {});
      },
    };
    const completer = new CodexCompleter({ backend: model });
    const controller = new AbortController();
    const pending = expect(
      completer.complete("Classify", { signal: controller.signal }),
    ).rejects.toThrow("Canceled by caller");
    controller.abort(new Error("Canceled by caller"));
    await pending;
  });
});

describe("Codex completion over the app-server protocol", () => {
  test.each(["completion-phases", "completion-unphased"])(
    "returns only final text with %s",
    async (scenario) => {
      const { model, cleanup } = await fakeBackend(scenario);
      try {
        const completer = new CodexCompleter({ backend: model });
        expect(await completer.completeWithUsage("Classify the claim")).toEqual({
          text: "NEUTRAL",
          usage: { promptTokens: 12, completionTokens: 7 },
        });
        await completer.dispose();
      } finally {
        await cleanup();
      }
    },
  );

  test.each(["native-output", "completion-no-final", "quota"])(
    "rejects %s without returning a verdict",
    async (scenario) => {
      const { model, cleanup } = await fakeBackend(scenario);
      try {
        await expect(
          new CodexCompleter({ backend: model }).complete("Classify the claim"),
        ).rejects.toThrow();
      } finally {
        await cleanup();
      }
    },
  );

  test("deadline bounds a real app-server turn", async () => {
    const { model, cleanup } = await fakeBackend("hang");
    try {
      const completer = new CodexCompleter({ backend: model, timeoutMs: 200 });
      await expect(completer.complete("Classify the claim")).rejects.toThrow("timed out");
      await completer.dispose();
    } finally {
      await cleanup();
    }
  });
});

async function fakeBackend(scenario: string) {
  const { CodexAppServerBackend } = await import("@omnesis/agent");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = await mkdtemp(join(tmpdir(), "omnesis-codex-completion-"));
  const fake = fileURLToPath(
    new URL("../../../agent/src/test-fixtures/fake-codex-app-server.mjs", import.meta.url),
  );
  const model = new CodexAppServerBackend({
    model: "example-model",
    codexHome: join(dir, "home"),
    command: process.execPath,
    args: [fake],
    versionArgs: [fake, "--version"],
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    env: { ...process.env, OMNESIS_FAKE_CODEX_SCENARIO: scenario },
  });
  return {
    model,
    cleanup: async () => {
      await model.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
