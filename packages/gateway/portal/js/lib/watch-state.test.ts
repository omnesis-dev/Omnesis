// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// Reading a state snapshot for the canvas. The payload here is the shape the
// route serves, and the fixture is deliberately multi-key and multi-cell: with
// one key live, the key lens and a lens that dimmed nothing produce the same
// canvas, and grouping by shape is indistinguishable from not grouping at all.

import { describe, expect, test } from "vitest";

// @ts-expect-error — portal is plain JS, no .d.ts ships alongside.
const {
  cellsForKey,
  filterWatchStateKeys,
  keyDisplayLabel,
  litNodeIds,
  readWatchStateSnapshot,
  spanProgress,
  watchStateKeyGroups,
} = await import("./watch-state.js");

const MAYA = "a1111111-0000-4000-8000-000000000001";
const JAMIE = "a1111111-0000-4000-8000-000000000002";
const AT = Date.parse("2026-04-06T09:00:00Z");
const DAY_MS = 86_400_000;

function iso(offsetMs: number): string {
  return new Date(AT + offsetMs).toISOString();
}

function person(id: string, name: string) {
  return { name: "person", raw: id, display: name };
}

/**
 * One watch holding three cells over three keys of two different shapes, with
 * two instances of one of them.
 */
const PAYLOAD = {
  watch: { id: "w-1", name: "quiet-week" },
  asOf: { at: iso(0), seq: 412, journalHead: 420 },
  nodes: [
    {
      id: "arrival",
      type: "source.document_event",
      cells: 0,
      onCollision: null,
      maxLiveInstances: null,
      cancelledBy: [],
      instances: [],
    },
    {
      id: "quiet",
      type: "stateful.wait",
      cells: 3,
      onCollision: "spawn",
      maxLiveInstances: 2,
      cancelledBy: ["reply"],
      instances: [
        {
          keyHash: "h-maya",
          instance: 0,
          key: { person: MAYA },
          keyLabel: `person=${MAYA}`,
          components: [person(MAYA, "Maya Reeves")],
          state: "live",
          armedAt: iso(0),
          deadlineAt: iso(2 * DAY_MS),
          lastFiredAt: null,
          detail: { kind: "wait", firesAt: iso(2 * DAY_MS) },
        },
        {
          keyHash: "h-maya",
          instance: 1,
          key: { person: MAYA },
          keyLabel: `person=${MAYA}`,
          components: [person(MAYA, "Maya Reeves")],
          state: "live",
          armedAt: iso(3_600_000),
          deadlineAt: iso(3_600_000 + 2 * DAY_MS),
          lastFiredAt: null,
          detail: { kind: "wait", firesAt: iso(3_600_000 + 2 * DAY_MS) },
        },
        {
          keyHash: "h-jamie",
          instance: 0,
          key: { person: JAMIE },
          keyLabel: `person=${JAMIE}`,
          components: [person(JAMIE, "Jamie Lopez")],
          state: "live",
          armedAt: iso(0),
          deadlineAt: iso(3 * DAY_MS),
          lastFiredAt: null,
          detail: { kind: "wait", firesAt: iso(3 * DAY_MS) },
        },
      ],
    },
    {
      id: "kept_up",
      type: "stateful.persistence",
      cells: 1,
      onCollision: null,
      maxLiveInstances: null,
      cancelledBy: [],
      instances: [
        {
          keyHash: "h-order",
          instance: 0,
          key: { order_id: "SO-8841" },
          keyLabel: "order_id=SO-8841",
          components: [{ name: "order_id", raw: "SO-8841", display: null }],
          state: "accumulating",
          armedAt: iso(0),
          deadlineAt: null,
          lastFiredAt: null,
          detail: { kind: "persistence", count: 2, required: 3, window: "7 days" },
        },
      ],
    },
  ],
  timers: [
    {
      nodeId: "quiet",
      keyHash: "h-maya",
      instance: 0,
      key: { person: MAYA },
      keyLabel: `person=${MAYA}`,
      components: [person(MAYA, "Maya Reeves")],
      kind: "wait",
      dueAt: iso(2 * DAY_MS),
      overdue: false,
    },
  ],
  parked: [{ nodeId: "sift", docId: "doc-1", seq: 400, at: iso(0), failure: "budget" }],
  judge: { dailyCap: 200, perWatchDailyCap: 50, spentToday: 7, watchSpentToday: 2 },
};

/** The definition reading the canvas already has, as lens 1 produces it. */
const DAG = {
  nodes: [
    { id: "arrival", keyed: false },
    { id: "quiet", keyed: true },
    { id: "kept_up", keyed: true },
    { id: "$sink", keyed: false },
  ],
};

const snapshot = readWatchStateSnapshot(PAYLOAD);

describe("reading the snapshot", () => {
  test("counts each node's population, zero included", () => {
    expect(snapshot.nodes.map((node: any) => [node.id, node.count])).toEqual([
      ["arrival", 0],
      ["quiet", 3],
      ["kept_up", 1],
    ]);
  });

  test("says whether the runtime is holding anything at all", () => {
    expect(snapshot.empty).toBe(false);
    const nothing = readWatchStateSnapshot({
      ...PAYLOAD,
      nodes: PAYLOAD.nodes.map((node) => ({ ...node, cells: 0, instances: [] })),
      timers: [],
      parked: [],
    });
    // A watch that holds nothing is a real state, not a failed read — the page
    // says so rather than rendering an empty canvas with no explanation.
    expect(nothing.empty).toBe(true);
    expect(nothing.nodes).toHaveLength(3);
  });

  test("reads a payload with no snapshot in it as no snapshot", () => {
    expect(readWatchStateSnapshot(null)).toBeNull();
    expect(readWatchStateSnapshot({ asOf: {} })).toBeNull();
  });

  test("survives a field of the wrong type rather than throwing", () => {
    const bent = readWatchStateSnapshot({
      nodes: [{ id: "quiet", cells: "three", instances: null, cancelledBy: 7 }],
      timers: "soon",
      parked: null,
    });
    expect(bent.nodes[0]).toMatchObject({ id: "quiet", count: 0, cancelledBy: [] });
    expect(bent.timers).toEqual([]);
  });
});

