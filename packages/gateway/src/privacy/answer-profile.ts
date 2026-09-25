// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Profiling for the MCP `ask_omnesis` call (`profiling: true`).
 *
 * This module is deliberately scoped: it exists only so an operator can see
 * where wall-clock time goes inside one privacy-reviewed Answer turn. It is
 * not wired into interactive conversations (portal / apps) — those never
 * construct an `AnswerProfiler`.
 *
 * What is collected (numbers only — no prompts, answers, tool arguments, or
 * corpus content ever enter a profile):
 *
 *   - Per-request LLM timings for the answer agent and the privacy
 *     reviewer, reported by the chat backends through `TurnInput.llmProbe`:
 *     time to first content, request wall time, provider-reported tokens.
 *   - Per-tool-call wall time, observed on the session event stream
 *     (`agent.tool.start` names the tool, `agent.tool.result` carries the
 *     backend-measured `durationMs` around `handle.invoke`).
 *   - Worker-queue splits, recorded by the worker layers themselves
 *     (search-worker FIFO wait vs compute, embedder slot wait vs compute)
 *     into the ambient profiler, so queue waiting can be separated from
 *     execution. Recording is a no-op outside a profiled run.
 *   - Store (writer-gate) wall time per operation, timed by the answer
 *     service around its own gate calls.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { z } from "zod";
import type { AgentEvent } from "@omnesis/core";
import type { LlmRequestTiming } from "@omnesis/agent";

export const ANSWER_PROFILE_VERSION = 1;

/** `_meta` key carrying the profile blob on a profiled `ask_omnesis` result. */
export const ANSWER_PROFILE_META_KEY = "dev.omnesis/profile";

export type AnswerProfileLlmRole = "agent" | "reviewer";

export interface AnswerProfileLlmCall {
  requestIndex: number;
  ttftMs: number | null;
  wallMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Output tokens per second of this request's wall time; null without tokens. */
  tps: number | null;
}

export interface AnswerProfileLlmRoleReport {
  /** Model requests issued (one per tool-loop iteration, plus retries). */
  calls: number;
  /** TTFT of the first request that produced content; null when none did. */
  firstTtftMs: number | null;
  /** Sum of request wall times (sequential within a turn — no overlap). */
  totalWallMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Requests that carried provider-reported token counts. */
  tokensReportedCalls: number;
  /**
   * Total output tokens over the wall time of the token-bearing requests.
   * Null when no request reported tokens — never guessed.
   */
  avgTps: number | null;
  requests: AnswerProfileLlmCall[];
}

export interface AnswerProfileToolStat {
  calls: number;
  totalMs: number;
  avgMs: number;
}

export interface AnswerProfileToolsReport {
  calls: number;
  totalMs: number;
  byTool: Record<string, AnswerProfileToolStat>;
}

export interface AnswerProfileQueueSourceStat {
  spans: number;
  queueMs: number;
  execMs: number;
}

export interface AnswerProfileQueuesReport {
  spans: number;
  totalQueueMs: number;
  totalExecMs: number;
  bySource: Record<string, AnswerProfileQueueSourceStat>;
}

export interface AnswerProfileStoreReport {
  calls: number;
  totalMs: number;
  byOp: Record<string, AnswerProfileToolStat>;
}

export interface AnswerProfileReport {
  version: typeof ANSWER_PROFILE_VERSION;
  /** Wall time of the whole profiled answer (generation + review). */
  totalWallMs: number;
  /** Wall time of candidate generation (agent turn). */
  candidateWallMs: number;
  /** Wall time of privacy review (one or two reviewer turns). */
  reviewWallMs: number;
  agent: AnswerProfileLlmRoleReport;
  reviewer: AnswerProfileLlmRoleReport & { reviews: number };
  tools: AnswerProfileToolsReport;
  queues: AnswerProfileQueuesReport;
  store: AnswerProfileStoreReport;
}

const llmCallSchema = z.object({
  requestIndex: z.number(),
  ttftMs: z.number().nullable(),
  wallMs: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  tps: z.number().nullable(),
});

