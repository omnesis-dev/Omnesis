// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the runtime does when it has to ask something it cannot compute.
 *
 * Three properties, each of which was once false and cost something:
 *
 * - A judge or a recall scorer is never called with a write transaction open.
 *   A host that shares a thread between its writers has the other one block
 *   inside SQLite's busy handler for as long as the call takes, and a model
 *   call takes as long as a model takes.
 * - A nomination the judge could not afford is parked, not spent. The look that
 *   would stop it ever being reconsidered is withheld, and the trace says the
 *   budget ran out rather than that the judge declined.
 * - Retrying an event leaves no trace of the attempt that was abandoned.
 *
 * Written against a hand-built journal rather than a fixture universe, because
 * each case turns on a provider behaving in a specific way at a specific event,
 * and that is not something a corpus can be asked for.
 */

import { describe, expect, it } from "vitest";

import { Ontology } from "../ontology/snapshot.js";
import { WatchEngine } from "./engine.js";
import { WatchStateStore } from "./state.js";
import type { JournalEvent } from "../journal/event.js";
import type { JudgeProvider, JudgeVerdict, RecallScorer } from "./providers.js";

const DOC = "d1e2f3a4-0000-4000-8000-000000000001";

const ontology = Ontology.parse({
  fingerprint: "offhost",
  sources: [
    {
      sourceId: "gmail",
      providerId: "google",
      semanticallyIndexed: true,
      profile: { documentTypes: ["email"], personRoles: ["sender"], metadataFields: [] },
    },
  ],
  analyticsTables: [],
  people: [],
});

/** A watch whose only source nominates on a literal term and then judges it. */
function semanticWatch(): Record<string, unknown> {
  return {
    name: "quotes",
    firing_policy: "stays_active",
    ontology_fingerprint: "offhost",
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created"], documentType: "email" },
        recall: { lexical: { terms: ["quote"] } },
        judge: {
          proposition: "this is a quote for work on the house",
          output_schema: { because: "string" },
        },
        output_map: { doc_id: "$e.docId" },
      },
    ],
    sink: { input: "mail", output_map: { doc_id: "$n.mail.doc_id" } },
  };
}

/**
 * A document event and the index that makes it visible to a recall arm.
 *
 * `observedAt` defaults to the document's own time, which is the ordinary case.
 * A caller passes them apart to model the one that matters: a document indexed
 * today that has carried a date of its own since long before.
 */
function documentAndIndex(at: string, observedAt: string = at): JournalEvent[] {
  return [
    {
      seq: 1,
      kind: "doc.event",
      occurredAt: at,
      observedAt,
      payload: {
        op: "created",
        docId: DOC,
        sourceId: "gmail",
        providerId: "google",
        documentType: "email",
        title: "Your quote for the roof",
        semanticTime: at,
        changedFields: [],
        contentChanged: false,
        metadata: {},
        people: [],
      },
    },
    {
      seq: 2,
      kind: "doc.indexed",
      occurredAt: at,
      observedAt,
      payload: { docId: DOC, eventIndexedAt: at },
    },
  ] as JournalEvent[];
}

const NEVER_RECALLED: RecallScorer = { score: () => 0 };

/** What a judge over its daily cap comes back with. */
const BUDGET_SPENT = { failure: "budget", reason: "judge budget spent" } as const;

/**
 * An engine in the shape a live host builds one: the journal is queryable
 * rather than a list held in memory, which is what lets a run reach a document
 * older than the slice it was handed.
 */
function engineOver(
  journal: JournalEvent[],
  store: WatchStateStore,
  judge: JudgeProvider,
  recall: RecallScorer = NEVER_RECALLED,
  reachable: JournalEvent[] = journal,
  timeReachedMs?: number,
): WatchEngine {
  return new WatchEngine({
    watch: semanticWatch() as never,
    ontology,
    journal,
    analytics: { query: () => Promise.resolve({ rows: [], columns: [] }) },
    judge,
    recall,
    store,
    ...(timeReachedMs === undefined ? {} : { timeReachedMs }),
    lookupDocument: (docId, atSeq) => {
      for (const event of [...reachable].reverse()) {
        if (event.kind !== "doc.event" || event.seq > atSeq) continue;
        if (event.payload.docId !== docId) continue;
        return { event: event.payload, seq: event.seq };
      }
      return null;
    },
  });
}

