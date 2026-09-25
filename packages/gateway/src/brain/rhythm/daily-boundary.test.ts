// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Local-time boundary math. Both sides of every assertion go through the
 * `Date` local-time constructor, so the tests are timezone-agnostic —
 * they assert the local-time CONTRACT, whatever zone the box is in.
 */

import { describe, test, expect } from "vitest";
import { mostRecentDailyBoundary } from "./daily-boundary.js";

/** Local-time instant helper. */
function local(y: number, mo: number, d: number, h: number, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

describe("mostRecentDailyBoundary", () => {
  test("before today's hour, the boundary is yesterday's", () => {
    const b = mostRecentDailyBoundary(local(2026, 3, 10, 4, 59), 5);
    expect(b.boundaryMs).toBe(local(2026, 3, 9, 5));
    expect(b.prevBoundaryMs).toBe(local(2026, 3, 8, 5));
    expect(b.day).toBe("2026-03-09");
  });

  test("at and after today's hour, the boundary is today's", () => {
    for (const now of [local(2026, 3, 10, 5, 0), local(2026, 3, 10, 23, 59)]) {
      const b = mostRecentDailyBoundary(now, 5);
      expect(b.boundaryMs).toBe(local(2026, 3, 10, 5));
      expect(b.prevBoundaryMs).toBe(local(2026, 3, 9, 5));
      expect(b.day).toBe("2026-03-10");
    }
  });

  test("month and year rollovers go through calendar arithmetic", () => {
    const b = mostRecentDailyBoundary(local(2026, 1, 1, 3, 0), 5);
    expect(b.boundaryMs).toBe(local(2025, 12, 31, 5));
    expect(b.prevBoundaryMs).toBe(local(2025, 12, 30, 5));
    expect(b.day).toBe("2025-12-31");
  });

  test("after downtime the most recent boundary is still exactly one boundary", () => {
    // Ten days pass; the function only ever answers "the latest one".
    const b = mostRecentDailyBoundary(local(2026, 3, 20, 12, 0), 5);
    expect(b.boundaryMs).toBe(local(2026, 3, 20, 5));
    expect(b.day).toBe("2026-03-20");
  });

  test("the hour knob is honored (e.g. midnight)", () => {
    const b = mostRecentDailyBoundary(local(2026, 3, 10, 0, 0), 0);
    expect(b.boundaryMs).toBe(local(2026, 3, 10, 0));
    expect(b.day).toBe("2026-03-10");
  });
});
