// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Dressing a runtime snapshot for a reader.
 *
 * The two joins are what this covers: a key component that turns out to be a
 * person gets a name beside the id it keeps, and a parked nomination gets the
 * class the judge refused it with — which lives on the trace rather than on the
 * nomination row, and is therefore correlated rather than read.
 *
 * The fixture is multi-key on purpose. With one key live, resolving the wrong
 * component or attributing the wrong class produces output that is still
 * internally consistent; with two, the mistake lands on the wrong row.
 */

import { describe, expect, it } from "vitest";

import { keyComponentCandidates, stateResponse, arrivalCandidates } from "./state-response.js";
import type { WatchStateSnapshot } from "@omnesis/watch";
import type { TraceRow } from "./traces.js";

const MAYA = "a1111111-0000-4000-8000-000000000001";
const JAMIE = "a1111111-0000-4000-8000-000000000002";
const AT = Date.parse("2026-04-06T09:00:00Z");
const DAY_MS = 86_400_000;

const NAMES = new Map([
  [MAYA, "Maya Reeves"],
  [JAMIE, "Jamie Lopez"],
]);

/** Two people-keyed cells and one thread-keyed accumulator, on one watch. */
const SNAPSHOT: WatchStateSnapshot = {
  asOfSeq: 412,
  nodes: [
    {
      nodeId: "quiet",
      type: "stateful.wait",
      onCollision: "spawn",
      maxLiveInstances: 2,
      cancelledBy: ["reply"],
      cells: [
        {
          keyHash: "h-maya",
          instance: 0,
          key: { person: MAYA, day: "2026-04-06" },
          state: "live",
          armedAtMs: AT,
          deadlineAtMs: AT + 2 * DAY_MS,
          lastFiredAtMs: null,
          detail: { kind: "wait", firesAtMs: AT + 2 * DAY_MS },
        },
        {
          keyHash: "h-jamie",
          instance: 0,
          key: { person: JAMIE, day: "2026-04-06" },
          state: "live",
          armedAtMs: AT + 3_600_000,
          deadlineAtMs: AT + 3_600_000 + 2 * DAY_MS,
          lastFiredAtMs: null,
          detail: { kind: "wait", firesAtMs: AT + 3_600_000 + 2 * DAY_MS },
        },
      ],
    },
    {
      nodeId: "kept_up",
      type: "stateful.persistence",
      onCollision: null,
      maxLiveInstances: null,
      cancelledBy: [],
      cells: [
        {
          keyHash: "h-thread",
          instance: 0,
          key: { thread_id: "T-4417" },
          state: "accumulating",
          armedAtMs: AT,
          deadlineAtMs: null,
          lastFiredAtMs: null,
          detail: {
            kind: "persistence",
            count: 2,
            required: 3,
            window: "7 days",
            windowMs: 7 * DAY_MS,
            oldestArrivalAtMs: AT,
          },
        },
      ],
    },
  ],
  timers: [
    {
      nodeId: "quiet",
      keyHash: "h-maya",
      instance: 0,
      key: { person: MAYA, day: "2026-04-06" },
      kind: "wait",
      dueAtMs: AT + 2 * DAY_MS,
    },
    {
      nodeId: "quiet",
      keyHash: "h-jamie",
      instance: 0,
      key: { person: JAMIE, day: "2026-04-06" },
      kind: "wait",
      dueAtMs: AT + 3_600_000 + 2 * DAY_MS,
    },
  ],
  parked: [
    { nodeId: "sift", docId: "doc-1", seq: 400, atMs: AT },
    { nodeId: "sift", docId: "doc-2", seq: 401, atMs: AT + 60_000 },
  ],
};

function trace(seq: number, nodeId: string, failure: string | null): TraceRow {
  return {
    watchId: "w-1",
    seq,
    nodeId,
    key: "singleton",
    transition: "held",
    detail: null,
    failure,
    at: new Date(AT).toISOString(),
  };
}

function render(overrides: Partial<Parameters<typeof stateResponse>[0]> = {}) {
  return stateResponse({
    watch: { id: "w-1", name: "quiet-week" },
    snapshot: SNAPSHOT,
    journalHead: 420,
    // Between the two deadlines, so one timer is overdue and the other is not.
    atMs: AT + 2 * DAY_MS + 1_000,
    names: NAMES,
    // Empty by default: only a join or a sequence has arrived arms, and the
    // fixtures above have neither. The suite below supplies its own.
    arrivals: { instants: new Map(), documents: new Map() },
    traces: [trace(400, "sift", "budget"), trace(401, "other", "provider")],
    judge: { dailyCap: 200, perWatchDailyCap: 50, spentToday: 12, watchSpentToday: 4 },
    ...overrides,
  });
}

