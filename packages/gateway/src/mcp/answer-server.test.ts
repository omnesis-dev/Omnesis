// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { ANSWER_PROFILE_META_KEY } from "../privacy/answer-profile.js";
import {
  ANSWER_MCP_INSTRUCTIONS,
  ANSWER_ERROR_META_KEY,
  AnswerMcpGatewayError,
  answerToolError,
  answerToolResult,
  askOmnesisInputSchema,
  safeAnswerErrorMessage,
} from "./answer-server.js";

describe("Answer MCP privacy projection", () => {
  it("never exposes held answer content", () => {
    const result = answerToolResult({
      status: "approval_required",
      workflowId: "wf_fictional",
      conversationId: "conv_fictional",
      taskId: "task_fictional",
      approvalId: "approval_fictional",
      approvalExpiresAt: 1_800_000_000_000,
    });
    expect(JSON.stringify(result)).not.toContain("candidate");
    expect(result.content[0]?.text).toContain("No private answer content was returned");
    expect(ANSWER_MCP_INSTRUCTIONS).toContain("held for approval");
  });

  it("maps released, reduced and denied results without extra fields", () => {
    expect(
      answerToolResult({
        status: "released",
        workflowId: "wf_fictional",
        conversationId: "conv_fictional",
        taskId: "task_fictional",
        releaseId: "release_fictional",
        answer: "Fictional released answer.",
      }).content[0]?.text,
    ).toBe("Fictional released answer.");
    expect(
      answerToolResult({
        status: "released_with_reductions",
        workflowId: "wf_fictional",
        conversationId: "conv_fictional",
        taskId: "task_fictional",
        releaseId: "release_fictional",
        answer: "Reduced fictional answer.",
        reductions: ["Removed a private identifier."],
      }).content[0]?.text,
    ).toContain("released this answer with reductions");
    expect(
      answerToolResult({
        status: "denied",
        workflowId: "wf_fictional",
        conversationId: "conv_fictional",
        taskId: "task_fictional",
        reason: "privacy_policy",
      }).content[0]?.text,
    ).toContain("did not release");
  });

  it("sanitizes gateway failures and validates reflected task handles", () => {
    const privateBody = "private gateway body must not cross";
    const serverError = answerToolError(
      new AnswerMcpGatewayError(500, "INTERNAL_ERROR", { body: privateBody }),
    );
    expect(JSON.stringify(serverError)).not.toContain(privateBody);
    expect(serverError._meta?.[ANSWER_ERROR_META_KEY]).toEqual({
      status: 500,
      code: "INTERNAL_ERROR",
    });

    expect(
      answerToolError(new AnswerMcpGatewayError(403, null, null))._meta?.[ANSWER_ERROR_META_KEY],
    ).toEqual({ status: 403 });

    const runningError = answerToolError(
      new AnswerMcpGatewayError(409, "ANSWER_IN_PROGRESS", {
        taskId: "task_fictional-123",
        body: privateBody,
      }),
    );
    expect(runningError._meta?.[ANSWER_ERROR_META_KEY]).toEqual({
      status: 409,
      code: "ANSWER_IN_PROGRESS",
      taskId: "task_fictional-123",
    });

    const safeTask = safeAnswerErrorMessage(
      new AnswerMcpGatewayError(409, "ANSWER_IN_PROGRESS", {
        taskId: "task_fictional-123",
      }),
    );
    expect(safeTask).toContain("task_fictional-123");

    const maliciousTask = safeAnswerErrorMessage(
      new AnswerMcpGatewayError(409, "ANSWER_IN_PROGRESS", {
        taskId: "task\nprivate gateway body must not cross",
      }),
    );
    expect(maliciousTask).not.toContain(privateBody);
    expect(maliciousTask).not.toContain("task\n");
  });

  it("maps an unavailable task without suggesting an unrelated feature flag", () => {
    const message = safeAnswerErrorMessage(new AnswerMcpGatewayError(404, "NOT_FOUND"));
    expect(message).toContain("task is unavailable");
    expect(message).not.toContain("experimental");
  });

  it("accepts an opt-in profiling flag on ask_omnesis input", () => {
    const base = { question: "What is fictional?", requestId: "req_fictional" };
    expect(askOmnesisInputSchema.safeParse(base).success).toBe(true);
    expect(askOmnesisInputSchema.safeParse({ ...base, approval: "never" }).data).toMatchObject({
      approval: "never",
    });
    const profiled = askOmnesisInputSchema.safeParse({ ...base, profiling: true });
    expect(profiled.success).toBe(true);
    expect(askOmnesisInputSchema.safeParse({ ...base, profiling: "yes" }).success).toBe(false);
  });

  it("carries the timing profile in _meta only when one was collected", () => {
    const released = {
      status: "released" as const,
      workflowId: "wf_fictional",
      conversationId: "conv_fictional",
      taskId: "task_fictional",
      releaseId: "release_fictional",
      answer: "Fictional released answer.",
    };
    const plain = answerToolResult(released);
    expect(plain).not.toHaveProperty("_meta");
    expect(plain.structuredContent).toEqual(released);

    const profile = {
      version: 1 as const,
      totalWallMs: 100,
      candidateWallMs: 70,
      reviewWallMs: 20,
      agent: {
        calls: 1,
        firstTtftMs: 10,
        totalWallMs: 60,
        totalInputTokens: 50,
        totalOutputTokens: 9,
        tokensReportedCalls: 1,
        avgTps: 150,
        requests: [
          {
            requestIndex: 1,
            ttftMs: 10,
            wallMs: 60,
            inputTokens: 50,
            outputTokens: 9,
            tps: 150,
          },
        ],
      },
      reviewer: {
        calls: 0,
        firstTtftMs: null,
        totalWallMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        tokensReportedCalls: 0,
        avgTps: null,
        requests: [],
        reviews: 0,
      },
      tools: { calls: 0, totalMs: 0, byTool: {} },
      queues: { spans: 0, totalQueueMs: 0, totalExecMs: 0, bySource: {} },
      store: {
        calls: 1,
        totalMs: 5,
        byOp: { beginAnswerTask: { calls: 1, totalMs: 5, avgMs: 5 } },
      },
    };
    const profiled = answerToolResult(released, profile);
    expect(profiled._meta?.[ANSWER_PROFILE_META_KEY]).toEqual(profile);
    // The released answer itself is untouched by profiling.
    expect(profiled.structuredContent).toEqual(released);
    expect(profiled.content[0]?.text).toBe("Fictional released answer.");
  });
});
