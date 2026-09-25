// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `broadcast` is a routing flag, not a meaning.
 *
 * A keyless edge into a keyed node has no key to route on, so it is declared
 * `broadcast: true` and reaches every live instance instead of one. What it
 * *does* on arrival is still its role. Deciding the routing first and never
 * reading the role turns a declared cancel into a no-op — and on nodes that
 * re-run when poked, into a firing caused by an edge whose stated purpose was
 * to stop one.
 */

import { describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { WatchEngine } from "./engine.js";
import { ScriptedJudge, ScriptedRecall } from "./providers.js";
import type { JournalEvent } from "../journal/event.js";
import type { JudgeProvider } from "./providers.js";
import type { WatchTrace } from "./trace.js";

const ontology = loadOntology();
const SENDER = "b3f2a9d4-0000-4000-8000-000000000002";
const SELF = "0a1b2c3d-0000-4000-8000-000000000001";

/**
 * Narrowed to the document-event member rather than the union: callers build
 * variants by spreading the payload, and a spread of the union loses the tie
 * between `kind` and the payload's shape.
 */
type DocEvent = Extract<JournalEvent, { kind: "doc.event" }>;

function email(seq: number, thread: string, day: number): DocEvent {
  const at = new Date(Date.UTC(2026, 2, day, 9)).toISOString();
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
        { personId: SENDER, role: "sender", isSelf: false },
        { personId: SELF, role: "recipient", isSelf: true },
      ],
    },
  };
}

/** A keyed wait that a daily tick is wired into as a broadcast cancel. */
const BROADCAST_CANCEL = {
  watch: {
    name: "broadcast-cancel-ends-every-instance",
    firing_policy: "stays_active",
    ontology_fingerprint: "poc-ontology-1",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
      },
      { id: "tick", type: "source.time", recurring: "0 12 * * *" },
      {
        id: "waiting",
        type: "stateful.wait",
        inputs: {
          mail: { role: "arm", key: { thread_id: ".thread_id" } },
          tick: { role: "cancel", broadcast: true },
        },
        on_collision: "reset",
        duration: "10 days",
        output_map: { doc_id: "$n.mail.doc_id" },
      },
    ],
    sink: { input: "waiting", output_map: { doc: "$n.waiting.doc_id" } },
  },
};

async function run(
  raw: unknown,
  journal: JournalEvent[],
  judge: JudgeProvider = new ScriptedJudge({ judgements: [] }),
): Promise<WatchTrace> {
  const result = validateWatch(raw, ontology);
  expect(
    result.valid,
    `fixture must validate: ${result.diagnostics.map((d) => d.code).join(", ")}`,
  ).toBe(true);

  const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
  try {
    return await new WatchEngine({
      watch: watchDslSchema.parse(raw).watch,
      ontology,
      journal,
      analytics,
      judge,
      recall: new ScriptedRecall([]),
    }).run();
  } finally {
    analytics.close();
  }
}

describe("a broadcast edge declared as a cancel", () => {
  it("ends every live instance rather than being routed to re-evaluation", async () => {
    // One email arms a ten-day wait; the daily tick then cancels it long before
    // the deadline. A run that dropped the role would hold the instance through
    // every tick and fire on day eleven.
    const trace = await run(BROADCAST_CANCEL, [email(1, "T1", 1), email(2, "T9", 25)]);

    const cancelled = trace.records.filter(
      (r) => r.nodeId === "waiting" && r.transition === "cancelled",
    );
    expect(cancelled.length).toBeGreaterThan(0);
    expect(trace.firings).toEqual([]);
  });

  it("cancels each live key, so a trace still says which instances ended", async () => {
    // Two threads are waiting when the first tick arrives. Both end, and the
    // trace names each — a single collapsed record would lose which instance
    // died. The last event runs the clock past the tick that cancels them.
    const trace = await run(BROADCAST_CANCEL, [
      email(1, "T1", 1),
      email(2, "T2", 1),
      email(3, "T3", 25),
    ]);

    const keys = new Set(
      trace.records
        .filter((r) => r.nodeId === "waiting" && r.transition === "cancelled")
        .map((r) => r.key),
    );
    expect(keys.size).toBeGreaterThanOrEqual(2);
  });
});

