// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading live state back out of a runtime that really ran.
 *
 * Every fixture here is **multi-key**, and one of them is multi-instance inside
 * a key. That is not thoroughness for its own sake: with one cell live, a
 * per-node reading and a per-cell reading are indistinguishable — every
 * assertion passes either way — and the keying and ordering mistakes this
 * reading exists to expose only appear once two populations have to be told
 * apart. So the engine is driven, not stubbed, and what comes back is checked
 * key by key.
 */

import { describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { WatchEngine } from "./engine.js";
import { readWatchState } from "./state-view.js";
import { WatchStateStore } from "./state.js";
import type { JournalEvent } from "../journal/event.js";
import type { WatchStateSnapshot } from "./state-view.js";

const ontology = loadOntology();
const SELF = "0a1b2c3d-0000-4000-8000-000000000001";
const CONTACT = "b3f2a9d4-0000-4000-8000-000000000002";
const WATCH_ID = "watch-under-test";
const DAY_MS = 86_400_000;

/** An inbound source node, keyed downstream by its thread. */
function inbound(id: string, fromSelf: boolean): Record<string, unknown> {
  return {
    id,
    type: "source.document_event",
    filter: {
      source: "gmail",
      event: ["created"],
      documentType: "email",
      people: [{ role: "sender", isSelf: fromSelf }],
    },
    output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
  };
}

/** A wait that opens a parallel instance per arm, capped at three per thread. */
const SPAWN_WATCH = {
  watch: {
    name: "spawn-per-thread",
    firing_policy: "stays_active",
    nodes: [
      inbound("arrival", false),
      {
        id: "hold",
        type: "stateful.wait",
        inputs: { arrival: { role: "arm", key: { thread_id: ".thread_id" } } },
        on_collision: "spawn",
        max_live_instances: 3,
        duration: "6 days",
        output_map: { doc: "$n.arrival.doc_id" },
      },
    ],
    sink: { input: "hold", output_map: { doc: "$n.hold.doc" } },
  },
};

/** Two arms that both have to arrive on the same thread. */
const JOIN_WATCH = {
  watch: {
    name: "both-sides-of-a-thread",
    firing_policy: "stays_active",
    nodes: [
      inbound("theirs", false),
      inbound("ours", true),
      {
        id: "both",
        type: "stateful.and",
        inputs: {
          theirs: { role: "arm", key: { thread_id: ".thread_id" } },
          ours: { role: "arm", key: { thread_id: ".thread_id" } },
        },
        deadline: "6 days",
        on_collision: "reset",
        output_map: { doc: "$n.theirs.doc_id" },
      },
    ],
    sink: { input: "both", output_map: { doc: "$n.both.doc" } },
  },
};

/** The same two arms, but one has to follow the other. */
const SEQUENCE_WATCH = {
  watch: {
    name: "theirs-then-ours",
    firing_policy: "stays_active",
    nodes: [
      inbound("theirs", false),
      inbound("ours", true),
      {
        id: "order",
        type: "stateful.sequence",
        inputs: {
          theirs: { role: "arm", key: { thread_id: ".thread_id" } },
          ours: { role: "arm", key: { thread_id: ".thread_id" } },
        },
        order: ["theirs", "ours"],
        deadline: "6 days",
        on_collision: "reset",
        output_map: { doc: "$n.theirs.doc_id" },
      },
    ],
    sink: { input: "order", output_map: { doc: "$n.order.doc" } },
  },
};

/** Repeated arrivals, then a quiet period after each time it says so. */
const KEPT_UP_WATCH = {
  watch: {
    name: "kept-up-then-quiet",
    firing_policy: "stays_active",
    nodes: [
      inbound("arrival", false),
      {
        id: "persist",
        type: "stateful.persistence",
        inputs: { arrival: { role: "arm", key: { thread_id: ".thread_id" } } },
        duration: "7 days",
        min_events: 2,
        output_map: { thread_id: "$n.arrival.thread_id", doc: "$n.arrival.doc_id" },
      },
      {
        id: "cool",
        type: "stateful.cooldown",
        inputs: { persist: { role: "arm", key: { thread_id: ".thread_id" } } },
        min_interval: "2 days",
        output_map: { doc: "$n.persist.doc" },
      },
    ],
    sink: { input: "cool", output_map: { doc: "$n.cool.doc" } },
  },
};

let nextSeq = 0;

/** One email, invented: a thread, an instant, and who sent it. */
function email(thread: string, atMs: number, fromSelf = false): JournalEvent {
  const seq = ++nextSeq;
  const at = new Date(atMs).toISOString();
  return {
    seq,
    kind: "doc.event",
    occurredAt: at,
    observedAt: at,
    payload: {
      op: "created",
      docId: `d0c00000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      sourceId: "gmail",
      providerId: "google",
      documentType: "email",
      title: `message ${seq}`,
      semanticTime: at,
      changedFields: [],
      contentChanged: false,
      metadata: { extra: { threadId: thread } },
      people: [
        { personId: fromSelf ? SELF : CONTACT, role: "sender", isSelf: fromSelf },
        { personId: SELF, role: "recipient", isSelf: true },
      ],
    },
  } as JournalEvent;
}

const DAY_1 = Date.parse("2026-04-06T09:00:00Z");

/**
 * Run a fixture to a standstill and read what it left behind.
 *
 * The store outlives the engine — an engine only closes the one it opened
 * itself — which is what makes the state readable after the run.
 */
async function stateAfter(raw: unknown, journal: JournalEvent[]): Promise<WatchStateSnapshot> {
  const checked = validateWatch(raw, ontology);
  if (!checked.valid) {
    throw new Error(`fixture does not validate: ${checked.diagnostics.map((d) => d.code).join()}`);
  }
  const store = new WatchStateStore();
  const watch = watchDslSchema.parse(raw).watch;
  try {
    await new WatchEngine({
      watch,
      watchId: WATCH_ID,
      ontology,
      journal,
      analytics: { query: () => Promise.resolve({ rows: [], columns: [] }) },
      judge: { judge: () => ({ fired: false, output: {} }) },
      recall: { score: () => 0 },
      store,
    }).run();
    return readWatchState({ watch, watchId: WATCH_ID, store, parkedLimit: 50 });
  } finally {
    store.close();
  }
}

function node(snapshot: WatchStateSnapshot, nodeId: string) {
  const found = snapshot.nodes.find((entry) => entry.nodeId === nodeId);
  if (!found) throw new Error(`no node ${nodeId} in the snapshot`);
  return found;
}

describe("several keys, and several instances inside one of them", () => {
  // Two arms on one thread and one apiece on two others: three keys, four
  // cells. A reading that collapsed instances would report three.
  const journal = [
    email("alder", DAY_1),
    email("alder", DAY_1 + 3_600_000),
    email("birch", DAY_1 + 7_200_000),
    email("cedar", DAY_1 + 10_800_000),
  ];

  it("keeps each key's instances apart", async () => {
    const snapshot = await stateAfter(SPAWN_WATCH, journal);
    const hold = node(snapshot, "hold");

    expect(hold.cells).toHaveLength(4);
    const byThread = new Map<string, number>();
    for (const cell of hold.cells) {
      const thread = cell.key.thread_id as string;
      byThread.set(thread, (byThread.get(thread) ?? 0) + 1);
    }
    expect([...byThread.entries()].sort()).toEqual([
      ["alder", 2],
      ["birch", 1],
      ["cedar", 1],
    ]);
  });

  it("gives the doubled key two instance ordinals, not one repeated", async () => {
    const snapshot = await stateAfter(SPAWN_WATCH, journal);
    const alder = node(snapshot, "hold").cells.filter((cell) => cell.key.thread_id === "alder");

    expect(alder.map((cell) => cell.instance)).toEqual([0, 1]);
    // One key, so one hash — the ordinal is the only thing telling them apart.
    expect(new Set(alder.map((cell) => cell.keyHash)).size).toBe(1);
  });

  it("fires each instance at its own arm's deadline", async () => {
    const snapshot = await stateAfter(SPAWN_WATCH, journal);
    const alder = node(snapshot, "hold").cells.filter((cell) => cell.key.thread_id === "alder");

    expect(alder[0]?.detail).toEqual({ kind: "wait", firesAtMs: DAY_1 + 6 * DAY_MS });
    expect(alder[1]?.detail).toEqual({
      kind: "wait",
      firesAtMs: DAY_1 + 3_600_000 + 6 * DAY_MS,
    });
  });

  it("reports the collision policy and the ceiling it is bounded by", async () => {
    const snapshot = await stateAfter(SPAWN_WATCH, journal);
    expect(node(snapshot, "hold").onCollision).toBe("spawn");
    expect(node(snapshot, "hold").maxLiveInstances).toBe(3);
  });

  it("arms one timer per cell, soonest first", async () => {
    const snapshot = await stateAfter(SPAWN_WATCH, journal);

    expect(snapshot.timers).toHaveLength(4);
    expect(snapshot.timers.every((timer) => timer.kind === "wait")).toBe(true);
    const due = snapshot.timers.map((timer) => timer.dueAtMs);
    expect([...due].sort((a, b) => a - b)).toEqual(due);
    // Every timer carries its own key, so the list is attributable without a
    // second lookup against the cells.
    expect(snapshot.timers.map((timer) => timer.key.thread_id)).toEqual([
      "alder",
      "alder",
      "birch",
      "cedar",
    ]);
  });

  it("states the journal event the whole reading is true at", async () => {
    const snapshot = await stateAfter(SPAWN_WATCH, journal);
    expect(snapshot.asOfSeq).toBe(journal[journal.length - 1]!.seq);
  });

  it("lists a node that holds nothing rather than omitting it", async () => {
    const snapshot = await stateAfter(SPAWN_WATCH, journal);
    // A source node is a trip-wire: it never holds a cell, and a snapshot that
    // left it out would make "holds nothing" and "is not in this watch" the
    // same answer on the canvas.
    expect(node(snapshot, "arrival").cells).toEqual([]);
    expect(snapshot.nodes.map((entry) => entry.nodeId)).toEqual(["arrival", "hold"]);
  });
});

describe("a join waiting on one of its two arms", () => {
  /** Their half of one thread, our half of another — each missing the other. */
  const halves = (): JournalEvent[] => [
    email("alder", DAY_1),
    email("birch", DAY_1 + 3_600_000, true),
  ];

  it("names the arm that arrived and the one that has not", async () => {
    const journal = halves();
    const snapshot = await stateAfter(JOIN_WATCH, journal);
    const both = node(snapshot, "both");

    expect(both.cells).toHaveLength(2);
    const alder = both.cells.find((cell) => cell.key.thread_id === "alder");
    const birch = both.cells.find((cell) => cell.key.thread_id === "birch");
    // Each thread is waiting on the *other* half, which is the assertion a
    // single-key fixture cannot make. The arm remembers the event it arrived
    // on, so a join can be traced back to what filled each of its slots.
    expect(alder?.detail).toMatchObject({
      kind: "join",
      arrived: [{ from: "theirs", seq: journal[0]!.seq }],
      outstanding: ["ours"],
      required: 2,
      of: 2,
    });
    expect(birch?.detail).toMatchObject({
      kind: "join",
      arrived: [{ from: "ours", seq: journal[1]!.seq }],
      outstanding: ["theirs"],
    });
  });

  it("arms a deadline timer per key", async () => {
    const snapshot = await stateAfter(JOIN_WATCH, halves());
    expect(snapshot.timers.map((timer) => [timer.nodeId, timer.kind])).toEqual([
      ["both", "deadline"],
      ["both", "deadline"],
    ]);
  });

  it("says which cancel arms are armed against the population", async () => {
    const snapshot = await stateAfter(JOIN_WATCH, [email("alder", DAY_1)]);
    expect(node(snapshot, "both").cancelledBy).toEqual([]);
  });
});

describe("a sequence part-way through its order", () => {
  it("says which step it is on and what would advance it", async () => {
    const snapshot = await stateAfter(SEQUENCE_WATCH, [
      email("alder", DAY_1),
      email("birch", DAY_1 + 3_600_000),
    ]);
    const order = node(snapshot, "order");

    expect(order.cells).toHaveLength(2);
    for (const cell of order.cells) {
      expect(cell.detail).toMatchObject({
        kind: "sequence",
        step: 1,
        of: 2,
        nextExpected: "ours",
      });
    }
    // Two threads at the same step, and each remembers its own first element.
    expect(order.cells.map((cell) => cell.key.thread_id).sort()).toEqual(["alder", "birch"]);
  });
});

describe("an accumulator and the quiet period behind it", () => {
  // One thread arms five times — twice enough to fire, and quickly enough that
  // the second firing lands inside the cooldown. A second thread arms once, so
  // the accumulator holds two keys while the cooldown holds one.
  const journal = [
    email("alder", DAY_1),
    email("alder", DAY_1 + 3_600_000),
    email("alder", DAY_1 + 7_200_000),
    email("alder", DAY_1 + 10_800_000),
    email("alder", DAY_1 + 14_400_000),
    email("birch", DAY_1 + 18_000_000),
  ];

  it("counts arms against the floor, per key", async () => {
    const snapshot = await stateAfter(KEPT_UP_WATCH, journal);
    const persist = node(snapshot, "persist");

    expect(persist.cells.map((cell) => cell.key.thread_id).sort()).toEqual(["alder", "birch"]);
    for (const cell of persist.cells) {
      expect(cell.detail).toMatchObject({
        kind: "persistence",
        count: 1,
        required: 2,
        window: "7 days",
        windowMs: 7 * DAY_MS,
      });
      expect(cell.state).toBe("accumulating");
    }
  });

  it("derives the instant a cooldown is suppressing until", async () => {
    const snapshot = await stateAfter(KEPT_UP_WATCH, journal);
    const cool = node(snapshot, "cool");

    // Only the thread that fired holds a cooldown cell at all.
    expect(cool.cells).toHaveLength(1);
    expect(cool.cells[0]?.key.thread_id).toBe("alder");
    expect(cool.cells[0]?.detail).toEqual({
      kind: "cooldown",
      // It last fired on the second arm, and is quiet for two days from there.
      suppressingUntilMs: DAY_1 + 3_600_000 + 2 * DAY_MS,
      minInterval: "2 days",
    });
  });

  it("arms no timer for a cooldown, because nothing fires unprompted", async () => {
    const snapshot = await stateAfter(KEPT_UP_WATCH, journal);
    expect(snapshot.timers).toEqual([]);
  });
});

describe("a watch the runtime is holding nothing for", () => {
  it("returns every node with an empty population rather than nothing at all", async () => {
    // A journal with nothing this watch matches: no cell, no timer, no queue.
    const snapshot = await stateAfter(SPAWN_WATCH, [email("alder", DAY_1, true)]);

    expect(snapshot.nodes.map((entry) => entry.nodeId)).toEqual(["arrival", "hold"]);
    expect(snapshot.nodes.every((entry) => entry.cells.length === 0)).toBe(true);
    expect(snapshot.timers).toEqual([]);
    expect(snapshot.parked).toEqual([]);
  });
});

/**
 * The same store, counted rather than described — what a list of watches needs
 * and a per-watch snapshot is the wrong shape for.
 *
 * Two watches in one store, because the mistake this can make is a `GROUP BY`
 * that leaks one watch's population into another's row, and a single-watch
 * fixture passes whether or not it does.
 */
describe("what every watch is holding, in one read", () => {
  async function liveStateAfter(
    watches: { id: string; raw: unknown; journal: JournalEvent[] }[],
  ): Promise<ReturnType<WatchStateStore["liveState"]>> {
    const store = new WatchStateStore();
    try {
      for (const entry of watches) {
        await new WatchEngine({
          watch: watchDslSchema.parse(entry.raw).watch,
          watchId: entry.id,
          ontology,
          journal: entry.journal,
          analytics: { query: () => Promise.resolve({ rows: [], columns: [] }) },
          judge: { judge: () => ({ fired: false, output: {} }) },
          recall: { score: () => 0 },
          store,
        }).run();
      }
      // No specs: these count the population, which is what this describes.
      // Which of it is still *holding* something is `holding.test.ts`.
      return store.liveState([], DAY_1);
    } finally {
      store.close();
    }
  }

  it("counts keys and cells apart, and keeps one watch out of another's row", async () => {
    // `spawner` takes two arms on one thread and one on another: two keys,
    // three cells. `joiner` sees one thread only.
    const held = await liveStateAfter([
      {
        id: "spawner",
        raw: SPAWN_WATCH,
        journal: [
          email("alder", DAY_1),
          email("alder", DAY_1 + 3_600_000),
          email("birch", DAY_1 + 7_200_000),
        ],
      },
      { id: "joiner", raw: JOIN_WATCH, journal: [email("cedar", DAY_1)] },
    ]);

    // Keys is what a list reports, and it is not the cell count: a node holding
    // two instances of one key is still tracking one thing.
    expect(held.get("spawner")).toMatchObject({ keys: 2, cells: 3 });
    expect(held.get("joiner")?.keys).toBe(1);
  });

  it("reports the soonest deadline, which is what says it will act unprompted", async () => {
    const held = await liveStateAfter([
      {
        id: "spawner",
        raw: SPAWN_WATCH,
        journal: [email("alder", DAY_1), email("birch", DAY_1 + 2 * DAY_MS)],
      },
    ]);

    const state = held.get("spawner")!;
    expect(state.timers).toBe(2);
    // The wait is six days, so the earlier arm's deadline is the earlier one.
    // `MIN` rather than any-of-them: a list saying "next in 8 days" about a
    // watch that fires in 6 is worse than saying nothing.
    expect(state.nextDueAtMs).toBe(DAY_1 + 6 * DAY_MS);
  });

  it("leaves out a watch it is holding nothing for, which reads as zero", async () => {
    const held = await liveStateAfter([
      { id: "spawner", raw: SPAWN_WATCH, journal: [email("alder", DAY_1, true)] },
    ]);

    // The cursor still moved, so the watch is present and holding nothing —
    // which is the state that must not read the same as "behind".
    expect(held.get("spawner")?.keys ?? 0).toBe(0);
    expect(held.get("never-installed")).toBeUndefined();
  });
});
