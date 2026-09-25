// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a long run stays a guest on the process it is in.
 *
 * A run is a loop of `await`s over work that is mostly synchronous, and
 * awaiting synchronous work queues a *micro*task — which Node drains to
 * completion before it serves anything else. So without a real yield a replay
 * blocks every request, every timer and, on a host that is also running
 * watches, the live engine, for its whole duration. That is why a replay over
 * the live journal was bounded at a couple of thousand events, and why the
 * bound was a latency bound rather than a cost one.
 *
 * `setImmediate` is a macrotask. A tick landing *during* the run is therefore
 * proof the loop got control back; zero ticks is the failure, and is what the
 * engine did before it took a deadline.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { Ontology } from "../ontology/snapshot.js";
import { CountingJudge, ScriptedRecall } from "./providers.js";
import { WatchEngine } from "./engine.js";
import type { JournalEvent } from "../journal/event.js";
import type { AnalyticsPort } from "./engine.js";

/** Nothing here queries; a source node with no predicate never reaches it. */
const NO_ANALYTICS: AnalyticsPort = {
  query: () => Promise.resolve({ rows: [], columns: [] } as never),
};

const ontology = Ontology.parse({
  fingerprint: "a-fingerprint",
  sources: [
    {
      sourceId: "mailbox",
      providerId: "mailbox",
      semanticallyIndexed: false,
      profile: { documentTypes: ["email"], personRoles: ["sender"], metadataFields: [] },
    },
  ],
  analyticsTables: [],
  people: [],
});

const watch = {
  name: "takes-every-email",
  firing_policy: "stays_active" as const,
  nodes: [
    {
      id: "seen",
      type: "source.document_event" as const,
      filter: { source: "mailbox", event: ["created" as const] },
      output_map: { doc_id: "$e.docId" },
    },
  ],
  sink: { input: "seen", output_map: { doc_id: "$n.seen.doc_id" } },
};

/** Enough events that a run takes longer than any sane yield deadline. */
function events(n: number): JournalEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60)).toISOString(),
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60)).toISOString(),
    kind: "doc.event" as const,
    payload: {
      op: "created" as const,
      docId: `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      sourceId: "mailbox",
      providerId: "mailbox",
      documentType: "email",
      title: `message ${i}`,
      semanticTime: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      changedFields: [],
      contentChanged: true,
      metadata: {},
      people: [],
    },
  }));
}

/** Ticks a macrotask counter for as long as `work` is running. */
async function ticksDuring(work: () => Promise<unknown>): Promise<number> {
  let ticks = 0;
  let running = true;
  const tick = (): void => {
    if (!running) return;
    ticks += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  await work();
  running = false;
  return ticks;
}

function engine(shouldYield?: () => boolean): WatchEngine {
  return new WatchEngine({
    watch,
    ontology,
    journal: events(4_000),
    analytics: NO_ANALYTICS,
    judge: new CountingJudge(),
    recall: new ScriptedRecall([], 1),
    ...(shouldYield === undefined ? {} : { shouldYield }),
  });
}

describe("a long run and the event loop", () => {
  it("hands it back when the caller says to", async () => {
    // Every hundredth event, so the hand-backs are frequent enough to observe.
    // The host asks a deadline instead; what is proved here is that the answer
    // is honoured at all.
    let seen = 0;
    expect(await ticksDuring(() => engine(() => ++seen % 100 === 0).run())).toBeGreaterThan(0);
  });

  it("holds it for the whole run when it is not asked to", async () => {
    // The live engine's shape: it consumes a small slice per tick and the
    // scheduler decides when it runs, so it wants no yield and pays nothing
    // for one. This is also the state a replay was in before it took a
    // deadline, and the reason a replay could not be pointed at ninety days.
    expect(await ticksDuring(() => engine().run())).toBe(0);
  });

  it("pays nothing for a predicate that never says yes", async () => {
    // What a deadline looks like on a run too short to reach it: a fast replay
    // never buys a hand-back it does not need, which is why the host asks in
    // time rather than in events.
    expect(await ticksDuring(() => engine(() => false).run())).toBe(0);
  });
});