/**
 * An accumulating SQL node whose predicate is true on every arm and never
 * lapses. A rising edge happens once — at the false→true transition — and the
 * cell that remembers the level has to outlive the firing for that to hold.
 */
const ACCUMULATING_EDGE = {
  watch: {
    name: "accumulate-remembers-its-level",
    firing_policy: "stays_active",
    ontology_fingerprint: "poc-ontology-1",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId" },
      },
      {
        id: "always_true",
        type: "sql",
        inputs: { mail: { role: "arm", key: { thread_id: ".thread_id" } } },
        query: "SELECT true AS fires",
        fire_on: "rising_edge",
        initial_level: "assume_false",
        on_collision: "accumulate",
        output_map: {},
      },
    ],
    sink: { input: "always_true", output_map: {} },
  },
};

describe("an accumulating node that fired", () => {
  it("keeps the level it observed, so a rising edge stays one edge", async () => {
    // Three arms on one key, predicate true throughout. Dropping the cell on
    // fire would erase the level and make every later arm look like a fresh
    // false→true, which is `every_true` wearing `rising_edge`'s name.
    const trace = await run(ACCUMULATING_EDGE, [
      email(1, "T1", 1),
      email(2, "T1", 2),
      email(3, "T1", 3),
    ]);

    const fired = trace.records.filter(
      (r) => r.nodeId === "always_true" && r.transition === "fired",
    );
    expect(fired).toHaveLength(1);
    expect(trace.firings).toHaveLength(1);
  });
});

/**
 * Two keyed waits feeding a node that declares no key of its own. Both threads
 * are armed on the same day and so come due on the same tick.
 */
const UNKEYED_HOP = {
  watch: {
    name: "unkeyed-hop-keeps-identity",
    firing_policy: "stays_active",
    ontology_fingerprint: "poc-ontology-1",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
      },
      {
        id: "ripens",
        type: "stateful.wait",
        inputs: { mail: { role: "arm", key: { thread_id: ".thread_id" } } },
        on_collision: "reset",
        duration: "1 days",
        output_map: { doc_id: "$n.mail.doc_id", thread_id: "$n.mail.thread_id" },
      },
      {
        id: "passthrough",
        type: "stateless.or",
        inputs: { ripens: { role: "arm" } },
        output_map: { doc_id: "$n.ripens.doc_id", thread_id: "$n.ripens.thread_id" },
      },
    ],
    sink: {
      input: "passthrough",
      output_map: { doc: "$n.passthrough.doc_id", thread: "$n.passthrough.thread_id" },
    },
  },
};

describe("two instances ripening independently", () => {
  it("both reach the sink, through a hop that declares no key", async () => {
    // Each deadline is its own timer and so carries its own sequence, which is
    // enough to keep the two firings distinct on its own. This covers the
    // ordinary path; the same-sequence case — two keys ripened by one broadcast
    // tick, where identity is the only thing separating them — is not
    // reproduced here and still needs a counterexample.
    const trace = await run(UNKEYED_HOP, [
      email(1, "T1", 1),
      email(2, "T2", 1),
      email(3, "T3", 20),
    ]);

    const threads = trace.firings.map((f) => f.payload.thread);
    expect(
      new Set(threads).size,
      `only ${threads.length} firing(s) survived`,
    ).toBeGreaterThanOrEqual(2);
    expect(threads).toContain("T1");
    expect(threads).toContain("T2");
  });
});

/**
 * A judge that spawns, bounded at one live instance per key, whose instances
 * never expire. The bound is the only thing standing between it and unbounded
 * parallel state.
 */
