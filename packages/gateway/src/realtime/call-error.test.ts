// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { AgentError } from "../agent/service.js";
import { realtimeModelFailure } from "./provider-failure.js";
import { providerCallError, terminalCallError, transportCallError } from "./call-error.js";

describe("safe voice failures", () => {
  it.each([
    ["credit_balance_exhausted", "credit_balance_exhausted", false],
    ["insufficient_quota", "quota_exhausted", false],
    ["organization_spend_limit_exceeded", "organization_spend_limit_exceeded", false],
    ["project_spend_limit_exceeded", "project_spend_limit_exceeded", false],
    ["organization_usage_limit_exceeded", "organization_usage_limit_exceeded", false],
    ["invalid_api_key", "authentication_failed", false],
    ["ip_not_authorized", "authentication_failed", false],
    ["permission_denied", "authentication_failed", false],
    ["rate_limit_exceeded", "rate_limited", true],
    ["slow_down", "rate_limited", true],
    ["context_length_exceeded", "context_window_exceeded", false],
    ["max_output_tokens", "output_truncated", true],
    ["session_expired", "session_expired", true],
    ["content_filter", "content_filtered", false],
    ["model_not_found", "model_unavailable", false],
    ["server_is_overloaded", "provider_error", true],
    ["PRIVATE_SENTINEL", "provider_error", true],
  ])("classifies %s without provider prose", (provider, code, retryable) => {
    const error = providerCallError({ error: { code: provider, message: "PRIVATE_SENTINEL" } });
    expect(error).toMatchObject({ code, retryable, fatal: true });
    expect(JSON.stringify(error)).not.toContain("PRIVATE_SENTINEL");
    expect(error.message.length).toBeLessThan(240);
  });
  it.each([
    ["credit_balance_exhausted", "Add API credit"],
    ["project_spend_limit_exceeded", "Raise that project's limit"],
    ["organization_spend_limit_exceeded", "organization's billing limits"],
    ["organization_usage_limit_exceeded", "assigned usage limit"],
  ])("gives legacy canonical cards the precise %s action", (code, action) => {
    const canonical = realtimeModelFailure(code, "openai-realtime", "fixture");
    expect(canonical.message).toContain(action);
    expect(canonical.retryable).toBe(false);
    expect(providerCallError({ error: { code } }).message).toBe(canonical.message);
  });
  it("distinguishes a failed end handshake from connection loss", () => {
    expect(transportCallError("session_end_failed")).toMatchObject({
      code: "session_end_failed",
      fatal: true,
    });
  });
  it("recognizes authentication errors reported only through their type", () => {
    expect(
      providerCallError({ error: { type: "authentication_error", message: "PRIVATE_SENTINEL" } }),
    ).toMatchObject({ code: "authentication_failed", retryable: false });
  });
  it("keeps quota type authoritative over a conflicting rate code", () => {
    expect(
      providerCallError({ error: { code: "rate_limit_exceeded", type: "insufficient_quota" } }),
    ).toMatchObject({ code: "quota_exhausted", retryable: false });
  });
  it("projects canonical failures without copying arbitrary messages", () => {
    expect(
      terminalCallError({ code: "rate_limited", message: "PRIVATE_SENTINEL", retryable: true }),
    ).toMatchObject({ code: "rate_limited", fatal: false });
    expect(
      JSON.stringify(
        terminalCallError({ code: "provider_error", message: "PRIVATE_SENTINEL", retryable: true }),
      ),
    ).not.toContain("PRIVATE_SENTINEL");
  });
  it.each(["session_busy", "session_not_found", "context_window_exceeded"])(
    "preserves admission %s",
    (code) => {
      expect(
        transportCallError("session_open_failed", new AgentError(code, "PRIVATE_SENTINEL")),
      ).toMatchObject({ code, fatal: true });
    },
  );
});
