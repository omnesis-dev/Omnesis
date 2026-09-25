// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A timer comes due in real time, and an event's semantic time is not that.
 *
 * `occurredAt` says when a thing happened, and for most feeds that is at or
 * before the moment it was recorded. Not for all of them: a calendar row
 * carries the appointment's *start*, so making an appointment for tomorrow puts
 * an event dated tomorrow on the journal today.
 *
 * The engine walks the journal on semantic time, which is what makes a replay
 * agree with the live run, and it drains timers as it goes. Drained to a
 * forward-dated event, a daily tick fires the boundary it was going to fire
 * tomorrow — early, against data that does not exist yet — and then reschedules
 * past it. The schedule silently loses a day, and nothing anywhere says so.
 *
 * That is what happened on a live install: an appointment made for the next
 * morning fired four daily watches a day early and moved their next run from
 * Sunday to Monday.
 *
 * So a drain is bounded by how far real time has actually got, which a live
 * host already supplies for the end-of-run drain. A replay supplies none and
 * needs none: its journal is the whole of what happened.
 */

import { describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { WatchEngine } from "./engine.js";
import { CountingJudge, ScriptedRecall } from "./providers.js";
import { hashKey, WatchStateStore } from "./state.js";
import type { JournalEvent } from "../journal/event.js";
import type { WatchTrace } from "./trace.js";

const ontology = loadOntology();

/** 09:00 UTC on a March day, which is where the daily tick lands. */
function nineAm(day: number): string {
  return new Date(Date.UTC(2026, 2, day, 9)).toISOString();
}

function instant(day: number, hour: number, minute = 0): string {
  return new Date(Date.UTC(2026, 2, day, hour, minute)).toISOString();
}

/**
 * One document event, with its two times given separately.
 *
 * The whole subject here is what happens when they disagree, so no fixture may
 * quietly set them from one value.
 */
function doc(seq: number, occurredAt: string, observedAt: string): JournalEvent {
  return {
    seq,
    kind: "doc.event",
    occurredAt,
    observedAt,
    payload: {
      op: "created",
      docId: `d0c00000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      sourceId: "gmail",
      providerId: "google",
      documentType: "email",
      title: `message ${seq}`,
      semanticTime: occurredAt,
      changedFields: [],
      contentChanged: false,
      metadata: {},
      people: [],
    },
  };
}

/** A watch that does nothing but record every daily boundary it is given. */
const DAILY = {
  watch: {
    name: "daily-tick",
    firing_policy: "stays_active",
    ontology_fingerprint: ontology.fingerprint,
    nodes: [{ id: "morning", type: "source.time", recurring: "0 9 * * *" }],
    sink: { input: "morning", output_map: {} },
  },
};

async function run(journal: JournalEvent[], timeReachedMs?: number): Promise<WatchTrace> {
  const result = validateWatch(DAILY, ontology);
  expect(result.valid, result.diagnostics.map((d) => d.code).join(", ")).toBe(true);

  const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
  const store = new WatchStateStore();
  try {
    return await new WatchEngine({
      watch: watchDslSchema.parse(DAILY).watch,
      watchId: "w-daily",
      ontology,
      journal,
      analytics,
      store,
      ...(timeReachedMs === undefined ? {} : { timeReachedMs }),
      judge: new CountingJudge(),
      recall: new ScriptedRecall([], 0),
    }).run();
  } finally {
    store.close();
    analytics.close();
  }
}

/** The boundaries a run fired, as ISO instants. */
function boundaries(trace: WatchTrace): string[] {
  return trace.firings.map((f) => f.firedAt);
}

/**
 * A watch that was already running, over a host that was not.
 *
 * A fresh watch arms its first boundary from real time — deliberately, so
 * connecting a source that backfills does not fire every boundary since. That
 * makes it the wrong shape for testing catch-up, which is about boundaries a
 * watch was *already* waiting on. So the tick is seeded where an earlier run
 * would have left it, and then the run resumes two days later.
 */
async function afterAnOutage(): Promise<string[]> {
  const store = new WatchStateStore();
  const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
  try {
    store.setTimerIfAbsent({
      watchId: "w-daily",
      nodeId: "morning",
      keyHash: hashKey({}),
      instance: 0,
      key: {},
      dueAtMs: Date.parse(nineAm(5)),
      kind: "tick",
    });
    const trace = await new WatchEngine({
      watch: watchDslSchema.parse(DAILY).watch,
      watchId: "w-daily",
      ontology,
      journal: [doc(1, instant(7, 10), instant(7, 10))],
      analytics,
      store,
      timeReachedMs: Date.parse(instant(7, 10)),
      judge: new CountingJudge(),
      recall: new ScriptedRecall([], 0),
    }).run();
    return boundaries(trace);
  } finally {
    store.close();
    analytics.close();
  }
}

describe("a document dated in the future", () => {
  it("does not pull tomorrow's boundary into today", async () => {
    // The live case: at 10:00 on the 4th, an appointment is made for 10:00 on
    // the 5th. Real time is still the 4th; only one boundary has been reached.
    const trace = await run(
      [doc(1, instant(4, 10), instant(4, 10)), doc(2, instant(5, 10), instant(4, 10))],
      Date.parse(instant(4, 10)),
    );
    // The first boundary is armed after the first event, so the 4th's 09:00 is
    // already behind us: nothing has been reached yet, and nothing should fire.
    expect(boundaries(trace), "a boundary that had not been reached was fired").toEqual([]);
  });

  it("leaves the next boundary where it belongs, so no day is skipped", async () => {
    // The damage the early fire does is not the extra firing — it is the one
    // that never happens, because the tick reschedules past it.
    const store = new WatchStateStore();
    const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
    try {
      await new WatchEngine({
        watch: watchDslSchema.parse(DAILY).watch,
        watchId: "w-daily",
        ontology,
        journal: [doc(1, instant(4, 10), instant(4, 10)), doc(2, instant(6, 10), instant(4, 10))],
        analytics,
        store,
        timeReachedMs: Date.parse(instant(4, 10)),
        judge: new CountingJudge(),
        recall: new ScriptedRecall([], 0),
      }).run();

      const timers = store.dueTimers("w-daily", Number.MAX_SAFE_INTEGER);
      expect(timers, "the tick lost its schedule").toHaveLength(1);
      expect(new Date(timers[0]!.dueAtMs).toISOString(), "the next boundary was skipped").toBe(
        nineAm(5),
      );
    } finally {
      store.close();
      analytics.close();
    }
  });

  it("still fires every boundary real time has actually passed", async () => {
    // The other half, and the one a careless bound would break: a host that was
    // down still owes the boundaries that came due while it was. A watch armed
    // on the 5th, resuming on the 7th, owes three.
    const fired = await afterAnOutage();
    expect(fired, "an outage lost the boundaries it owed").toEqual([
      nineAm(5),
      nineAm(6),
      nineAm(7),
    ]);
  });

  it("fires them in order, not as one burst at the resume", async () => {
    const fired = await afterAnOutage();
    expect([...fired].sort(), "the catch-up came out of order").toEqual(fired);
  });
});

describe("a document dated in the past", () => {
  it("fires nothing it has not reached, as before", async () => {
    // A backfill carries instants from years ago. It must not fire boundaries
    // either — and it never did; this holds that unchanged.
    const trace = await run(
      [doc(1, instant(4, 10), instant(4, 10)), doc(2, instant(1, 10), instant(4, 10))],
      Date.parse(instant(4, 10)),
    );
    expect(boundaries(trace)).toEqual([]);
  });
});

describe("a replay, which has no real time to be bounded by", () => {
  it("drains on the journal's own clock", async () => {
    // A backtest's time stops where its events stop: the journal is the whole
    // of what happened, so semantic time is the only time there is. Bounding a
    // replay by a real clock it was never given would fire nothing at all.
    const trace = await run([
      doc(1, instant(4, 10), instant(4, 10)),
      doc(2, instant(7, 10), instant(7, 10)),
    ]);
    expect(boundaries(trace), "the replay stopped firing its own boundaries").toEqual([
      nineAm(5),
      nineAm(6),
      nineAm(7),
    ]);
  });
});

/**
 * A watch that waits a day after a message, unless a reply cancels it.
 *
 * The wait's whole point is that the reply gets to arrive first. That ordering
 * is the journal's, and it is why a drain is bounded by the *event* being
 * processed as well as by real time: a bound that only ever used real time
 * would fire every deadline already due before dispatching anything, and a
 * reply sitting later in the same slice would arrive to find the watch had
 * already spoken.
 */
const WAIT_UNLESS_REPLIED = {
  watch: {
    name: "unanswered",
    firing_policy: "stays_active",
    ontology_fingerprint: ontology.fingerprint,
    nodes: [
      {
        id: "inbound",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: {},
      },
      {
        // A different source, so an inbound mail cannot arm and cancel itself.
        id: "reply",
        type: "source.document_event",
        filter: { source: "whatsapp-messages", event: ["created"], documentType: "chat" },
        output_map: {},
      },
      {
        id: "unanswered",
        type: "stateful.wait",
        inputs: {
          inbound: { role: "arm" },
          reply: { role: "cancel" },
        },
        on_collision: "reset",
        duration: "1 days",
        output_map: {},
      },
    ],
    sink: { input: "unanswered", output_map: {} },
  },
};

/** A message on another source, which is what cancels the wait. */
function chat(seq: number, occurredAt: string, observedAt: string): JournalEvent {
  const base = doc(seq, occurredAt, observedAt);
  if (base.kind !== "doc.event") throw new Error("fixture must be a document event");
  return {
    ...base,
    payload: {
      ...base.payload,
      sourceId: "whatsapp-messages",
      providerId: "whatsapp",
      documentType: "chat",
    },
  } as JournalEvent;
}

describe("the journal's own order, which the bound must not overrule", () => {
  it("lets a reply later in the slice cancel a deadline already due in real time", async () => {
    // The inbound is at 08:00 on the 4th, so its deadline falls at 08:00 on the
    // 5th. The reply is at 20:00 on the 4th, well before it. Real time is the
    // 7th, so the deadline is long past in real terms — but the reply is the
    // earlier *event*, and it wins.
    //
    // The mail on the other thread in between is what makes this bite: it is
    // the event at which a drain bounded only by real time would sweep the
    // deadline, before the reply behind it had been dispatched at all.
    const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
    const store = new WatchStateStore();
    try {
      const result = validateWatch(WAIT_UNLESS_REPLIED, ontology);
      expect(result.valid, result.diagnostics.map((d) => d.code).join(", ")).toBe(true);

      const trace = await new WatchEngine({
        watch: watchDslSchema.parse(WAIT_UNLESS_REPLIED).watch,
        watchId: "w-unanswered",
        ontology,
        journal: [
          doc(1, instant(4, 8), instant(7, 12)),
          doc(2, instant(4, 12), instant(7, 12)),
          chat(3, instant(4, 20), instant(7, 12)),
        ],
        analytics,
        store,
        timeReachedMs: Date.parse(instant(7, 12)),
        judge: new CountingJudge(),
        recall: new ScriptedRecall([], 0),
      }).run();

      expect(
        trace.firings.length,
        "the deadline fired before the reply that cancels it was dispatched",
      ).toBe(0);
      expect(
        trace.records.some((r) => r.nodeId === "unanswered" && r.transition === "cancelled"),
        "the reply never reached the wait",
      ).toBe(true);
    } finally {
      store.close();
      analytics.close();
    }
  });
});
