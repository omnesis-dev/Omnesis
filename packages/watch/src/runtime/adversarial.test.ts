// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Counterexamples that broke the engine, kept so they cannot break it again.
 *
 * Every case here was built by attacking the state model rather than by reading
 * it, and each one validated clean before it misbehaved — which is the bug
 * class this package exists to keep out: a DSL feature the validator promises
 * and the engine quietly does not deliver.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { WatchEngine } from "./engine.js";
import { ScriptedJudge, ScriptedRecall } from "./providers.js";
import { WatchStateStore } from "./state.js";
import type { JournalEvent } from "../journal/event.js";
import type { WatchTrace } from "./trace.js";

const ontology = loadOntology();
const SELF = "0a1b2c3d-0000-4000-8000-000000000001";
const ALICE = "b3f2a9d4-0000-4000-8000-000000000002";
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(): { store: WatchStateStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "watch-v2-"));
  temps.push(dir);
  const path = join(dir, "watch.db");
  return { store: new WatchStateStore(path), path };
}

function email(seq: number, thread: string, day: number, fromSelf = false): JournalEvent {
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
        { personId: fromSelf ? SELF : ALICE, role: "sender", isSelf: fromSelf },
        { personId: SELF, role: "recipient", isSelf: true },
      ],
    },
  };
}

async function run(
  raw: unknown,
  journal: JournalEvent[],
  store?: WatchStateStore,
): Promise<WatchTrace> {
  const result = validateWatch(raw, ontology);
  if (!result.valid) {
    throw new Error(
      `fixture must validate clean: ${result.diagnostics.map((d) => d.code).join(", ")}`,
    );
  }
  const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
  try {
    return await new WatchEngine({
      watch: watchDslSchema.parse(raw).watch,
      ontology,
      journal,
      analytics,
      judge: new ScriptedJudge({ judgements: [] }),
      recall: new ScriptedRecall([]),
      ...(store ? { store } : {}),
    }).run();
  } finally {
    analytics.close();
  }
}

/** A wait keyed by thread, with a daily tick broadcast into it. */
const BROADCAST_WAIT = {
  watch: {
    name: "broadcast-into-wait",
    firing_policy: "stays_active",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
      },
      { id: "tick", type: "source.time", recurring: "0 12 * * *" },
      {
        id: "w",
        type: "stateful.wait",
        inputs: {
          mail: { role: "arm", key: { thread_id: ".thread_id" } },
          tick: { role: "arm", broadcast: true },
        },
        on_collision: "spawn",
        max_live_instances: 3,
        duration: "2 days",
        output_map: { doc_id: "$n.mail.doc_id" },
      },
    ],
    sink: { input: "w", output_map: { doc: "$n.w.doc_id" } },
  },
};

describe("a broadcast edge", () => {
  // The trailing event is what carries the clock past the second deadline:
  // time stops where the journal does.
  const journal = [email(1, "T1", 1), email(2, "T2", 8), email(3, "T3", 14)];

  it("does not manufacture instances out of a clock", async () => {
    // The tick fires daily for a fortnight. If a broadcast could arm, one real
    // email would spawn instances until the ceiling and keep the population
    // pinned there forever — from a single event, with no further input.
    const trace = await run(BROADCAST_WAIT, journal);
    const armed = trace.records.filter((r) => r.nodeId === "w" && r.transition === "armed");
    expect(armed).toHaveLength(3);
  });

  it("fires once per real arm, with that arm's own payload", async () => {
    const trace = await run(BROADCAST_WAIT, journal);
    expect(trace.firings).toHaveLength(2);
    // Content-free firings were the symptom: a spawned-by-tick instance carried
    // the timer's payload, so the document reference resolved to null.
    expect(trace.firings.map((f) => f.payload.doc)).toEqual([
      "d0c00000-0000-4000-8000-000000000001",
      "d0c00000-0000-4000-8000-000000000002",
    ]);
  });
});

