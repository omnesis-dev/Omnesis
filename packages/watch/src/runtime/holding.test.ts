// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Telling a cell that is holding something from one that is only remembering.
 *
 * Every fixture here is a **husk or a half-arrival** — the two shapes a count of
 * cells cannot tell apart and the reason it was wrong. A cooldown that fired
 * months ago still keeps its stamp; a persistence window drains without anything
 * touching it; a join two arms of three toward firing is `accumulating` exactly
 * like the husks are. So the engine is driven for real and the read is taken at
 * a stated instant, because the difference between a husk and a live cell is
 * frequently nothing but the clock the reader holds.
 */

import { describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { WatchEngine } from "./engine.js";
import { HOLDING_SQL, holdingSpecs, specRow } from "./holding.js";
import { WatchStateStore, type NodeCell, type WatchLiveState } from "./state.js";
import type { JournalEvent } from "../journal/event.js";

const ontology = loadOntology();
const SELF = "0a1b2c3d-0000-4000-8000-000000000001";
const CONTACT = "b3f2a9d4-0000-4000-8000-000000000002";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const DAY_1 = Date.parse("2026-04-06T09:00:00Z");

/** An inbound source node, keyed downstream by its thread. */
function inbound(id: string): Record<string, unknown> {
  return {
    id,
    type: "source.document_event",
    filter: {
      source: "gmail",
      event: ["created"],
      documentType: "email",
      people: [{ role: "sender", isSelf: false }],
    },
    output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
  };
}

/** Fires once a thread has had three messages in a day, then goes quiet for two. */
const KEPT_UP_WATCH = {
  watch: {
    name: "kept-up-then-quiet",
    firing_policy: "stays_active",
    nodes: [
      inbound("arrival"),
      {
        id: "persist",
        type: "stateful.persistence",
        inputs: { arrival: { role: "arm", key: { thread_id: ".thread_id" } } },
        duration: "1 day",
        min_events: 3,
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

/** Two arms on one thread, and a wait that opens when either arrives. */
const JOIN_AND_WAIT_WATCH = {
  watch: {
    name: "both-arms-then-wait",
    firing_policy: "stays_active",
    nodes: [
      inbound("theirs"),
      {
        id: "hold",
        type: "stateful.wait",
        inputs: { theirs: { role: "arm", key: { thread_id: ".thread_id" } } },
        on_collision: "reset",
        duration: "3 days",
        output_map: { thread_id: "$n.theirs.thread_id" },
      },
      {
        id: "both",
        type: "stateful.and",
        inputs: {
          theirs: { role: "arm", key: { thread_id: ".thread_id" } },
          hold: { role: "arm", key: { thread_id: ".thread_id" } },
        },
        deadline: "6 days",
        on_collision: "reset",
        output_map: { thread_id: "$n.theirs.thread_id" },
      },
    ],
    sink: { input: "both", output_map: { thread: "$n.both.thread_id" } },
  },
};

/** A predicate that has to keep holding for a day before it counts. */
const SQL_WATCH = {
  watch: {
    name: "true-for-a-day",
    firing_policy: "stays_active",
    nodes: [
      inbound("arrival"),
      {
        id: "check",
        type: "sql",
        inputs: { arrival: { role: "arm", key: { thread_id: ".thread_id" } } },
        query: "SELECT true AS fires",
        fire_on: "rising_edge",
        initial_level: "assume_false",
        persistence: "1 day",
        on_collision: "accumulate",
        output_map: {},
      },
    ],
    sink: { input: "check", output_map: {} },
  },
};

let nextSeq = 0;

/** One email, invented: a thread and an instant. */
function email(thread: string, atMs: number): JournalEvent {
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
        { personId: CONTACT, role: "sender", isSelf: false },
        { personId: SELF, role: "recipient", isSelf: true },
      ],
    },
  } as JournalEvent;
}

/**
 * Run a fixture to a standstill, then read what it holds at a stated instant.
 *
 * The instant is the point: a spent cooldown and a live one are the same row,
 * and only the clock the reader holds tells them apart.
 */
async function heldAt(
  raw: unknown,
  journal: JournalEvent[],
  nowMs: number,
  watchId = "under-test",
  fires = false,
): Promise<WatchLiveState | undefined> {
  const checked = validateWatch(raw, ontology);
  if (!checked.valid) {
    throw new Error(`fixture does not validate: ${checked.diagnostics.map((d) => d.code).join()}`);
  }
  const store = new WatchStateStore();
  try {
    await new WatchEngine({
      watch: watchDslSchema.parse(raw).watch,
      watchId,
      ontology,
      journal,
      analytics: { query: () => Promise.resolve({ rows: [{ fires }], columns: ["fires"] }) },
      judge: { judge: () => ({ fired: false, output: {} }) },
      recall: { score: () => 0 },
      store,
    }).run();
    return store.liveState(holdingSpecs(watchId, raw), nowMs).get(watchId);
  } finally {
    store.close();
  }
}

describe("a cell that holds something, against one that only remembers", () => {
  /** Three in a day fires the persistence node, which stamps the cooldown. */
  const FIRED = [
    email("alder", DAY_1),
    email("alder", DAY_1 + HOUR_MS),
    email("alder", DAY_1 + 2 * HOUR_MS),
  ];

  it("counts a persistence cell part-way to its floor", async () => {
    // Two arms of three, inside the window: the state the whole distinction
    // exists to protect. It is `accumulating` in the store exactly like a husk,
    // and a reader wants to see it more than anything else here.
    const held = await heldAt(KEPT_UP_WATCH, FIRED.slice(0, 2), DAY_1 + 3 * HOUR_MS);

    expect(held).toMatchObject({ keys: 1, holdingKeys: 1, cells: 1, holdingCells: 1 });
  });

  it("stops counting a persistence window that has drained", async () => {
    // Nothing arrived to prune the arrivals — the window emptied by the clock
    // alone, which is why reading the row without one reports it as held.
    const held = await heldAt(KEPT_UP_WATCH, FIRED.slice(0, 2), DAY_1 + 2 * DAY_MS);

    expect(held).toMatchObject({ keys: 1, holdingKeys: 0, cells: 1, holdingCells: 0 });
  });

  it("counts a cooldown while it is still suppressing", async () => {
    // The persistence node fired and the cooldown stamped the key: for two days
    // that stamp genuinely suppresses the next firing.
    const held = await heldAt(KEPT_UP_WATCH, FIRED, DAY_1 + DAY_MS);

    // The persistence cell reset its arrivals on firing, so the only thing held
    // is the cooldown — which is what makes this a one-cell answer, not two.
    expect(held).toMatchObject({ keys: 1, cells: 2, holdingKeys: 1, holdingCells: 1 });
  });

  it("stops counting a cooldown husk once its interval has elapsed", async () => {
    // The same rows, three days on. Nothing about the watch changed; the stamp
    // suppresses nothing now, and a mark reading "tracking 1 thing" is false.
    const held = await heldAt(KEPT_UP_WATCH, FIRED, DAY_1 + 3 * DAY_MS);

    expect(held).toMatchObject({ keys: 1, cells: 2, holdingKeys: 0, holdingCells: 0 });
  });

  it("stops counting a SQL cell at rest, and counts one mid-persistence", async () => {
    // The predicate held from the first arrival and has to hold for a day.
    const holding = await heldAt(SQL_WATCH, [email("birch", DAY_1)], DAY_1 + HOUR_MS, "sql", true);
    expect(holding).toMatchObject({ keys: 1, holdingKeys: 1 });

    // A day on it has fired, and the cell is the resting state itself: a level
    // kept so the rising edge is not re-taken, holding nothing.
    const rested = await heldAt(
      SQL_WATCH,
      [email("birch", DAY_1), email("birch", DAY_1 + 2 * DAY_MS)],
      DAY_1 + 2 * DAY_MS + HOUR_MS,
      "sql",
      true,
    );
    expect(rested).toMatchObject({ keys: 1, holdingKeys: 0 });
  });

  it("keeps one watch's population out of another's row", async () => {
    // Two watches, one store: a `GROUP BY` that leaks would pass every
    // single-watch fixture above.
    const store = new WatchStateStore();
    try {
      const specs = [];
      for (const [id, raw, journal] of [
        ["husk", KEPT_UP_WATCH, FIRED],
        ["live", KEPT_UP_WATCH, FIRED.slice(0, 2)],
      ] as const) {
        await new WatchEngine({
          watch: watchDslSchema.parse(raw).watch,
          watchId: id,
          ontology,
          journal: journal.map((event) => ({ ...event, seq: ++nextSeq })),
          analytics: { query: () => Promise.resolve({ rows: [], columns: [] }) },
          judge: { judge: () => ({ fired: false, output: {} }) },
          recall: { score: () => 0 },
          store,
        }).run();
        specs.push(...holdingSpecs(id, raw));
      }
      const held = store.liveState(specs, DAY_1 + 3 * HOUR_MS);

      expect(held.get("husk")?.holdingKeys).toBe(1);
      expect(held.get("live")?.holdingKeys).toBe(1);
      expect(held.get("husk")?.cells).toBe(2);
      expect(held.get("live")?.cells).toBe(1);
    } finally {
      store.close();
    }
  });

  it("counts a cell it cannot read a spec for, rather than hiding it", async () => {
    // A definition this build cannot walk, a node it no longer declares: the
    // count falls back to the population, which is what it always was. A
    // surface losing sight of a node type it has never heard of is the worse
    // fault of the two.
    const held = await heldAt(KEPT_UP_WATCH, FIRED, DAY_1 + 3 * DAY_MS);
    expect(held?.holdingKeys).toBe(0);

    const store = new WatchStateStore();
    try {
      await new WatchEngine({
        watch: watchDslSchema.parse(KEPT_UP_WATCH).watch,
        watchId: "unreadable",
        ontology,
        journal: FIRED.map((event) => ({ ...event, seq: ++nextSeq })),
        analytics: { query: () => Promise.resolve({ rows: [], columns: [] }) },
        judge: { judge: () => ({ fired: false, output: {} }) },
        recall: { score: () => 0 },
        store,
      }).run();

      expect(store.liveState([], DAY_1 + 3 * DAY_MS).get("unreadable")).toMatchObject({
        keys: 1,
        holdingKeys: 1,
      });
    } finally {
      store.close();
    }
  });
});

describe("the shapes a join and a wait leave behind", () => {
  it("counts a join with one arm of two, and a wait before its deadline", async () => {
    // Both are genuinely waiting: the join for its second arm, the wait for the
    // instant that is its fire. Neither has a duration of its own to be read
    // against, so both are decided from the cell alone.
    const held = await heldAt(JOIN_AND_WAIT_WATCH, [email("alder", DAY_1)], DAY_1 + HOUR_MS);

    expect(held).toMatchObject({ keys: 1, cells: 2, holdingKeys: 1, holdingCells: 2 });
  });

  it("stops counting a wait whose deadline has passed", async () => {
    // The cell is still there — a deadline is swept by an evaluation pass, so
    // between the instant and the pass it is a cell holding nothing.
    const held = await heldAt(JOIN_AND_WAIT_WATCH, [email("alder", DAY_1)], DAY_1 + 4 * DAY_MS);

    expect(held?.holdingCells).toBe(1);
  });
});

describe("the two shapes a cell keeps after it has fired", () => {
  /**
   * Written straight into the store rather than driven through the engine.
   *
   * Both shapes are what a cell looks like *after* an episode ends, and the
   * engine reaches them only through a judge or a poll this test would have to
   * stand up around them. The columns are the contract the reading rests on, so
   * they are stated here directly.
   */
  function cell(overrides: Partial<NodeCell>): NodeCell {
    return {
      watchId: "under-test",
      nodeId: "n",
      keyHash: "k",
      instance: 0,
      key: {},
      state: "accumulating",
      armedAtMs: DAY_1,
      heldSinceMs: null,
      deadlineAtMs: null,
      level: null,
      slots: {},
      payload: {},
      provenance: {},
      lastFiredAtMs: null,
      arrivals: [],
      ...overrides,
    };
  }

  function heldFor(kind: string, overrides: Partial<NodeCell>): WatchLiveState | undefined {
    const store = new WatchStateStore();
    try {
      store.putCell(cell(overrides));
      return store
        .liveState(
          [{ watchId: "under-test", nodeId: "n", kind: kind as never, ms: 0 }],
          DAY_1 + DAY_MS,
        )
        .get("under-test");
    } finally {
      store.close();
    }
  }

  it("stops counting an LLM cell that its own arm has already fired on", () => {
    // Under `on_collision: accumulate` an llm cell outlives the firing, exactly
    // as a cooldown stamp does. A later arm re-arms it, so the two instants
    // together say whether this episode is still open.
    expect(heldFor("unfired", { armedAtMs: DAY_1, lastFiredAtMs: DAY_1 })?.holdingCells).toBe(0);
    expect(
      heldFor("unfired", { armedAtMs: DAY_1 + HOUR_MS, lastFiredAtMs: DAY_1 })?.holdingCells,
    ).toBe(1);
  });

  it("keeps counting a SQL predicate that is satisfied and not yet re-polled", () => {
    // The moment it is closest to firing: the predicate has held longer than
    // the node's persistence and nothing has arrived to re-evaluate it.
    // Measuring the persistence window here would call that a husk.
    expect(
      heldFor("predicate", { heldSinceMs: DAY_1 - 3 * DAY_MS, level: true })?.holdingCells,
    ).toBe(1);
    // And once the episode has fired, the level it keeps is the resting state.
    expect(
      heldFor("predicate", { heldSinceMs: DAY_1 - 3 * DAY_MS, lastFiredAtMs: DAY_1, level: true })
        ?.holdingCells,
    ).toBe(0);
  });

  it("stops counting a join whose deadline has passed", () => {
    // An arm arrived and the instance is over. Its expiry is swept by an
    // evaluation pass, so between the two it is a cell holding nothing — and
    // reading it as held would disagree with the wait beside it.
    expect(
      heldFor("slots", {
        slots: { theirs: { seq: 1, payload: {} } },
        deadlineAtMs: DAY_1 + HOUR_MS,
      })?.holdingCells,
    ).toBe(0);
    expect(
      heldFor("slots", {
        slots: { theirs: { seq: 1, payload: {} } },
        deadlineAtMs: DAY_1 + 2 * DAY_MS,
      })?.holdingCells,
    ).toBe(1);
  });
});

describe("what each node type says about its own cells", () => {
  it("reads the duration off the node that declares one", () => {
    expect(holdingSpecs("w", KEPT_UP_WATCH)).toEqual([
      { watchId: "w", nodeId: "arrival", kind: "opaque", ms: 0 },
      { watchId: "w", nodeId: "persist", kind: "window", ms: DAY_MS },
      { watchId: "w", nodeId: "cool", kind: "suppressing", ms: 2 * DAY_MS },
    ]);
  });

  it("reads a SQL node from its own clock rather than from a duration", () => {
    // `predicate` needs no duration: a cell is holding while its predicate
    // holds and this episode of it has not fired, which the cell's own two
    // instants answer between them. So a node declaring `persistence` and one
    // that does not are read exactly the same way.
    expect(holdingSpecs("w", SQL_WATCH).at(-1)).toEqual({
      watchId: "w",
      nodeId: "check",
      kind: "predicate",
      ms: 0,
    });

    const instant = { watch: { nodes: [{ id: "check", type: "sql" }] } };
    expect(holdingSpecs("w", instant)).toEqual([
      { watchId: "w", nodeId: "check", kind: "predicate", ms: 0 },
    ]);
  });

  it("reads an LLM node, whose cell outlives the firing under accumulate", () => {
    expect(holdingSpecs("w", { watch: { nodes: [{ id: "judge", type: "llm" }] } })).toEqual([
      { watchId: "w", nodeId: "judge", kind: "unfired", ms: 0 },
    ]);
  });

  it("keeps one spec per node, so a duplicate id cannot double a population", () => {
    // The validator refuses a duplicate id at install, so this is a document
    // something stored without validating. The aggregate joins cells to specs,
    // so a second row for one node multiplies that node's cells into the counts
    // — wrong numbers with nothing raised, which is the worse failure.
    const duplicated = {
      watch: {
        nodes: [
          { id: "cool", type: "stateful.cooldown", min_interval: "2 days" },
          { id: "cool", type: "stateful.cooldown", min_interval: "9 days" },
        ],
      },
    };

    expect(holdingSpecs("w", duplicated)).toEqual([
      { watchId: "w", nodeId: "cool", kind: "suppressing", ms: 2 * DAY_MS },
    ]);
  });

  it("writes a kind it does not recognise as opaque, and an unreadable duration as zero", () => {
    // The row is what the query joins to, and a kind it does not recognise
    // would match no branch and be held for a reason nobody chose.
    expect(
      specRow({ watchId: "w", nodeId: "n", kind: "invented" as never, ms: Number.NaN }),
    ).toEqual(["w", "n", "opaque", 0]);
  });

  it("demotes a node whose declared duration it cannot read", () => {
    // Zero is a decision for the kinds that read a duration — it makes every
    // cell read as long expired — so a window this build cannot parse falls to
    // `opaque` and counts as holding, which is the conservative direction.
    const unreadable = {
      watch: {
        nodes: [{ id: "persist", type: "stateful.persistence", duration: "P1D", min_events: 3 }],
      },
    };

    expect(holdingSpecs("w", unreadable)).toEqual([
      { watchId: "w", nodeId: "persist", kind: "opaque", ms: 0 },
    ]);
  });

  it("demotes a node that declares no duration where its kind needs one", () => {
    const missing = { watch: { nodes: [{ id: "cool", type: "stateful.cooldown" }] } };

    expect(holdingSpecs("w", missing)).toEqual([
      { watchId: "w", nodeId: "cool", kind: "opaque", ms: 0 },
    ]);
  });

  it("decides every kind it is willing to write", () => {
    // Three hand-kept lists: the union, the array `specRow` closes over, and
    // the `CASE`. A kind missing from the last one falls through to `ELSE 1`
    // and is held forever, which looks exactly like a node type nobody has
    // taught it about. The type system closes the first two; this closes this.
    for (const spec of Object.values({
      cooldown: holdingSpecs("w", {
        watch: { nodes: [{ id: "n", type: "stateful.cooldown", min_interval: "1 day" }] },
      }),
      persistence: holdingSpecs("w", {
        watch: {
          nodes: [{ id: "n", type: "stateful.persistence", duration: "1 day", min_events: 2 }],
        },
      }),
      join: holdingSpecs("w", { watch: { nodes: [{ id: "n", type: "stateful.and" }] } }),
      wait: holdingSpecs("w", { watch: { nodes: [{ id: "n", type: "stateful.wait" }] } }),
      sql: holdingSpecs("w", { watch: { nodes: [{ id: "n", type: "sql" }] } }),
      llm: holdingSpecs("w", { watch: { nodes: [{ id: "n", type: "llm" }] } }),
    }).flat()) {
      expect(HOLDING_SQL, `no branch decides ${spec.kind}`).toContain(`WHEN '${spec.kind}'`);
    }
  });

  it("yields nothing for a document it cannot walk", () => {
    expect(holdingSpecs("w", null)).toEqual([]);
    expect(holdingSpecs("w", { watch: {} })).toEqual([]);
    expect(holdingSpecs("w", { watch: { nodes: [{ type: "sql" }, 7] } })).toEqual([]);
  });
});
