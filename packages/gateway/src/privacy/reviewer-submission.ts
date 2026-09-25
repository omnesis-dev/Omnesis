// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { AgentSession, classifyAgentTurn, type ChatBackend, type ToolHandle } from "@omnesis/agent";
import { z } from "zod";
import { observeSessionForAnswerProfile, type AnswerProfiler } from "./answer-profile.js";
import type {
  AgentMessageEndEvent,
  AgentTerminalFailure,
  RateLimitPatience,
  ToolResult,
} from "@omnesis/core";
import type { PrivacyFinding } from "@omnesis/types/privacy";

export const MAX_PRIVACY_REVIEW_OUTPUT_BYTES = 256 * 1024;
export const MAX_PRIVACY_FINDING_DESCRIPTION_CHARACTERS = 2_000;

const NON_REDUCTION_REDUCED_ANSWER_ISSUE = "reducedAnswer is only valid for reduce";

const findingSchema = z
  .object({
    category: z.string().min(1).max(80),
    detailLevel: z.enum(["existence", "summary", "exact", "original"]),
    subject: z.enum(["user", "other_person", "multiple_people", "unknown"]),
    disposition: z.enum(["allow", "reduce", "approval", "deny"]),
    description: z.string().min(1).max(MAX_PRIVACY_FINDING_DESCRIPTION_CHARACTERS),
  })
  .strict();

export interface ValidatedReviewerOutput {
  decision: "allow" | "reduce" | "ask" | "deny";
  confidence: number;
  findings: PrivacyFinding[];
  rationale: string;
  reducedAnswer?: string;
}

const reviewerOutputSchema = z
  .object({
    decision: z.enum(["allow", "reduce", "ask", "deny"]),
    confidence: z.number().min(0).max(1),
    findings: z.array(findingSchema).max(50),
    rationale: z.string().min(1).max(2_000),
    reducedAnswer: z.union([z.string().max(200_000), z.null()]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasReducedAnswer =
      typeof value.reducedAnswer === "string" && value.reducedAnswer.trim().length > 0;
    if (value.decision === "reduce" && !hasReducedAnswer) {
      ctx.addIssue({
        code: "custom",
        path: ["reducedAnswer"],
        message: "reduce requires reducedAnswer",
      });
    }
    if (value.decision !== "reduce" && hasReducedAnswer) {
      ctx.addIssue({
        code: "custom",
        path: ["reducedAnswer"],
        message: NON_REDUCTION_REDUCED_ANSWER_ISSUE,
      });
    }
  })
  .transform(({ reducedAnswer, ...value }): ValidatedReviewerOutput => {
    if (value.decision === "reduce" && typeof reducedAnswer === "string") {
      return { ...value, reducedAnswer };
    }
    return value;
  });

export interface PrivacyReviewSubmissionRun {
  rawModelOutput: string | null;
  parsedModelOutput: ValidatedReviewerOutput | null;
  invalidReason: string | null;
}

interface SubmissionState {
  rawModelOutput: string | null;
  parsedModelOutput: ValidatedReviewerOutput | null;
  invalidReason: string | null;
}

export class PrivacyReviewSubmissionError extends Error {
  override readonly name = "PrivacyReviewSubmissionError";

  constructor(readonly failure: AgentTerminalFailure) {
    super(failure.message);
  }
}

export async function runPrivacyReviewSubmission(
  backend: ChatBackend,
  sessionId: string,
  systemPrompt: string,
  payload: string,
  signal?: AbortSignal,
  options?: {
    /**
     * Profiling sink for the MCP Answer `profiling` flag. Records the
     * reviewer's per-request LLM timings and its (trivial, in-process)
     * submission tool calls.
     */
    profiler?: AnswerProfiler;
    /** How long the review may wait out a provider rate limit; absent keeps the default. */
    rateLimitPatience?: RateLimitPatience;
  },
): Promise<PrivacyReviewSubmissionRun> {
  const state: SubmissionState = {
    rawModelOutput: null,
    parsedModelOutput: null,
    invalidReason: null,
  };
  const session = new AgentSession({
    sessionId,
    backend,
    tools: [makeSubmissionTool(state)],
    systemPrompt,
    ...(options?.rateLimitPatience ? { rateLimitPatience: options.rateLimitPatience } : {}),
  });
  let outputBytes = 0;
  let outputLimitExceeded = false;
  let textOutput = "";
  const stopProfilingObservation = options?.profiler
    ? observeSessionForAnswerProfile(
        (subscriber) => session.subscribe(subscriber),
        options.profiler,
      )
    : undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent.text.delta") {
      outputBytes += Buffer.byteLength(event.payload.delta, "utf8");
      if (outputBytes > MAX_PRIVACY_REVIEW_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        session.cancel();
      } else {
        textOutput += event.payload.delta;
      }
    }
  });
  let terminal: AgentMessageEndEvent | null = null;
  try {
    try {
      const profiler = options?.profiler;
      terminal = await session.send(payload, {
        signal,
        ...(profiler ? { llmProbe: (timing) => profiler.recordLlmCall("reviewer", timing) } : {}),
      }).completion;
    } catch (err) {
      if (!outputLimitExceeded) throw err;
    }
  } finally {
    unsubscribe();
    stopProfilingObservation?.();
  }
  if (outputLimitExceeded) throw new Error("privacy review output exceeded its size limit");
  if (terminal === null) throw new Error("privacy review ended without a terminal event");
  const turn = classifyAgentTurn(terminal);
  if (turn.status === "failed") {
    throw new PrivacyReviewSubmissionError(turn.failure);
  }
  if (state.parsedModelOutput === null) {
    if (state.rawModelOutput === null && textOutput.trim().length > 0) {
      state.rawModelOutput = textOutput;
    }
    state.invalidReason ??=
      "Privacy reviewer ended without an accepted submit_privacy_review tool call.";
  }
  return state;
}

