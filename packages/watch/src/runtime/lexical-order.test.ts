// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * "A before B" has to mean the order things happened.
 *
 * A nominating source waits for the document to be indexed, because a semantic
 * arm compares an embedding and there is no embedding until the indexer has
 * made one. A lexical arm is a term match against the title: nothing about it
 * needs an index.
 *
 * Waiting anyway costs more than latency. Documents finish indexing in the
 * order the embedding work happens to complete, which bears no relation to the
 * order they arrived — so a `stateful.sequence` fed from lexical arms was
 * answering "did A finish indexing before B", and reporting it as "did A happen
 * before B".
 *
 * Two mails sent seconds apart, correct in the journal, can therefore reach the
 * gate reversed: the ordered pair stays silent and a deliberately-reversed pair
 * fires. Both gates are right about what they were shown. Nothing is wrong with
 * the sequence node at all, which is why this is tested here rather than there.
 */

import { describe, expect, it } from "vitest";

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

/** A judge that agrees with whatever a lexical arm nominated. */
const CONFIRMS = new ScriptedJudge({ judgements: [], fallback: { fired: true, output: {} } });

function at(minute: number): string {
  return new Date(Date.UTC(2026, 2, 4, 9, minute)).toISOString();
}

/** A mail with a token in its subject, and its index landing separately. */
function mail(seq: number, title: string, minute: number): JournalEvent {
  return {
    seq,
    kind: "doc.event",
    occurredAt: at(minute),
    observedAt: at(minute),
    payload: {
      op: "created",
      docId: `d0c00000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      sourceId: "gmail",
      providerId: "google",
      documentType: "email",
      title,
      semanticTime: at(minute),
      changedFields: [],
      contentChanged: false,
      metadata: {},
      people: [],
    },
  };
}

/** The indexer finishing with a document, which may be in any order at all. */
function indexed(seq: number, docSeq: number, minute: number): JournalEvent {
  return {
    seq,
    kind: "doc.indexed",
    occurredAt: at(minute),
    observedAt: at(minute),
    payload: { docId: `d0c00000-0000-4000-8000-${String(docSeq).padStart(12, "0")}` },
  } as JournalEvent;
}

/** Fires only when CONFIRMED is followed by SHIPPED, in that order. */
function orderedPair(): unknown {
  return {
    watch: {
      name: "order-pair",
      firing_policy: "stays_active",
      ontology_fingerprint: ontology.fingerprint,
      nodes: [
        {
          id: "confirmed",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"], documentType: "email" },
          recall: { lexical: { terms: ["ORDER-K7QX-CONFIRMED"], match: "token" } },
          judge: {
            proposition: "The title contains the exact text ORDER-K7QX-CONFIRMED",
            output_schema: { seen: "bool" },
          },
          output_map: { doc_id: "$e.docId" },
        },
        {
          id: "shipped",
          type: "source.document_event",
          filter: { source: "gmail", event: ["created"], documentType: "email" },
          recall: { lexical: { terms: ["ORDER-K7QX-SHIPPED"], match: "token" } },
          judge: {
            proposition: "The title contains the exact text ORDER-K7QX-SHIPPED",
            output_schema: { seen: "bool" },
          },
          output_map: { doc_id: "$e.docId" },
        },
        {
          id: "in_order",
          type: "stateful.sequence",
          inputs: { confirmed: { role: "arm" }, shipped: { role: "arm" } },
          order: ["confirmed", "shipped"],
          deadline: "7 days",
          on_collision: "ignore",
          output_map: {},
        },
      ],
      sink: { input: "in_order", output_map: {} },
    },
  };
}

async function run(journal: JournalEvent[]): Promise<WatchTrace> {
  const raw = orderedPair();
  const result = validateWatch(raw, ontology);
  expect(result.valid, result.diagnostics.map((d) => d.code).join(", ")).toBe(true);

  const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
  const store = new WatchStateStore();
  try {
    return await new WatchEngine({
      watch: watchDslSchema.parse(raw).watch,
      watchId: "w-pair",
      ontology,
      journal,
      analytics,
      store,
      judge: CONFIRMS,
      recall: new ScriptedRecall([], 0),
    }).run();
  } finally {
    store.close();
    analytics.close();
  }
}

const CONFIRMED_FIRST = [
  mail(1, "Order ORDER-K7QX-CONFIRMED", 0),
  mail(2, "Order ORDER-K7QX-SHIPPED", 1),
];
const SHIPPED_FIRST = [
  mail(1, "Order ORDER-K7QX-SHIPPED", 0),
  mail(2, "Order ORDER-K7QX-CONFIRMED", 1),
];

describe("a sequence over lexical arms", () => {
  it("fires when the pair arrives in order", async () => {
    expect((await run(CONFIRMED_FIRST)).firings).toHaveLength(1);
  });

  it("stays silent when it arrives reversed", async () => {
    const trace = await run(SHIPPED_FIRST);
    expect(trace.firings, "the gate degraded into an unordered AND").toHaveLength(0);
    expect(
      trace.records.some((r) => r.nodeId === "in_order" && r.transition === "dropped"),
      "the out-of-order arm was not recorded as dropped",
    ).toBe(true);
  });

  it("is decided by the journal, not by the order indexing happened to finish", async () => {
    // The live failure exactly: the pair is correct on the journal, and the
    // indexer completes them backwards — which it is free to do, since embedding
    // runs on a worker pool and two mails in one batch race each other.
    const trace = await run([
      ...CONFIRMED_FIRST,
      indexed(3, 2, 2), // SHIPPED indexed first
      indexed(4, 1, 2), // CONFIRMED second
    ]);
    expect(trace.firings, "the gate followed indexing order rather than the journal").toHaveLength(
      1,
    );
  });

  it("does not fire twice when the index lands after the document", async () => {
    // The other direction of the same change: now that a lexical arm answers on
    // the document, the later `doc.indexed` must not nominate it a second time.
    const trace = await run([...CONFIRMED_FIRST, indexed(3, 1, 2), indexed(4, 2, 2)]);
    expect(trace.firings, "the index re-nominated a document already decided").toHaveLength(1);
  });
});

describe("a recall that genuinely needs the index", () => {
  /** Runs the semantic watch over a journal and reports what it fired. */
  async function semantic(journal: JournalEvent[]): Promise<WatchTrace> {
    const raw = {
      watch: {
        name: "semantic-arm",
        firing_policy: "stays_active",
        ontology_fingerprint: ontology.fingerprint,
        nodes: [
          {
            id: "topic",
            type: "source.document_event",
            filter: { source: "gmail", event: ["created"], documentType: "email" },
            recall: { semantic: { query: "a question about an order", threshold: 0.35 } },
            judge: {
              proposition: "This document is about an order",
              output_schema: { seen: "bool" },
            },
            output_map: {},
          },
        ],
        sink: { input: "topic", output_map: {} },
      },
    };
    const result = validateWatch(raw, ontology);
    expect(result.valid, result.diagnostics.map((d) => d.code).join(", ")).toBe(true);

    const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
    const store = new WatchStateStore();
    try {
      return await new WatchEngine({
        watch: watchDslSchema.parse(raw).watch,
        watchId: "w-semantic",
        ontology,
        journal,
        analytics,
        store,
        judge: CONFIRMS,
        // Every document scores well above the threshold, so the only thing
        // that can keep this watch quiet is not having been asked.
        recall: new ScriptedRecall([], 0.9),
      }).run();
    } finally {
      store.close();
      analytics.close();
    }
  }

  it("does not score a document the indexer has not reached", async () => {
    // There is no embedding to compare against yet. Scoring here would be
    // scoring nothing, and the answer would be whatever the absence produced.
    const trace = await semantic([mail(1, "Order ORDER-K7QX-CONFIRMED", 0)]);
    expect(trace.firings, "a semantic arm scored an unindexed document").toHaveLength(0);
  });

  it("scores it once the index lands", async () => {
    // The other half: the wait is a wait, not a refusal.
    const trace = await semantic([mail(1, "Order ORDER-K7QX-CONFIRMED", 0), indexed(2, 1, 1)]);
    expect(trace.firings, "the semantic arm never ran after indexing").toHaveLength(1);
  });
});

/**
 * The other half of the same ordering problem, from the index's side.
 *
 * A semantic arm genuinely has to wait for the index — there is no embedding to
 * compare until the indexer has made one — so it is answered on the index event
 * and finds its document by lookup. Nothing guarantees the document event was
 * written first — one can land a sequence or two *behind* its own index event.
 * Without somewhere to keep the index until the document arrives, the lookup
 * finds nothing, the handler returns, and the node never sees that document at
 * all: not declined, not traced, absent. Nothing downstream can tell
 * "considered and rejected" from "never happened", which is the distinction a
 * trace exists to preserve — and only a later re-index of the same document
 * could repair it, by accident.
 */
describe("an index event that outruns its own document", () => {
  const TOPIC = "a question about an order";

  function semanticWatch(): unknown {
    return {
      watch: {
        name: "semantic-arm",
        firing_policy: "stays_active",
        ontology_fingerprint: ontology.fingerprint,
        nodes: [
          {
            id: "topic",
            type: "source.document_event",
            filter: { source: "gmail", event: ["created"], documentType: "email" },
            recall: { semantic: { query: TOPIC, threshold: 0.35 } },
            judge: {
              proposition: "This document is about an order",
              output_schema: { seen: "bool" },
            },
            output_map: {},
          },
        ],
        sink: { input: "topic", output_map: {} },
      },
    };
  }

  /** Runs the semantic watch, and hands back the store so state can be read. */
  async function runSemantic(
    journal: JournalEvent[],
  ): Promise<{ trace: WatchTrace; store: WatchStateStore }> {
    const raw = semanticWatch();
    const result = validateWatch(raw, ontology);
    expect(result.valid, result.diagnostics.map((d) => d.code).join(", ")).toBe(true);

    const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
    const store = new WatchStateStore();
    try {
      const trace = await new WatchEngine({
        watch: watchDslSchema.parse(raw).watch,
        watchId: "w-semantic",
        ontology,
        journal,
        analytics,
        store,
        judge: CONFIRMS,
        // Every document scores far above the threshold, so the only thing that
        // can keep this watch quiet is never having been asked.
        recall: new ScriptedRecall([], 0.9),
      }).run();
      return { trace, store };
    } finally {
      analytics.close();
    }
  }

  const OUT_OF_ORDER: JournalEvent[] = [
    indexed(1, 2, 0), // the index event, at sequence 1
    mail(2, "Order ORDER-K7QX-CONFIRMED", 1), // the document it is about, at 2
  ];

  it("scores the document once it lands, rather than never", async () => {
    const { trace, store } = await runSemantic(OUT_OF_ORDER);
    expect(trace.firings, "a document whose index outran it was never seen").toHaveLength(1);
    store.close();
  });

  it("attributes it to the document, which is where both facts were first true", async () => {
    const { trace, store } = await runSemantic(OUT_OF_ORDER);
    expect(trace.firings[0]?.seq, "the firing was attributed to the index event").toBe(2);
    store.close();
  });

  it("says out loud that it deferred, rather than leaving a gap", async () => {
    // The absence is the defect. A node that received an event and neither
    // decided nor recorded anything is indistinguishable from a node the event
    // never reached, and a reader has no way to tell which happened.
    const { trace, store } = await runSemantic(OUT_OF_ORDER);
    const deferred = trace.records.find(
      (r) => r.seq === 1 && r.nodeId === "topic" && r.transition === "held",
    );
    expect(deferred, "the deferral left no record at all").toBeDefined();
    expect(deferred?.detail).toContain("not been journalled");
    store.close();
  });

  it("stops owing the index once the document has settled it", async () => {
    const { store } = await runSemantic(OUT_OF_ORDER);
    expect(store.pendingIndexCount("w-semantic"), "a settled index was still owed").toBe(0);
    store.close();
  });

  it("does not score it twice when the index event repeats afterwards", async () => {
    // A re-index of a document already decided must not nominate it a second
    // time — the guard is the look, keyed on the document's own event.
    const { trace, store } = await runSemantic([...OUT_OF_ORDER, indexed(3, 2, 2)]);
    expect(trace.firings, "the re-index nominated a document already decided").toHaveLength(1);
    store.close();
  });

  it("keeps owing it while the document has still not arrived", async () => {
    // The engine must not quietly forget: the document may be in the next slice
    // of the journal, days later, or never — and only the first two are its
    // business.
    const { trace, store } = await runSemantic([indexed(1, 9, 0)]);
    expect(trace.firings).toHaveLength(0);
    expect(store.pendingIndexCount("w-semantic"), "the index event was dropped").toBe(1);
    store.close();
  });

  it("does not grow without bound when a document never arrives", () => {
    // An entry is settled by the document it waits for, which in ordinary
    // running lands within a few sequences. One that is never settled means an
    // index event was written for a document that was never journalled — a
    // defect upstream, and not a reason to hold rows forever.
    const store = new WatchStateStore();
    for (let seq = 1; seq <= 1100; seq += 1) store.parkIndex("w", `doc-${seq}`, seq);

    expect(store.pendingIndexCount("w")).toBe(1000);
    expect(store.indexOwed("w", "doc-1"), "the oldest were kept over the newest").toBeNull();
    expect(store.indexOwed("w", "doc-1100")).toBe(1100);
    store.close();
  });

  it("says out loud when the limit costs it a deferral", async () => {
    // An eviction is a document a node will now never consider — the outcome
    // the queue exists to prevent. A queue that silently forgets is
    // indistinguishable from one that never held the thing at all, which is the
    // absence this whole fix is about.
    const journal: JournalEvent[] = [];
    for (let seq = 1; seq <= 1001; seq += 1) journal.push(indexed(seq, 5000 + seq, 0));
    const { trace, store } = await runSemantic(journal);

    expect(store.pendingIndexCount("w-semantic")).toBe(1000);
    const dropped = trace.records.filter((r) => r.transition === "dropped");
    expect(dropped.length, "a deferral was discarded in silence").toBeGreaterThan(0);
    expect(dropped[0]?.detail).toContain("queue's limit");
    store.close();
  });

  it("prunes only its own watch's deferrals", () => {
    const store = new WatchStateStore();
    store.parkIndex("w-other", "doc-keep", 1);
    for (let seq = 1; seq <= 1001; seq += 1) store.parkIndex("w", `doc-${seq}`, seq);

    expect(store.indexOwed("w-other", "doc-keep"), "a sibling watch's deferral was pruned").toBe(1);
    store.close();
  });

  it("keeps the first index event when a document is indexed twice before landing", () => {
    // The earlier one is the sequence at which this document first became
    // scorable, and it is the one a replay of the same journal would reach.
    const store = new WatchStateStore();
    store.parkIndex("w", "doc-1", 40);
    store.parkIndex("w", "doc-1", 12);
    expect(store.indexOwed("w", "doc-1")).toBe(12);
    expect(store.pendingIndexCount("w"), "one document occupied two slots").toBe(1);
    store.close();
  });

  it("remembers nothing for a watch that never waits on an index", async () => {
    // A lexical watch is answered on the document itself, so an index event is
    // nothing to it. Parking one anyway would have every watch in an install
    // holding rows about documents none of them will ever score.
    const raw = orderedPair();
    const analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
    const store = new WatchStateStore();
    try {
      await new WatchEngine({
        watch: watchDslSchema.parse(raw).watch,
        watchId: "w-pair",
        ontology,
        journal: [indexed(1, 9, 0)],
        analytics,
        store,
        judge: CONFIRMS,
        recall: new ScriptedRecall([], 0),
      }).run();
      expect(store.pendingIndexCount("w-pair")).toBe(0);
    } finally {
      store.close();
      analytics.close();
    }
  });
});
