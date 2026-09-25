// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Recurring time sources, on a runtime that is not replaying.
 *
 * A backtest hands the engine a journal and lets the events carry the clock, so
 * a boundary comes due because an event after it arrived. A live host has
 * neither guarantee: a watch added today starts with its cursor already at the
 * journal head, and a watch whose only outstanding work is a daily boundary has
 * no events at all. Both of those made a `source.time` watch silently do
 * nothing — it installed, validated, sat active, and had no timer.
 */

import { describe, expect, it } from "vitest";

import { Ontology } from "../ontology/snapshot.js";
import { WatchEngine } from "./engine.js";
import { WatchStateStore } from "./state.js";
import type { JournalEvent } from "../journal/event.js";

const ontology = Ontology.parse({
  fingerprint: "timers",
  sources: [],
  analyticsTables: [],
  people: [],
});

const NOON = Date.parse("2026-03-01T12:00:00Z");
const DAY_MS = 86_400_000;

/** A watch that fires on a daily boundary and nothing else. */
const daily = {
  name: "morning-digest",
  firing_policy: "stays_active",
  ontology_fingerprint: "timers",
  nodes: [
    {
      id: "tick",
      type: "source.time",
      recurring: "0 9 * * *",
      output_map: { at: "$e.dueAt" },
    },
  ],
  sink: { input: "tick", output_map: { at: "$n.tick.at" } },
};

function engine(store: WatchStateStore, journal: JournalEvent[], timeReachedMs: number) {
  return new WatchEngine({
    watch: daily as never,
    ontology,
    journal,
    analytics: { query: () => Promise.resolve({ rows: [], columns: [] }) },
    judge: { judge: () => ({ fired: false, output: {} }) },
    recall: { score: () => 0 },
    store,
    timeReachedMs,
  });
}

describe("a recurring source on a live host", () => {
  it("arms even though the cursor was seeded past the beginning", async () => {
    // A watch added today is pointed at the journal head before its first
    // evaluation, so its cursor is never zero. Arming only at zero meant a
    // recurring source got its first boundary exactly never.
    const store = new WatchStateStore();
    store.advanceCursor("morning-digest", 4_000);

    await engine(store, [], NOON).run();

    const due = store.dueTimers("morning-digest", NOON + DAY_MS);
    expect(due, "no boundary was scheduled for a watch that starts mid-journal").toHaveLength(1);
    expect(due[0]?.kind).toBe("tick");
    store.close();
  });

  it("fires with no events to carry the clock", async () => {
    // The only thing this watch is waiting for is a time. A pass that returned
    // early for want of journal events would leave it waiting for unrelated
    // traffic to drag the clock past its boundary — so whether a digest fires
    // would depend on whether anything else happened that morning.
    const store = new WatchStateStore();
    await engine(store, [], NOON).run();

    // A day later, still with nothing in the journal.
    const trace = await engine(store, [], NOON + DAY_MS).run();

    expect(trace.firings, "a time-driven watch needed an unrelated event to fire").toHaveLength(1);
    store.close();
  });

  it("does not fire boundaries from before it existed", async () => {
    // The semantic clock starts at the first event in the slice, and a source
    // backfilling carries instants from years ago. Anchoring the first boundary
    // there would produce every boundary since, for a watch that did not exist
    // for any of them.
    const store = new WatchStateStore();
    const ancient = "2019-01-01T00:00:00Z";
    const backfilled: JournalEvent[] = [
      {
        seq: 1,
        kind: "doc.indexed",
        occurredAt: ancient,
        observedAt: "2026-03-01T11:59:00Z",
        payload: { docId: "aaaaaaaa-0000-4000-8000-000000000001", eventIndexedAt: ancient },
      } as JournalEvent,
    ];

    const trace = await engine(store, backfilled, NOON).run();

    expect(
      trace.firings,
      "a backfilled document produced years of missed daily boundaries",
    ).toHaveLength(0);
    store.close();
  });
});