describe("a provider call", () => {
  it("carries document kind, time and participant direction into judgement", async () => {
    const events = documentAndIndex("2026-03-01T09:00:00Z");
    const document = events[0];
    if (document?.kind !== "doc.event") throw new Error("expected a document event");
    document.payload.contentHash = "revision-1";
    document.payload.people = [
      { personId: null, role: "sender", isSelf: false },
      { personId: null, role: "recipient", isSelf: true },
      { personId: "ignored", role: "sender", isSelf: false },
      ...Array.from({ length: 40 }, (_, index) => ({
        personId: null,
        role: `participant-${index}`,
        isSelf: false,
      })),
    ];
    let evidence: Readonly<Record<string, unknown>> | undefined;
    let documentRevision: string | undefined;
    const judge: JudgeProvider = {
      judge: (request) => {
        evidence = request.evidence;
        documentRevision = request.documentRevision;
        return { fired: false, output: {} };
      },
    };

    const store = new WatchStateStore();
    await engineOver(events, store, judge).run();

    expect(evidence).toMatchObject({
      docId: DOC,
      documentType: "email",
      title: "Your quote for the roof",
      semanticTime: "2026-03-01T09:00:00Z",
    });
    expect(documentRevision).toBe("revision-1");
    const people = evidence?.["people"] as { role: string; isSelf: boolean }[];
    expect(people).toHaveLength(32);
    expect(people.slice(0, 2)).toEqual([
      { role: "sender", isSelf: false },
      { role: "recipient", isSelf: true },
    ]);
    expect(people.filter((person) => person.role === "sender")).toHaveLength(1);
    expect(people.every((person) => !("personId" in person))).toBe(true);
    store.close();
  });

  it("is never made while a write transaction is open", async () => {
    // The property the whole retry arrangement exists for. A host writing this
    // file from a second task on the same thread does not wait politely for a
    // transaction held across a network call — it blocks the event loop inside
    // SQLite's busy handler until the model answers or the timeout expires.
    const store = new WatchStateStore();
    const openWhenAsked: boolean[] = [];

    const judge: JudgeProvider = {
      judge: () => {
        openWhenAsked.push(store.open);
        return { fired: true, output: {} };
      },
    };
    const recall: RecallScorer = {
      score: () => {
        openWhenAsked.push(store.open);
        return 1;
      },
    };

    await engineOver(documentAndIndex("2026-03-01T09:00:00Z"), store, judge, recall).run();

    expect(openWhenAsked.length, "no provider was consulted at all").toBeGreaterThan(0);
    expect(
      openWhenAsked,
      "a provider was called with the state store mid-transaction",
    ).not.toContain(true);
    store.close();
  });

  it("that throws pauses the watch rather than taking the run down", async () => {
    // Fetching happens outside the guard that contains an ordinary node
    // failure, so the containment has to be repeated there. Without it one
    // judge backend having a bad afternoon ends the whole evaluation pass.
    const store = new WatchStateStore();
    const judge: JudgeProvider = {
      judge: () => {
        throw new Error("judge backend unavailable");
      },
    };

    const trace = await engineOver(documentAndIndex("2026-03-01T09:00:00Z"), store, judge).run();

    const failed = trace.records.filter((record) => record.transition === "failed");
    expect(failed, "a broken judge did not register as a failure").toHaveLength(1);
    expect(failed[0]?.nodeId, "the outage was blamed on the watch, not the node").toBe("mail");
    expect(store.isActive("quotes"), "a failed watch kept running").toBe(false);
    store.close();
  });
});