describe("key components, raw and resolved", () => {
  it("names the components the directory knows and leaves the rest alone", () => {
    const quiet = render().nodes.find((node) => node.id === "quiet")!;
    const maya = quiet.instances.find((instance) => instance.keyHash === "h-maya")!;

    expect(maya.components).toEqual([
      { name: "person", raw: MAYA, display: "Maya Reeves" },
      // A day stamp is not a person and must not acquire a name — the
      // directory is asked about every component precisely because nothing on
      // the key says which is which.
      { name: "day", raw: "2026-04-06", display: null },
    ]);
    // The raw key survives beside the reading, so nothing is lost.
    expect(maya.key).toEqual({ person: MAYA, day: "2026-04-06" });
  });

  it("puts each name on its own key", () => {
    const quiet = render().nodes.find((node) => node.id === "quiet")!;
    expect(quiet.instances.map((instance) => instance.components[0]?.display)).toEqual([
      "Maya Reeves",
      "Jamie Lopez",
    ]);
  });

  it("labels a key the way the runtime's own trace does", () => {
    const kept = render().nodes.find((node) => node.id === "kept_up")!;
    expect(kept.instances[0]?.keyLabel).toBe("thread_id=T-4417");
  });

  it("offers only string components for lookup, deduped", () => {
    const candidates = keyComponentCandidates(SNAPSHOT);
    expect(candidates.sort()).toEqual([MAYA, JAMIE, "2026-04-06", "T-4417"].sort());
  });

  it("offers nothing for a snapshot with nothing keyed", () => {
    expect(keyComponentCandidates({ asOfSeq: 0, nodes: [], timers: [], parked: [] })).toEqual([]);
  });
});

describe("instants on the wire", () => {
  it("states the moment and the two sequence numbers it sits between", () => {
    const response = render();
    expect(response.asOf).toEqual({
      at: new Date(AT + 2 * DAY_MS + 1_000).toISOString(),
      seq: 412,
      journalHead: 420,
    });
  });

  it("renders a cell's own instants as ISO, keeping nulls null", () => {
    const kept = render().nodes.find((node) => node.id === "kept_up")!.instances[0]!;
    expect(kept.armedAt).toBe(new Date(AT).toISOString());
    expect(kept.deadlineAt).toBeNull();
    expect(kept.lastFiredAt).toBeNull();
  });

  it("drops the `Ms` suffix from a detail's instants and keeps its spans", () => {
    const response = render();
    const maya = response.nodes[0]!.instances[0]!;
    expect(maya.detail).toEqual({
      kind: "wait",
      firesAt: new Date(AT + 2 * DAY_MS).toISOString(),
    });
    // `windowMs` is a length of time, not an instant, and has no ISO form.
    expect(response.nodes[1]!.instances[0]!.detail).toEqual({
      kind: "persistence",
      count: 2,
      required: 3,
      window: "7 days",
      windowMs: 7 * DAY_MS,
      oldestArrivalAt: new Date(AT).toISOString(),
    });
  });
});

describe("timers and the queue behind them", () => {
  it("flags a timer already due against the same clock as the header", () => {
    const timers = render().timers;
    expect(timers.map((timer) => timer.overdue)).toEqual([true, false]);
    // Due is not fired: a timer is swept by an evaluation pass, so one that
    // came due between passes is still here.
    expect(timers[0]?.dueAt).toBe(new Date(AT + 2 * DAY_MS).toISOString());
  });

  it("resolves a timer's own key, so the list needs no second lookup", () => {
    expect(render().timers[1]?.components).toEqual([
      { name: "person", raw: JAMIE, display: "Jamie Lopez" },
      { name: "day", raw: "2026-04-06", display: null },
    ]);
  });

  it("gives a parked nomination the class its own trace row carries", () => {
    const parked = render().parked;
    expect(parked[0]).toMatchObject({ nodeId: "sift", docId: "doc-1", failure: "budget" });
    // The second nomination's sequence appears in the trace against a
    // different node, and must not be attributed to this one.
    expect(parked[1]).toMatchObject({ docId: "doc-2", failure: null });
  });

  it("reports no class rather than a guessed one once the trace has rolled off", () => {
    expect(render({ traces: [] }).parked.map((nomination) => nomination.failure)).toEqual([
      null,
      null,
    ]);
  });

  it("carries the day's judge allowance and this watch's share of it", () => {
    expect(render().judge).toEqual({
      dailyCap: 200,
      perWatchDailyCap: 50,
      spentToday: 12,
      watchSpentToday: 4,
    });
  });
});