const SPAWN_NO_DEADLINE = {
  watch: {
    name: "spawn-ceiling-without-a-deadline",
    firing_policy: "stays_active",
    ontology_fingerprint: "poc-ontology-1",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
      },
      {
        id: "verdict",
        type: "llm",
        mode: "judge",
        inputs: { mail: { role: "arm", key: { thread_id: ".thread_id" } } },
        proposition: "This needs a reply",
        output_schema: { decision: "bool" },
        on_collision: "spawn",
        max_live_instances: 1,
        deadline: "infinite",
        output_map: { doc_id: "$n.mail.doc_id" },
      },
    ],
    sink: { input: "verdict", output_map: { doc: "$n.verdict.doc_id" } },
  },
};

describe("a spawning node whose instances never expire", () => {
  it("parks an unanswered explicit judge on a future timer instead of spinning", async () => {
    let calls = 0;
    const unavailable: JudgeProvider = {
      judge: () => {
        calls += 1;
        return {
          fired: false,
          output: {},
          unanswered: { failure: "provider", reason: "temporarily unavailable" },
        };
      },
    };

    const trace = await run(SPAWN_NO_DEADLINE, [email(1, "T1", 1)], unavailable);

    expect(calls).toBe(1);
    expect(trace.firings).toEqual([]);
  });

  it("still refuses an arm past its ceiling", async () => {
    // Every arm is judged not-fired, so each instance stays live. The second
    // and third arms must be refused: an instance with no deadline is still an
    // instance, and the ceiling is the operator's only bound on how many of
    // them one key can hold.
    const trace = await run(SPAWN_NO_DEADLINE, [
      email(1, "T1", 1),
      email(2, "T1", 2),
      email(3, "T1", 3),
    ]);

    const refused = trace.records.filter(
      (r) => r.nodeId === "verdict" && r.transition === "refused",
    );
    expect(refused.length).toBeGreaterThan(0);
    expect(trace.firings).toEqual([]);
  });
});

/**
 * An ordered gate whose `order` also names a keyless tick. The tick can never
 * occupy a slot — broadcast edges are routed to re-evaluation — so it must not
 * count towards the position the gate is waiting for.
 */
