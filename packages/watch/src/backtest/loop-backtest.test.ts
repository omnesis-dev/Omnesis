// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The facts the compiler's loop reads off a replay, and how they are said.
 *
 * The loop is stated against these rather than against either substrate's own
 * report, because a universe and a live install measure the same watch and
 * answer in different shapes. What matters is that both can say the same things,
 * and that neither can accidentally say something it did not measure.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { failureFrom } from "./backtest.js";
import {
  formatBacktest,
  type LoopBacktest,
  type LoopBacktestFacts,
  type StateBounds,
} from "./loop-backtest.js";

// State bounds arrive as their own argument because they are their own
// measurement: a replay either tracked instance lifetimes or did not, and the
// nodes and their peaks are two halves of one answer.
function measured(
  overrides: Partial<LoopBacktestFacts> = {},
  bounds: StateBounds = {},
): LoopBacktest {
  return {
    watch: "a-parcel-shipped",
    events: 4_200,
    days: 90,
    firings: 3,
    reachByNode: {},
    totalReaches: 0,
    ...overrides,
    ...bounds,
  };
}

describe("the replay, in the words the model is shown", () => {
  it("states the window the rates are computed against", () => {
    // Every number under it is a rate, and a reader given the count without the
    // span has no way to tell a busy watch from a long window.
    expect(formatBacktest(measured())).toContain("replayed 4200 events over 90 days");
  });

  it("says a watch decides procedurally rather than reporting zero reaches", () => {
    // Zero reaches on a watch with no judge is a fact about its design, not a
    // symptom — and phrased as a count it reads like something to fix.
    expect(formatBacktest(measured())).toContain("this watch decides procedurally");
  });

  it("gives each judged node its own rate", () => {
    const text = formatBacktest(
      measured({ reachByNode: { mail: 90, calls: 45 }, totalReaches: 135 }),
    );
    expect(text).toContain("mail: 90 (1.00/day)");
    expect(text).toContain("calls: 45 (0.50/day)");
  });

  it("says a replay ran out of history before it ran out of window", () => {
    // Every zero under this line is read differently depending on it. Ninety
    // quiet days is evidence a condition does not occur; twelve is an install
    // that has not been running long, and repairing a watch on the strength of
    // it means changing a filter that was never shown to be wrong.
    const text = formatBacktest(measured({ days: 12, daysRequested: 90 }));
    expect(text).toContain("over 12 days (90 asked for");
    expect(text, "an exhausted journal was described as a ceiling").toContain(
      "the journal reaches no further back",
    );
  });

  it("says a ceiling was a ceiling, not the end of the history", () => {
    // These produce the same small number of days and call for opposite
    // conclusions. A ceiling means the install has more history than one replay
    // reads, so a longer look is available; the end of the history means there
    // is nothing older, and nothing more can be learned until time passes.
    // Observed live: a ninety-day request bound by an event backstop on an
    // install whose journal goes back far further.
    const text = formatBacktest(measured({ days: 12, daysRequested: 90, windowWasCapped: true }));
    expect(text, "a capped window was reported as an exhausted journal").not.toContain(
      "reaches no further back",
    );
    expect(text).toContain("one replay reads no more than that at once");
  });

  it("does not blame the journal for a window the watch itself ended", () => {
    // A `once_ever` watch that fires on day two of a ninety-day request consumed
    // two days and retired. The journal reaches back fine — there was simply
    // nothing left to replay. Telling a model "the journal reaches no further
    // back" is a false statement about the install, shown to it exactly when a
    // concern is asking it to change the watch.
    const fired = formatBacktest(
      measured({ days: 2, daysRequested: 90, firings: 1, endedEarly: "fired" }),
    );
    expect(fired, "a retired watch's short span was blamed on the journal").not.toContain(
      "the journal reaches no further back",
    );
    expect(fired).toContain("the watch fired and retired");

    const expired = formatBacktest(
      measured({ days: 3, daysRequested: 90, firings: 0, endedEarly: "expired" }),
    );
    expect(expired).toContain("the watch's horizon passed");

    // The discriminating half: without a retirement the same short window is
    // still the journal's fault, so the assertions above are about the
    // retirement and not about the span.
    expect(formatBacktest(measured({ days: 2, daysRequested: 90 }))).toContain(
      "the journal reaches no further back",
    );

    // Both at once is reachable — a backstop cuts the old end of the window and
    // the horizon sits inside what survives — and the watch is the one to say.
    // A ceiling means a longer look is available, which is not true of a window
    // there is no more watch to fill.
    expect(
      formatBacktest(
        measured({ days: 5, daysRequested: 90, windowWasCapped: true, endedEarly: "expired" }),
      ),
      "a capped window outranked the watch that ended inside it",
    ).toContain("the watch's horizon passed");
  });

  it("says nothing about it when the replay covered what it asked for", () => {
    // The discriminating half. Restating the window when it was fully covered
    // is noise, and noise in a report a model acts on is not free.
    expect(formatBacktest(measured({ days: 90, daysRequested: 90 }))).not.toContain("asked for");
  });

  it("says nothing about state bounds when the replay did not measure them", () => {
    // The discriminating case. An absent measurement and a measurement of none
    // lead to opposite revisions, and only one of them is true of a replay that
    // does not track instance lifetimes.
    const text = formatBacktest(measured());
    expect(text).not.toContain("holds state with no deadline");
  });

  it("names an unbounded node when the replay did measure them", () => {
    const text = formatBacktest(
      measured(
        {},
        { unboundedNodes: ["wait-for-reply"], peakInstancesByNode: { "wait-for-reply": 41 } },
      ),
    );
    expect(text).toContain("wait-for-reply holds state with no deadline — peaked at 41");
  });

  it("cannot be given an unbounded node without the peaks that qualify it", () => {
    // The formatter has one number to print per unbounded node and no way to
    // measure it, so a report carrying the nodes without any peaks would have it
    // inventing every one — in a report whose discipline is to state only what
    // was measured. The two fields are one measurement, and the type says so;
    // the assertion that a half-measurement is rejected is the directive below,
    // which the `typecheck:tests` lane enforces and `vitest` cannot see.
    // @ts-expect-error — nodes without peaks is not a measurement anything makes
    const half: StateBounds = { unboundedNodes: ["wait-for-reply"] };
    expect(half.unboundedNodes).toEqual(["wait-for-reply"]);
    // A node inside a measurement that has no entry never armed, and zero is
    // then the measured peak rather than an invented one.
    expect(
      formatBacktest(measured({}, { unboundedNodes: ["idle"], peakInstancesByNode: {} })),
    ).toContain("idle holds state with no deadline — peaked at 0 live instances");
  });

  it("does not divide by zero on a window that consumed no time", () => {
    const text = formatBacktest(measured({ days: 0, reachByNode: { mail: 7 }, totalReaches: 7 }));
    expect(text).toContain("mail: 7");
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("NaN");
  });
});