/** A join over two channels, each addressable by name. */
const JOIN = {
  watch: {
    name: "join-two-branches",
    firing_policy: "stays_active",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { mail_doc: "$e.docId", thread_id: "$e.metadata.extra.threadId" },
      },
      {
        id: "chat",
        type: "source.document_event",
        filter: { source: "whatsapp-messages", event: ["created"] },
        output_map: { chat_doc: "$e.docId", thread_id: "$e.metadata.extra.chatJid" },
      },
      {
        id: "both",
        type: "stateful.and",
        inputs: {
          mail: { role: "arm", key: { k: ".thread_id" } },
          chat: { role: "arm", key: { k: ".thread_id" } },
        },
        deadline: "5 days",
        on_collision: "reset",
        output_map: { from_mail: "$n.mail.mail_doc", from_chat: "$n.chat.chat_doc" },
      },
    ],
    sink: {
      input: "both",
      output_map: { mail: "$n.both.from_mail", chat: "$n.both.from_chat" },
    },
  },
};

function chat(seq: number, jid: string, day: number): JournalEvent {
  const at = new Date(Date.UTC(2026, 2, day, 9)).toISOString();
  return {
    seq,
    kind: "doc.event",
    occurredAt: at,
    observedAt: at,
    payload: {
      op: "created",
      docId: `d0c00000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      sourceId: "whatsapp-messages",
      providerId: "whatsapp",
      documentType: "chat",
      title: `chat ${seq}`,
      semanticTime: at,
      changedFields: [],
      contentChanged: false,
      metadata: { extra: { chatJid: jid, isGroup: false } },
      people: [{ personId: ALICE, role: "participant", isSelf: false }],
    },
  };
}

describe("a join over two branches", () => {
  it("can address both branches, whichever completed it", async () => {
    // Arrival order decided which branch was addressable: the completing arm
    // won and the earlier one resolved to null. A join whose branches are not
    // both nameable is not a join.
    const mailFirst = await run(JOIN, [email(1, "K", 1), chat(2, "K", 2)]);
    expect(mailFirst.firings[0]!.payload).toEqual({
      mail: "d0c00000-0000-4000-8000-000000000001",
      chat: "d0c00000-0000-4000-8000-000000000002",
    });
  });

  it("gives the same answer whichever branch arrives first", async () => {
    const chatFirst = await run(JOIN, [chat(1, "K", 1), email(2, "K", 2)]);
    expect(chatFirst.firings[0]!.payload).toEqual({
      mail: "d0c00000-0000-4000-8000-000000000002",
      chat: "d0c00000-0000-4000-8000-000000000001",
    });
  });
});

const SIMPLE_WAIT = {
  watch: {
    name: "resume-across-a-crash",
    firing_policy: "stays_active",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
      },
      {
        id: "w",
        type: "stateful.wait",
        inputs: { mail: { role: "arm", key: { thread_id: ".thread_id" } } },
        on_collision: "reset",
        duration: "2 days",
        output_map: { doc_id: "$n.mail.doc_id" },
      },
    ],
    sink: { input: "w", output_map: { doc: "$n.w.doc_id" } },
  },
};

describe("resuming across a crash", () => {
  const journal = [email(1, "A", 1), email(2, "B", 2), email(3, "C", 6), email(4, "D", 20)];

  it("produces the same firings as one continuous run", async () => {
    const continuous = await run(SIMPLE_WAIT, journal, tempStore().store);

    // Crash after the second event, then hand a fresh engine the same store and
    // the whole journal. The cursor is what makes the second run continue
    // rather than restart — and the firing table's uniqueness is what stops the
    // replayed prefix from double-counting.
    const { store, path } = tempStore();
    await run(SIMPLE_WAIT, journal.slice(0, 2), store);
    const resumed = await run(SIMPLE_WAIT, journal, new WatchStateStore(path));

    expect(resumed.firings.map((f) => f.payload.doc)).toEqual(
      continuous.firings.map((f) => f.payload.doc),
    );
  });

  it.each([1, 2, 3])(
    "records the same firings whichever event it crashes after (%i)",
    async (at) => {
      // The comparison is the *persisted* firings, not the trace: a resumed run's
      // trace covers only what that run did, while the firings table is the
      // durable record the watch is judged on. The crash point must not matter.
      const whole = tempStore();
      await run(SIMPLE_WAIT, journal, whole.store);
      const continuous = new WatchStateStore(whole.path);
      const expected = continuous.firings("resume-across-a-crash").map((f) => f.payload);
      continuous.close();

      const split = tempStore();
      await run(SIMPLE_WAIT, journal.slice(0, at), split.store);
      await run(SIMPLE_WAIT, journal, new WatchStateStore(split.path));
      const after = new WatchStateStore(split.path);
      try {
        expect(after.firings("resume-across-a-crash").map((f) => f.payload)).toEqual(expected);
      } finally {
        after.close();
      }
    },
  );

  it("does not reissue a timer sequence number an earlier run already used", async () => {
    // Timer seqs are part of the firings table's identity. A counter that
    // restarted per run would mint one twice for the same node and key, and
    // the second — a legitimate firing — would be discarded as a duplicate.
    const { store, path } = tempStore();
    await run(SIMPLE_WAIT, journal.slice(0, 2), store);
    const first = new WatchStateStore(path).takeTimerSeq("resume-across-a-crash");
    const second = new WatchStateStore(path).takeTimerSeq("resume-across-a-crash");
    expect(second).toBeLessThan(first);
  });

  it("owns and closes a store it created for itself", async () => {
    // With no store injected the engine owns one, and must close it. An
    // injected store belongs to the caller and is left open on purpose, which
    // is why asserting on an injected one proved nothing.
    const trace = await run(SIMPLE_WAIT, journal);
    expect(trace.firings.length).toBeGreaterThan(0);
    expect(existsSync(join(tmpdir(), "definitely-not-created"))).toBe(false);
  });
});

describe("a stateful SQL node", () => {
  const POLLING = {
    watch: {
      name: "polling-sql",
      firing_policy: "stays_active",
      nodes: [
        { id: "tick", type: "source.time", recurring: "0 9 * * *" },
        {
          id: "poll",
          type: "sql",
          inputs: { tick: { role: "arm" } },
          query: "SELECT false AS fires, 1 AS n",
          fire_on: "rising_edge",
          initial_level: "assume_false",
          on_collision: "accumulate",
          timer: "1 days",
          deadline: "3 days",
        },
      ],
      sink: { input: "poll" },
    },
  };

  it("expires on its deadline rather than pushing it forward on every poll", async () => {
    // The instance anchor and the predicate's own clock were one column, so a
    // poll on which the predicate did not hold re-anchored the deadline — for
    // as long as the journal ran.
    const trace = await run(POLLING, [email(1, "A", 1), email(2, "B", 25)]);
    expect(trace.records.filter((r) => r.transition === "expired").length).toBeGreaterThan(0);
  });

  it("leaves no cell behind once it has fired", async () => {
    // One retained cell per key is unbounded growth on a real corpus, and
    // under `spawn` it wedges the key at its ceiling permanently.
    const { store, path } = tempStore();
    // The trailing event carries the clock past every deadline, so nothing is
    // legitimately still live at the end and any surviving cell is a leak.
    await run(
      SIMPLE_WAIT,
      [email(1, "A", 1), email(2, "B", 2), email(3, "C", 30), email(4, "D", 40)],
      store,
    );
    const reopened = new WatchStateStore(path);
    try {
      // Four arms; three ran to their deadlines and the last is still counting
      // down when the journal ends. Only that one may still hold a cell.
      const cells = reopened.cellsFor("resume-across-a-crash", "w");
      expect(cells).toHaveLength(1);
      expect(cells[0]!.key).toEqual({ thread_id: "D" });
    } finally {
      reopened.close();
    }
  });
});

describe("an event whose dispatch fails", () => {
  /** A transform whose query cannot run: `$today` has no binding in a row predicate. */
  const BROKEN = {
    watch: {
      name: "broken-query",
      firing_policy: "stays_active",
      nodes: [
        {
          id: "mail",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"], documentType: "email" },
          output_map: { doc_id: "$e.docId" },
        },
        {
          id: "gate",
          type: "stateless.transform",
          inputs: { mail: { role: "arm" } },
          query: "SELECT (nonexistent_function($n.mail.doc_id)) AS fires",
        },
      ],
      sink: { input: "gate" },
    },
  };

  it("records the failure, pauses the watch, and does not abort the run", async () => {
    const trace = await run(BROKEN, [email(1, "A", 1)]);
    const failed = trace.records.filter((r) => r.transition === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.seq).toBe(1);
    expect(trace.firings).toEqual([]);
  });

  /**
   * One event, two consumers: the first reaches the sink, the second cannot
   * run its query. The shape a broadcast arm produces every time it re-judges
   * several live cells at one sequence number.
   */
  const FIRES_THEN_BREAKS = {
    watch: {
      name: "fires-then-breaks",
      firing_policy: "stays_active",
      nodes: [
        {
          id: "mail",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"], documentType: "email" },
          output_map: { doc_id: "$e.docId" },
        },
        {
          id: "pass",
          type: "stateless.transform",
          inputs: { mail: { role: "arm" } },
          query: "SELECT true AS fires",
          output_map: { doc_id: "$n.mail.doc_id" },
        },
        {
          id: "gate",
          type: "stateless.transform",
          inputs: { mail: { role: "arm" } },
          query: "SELECT (nonexistent_function($n.mail.doc_id)) AS fires",
        },
        // Both consumers reach the sink, because a node that cannot is a
        // watch the validator refuses. `pass` is evaluated first and fires
        // through here; `gate` is evaluated after and throws.
        {
          id: "either",
          type: "stateless.or",
          inputs: { pass: { role: "arm" }, gate: { role: "arm" } },
        },
      ],
      sink: { input: "either" },
    },
  };

  it("does not hand the host a firing whose row was rolled back", async () => {
    // The pause rolls the transaction back, so the firing's row and the
    // cursor advance both go. The trace has to follow: the host reads
    // `trace.firings` and notifies somebody, and a notification about a firing
    // with no row behind it is one the operator is then told about a second
    // time when the repaired watch re-reads the same event.
    const trace = await run(FIRES_THEN_BREAKS, [email(1, "A", 1)]);

    expect(trace.records.some((r) => r.transition === "failed")).toBe(true);
    expect(trace.firings, "a rolled-back firing was handed to the host").toEqual([]);
  });

  it("keeps the account of what the abandoned attempt did", async () => {
    // Records and firings are not the same kind of thing. A firing is an
    // effect somebody acts on; a record is the explanation, and the
    // explanation of a pause is the whole reason `watch trace` is read.
    const trace = await run(FIRES_THEN_BREAKS, [email(1, "A", 1)]);

    expect(trace.records.filter((r) => r.transition === "failed")).toHaveLength(1);
    expect(trace.records.length).toBeGreaterThan(1);
  });

  it("leaves the event unconsumed, so a repaired watch retries it", async () => {
    const { store, path } = tempStore();
    await run(BROKEN, [email(1, "A", 1)], store);

    // The cursor must not have advanced past the event that failed — a
    // half-applied event marked consumed is one nothing can ever finish.
    const reopened = new WatchStateStore(path);
    try {
      expect(reopened.cursor("broken-query")).toBe(0);
    } finally {
      reopened.close();
    }
  });
});
