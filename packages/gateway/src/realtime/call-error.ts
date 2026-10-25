// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { AgentError } from "../agent/service.js";
import {
  realtimeFailureDetails,
  realtimeFailureCode,
  realtimeProviderActionMessages,
} from "./provider-failure.js";
import type { AgentTerminalFailure } from "@omnesis/core";

const failures = {
  credit_balance_exhausted: [realtimeProviderActionMessages.credit_balance_exhausted, false],
  project_spend_limit_exceeded: [
    realtimeProviderActionMessages.project_spend_limit_exceeded,
    false,
  ],
  organization_spend_limit_exceeded: [
    realtimeProviderActionMessages.organization_spend_limit_exceeded,
    false,
  ],
  organization_usage_limit_exceeded: [
    realtimeProviderActionMessages.organization_usage_limit_exceeded,
    false,
  ],
  quota_exhausted: [
    "The provider API credit or quota is exhausted. Check billing or limits before trying again.",
    false,
  ],
  pairing_rejected: ["This device is no longer authorized. Pair it with the gateway again.", false],
  authentication_failed: [
    "The voice provider rejected its API credentials. Check the OpenAI key and permissions on the gateway.",
    false,
  ],
  rate_limited: ["The realtime model is temporarily rate-limited. Please try again shortly.", true],
  context_window_exceeded: [
    "This conversation is too long for the voice model. Continue in text or start a new conversation.",
    false,
  ],
  output_truncated: [
    "The voice model reached its reply limit. Ask for a shorter reply or continue in text.",
    true,
  ],
  model_unavailable: [
    "The configured realtime model is unavailable. Check the gateway's OpenAI model access.",
    false,
  ],
  session_expired: ["The voice session expired. Start a new call to continue.", true],
  content_filtered: ["The voice provider could not answer this request. Try rephrasing it.", false],
  provider_error: ["The voice provider could not complete this reply. Please try again.", true],
  connection_error: [
    "The voice connection was interrupted. Check your connection and try again.",
    true,
  ],
  session_end_failed: [
    "The voice call could not finish cleanly. Reopen the conversation before trying again.",
    true,
  ],
  timeout: ["The voice connection timed out. Please try again.", true],
  protocol_error: [
    "The voice connection received unsupported data. Update the app and gateway, then try again.",
    true,
  ],
  session_busy: [
    "This conversation is busy. Wait for its current work to finish, then try voice again.",
    true,
  ],
  session_not_found: [
    "This conversation is no longer available. Open an existing conversation or start a new one.",
    false,
  ],
  unavailable: [
    "Voice is unavailable. Check experimental mode, remote inference, and the OpenAI backend on the gateway.",
    false,
  ],
  call_limit_reached: [
    "The voice call reached its time limit. Start another call to continue.",
    true,
  ],
  server_shutdown: ["The gateway is shutting down. Reconnect when it is available again.", true],
} satisfies Record<string, readonly [string, boolean]>;

export type RealtimeCallError = {
  code: keyof typeof failures;
  message: string;
  retryable: boolean;
  fatal: boolean;
};
export function callError(code: keyof typeof failures, fatal = true): RealtimeCallError {
  const [message, retryable] = failures[code];
  return { code, message, retryable, fatal };
}

/** Only fixed gateway copy crosses the audio channel, never provider/tool exception messages. */
export function providerCallError(details: unknown, fatal = true): RealtimeCallError {
  const code = realtimeFailureCode(realtimeFailureDetails(details));
  if (
    code === "credit_balance_exhausted" ||
    code === "project_spend_limit_exceeded" ||
    code === "organization_spend_limit_exceeded" ||
    code === "organization_usage_limit_exceeded"
  )
    return callError(code, fatal);
  if (code === "insufficient_quota") return callError("quota_exhausted", fatal);
  if (
    ["invalid_api_key", "authentication_error", "permission_denied", "ip_not_authorized"].includes(
      code,
    )
  )
    return callError("authentication_failed", fatal);
  if (["rate_limit_exceeded", "rate_limited", "rate_limit_error", "slow_down"].includes(code))
    return callError("rate_limited", fatal);
  if (["context_length_exceeded", "context_window_exceeded"].includes(code))
    return callError("context_window_exceeded", fatal);
  if (["max_output_tokens", "max_tokens", "output_truncated"].includes(code))
    return callError("output_truncated", fatal);
  if (code === "session_expired") return callError("session_expired", fatal);
  if (code === "content_filter") return callError("content_filtered", fatal);
  if (code === "model_not_found") return callError("model_unavailable", fatal);
  return callError("provider_error", fatal);
}
export function terminalCallError(failure: AgentTerminalFailure, fatal = false): RealtimeCallError {
  const provider = providerCallError(
    { error: { code: failure.provider?.code, type: failure.provider?.type } },
    fatal,
  );
  const canonical =
    failure.code === "rate_limited" ||
    failure.code === "output_truncated" ||
    failure.code === "context_window_exceeded" ||
    failure.code === "session_busy"
      ? callError(failure.code, fatal)
      : callError("provider_error", fatal);
  const result = provider.code === "provider_error" ? canonical : provider;
  return { ...result, retryable: result.retryable && failure.retryable };
}

export function transportCallError(reason: string, error?: unknown): RealtimeCallError {
  if (error instanceof AgentError) {
    if (
      error.code === "session_busy" ||
      error.code === "session_not_found" ||
      error.code === "context_window_exceeded"
    )
      return callError(error.code);
    if (error.code === "forbidden") return callError("pairing_rejected");
  }
  if (reason === "session_end_failed") return callError("session_end_failed");
  if (reason.endsWith("timeout")) return callError("timeout");
  if (reason.startsWith("invalid_") || reason === "session_not_open")
    return callError("protocol_error");
  if (reason === "pending_input_limit") return callError("session_busy");
  if (reason === "transcription_failed" || reason === "provider_error")
    return callError("provider_error");
  return callError("connection_error");
}

export class RealtimeAdmissionError extends Error {
  constructor(readonly detail: RealtimeCallError) {
    super(detail.message);
  }
}