const SEQUENCE_WITH_BROADCAST = {
  watch: {
    name: "sequence-ignores-a-broadcast-in-its-order",
    firing_policy: "stays_active",
    ontology_fingerprint: "poc-ontology-1",
    nodes: [
      {
        id: "first",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
      },
      {
        id: "second",
        type: "source.document_event",
        filter: { source: "gmail", event: ["updated"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
      },
      { id: "daily", type: "source.time", recurring: "0 12 * * *" },
      {
        id: "in_order",
        type: "stateful.sequence",
        inputs: {
          first: { role: "arm", key: { thread_id: ".thread_id" } },
          second: { role: "arm", key: { thread_id: ".thread_id" } },
          daily: { role: "arm", broadcast: true },
        },
        order: ["first", "daily", "second"],
        on_collision: "ignore",
        deadline: "30 days",
        output_map: { doc_id: "$n.second.doc_id" },
      },
    ],
    sink: { input: "in_order", output_map: { doc: "$n.in_order.doc_id" } },
  },
};

describe("a sequence whose order names a broadcast input", () => {
  it("still completes, because that input never occupies a slot", async () => {
    // `first` then `second` on one thread is the whole sequence. Counting the
    // tick as an ordered element would leave the gate expecting it forever and
    // drop `second` as out of order, so the watch could never fire at all.
    const trace = await run(SEQUENCE_WITH_BROADCAST, [
      email(1, "T1", 1),
      { ...email(2, "T1", 3), payload: { ...email(2, "T1", 3).payload, op: "updated" } },
    ]);

    expect(trace.records.filter((r) => r.transition === "dropped")).toEqual([]);
    expect(trace.firings).toHaveLength(1);
  });
});

/** Two source filters that both match the very same document. */
function overlappingSequence(first: string, second: string) {
  const sources = {
    early: {
      id: "early",
      type: "source.document_event",
      filter: { source: "gmail", event: ["created"], documentType: "email" },
      output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
    },
    late: {
      id: "late",
      type: "source.document_event",
      filter: { source: "gmail", event: ["created"] },
      output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
    },
  } as const;

  return {
    watch: {
      name: "sequence-needs-one-thing-after-another",
      firing_policy: "stays_active",
      ontology_fingerprint: "poc-ontology-1",
      // Declaration order is the variable under test: it decides which source
      // fires first inside one event.
      nodes: [
        sources[first as "early" | "late"],
        sources[second as "early" | "late"],
        {
          id: "in_order",
          type: "stateful.sequence",
          inputs: {
            early: { role: "arm", key: { thread_id: ".thread_id" } },
            late: { role: "arm", key: { thread_id: ".thread_id" } },
          },
          order: ["early", "late"],
          on_collision: "ignore",
          deadline: "30 days",
          output_map: { a: "$n.early.doc_id", b: "$n.late.doc_id" },
        },
      ],
      sink: { input: "in_order", output_map: { a: "$n.in_order.a", b: "$n.in_order.b" } },
    },
  };
}

describe("a sequence given one document that matches both its elements", () => {
  it("does not fire, because nothing followed anything", async () => {
    const trace = await run(overlappingSequence("early", "late"), [email(1, "T1", 1)]);
    expect(trace.firings).toEqual([]);
  });

  it("answers the same way whichever source is declared first", async () => {
    // The gate asks whether one thing happened after another. That must not
    // become a question about the order the watch was written down in.
    const a = await run(overlappingSequence("early", "late"), [email(1, "T1", 1)]);
    const b = await run(overlappingSequence("late", "early"), [email(1, "T1", 1)]);
    expect(a.firings).toEqual(b.firings);
  });
});

/** A judge re-run by a daily tick, which is meant to give up after five days. */
const POLLED_JUDGE = {
  watch: {
    name: "polled-judge-expires",
    firing_policy: "stays_active",
    ontology_fingerprint: "poc-ontology-1",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
      },
      { id: "daily", type: "source.time", recurring: "0 12 * * *" },
      {
        id: "verdict",
        type: "llm",
        mode: "judge",
        inputs: {
          mail: { role: "arm", key: { thread_id: ".thread_id" } },
          daily: { role: "arm", broadcast: true },
        },
        proposition: "This has been resolved",
        output_schema: { decision: "bool" },
        on_collision: "reset",
        deadline: "5 days",
        output_map: { doc_id: "$n.mail.doc_id" },
      },
    ],
    sink: { input: "verdict", output_map: { doc: "$n.verdict.doc_id" } },
  },
};

describe("an instance re-evaluated by a broadcast tick", () => {
  it("expires on the deadline it was armed with", async () => {
    // Twenty-five days of ticks against a five-day deadline. Re-anchoring on
    // each tick would push the deadline out forever: no expiry, and a judge
    // call every day for as long as the watch ran.
    const trace = await run(POLLED_JUDGE, [email(1, "T1", 1), email(2, "T9", 25)]);

    const forThread = trace.records.filter((r) => r.nodeId === "verdict" && r.key.includes("T1"));
    expect(forThread.some((r) => r.transition === "expired")).toBe(true);
    expect(forThread.filter((r) => r.transition === "held").length).toBeLessThan(10);
  });
});

/** A stateful SQL node with a two-day deadline, polled every six hours. */
const BACKFILLED_SQL = {
  watch: {
    name: "backfilled-arm-gets-its-window",
    firing_policy: "stays_active",
    ontology_fingerprint: "poc-ontology-1",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId" },
      },
      {
        id: "gate",
        type: "sql",
        inputs: { mail: { role: "arm", key: { thread_id: ".thread_id" } } },
        query: "SELECT false AS fires",
        fire_on: "every_true",
        on_collision: "accumulate",
        deadline: "2 days",
        timer: "6 hours",
        output_map: {},
      },
    ],
    sink: { input: "gate", output_map: {} },
  },
};

