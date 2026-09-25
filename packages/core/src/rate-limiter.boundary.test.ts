// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { StandardRateLimitTracker } from "./rate-limiter.js";

// Boundary tests that pin the exact comparison thresholds in rate-limiter.ts.
// Each fixture sits ON the boundary the operator straddles, so the assertion
// flips outcome if `<=` were loosened to `<` (or `<` tightened to `<=`).

describe("StandardRateLimitTracker.canMakeNCalls — the n<=0 short-circuit boundary", () => {
  it("returns true for n===0 even when the live counter is already over the cap", () => {
    // limit 1, safetyPct 1 → cap = floor(1) = 1. Push current to 2 (over cap).
    const tracker = new StandardRateLimitTracker({ defaultLimit: 1, safetyPct: 1 });
    tracker.recordCall();
    tracker.recordCall();
    expect(tracker.quotaUsed()).toEqual({ current: 2, limit: 1 });

    // n===0 must short-circuit to allowed BEFORE the cap check runs. With the
    // short-circuit the answer is true; without it, current(2) + 0 <= cap(1)
    // would be false. This is exactly the `n <= 0` vs `n < 0` boundary.
    expect(tracker.canMakeNCalls(0)).toBe(true);

    // Sanity: a positive request past the cap is still rejected, proving the
    // cap check itself is live and only n===0 is short-circuited.
    expect(tracker.canMakeNCalls(1)).toBe(false);
  });

  it("returns true for negative n past the cap (the < 0 side of the boundary)", () => {
    const tracker = new StandardRateLimitTracker({ defaultLimit: 1, safetyPct: 1 });
    tracker.recordCall();
    tracker.recordCall();
    expect(tracker.canMakeNCalls(-1)).toBe(true);
  });
});

describe("StandardRateLimitTracker reset parsing — the 1e12 seconds/ms boundary", () => {
  it("treats a reset value exactly equal to 1e12 as epoch MILLISECONDS (not seconds)", () => {
    const tracker = new StandardRateLimitTracker();
    // 1e12 === 1_000_000_000_000. The cutoff is `asInt < 1e12` → seconds*1000,
    // else used as-is. At the exact boundary the value is NOT below 1e12, so it
    // is used as milliseconds. The `< 1e12` vs `<= 1e12` flip is only visible
    // here: a `<=` mutant would multiply by 1000 → Date(1e15).
    tracker.consumeHeaders({ "X-RateLimit-Reset": "1000000000000" });
    expect(tracker.resetTime().getTime()).toBe(1_000_000_000_000);
  });

  it("treats one below the boundary (1e12 - 1) as epoch SECONDS (*1000)", () => {
    const tracker = new StandardRateLimitTracker();
    // 999_999_999_999 < 1e12 → interpreted as seconds and scaled to ms.
    tracker.consumeHeaders({ "X-RateLimit-Reset": "999999999999" });
    expect(tracker.resetTime().getTime()).toBe(999_999_999_999 * 1000);
  });
});
