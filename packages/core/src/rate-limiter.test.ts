// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StandardRateLimitTracker } from "./rate-limiter.js";

describe("StandardRateLimitTracker.canMakeNCalls", () => {
  it("short-circuits to true while the limit is unknown (Infinity)", () => {
    const tracker = new StandardRateLimitTracker();
    // No headers consumed yet → limit is Infinity → always allowed.
    expect(tracker.canMakeNCalls(1_000_000)).toBe(true);
  });

  it("treats n <= 0 as always allowed even under a real limit", () => {
    const tracker = new StandardRateLimitTracker({ defaultLimit: 0 });
    expect(tracker.canMakeNCalls(0)).toBe(true);
    expect(tracker.canMakeNCalls(-5)).toBe(true);
  });

  it("gates against the limit once known", () => {
    const tracker = new StandardRateLimitTracker({ defaultLimit: 5 });
    expect(tracker.canMakeNCalls(5)).toBe(true);
    expect(tracker.canMakeNCalls(6)).toBe(false);
    tracker.recordCall();
    tracker.recordCall();
    // current = 2; cap = 5; 2 + 3 <= 5 ok, 2 + 4 > 5 not ok.
    expect(tracker.canMakeNCalls(3)).toBe(true);
    expect(tracker.canMakeNCalls(4)).toBe(false);
  });

  it("floors the effective cap by safetyPct", () => {
    // limit 100, safetyPct 0.9 → cap = floor(90) = 90.
    const tracker = new StandardRateLimitTracker({ defaultLimit: 100, safetyPct: 0.9 });
    expect(tracker.canMakeNCalls(90)).toBe(true);
    expect(tracker.canMakeNCalls(91)).toBe(false);
  });

  it("floors a fractional cap downward (no rounding up past the safety budget)", () => {
    // limit 10, safetyPct 0.95 → floor(9.5) = 9.
    const tracker = new StandardRateLimitTracker({ defaultLimit: 10, safetyPct: 0.95 });
    expect(tracker.canMakeNCalls(9)).toBe(true);
    expect(tracker.canMakeNCalls(10)).toBe(false);
  });
});

describe("StandardRateLimitTracker.consumeHeaders parsing", () => {
  it("recomputes current = max(0, limit - remaining) from a Headers object", () => {
    const tracker = new StandardRateLimitTracker();
    const headers = new Headers({
      "X-RateLimit-Limit": "100",
      "X-RateLimit-Remaining": "30",
    });
    tracker.consumeHeaders(headers);
    expect(tracker.quotaUsed()).toEqual({ current: 70, limit: 100 });
  });

  it("clamps current to 0 when remaining exceeds limit (never negative)", () => {
    const tracker = new StandardRateLimitTracker();
    tracker.consumeHeaders({
      "X-RateLimit-Limit": "100",
      "X-RateLimit-Remaining": "150",
    });
    expect(tracker.quotaUsed()).toEqual({ current: 0, limit: 100 });
  });

  it("reads case-mixed header names from a plain record", () => {
    const tracker = new StandardRateLimitTracker();
    tracker.consumeHeaders({
      "x-ratelimit-limit": "60",
      "X-RATELIMIT-REMAINING": "20",
    });
    expect(tracker.quotaUsed()).toEqual({ current: 40, limit: 60 });
  });

  it("honours custom header names", () => {
    const tracker = new StandardRateLimitTracker({
      limitHeader: "X-Custom-Limit",
      remainingHeader: "X-Custom-Remaining",
    });
    tracker.consumeHeaders({
      "x-custom-limit": "8",
      "x-custom-remaining": "3",
    });
    expect(tracker.quotaUsed()).toEqual({ current: 5, limit: 8 });
  });

  it("does not recompute current from remaining while limit is still Infinity", () => {
    const tracker = new StandardRateLimitTracker();
    // Only a remaining header, no limit → cannot derive current; stays 0.
    tracker.consumeHeaders({ "X-RateLimit-Remaining": "5" });
    expect(tracker.quotaUsed()).toEqual({ current: 0, limit: Infinity });
  });

  it("ignores non-numeric limit/remaining headers", () => {
    const tracker = new StandardRateLimitTracker({ defaultLimit: 42 });
    tracker.consumeHeaders({ "X-RateLimit-Limit": "not-a-number" });
    expect(tracker.quotaUsed().limit).toBe(42);
  });
});

describe("StandardRateLimitTracker reset-time parsing", () => {
  it("interprets a small integer reset as epoch SECONDS (below the 1e12 boundary)", () => {
    const tracker = new StandardRateLimitTracker();
    // 1_700_000_000 < 1e12 → treated as seconds → *1000.
    tracker.consumeHeaders({ "X-RateLimit-Reset": "1700000000" });
    expect(tracker.resetTime().getTime()).toBe(1_700_000_000 * 1000);
  });

  it("interprets a large integer reset as epoch MILLISECONDS (at/above the 1e12 boundary)", () => {
    const tracker = new StandardRateLimitTracker();
    // 1_700_000_000_000 >= 1e12 → already ms, used as-is.
    tracker.consumeHeaders({ "X-RateLimit-Reset": "1700000000000" });
    expect(tracker.resetTime().getTime()).toBe(1_700_000_000_000);
  });

  it("parses an HTTP-date reset header", () => {
    const tracker = new StandardRateLimitTracker();
    const httpDate = "Wed, 21 Oct 2026 07:28:00 GMT";
    tracker.consumeHeaders({ "X-RateLimit-Reset": httpDate });
    expect(tracker.resetTime().getTime()).toBe(Date.parse(httpDate));
  });
});

describe("StandardRateLimitTracker Retry-After parsing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("interprets a numeric Retry-After as delta-seconds from now", () => {
    const tracker = new StandardRateLimitTracker();
    tracker.consumeHeaders({ "Retry-After": "120" });
    expect(tracker.resetTime().getTime()).toBe(Date.parse("2026-01-01T00:00:00.000Z") + 120_000);
  });

  it("parses an HTTP-date Retry-After as an absolute instant", () => {
    const tracker = new StandardRateLimitTracker();
    const httpDate = "Wed, 21 Oct 2026 07:28:00 GMT";
    tracker.consumeHeaders({ "Retry-After": httpDate });
    expect(tracker.resetTime().getTime()).toBe(Date.parse(httpDate));
  });
});
