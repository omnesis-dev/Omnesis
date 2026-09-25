// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { classifyAgentTurn } from "./turn-outcome.js";

describe("classifyAgentTurn", () => {
  it("uses the terminal failure as the authoritative machine outcome", () => {
    const outcome = classifyAgentTurn({
      sessionId: "s",
      messageId: "m",
      stopReason: "error",
      failure: {
        code: "context_window_exceeded",
        message: "safe",
        retryable: false,
        backend: "anthropic",
        model: "example-model",
      },
    });
    expect(outcome).toMatchObject({
      status: "failed",
      failure: { code: "context_window_exceeded", retryable: false },
    });
  });

  it("never treats output truncation as machine success", () => {
    expect(
      classifyAgentTurn({
        sessionId: "s",
        messageId: "m",
        stopReason: "max_tokens",
      }),
    ).toMatchObject({
      status: "failed",
      failure: { code: "output_truncated", retryable: false },
    });
  });

  it("keeps cancellation and generic errors retryable", () => {
    expect(
      classifyAgentTurn({
        sessionId: "s",
        messageId: "m",
        stopReason: "canceled",
      }),
    ).toMatchObject({ status: "failed", failure: { retryable: true } });
    expect(
      classifyAgentTurn({
        sessionId: "s",
        messageId: "m",
        stopReason: "error",
      }),
    ).toMatchObject({ status: "failed", failure: { retryable: true } });
  });
});