function makeSubmissionTool(state: SubmissionState): ToolHandle {
  return {
    name: "submit_privacy_review",
    description:
      "Submit the final privacy classification. This is the only valid way to complete the " +
      "review. If the tool returns an error, correct the rejected arguments and call it again " +
      "within this same turn.",
    schema: reviewerOutputSchema,
    summarize: () => "privacy review submission",
    // eslint-disable-next-line @typescript-eslint/require-await -- synchronous state capture behind the async ToolHandle contract
    async invoke(args): Promise<ToolResult> {
      if (state.parsedModelOutput !== null) {
        return {
          kind: "error",
          code: "privacy_review_already_submitted",
          message: "A valid privacy review is already recorded. End the turn now.",
        };
      }

      const raw = serializeArguments(args);
      if (raw === null || Buffer.byteLength(raw, "utf8") > MAX_PRIVACY_REVIEW_OUTPUT_BYTES) {
        state.rawModelOutput = null;
        state.invalidReason =
          "submit_privacy_review arguments exceeded the privacy review size limit.";
        return {
          kind: "error",
          code: "privacy_review_output_too_large",
          message: "The submission is too large. Shorten it and call submit_privacy_review again.",
        };
      }
      state.rawModelOutput = raw;

      const validated = reviewerOutputSchema.safeParse(args);
      if (!validated.success) {
        state.invalidReason = formatValidationFailure(validated.error);
        return {
          kind: "error",
          code: "privacy_review_invalid",
          message: `${state.invalidReason} Correct the arguments and call submit_privacy_review again.`,
        };
      }

      state.parsedModelOutput = validated.data;
      state.invalidReason = null;
      return {
        kind: "structured",
        resultType: "privacy_review.accepted",
        data: { accepted: true, message: "Privacy review accepted. End the turn now." },
      };
    },
  };
}

function serializeArguments(args: unknown): string | null {
  try {
    const serialized = JSON.stringify(args);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

function formatValidationFailure(error: z.ZodError): string {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "arguments";
    return `${path}: ${issue.message}`;
  });
  return `submit_privacy_review rejected its arguments${
    issues.length > 0 ? ` (${issues.join("; ")})` : ""
  }.`;
}
