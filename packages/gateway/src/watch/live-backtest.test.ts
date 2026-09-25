// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a compile-time replay of this install says what the loop needs.
 *
 * The compiler's loop reads a handful of facts off a replay and decides from
 * them whether to spend a repair turn. Getting the facts wrong is worse than
 * having none: a window that consumed nothing reads as a filter that matches
 * nothing, and the model is sent to repair a watch that was fine.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it, vi } from "vitest";

import { liveBacktestPort, loopBacktestFrom } from "./live-backtest.js";
import type { PreflightOutcome, PreflightReport } from "./preflight.js";

const DAY = 86_400_000;

function report(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    window: {
      events: 4_200,
      offered: 4_200,
      fromSeq: 1,
      toSeq: 4_200,
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-07-30T00:00:00.000Z",
      observedMs: 90 * DAY,
    },
    nodes: [],
    firings: 0,
    ...overrides,
  } as PreflightReport;
}

function node(id: string, wouldAsk: number): PreflightReport["nodes"][number] {
  return {
    nodeId: id,
    type: "source.document_event",
    evaluated: 100,
    matched: 3,
    declined: 97,
    wouldAsk,
    samples: [],
    diagnostics: [],
  } as unknown as PreflightReport["nodes"][number];
}

describe("what the loop is told about a live replay", () => {
  it("divides by the window the replay consumed, not the one it asked for", async () => {
    // The rates the concern is computed from all hang off this. A ninety-day
    // request that the journal could only answer for twelve is a twelve-day
    // denominator, and using ninety would report a watch as roughly eight times
    // quieter than it is.
    const measured = loopBacktestFrom(
      report({ window: { ...report().window, observedMs: 12 * DAY, truncated: true } }),
      "a-watch",
    );
    expect(measured?.days).toBe(12);
  });

  it("carries what was asked for, so a short window is not read as a quiet one", async () => {
    const measured = loopBacktestFrom(
      report({
        window: { ...report().window, observedMs: 12 * DAY, daysRequested: 90, truncated: true },
      }),
      "a-watch",
    );
    expect(measured?.daysRequested).toBe(90);
    // Why it fell short, which decides what the model should do about it. This
    // install's ninety-day request is bound by an event backstop, not by the
    // start of its journal.
    expect(measured?.windowWasCapped).toBe(true);
  });

  it("does not call a short window a ceiling when the journal simply ended", async () => {
    // The discriminating half. `truncated` is set only when the backstop bound
    // the run; a young install answers a ninety-day request with everything it
    // has and sets nothing.
    const measured = loopBacktestFrom(
      report({ window: { ...report().window, observedMs: 12 * DAY, daysRequested: 90 } }),
      "a-watch",
    );
    expect(measured?.daysRequested).toBe(90);
    expect(measured?.windowWasCapped).toBeUndefined();
  });

  it("counts judge reaches per node and in total", async () => {
    const measured = loopBacktestFrom(
      report({ nodes: [node("mail", 7), node("ledger", 0), node("calls", 5)] }),
      "a-watch",
    );
    expect(measured?.totalReaches).toBe(12);
    // Only the nodes that would ask, so a report the model reads is not padded
    // with zeroes for every structural filter in the plan.
    expect(measured?.reachByNode).toEqual({ mail: 7, calls: 5 });
  });

  it("says nothing about state bounds rather than reporting none", async () => {
    // This replay does not track how many instances a node held at once. An
    // empty list would state that nothing held state without a deadline — a
    // claim nobody checked, put in front of the model as though it had been.
    const measured = loopBacktestFrom(report(), "a-watch");
    expect(measured?.unboundedNodes).toBeUndefined();
    expect(measured?.peakInstancesByNode).toBeUndefined();
  });

  it("carries a node that threw, which the counts cannot show", async () => {
    const measured = loopBacktestFrom(
      report({
        failed: [{ nodeId: "spend", failure: "sql", detail: "no such column: merchant_name" }],
      }),
      "a-watch",
    );
    expect(measured?.failure).toEqual({
      nodeId: "spend",
      detail: "sql: no such column: merchant_name",
    });
  });

  it("says the replay ended early, so one firing is not read as a rate", async () => {
    // A `once_ever` watch that fires on day two of a ninety-day replay consumed
    // two days and retired. Without this the loop divides by two and reads one
    // firing as a flood, then asks for the watch to be changed.
    const measured = loopBacktestFrom(
      report({ window: { ...report().window, observedMs: 2 * DAY, ended: "fired" }, firings: 1 }),
      "a-watch",
    );
    expect(measured?.endedEarly).toBe("fired");
  });

  it("says nothing about ending early on a replay that ran the whole window", async () => {
    expect(loopBacktestFrom(report(), "a-watch")?.endedEarly).toBeUndefined();
  });

  it("reports nothing at all when the window consumed nothing", async () => {
    // A watch that reached nothing and a watch nobody replayed lead to opposite
    // revisions, and only one of them is worth a repair turn. An empty journal
    // must not be handed to the loop as a watch that matches nothing.
    expect(loopBacktestFrom(report({ window: { ...report().window, events: 0 } }), "a")).toBeNull();
    expect(
      loopBacktestFrom(report({ window: { ...report().window, observedMs: 0 } }), "a"),
    ).toBeNull();
  });
});

