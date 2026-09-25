// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Several instances of one node, live at the same time.
 *
 * This is the shape the corpus did not have, and the shape under which a whole
 * class of bug is invisible. With one key live, a per-node "last output" and
 * correct per-instance scoping are indistinguishable — every assertion passes
 * either way. With three, they diverge immediately: the firing instance gets
 * whichever key happened to arm most recently.
 *
 * So these tests do not assert how many firings there were. They assert that
 * **each firing carries its own key's data**, which is the only assertion that
 * can tell the two implementations apart.
 */

import { describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { WatchEngine } from "./engine.js";
import { ScriptedJudge, ScriptedRecall } from "./providers.js";
import type { WatchStateStore } from "./state.js";
import type { JournalEvent } from "../journal/event.js";
import type { WatchTrace } from "./trace.js";

const ontology = loadOntology();
const SELF = "0a1b2c3d-0000-4000-8000-000000000001";
const ALICE = "b3f2a9d4-0000-4000-8000-000000000002";

/** A wait keyed by thread, cancelled by a reply on the same thread. */
const THREAD_WATCH = {
  watch: {
    name: "thread-concurrency",
    firing_policy: "stays_active",
    nodes: [
      {
        id: "inbound",
        type: "source.document_event",
        filter: {
          source: "gmail",
          event: ["created"],
          documentType: "email",
          people: [{ role: "sender", isSelf: false }],
        },
        output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
      },
      {
        id: "reply",
        type: "source.document_event",
        filter: {
          source: "gmail",
          event: ["created"],
          documentType: "email",
          people: [{ role: "sender", isSelf: true }],
        },
        output_map: { thread_id: "$e.metadata.extra.threadId" },
      },
      {
        id: "wait3",
        type: "stateful.wait",
        inputs: {
          inbound: { role: "arm", key: { thread_id: ".thread_id" } },
          reply: { role: "cancel", key: { thread_id: ".thread_id" } },
        },
        on_collision: "reset",
        duration: "3 days",
        output_map: { doc: "$n.inbound.doc_id", thread: "$n.inbound.thread_id" },
      },
    ],
    sink: {
      input: "wait3",
      output_map: {
        doc: "$n.wait3.doc",
        thread: "$n.wait3.thread",
        key_thread: "$n.wait3.$key.thread_id",
      },
    },
  },
};

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
      `fixture does not validate: ${result.diagnostics.map((d) => d.code).join(", ")}`,
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

/** Peak number of distinct keys live on one node, read off a trace. */
function peakLiveKeys(trace: WatchTrace, nodeId: string): number {
  const live = new Set<string>();
  let peak = 0;
  for (const record of trace.records) {
    if (record.nodeId !== nodeId) continue;
    if (record.transition === "armed" || record.transition === "accumulated") live.add(record.key);
    else if (["fired", "cancelled", "expired", "dropped"].includes(record.transition)) {
      live.delete(record.key);
    }
    peak = Math.max(peak, live.size);
  }
  return peak;
}

describe("several keys live at once", () => {
  // Three threads arm on consecutive days, so all three are live together. The
  // middle one is answered; the other two run to their own deadlines.
  const journal = [
    email(1, "A", 1),
    email(2, "B", 2),
    email(3, "C", 3),
    email(4, "B", 5, true),
    email(5, "Z", 20),
  ];

  it("really does hold three instances at the same time", async () => {
    const trace = await run(THREAD_WATCH, journal);
    expect(peakLiveKeys(trace, "wait3")).toBe(3);
  });

  it("gives each firing its own key's data, not the most recent arm's", async () => {
    const trace = await run(THREAD_WATCH, journal);

    // This is the assertion that distinguishes per-instance scoping from a
    // per-node last-write. Both produce two firings here; only one produces
    // the right documents in them.
    const byThread = new Map(trace.firings.map((f) => [f.payload.thread as string, f.payload]));
    expect([...byThread.keys()].sort()).toEqual(["A", "C"]);
    expect(byThread.get("A")!.doc).toBe("d0c00000-0000-4000-8000-000000000001");
    expect(byThread.get("C")!.doc).toBe("d0c00000-0000-4000-8000-000000000003");
  });

  it("carries each instance's own key through `$key`", async () => {
    const trace = await run(THREAD_WATCH, journal);
    for (const firing of trace.firings) {
      expect(firing.payload.key_thread).toBe(firing.payload.thread);
    }
  });

  it("cancels only the thread that was answered", async () => {
    const trace = await run(THREAD_WATCH, journal);
    const cancelled = trace.records.filter((r) => r.transition === "cancelled");
    expect(cancelled.map((r) => r.key)).toEqual(["thread_id=B"]);
  });

  it("fires each deadline at its own instant, three days after its own arm", async () => {
    const trace = await run(THREAD_WATCH, journal);
    const when = new Map(trace.firings.map((f) => [f.payload.thread as string, f.firedAt]));
    expect(when.get("A")).toBe("2026-03-04T09:00:00.000Z");
    expect(when.get("C")).toBe("2026-03-06T09:00:00.000Z");
  });
});

describe("a cancel arriving at the exact instant a deadline is due", () => {
  it("beats the deadline — the reply is evidence, the deadline is its absence", async () => {
    // Armed on the 1st with a three-day wait; the reply lands on the 4th at the
    // same hour. Firing here would mean telling the operator nobody answered an
    // email that was answered.
    const trace = await run(THREAD_WATCH, [
      email(1, "A", 1),
      email(2, "A", 4, true),
      email(3, "Z", 20),
    ]);
    expect(trace.firings).toEqual([]);
    expect(trace.records.filter((r) => r.transition === "cancelled")).toHaveLength(1);
  });

  it("still fires when the reply is a moment too late", async () => {
    const late = email(2, "A", 4, true);
    const shifted = new Date(Date.parse(late.occurredAt) + 1000).toISOString();
    const trace = await run(THREAD_WATCH, [
      email(1, "A", 1),
      { ...late, occurredAt: shifted, observedAt: shifted },
      email(3, "Z", 20),
    ]);
    expect(trace.firings).toHaveLength(1);
    expect(trace.firings[0]!.payload.thread).toBe("A");
  });
});
