// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The backlog-age badge's two decisions. A backlog's depth says how much is
 * outstanding; its head-of-queue age says how late it is, and only the second
 * is what a latency SLA is written against.
 */

import { describe, expect, test } from "vitest";
// @ts-expect-error — portal JS module, untyped by design.
import { formatDurationShort, isBacklogLate } from "./lib/format.js";

describe("formatDurationShort", () => {
  test.each([
    [0, "0s"],
    [45_000, "45s"],
    [90_000, "2m"],
    [45 * 60_000, "45m"],
    [3 * 3_600_000, "3.0h"],
    [50 * 3_600_000, "2.1d"],
  ])("%dms renders as %s", (ms, expected) => {
    expect(formatDurationShort(ms)).toBe(expected);
  });

  test("a nonsensical duration renders as nothing rather than NaN", () => {
    expect(formatDurationShort(Number.NaN)).toBe("");
    expect(formatDurationShort(-1)).toBe("");
  });
});

describe("isBacklogLate", () => {
  test("flags an age past the SLA the server reported", () => {
    expect(isBacklogLate(31 * 60_000, 30 * 60_000)).toBe(true);
  });

  test("does not flag an age within it", () => {
    expect(isBacklogLate(29 * 60_000, 30 * 60_000)).toBe(false);
  });

  test("tracks the configured SLA rather than a fixed threshold", () => {
    // The failure this guards against is a display that hardcodes the default:
    // it would cry wolf on a longer setting and stay silent on a shorter one.
    expect(isBacklogLate(45 * 60_000, 2 * 3_600_000)).toBe(false);
    expect(isBacklogLate(11 * 60_000, 10 * 60_000)).toBe(true);
  });

  test("reports nothing when the job is held to no SLA", () => {
    // Absent is not the same as met — a job with no stated latency target has
    // no verdict to render.
    expect(isBacklogLate(99 * 3_600_000, undefined)).toBe(false);
    expect(isBacklogLate(99 * 3_600_000, 0)).toBe(false);
  });

  test("reports nothing when there is no backlog to age", () => {
    expect(isBacklogLate(undefined, 30 * 60_000)).toBe(false);
  });
});