describe("a nomination the budget could not afford", () => {
  /** A judge that defers its first N calls and then answers for real. */
  function deferringJudge(defersFirst: number): JudgeProvider & { calls: number } {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      judge: (): JudgeVerdict => {
        calls += 1;
        return calls <= defersFirst
          ? { fired: false, output: {}, unanswered: BUDGET_SPENT }
          : { fired: true, output: { because: "it is a quote" } };
      },
    };
  }

  it("is parked rather than spent, and says so", async () => {
    const store = new WatchStateStore();
    const judge = deferringJudge(1);

    const trace = await engineOver(documentAndIndex("2026-03-01T09:00:00Z"), store, judge).run();

    expect(trace.firings, "a deferred nomination fired anyway").toHaveLength(0);
    expect(store.pendingCount("quotes"), "the nomination was dropped instead of parked").toBe(1);
    // The distinction the shadow period is measuring. "judge declined" here
    // would report the budget as a precision judgement.
    const held = trace.records.find((record) => record.transition === "held");
    expect(held?.detail).toContain("budget");
    store.close();
  });

  it("leaves no look behind, so it can still be judged later", async () => {
    // The look is what says a node has considered a document. Recording it for
    // a nomination nobody judged would retire the question unanswered.
    const store = new WatchStateStore();
    await engineOver(documentAndIndex("2026-03-01T09:00:00Z"), store, deferringJudge(1)).run();

    expect(
      store.lookedOn("quotes", "mail", DOC),
      "a parked document was recorded as already considered",
    ).toBeNull();
    store.close();
  });

  it("fires on a later run, once the budget is back", async () => {
    const store = new WatchStateStore();
    const judge = deferringJudge(1);
    const journal = documentAndIndex("2026-03-01T09:00:00Z");

    await engineOver(journal, store, judge).run();
    // The second run reads no new events at all: the cursor is past both. What
    // it has is the parked nomination, and draining that is its only work.
    const second = await engineOver([], store, judge, NEVER_RECALLED, journal).run();

    expect(second.firings, "the parked nomination was never reconsidered").toHaveLength(1);
    expect(second.firings[0]?.payload).toEqual({ doc_id: DOC });
    expect(store.pendingCount("quotes"), "the queue kept a nomination it had drained").toBe(0);
    store.close();
  });

  it("does not retry the oldest nomination before its durable retry time", async () => {
    const store = new WatchStateStore();
    const journal = documentAndIndex("2026-03-01T09:00:00Z");
    const retryAt = Date.parse("2026-03-01T09:01:00Z");
    let calls = 0;
    const judge: JudgeProvider = {
      judge: () => {
        calls += 1;
        return calls === 1
          ? {
              fired: false,
              output: {},
              unanswered: { ...BUDGET_SPENT, retryAtMs: retryAt },
            }
          : { fired: true, output: {} };
      },
    };

    await engineOver(journal, store, judge, NEVER_RECALLED, journal).run();
    expect(store.pendingNominations("quotes", 1)[0]?.retryAtMs).toBe(retryAt);

    await engineOver([], store, judge, NEVER_RECALLED, journal, retryAt - 1).run();
    expect(calls, "the nomination retried during its cooldown").toBe(1);

    const due = await engineOver([], store, judge, NEVER_RECALLED, journal, retryAt).run();
    expect(calls).toBe(2);
    expect(due.firings).toHaveLength(1);
    store.close();
  });

  it("stamps what it fires with when the journal saw it, not the document's date", async () => {
    // Why the firing keeps two times at all. The drain runs on a later pass,
    // and the only clock the firing itself carries is the document's own — so
    // a watch that spoke this afternoon about a document dated three years ago
    // is read, everywhere the ledger is read, as a watch that last spoke three
    // years ago. The instant the journal saw the nomination has to survive the
    // park, because by the time the queue drains that event is long gone.
    const semanticTime = "2023-06-04T09:00:00.000Z";
    const noticed = "2026-03-01T09:00:00.000Z";
    const store = new WatchStateStore();
    const judge = deferringJudge(1);
    const journal = documentAndIndex(semanticTime, noticed);

    await engineOver(journal, store, judge).run();
    const second = await engineOver([], store, judge, NEVER_RECALLED, journal).run();
    expect(second.firings, "the parked nomination was never reconsidered").toHaveLength(1);

    const [firing] = store.firings("quotes");
    expect(firing?.firedAt, "the subject's own time was not preserved").toBe(semanticTime);
    expect(firing?.noticedAt, "the drained firing kept no record of when it spoke").toBe(noticed);
    store.close();
  });

  it("says which kind of nothing the judge came back with", async () => {
    // The class, not just the sentence. A reader counting how often a watch
    // was quiet because a model was missing cannot pattern-match prose, and a
    // status note is only allowed to carry a category the runtime chose.
    const store = new WatchStateStore();
    const judge: JudgeProvider = {
      judge: (): JudgeVerdict => ({
        fired: false,
        output: {},
        unanswered: { failure: "provider", reason: "no usable watch-judge model is assigned" },
      }),
    };

    const trace = await engineOver(documentAndIndex("2026-03-01T09:00:00Z"), store, judge).run();

    const held = trace.records.find((record) => record.transition === "held");
    expect(held?.failure, "an outage was recorded as an ordinary hold").toBe("provider");
    expect(held?.detail).toContain("no usable watch-judge model is assigned");
    // Held, not failed: a model that is missing is not a defect in the watch,
    // and pausing every watch on it would make one misconfiguration into an
    // afternoon of resuming them by hand.
    expect(trace.records.some((record) => record.transition === "failed")).toBe(false);
    expect(store.isActive("quotes"), "a provider outage deactivated the watch").toBe(true);
    // The document is still owed an answer, so it is parked rather than
    // retired as considered.
    expect(store.pendingCount("quotes")).toBe(1);
    expect(store.lookedOn("quotes", "mail", DOC)).toBeNull();
    store.close();
  });

  it("keeps the judge's own sentence when it did decide", async () => {
    // The one account of why this watch stayed quiet on a document the
    // operator can see it looked at. A constant in its place leaves "it
    // decided against all of these" and "it decided against this one, and
    // here is why" reading identically.
    const store = new WatchStateStore();
    const judge: JudgeProvider = {
      judge: (): JudgeVerdict => ({
        fired: false,
        output: { because: "the quote is for a neighbouring address" },
      }),
    };

    const trace = await engineOver(documentAndIndex("2026-03-01T09:00:00Z"), store, judge).run();

    const held = trace.records.find((record) => record.transition === "held");
    expect(held?.detail).toBe("judge declined: the quote is for a neighbouring address");
    expect(held?.failure, "a judgement was classified as a failure").toBeUndefined();
    // Decided, so the document is spent: no parked nomination, and the look is
    // recorded so the same document is never paid for twice.
    expect(store.pendingCount("quotes")).toBe(0);
    expect(store.lookedOn("quotes", "mail", DOC)).not.toBeNull();
    store.close();
  });

  it("cannot be told to park by the model it is judging", async () => {
    // `output` is whatever the model wrote — a node's declared fields pass
    // through it verbatim. A model that could set the parking marker there
    // would keep its own document from ever being recorded as considered, and
    // have the runtime ask about it again on every pass, for free.
    const store = new WatchStateStore();
    const judge: JudgeProvider = {
      judge: (): JudgeVerdict => ({
        fired: false,
        output: { deferred: true, unanswered: { failure: "budget", reason: "spent" } },
      }),
    };

    const trace = await engineOver(documentAndIndex("2026-03-01T09:00:00Z"), store, judge).run();

    expect(store.pendingCount("quotes"), "a model parked its own document").toBe(0);
    expect(
      store.lookedOn("quotes", "mail", DOC),
      "a model kept its document from being recorded as considered",
    ).not.toBeNull();
    const held = trace.records.find((record) => record.transition === "held");
    expect(held?.failure, "a model classified its own decline as a failure").toBeUndefined();
    store.close();
  });

  it("is judged once, not once per attempt", async () => {
    // A parked nomination that re-asked on every pass would spend the budget it
    // was parked for want of.
    const store = new WatchStateStore();
    const judge = deferringJudge(1);
    const journal = documentAndIndex("2026-03-01T09:00:00Z");

    await engineOver(journal, store, judge).run();
    await engineOver([], store, judge, NEVER_RECALLED, journal).run();
    await engineOver([], store, judge, NEVER_RECALLED, journal).run();

    expect(judge.calls, "the judge was asked again after it had answered").toBe(2);
    store.close();
  });
});

