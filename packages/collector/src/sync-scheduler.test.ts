// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { SyncScheduler, formatInterval, MAX_DEFER_MS } from "./sync-scheduler.js";

/**
 * Deterministic unit coverage for the jittered recurring-sync scheduler.
 * `Math.random` is stubbed so the jitter is exact, and fake timers drive
 * the clock so there are no wall-clock sleeps.
 */
describe("SyncScheduler", () => {
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Pin jitter to a known fraction of the window so first-tick timing is exact.
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  test("first tick is delayed past the interval by the jitter offset, then steady ticks fire at the exact interval", () => {
    const scheduler = new SyncScheduler();
    const interval = 60_000;
    let ticks = 0;
    scheduler.schedule("src", () => ticks++, interval);

    // Jitter = floor(0.5 * 60000 * 0.25) = 7500ms → first delay = 67500ms.
    // Nothing should fire before the jittered first delay elapses.
    vi.advanceTimersByTime(interval); // 60000ms
    expect(ticks).toBe(0);

    // Cross the jittered first-tick boundary.
    vi.advanceTimersByTime(7_500); // now at 67500ms
    expect(ticks).toBe(1);

    // After the first tick, the steady interval fires every exact `interval`.
    vi.advanceTimersByTime(interval);
    expect(ticks).toBe(2);
    vi.advanceTimersByTime(interval);
    expect(ticks).toBe(3);

    scheduler.clearAll();
  });

  test("the jittered first delay never undershoots the interval or exceeds interval*1.25", () => {
    // Probe both random extremes against the documented [interval, interval*1.25] window.
    for (const r of [0, 0.999999]) {
      randomSpy.mockReturnValue(r);
      const scheduler = new SyncScheduler();
      const interval = 40_000;
      let ticks = 0;
      scheduler.schedule("src", () => ticks++, interval);

      // Just under the interval: must not have fired (jitter is additive, never negative).
      vi.advanceTimersByTime(interval - 1);
      expect(ticks).toBe(0);

      // By interval*1.25 the first tick must have fired regardless of jitter.
      vi.advanceTimersByTime(interval * 0.25 + 1);
      expect(ticks).toBe(1);

      scheduler.clearAll();
    }
  });

  test("clear() stops a still-pending first-tick timeout before it ever fires", () => {
    const scheduler = new SyncScheduler();
    let ticks = 0;
    scheduler.schedule("src", () => ticks++, 60_000);

    expect(scheduler.has("src")).toBe(true);
    scheduler.clear("src");
    expect(scheduler.has("src")).toBe(false);

    // Advance well past where both the first tick and several steady ticks
    // would have landed; the cleared timer must be silent.
    vi.advanceTimersByTime(60_000 * 5);
    expect(ticks).toBe(0);
  });

  test("clear() stops the steady interval after the first tick has promoted it", () => {
    const scheduler = new SyncScheduler();
    const interval = 60_000;
    let ticks = 0;
    scheduler.schedule("src", () => ticks++, interval);

    // Fire the first (jittered) tick → promotes to steady setInterval.
    vi.advanceTimersByTime(interval + 7_500);
    expect(ticks).toBe(1);

    scheduler.clear("src");
    expect(scheduler.has("src")).toBe(false);

    // Steady interval must no longer fire.
    vi.advanceTimersByTime(interval * 3);
    expect(ticks).toBe(1);
  });

  test("re-scheduling clears the previous timer so the handle does not leak (no double-fire)", () => {
    const scheduler = new SyncScheduler();
    const interval = 60_000;
    let ticks = 0;
    const tick = () => ticks++;
    scheduler.schedule("src", tick, interval);
    // Re-arm before the first one fires.
    scheduler.schedule("src", tick, interval);

    // Past the first-tick boundary: only ONE first-tick fires, not two.
    vi.advanceTimersByTime(interval + 7_500);
    expect(ticks).toBe(1);

    scheduler.clearAll();
  });

  test("deferNext() pushes the next tick out by the delay, then resumes the steady interval (one-shot)", () => {
    const scheduler = new SyncScheduler();
    const interval = 60_000;
    let ticks = 0;
    scheduler.schedule("src", () => ticks++, interval);

    // Promote to the steady interval by firing the jittered first tick.
    vi.advanceTimersByTime(interval + 7_500);
    expect(ticks).toBe(1);

    // The steady tick fired this run rate-limited us; defer the next one well
    // past the normal interval (e.g. a 6h ASPSP back-off floored at the max).
    const deferMs = 6 * 60 * 60 * 1000;
    scheduler.deferNext("src", deferMs);

    // The normal interval elapsing must NOT fire a tick while deferred.
    vi.advanceTimersByTime(interval * 3);
    expect(ticks).toBe(1);

    // Just before the deferral deadline: still silent.
    vi.advanceTimersByTime(deferMs - interval * 3 - 1);
    expect(ticks).toBe(1);

    // Crossing the deadline fires exactly one deferred tick…
    vi.advanceTimersByTime(1);
    expect(ticks).toBe(2);

    // …and re-arms the steady interval at the ORIGINAL cadence (one-shot).
    vi.advanceTimersByTime(interval);
    expect(ticks).toBe(3);
    vi.advanceTimersByTime(interval);
    expect(ticks).toBe(4);

    scheduler.clearAll();
  });

  test("deferNext() clamps an absurd delay to MAX_DEFER_MS so it can't overflow setTimeout", () => {
    const scheduler = new SyncScheduler();
    const interval = 60_000;
    let ticks = 0;
    scheduler.schedule("src", () => ticks++, interval);
    vi.advanceTimersByTime(interval + 7_500);
    expect(ticks).toBe(1);

    // A hostile/buggy Retry-After larger than Node's TIMEOUT_MAX (~24.8 days)
    // would, un-clamped, make setTimeout fire ~immediately. Defer by 40 days.
    scheduler.deferNext("src", 40 * 24 * 60 * 60 * 1000);

    // It must NOT fire immediately (overflow bug) — silent right up to the cap.
    vi.advanceTimersByTime(MAX_DEFER_MS - 1);
    expect(ticks).toBe(1);

    // Crossing MAX_DEFER_MS fires exactly one deferred tick, then resumes.
    vi.advanceTimersByTime(1);
    expect(ticks).toBe(2);
    vi.advanceTimersByTime(interval);
    expect(ticks).toBe(3);

    scheduler.clearAll();
  });

  test("deferNext() works while a source is still in its jittered first-tick window", () => {
    const scheduler = new SyncScheduler();
    const interval = 60_000;
    let ticks = 0;
    scheduler.schedule("src", () => ticks++, interval);
    // No first tick yet (still in the first-tick setTimeout window).
    expect(ticks).toBe(0);

    // Defer before the first tick ever fires — the deferral (one-shot
    // setTimeout fired `deferMs` from now) replaces the pending first-tick.
    const deferMs = 200_000;
    scheduler.deferNext("src", deferMs);
    vi.advanceTimersByTime(interval + 7_500); // where the first tick would have landed
    expect(ticks).toBe(0);

    // Cross the deferral deadline (clock now at deferMs) → one deferred tick.
    vi.advanceTimersByTime(deferMs - (interval + 7_500));
    expect(ticks).toBe(1);
    // Steady cadence resumes at the configured interval.
    vi.advanceTimersByTime(interval);
    expect(ticks).toBe(2);

    scheduler.clearAll();
  });

  test("deferNext() on an unscheduled source is a no-op (manual/push-only sources)", () => {
    const scheduler = new SyncScheduler();
    // Never scheduled — deferNext has nothing to defer and must not arm a timer.
    scheduler.deferNext("never-scheduled", 100_000);
    expect(scheduler.has("never-scheduled")).toBe(false);
    // Advancing the clock must not throw or fire any phantom timer.
    expect(() => vi.advanceTimersByTime(500_000)).not.toThrow();
  });

  test("clear() during a deferral stops the pending deferred tick", () => {
    const scheduler = new SyncScheduler();
    const interval = 60_000;
    let ticks = 0;
    scheduler.schedule("src", () => ticks++, interval);
    vi.advanceTimersByTime(interval + 7_500); // promote to steady
    expect(ticks).toBe(1);

    scheduler.deferNext("src", 500_000);
    scheduler.clear("src");
    expect(scheduler.has("src")).toBe(false);

    // The deferred tick must never fire after a clear.
    vi.advanceTimersByTime(1_000_000);
    expect(ticks).toBe(1);
  });

  test("clearAll() tears down both a still-pending first-tick and a promoted steady interval", () => {
    const scheduler = new SyncScheduler();
    const shortInterval = 60_000;
    const longInterval = 600_000;
    let pendingTicks = 0;
    let steadyTicks = 0;

    // "pending" has a long interval so its first tick hasn't fired yet;
    // "steady" has a short interval and gets promoted to setInterval.
    scheduler.schedule("pending", () => pendingTicks++, longInterval);
    scheduler.schedule("steady", () => steadyTicks++, shortInterval);

    // Cross the short first-tick boundary (60000 + 7500) but stay below the
    // long one (600000 + 75000).
    vi.advanceTimersByTime(shortInterval + 7_500);
    expect(steadyTicks).toBe(1); // promoted to steady setInterval
    expect(pendingTicks).toBe(0); // still in its first-tick setTimeout

    scheduler.clearAll();
    expect(scheduler.has("pending")).toBe(false);
    expect(scheduler.has("steady")).toBe(false);

    // Neither the cleared steady interval nor the cleared pending first-tick
    // fires after clearAll, even past where both would have landed.
    vi.advanceTimersByTime(longInterval * 2);
    expect(pendingTicks).toBe(0);
    expect(steadyTicks).toBe(1);
  });
});

describe("formatInterval", () => {
  test("renders hours / minutes / seconds at the documented boundaries", () => {
    expect(formatInterval(3_600_000)).toBe("1h");
    expect(formatInterval(7_200_000)).toBe("2h");
    // Just below the hour boundary falls back to minutes.
    expect(formatInterval(3_540_000)).toBe("59m");
    expect(formatInterval(60_000)).toBe("1m");
    // Just below the minute boundary falls back to seconds.
    expect(formatInterval(30_000)).toBe("30s");
    expect(formatInterval(1_000)).toBe("1s");
  });
});