describe("the port the compiler calls", () => {
  const watch = { name: "a-watch", nodes: [] } as never;

  it("asks for a season, because a shorter window settles nothing", async () => {
    const days: number[] = [];
    const replay = async (_watch: never, forDays: number) => {
      days.push(forDays);
      return { outcome: "probed", report: report() } as PreflightOutcome;
    };
    await liveBacktestPort(replay as never)(watch);
    expect(days).toEqual([90]);
  });

  it("leaves a validated watch standing when the replay refuses", async () => {
    // The backtest is advice, and advice must not cost a working compilation.
    const replay = vi.fn(
      async () => ({ outcome: "refused", refusal: { reason: "cannot-score" } }) as PreflightOutcome,
    );
    await expect(liveBacktestPort(replay)(watch)).resolves.toBeNull();
  });

  it("leaves it standing when the replay throws, too", async () => {
    const replay = vi.fn(() => Promise.reject(new Error("the index was rebuilding")));
    await expect(liveBacktestPort(replay)(watch)).resolves.toBeNull();
  });

  it("says nothing at all on an install with no runtime to replay against", async () => {
    // Not a failure and not a cost. Counting it among the broken replays would
    // drown the rate that says whether this loop works, and warning once per
    // compile about a condition that will never change is noise an operator
    // learns to skip past.
    const seen: string[] = [];
    const port = liveBacktestPort(
      () => null,
      (timing) => seen.push(timing.outcome),
    );
    await expect(port(watch)).resolves.toBeNull();
    expect(seen, "an install with no runtime was timed as a replay").toEqual([]);
  });

  it("reports what the replay cost, whichever way it went", async () => {
    const seen: string[] = [];
    const ok = liveBacktestPort(
      async () => ({ outcome: "probed", report: report() }) as PreflightOutcome,
      (timing) => seen.push(timing.outcome),
    );
    const refused = liveBacktestPort(
      async () => ({ outcome: "refused", refusal: { reason: "cannot-score" } }) as PreflightOutcome,
      (timing) => seen.push(timing.outcome),
    );
    const threw = liveBacktestPort(
      () => Promise.reject(new Error("boom")),
      (timing) => seen.push(timing.outcome),
    );
    await ok(watch);
    await refused(watch);
    await threw(watch);
    // The latency of a compile with the loop on is the thing being traded
    // against the answer it buys, so every outcome has to be timed — including
    // the ones that produce no report, which are not free.
    //
    // A refusal and a throw are counted apart. Both leave the compile standing
    // and both cost time, but one is the replay declining a candidate it cannot
    // score and the other is the replay itself being broken — and a rate of the
    // second is the thing that would say this loop should be turned off.
    expect(seen).toEqual(["replayed", "refused", "failed"]);
  });
});
