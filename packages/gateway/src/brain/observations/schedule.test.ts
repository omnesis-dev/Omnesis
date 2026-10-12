// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { nextMorningBriefAt } from "./schedule.js";

/** A local wall-clock time, so the assertions hold in any gateway time zone. */
function local(y: number, m: number, d: number, h = 0, min = 0, sec = 0, ms = 0): number {
  return new Date(y, m - 1, d, h, min, sec, ms).getTime();
}

describe("nextMorningBriefAt", () => {
  test("today at the hour when it is still ahead", () => {
    expect(nextMorningBriefAt(local(2026, 7, 2, 5, 30), 7)).toBe(local(2026, 7, 2, 7));
  });

  test("tomorrow when the hour has passed", () => {
    expect(nextMorningBriefAt(local(2026, 7, 2, 9, 15), 7)).toBe(local(2026, 7, 3, 7));
  });

  test("exactly at the hour rolls to tomorrow", () => {
    expect(nextMorningBriefAt(local(2026, 7, 2, 7), 7)).toBe(local(2026, 7, 3, 7));
  });

  test("one millisecond before the hour is still today", () => {
    expect(nextMorningBriefAt(local(2026, 7, 2, 6, 59, 59, 999), 7)).toBe(local(2026, 7, 2, 7));
  });

  test("across midnight, just before and just after", () => {
    expect(nextMorningBriefAt(local(2026, 7, 2, 23, 59, 59), 7)).toBe(local(2026, 7, 3, 7));
    expect(nextMorningBriefAt(local(2026, 7, 3, 0, 0, 1), 7)).toBe(local(2026, 7, 3, 7));
  });

  test("across a month and a year boundary", () => {
    expect(nextMorningBriefAt(local(2026, 7, 31, 22), 7)).toBe(local(2026, 8, 1, 7));
    expect(nextMorningBriefAt(local(2026, 12, 31, 8), 7)).toBe(local(2027, 1, 1, 7));
  });

  test("weekends count like any other day", () => {
    // 2026-07-04 is a Saturday.
    expect(new Date(local(2026, 7, 4)).getDay()).toBe(6);
    expect(nextMorningBriefAt(local(2026, 7, 3, 12), 7)).toBe(local(2026, 7, 4, 7));
  });

  test("hour 0 is midnight", () => {
    expect(nextMorningBriefAt(local(2026, 7, 2, 12), 0)).toBe(local(2026, 7, 3, 0));
  });
});