describe("an instance armed from a backfilled event", () => {
  it("is not born already past its deadline", async () => {
    // The second event runs the clock to day 20; the third is dated day 2, far
    // behind it. Deriving that instance's deadline from the raw event time
    // would put it two days after day 2 — already weeks gone — so it would
    // expire the moment it was created rather than getting its declared window.
    const trace = await run(BACKFILLED_SQL, [
      email(1, "T1", 1),
      email(2, "T2", 20),
      email(3, "T3", 2),
      // Something later, so the deadline sweep actually runs over T3's
      // instance. Without a subsequent event nothing ever comes due and the
      // instance's deadline is never tested at all.
      email(4, "T4", 21),
    ]);

    const t3 = trace.records.filter((r) => r.nodeId === "gate" && r.key.includes("T3"));
    expect(t3.length, "the backfilled arm produced no record").toBeGreaterThan(0);
    // A deadline taken from the raw event time lands weeks in the past, so the
    // very next sweep expires the instance. Given its declared two days from
    // when it was actually observed, it is still alive.
    expect(t3.map((r) => r.transition)).not.toContain("expired");
  });
});

/** A two-day wait that a reply cancels. */
const CANCELLABLE_WAIT = {
  watch: {
    name: "same-instant-cancel-beats-deadline",
    firing_policy: "stays_active",
    ontology_fingerprint: "poc-ontology-1",
    nodes: [
      {
        id: "inbound",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
      },
      {
        id: "reply",
        type: "source.document_event",
        filter: { source: "gmail", event: ["updated"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId" },
      },
      {
        id: "unanswered",
        type: "stateful.wait",
        inputs: {
          inbound: { role: "arm", key: { thread_id: ".thread_id" } },
          reply: { role: "cancel", key: { thread_id: ".thread_id" } },
        },
        on_collision: "reset",
        duration: "2 days",
        output_map: { doc_id: "$n.inbound.doc_id" },
      },
    ],
    sink: { input: "unanswered", output_map: { doc: "$n.unanswered.doc_id" } },
  },
};

/** The same instant as the deadline, on an unrelated thread. */
function bystander(seq: number, day: number): JournalEvent {
  return email(seq, "T-other", day);
}

function replyAt(seq: number, thread: string, day: number): DocEvent {
  const base = email(seq, thread, day);
  return { ...base, payload: { ...base.payload, op: "updated" } };
}

describe("a cancel arriving at the same instant as the deadline", () => {
  it("wins, and keeps winning when an unrelated event shares that instant", async () => {
    // The wait is armed on day 1 and comes due on day 3. The reply lands on
    // day 3 at the same hour. Sweeping deadlines after each event rather than
    // once the instant is exhausted lets the bystander — which touches a
    // different thread and does nothing to this one — fire the deadline before
    // the cancel behind it is dispatched.
    const withBystander = await run(CANCELLABLE_WAIT, [
      email(1, "T1", 1),
      bystander(2, 3),
      replyAt(3, "T1", 3),
      email(4, "T-last", 9),
    ]);

    const alone = await run(CANCELLABLE_WAIT, [
      email(1, "T1", 1),
      replyAt(3, "T1", 3),
      email(4, "T-last", 9),
    ]);

    const cancelled = (t: WatchTrace) =>
      t.records.some((r) => r.nodeId === "unanswered" && r.transition === "cancelled");

    expect(cancelled(alone), "control: the cancel wins on its own").toBe(true);
    expect(cancelled(withBystander), "an unrelated event changed the verdict").toBe(true);

    // The bystander arms a wait of its own, which fires later on its own
    // merits — so only the thread under test is compared.
    const cancelledThread = "d0c00000-0000-4000-8000-000000000001";
    const firedForT1 = (t: WatchTrace) =>
      t.firings.filter((f) => f.payload.doc === cancelledThread);
    expect(firedForT1(alone)).toEqual([]);
    expect(firedForT1(withBystander), "a cancelled wait fired anyway").toEqual([]);
  });
});

/**
 * Two keyed instances re-evaluated by one broadcast tick, feeding a node that
 * declares no key. Both ripen at the same timer sequence, so the identity the
 * hop carries is the only thing separating their firings.
 */
const TWO_KEYS_ONE_TICK = {
  watch: {
    name: "two-keys-one-tick",
    firing_policy: "stays_active",
    ontology_fingerprint: "poc-ontology-1",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
      },
      { id: "daily", type: "source.time", recurring: "0 12 * * *" },
      {
        id: "ready",
        type: "sql",
        inputs: {
          mail: { role: "arm", key: { thread_id: ".thread_id" } },
          daily: { role: "arm", broadcast: true },
        },
        query: "SELECT $today >= DATE '2026-03-05' AS fires",
        fire_on: "rising_edge",
        initial_level: "assume_false",
        on_collision: "accumulate",
        output_map: { thread_id: "$key.thread_id" },
      },
      {
        id: "passthrough",
        type: "stateless.or",
        inputs: { ready: { role: "arm" } },
        output_map: { thread_id: "$n.ready.thread_id" },
      },
    ],
    sink: { input: "passthrough", output_map: { thread: "$n.passthrough.thread_id" } },
  },
};

