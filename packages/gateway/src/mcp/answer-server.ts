// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertNever } from "@omnesis/core";
import * as z from "zod/v4";
import { ANSWER_PROFILE_META_KEY, type AnswerProfileReport } from "../privacy/answer-profile.js";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AnswerResponse } from "@omnesis/types/privacy";

export const ANSWER_MCP_SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25"] as const;
export const NATIVE_ANSWER_CONVERSATION_META_KEY = "dev.omnesis/nativeConversationId";
export const ANSWER_ERROR_META_KEY = "dev.omnesis/error";

/** Safe, transport-neutral failure presented by the Answer boundary. */
export class AnswerMcpGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly detail: Readonly<Record<string, unknown>> | null,
  ) {
    super("Omnesis Answer boundary rejected the request.");
    this.name = "AnswerMcpGatewayError";
  }
}

export interface AnswerMcpSubmission {
  response: AnswerResponse;
  /** Timing profile; non-null only when the call set `profiling: true`. */
  profile: AnswerProfileReport | null;
}

export interface AnswerMcpClient {
  submit(
    input: {
      question: string;
      clientRequestId: string;
      conversationId?: string;
      workflowId?: string;
      workflowName?: string;
      workflowPurpose?: string;
      approval?: "allow" | "never";
      /** Trusted native route carried outside the model-visible tool arguments. */
      nativeConversationId?: string;
      /** Collect a timing profile of the run, returned beside the response. */
      profiling?: boolean;
    },
    options?: { signal?: AbortSignal },
  ): Promise<AnswerMcpSubmission>;
  getTask(taskId: string, options?: { signal?: AbortSignal }): Promise<AnswerResponse>;
}

const id = z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/);
const requestId = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
const answerBase = { workflowId: z.string(), conversationId: z.string(), taskId: z.string() };

export const answerOutputSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...answerBase,
    status: z.literal("released"),
    releaseId: z.string(),
    answer: z.string(),
  }),
  z.strictObject({
    ...answerBase,
    status: z.literal("released_with_reductions"),
    releaseId: z.string(),
    answer: z.string(),
    reductions: z.array(z.string()),
  }),
  z.strictObject({
    ...answerBase,
    status: z.literal("approval_required"),
    approvalId: z.string(),
    approvalExpiresAt: z.number(),
  }),
  z.strictObject({
    ...answerBase,
    status: z.literal("denied"),
    reason: z.enum([
      "privacy_policy",
      "hard_stop",
      "user_denied",
      "expired",
      "canceled",
      "approval_not_available",
    ]),
  }),
]);

export const askOmnesisInputSchema = z.strictObject({
  question: z
    .string()
    .min(1)
    .max(10_000)
    .refine((value) => value.trim().length > 0, "Question must not be blank."),
  conversationId: id.optional().describe("Continue a prior Omnesis Answer conversation."),
  workflowId: id.optional().describe("Continue a stable external-agent workflow."),
  workflowName: z.string().min(1).max(120).optional(),
  workflowPurpose: z
    .string()
    .max(500)
    .optional()
    .describe("Purpose shown to the Omnesis privacy reviewer."),
  requestId: requestId.describe(
    "Stable idempotency key. Reuse it when retrying the identical call.",
  ),
  approval: z
    .enum(["allow", "never"])
    .default("allow")
    .describe(
      "Use allow for interactive sessions: Omnesis may hold sensitive content for approval in the portal. Use never only when no human can approve and retrieve the task.",
    ),
  profiling: z
    .boolean()
    .optional()
    .describe(
      "Set true to also receive a timing profile of the run (LLM calls, tool calls, worker-queue waits, store ops) in the result _meta. Omit or set false for normal calls.",
    ),
});

export const answerStatusInputSchema = z.strictObject({
  taskId: z.string().min(1).max(160).describe("Opaque task id returned by Omnesis."),
});

export const ANSWER_MCP_INSTRUCTIONS =
  "Use ask_omnesis to obtain privacy-reviewed answers from the user's Omnesis corpus. " +
  "This server exposes no direct corpus, document, people, analytics, SQL, write, or admin tools. " +
  "Treat denied and reduced outcomes as final policy decisions, and never reconstruct content " +
  "that Omnesis held for approval. " +
  "Omnesis cannot browse or search the live internet: it answers only from the user's already-captured corpus, " +
  "fixed at capture time. When a question needs current outside-world facts, combine the released answer " +
  "with your own search or browse tools.";

export const ANSWER_MCP_COMBINED_INSTRUCTIONS =
  "Use ask_omnesis when the answer should pass through the user's Omnesis privacy policy. " +
  "Only that Answer tool family is privacy reviewed; any Direct tools on this server return raw corpus data. " +
  "Treat denied and reduced Answer outcomes as final policy decisions, and never use Direct tools to reconstruct content that Omnesis held for approval. " +
  "Omnesis cannot browse or search the live internet: it answers only from the user's already-captured corpus, " +
  "fixed at capture time. When a question needs current outside-world facts, combine the Omnesis result " +
  "with your own search or browse tools.";

