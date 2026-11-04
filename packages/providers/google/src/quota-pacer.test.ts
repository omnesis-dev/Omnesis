// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { QuotaPacer } from "./quota-pacer.js";

/** The most units granted inside any window of `windowMs`. */
function busiestWindow(grants: Array<{ at: number; units: number }>, windowMs: number): number {
  let busiest = 0;
  for (const start of grants) {
    const spent = grants
      .filter((g) => g.at >= start.at && g.at < start.at + windowMs)
      .reduce((sum, g) => sum + g.units, 0);
    busiest = Math.max(busiest, spent);
  }
  return busiest;
}

describe("QuotaPacer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("concurrent callers never spend more than the minute's budget plus the burst", async () => {
    const pacer = new QuotaPacer({ unitsPerMinute: 5_400, burstUnits: 300 });
    const startedAt = Date.now();
    const grants: Array<{ at: number; units: number }> = [];
    let stop = false;
    const lane = async (units: number) => {
      while (!stop) {
        await pacer.acquire(units);
        if (stop) return;
        grants.push({ at: Date.now() - startedAt, units });
      }
    };
    const lanes = [60, 60, 60, 60, 60, 20, 5, 1].map((units) => lane(units));

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    stop = true;
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(lanes);

    const busiest = busiestWindow(grants, 60_000);
    expect(busiest).toBeLessThanOrEqual(5_700);
    expect(busiest).toBeLessThan(6_000);
    const spentInThreeMinutes = grants
      .filter((g) => g.at < 3 * 60_000)
      .reduce((sum, g) => sum + g.units, 0);
    expect(spentInThreeMinutes).toBeGreaterThan(3 * 5_400 - 300);
  });

  test("callers are served in the order they asked", async () => {
    const pacer = new QuotaPacer({ unitsPerMinute: 600, burstUnits: 60 });
    const order: string[] = [];
    const asked = [
      pacer.acquire(60).then(() => order.push("first")),
      pacer.acquire(60).then(() => order.push("second")),
      pacer.acquire(1).then(() => order.push("third")),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(order).toEqual(["first", "second"]);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all(asked);
    expect(order).toEqual(["first", "second", "third"]);
  });

  test("an idle pacer refills only up to its burst", async () => {
    const pacer = new QuotaPacer({ unitsPerMinute: 6_000, burstUnits: 100 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    let granted = 0;
    const asked = Array.from({ length: 5 }, () => pacer.acquire(50).then(() => granted++));
    await vi.advanceTimersByTimeAsync(0);
    expect(granted).toBe(2);
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.all(asked);
    expect(granted).toBe(5);
  });

  test("an unlimited pacer never waits", async () => {
    const pacer = QuotaPacer.unlimited();
    let granted = 0;
    await Promise.all(Array.from({ length: 1_000 }, () => pacer.acquire(60).then(() => granted++)));
    expect(granted).toBe(1_000);
  });
  test("an unlimited pacer has no pace to adapt", () => {
    const pacer = QuotaPacer.unlimited();
    expect(pacer.rateLimited()).toBeUndefined();
    expect(pacer.succeeded()).toBeUndefined();
    expect(pacer.unitsPerMinute).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("QuotaPacer adaptive pace", () => {
  const QUIET = 10 * 60_000;
  const HOLD = 60 * 60_000;
  const adaptivePacer = () =>
    new QuotaPacer({
      unitsPerMinute: 4_000,
      burstUnits: 300,
      adaptive: {
        floorUnitsPerMinute: 1_500,
        decreaseFactor: 0.75,
        increaseUnitsPerMinute: 250,
        quietMs: QUIET,
        holdMs: HOLD,
      },
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T09:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("repeated rate limits cut the pace to the floor and no further", () => {
    const pacer = adaptivePacer();
    const paces: Array<number | undefined> = [];
    for (let i = 0; i < 6; i++) paces.push(pacer.rateLimited());

    expect(paces).toEqual([3_000, 2_250, 1_688, 1_500, undefined, undefined]);
    expect(pacer.unitsPerMinute).toBe(1_500);
  });

  test("quiet periods restore the pace to the ceiling and no further", () => {
    const pacer = adaptivePacer();
    for (let i = 0; i < 4; i++) pacer.rateLimited();
    vi.advanceTimersByTime(HOLD);
    expect(pacer.succeeded(), "an hour without a rate limit is a quiet period").toBe(1_750);

    const paces: number[] = [];
    for (let i = 0; i < 13; i++) {
      vi.advanceTimersByTime(QUIET - 1);
      expect(pacer.succeeded(), "a quiet period not yet over").toBeUndefined();
      vi.advanceTimersByTime(1);
      pacer.succeeded();
      paces.push(pacer.unitsPerMinute);
    }

    expect(paces).toEqual([
      2_000, 2_250, 2_500, 2_750, 3_000, 3_250, 3_500, 3_750, 4_000, 4_000, 4_000, 4_000, 4_000,
    ]);
  });

  test("a pace with no rate limit behind it stays at the ceiling", () => {
    const pacer = adaptivePacer();
    vi.advanceTimersByTime(5 * QUIET);
    expect(pacer.succeeded()).toBeUndefined();
    expect(pacer.unitsPerMinute).toBe(4_000);
  });

  test("for the hold after a rate limit the pace climbs to a step short of the refused pace", () => {
    const pacer = adaptivePacer();
    pacer.rateLimited();
    pacer.rateLimited();
    expect(pacer.unitsPerMinute).toBe(2_250);

    const paces: number[] = [];
    for (let elapsed = QUIET; elapsed < HOLD; elapsed += QUIET) {
      vi.advanceTimersByTime(QUIET);
      pacer.succeeded();
      paces.push(pacer.unitsPerMinute);
    }
    expect(paces).toEqual([2_500, 2_750, 2_750, 2_750, 2_750]);

    vi.advanceTimersByTime(QUIET);
    expect(pacer.succeeded()).toBe(3_000);
  });

  test("callers waiting for units are paced at the cut rate", async () => {
    const pacer = adaptivePacer();
    pacer.rateLimited();
    pacer.rateLimited();
    const startedAt = Date.now();
    const grants: Array<{ at: number; units: number }> = [];
    let stop = false;
    const lane = async () => {
      while (!stop) {
        await pacer.acquire(60);
        if (stop) return;
        grants.push({ at: Date.now() - startedAt, units: 60 });
      }
    };
    const lanes = Array.from({ length: 8 }, () => lane());

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    stop = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(lanes);

    const spent = grants.filter((g) => g.at < 3 * 60_000).reduce((sum, g) => sum + g.units, 0);
    expect(spent).toBeLessThanOrEqual(3 * 2_250 + 300);
    expect(spent).toBeGreaterThan(3 * 2_250 - 300);
  });
});