describe("an event that had to be retried", () => {
  it("records its transitions once, not once per attempt", async () => {
    // Each abandoned attempt runs the event's local work and rolls it back. A
    // trace that kept those records would show a reader the runtime doing the
    // work twice and firing twice.
    const store = new WatchStateStore();
    const judge: JudgeProvider = { judge: () => ({ fired: true, output: {} }) };
    const recall: RecallScorer = { score: () => 1 };

    // Two providers, so this event needs two separate fetches and therefore two
    // retries before it can be applied.
    const trace = await engineOver(
      documentAndIndex("2026-03-01T09:00:00Z"),
      store,
      judge,
      recall,
    ).run();

    expect(trace.firings, "the retried event fired more than once").toHaveLength(1);
    const fired = trace.records.filter(
      (record) => record.nodeId === "mail" && record.transition === "fired",
    );
    expect(fired, "an abandoned attempt left its records in the trace").toHaveLength(1);
    store.close();
  });
});

describe("a pass that had to go off the host", () => {
  /**
   * Two nominating nodes over one document: the first is refused by its own
   * lexical arm and records `ignored` immediately, the second nominates and
   * reaches the judge. So the abandoned attempt has already written to the
   * trace by the time it discovers what it has to fetch — which is the only
   * arrangement in which rewinding it is observable.
   */
  function twoNodeWatch(): Record<string, unknown> {
    const watch = semanticWatch();
    (watch.nodes as Record<string, unknown>[]).unshift({
      id: "never",
      type: "source.document_event",
      filter: { source: "gmail", event: ["created"], documentType: "email" },
      recall: { lexical: { terms: ["invoice"] } },
      judge: { proposition: "never asked", output_schema: { because: "string" } },
      output_map: { doc_id: "$e.docId" },
    });
    return watch;
  }

  function engineWith(
    watch: Record<string, unknown>,
    store: WatchStateStore,
    judge: JudgeProvider,
    journal: JournalEvent[],
  ): WatchEngine {
    return new WatchEngine({
      watch: watch as never,
      ontology,
      journal,
      analytics: { query: () => Promise.resolve({ rows: [], columns: [] }) },
      judge,
      recall: NEVER_RECALLED,
      store,
      lookupDocument: (docId, atSeq) => {
        for (const event of [...journal].reverse()) {
          if (event.kind !== "doc.event" || event.seq > atSeq) continue;
          if (event.payload.docId !== docId) continue;
          return { event: event.payload, seq: event.seq };
        }
        return null;
      },
    });
  }

  it("does not keep the records the abandoned attempt wrote", async () => {
    const store = new WatchStateStore();
    const trace = await engineWith(
      twoNodeWatch(),
      store,
      { judge: () => ({ fired: true, output: {} }) },
      documentAndIndex("2026-03-01T09:00:00Z"),
    ).run();

    // The `ignored` from the node that declined is written on every attempt.
    // Without a rewind the retried attempt leaves a second copy, and a reader
    // sees the runtime having considered the document twice.
    const ignored = trace.records.filter((record) => record.transition === "ignored");
    expect(ignored, "an abandoned attempt left its records behind").toHaveLength(1);
    expect(trace.firings).toHaveLength(1);
    store.close();
  });

  it("fetches everything one pass needs, however many that is", async () => {
    // The cost of an event is how deeply its questions nest, not how many of
    // them there are. Counting questions meant an hourly watch catching up
    // after an outage, or a judged node behind a broadcast arm, exhausted the
    // budget and paused itself permanently.
    const store = new WatchStateStore();
    const rounds: number[] = [];
    let asked = 0;
    const judge: JudgeProvider = {
      judge: () => {
        asked += 1;
        return { fired: false, output: {} };
      },
    };

    // Both nodes ask about the same document in the same pass.
    const watch = twoNodeWatch();
    (watch.nodes as Record<string, unknown>[])[0]!.recall = { lexical: { terms: ["quote"] } };
    await engineWith(watch, store, judge, documentAndIndex("2026-03-01T09:00:00Z")).run();

    expect(asked, "both nodes should have reached the judge").toBe(2);
    expect(rounds.length).toBe(0);
    store.close();
  });
});