describe("two keys ripened by a single broadcast tick", () => {
  it("both reach the sink, though they share one sequence", async () => {
    // One tick re-evaluates both live instances, so both firings carry the tick's
    // sequence. The firings table is unique on (watch, sequence, node, key): if
    // the keyless hop replaced each thread's identity with an empty key, the two
    // would be indistinguishable and one would be discarded — while the trace
    // above still recorded both.
    const trace = await run(TWO_KEYS_ONE_TICK, [
      email(1, "T1", 1),
      email(2, "T2", 1),
      email(3, "T3", 6),
    ]);

    const atOneSeq = new Map<number, Set<unknown>>();
    for (const firing of trace.firings) {
      const seen = atOneSeq.get(firing.seq) ?? new Set();
      seen.add(firing.payload.thread);
      atOneSeq.set(firing.seq, seen);
    }
    const shared = [...atOneSeq.values()].filter((threads) => threads.size > 1);
    expect(shared.length, "no sequence carried two threads' firings").toBeGreaterThan(0);
  });
});

/**
 * The same daily poll, but the predicate has to hold for two days first.
 *
 * `persistence` is measured from when the predicate became true, and the only
 * evidence of that instant is the cell's own clock. A cell that stamped the
 * clock on every evaluation — true or not — would carry the *last false poll*
 * as the moment it became true, and hand the node a day of credit it never had.
 */
const HELD_FOR_TWO_DAYS = {
  watch: {
    name: "true-for-two-days",
    firing_policy: "stays_active",
    ontology_fingerprint: "poc-ontology-1",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId" },
      },
      { id: "daily", type: "source.time", recurring: "0 12 * * *" },
      {
        id: "ready",
        type: "sql",
        inputs: {
          mail: { role: "arm", key: { thread_id: ".thread_id" } },
          daily: { role: "arm", broadcast: true },
        },
        query: "SELECT $today >= DATE '2026-03-05' AS fires",
        fire_on: "rising_edge",
        initial_level: "assume_false",
        persistence: "2 days",
        on_collision: "accumulate",
        output_map: { thread_id: "$key.thread_id" },
      },
    ],
    sink: { input: "ready", output_map: { thread: "$n.ready.thread_id" } },
  },
};

describe("a predicate that must hold for a duration", () => {
  it("counts the duration from when it became true, not from the last poll", async () => {
    // The predicate turns true on the 5th and is polled at noon each day. Two
    // days of holding is satisfied on the 7th. Counting from the 4th — the last
    // poll that saw it false — brings the firing forward to the 6th, which is a
    // day the watch was told to wait through.
    const trace = await run(HELD_FOR_TWO_DAYS, [email(1, "T1", 1), email(2, "T2", 9)]);

    const fired = trace.firings.map((firing) => firing.firedAt).sort();
    expect(fired[0]).toBe("2026-03-07T12:00:00.000Z");
  });
});
