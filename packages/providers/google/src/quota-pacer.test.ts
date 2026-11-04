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
});
