// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  ambientAnswerProfiler,
  AnswerProfiler,
  answerProfileReportSchema,
  observeSessionForAnswerProfile,
  recordAnswerQueueSpan,
  runWithAnswerProfiler,
  timeAnswerStoreOp,
} from "./answer-profile.js";
import type { AgentEvent } from "@omnesis/core";

describe("AnswerProfiler", () => {
  it("summarizes LLM calls with per-request and average TPS", () => {
    const profiler = new AnswerProfiler();
    profiler.recordLlmCall("agent", {
      requestIndex: 1,
      ttftMs: 800,
      wallMs: 2000,
      inputTokens: 1000,
      outputTokens: 100,
    });
    profiler.recordLlmCall("agent", {
      requestIndex: 2,
      ttftMs: 300,
      wallMs: 1000,
      inputTokens: 2000,
      outputTokens: 50,
    });
    // A request that produced no tokens still counts its wall time.
    profiler.recordLlmCall("agent", { requestIndex: 3, ttftMs: null, wallMs: 500 });

    const { report } = profiler.buildReport({
      totalWallMs: 5000,
      candidateWallMs: 3500,
      reviewWallMs: 1000,
    });
    expect(report.version).toBe(1);
    expect(report.agent.calls).toBe(3);
    expect(report.agent.firstTtftMs).toBe(800);
    expect(report.agent.totalWallMs).toBe(3500);
    expect(report.agent.totalInputTokens).toBe(3000);
    expect(report.agent.totalOutputTokens).toBe(150);
    expect(report.agent.tokensReportedCalls).toBe(2);
    // 150 output tokens over the 3000ms of token-bearing requests.
    expect(report.agent.avgTps).toBe(50);
    expect(report.agent.requests[0]).toMatchObject({
      requestIndex: 1,
      ttftMs: 800,
      wallMs: 2000,
      tps: 50,
    });
    expect(report.agent.requests[2]).toMatchObject({ ttftMs: null, tps: null });
    expect(report.reviewer.calls).toBe(0);
    expect(report.reviewer.avgTps).toBeNull();
  });

  it("aggregates tool calls per tool with counts and totals", () => {
    const profiler = new AnswerProfiler();
    profiler.recordToolCall("search_documents", 30);
    profiler.recordToolCall("search_documents", 10);
    profiler.recordToolCall("fetch_document", 5);
    const { report } = profiler.buildReport({
      totalWallMs: 100,
      candidateWallMs: 80,
      reviewWallMs: 0,
    });
    expect(report.tools.calls).toBe(3);
    expect(report.tools.totalMs).toBe(45);
    expect(report.tools.byTool["search_documents"]).toMatchObject({
      calls: 2,
      totalMs: 40,
      avgMs: 20,
    });
    expect(report.tools.byTool["fetch_document"]).toMatchObject({ calls: 1, totalMs: 5 });
  });

  it("aggregates queue spans per source, separating wait from exec", () => {
    const profiler = new AnswerProfiler();
    profiler.recordQueueSpan("search-worker", 5, 25);
    profiler.recordQueueSpan("search-worker", 15, 35);
    profiler.recordQueueSpan("embedder", 0, 40);
    const { report } = profiler.buildReport({
      totalWallMs: 200,
      candidateWallMs: 200,
      reviewWallMs: 0,
    });
    expect(report.queues.spans).toBe(3);
    expect(report.queues.totalQueueMs).toBe(20);
    expect(report.queues.totalExecMs).toBe(100);
    expect(report.queues.bySource["search-worker"]).toEqual({
      spans: 2,
      queueMs: 20,
      execMs: 60,
    });
  });

  it("records store ops and validates the built report against the schema", () => {
    const profiler = new AnswerProfiler();
    profiler.recordStoreOp("beginAnswerTask", 12);
    profiler.recordStoreOp("completeAnswerTask", 8);
    const { report } = profiler.buildReport({
      totalWallMs: 50,
      candidateWallMs: 30,
      reviewWallMs: 10,
    });
    expect(report.store.calls).toBe(2);
    expect(report.store.byOp["beginAnswerTask"]).toMatchObject({ calls: 1, totalMs: 12 });
    expect(answerProfileReportSchema.safeParse(report).success).toBe(true);
    expect(answerProfileReportSchema.safeParse({ ...report, version: 999 }).success).toBe(false);
  });

  it("counts reviewer turns separately from reviewer LLM calls", () => {
    const profiler = new AnswerProfiler();
    profiler.countReview();
    profiler.countReview();
    profiler.recordLlmCall("reviewer", {
      requestIndex: 1,
      ttftMs: 100,
      wallMs: 400,
      inputTokens: 60,
      outputTokens: 12,
    });
    const { report } = profiler.buildReport({
      totalWallMs: 500,
      candidateWallMs: 0,
      reviewWallMs: 450,
    });
    expect(report.reviewer.reviews).toBe(2);
    expect(report.reviewer.calls).toBe(1);
  });
});