describe("the parked queue", () => {
  /** Two documents, each with its index, so two nominations can be parked. */
  function twoDocuments(): JournalEvent[] {
    const second = "d1e2f3a4-0000-4000-8000-000000000002";
    return [
      ...documentAndIndex("2026-03-01T09:00:00Z"),
      {
        seq: 3,
        kind: "doc.event",
        occurredAt: "2026-03-01T10:00:00Z",
        observedAt: "2026-03-01T10:00:00Z",
        payload: {
          op: "created",
          docId: second,
          sourceId: "gmail",
          providerId: "google",
          documentType: "email",
          title: "Second quote, for the windows",
          semanticTime: "2026-03-01T10:00:00Z",
          changedFields: [],
          contentChanged: false,
          metadata: {},
          people: [],
        },
      },
      {
        seq: 4,
        kind: "doc.indexed",
        occurredAt: "2026-03-01T10:00:00Z",
        observedAt: "2026-03-01T10:00:00Z",
        payload: { docId: second, eventIndexedAt: "2026-03-01T10:00:00Z" },
      },
    ] as JournalEvent[];
  }

  it("stops at the first nomination it still cannot afford", async () => {
    // Order is the only fairness the queue has. A drain that skipped past the
    // one it could not afford would serve whichever document happened to be
    // cheap and starve what was parked when the budget ran out.
    const store = new WatchStateStore();
    const journal = twoDocuments();
    const deferAll: JudgeProvider = {
      judge: () => ({ fired: false, output: {}, unanswered: BUDGET_SPENT }),
    };
    await engineOver(journal, store, deferAll).run();
    expect(store.pendingCount("quotes"), "both nominations should be parked").toBe(2);

    // Now the budget affords exactly nothing for the older one and everything
    // for the newer: a drain that respects the order gets neither.
    const judged: string[] = [];
    const stubborn: JudgeProvider = {
      judge: (request) => {
        const docId = (request.evidence as { docId: string }).docId;
        judged.push(docId);
        return docId === DOC
          ? { fired: false, output: {}, unanswered: BUDGET_SPENT }
          : { fired: true, output: {} };
      },
    };
    const after = await engineOver([], store, stubborn, NEVER_RECALLED, journal).run();

    expect(judged, "the drain reached past a nomination it could not afford").toEqual([DOC]);
    expect(after.firings, "a later nomination jumped the queue").toHaveLength(0);
    expect(store.pendingCount("quotes")).toBe(2);
    store.close();
  });

  it("survives a run that holds its journal in memory", async () => {
    // A replay engine has no queryable journal — it is handed its events. The
    // drain runs before those events are walked, so the memo is empty exactly
    // when the queue needs it, and a drain that read the memo alone would find
    // nothing and discard the whole queue on every run.
    const store = new WatchStateStore();
    const journal = documentAndIndex("2026-03-01T09:00:00Z");
    const defersOnce = (() => {
      let calls = 0;
      return {
        judge: () => {
          calls += 1;
          return calls === 1
            ? { fired: false, output: {}, unanswered: BUDGET_SPENT }
            : { fired: true, output: {} };
        },
      } satisfies JudgeProvider;
    })();

    const memoEngine = (events: JournalEvent[]): WatchEngine =>
      new WatchEngine({
        watch: semanticWatch() as never,
        ontology,
        journal: events,
        analytics: { query: () => Promise.resolve({ rows: [], columns: [] }) },
        judge: defersOnce,
        recall: NEVER_RECALLED,
        store,
      });

    await memoEngine(journal).run();
    expect(store.pendingCount("quotes"), "nothing was parked").toBe(1);

    // The same journal again: the cursor is past both events, so the only work
    // is the parked nomination.
    const second = await memoEngine(journal).run();
    expect(second.firings, "the queue was unreachable and stayed parked").toHaveLength(1);
    expect(store.pendingCount("quotes")).toBe(0);
    store.close();
  });

  it("is cleared when the live path settles the same document first", async () => {
    // A parked nomination the live path has since judged is answered. Leaving
    // it lets the drain judge that revision again on a later pass — a second
    // paid judgement and a second firing, which the firings table does not
    // deduplicate because the two carry different sequence numbers.
    const store = new WatchStateStore();
    const journal = documentAndIndex("2026-03-01T09:00:00Z");
    // Park it.
    await engineOver(journal, store, {
      judge: () => ({ fired: false, output: {}, unanswered: BUDGET_SPENT }),
    }).run();
    expect(store.pendingCount("quotes")).toBe(1);

    // A second index over the same document, which the live path now judges.
    const reindexed: JournalEvent[] = [
      ...journal,
      {
        seq: 3,
        kind: "doc.indexed",
        occurredAt: "2026-03-01T11:00:00Z",
        observedAt: "2026-03-01T11:00:00Z",
        payload: { docId: DOC, eventIndexedAt: "2026-03-01T11:00:00Z" },
      },
    ] as JournalEvent[];

    let judged = 0;
    const willing: JudgeProvider = {
      judge: () => {
        judged += 1;
        return { fired: true, output: {} };
      },
    };
    await engineOver(reindexed, store, willing, NEVER_RECALLED, reindexed).run();

    expect(
      store.pendingCount("quotes"),
      "the queue kept a nomination the live path had answered",
    ).toBe(0);
    const total = store.firings("quotes");
    expect(total, "one revision was reported twice").toHaveLength(1);
    expect(judged, "one revision was judged twice").toBe(1);
    store.close();
  });
});
