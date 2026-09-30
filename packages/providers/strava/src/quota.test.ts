// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { StravaRateLimitTracker, DEFAULT_SAFETY_PCT } from "./quota.js";

function makeHeaders(record: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(record)) h.set(k, v);
  return h;
}

describe("StravaRateLimitTracker", () => {
  it("treats unobserved state as effectively unbounded", () => {
    const tr = new StravaRateLimitTracker();
    expect(tr.canMakeNCalls(1000)).toBe(true);
    expect(tr.remainingShort()).toBe(Infinity);
    expect(tr.remainingDaily()).toBe(Infinity);
  });

  it("parses overall + read pairs and applies safety pct", () => {
    const tr = new StravaRateLimitTracker();
    tr.observe(
      makeHeaders({
        "X-RateLimit-Limit": "200,2000",
        "X-RateLimit-Usage": "10,100",
        "X-ReadRateLimit-Limit": "100,1000",
        "X-ReadRateLimit-Usage": "20,200",
      }),
    );
    // read short cap = 100 * 0.9 = 90, used 20 → 70
    // read daily cap = 1000 * 0.9 = 900, used 200 → 700
    expect(tr.remainingShort()).toBe(70);
    expect(tr.remainingDaily()).toBe(700);
    expect(tr.canMakeNCalls(70)).toBe(true);
    expect(tr.canMakeNCalls(71)).toBe(false);
  });

  it("respects whichever pair is tighter (overall vs read)", () => {
    const tr = new StravaRateLimitTracker();
    // Overall is the tighter bound here
    tr.observe(
      makeHeaders({
        "X-RateLimit-Limit": "200,2000",
        "X-RateLimit-Usage": "175,500",
        "X-ReadRateLimit-Limit": "100,1000",
        "X-ReadRateLimit-Usage": "10,200",
      }),
    );
    // overall cap 180, used 175 → 5
    // read cap 90, used 10 → 80
    expect(tr.remainingShort()).toBe(5);
  });

  it("ignores headers when only partial pair is present", () => {
    const tr = new StravaRateLimitTracker();
    tr.observe(makeHeaders({ "X-RateLimit-Limit": "200,2000" }));
    // No usage → no overall state set
    expect(tr.remainingShort()).toBe(Infinity);
  });

  it("returns 0 when usage exceeds the safety cap", () => {
    const tr = new StravaRateLimitTracker();
    tr.observe(
      makeHeaders({
        "X-ReadRateLimit-Limit": "100,1000",
        "X-ReadRateLimit-Usage": "95,900",
      }),
    );
    // cap = 90, usage 95 → 0 (clamped)
    expect(tr.remainingShort()).toBe(0);
    expect(tr.canMakeNCalls(1)).toBe(false);
  });

  it("supports custom safety pct", () => {
    const tr = new StravaRateLimitTracker();
    tr.observe(
      makeHeaders({
        "X-ReadRateLimit-Limit": "100,1000",
        "X-ReadRateLimit-Usage": "0,0",
      }),
    );
    expect(tr.remainingShort(1.0)).toBe(100);
    expect(tr.remainingShort(0.5)).toBe(50);
    expect(DEFAULT_SAFETY_PCT).toBe(0.9);
  });

  it("computes ms until next 15-min boundary", () => {
    const tr = new StravaRateLimitTracker();
    // 12:07:30 UTC → next boundary is 12:15:00 → 7m30s = 450_000ms
    const ms = tr.msUntilWindowReset(new Date(Date.UTC(2026, 4, 4, 12, 7, 30)));
    expect(ms).toBe(7 * 60 * 1000 + 30 * 1000);
  });

  it("setState lets tests fast-forward to near-exhaustion", () => {
    const tr = new StravaRateLimitTracker();
    tr.setState(undefined, {
      used: { short: 95, daily: 200 },
      limit: { short: 100, daily: 1000 },
    });
    expect(tr.canMakeNCalls(1)).toBe(false);
    expect(tr.remainingShort()).toBe(0);
  });
});

// Usage arrives only with a response, and a spent budget is exactly when no
// request is made — so the tracker itself has to know when Strava resets it.
describe("StravaRateLimitTracker across Strava's reset boundaries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A tracker that last heard from Strava at `when`, reporting `usage`. */
  function heardAt(when: string, usage: string): StravaRateLimitTracker {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(when));
    const tr = new StravaRateLimitTracker();
    tr.observe(
      makeHeaders({ "X-ReadRateLimit-Limit": "100,1000", "X-ReadRateLimit-Usage": usage }),
    );
    return tr;
  }

  const at = (iso: string) => new Date(iso);

  it("lets the 15-minute window's usage go on the quarter hour", () => {
    const tr = heardAt("2026-03-04T10:14:30Z", "95,300");

    expect(tr.canMakeNCalls(10, DEFAULT_SAFETY_PCT, at("2026-03-04T10:14:59Z"))).toBe(false);
    expect(tr.canMakeNCalls(10, DEFAULT_SAFETY_PCT, at("2026-03-04T10:15:00Z"))).toBe(true);
    // Short window reset: cap 90, used 0 → 90. Day not reset: cap 900, used 300 → 600.
    expect(tr.remainingShort(DEFAULT_SAFETY_PCT, at("2026-03-04T10:15:00Z"))).toBe(90);
    expect(tr.remainingDaily(DEFAULT_SAFETY_PCT, at("2026-03-04T10:15:00Z"))).toBe(600);
  });

  it("lets the day's usage go at midnight UTC, and not before", () => {
    const tr = heardAt("2026-03-04T22:40:00Z", "5,950");

    expect(tr.canMakeNCalls(10, DEFAULT_SAFETY_PCT, at("2026-03-04T23:59:59Z"))).toBe(false);
    expect(tr.canMakeNCalls(10, DEFAULT_SAFETY_PCT, at("2026-03-05T00:00:00Z"))).toBe(true);
  });

  it("reports the wait until whichever window cannot cover the calls resets", () => {
    /** How long ten calls wait, asked the moment Strava reported `usage`. */
    const waitAfter = (when: string, usage: string) =>
      heardAt(when, usage).msUntilCanMakeNCalls(10, DEFAULT_SAFETY_PCT, at(when));
    const grace = 30_000;

    expect(waitAfter("2026-03-04T10:07:30Z", "95,300")).toBe(7.5 * 60_000 + grace);
    expect(waitAfter("2026-03-04T22:40:00Z", "5,950")).toBe(80 * 60_000 + grace);
    // Both spent: the quarter hour would free nothing, so the wait runs to midnight.
    expect(waitAfter("2026-03-04T22:40:00Z", "95,950")).toBe(80 * 60_000 + grace);
    expect(waitAfter("2026-03-04T10:07:30Z", "5,300")).toBe(0);
  });

  it("takes a count reported in a window's first 30 seconds for the window before it", () => {
    // A response crossing midnight carries yesterday's spent day; counted as
    // today's, it would hold the source back until the next midnight.
    const crossing = heardAt("2026-03-05T00:00:05Z", "95,950");
    expect(crossing.canMakeNCalls(10, DEFAULT_SAFETY_PCT, at("2026-03-05T00:00:40Z"))).toBe(true);

    const current = heardAt("2026-03-05T00:00:45Z", "95,950");
    expect(current.canMakeNCalls(10, DEFAULT_SAFETY_PCT, at("2026-03-05T00:01:00Z"))).toBe(false);
  });
});
