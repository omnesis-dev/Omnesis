// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The watchdog's judgement driven step by step: heartbeat stamps and poll
 * times are chosen numbers, so nothing here depends on how fast the machine
 * running it is.
 */

import { describe, expect, test } from "vitest";

import { ProfileTrigger, StallDetector } from "./stall-detector.js";
import type { ActivitySample } from "./stall-protocol.js";

const INTERVAL = 50;
const POLL = 25;

/**
 * A detector, and a clock that polls it every POLL ms. The main thread's side
 * is simulated too: each stamp records its gap from the previous one, as the
 * real heartbeat does, and the detector takes the largest.
 */
function harness(thresholdMs = 250) {
  let now = 0;
  let beat = 0;
  let maxGap = 0;
  const detector = new StallDetector(INTERVAL, thresholdMs, 2_000, beat, now);
  const stamp = () => {
    maxGap = Math.max(maxGap, now - beat);
    beat = now;
  };
  const takeMaxGap = () => {
    const gap = maxGap;
    maxGap = 0;
    return gap;
  };
  const poll = (activity: ActivitySample) => detector.poll(beat, now, () => activity, takeMaxGap);
  return {
    /** Advance with the main thread stuck, sampling `activity` at every poll. */
    stuck(ms: number, activity: ActivitySample) {
      const found = [];
      for (let t = 0; t < ms; t += POLL) {
        now += POLL;
        found.push(poll(activity));
      }
      return found.filter(Boolean);
    },
    /** The loop turns again: the main thread stamps the heartbeat. */
    resume() {
      stamp();
      now += POLL;
      return poll({ inner: 0, outer: 0, inFlight: [] });
    },
    /** A normal heartbeat-sized step: stamped on time. */
    healthy(steps: number) {
      for (let i = 0; i < steps; i++) {
        now += POLL;
        if (i % 2 === 1) stamp();
        expect(poll({ inner: 9, outer: 9, inFlight: [] })).toBeNull();
      }
    },
    /** The main thread keeps time while the watchdog does not poll at all. */
    watchdogAway(ms: number) {
      for (let t = 0; t < ms; t += INTERVAL) {
        now += INTERVAL;
        stamp();
      }
    },
    /** Neither thread runs: the process is suspended. */
    jumpClock(ms: number) {
      now += ms;
    },
    poll: () => poll({ inner: 0, outer: 0, inFlight: [] }),
  };
}

describe("StallDetector", () => {
  test("stays quiet while the heartbeat keeps time", () => {
    harness().healthy(40);
  });

  test("reports a stall when the heartbeat resumes, named by what it was stuck in", () => {
    const h = harness();
    h.healthy(4);
    expect(h.stuck(1_000, { inner: 7, outer: 3, inFlight: [5] })).toEqual([]);
    const stall = h.resume();
    expect(stall).toMatchObject({ inner: 7, outer: 3, inFlight: [5] });
    // The gap between stamps, less the interval the timer meant to wait.
    expect(stall!.durationMs).toBeGreaterThanOrEqual(1_000 - INTERVAL);
    expect(stall!.durationMs).toBeLessThanOrEqual(1_000 + POLL);
  });

  test("leaves a gap below the threshold unreported", () => {
    const h = harness(250);
    h.healthy(4);
    h.stuck(150, { inner: 7, outer: 7, inFlight: [] });
    expect(h.resume()).toBeNull();
  });

  test("attributes a stall to the activity seen in most of its samples", () => {
    const h = harness();
    h.healthy(2);
    h.stuck(200, { inner: 1, outer: 1, inFlight: [] });
    h.stuck(800, { inner: 2, outer: 1, inFlight: [] });
    expect(h.resume()).toMatchObject({ inner: 2, outer: 1 });
  });

  test("names no activity when most of the stall ran unmarked", () => {
    const h = harness();
    h.healthy(2);
    h.stuck(200, { inner: 4, outer: 4, inFlight: [8] });
    h.stuck(800, { inner: 0, outer: 0, inFlight: [8, 6] });
    expect(h.resume()).toMatchObject({ inner: 0, outer: 0, inFlight: [8, 6] });
  });

  test("reports no stall when only the watchdog fell behind", () => {
    const h = harness();
    h.healthy(2);
    // The watchdog's own loop was busy for over a second, while the main
    // thread kept stamping on time: the stamps it sees jump, the gaps did not.
    h.watchdogAway(1_500);
    expect(h.poll()).toBeNull();
    h.healthy(4);
  });

  test("starts each stall's attribution afresh", () => {
    const h = harness();
    h.stuck(1_000, { inner: 1, outer: 1, inFlight: [1] });
    h.resume();
    h.healthy(2);
    h.stuck(1_000, { inner: 2, outer: 2, inFlight: [] });
    expect(h.resume()).toMatchObject({ inner: 2, inFlight: [] });
  });

  test("discards a gap the watchdog itself slept through: the process was suspended", () => {
    const h = harness();
    h.healthy(2);
    h.jumpClock(30_000);
    expect(h.resume()).toBeNull();
    // And the next real stall is still reported.
    h.healthy(2);
    h.stuck(1_000, { inner: 3, outer: 3, inFlight: [] });
    expect(h.resume()).toMatchObject({ inner: 3 });
  });
});

describe("ProfileTrigger", () => {
  const policy = { minStallMs: 1_000, stallCount: 3, windowMs: 120_000, cooldownMs: 900_000 };

  test("starts a capture on the stall that completes the budget, and not before", () => {
    const t = new ProfileTrigger(policy);
    expect(t.noteStall(1_500, 0)).toBe(false);
    expect(t.noteStall(900, 1_000)).toBe(false); // too short to count
    expect(t.noteStall(1_200, 2_000)).toBe(false);
    expect(t.noteStall(2_000, 3_000)).toBe(true);
  });

  test("counts only stalls within the window", () => {
    const t = new ProfileTrigger(policy);
    t.noteStall(1_500, 0);
    t.noteStall(1_500, 20_000);
    expect(t.noteStall(1_500, 130_000)).toBe(false); // the first has aged out
    expect(t.noteStall(1_500, 131_000)).toBe(true);
  });

  test("captures once at a time, and not again until the cooldown has passed", () => {
    const t = new ProfileTrigger(policy);
    for (const at of [0, 1, 2]) t.noteStall(1_500, at);
    for (const at of [3, 4, 5]) expect(t.noteStall(1_500, at)).toBe(false); // still running
    t.finished();
    for (const at of [10, 11, 12]) expect(t.noteStall(1_500, at)).toBe(false); // cooling down
    for (const at of [900_100, 900_101]) expect(t.noteStall(1_500, at)).toBe(false);
    expect(t.noteStall(1_500, 900_102)).toBe(true);
  });
});