describe("observeSessionForAnswerProfile", () => {
  it("maps tool result durations onto tool start names", () => {
    const profiler = new AnswerProfiler();
    const subscribers = new Set<(event: AgentEvent) => void>();
    const stop = observeSessionForAnswerProfile((subscriber) => {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    }, profiler);
    const emit = (event: AgentEvent): void => {
      for (const subscriber of subscribers) subscriber(event);
    };
    emit({
      type: "agent.tool.start",
      payload: {
        sessionId: "s",
        messageId: "m",
        toolCallId: "c1",
        tool: "search_documents",
        args: {},
      },
    });
    emit({
      type: "agent.tool.result",
      payload: {
        sessionId: "s",
        messageId: "m",
        toolCallId: "c1",
        result: { kind: "error", code: "x", message: "y" },
        durationMs: 42,
      },
    });
    // A result without a start still records under a fallback name.
    emit({
      type: "agent.tool.result",
      payload: {
        sessionId: "s",
        messageId: "m",
        toolCallId: "c-unknown",
        result: { kind: "error", code: "x", message: "y" },
        durationMs: 7,
      },
    });
    stop();
    const { report } = profiler.buildReport({
      totalWallMs: 100,
      candidateWallMs: 100,
      reviewWallMs: 0,
    });
    expect(report.tools.byTool["search_documents"]).toMatchObject({ calls: 1, totalMs: 42 });
    expect(report.tools.byTool["unknown"]).toMatchObject({ calls: 1, totalMs: 7 });
  });
});

describe("ambient answer profiling", () => {
  it("exposes the ambient profiler for enqueue-time capture", () => {
    expect(ambientAnswerProfiler()).toBeUndefined();
    const profiler = new AnswerProfiler();
    runWithAnswerProfiler(profiler, () => {
      // Worker layers capture this reference at enqueue time because
      // their reply handlers run outside the async chain.
      expect(ambientAnswerProfiler()).toBe(profiler);
    });
    expect(ambientAnswerProfiler()).toBeUndefined();
  });

  it("drops queue spans and store ops outside a profiled run", async () => {
    recordAnswerQueueSpan("search-worker", 10, 20);
    const passthrough = await timeAnswerStoreOp("beginAnswerTask", () => Promise.resolve("ok"));
    expect(passthrough).toBe("ok");
  });

  it("attributes queue spans and store ops inside a profiled run", async () => {
    const profiler = new AnswerProfiler();
    await runWithAnswerProfiler(profiler, async () => {
      recordAnswerQueueSpan("search-worker", 10, 20);
      await timeAnswerStoreOp("beginAnswerTask", () => Promise.resolve("ok"));
    });
    const { report } = profiler.buildReport({
      totalWallMs: 10,
      candidateWallMs: 10,
      reviewWallMs: 0,
    });
    expect(report.queues.bySource["search-worker"]).toEqual({
      spans: 1,
      queueMs: 10,
      execMs: 20,
    });
    expect(report.store.byOp["beginAnswerTask"]?.calls).toBe(1);
  });
});
