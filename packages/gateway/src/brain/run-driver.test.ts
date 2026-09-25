// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger, type AgentEvent } from "@omnesis/core";
import {
  CognitionRunDriver,
  defaultCognitionPrompt,
  type CognitionRunDriverDeps,
} from "./run-driver.js";
import { FsCognitionTranscriptStore } from "./transcripts.js";
import type { ChatBackend, TurnInput } from "@omnesis/agent";
import type { ClaimedCognitionRun } from "./storage/types.js";

const log = createLogger("test").child("run-driver");

/**
 * A zero-token scripted backend: emits a fixed event script per turn,
 * echoing the session/message ids the session allocated. Also records
 * the prompts it was sent so tests can assert on the run envelope.
 */
function scriptedBackend(
  script: (input: TurnInput) => AgentEvent[],
  prompts: string[] = [],
): ChatBackend {
  return {
    name: "scripted",
    model: "scripted-model",
    // eslint-disable-next-line @typescript-eslint/require-await
    async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      prompts.push(input.userMessage);
      for (const event of script(input)) yield event;
    },
  };
}

function happyScript(text: string, usage?: { inputTokens: number; outputTokens: number }) {
  return (input: TurnInput): AgentEvent[] => [
    {
      type: "agent.message.start",
      payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
    },
    {
      type: "agent.text.delta",
      payload: { sessionId: input.sessionId, messageId: input.messageId, delta: text },
    },
    {
      type: "agent.message.end",
      payload: {
        sessionId: input.sessionId,
        messageId: input.messageId,
        stopReason: "end_turn",
        ...(usage ? { usage } : {}),
      },
    },
  ];
}

function claimed(overrides: Partial<ClaimedCognitionRun> = {}): ClaimedCognitionRun {
  return { id: "run_1", kind: "data", payload: { docId: "doc_a" }, attempts: 1, ...overrides };
}

