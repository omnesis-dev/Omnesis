// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AgentMessageEndEvent, AgentTerminalFailure } from "@omnesis/core";

export const CONTEXT_WINDOW_EXCEEDED_MESSAGE =
  "This conversation no longer fits in the selected model's context window. Start a new conversation to continue.";

export const OUTPUT_TRUNCATED_MESSAGE =
  "The model reached its output limit before completing this response.";

export type AgentTurnOutcome =
  | {
      status: "succeeded";
      terminal: AgentMessageEndEvent;
    }
  | {
      status: "failed";
      terminal: AgentMessageEndEvent;
      failure: AgentTerminalFailure;
    };

/**
 * Convert the authoritative terminal event into the one success/failure shape
 * used by background workflows. `AgentSession` normally supplies `failure`,
 * while the stop-reason fallbacks keep direct backend consumers and older
 * replay fixtures from treating truncation or cancellation as success.
 */
export function classifyAgentTurn(terminal: AgentMessageEndEvent): AgentTurnOutcome {
  const identity = {
    backend: "unknown",
    model: "unknown",
  };
  if (terminal.stopReason === "max_tokens") {
    return {
      status: "failed",
      terminal,
      failure: {
        code: "output_truncated",
        message: OUTPUT_TRUNCATED_MESSAGE,
        retryable: false,
        ...identity,
      },
    };
  }
  if (terminal.failure) {
    return { status: "failed", terminal, failure: terminal.failure };
  }
  if (terminal.stopReason === "canceled") {
    return {
      status: "failed",
      terminal,
      failure: {
        code: "canceled",
        message: "The agent turn was canceled before completion.",
        retryable: true,
        ...identity,
      },
    };
  }
  if (terminal.stopReason === "error") {
    return {
      status: "failed",
      terminal,
      failure: {
        code: "internal_error",
        message: "The model request failed before completing.",
        retryable: true,
        ...identity,
      },
    };
  }
  return { status: "succeeded", terminal };
}