describe("lifting a crashed node out of a universe replay", () => {
  const record = (transition: string, nodeId: string, failure?: string, detail?: string) =>
    ({
      seq: 1,
      nodeId,
      key: "singleton",
      transition,
      ...(failure ? { failure } : {}),
      ...(detail ? { detail } : {}),
    }) as never;

  it("finds the node that threw, with the engine's own words", () => {
    // The loop reads one field; only this substrate answers with a trace. If the
    // lifting stops working the crash becomes invisible — and a crash reported
    // as silence sends the model to loosen a filter that was never the problem.
    expect(
      failureFrom({
        watch: "w",
        records: [record("declined", "mail"), record("failed", "spend", "query", "no such column")],
        firings: [],
      } as never),
    ).toEqual({ failure: { nodeId: "spend", detail: "query: no such column" } });
  });

  it("keeps the kind, which is what says where to look", () => {
    // The discriminating case, and the one both substrates have to agree on: a
    // budget failure and a query failure read identically once the kind is
    // dropped, and they send a reader to opposite parts of the watch.
    expect(
      failureFrom({
        watch: "w",
        records: [record("failed", "spend", "budget")],
        firings: [],
      } as never),
    ).toEqual({ failure: { nodeId: "spend", detail: "budget" } });
  });

  it("reports the node even when the engine said nothing about why", () => {
    expect(
      failureFrom({ watch: "w", records: [record("failed", "spend")], firings: [] } as never),
    ).toEqual({ failure: { nodeId: "spend" } });
  });

  it("says nothing at all about a replay where nothing threw", () => {
    // Absent rather than a null failure: the loop spreads this into the report,
    // and a present-but-empty field would read as a crash with no name.
    expect(
      failureFrom({ watch: "w", records: [record("declined", "mail")], firings: [] } as never),
    ).toEqual({});
  });
});
