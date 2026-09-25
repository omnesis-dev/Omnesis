// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Display helpers for the sweeps table.
 *
 * The cadence one carries real weight: the scheduler counts WHOLE LOCAL DAYS,
 * so a row that printed the raw hour count would promise a precision the
 * engine does not have — `36h` is stored, but the sweep runs every two days.
 * The row must say what happens, not what was typed.
 */

import { describe, test, expect } from "vitest";
// @ts-expect-error — portal sources are plain JS with no type declarations.
import { cadenceDays, formatCadence, formatTokens, ownsProse } from "./sweeps.js";

describe("cadenceDays", () => {
  test("converts whole-day cadences exactly", () => {
    expect(cadenceDays(24)).toBe(1);
    expect(cadenceDays(168)).toBe(7);
    expect(cadenceDays(720)).toBe(30);
  });

  test("rounds a part-day cadence to the day the scheduler will actually use", () => {
    // 36h is 1.5 days and the engine rounds to 2; 30h is 1.25 and rounds to 1.
    expect(cadenceDays(36)).toBe(2);
    expect(cadenceDays(30)).toBe(1);
  });

  test("never returns less than a day, however small the input", () => {
    // A sweep gets one boundary per day, so sub-day is not expressible.
    expect(cadenceDays(1)).toBe(1);
    expect(cadenceDays(0)).toBe(1);
  });
});

describe("formatCadence", () => {
  test("names the daily case and counts the rest in days", () => {
    expect(formatCadence(24)).toBe("daily");
    expect(formatCadence(168)).toBe("7d");
    expect(formatCadence(720)).toBe("30d");
  });

  test("shows a part-day cadence as the days it will really run on", () => {
    // The bug this pins: printing "36h" tells the operator it runs every day
    // and a half, which never happens.
    expect(formatCadence(36)).toBe("2d");
  });
});

describe("formatTokens", () => {
  test("scales to k and M so a wide column stays narrow", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_500)).toBe("2k");
    expect(formatTokens(22_616_496)).toBe("22.6M");
  });
});

describe("ownsProse", () => {
  const sweep = (over: Record<string, unknown>) => ({
    modified: false,
    hasSystemVersion: true,
    ...over,
  });

  test("a shipped sweep the operator has not touched is not theirs to edit", () => {
    expect(ownsProse(sweep({}))).toBe(false);
  });

  test("a shipped sweep only switched off is still not theirs — its prose still tracks the release", () => {
    // `modified` means the file PINS content; enabling/disabling pins nothing.
    expect(ownsProse(sweep({ modified: false }))).toBe(false);
  });

  test("a forked sweep and an invented one are both editable", () => {
    expect(ownsProse(sweep({ modified: true }))).toBe(true);
    expect(ownsProse(sweep({ hasSystemVersion: false }))).toBe(true);
  });
});
