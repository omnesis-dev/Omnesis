// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CONTEXT_WINDOW_EXCEEDED_MESSAGE, OUTPUT_TRUNCATED_MESSAGE } from "@omnesis/agent";
import { z } from "zod";
import type { AgentTerminalFailure } from "@omnesis/core";

const codes = new Set([
  "credit_balance_exhausted",
  "server_error",
  "internal_error",
  "invalid_request",
  "invalid_request_error",
  "rate_limit_error",
  "rate_limit_exceeded",
  "insufficient_quota",
  "context_length_exceeded",
  "context_window_exceeded",
  "model_not_found",
  "session_expired",
  "max_output_tokens",
  "max_tokens",
  "content_filter",
]);
const errorTypes = new Set([
  "server_error",
  "invalid_request_error",
  "rate_limit_error",
  "insufficient_quota",
  "tokens",
  "requests",
]);
const reasons = new Set([
  "turn_detected",
  "client_cancelled",
  "max_output_tokens",
  "content_filter",
]);
const statuses = new Set(["completed", "cancelled", "failed", "incomplete"]);
const detailsSchema = z.object({
  type: z.unknown().optional(),
  reason: z.unknown().optional(),
  error: z.object({ code: z.unknown().optional(), type: z.unknown().optional() }).nullish(),
});

/** Provider messages may quote input. Preserve only known protocol identifiers, never messages. */
export function realtimeFailureDetails(value: unknown): {
  code?: string;
  type?: string;
  reason?: string;
  statusType?: string;
} {
  const parsed = detailsSchema.safeParse(value);
  if (!parsed.success) return {};
  const identifier = (field: unknown, allowed: ReadonlySet<string>) =>
    typeof field === "string" ? (allowed.has(field) ? field : "unrecognized") : undefined;
  return {
    code: identifier(parsed.data.error?.code, codes),
    type: identifier(parsed.data.error?.type, errorTypes),
    reason: identifier(parsed.data.reason, reasons),
    statusType: identifier(parsed.data.type, statuses),
  };
}

export function realtimeQuotaExhausted(detail: ReturnType<typeof realtimeFailureDetails>): boolean {
  return (
    detail.code === "insufficient_quota" ||
    detail.code === "credit_balance_exhausted" ||
    detail.type === "insufficient_quota"
  );
}

export function realtimeFailureCode(detail: ReturnType<typeof realtimeFailureDetails>): string {
  return realtimeQuotaExhausted(detail)
    ? detail.code === "credit_balance_exhausted"
      ? detail.code
      : "insufficient_quota"
    : (detail.code ?? detail.reason ?? detail.type ?? "provider_error");
}

export function realtimeModelFailure(
  code: string,
  backend: string,
  model: string,
): AgentTerminalFailure {
  const kind =
    code === "context_length_exceeded" || code === "context_window_exceeded"
      ? "context_window_exceeded"
      : code === "max_output_tokens" || code === "max_tokens"
        ? "output_truncated"
        : code === "rate_limit_exceeded"
          ? "rate_limited"
          : "provider_error";
  const quotaExhausted = code === "insufficient_quota" || code === "credit_balance_exhausted";
  return {
    code: kind,
    message:
      kind === "context_window_exceeded"
        ? CONTEXT_WINDOW_EXCEEDED_MESSAGE
        : kind === "output_truncated"
          ? OUTPUT_TRUNCATED_MESSAGE
          : kind === "rate_limited"
            ? "The realtime model is temporarily rate-limited. Please try again shortly."
            : quotaExhausted
              ? "The provider API credit or quota is exhausted. Check billing or limits before trying again."
              : "The realtime model could not complete this reply.",
    retryable: (kind === "provider_error" || kind === "rate_limited") && !quotaExhausted,
    backend,
    model,
  };
}

export const realtimeResponseDone = z.object({
  response: z.object({
    id: z.string().optional(),
    status: z.string().optional(),
    status_details: z
      .object({
        type: z.string().nullish(),
        reason: z.string().nullish(),
        error: z.object({ code: z.string().nullish(), type: z.string().nullish() }).nullish(),
      })
      .nullable()
      .optional(),
    output: z.array(z.object({ type: z.string() }).passthrough()).optional(),
    usage: z
      .object({
        input_tokens: z.number().nonnegative(),
        output_tokens: z.number().nonnegative(),
        input_token_details: z
          .object({ cached_tokens: z.number().nonnegative().optional() })
          .optional(),
      })
      .nullable()
      .optional(),
  }),
});
