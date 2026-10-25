// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-render coverage for the context line of `omnesis brain run <id>`: how
 * much of its model's window the run's conversation filled, and why it handed
 * its work to a successor.
 */

import { describe, expect, test } from "vitest";
import { renderRunContext } from "./briefs.js";

describe("renderRunContext", () => {
  test("shows the peak against a reported window and the handoff reason", () => {
    expect(
      renderRunContext({
        peakInputTokens: 168_000,
        lastInputTokens: 168_000,
        contextWindowTokens: 258_400,
        handoffReason: "context_budget",
      }),
    ).toBe("peak 168000 input tokens of 258400 (65%), latest 168000, handed off: context_budget");
  });

  test("shows the peak alone when the window is unknown and the run did not hand off", () => {
    expect(
      renderRunContext({
        peakInputTokens: 42_000,
        lastInputTokens: 40_000,
        contextWindowTokens: null,
        handoffReason: null,
      }),
    ).toBe("peak 42000 input tokens, latest 40000");
  });

  test("prints nothing for a run without context telemetry", () => {
    expect(renderRunContext(null)).toBeNull();
    expect(renderRunContext(undefined)).toBeNull();
  });
});
