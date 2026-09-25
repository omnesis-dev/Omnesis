// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The arrangement a live host needs, and why it differs from a fixture's.
 *
 * A fixture universe hands the engine a journal and an empty analytics
 * database, and the engine builds the second out of the first as it walks — so
 * a SQL node at event 40 cannot see a row that arrives at event 900. A live
 * gateway is the other way round: the analytics store already holds every row,
 * because the journal is *downstream* of the writes that produced it.
 *
 * Two consequences, and both are load-bearing. The engine must not write rows
 * into a store that already has them, and it must not rebuild its memory by
 * replaying a journal that never ends. Both are declared by what the host
 * supplies rather than by a flag: a store with no `applyRow` is a store that
 * owns its own rows, and a `lookupDocument` is a journal that can be asked
 * rather than remembered.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { watchDslSchema } from "../dsl/schema.js";
import { AnalyticsDatabase } from "../universe/analytics.js";
import { analyticsDir, loadOntology } from "../universe/paths.js";
import { WatchEngine, type AnalyticsPort, type JournalDocument } from "./engine.js";
import { ScriptedJudge, ScriptedRecall } from "./providers.js";
import { WatchStateStore } from "./state.js";
import type { JournalEvent } from "../journal/event.js";

const ontology = loadOntology();
const DOC = "d0c00000-0000-4000-8000-00000000f00d";
const SELF = "0a1b2c3d-0000-4000-8000-000000000001";

let dir: string;
let analytics: AnalyticsDatabase;

function at(day: number, hour = 9): string {
  return new Date(Date.UTC(2026, 2, day, hour)).toISOString();
}

function docEvent(seq: number, day: number, contentChanged: boolean): JournalEvent {
  return {
    seq,
    kind: "doc.event",
    occurredAt: at(day),
    observedAt: at(day),
    payload: {
      op: seq === 1 ? "created" : "updated",
      docId: DOC,
      sourceId: "gmail",
      providerId: "google",
      documentType: "email",
      title: "Spring works — quote",
      semanticTime: at(day),
      changedFields: contentChanged ? ["contentHash"] : ["metadata"],
      contentChanged,
      metadata: { extra: { threadId: "t-hosted" } },
      people: [{ personId: SELF, role: "recipient", isSelf: true }],
    },
  };
}

function indexed(seq: number, day: number, hour: number): JournalEvent {
  return {
    seq,
    kind: "doc.indexed",
    occurredAt: at(day, hour),
    observedAt: at(day, hour),
    payload: { docId: DOC, eventIndexedAt: at(day, hour) },
  };
}

/** A watch that nominates on every index its recall arm accepts. */
const NOMINATING = {
  watch: {
    name: "hosted-quotes",
    firing_policy: "stays_active",
    ontology_fingerprint: ontology.fingerprint,
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: { source: "gmail", event: ["created", "updated"], documentType: "email" },
        recall: { semantic: { query: "a quote for building work", threshold: 0.3 } },
        judge: {
          proposition: "This is a quote for building work.",
          output_schema: { decision: "bool" },
        },
        output_map: { doc_id: "$e.docId" },
      },
    ],
    sink: { input: "mail", output_map: { doc_id: "$n.mail.doc_id" } },
  },
};

/**
 * The store as a live host supplies it: it answers queries and has no way to be
 * written to, because it is not the engine's to write.
 */
function beside(db: AnalyticsDatabase): AnalyticsPort {
  return { query: (sql, values) => db.query(sql, values) };
}

/** A judge that accepts whatever reaches it, so the trace counts nominations. */
function accepting(): ScriptedJudge {
  return new ScriptedJudge({ judgements: [], fallback: { fired: true, output: {} } });
}

/**
 * The journal as a live host supplies it: queryable, not remembered.
 *
 * Bounded by the sequence being evaluated, because a host catching up after a
 * restart is walking a backlog — an unbounded lookup would hand it a revision
 * that had not happened yet at the event in hand.
 */
function lookupIn(journal: readonly JournalEvent[]) {
  return (docId: string, atSeq: number): JournalDocument | null => {
    for (let i = journal.length - 1; i >= 0; i -= 1) {
      const event = journal[i]!;
      if (event.seq > atSeq) continue;
      if (event.kind === "doc.event" && event.payload.docId === docId) {
        return { event: event.payload, seq: event.seq };
      }
    }
    return null;
  };
}

async function runHosted(
  journal: readonly JournalEvent[],
  store: WatchStateStore,
): Promise<number> {
  const trace = await new WatchEngine({
    watch: watchDslSchema.parse(NOMINATING).watch,
    ontology,
    journal,
    analytics: beside(analytics),
    lookupDocument: lookupIn(journal),
    store,
    // Every nomination is accepted, so what the trace counts is nominations.
    judge: accepting(),
    recall: new ScriptedRecall([], 1),
  }).run();
  return trace.firings.length;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-wv2-hosted-"));
  analytics = await AnalyticsDatabase.materialize(ontology, analyticsDir(), "projections");
});

