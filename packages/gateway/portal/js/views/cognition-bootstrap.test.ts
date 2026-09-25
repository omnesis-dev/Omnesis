// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-logic coverage for the Bootstrap panel: the state vocabulary, the ETA's
 * refusal to answer when it cannot answer honestly, and the rule that decides
 * whether the backlog may be read as a denominator at all.
 * Plain function calls in the node env — same harness as cognition.test.ts.
 */

import { describe, expect, test } from "vitest";
// @ts-expect-error plain-JS portal module without type declarations
import * as panel from "./cognition-bootstrap.js";

describe("lane state vocabulary", () => {
  test("every state has a label and a colour", () => {
    for (const state of ["off", "holding", "running", "drained", "parked"]) {
      expect(panel.stateLabel(state)).not.toBe(state === "off" ? "off" : "");
      expect(panel.stateColor(state)).toMatch(/^var\(--/);
    }
  });

  test("parked reads as a fault and drained does not", () => {
    // Both are quiet states, but only one is something the operator has to act
    // on — the colours have to distinguish them or the panel buries the bug it
    // exists to surface.
    expect(panel.stateColor("parked")).toBe("var(--danger)");
    expect(panel.stateColor("drained")).toBe("var(--warning)");
    expect(panel.stateColor("running")).toBe("var(--success)");
  });

  test("an unknown state renders as itself rather than blank", () => {
    expect(panel.stateLabel("something-new")).toBe("something-new");
    expect(panel.stateColor("something-new")).toBe("var(--text-secondary)");
  });
});

const RUNNING = {
  state: "running",
  totalEnqueued: 2300,
  settings: { maxRunsPerDay: 200, maxRuns: 1_000_000 },
};

describe("etaDays", () => {
  test("rounds up, because a partial day is still a day of waiting", () => {
    expect(panel.etaDays(RUNNING, 3782)).toBe(19);
    expect(panel.etaDays(RUNNING, 1)).toBe(1);
  });

  test("refuses to project for a lane that will never move", () => {
    // The failure this guards against is specific: a parked lane still has a
    // configured pace, so dividing by it prints a confident ETA directly under
    // a banner saying the lane is stopped until someone raises a knob.
    for (const state of ["parked", "off", "drained", "holding"]) {
      expect(panel.etaDays({ ...RUNNING, state }, 3782)).toBeNull();
    }
  });

  test("is bounded by the lifetime backstop, not just the daily pace", () => {
    // 3,782 owed but only 100 runs left before `maxRuns` parks it: it will
    // work through 100, not 3,782, and one day is the honest answer.
    const nearlyParked = { ...RUNNING, totalEnqueued: 999_900 };
    expect(panel.etaDays(nearlyParked, 3782)).toBe(1);
    // And with no headroom at all there is nothing to project.
    expect(panel.etaDays({ ...RUNNING, totalEnqueued: 1_000_000 }, 3782)).toBeNull();
  });

  test("declines to answer when there is nothing to say", () => {
    expect(panel.etaDays(RUNNING, 0)).toBeNull();
    expect(panel.etaDays({ ...RUNNING, settings: { maxRunsPerDay: 0, maxRuns: 10 } }, 3782)).toBeNull();
    expect(panel.etaDays(RUNNING, undefined)).toBeNull();
    expect(panel.etaDays(null, 3782)).toBeNull();
  });

  test("formatEta pluralises and passes null through", () => {
    expect(panel.formatEta(19)).toBe("19 days");
    expect(panel.formatEta(1)).toBe("1 day");
    expect(panel.formatEta(null)).toBeNull();
  });
});

describe("canRecount", () => {
  test("is false while the gateway is still serving the same snapshot", () => {
    // Otherwise the button flips to "Counting…" and hands back the identical
    // numbers with the identical timestamp — a control that lies about acting.
    const backlog = { staleAfter: "2026-08-23T12:01:00.000Z" };
    expect(panel.canRecount(backlog, Date.parse("2026-08-23T12:00:30.000Z"))).toBe(false);
    expect(panel.canRecount(backlog, Date.parse("2026-08-23T12:01:00.000Z"))).toBe(true);
  });

  test("permits a recount when there is nothing cached, or the stamp is unreadable", () => {
    expect(panel.canRecount(null)).toBe(true);
    expect(panel.canRecount({ staleAfter: "nonsense" })).toBe(true);
  });
});

describe("backlogIsSettled", () => {
  test("is false while documents are still awaiting a date scan", () => {
    // The backlog only counts documents with extracted dates, so an unscanned
    // document is invisible to it and will ENTER the count later. Until the
    // scan is done the figure is rising, and must not be read as a denominator.
    expect(panel.backlogIsSettled({ remaining: 100, dateScanPending: 5_000 })).toBe(false);
  });

  test("is true once the scan has caught up", () => {
    expect(panel.backlogIsSettled({ remaining: 100, dateScanPending: 0 })).toBe(true);
  });

  test("is false with no backlog at all", () => {
    expect(panel.backlogIsSettled(null)).toBe(false);
    expect(panel.backlogIsSettled(undefined)).toBe(false);
  });
});

describe("formatting", () => {
  test("counts are grouped, absent counts are an em dash", () => {
    expect(panel.fmtCount(172651)).toBe("172,651");
    expect(panel.fmtCount(0)).toBe("0");
    expect(panel.fmtCount(null)).toBe("—");
    expect(panel.fmtCount(undefined)).toBe("—");
  });

});

describe("module health", () => {
  test("exports the tab component", () => {
    expect(typeof panel.BootstrapTab).toBe("function");
  });
});

describe("capExceedsThroughput", () => {
  const base = {
    settings: { maxRunsPerDay: 1500 },
    enqueuedToday: 1500,
    completedLast24h: 400,
  };

  test("flags a cap the lane demonstrably cannot reach", () => {
    // The lane spent its whole allowance and still got through a quarter of
    // it, so the number above is decoration.
    expect(panel.capExceedsThroughput(base)).toBe(true);
  });

  test("stays quiet when the lane is keeping up", () => {
    expect(panel.capExceedsThroughput({ ...base, completedLast24h: 1400 })).toBe(false);
  });

  test("stays quiet when the lane never tried to spend its allowance", () => {
    // A lane that enqueued less than its cap was limited by something else —
    // an empty backlog, a pause, a budget. Blaming throughput would be a
    // confident wrong diagnosis, and the operator would raise a cap that was
    // never the constraint.
    expect(panel.capExceedsThroughput({ ...base, enqueuedToday: 300 })).toBe(false);
  });

  test("stays quiet with no evidence at all", () => {
    expect(panel.capExceedsThroughput({ ...base, completedLast24h: 0 })).toBe(false);
    expect(panel.capExceedsThroughput(null)).toBe(false);
    expect(panel.capExceedsThroughput({ settings: {}, enqueuedToday: 0 })).toBe(false);
  });
});