const llmRoleSchema = z.object({
  calls: z.number(),
  firstTtftMs: z.number().nullable(),
  totalWallMs: z.number(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  tokensReportedCalls: z.number(),
  avgTps: z.number().nullable(),
  requests: z.array(llmCallSchema),
});

const toolStatSchema = z.object({
  calls: z.number(),
  totalMs: z.number(),
  avgMs: z.number(),
});

/** Runtime validator for the profile blob — guards the MCP `_meta` shape. */
export const answerProfileReportSchema: z.ZodType<AnswerProfileReport> = z.object({
  version: z.literal(ANSWER_PROFILE_VERSION),
  totalWallMs: z.number(),
  candidateWallMs: z.number(),
  reviewWallMs: z.number(),
  agent: llmRoleSchema,
  reviewer: llmRoleSchema.extend({ reviews: z.number() }),
  tools: z.object({
    calls: z.number(),
    totalMs: z.number(),
    byTool: z.record(z.string(), toolStatSchema),
  }),
  queues: z.object({
    spans: z.number(),
    totalQueueMs: z.number(),
    totalExecMs: z.number(),
    bySource: z.record(
      z.string(),
      z.object({ spans: z.number(), queueMs: z.number(), execMs: z.number() }),
    ),
  }),
  store: z.object({
    calls: z.number(),
    totalMs: z.number(),
    byOp: z.record(z.string(), toolStatSchema),
  }),
});

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class AnswerProfiler {
  private readonly llmCalls: Record<AnswerProfileLlmRole, LlmRequestTiming[]> = {
    agent: [],
    reviewer: [],
  };
  private reviews = 0;
  private readonly toolCalls = new Map<string, number[]>();
  private readonly queueSpans: Array<{ source: string; queueMs: number; execMs: number }> = [];
  private readonly storeOps = new Map<string, number[]>();

  recordLlmCall(role: AnswerProfileLlmRole, timing: LlmRequestTiming): void {
    this.llmCalls[role].push(timing);
  }

  /** Count one reviewer turn (a review may run twice: initial + reduction). */
  countReview(): void {
    this.reviews += 1;
  }

  recordToolCall(tool: string, durationMs: number): void {
    const durations = this.toolCalls.get(tool) ?? [];
    durations.push(Math.max(0, durationMs));
    this.toolCalls.set(tool, durations);
  }

  recordQueueSpan(source: string, queueMs: number, execMs: number): void {
    this.queueSpans.push({
      source,
      queueMs: Math.max(0, queueMs),
      execMs: Math.max(0, execMs),
    });
  }

  recordStoreOp(op: string, wallMs: number): void {
    const walls = this.storeOps.get(op) ?? [];
    walls.push(Math.max(0, wallMs));
    this.storeOps.set(op, walls);
  }

  buildReport(input: { totalWallMs: number; candidateWallMs: number; reviewWallMs: number }): {
    report: AnswerProfileReport;
  } {
    const agent = summarizeLlmCalls(this.llmCalls.agent);
    const reviewerCalls = summarizeLlmCalls(this.llmCalls.reviewer);
    return {
      report: {
        version: ANSWER_PROFILE_VERSION,
        totalWallMs: Math.max(0, Math.round(input.totalWallMs)),
        candidateWallMs: Math.max(0, Math.round(input.candidateWallMs)),
        reviewWallMs: Math.max(0, Math.round(input.reviewWallMs)),
        agent,
        reviewer: { ...reviewerCalls, reviews: this.reviews },
        tools: summarizeDurations(this.toolCalls, "byTool"),
        queues: summarizeQueueSpans(this.queueSpans),
        store: summarizeDurations(this.storeOps, "byOp"),
      },
    };
  }
}

function summarizeLlmCalls(calls: LlmRequestTiming[]): AnswerProfileLlmRoleReport {
  const requests: AnswerProfileLlmCall[] = calls.map((call) => ({
    requestIndex: call.requestIndex,
    ttftMs: call.ttftMs == null ? null : Math.round(call.ttftMs),
    wallMs: Math.round(call.wallMs),
    inputTokens: call.inputTokens ?? null,
    outputTokens: call.outputTokens ?? null,
    tps:
      call.outputTokens == null || call.wallMs <= 0
        ? null
        : round2(call.outputTokens / (call.wallMs / 1000)),
  }));
  const firstTtft = requests.find((request) => request.ttftMs != null)?.ttftMs ?? null;
  const tokenBearing = calls.filter((call) => call.outputTokens != null);
  const tokenWallMs = tokenBearing.reduce((sum, call) => sum + call.wallMs, 0);
  const tokenOutput = tokenBearing.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0);
  return {
    calls: calls.length,
    firstTtftMs: firstTtft,
    totalWallMs: Math.round(calls.reduce((sum, call) => sum + call.wallMs, 0)),
    totalInputTokens: calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
    totalOutputTokens: tokenOutput,
    tokensReportedCalls: tokenBearing.length,
    avgTps: tokenWallMs > 0 ? round2(tokenOutput / (tokenWallMs / 1000)) : null,
    requests,
  };
}