export function registerAnswerMcpTools(server: McpServer, client: AnswerMcpClient): void {
  server.registerTool(
    "ask_omnesis",
    {
      title: "Ask Omnesis (privacy reviewed)",
      description:
        "Ask the local Omnesis agent about the user's private corpus. This read-only call may run a model, consume the owner's configured model budget, create durable privacy activity, and send an approval notification. Omnesis searches internally, reviews the candidate answer against the user's privacy policy, and returns only the released result. Omnesis cannot browse or search the live internet: it answers only from the user's already-captured corpus, fixed at capture time, so combine the released result with your own search or browse tools when the question needs current outside-world facts. By default, sensitive content may be held for approval in Omnesis; if approval_required is returned, tell the user and call get_answer_status after they approve. Never invent or reconstruct held content. Reuse requestId for a retry of the exact same turn.",
      inputSchema: askOmnesisInputSchema,
      outputSchema: answerOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, context) => {
      try {
        const nativeConversationId = parseNativeConversationMeta(context.mcpReq._meta);
        const submission = await client.submit(
          {
            question: args.question.trim(),
            clientRequestId: args.requestId,
            ...(args.conversationId ? { conversationId: args.conversationId } : {}),
            ...(args.workflowId ? { workflowId: args.workflowId } : {}),
            ...(args.workflowName ? { workflowName: args.workflowName } : {}),
            ...(args.workflowPurpose ? { workflowPurpose: args.workflowPurpose } : {}),
            ...(nativeConversationId ? { nativeConversationId } : {}),
            ...(args.profiling ? { profiling: true as const } : {}),
            approval: args.approval,
          },
          { signal: context.mcpReq.signal },
        );
        return answerToolResult(submission.response, submission.profile ?? undefined);
      } catch (error) {
        return answerToolError(error);
      }
    },
  );
  server.registerTool(
    "get_answer_status",
    {
      title: "Get Omnesis answer status",
      description:
        "Retrieve a durable Answer task owned by this authenticated principal credential. A task id is only a lookup handle: Omnesis re-checks the credential and task ownership on every call. Use this after the user confirms that they approved an approval_required result in Omnesis; do not busy-poll.",
      inputSchema: answerStatusInputSchema,
      outputSchema: answerOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ taskId }, context) => {
      try {
        return answerToolResult(await client.getTask(taskId, { signal: context.mcpReq.signal }));
      } catch (error) {
        return answerToolError(error);
      }
    },
  );
}

function parseNativeConversationMeta(
  meta: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const value = meta?.[NATIVE_ANSWER_CONVERSATION_META_KEY];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new AnswerMcpGatewayError(400, "INVALID_NATIVE_ANSWER_ROUTE", null);
  }
  return value;
}

export function answerToolResult(result: AnswerResponse, profile?: AnswerProfileReport) {
  return {
    content: [{ type: "text" as const, text: answerText(result) }],
    structuredContent: result,
    ...(profile ? { _meta: { [ANSWER_PROFILE_META_KEY]: profile } } : {}),
  };
}

function answerText(result: AnswerResponse): string {
  switch (result.status) {
    case "released":
      return result.answer;
    case "released_with_reductions":
      return `${result.answer}\n\nPrivacy: Omnesis released this answer with reductions.`;
    case "approval_required":
      return (
        "Omnesis requires user approval before it can release an answer. No private answer content was returned. " +
        `Ask the user to approve task ${result.taskId} in Omnesis, then call get_answer_status with that taskId after the user confirms approval.`
      );
    case "denied":
      return `Omnesis did not release an answer (${result.reason}).`;
    default:
      return assertNever(result);
  }
}

export function answerToolError(error: unknown) {
  const errorMeta = safeAnswerErrorMeta(error);
  return {
    content: [{ type: "text" as const, text: safeAnswerErrorMessage(error) }],
    isError: true as const,
    ...(errorMeta ? { _meta: { [ANSWER_ERROR_META_KEY]: errorMeta } } : {}),
  };
}

function safeAnswerErrorMeta(
  error: unknown,
): { status: number; code?: string; taskId?: string } | undefined {
  if (!(error instanceof AnswerMcpGatewayError)) return undefined;
  const code = error.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : undefined;
  const rawTaskId = code === "ANSWER_IN_PROGRESS" ? error.detail?.taskId : undefined;
  const taskId =
    typeof rawTaskId === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(rawTaskId)
      ? rawTaskId
      : undefined;
  return {
    status: Math.max(400, Math.min(599, Math.floor(error.status))),
    ...(code ? { code } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

export function safeAnswerErrorMessage(error: unknown): string {
  if (error instanceof AnswerMcpGatewayError) {
    if (error.status === 401)
      return "Omnesis rejected this MCP credential. Reauthorize the principal and try again.";
    if (error.status === 403) return "This principal grant does not allow Omnesis Answer.";
    if (error.status === 404)
      return "The requested Omnesis Answer task is unavailable. Ensure the task belongs to this principal.";
    if (error.status === 409 && error.code === "ANSWER_IN_PROGRESS") {
      const rawTaskId = error.detail?.taskId;
      const taskId =
        typeof rawTaskId === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(rawTaskId)
          ? rawTaskId
          : null;
      return taskId
        ? `That idempotent Omnesis Answer task is still running. Retry with the same requestId or call get_answer_status with taskId ${taskId}.`
        : "That idempotent Omnesis Answer task is still running. Retry with the same requestId.";
    }
    if (error.status === 409)
      return "The Omnesis Answer task is not ready or the supplied workflow state conflicts with the existing task.";
    if (error.status === 429 || error.status === 503)
      return "Omnesis is at Answer capacity. Wait briefly, then retry with the same requestId.";
    if (error.status >= 500)
      return "Omnesis could not complete the privacy-reviewed answer. Check the gateway and its configured models.";
    return `Omnesis rejected the Answer request (HTTP ${error.status}).`;
  }
  if (error instanceof Error && error.name === "AbortError")
    return "The Omnesis Answer request was cancelled.";
  return "The Omnesis Answer request failed before a privacy-reviewed result could be returned.";
}