describe("the key selector", () => {
  const groups = watchStateKeyGroups(snapshot);

  test("groups keys by shape, not into one flat list", () => {
    expect(groups.map((group: any) => group.shape)).toEqual(["(order_id)", "(person)"]);
    expect(groups.find((group: any) => group.shape === "(person)").keys).toHaveLength(2);
  });

  test("collapses a key's instances onto one entry, and counts them", () => {
    const maya = groups
      .find((group: any) => group.shape === "(person)")
      .keys.find((key: any) => key.keyHash === "h-maya");
    // Two cells, one key: a selector that listed instances would offer the
    // same key twice and make the lens look like two different slices.
    expect(maya.cells).toBe(2);
    expect(maya.nodeIds).toEqual(["quiet"]);
  });

  test("renders a key by its resolved names, keeping the raw ids to hand", () => {
    const maya = groups
      .find((group: any) => group.shape === "(person)")
      .keys.find((key: any) => key.keyHash === "h-maya");
    expect(keyDisplayLabel(maya)).toBe("person=Maya Reeves");
    expect(maya.components[0].raw).toBe(MAYA);
  });

  test("searches the display name and the raw id alike", () => {
    // The operator arrives with whichever they have: a name off the People
    // page, or an id copied out of a trace.
    expect(
      filterWatchStateKeys(groups, "jamie").flatMap((group: any) =>
        group.keys.map((key: any) => key.keyHash),
      ),
    ).toEqual(["h-jamie"]);
    expect(
      filterWatchStateKeys(groups, MAYA).flatMap((group: any) =>
        group.keys.map((key: any) => key.keyHash),
      ),
    ).toEqual(["h-maya"]);
    // A group with nothing left in it is dropped rather than shown empty.
    expect(filterWatchStateKeys(groups, "nothing-like-this")).toEqual([]);
    expect(filterWatchStateKeys(groups, "  ")).toEqual(groups);
  });
});

describe("the key lens", () => {
  test("lights the nodes holding the key and dims the keyed ones that are not", () => {
    const lit = litNodeIds(snapshot, DAG, "h-maya");
    expect([...lit].sort()).toEqual(["$sink", "arrival", "quiet"]);
    // `kept_up` is keyed and holds no cell for this key, so it dims. The
    // source and the sink are unkeyed and are never outside a key's slice.
    expect(lit.has("kept_up")).toBe(false);
  });

  test("lights a different set for a different key", () => {
    const lit = litNodeIds(snapshot, DAG, "h-order");
    expect(lit.has("kept_up")).toBe(true);
    expect(lit.has("quiet")).toBe(false);
  });

  test("hands back that key's cells, instances and all", () => {
    expect(cellsForKey(snapshot, "quiet", "h-maya").map((cell: any) => cell.instance)).toEqual([
      0, 1,
    ]);
    expect(cellsForKey(snapshot, "quiet", "h-order")).toEqual([]);
    expect(cellsForKey(snapshot, "not-a-node", "h-maya")).toEqual([]);
  });
});

describe("the upcoming list", () => {
  test("keeps the order the route sent, soonest first", () => {
    const many = readWatchStateSnapshot({
      ...PAYLOAD,
      timers: [
        { ...PAYLOAD.timers[0], keyHash: "h-a", dueAt: iso(DAY_MS) },
        { ...PAYLOAD.timers[0], keyHash: "h-b", dueAt: iso(2 * DAY_MS) },
        { ...PAYLOAD.timers[0], keyHash: "h-c", dueAt: iso(3 * DAY_MS) },
      ],
    });
    expect(many.timers.map((timer: any) => timer.dueAt)).toEqual([
      iso(DAY_MS),
      iso(2 * DAY_MS),
      iso(3 * DAY_MS),
    ]);
  });

  test("carries the class a parked nomination was refused with", () => {
    expect(snapshot.parked[0]).toMatchObject({ nodeId: "sift", failure: "budget" });
    const rolledOff = readWatchStateSnapshot({
      ...PAYLOAD,
      parked: [{ nodeId: "sift", docId: "doc-1", seq: 400, at: iso(0) }],
    });
    // The trace the class lives on is bounded and rolls off while the
    // nomination stays; null says so rather than guessing a class.
    expect(rolledOff.parked[0].failure).toBeNull();
  });
});

describe("the countdown bar", () => {
  test("places now between the two ends", () => {
    expect(spanProgress(iso(0), iso(4 * DAY_MS), AT + DAY_MS)).toBeCloseTo(0.25);
  });

  test("clamps rather than running past its own end", () => {
    // A deadline the evaluation tick has not swept yet is genuinely past; a bar
    // drawn beyond its track would read as a rendering fault instead.
    expect(spanProgress(iso(0), iso(DAY_MS), AT + 5 * DAY_MS)).toBe(1);
    expect(spanProgress(iso(0), iso(DAY_MS), AT - DAY_MS)).toBe(0);
  });

  test("draws nothing when there is nothing to measure", () => {
    expect(spanProgress(null, iso(DAY_MS), AT)).toBeNull();
    expect(spanProgress(iso(0), null, AT)).toBeNull();
    expect(spanProgress(iso(DAY_MS), iso(DAY_MS), AT)).toBeNull();
  });
});