describe("CognitionRunDriver", () => {
  let dir: string;
  let transcripts: FsCognitionTranscriptStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-run-driver-"));
    transcripts = new FsCognitionTranscriptStore(join(dir, "t"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDriver(overrides: Partial<CognitionRunDriverDeps>): CognitionRunDriver {
    return new CognitionRunDriver({
      resolveBackend: () => scriptedBackend(happyScript("ok")),
      transcripts,
      log,
      clock: () => 5000,
      ...overrides,
    });
  }

  test("a successful run harvests text + usage and persists a transcript", async () => {
    const driver = makeDriver({
      resolveBackend: () =>
        scriptedBackend(happyScript("all clear", { inputTokens: 100, outputTokens: 25 })),
    });
    const outcome = await driver.execute(claimed());
    expect(outcome.ok).toBe(true);
    expect(outcome.finalText).toBe("all clear");
    // Spend attribution: the resolved backend's model id rides the outcome.
    expect(outcome.modelId).toBe("scripted-model");
    expect(outcome.usage).toEqual({
      promptTokens: 100,
      completionTokens: 25,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    const refs = transcripts.list();
    expect(refs).toHaveLength(1);
    const t = transcripts.load(refs[0]!.fileName);
    expect(t).toMatchObject({
      runId: "run_1",
      attempt: 1,
      kind: "data",
      outcome: "completed",
      finalText: "all clear",
      usage: {
        promptTokens: 100,
        completionTokens: 25,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    expect(t.events.map((e) => e.type)).toContain("agent.message.end");
  });

  test("the transcript persists the run payload, minus the transient fold snapshot", async () => {
    const driver = makeDriver({});
    await driver.execute(
      claimed({
        payload: {
          docId: "doc_a",
          event: "updated",
          datumAt: 500,
          diff: "-old line\n+new line",
          snapshot: { content: "the entire previous body", capturedAt: 400 },
        },
      }),
    );
    const t = transcripts.load(transcripts.list()[0]!.fileName);
    // The snapshot is the pre-update body — it may live only on the
    // pending queue row (no-prior-version-storage), never in a file.
    expect(t.payload).toEqual({
      docId: "doc_a",
      event: "updated",
      datumAt: 500,
      diff: "-old line\n+new line",
    });
  });

  test("cache tokens count as prompt-side usage", async () => {
    const driver = makeDriver({
      resolveBackend: () =>
        scriptedBackend((input) => [
          {
            type: "agent.message.start",
            payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
          },
          {
            type: "agent.text.delta",
            payload: { sessionId: input.sessionId, messageId: input.messageId, delta: "ok" },
          },
          {
            type: "agent.message.end",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              stopReason: "end_turn",
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 90,
                cacheCreationTokens: 40,
              },
            },
          },
        ]),
    });
    const outcome = await driver.execute(claimed());
    expect(outcome.usage).toEqual({
      promptTokens: 140,
      completionTokens: 5,
      cacheReadTokens: 90,
      cacheCreationTokens: 40,
    });
  });

  test("the default prompt envelope states run id, attempt, kind, and payload", async () => {
    const prompts: string[] = [];
    const driver = makeDriver({
      resolveBackend: () => scriptedBackend(happyScript("ok"), prompts),
    });
    await driver.execute(claimed({ id: "run_42", kind: "feedback", attempts: 1 }));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Run id: run_42");
    expect(prompts[0]).toContain("Attempt: 1");
    expect(prompts[0]).toContain("Kind: feedback");
    expect(prompts[0]).toContain('"docId":"doc_a"');
  });

  test("a re-attempt's prompt carries the attempt number", () => {
    const prompt = defaultCognitionPrompt(claimed({ attempts: 3 }));
    expect(prompt).toContain("Attempt: 3");
  });

  test("a throwing backend fails the run softly and still writes a transcript", async () => {
    const driver = makeDriver({
      resolveBackend: () => ({
        name: "broken",
        model: "broken-model",
        // A backend that dies before emitting a single event.
        // eslint-disable-next-line @typescript-eslint/require-await, require-yield
        async *runTurn(): AsyncIterable<AgentEvent> {
          throw new Error("connection reset");
        },
      }),
    });
    const outcome = await driver.execute(claimed());
    expect(outcome.ok).toBe(false);
    expect(outcome.errorMessage).toContain("connection reset");
    const refs = transcripts.list();
    expect(refs).toHaveLength(1);
    expect(transcripts.load(refs[0]!.fileName).outcome).toBe("failed");
  });

  test("an async prompt-builder failure returns a retryable outcome instead of throwing", async () => {
    const driver = makeDriver({
      promptBuilder: () => Promise.reject(new Error("temporal projection read unavailable")),
    });

    await expect(driver.execute(claimed())).resolves.toMatchObject({
      ok: false,
      errorMessage: "temporal projection read unavailable",
      modelId: "scripted-model",
      usage: null,
      finalText: "",
      citations: [],
      openedDocIds: [],
    });
    // No model session started, so there is no transcript to persist.
    expect(transcripts.list()).toEqual([]);
  });

  test("a canceled turn is not a completed run", async () => {
    const driver = makeDriver({
      resolveBackend: () =>
        scriptedBackend((input) => [
          {
            type: "agent.message.start",
            payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
          },
          {
            type: "agent.message.end",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              stopReason: "canceled",
            },
          },
        ]),
    });
    const outcome = await driver.execute(claimed());
    // The completion promise resolves on a cancel, but no work happened —
    // the run must stay eligible for retry.
    expect(outcome.ok).toBe(false);
    expect(outcome.errorMessage).toContain("canceled");
  });

  test("a context-window terminal failure is structured and non-retryable", async () => {
    const driver = makeDriver({
      resolveBackend: () =>
        scriptedBackend((input) => [
          {
            type: "agent.message.end",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              stopReason: "error",
              failure: {
                code: "context_window_exceeded",
                message: "prompt is too long",
                retryable: false,
                backend: "scripted",
                model: "scripted-model",
              },
              context: {
                inputTokens: 8_500,
                peakInputTokens: 8_500,
                contextWindowTokens: 8_192,
                reservedOutputTokens: 1_024,
                safetyMarginTokens: 128,
                measurement: "provider_count",
                limitSource: "configured",
                requestIteration: 1,
              },
            },
          },
        ]),
    });

    const outcome = await driver.execute(claimed());

    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "context_window_exceeded", retryable: false },
      context: {
        inputTokens: 8_500,
        contextWindowTokens: 8_192,
        measurement: "provider_count",
      },
    });
    const transcript = transcripts.load(transcripts.list()[0]!.fileName);
    expect(transcript).toMatchObject({
      outcome: "failed",
      failureCode: "context_window_exceeded",
      context: {
        inputTokens: 8_500,
        peakInputTokens: 8_500,
        contextWindowTokens: 8_192,
        requestIteration: 1,
      },
    });
  });

  test("max_tokens is an output_truncated machine-workflow failure", async () => {
    const driver = makeDriver({
      resolveBackend: () =>
        scriptedBackend((input) => [
          {
            type: "agent.text.delta",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              delta: "unfinished",
            },
          },
          {
            type: "agent.citation",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              toolCallId: "tc_evidence",
              documentId: "doc_evidence",
              ref: {
                documentId: "doc_evidence",
                sourceType: "fictional-source",
                sourceId: "fictional-account",
              },
            },
          },
          {
            type: "agent.message.end",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              stopReason: "max_tokens",
            },
          },
        ]),
    });

    const outcome = await driver.execute(claimed());

    expect(outcome).toMatchObject({
      ok: false,
      finalText: "unfinished",
      citations: [
        {
          documentId: "doc_evidence",
          sourceType: "fictional-source",
          sourceId: "fictional-account",
        },
      ],
      failure: { code: "output_truncated", retryable: false },
    });
    const transcript = transcripts.load(transcripts.list()[0]!.fileName);
    expect(transcript).toMatchObject({
      outcome: "failed",
      failureCode: "output_truncated",
      finalText: "unfinished",
    });
    expect(transcript.events).toContainEqual(
      expect.objectContaining({
        type: "agent.citation",
        payload: expect.objectContaining({ documentId: "doc_evidence" }),
      }),
    );
  });

  test("an unavailable backend fails softly without a transcript (no session ran)", async () => {
    const driver = makeDriver({ resolveBackend: () => null });
    const outcome = await driver.execute(claimed());
    expect(outcome.ok).toBe(false);
    expect(outcome.errorMessage).toContain("backend unavailable");
    expect(outcome.modelId).toBeNull();
    expect(transcripts.list()).toEqual([]);
  });

  test("the prompt-builder and system-prompt seams are honoured", async () => {
    const prompts: string[] = [];
    const systemPrompts: string[] = [];
    const driver = makeDriver({
      resolveBackend: () =>
        scriptedBackend((input) => {
          systemPrompts.push(input.systemPrompt);
          return happyScript("ok")(input);
        }, prompts),
      promptBuilder: (run) => `custom prompt for ${run.id}`,
      systemPrompt: () => "custom system prompt",
    });
    await driver.execute(claimed());
    expect(prompts).toEqual(["custom prompt for run_1"]);
    expect(systemPrompts).toEqual(["custom system prompt"]);
  });

  test("passes the resolved model id to per-run tools and completion validation", async () => {
    const seen: string[] = [];
    const driver = makeDriver({
      buildTools: (_run, context) => {
        seen.push(`tools:${context.modelId}`);
        return [];
      },
      validateRun: (_run, context) => {
        seen.push(`validate:${context.modelId}`);
        return null;
      },
    });

    await expect(driver.execute(claimed())).resolves.toMatchObject({ ok: true });
    expect(seen).toEqual(["tools:scripted-model", "validate:scripted-model"]);
  });

  test("fails closed when post-turn validation reports incomplete durable work", async () => {
    const driver = makeDriver({
      validateRun: () => "subscription precision decisions remain pending",
    });

    await expect(driver.execute(claimed())).resolves.toMatchObject({
      ok: false,
      errorMessage: "subscription precision decisions remain pending",
    });
    const transcript = transcripts.load(transcripts.list()[0]!.fileName);
    expect(transcript.outcome).toBe("failed");
    expect(transcript.errorMessage).toBe("subscription precision decisions remain pending");
  });

  test("fails closed when post-turn validation itself throws", async () => {
    const driver = makeDriver({
      validateRun: () => {
        throw new Error("precision state unavailable");
      },
    });

    await expect(driver.execute(claimed())).resolves.toMatchObject({
      ok: false,
      errorMessage: "precision state unavailable",
    });
  });
});
