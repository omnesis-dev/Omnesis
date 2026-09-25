// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The answer path forwards a backend's own failure message to callers outside
 * the privacy boundary for the codes listed here, and replaces it with a fixed
 * sentence for every other code. Membership therefore decides whether a
 * provider's or a runtime's prose can leave the machine.
 *
 * This test pins the list. It fails on any addition, which is the point: the
 * person adding a code has to open every site that produces it and confirm the
 * message is a literal, rather than appending a line and moving on.
 */

import { describe, expect, it } from "vitest";

import { VETTED_ANSWER_FAILURE_CODES } from "./service.js";

const REVIEWED = [
  // Fixed sentences in packages/agent/src/http-backend.ts and
  // openai-responses-backend.ts, or built by `describeHttpStatus`, which
  // interpolates only the numeric status.
  "http_empty_response",
  "http_request_timeout",
  "http_request_error",
  "http_api_error",
  "http_protocol_mismatch",
  "http_stream_error",
  // Fixed sentences in packages/agent/src/anthropic-backend.ts.
  "anthropic_api_error",
  "anthropic_stream_error",
  // Fixed sentences in `friendlyCodexErrorMessage`. `codex_not_authenticated`
  // is excluded on purpose: its sentence names a filesystem path.
  "codex_binary_missing",
  "codex_unsupported_version",
  "codex_usage_limited",
  "codex_invalid_model",
  "codex_runtime_error",
];

describe("vetted answer failure codes", () => {
  it("matches the reviewed list exactly", () => {
    expect([...VETTED_ANSWER_FAILURE_CODES].sort()).toEqual([...REVIEWED].sort());
  });

  it("excludes the codes whose message names a path or quotes upstream bytes", () => {
    for (const code of ["codex_not_authenticated", "tool_threw", "internal_error"]) {
      expect(VETTED_ANSWER_FAILURE_CODES.has(code)).toBe(false);
    }
  });
});
