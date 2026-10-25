// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger, type AgentEvent } from "@omnesis/core";
import {
  CognitionRunDriver,
  contextHandoffThreshold,
  defaultCognitionPrompt,
  type CognitionRunDriverDeps,
} from "./run-driver.js";
import { knowledgeFrontierPreflight } from "./knowledge/engine-frontier.js";
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

  test.each([true, false])(
    "resolves an organization-only turn only when completion is ready (%s)",
    async (readyToComplete) => {
      let resolutions = 0;
      const prompts: string[] = [];
      const driver = makeDriver({
        preflight: async () =>
          knowledgeFrontierPreflight({
            done: false,
            items: [],
            organization: {
              id: "cohort",
              inputFingerprint: "inputs",
              sourceIds: ["a", "b"],
              readyToComplete,
            },
          }),
        resolveBackend: () => {
          resolutions++;
          return scriptedBackend(happyScript("Joint outcome recorded."), prompts);
        },
      });
      const outcome = await driver.execute(
        claimed({
          kind: "synthesis",
          payload: { focus: "knowledge-maintenance", batchId: "batch" },
        }),
      );
      expect(resolutions).toBe(readyToComplete ? 1 : 0);
      expect(prompts).toHaveLength(readyToComplete ? 1 : 0);
      expect(outcome.ok).toBe(readyToComplete);
      if (!readyToComplete)
        expect(outcome).toMatchObject({ modelId: null, usage: null, deferredUntil: 20000 });
    },
  );

  test("keeps completed and bounded-progress frontiers unpaid", () => {
    expect(
      knowledgeFrontierPreflight({
        done: true,
        items: [],
        organization: {
          id: "cohort",
          inputFingerprint: "inputs",
          sourceIds: [],
          readyToComplete: true,
        },
      }),
    ).toBe("complete");
    expect(knowledgeFrontierPreflight({ done: false, items: [], continuation: true })).toBe(
      "yield",
    );
    expect(knowledgeFrontierPreflight({ done: false, items: [] })).toBe("defer");
    expect(
      knowledgeFrontierPreflight({
        done: false,
        items: [],
        candidateDecisions: [{ id: "candidate", revision: 2 }],
      }),
    ).toBe("continue");
  });

  test("settles a gated maintenance frontier before resolving any model backend", async () => {
    let resolutions = 0;
    const driver = makeDriver({
      preflight: async () => "complete",
      resolveBackend: () => {
        resolutions++;
        return null;
      },
    });
    const outcome = await driver.execute(
      claimed({ kind: "synthesis", payload: { focus: "knowledge-maintenance", batchId: "batch" } }),
    );
    expect(outcome).toMatchObject({ ok: true, modelId: null, usage: null });
    expect(resolutions).toBe(0);
  });

  test("defers incomplete deterministic inputs without a model attempt", async () => {
    const driver = makeDriver({
      preflight: async () => "defer",
      resolveBackend: () => {
        throw new Error("must not resolve");
      },
    });
    expect(await driver.execute(claimed())).toMatchObject({
      ok: false,
      deferredUntil: 20000,
      modelId: null,
      usage: null,
    });
  });

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

  test("uses terminal totals once rather than adding cumulative live usage", async () => {
    const driver = makeDriver({
      resolveBackend: () =>
        scriptedBackend((input) => {
          const events = happyScript("done", { inputTokens: 100, outputTokens: 25 })(input);
          events.splice(1, 0, {
            type: "agent.usage.update",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              usage: { inputTokens: 80, outputTokens: 20 },
            },
          });
          return events;
        }),
    });
    expect((await driver.execute(claimed())).usage).toMatchObject({
      promptTokens: 100,
      completionTokens: 25,
    });
  });

  test("every run of a workflow shares one stable prompt cache key, and each model call is probed", async () => {
    const inputs: TurnInput[] = [];
    const driver = makeDriver({
      resolveBackend: () =>
        scriptedBackend((input) => {
          inputs.push(input);
          return happyScript("ok")(input);
        }),
    });
    const datum = { docId: "doc_a", event: "created", datumAt: 1_700_000_000_000 };
    await driver.execute(claimed({ id: "run_a", payload: datum }));
    await driver.execute(
      claimed({ id: "run_b", attempts: 2, payload: { ...datum, docId: "doc_b" } }),
    );
    await driver.execute(claimed({ id: "run_c", kind: "bootstrap" }));
    // Two workflows of one kind get distinct keys: their tools and instructions differ.
    await driver.execute(claimed({ id: "run_d", kind: "time_based", payload: { prompt: "p" } }));
    await driver.execute(
      claimed({ id: "run_e", kind: "time_based", payload: { decayCheckLoopId: "loop_1" } }),
    );
    expect(inputs.map((input) => input.promptCacheKey)).toEqual([
      "omnesis-cognition:datum-intake",
      "omnesis-cognition:datum-intake",
      "omnesis-cognition:source-bootstrap",
      "omnesis-cognition:time-reaction",
      "omnesis-cognition:loop-decay-check",
    ]);
    // The per-call cache accounting reaches the backend on every run.
    for (const input of inputs) expect(typeof input.llmProbe).toBe("function");
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

  test.each([true, false])(
    "stops a handoff only when trusted durable state confirms it: %s",
    async (confirmed) => {
      let continued = false;
      const backend: ChatBackend = {
        name: "scripted",
        model: "scripted-model",
        async *runTurn(input, signal) {
          yield happyScript("", { inputTokens: 10, outputTokens: 2 })(input)[0]!;
          yield {
            type: "agent.tool.start",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              toolCallId: "handoff",
              tool: "open_loop_update",
              args: {},
            },
          };
          yield {
            type: "agent.tool.result",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              toolCallId: "handoff",
              result: { kind: "error", code: "maintenance_handoff", message: "Requeued" },
              durationMs: 0,
            },
          };
          if (signal?.aborted) return;
          continued = true;
          yield happyScript("Continued", { inputTokens: 10, outputTokens: 2 })(input)[2]!;
        },
      };
      const driver = makeDriver({ resolveBackend: () => backend, isRunHandedOff: () => confirmed });
      const outcome = await driver.execute(
        claimed({
          kind: "synthesis",
          payload: { focus: "knowledge-maintenance", batchId: "batch" },
        }),
      );
      expect(outcome.ok).toBe(true);
      expect(continued).toBe(!confirmed);
      expect(transcripts.load(transcripts.list()[0]!.fileName)).toMatchObject({
        outcome: "completed",
      });
    },
  );

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
    const routedRuns: Array<string | undefined> = [];
    const driver = makeDriver({
      resolveBackend: () =>
        scriptedBackend((input) => {
          systemPrompts.push(input.systemPrompt);
          return happyScript("ok")(input);
        }, prompts),
      promptBuilder: (run) => `custom prompt for ${run.id}`,
      systemPrompt: (run) => {
        routedRuns.push(run?.id);
        return "custom system prompt";
      },
    });
    await driver.execute(claimed());
    expect(prompts).toEqual(["custom prompt for run_1"]);
    expect(systemPrompts).toEqual(["custom system prompt"]);
    expect(routedRuns).toEqual(["run_1"]);
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

  test("retains a tool-level cap signal when a backend ends normally with incomplete work", async () => {
    const driver = makeDriver({
      resolveBackend: () =>
        scriptedBackend((input) => {
          const events = happyScript("Segment stopped", { inputTokens: 10, outputTokens: 2 })(
            input,
          );
          events.splice(
            1,
            0,
            {
              type: "agent.usage.update",
              payload: {
                sessionId: input.sessionId,
                messageId: input.messageId,
                usage: { inputTokens: 10, outputTokens: 2 },
              },
            },
            {
              type: "agent.tool.start",
              payload: {
                sessionId: input.sessionId,
                messageId: input.messageId,
                toolCallId: "cap",
                tool: "knowledge_reference",
                args: {},
              },
            },
            {
              type: "agent.tool.result",
              payload: {
                sessionId: input.sessionId,
                messageId: input.messageId,
                toolCallId: "cap",
                result: { kind: "error", code: "tool_iteration_cap", message: "Tool cap reached" },
                durationMs: 0,
              },
            },
          );
          return events;
        }),
      validateRun: () => "Knowledge batch has remaining work",
    });
    const outcome = await driver.execute(claimed());
    expect(outcome).toMatchObject({
      ok: false,
      toolLimitReached: true,
      usage: { promptTokens: 10, completionTokens: 2 },
    });
    const transcript = transcripts.load(transcripts.list()[0]!.fileName);
    expect(transcript.outcome).toBe("failed");
    expect(transcript.events.some((event) => event.type === "agent.tool.result")).toBe(true);
  });

  test("cancels at the first tool cap and preserves settled tools and observed cumulative usage", async () => {
    let continued = false;
    const backend: ChatBackend = {
      name: "scripted",
      model: "scripted-model",
      async *runTurn(input, signal) {
        yield happyScript("")(input)[0]!;
        for (const tokens of [20, 30])
          yield {
            type: "agent.usage.update",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              usage: { inputTokens: tokens, outputTokens: 7 },
            },
          };
        yield {
          type: "agent.tool.start",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            toolCallId: "saved",
            tool: "knowledge_save",
            args: {},
          },
        };
        yield {
          type: "agent.tool.result",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            toolCallId: "saved",
            durationMs: 0,
            result: { kind: "structured", resultType: "saved", data: { revision: 2 } },
          },
        };
        yield {
          type: "agent.tool.start",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            toolCallId: "cap",
            tool: "knowledge_reference",
            args: {},
          },
        };
        yield {
          type: "agent.tool.result",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            toolCallId: "cap",
            durationMs: 0,
            result: { kind: "error", code: "tool_iteration_cap", message: "Tool cap reached" },
          },
        };
        continued = !signal?.aborted;
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: signal?.aborted ? "canceled" : "end_turn",
            usage: { inputTokens: 30, outputTokens: 7 },
          },
        };
      },
    };
    const outcome = await makeDriver({ resolveBackend: () => backend }).execute(claimed());
    expect(continued).toBe(false);
    expect(outcome).toMatchObject({
      ok: false,
      toolLimitReached: true,
      failure: { code: "tool_iteration_cap", retryable: false },
      usage: { promptTokens: 30, completionTokens: 7 },
    });
    const transcript = transcripts.load(transcripts.list()[0]!.fileName);
    expect(transcript.failureCode).toBe("tool_iteration_cap");
    expect(transcript.events.filter((event) => event.type === "agent.tool.result")).toHaveLength(2);
    expect(transcript.usage).toMatchObject({ promptTokens: 30, completionTokens: 7 });
  });

  /**
   * A tool loop whose every model request reports its input size live: each
   * request answers with two tool calls, and the backend stops issuing
   * requests once the session is cancelled.
   */
  function growingContextBackend(
    inputs: number[],
    opts: { window?: number; requests?: number[] } = {},
  ): ChatBackend {
    return {
      name: "scripted",
      model: "scripted-model",
      async *runTurn(input, signal) {
        const ids = { sessionId: input.sessionId, messageId: input.messageId };
        yield happyScript("")(input)[0]!;
        let peak = 0;
        for (const [index, inputTokens] of inputs.entries()) {
          if (signal?.aborted) break;
          opts.requests?.push(inputTokens);
          peak = Math.max(peak, inputTokens);
          yield {
            type: "agent.usage.update",
            payload: {
              ...ids,
              usage: { inputTokens: peak * (index + 1), outputTokens: 5 * (index + 1) },
              context: {
                inputTokens,
                peakInputTokens: peak,
                ...(opts.window ? { contextWindowTokens: opts.window } : {}),
                measurement: "provider_reported",
                limitSource: opts.window ? "provider" : "unknown",
                requestIteration: index + 1,
              },
            },
          };
          for (const call of ["first", "second"])
            yield {
              type: "agent.tool.start",
              payload: { ...ids, toolCallId: `${call}-${index}`, tool: "knowledge_save", args: {} },
            };
          for (const call of ["first", "second"])
            yield {
              type: "agent.tool.result",
              payload: {
                ...ids,
                toolCallId: `${call}-${index}`,
                durationMs: 0,
                result: { kind: "structured", resultType: "saved", data: { revision: index } },
              },
            };
        }
        yield {
          type: "agent.message.end",
          payload: {
            ...ids,
            stopReason: signal?.aborted ? "canceled" : "end_turn",
            usage: { inputTokens: peak * inputs.length, outputTokens: 5 * inputs.length },
          },
        };
      },
    };
  }

  test("counts a fetched document as opened only when the run read it whole", async () => {
    const backend: ChatBackend = {
      name: "scripted",
      model: "scripted-model",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runTurn(input) {
        const ids = { sessionId: input.sessionId, messageId: input.messageId };
        yield happyScript("")(input)[0]!;
        yield {
          type: "agent.tool.start",
          payload: {
            ...ids,
            toolCallId: "read",
            tool: "fetch_many",
            args: {
              documents: [
                { documentId: "doc_whole" },
                { documentId: "doc_paged" },
                { documentId: "doc_missing" },
              ],
            },
          },
        };
        const ref = (documentId: string) => ({
          documentId,
          sourceType: "notes",
          sourceId: "notes",
        });
        yield {
          type: "agent.tool.result",
          payload: {
            ...ids,
            toolCallId: "read",
            durationMs: 0,
            result: {
              kind: "document.batch",
              items: [
                { kind: "document", ref: ref("doc_whole"), document: { id: "doc_whole" } },
                {
                  kind: "document",
                  ref: ref("doc_paged"),
                  document: { id: "doc_paged", contentRange: { truncated: true } },
                },
                { kind: "error", code: "not_found", message: "missing" },
              ],
            },
          },
        };
        yield happyScript("done")(input).at(-1)!;
      },
    };
    const outcome = await makeDriver({ resolveBackend: () => backend }).execute(claimed());
    expect(outcome.openedDocIds).toEqual(["doc_whole"]);
  });

  test("derives the handoff threshold from a reported limit, else the fallback", () => {
    const budget = { ratio: 0.65, fallbackTokens: 120_000 };
    const reading = {
      measurement: "provider_reported",
      limitSource: "provider",
      requestIteration: 1,
    } as const;
    expect(contextHandoffThreshold(budget, undefined)).toBe(120_000);
    expect(contextHandoffThreshold(budget, { ...reading, contextWindowTokens: 400_000 })).toBe(
      260_000,
    );
    // An input-only limit wins over a combined window that includes output.
    expect(
      contextHandoffThreshold(budget, {
        ...reading,
        maxInputTokens: 200_000,
        contextWindowTokens: 264_000,
      }),
    ).toBe(130_000);
  });

  test("hands off once the request that crossed the budget has finished its tool calls", async () => {
    const requests: number[] = [];
    const outcome = await makeDriver({
      resolveBackend: () => growingContextBackend([1_000, 3_000, 6_000, 9_000], { requests }),
      contextBudget: () => ({ ratio: 0.65, fallbackTokens: 5_000 }),
    }).execute(claimed());
    // The third request crossed 5,000 tokens; its two saves still ran and no
    // fourth request was sent.
    expect(requests).toEqual([1_000, 3_000, 6_000]);
    expect(outcome).toMatchObject({
      ok: false,
      contextHandoff: "context_budget",
      failure: { code: "context_budget", retryable: false },
      usage: {
        promptTokens: 18_000,
        completionTokens: 15,
        context: { peakInputTokens: 6_000, lastInputTokens: 6_000 },
      },
    });
    expect(outcome.toolLimitReached).toBeUndefined();
    const transcript = transcripts.load(transcripts.list()[0]!.fileName);
    expect(transcript.failureCode).toBe("context_budget");
    expect(transcript.events.filter((event) => event.type === "agent.tool.result")).toHaveLength(6);
    // The cancelled turn has no terminal reading; the last live one is kept.
    expect(transcript.context).toMatchObject({ inputTokens: 6_000, peakInputTokens: 6_000 });
  });

  test("measures the budget against the model's reported window", async () => {
    const requests: number[] = [];
    const outcome = await makeDriver({
      resolveBackend: () =>
        growingContextBackend([1_000, 3_000, 6_000, 9_000], { window: 10_000, requests }),
      contextBudget: () => ({ ratio: 0.5, fallbackTokens: 1_000 }),
    }).execute(claimed());
    expect(requests).toEqual([1_000, 3_000, 6_000]);
    expect(outcome.usage?.context).toEqual({
      peakInputTokens: 6_000,
      lastInputTokens: 6_000,
      contextWindowTokens: 10_000,
    });
  });

  test("leaves a run without a budget to finish, recording its peak input", async () => {
    const requests: number[] = [];
    const outcome = await makeDriver({
      resolveBackend: () => growingContextBackend([1_000, 3_000, 6_000, 9_000], { requests }),
      contextBudget: () => null,
    }).execute(claimed());
    expect(requests).toHaveLength(4);
    expect(outcome.ok).toBe(true);
    expect(outcome.contextHandoff).toBeUndefined();
    expect(outcome.usage?.context).toMatchObject({ peakInputTokens: 9_000 });
  });

  test("reports a context-window refusal as a context handoff", async () => {
    const backend: ChatBackend = {
      name: "scripted",
      model: "scripted-model",
      // eslint-disable-next-line @typescript-eslint/require-await
      async *runTurn(input) {
        const ids = { sessionId: input.sessionId, messageId: input.messageId };
        yield happyScript("")(input)[0]!;
        yield {
          type: "agent.error",
          payload: { ...ids, code: "context_window_exceeded", message: "too long" },
        };
        yield {
          type: "agent.message.end",
          payload: {
            ...ids,
            stopReason: "error",
            usage: { inputTokens: 900, outputTokens: 4 },
            context: {
              inputTokens: 210_000,
              peakInputTokens: 210_000,
              maxInputTokens: 200_000,
              measurement: "provider_count",
              limitSource: "provider",
              requestIteration: 7,
            },
            failure: {
              code: "context_window_exceeded",
              message: "too long",
              retryable: false,
            },
          },
        };
      },
    };
    const outcome = await makeDriver({ resolveBackend: () => backend }).execute(claimed());
    expect(outcome).toMatchObject({
      ok: false,
      contextHandoff: "context_window_exceeded",
      failure: { code: "context_window_exceeded" },
      usage: {
        context: {
          peakInputTokens: 210_000,
          lastInputTokens: 210_000,
          contextWindowTokens: 200_000,
        },
      },
    });
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