describe("a watch holding nothing", () => {
  it("reports every node with a zero population rather than an empty response", () => {
    const empty = render({
      snapshot: {
        asOfSeq: 9,
        nodes: [
          {
            nodeId: "quiet",
            type: "stateful.wait",
            onCollision: "reset",
            maxLiveInstances: null,
            cancelledBy: [],
            cells: [],
          },
        ],
        timers: [],
        parked: [],
      },
    });
    expect(empty.nodes).toEqual([
      {
        id: "quiet",
        type: "stateful.wait",
        cells: 0,
        onCollision: "reset",
        maxLiveInstances: null,
        cancelledBy: [],
        instances: [],
      },
    ]);
    expect(empty.timers).toEqual([]);
    expect(empty.parked).toEqual([]);
  });
});

/**
 * A half-satisfied sequence, which is the cell that raises a question the
 * counts cannot answer: "step 1 of 2, waiting for shipped" says when nothing
 * and what nothing, while the cell has known both all along.
 */
describe("what an arrived arm arrived on", () => {
  const SEQUENCE: WatchStateSnapshot = {
    asOfSeq: 412,
    nodes: [
      {
        nodeId: "in_order",
        type: "stateful.sequence",
        onCollision: "ignore",
        maxLiveInstances: null,
        cancelledBy: [],
        cells: [
          {
            keyHash: "h-order",
            instance: 0,
            key: { order_id: "SO-8841" },
            state: "live",
            armedAtMs: AT,
            deadlineAtMs: AT + 7 * DAY_MS,
            lastFiredAtMs: null,
            detail: {
              kind: "sequence",
              step: 1,
              of: 2,
              nextExpected: "shipped",
              arrived: [{ from: "confirmed", seq: 4210, documentId: "doc-confirm" }],
            },
          },
        ],
      },
    ],
    timers: [],
    parked: [],
  };

  const resolved = {
    instants: new Map([[4210, new Date(AT).toISOString()]]),
    documents: new Map([
      [
        "doc-confirm",
        {
          id: "doc-confirm",
          title: "Order SO-8841 confirmed",
          sourceId: "gmail:orders@example.com",
        },
      ],
    ]),
  };

  function arm(input: Partial<Parameters<typeof stateResponse>[0]> = {}) {
    const response = render({ snapshot: SEQUENCE, arrivals: resolved, ...input });
    const detail = response.nodes[0]!.instances[0]!.detail as {
      arrived: { from: string; seq: number; at?: string; document?: { title: string } }[];
    };
    return detail.arrived[0]!;
  }

  it("says when the step happened and what satisfied it", () => {
    expect(arm()).toEqual({
      from: "confirmed",
      seq: 4210,
      at: new Date(AT).toISOString(),
      document: {
        id: "doc-confirm",
        title: "Order SO-8841 confirmed",
        sourceId: "gmail:orders@example.com",
      },
    });
  });

  it("keeps an arm whose journal event has been pruned, without dating it", () => {
    // The trace and the journal are bounded separately from the cells, which
    // outlive both. An arm that loses its event is still the arm that armed
    // this cell — dropping it would report a satisfied step as unsatisfied.
    const pruned = arm({ arrivals: { instants: new Map(), documents: resolved.documents } });
    expect(pruned).not.toHaveProperty("at");
    expect(pruned.seq).toBe(4210);
    expect(pruned.document?.title).toBe("Order SO-8841 confirmed");
  });

  it("keeps an arm whose document the corpus no longer holds", () => {
    const gone = arm({ arrivals: { instants: resolved.instants, documents: new Map() } });
    expect(gone).not.toHaveProperty("document");
    expect(gone.at).toBe(new Date(AT).toISOString());
  });

  it("asks about exactly the events and documents its arms name", () => {
    expect(arrivalCandidates(SEQUENCE)).toEqual({ seqs: [4210], documentIds: ["doc-confirm"] });
    // A snapshot with no join or sequence asks for nothing, so the reads that
    // answer this never run for the watches that cannot use them.
    expect(arrivalCandidates(SNAPSHOT)).toEqual({ seqs: [], documentIds: [] });
  });
});