function summarizeDurations<K extends "byTool" | "byOp">(
  byName: ReadonlyMap<string, number[]>,
  key: K,
): { calls: number; totalMs: number } & Record<K, Record<string, AnswerProfileToolStat>> {
  const byNameOut: Record<string, AnswerProfileToolStat> = {};
  let calls = 0;
  let totalMs = 0;
  for (const [name, durations] of byName) {
    const total = durations.reduce((sum, value) => sum + value, 0);
    byNameOut[name] = {
      calls: durations.length,
      totalMs: Math.round(total),
      avgMs: durations.length > 0 ? round2(total / durations.length) : 0,
    };
    calls += durations.length;
    totalMs += total;
  }
  return { calls, totalMs: Math.round(totalMs), [key]: byNameOut } as {
    calls: number;
    totalMs: number;
  } & Record<K, Record<string, AnswerProfileToolStat>>;
}

function summarizeQueueSpans(
  spans: ReadonlyArray<{ source: string; queueMs: number; execMs: number }>,
): AnswerProfileQueuesReport {
  const bySource: Record<string, AnswerProfileQueueSourceStat> = {};
  let totalQueueMs = 0;
  let totalExecMs = 0;
  for (const span of spans) {
    const stat = bySource[span.source] ?? { spans: 0, queueMs: 0, execMs: 0 };
    stat.spans += 1;
    stat.queueMs += span.queueMs;
    stat.execMs += span.execMs;
    bySource[span.source] = stat;
    totalQueueMs += span.queueMs;
    totalExecMs += span.execMs;
  }
  for (const stat of Object.values(bySource)) {
    stat.queueMs = Math.round(stat.queueMs);
    stat.execMs = Math.round(stat.execMs);
  }
  return {
    spans: spans.length,
    totalQueueMs: Math.round(totalQueueMs),
    totalExecMs: Math.round(totalExecMs),
    bySource,
  };
}

/**
 * Observe one agent/reviewer turn's tool calls into the profiler. LLM
 * timings arrive separately through the backend `llmProbe` (per-request
 * spans the event stream cannot reconstruct); this subscription only maps
 * `tool.start` names onto `tool.result` durations.
 */
export function observeSessionForAnswerProfile(
  subscribe: (subscriber: (event: AgentEvent) => void) => () => void,
  profiler: AnswerProfiler,
): () => void {
  const toolNames = new Map<string, string>();
  return subscribe((event) => {
    if (event.type === "agent.tool.start") {
      toolNames.set(event.payload.toolCallId, event.payload.tool);
    } else if (event.type === "agent.tool.result") {
      const tool = toolNames.get(event.payload.toolCallId) ?? "unknown";
      toolNames.delete(event.payload.toolCallId);
      profiler.recordToolCall(tool, event.payload.durationMs);
    }
  });
}

// ─── Ambient queue attribution ────────────────────────────────────────────

/**
 * Ambient profiler for worker layers that cannot take an explicit profiler
 * parameter (tool handles → search pipeline → worker pool cross the tool
 * boundary, and the pool fans out across threads). The answer service sets
 * it for the duration of one profiled run; every recording point is a
 * no-op when no profiled run is ambient, so unprofiled traffic pays one
 * map lookup per worker call and nothing else.
 */
const ambientProfiler = new AsyncLocalStorage<AnswerProfiler>();

export function runWithAnswerProfiler<T>(profiler: AnswerProfiler, fn: () => T): T {
  return ambientProfiler.run(profiler, fn);
}

/**
 * The profiler of the ambient profiled run, if any. Call sites that run
 * inside the profiled async chain (the answer service's own awaits) can use
 * this directly; see the worker note below.
 */
export function ambientAnswerProfiler(): AnswerProfiler | undefined {
  return ambientProfiler.getStore();
}

/**
 * Record a worker queue/exec split into the ambient profiled run, if any.
 * Only valid on the same thread inside the profiled async chain — worker
 * `message` handlers run outside any request's async context (the event is
 * emitted from the event loop), so cross-thread reporters must capture
 * {@link ambientAnswerProfiler} at enqueue time and record on the captured
 * reference when the reply lands.
 */
export function recordAnswerQueueSpan(source: string, queueMs: number, execMs: number): void {
  ambientProfiler.getStore()?.recordQueueSpan(source, queueMs, execMs);
}

/**
 * Time one writer-gate (or other store) operation into the ambient profiled
 * run, if any. The answer service wraps its own gate calls with this so no
 * signature gains a profiler parameter; outside a profiled run it just runs
 * the operation.
 */
export async function timeAnswerStoreOp<T>(op: string, fn: () => Promise<T>): Promise<T> {
  const profiler = ambientProfiler.getStore();
  if (!profiler) return fn();
  const startMs = Date.now();
  try {
    return await fn();
  } finally {
    profiler.recordStoreOp(op, Date.now() - startMs);
  }
}
