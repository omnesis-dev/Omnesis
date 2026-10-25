// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { recordCognitionSpend } from "../brain/storage/spend.js";
import { LlmJudgeEntailmentVerifier, type EntailmentUsage } from "./entailment-loader.js";
import { AgentTurnCompleter } from "./agent-turn-completer.js";
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

describe("AgentTurnCompleter", () => {
  test("uses fresh tool-free turns, returns terminal usage and applies stop strings", async () => {
    const model = backend([delta, end({ usage: { inputTokens: 23, outputTokens: 7 } })]);
    const completer = new AgentTurnCompleter({ backend: model });
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

  test.each([
    { inputTokens: 23, outputTokens: 7, cacheReadTokens: 50, cacheCreationTokens: 3 },
    { inputTokens: 23, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { inputTokens: 23, outputTokens: 7 },
  ])("preserves reported cache through the verifier and spend sink: %j", async (reported) => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE cognition_spend (
      day TEXT, mechanism TEXT, model_id TEXT, runs INTEGER,
      prompt_tokens INTEGER, completion_tokens INTEGER,
      cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      PRIMARY KEY(day, mechanism, model_id))`);
    const receipts: EntailmentUsage[] = [];
    const completer = new AgentTurnCompleter({
      backend: backend([delta, end({ usage: reported })]),
    });
    const verifier = new LlmJudgeEntailmentVerifier({
      completer: {
        modelId: completer.modelId,
        complete: (prompt, options) => completer.completeWithUsage(prompt, options),
        dispose: () => completer.dispose(),
      },
      getPromptStyle: () => "judge",
      recordUsage: (receipt) => {
        receipts.push(receipt);
        recordCognitionSpend(db, "2026-01-01", "entailment-gate", receipt.modelId, receipt);
      },
    });
    try {
      await verifier.verify({ claim: "The lantern is blue.", evidence: "The lantern is red." });
      const cacheRead = "cacheReadTokens" in reported ? reported.cacheReadTokens : undefined;
      const cacheCreation =
        "cacheCreationTokens" in reported ? reported.cacheCreationTokens : undefined;
      expect(receipts).toEqual([
        {
          modelId: "example-model",
          promptTokens: 23 + (cacheRead ?? 0) + (cacheCreation ?? 0),
          completionTokens: 7,
          ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
          ...(cacheCreation !== undefined ? { cacheCreationTokens: cacheCreation } : {}),
        },
      ]);
      expect(
        db
          .prepare(
            "SELECT prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens FROM cognition_spend",
          )
          .get(),
      ).toEqual({
        prompt_tokens: 23 + (cacheRead ?? 0) + (cacheCreation ?? 0),
        completion_tokens: 7,
        cache_read_tokens: cacheRead ?? 0,
        cache_creation_tokens: cacheCreation ?? 0,
      });
    } finally {
      await verifier.dispose();
      db.close();
    }
  });

  test.each(["error", "canceled", "max_tokens", "tool_use"] as const)(
    "rejects partial text with terminal %s",
    async (stopReason) => {
      const completer = new AgentTurnCompleter({ backend: backend([delta, end({ stopReason })]) });
      await expect(completer.complete("Classify")).rejects.toThrow();
    },
  );

  test("terminal failure is authoritative even with end_turn and output", async () => {
    const completer = new AgentTurnCompleter({
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
      new AgentTurnCompleter({ backend: backend([delta]) }).complete("Classify"),
    ).rejects.toThrow("terminal result");
    expect(
      await new AgentTurnCompleter({ backend: backend([end()]) }).completeWithUsage(
        "Read blank image",
      ),
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
    const completer = new AgentTurnCompleter({ backend: model, timeoutMs: 10 });
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
    const completer = new AgentTurnCompleter({ backend: model });
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
    const completer = new AgentTurnCompleter({ backend: model });
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
        const completer = new AgentTurnCompleter({ backend: model });
        expect(await completer.completeWithUsage("Classify the claim")).toEqual({
          text: "NEUTRAL",
          // The whole turn (`total`), cached input included: 30 in, 11 out.
          usage: {
            promptTokens: 30,
            completionTokens: 11,
            cacheReadTokens: 20,
          },
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
          new AgentTurnCompleter({ backend: model }).complete("Classify the claim"),
        ).rejects.toThrow();
      } finally {
        await cleanup();
      }
    },
  );

  test("deadline bounds a real app-server turn", async () => {
    const { model, cleanup } = await fakeBackend("hang");
    try {
      const completer = new AgentTurnCompleter({ backend: model, timeoutMs: 200 });
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