afterEach(() => {
  analytics.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a store that lives beside the journal", () => {
  it("is never written to by the engine", async () => {
    // The gateway's analytics database is the source the journal was made
    // from. An engine that wrote rows back into it would be editing the corpus
    // it is supposed to be watching.
    let writes = 0;
    const counting: AnalyticsPort = {
      query: (sql, values) => analytics.query(sql, values),
      applyRow: async () => {
        writes += 1;
      },
    };
    const row: JournalEvent = {
      seq: 1,
      kind: "analytics.row",
      occurredAt: at(1),
      observedAt: at(1),
      payload: {
        op: "inserted",
        table: "plaid_transactions",
        sourceId: "plaid",
        pk: { id: "t-1" },
        row: {
          id: "t-1",
          account_id: "a",
          date: "2026-03-01",
          amount: 5,
          currency: "GBP",
          merchant_name: "Stellar Sound",
          category: "x",
          pending: false,
        },
      },
    };
    const store = new WatchStateStore(join(dir, "with.db"));
    try {
      // With `applyRow`, the engine builds the store as it walks.
      await new WatchEngine({
        watch: watchDslSchema.parse(NOMINATING).watch,
        ontology,
        journal: [row],
        analytics: counting,
        store,
        judge: accepting(),
        recall: new ScriptedRecall([], 0),
      }).run();
      expect(writes, "a store that builds from the journal was not written to").toBe(1);
    } finally {
      store.close();
    }

    // Without it, the same event writes nothing at all.
    const bare = new WatchStateStore(join(dir, "without.db"));
    try {
      await runHosted([row], bare);
      expect(writes, "the engine wrote into a store it does not own").toBe(1);
    } finally {
      bare.close();
    }
  });
});

describe("a journal that can be asked rather than remembered", () => {
  const LIFE: JournalEvent[] = [
    docEvent(1, 1, true),
    indexed(2, 1, 10),
    indexed(3, 1, 14),
    indexed(4, 2, 3),
  ];

  it("still nominates a document exactly once per episode", async () => {
    const store = new WatchStateStore(join(dir, "once.db"));
    try {
      expect(await runHosted(LIFE, store), "a re-indexed document spoke twice").toBe(1);
    } finally {
      store.close();
    }
  });

  it("speaks again only when the document's content moves", async () => {
    const store = new WatchStateStore(join(dir, "moved.db"));
    try {
      const withRevision = [...LIFE, docEvent(5, 3, true), indexed(6, 3, 10)];
      expect(
        await runHosted(withRevision, store),
        "a revision was not heard, or the re-indexes before it were",
      ).toBe(2);
    } finally {
      store.close();
    }
  });

  it("does not evaluate an index against a revision that has not happened yet", async () => {
    // A host catching up walks a backlog, so the journal it can see extends
    // past the event it is evaluating. Reading the newest revision of a
    // document at an index event from before that revision would make a watch's
    // decision depend on how far behind it was.
    const store = new WatchStateStore(join(dir, "future.db"));
    try {
      // The index at seq 2 belongs to the original document. The revision at
      // seq 3 is the future, and its own index at seq 4 is what should be
      // heard second.
      const backlog = [
        docEvent(1, 1, true),
        indexed(2, 1, 10),
        docEvent(3, 2, true),
        indexed(4, 2, 10),
      ];
      expect(await runHosted(backlog, store)).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("a host that restarts", () => {
  const LIFE: JournalEvent[] = [
    docEvent(1, 1, true),
    indexed(2, 1, 10),
    indexed(3, 1, 14),
    docEvent(4, 2, false),
    indexed(5, 2, 10),
  ];

  it("resumes from its cursor without being handed the events it already read", async () => {
    // The whole point of the persisted look. A live consumer cannot replay its
    // journal to remember what it has nominated — the journal does not end —
    // so what it remembered has to survive on disk.
    const path = join(dir, "resume.db");
    const first = new WatchStateStore(path);
    let before: number;
    try {
      before = await runHosted(LIFE.slice(0, 3), first);
    } finally {
      first.close();
    }
    expect(before, "the first pass never nominated").toBe(1);

    // The restart is handed ONLY what it has not seen, which is what a cursor
    // over a growing journal produces.
    const second = new WatchStateStore(path);
    try {
      const after = await runHosted(LIFE.slice(3), second);
      expect(after, "the resumed host nominated again a document it had already spoken about").toBe(
        0,
      );
    } finally {
      second.close();
    }
  });

  it("agrees with a host that never restarted", async () => {
    const continuous = new WatchStateStore(join(dir, "continuous.db"));
    let whole: number;
    try {
      whole = await runHosted(LIFE, continuous);
    } finally {
      continuous.close();
    }

    const path = join(dir, "split.db");
    let split = 0;
    for (const slice of [LIFE.slice(0, 2), LIFE.slice(2, 4), LIFE.slice(4)]) {
      const store = new WatchStateStore(path);
      try {
        split += await runHosted(slice, store);
      } finally {
        store.close();
      }
    }
    expect(split, "restarting changed what the watch said").toBe(whole);
  });
});
