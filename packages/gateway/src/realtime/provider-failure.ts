// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CONTEXT_WINDOW_EXCEEDED_MESSAGE, OUTPUT_TRUNCATED_MESSAGE } from "@omnesis/agent";
import { z } from "zod";
import type { AgentTerminalFailure } from "@omnesis/core";

const codes = new Set([
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "slow_down",
  "server_is_overloaded",
  "ip_not_authorized",
  "invalid_api_key",
  "authentication_error",
  "permission_denied",
  "rate_limited",
  "output_truncated",
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
  "authentication_error",
  "permission_denied",
  "ip_not_authorized",
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

const quotaCodes = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);
export function realtimeQuotaExhausted(detail: ReturnType<typeof realtimeFailureDetails>): boolean {
  return quotaCodes.has(detail.code ?? "") || detail.type === "insufficient_quota";
}

export function realtimeFailureCode(detail: ReturnType<typeof realtimeFailureDetails>): string {
  if (detail.code && quotaCodes.has(detail.code)) return detail.code;
  if (detail.type === "insufficient_quota") return "insufficient_quota";
  return detail.code ?? detail.reason ?? detail.type ?? "provider_error";
}

export const realtimeProviderActionMessages = {
  credit_balance_exhausted:
    "The provider API credit balance is exhausted. Add API credit before trying again.",
  project_spend_limit_exceeded:
    "The OpenAI project spend limit was reached. Raise that project's limit before trying again.",
  organization_spend_limit_exceeded:
    "The OpenAI organization spend limit was reached. Check the organization's billing limits before trying again.",
  organization_usage_limit_exceeded:
    "The OpenAI organization usage limit was reached. Check its assigned usage limit before trying again.",
  insufficient_quota:
    "The provider API credit or quota is exhausted. Check billing or limits before trying again.",
} as const;

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
  const quotaExhausted = quotaCodes.has(code);
  const actionMessage = Object.entries(realtimeProviderActionMessages).find(
    ([key]) => key === code,
  )?.[1];
  return {
    code: kind,
    message:
      kind === "context_window_exceeded"
        ? CONTEXT_WINDOW_EXCEEDED_MESSAGE
        : kind === "output_truncated"
          ? OUTPUT_TRUNCATED_MESSAGE
          : kind === "rate_limited"
            ? "The realtime model is temporarily rate-limited. Please try again shortly."
            : code === "content_filter"
              ? "The voice provider could not answer this request. Try rephrasing it."
              : (actionMessage ?? "The realtime model could not complete this reply."),
    retryable:
      (kind === "provider_error" || kind === "rate_limited") &&
      !quotaExhausted &&
      code !== "content_filter",
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
