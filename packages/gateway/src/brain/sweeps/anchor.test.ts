// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for sweep scheduling: boundary arithmetic, the drift-free due gate,
 * the first-pass seed, downtime collapsing to one fire, a real DST transition,
 * and the derived anchors that keep unscheduled sweeps out of the morning
 * digest's window.
 */

import { describe, test, expect } from "vitest";
import {
  deriveAnchorMinutes,
  formatClockTime,
  isInQuietWindow,
  mostRecentSweepBoundary,
  parseClockTime,
  sweepDue,
} from "./anchor.js";

const HOUR = 3_600_000;

function local(y: number, m: number, d: number, h = 0, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

/**
 * The DST case can only be asserted in a zone that actually shifts on the date
 * it uses. CI and the dev boxes run Europe/London; elsewhere the case is
 * skipped rather than asserted against a zone where nothing happens.
 */
function isEuropeLondon(): boolean {
  return Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/London";
}

describe("parseClockTime / formatClockTime", () => {
  test("round-trips valid 24-hour times", () => {
    expect(parseClockTime("00:00")).toBe(0);
    expect(parseClockTime("06:30")).toBe(390);
    expect(parseClockTime("23:59")).toBe(1439);
    expect(parseClockTime(" 9:05 ")).toBe(545);
    expect(formatClockTime(390)).toBe("06:30");
    expect(formatClockTime(0)).toBe("00:00");
    expect(formatClockTime(1439)).toBe("23:59");
  });

  test("rejects anything that is not a wall-clock time", () => {
    for (const bad of ["24:00", "12:60", "noon", "6.30", "", "1230"]) {
      expect(parseClockTime(bad)).toBeNull();
    }
  });
});

describe("mostRecentSweepBoundary", () => {
  test("is today's anchor once it has passed, else yesterday's", () => {
    expect(mostRecentSweepBoundary(local(2026, 7, 2, 10), 9 * 60)).toBe(local(2026, 7, 2, 9));
    expect(mostRecentSweepBoundary(local(2026, 7, 2, 8), 9 * 60)).toBe(local(2026, 7, 1, 9));
  });

  test("lands exactly on the anchor at the anchor", () => {
    const at = local(2026, 7, 2, 9);
    expect(mostRecentSweepBoundary(at, 9 * 60)).toBe(at);
  });
});

describe("sweepDue", () => {
  const weekly = (nowMs: number, lastBoundaryMs: number) =>
    sweepDue({ nowMs, cadenceHours: 168, anchorMinutes: 9 * 60, lastBoundaryMs });

  test("the first ever pass seeds instead of firing, landing the first run on the next anchor", () => {
    // Otherwise a fresh install fires every sweep at once, in whatever part of
    // the day the gateway happened to start.
    const seeded = weekly(local(2026, 7, 2, 14), 0);
    expect(seeded).toEqual({ due: false, seedBoundaryMs: local(2026, 6, 26, 9) });
    const seed = (seeded as { seedBoundaryMs: number }).seedBoundaryMs;
    // Not before the next anchor...
    expect(weekly(local(2026, 7, 3, 8), seed).due).toBe(false);
    // ...and exactly on it.
    expect(weekly(local(2026, 7, 3, 9), seed)).toEqual({
      due: true,
      boundaryMs: local(2026, 7, 3, 9),
    });
  });

  test("a daily sweep seeded on its first pass fires at tomorrow's anchor", () => {
    const daily = (nowMs: number, lastBoundaryMs: number) =>
      sweepDue({ nowMs, cadenceHours: 24, anchorMinutes: 9 * 60, lastBoundaryMs });
    const seeded = daily(local(2026, 7, 2, 14), 0);
    expect(seeded).toEqual({ due: false, seedBoundaryMs: local(2026, 7, 2, 9) });
    expect(daily(local(2026, 7, 3, 9), local(2026, 7, 2, 9)).due).toBe(true);
  });

  test("holds until a full cadence has passed, then fires on the anchor", () => {
    const last = local(2026, 7, 2, 9);
    expect(weekly(local(2026, 7, 8, 23), last).due).toBe(false);
    expect(weekly(local(2026, 7, 9, 8), last).due).toBe(false);
    expect(weekly(local(2026, 7, 9, 23), last)).toEqual({
      due: true,
      boundaryMs: local(2026, 7, 9, 9),
    });
  });

  test("the fire records the boundary, so a late tick does not push the phase forward", () => {
    // Ticking at 23:00 every week would drift a schedule that stored `now`.
    let last = local(2026, 7, 2, 9);
    for (const day of [9, 16, 23, 30]) {
      const r = weekly(local(2026, 7, day, 23), last);
      expect(r).toEqual({ due: true, boundaryMs: local(2026, 7, day, 9) });
      last = (r as { boundaryMs: number }).boundaryMs;
    }
  });

  test("downtime spanning several periods yields exactly one fire", () => {
    const last = local(2026, 7, 2, 9);
    const r = weekly(local(2026, 8, 20, 15), last);
    expect(r).toEqual({ due: true, boundaryMs: local(2026, 8, 20, 9) });
    // Having fired for that boundary, it is not due again the same day.
    expect(weekly(local(2026, 8, 20, 23), local(2026, 8, 20, 9)).due).toBe(false);
  });

  test("a backwards clock jump past a fired boundary stays quiet", () => {
    expect(weekly(local(2026, 7, 2, 10), local(2026, 7, 9, 9)).due).toBe(false);
  });

  test("a daily cadence still fires across a real DST transition", () => {
    // Europe/London springs forward on 2026-03-29, so that local day is 23
    // hours. Counting whole local days is what keeps the sweep on its anchor
    // instead of skipping the period or firing early.
    if (!isEuropeLondon()) return;
    const before = local(2026, 3, 28, 9);
    const across = sweepDue({
      nowMs: local(2026, 3, 29, 9),
      cadenceHours: 24,
      anchorMinutes: 9 * 60,
      lastBoundaryMs: before,
    });
    expect(across).toEqual({ due: true, boundaryMs: local(2026, 3, 29, 9) });
    // The boundary is the operator's 09:00 wall-clock time, not 10:00.
    expect(new Date(local(2026, 3, 29, 9)).getHours()).toBe(9);
    expect(mostRecentSweepBoundary(local(2026, 3, 29, 12), 9 * 60)).toBe(local(2026, 3, 29, 9));
    // And it does not fire twice on the same shortened day.
    expect(
      sweepDue({
        nowMs: local(2026, 3, 29, 23),
        cadenceHours: 24,
        anchorMinutes: 9 * 60,
        lastBoundaryMs: local(2026, 3, 29, 9),
      }).due,
    ).toBe(false);
  });

  test("a cadence that is not a whole number of days rounds to the nearest one", () => {
    // 36h is 1.5 days. Rounding to 2 is what stops it coming round daily —
    // which is what a millisecond comparison with any usable DST slack does.
    const every36h = (nowMs: number, lastBoundaryMs: number) =>
      sweepDue({ nowMs, cadenceHours: 36, anchorMinutes: 9 * 60, lastBoundaryMs });
    const last = local(2026, 7, 1, 9);
    expect(every36h(local(2026, 7, 2, 10), last).due).toBe(false);
    expect(every36h(local(2026, 7, 3, 10), last).due).toBe(true);
    // And 30h (1.25 days) rounds down to 1: it runs daily.
    expect(
      sweepDue({
        nowMs: local(2026, 7, 2, 10),
        cadenceHours: 30,
        anchorMinutes: 9 * 60,
        lastBoundaryMs: last,
      }).due,
    ).toBe(true);
  });
});

describe("deriveAnchorMinutes", () => {
  const quiet = { startMinutes: 5 * 60, endMinutes: 7 * 60 + 45 };

  test("is stable for an id and spread across ids", () => {
    expect(deriveAnchorMinutes("commitments-made")).toBe(deriveAnchorMinutes("commitments-made"));
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "commitments-made", "health-trends"];
    const slots = new Set(ids.map((id) => deriveAnchorMinutes(id)));
    // Collisions are possible in principle; a total collapse would mean the
    // hash is not doing its job.
    expect(slots.size).toBeGreaterThan(ids.length - 3);
  });

  test("never lands inside the digest's quiet window", () => {
    for (let i = 0; i < 500; i += 1) {
      const minutes = deriveAnchorMinutes(`sweep-${i}`, quiet);
      expect(minutes).toBeGreaterThanOrEqual(0);
      expect(minutes).toBeLessThan(1440);
      expect(isInQuietWindow(minutes, quiet)).toBe(false);
    }
  });

  test("handles a window that wraps midnight", () => {
    const wrapping = { startMinutes: 23 * 60, endMinutes: 60 };
    for (let i = 0; i < 200; i += 1) {
      expect(isInQuietWindow(deriveAnchorMinutes(`s${i}`, wrapping), wrapping)).toBe(false);
    }
  });

  test("a window covering all but one minute still leaves a schedulable slot", () => {
    const almostAllDay = { startMinutes: 1, endMinutes: 0 };
    for (const id of ["a", "b", "c"]) {
      const minutes = deriveAnchorMinutes(id, almostAllDay);
      expect(minutes).toBe(0);
      expect(isInQuietWindow(minutes, almostAllDay)).toBe(false);
    }
  });
});

describe("isInQuietWindow", () => {
  test("is half-open, and handles midnight wrap", () => {
    const w = { startMinutes: 300, endMinutes: 465 };
    expect(isInQuietWindow(300, w)).toBe(true);
    expect(isInQuietWindow(464, w)).toBe(true);
    expect(isInQuietWindow(465, w)).toBe(false);
    const wrap = { startMinutes: 1380, endMinutes: 60 };
    expect(isInQuietWindow(1400, wrap)).toBe(true);
    expect(isInQuietWindow(30, wrap)).toBe(true);
    expect(isInQuietWindow(600, wrap)).toBe(false);
  });

  test("an empty window contains nothing", () => {
    expect(isInQuietWindow(0, { startMinutes: 0, endMinutes: 0 })).toBe(false);
  });
});
