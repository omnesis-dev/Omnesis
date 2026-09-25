// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Trying a candidate before storing it.
 *
 * The properties worth pinning are the ones that make the answer trustworthy
 * rather than merely present: that it runs the *real* engine over the *real*
 * journal, so it cannot disagree with what the install would do; that it
 * leaves nothing behind; that it asks no model; and that it distinguishes
 * "nothing to evaluate" from "this catches nothing", which is the one pair a
 * pre-flight exists to tell apart and the one a single zero would conflate.
 *
 * Driven over a real journal store and a real ontology, because a stubbed
 * substrate would be testing the summariser rather than the answer.
 *
 * Fixture data is invented — no corpus content.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { Ontology, type AnalyticsPort } from "@omnesis/watch";
import { runSchemaSetup } from "../data/schema.js";
import { buildOntologySnapshot } from "./ontology.js";
import { preflight } from "./preflight.js";
import { WatchJournalStore } from "./store.js";
import type { Db } from "../data/types.js";
import type { NewJournalEvent } from "./store.js";

const ALICE = "b3f2a9d4-0000-4000-8000-000000000002";
const SELF = "0a1b2c3d-0000-4000-8000-000000000001";

let dir: string;
let db: Db;
let journal: WatchJournalStore;

function at(day: number): string {
  return new Date(Date.UTC(2026, 2, day, 9)).toISOString();
}

function mail(day: number, docId: string, title: string, from = ALICE): NewJournalEvent {
  return {
    kind: "doc.event",
    occurredAt: at(day),
    observedAt: at(day),
    payload: {
      op: "created",
      docId,
      sourceId: "gmail",
      providerId: "google",
      documentType: "email",
      title,
      semanticTime: at(day),
      changedFields: [],
      contentChanged: true,
      metadata: { extra: {} },
      people: [
        { personId: from, role: "sender", isSelf: false },
        { personId: SELF, role: "recipient", isSelf: true },
      ],
    },
  };
}

/** A candidate that takes every email Alice sends. Procedural — no judge. */
function fromAlice(fingerprint: string, person = ALICE): unknown {
  return {
    name: "alice-writes",
    firing_policy: "stays_active",
    ontology_fingerprint: fingerprint,
    nodes: [
      {
        id: "mail",
        type: "source.document_event",
        filter: {
          source: "gmail",
          event: ["created"],
          documentType: "email",
          people: [{ role: "sender", person }],
        },
        output_map: { doc_id: "$e.docId" },
      },
    ],
    sink: { input: "mail", output_map: { doc_id: "$n.mail.doc_id" } },
  };
}

const NO_ANALYTICS: AnalyticsPort = {
  query: () => Promise.resolve({ rows: [], columns: [] } as never),
};

function deps(overrides: { canScore?: boolean; now?: () => number } = {}) {
  return {
    journal: {
      head: () => journal.head(),
      read: (afterSeq: number, limit: number) => journal.read(afterSeq, limit),
      documentAt: (docId: string, atSeq: number) => journal.documentAt(docId, atSeq),
      firstSeqAtOrAfter: (iso: string) => journal.firstSeqAtOrAfter(iso),
    },
    now: overrides.now ?? (() => Date.UTC(2026, 2, 20, 9)),
    ontology: async () =>
      Ontology.parse(
        await buildOntologySnapshot({ db, analyticsDb: null, semanticallyIndexed: () => true }),
      ),
    analytics: () => NO_ANALYTICS,
    recall: { score: () => 0 },
    canScore: () => overrides.canScore ?? true,
  };
}

async function fingerprint(): Promise<string> {
  return (await buildOntologySnapshot({ db, analyticsDb: null, semanticallyIndexed: () => true }))
    .fingerprint;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-preflight-"));
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
  db.prepare(
    `INSERT INTO source_document_profiles (source_type, profile_json, published_at)
     VALUES ('gmail', ?, 0)`,
  ).run(
    JSON.stringify({
      documentTypes: ["email"],
      personRoles: ["sender", "recipient"],
      metadataFields: [],
    }),
  );
  for (const [id, name, self] of [
    [ALICE, "Maya Reeves", 0],
    [SELF, "Self", 1],
  ] as const) {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, 'test', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(id, name, self);
  }
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
                            metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES ('11111111-2222-4333-8444-555555555555', 'google', 'gmail', 'seed', 'seed', '', 'h',
             '{}', ?, ?, ?, ?)`,
  ).run(at(1), at(1), at(1), at(1));
  journal = WatchJournalStore.open(join(dir, "watch.db"), null);
});

afterEach(() => {
  journal.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("trying a candidate against the recent past", () => {
  it("says how many events reached each node and how many it took up", async () => {
    // The whole question: a filter that admits nothing and a quiet week look
    // the same from a stored watch, and this is what separates them.
    journal.commit({
      events: [
        mail(1, "d0000000-0000-4000-8000-000000000001", "one"),
        mail(2, "d0000000-0000-4000-8000-000000000002", "two"),
      ],
    });

    const result = await preflight(deps(), fromAlice(await fingerprint()) as never);

    expect(result.outcome).toBe("probed");
    if (result.outcome !== "probed") return;
    expect(result.report.window.events).toBe(2);
    const node = result.report.nodes[0];
    expect(node?.nodeId).toBe("mail");
    expect(node?.evaluated).toBe(2);
    expect(node?.matched, "the candidate took up neither email").toBe(2);
    expect(result.report.firings).toBe(2);
  });

  it("reports a filter that admits nothing as nothing, against a window that was not empty", async () => {
    // The failure this exists to catch. Both numbers matter: zero of two says
    // the condition is wrong, zero of zero says nobody has looked yet.
    journal.commit({ events: [mail(1, "d0000000-0000-4000-8000-000000000001", "one")] });
    const nobody = "c0000000-0000-4000-8000-00000000dead";
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'Jamie Lopez', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(nobody);

    const result = await preflight(deps(), fromAlice(await fingerprint(), nobody) as never);

    expect(result.outcome).toBe("probed");
    if (result.outcome !== "probed") return;
    expect(result.report.window.events, "nothing was replayed, which is a different answer").toBe(
      1,
    );
    expect(result.report.nodes[0]?.matched).toBe(0);
    expect(result.report.firings).toBe(0);
  });

  it("leaves nothing behind — no cursor, no firing, no state", async () => {
    // A pre-flight that moved a cursor would consume the events it was asked
    // about, and the watch installed afterwards would never see them.
    journal.commit({ events: [mail(1, "d0000000-0000-4000-8000-000000000001", "one")] });
    const before = journal.head();

    await preflight(deps(), fromAlice(await fingerprint()) as never);

    expect(journal.head(), "the probe consumed the journal").toBe(before);
    // Where a real watch's state actually lives: the journal database, beside
    // the events. The engine builds its own in-memory store when none is
    // handed to it, so nothing should have appeared there at all.
    const state = new Database(join(dir, "watch.db"));
    try {
      const rows = state
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('watch_firings','consumer_cursor')",
        )
        .all() as unknown[];
      expect(rows, "the probe wrote runtime state").toEqual([]);
    } finally {
      state.close();
    }
  });

  it("refuses rather than answering when it cannot score", async () => {
    // `LiveRecall` answers 0 with no embedder, so every document would look far
    // below every threshold. A confident wrong answer is worse than none for a
    // diagnostic.
    journal.commit({ events: [mail(1, "d0000000-0000-4000-8000-000000000001", "one")] });
    const semantic = fromAlice(await fingerprint()) as { nodes: Array<Record<string, unknown>> };
    semantic.nodes[0]!.recall = { semantic: { query: "a parcel shipped", threshold: 0.4 } };

    const result = await preflight(deps({ canScore: false }), semantic as never);

    expect(result).toEqual({ outcome: "refused", refusal: { reason: "cannot-score" } });
  });

  it("separates an empty journal from a condition that catches nothing", async () => {
    // A fresh install's journal starts at the newest document rather than
    // replaying the corpus, so "nothing has happened yet" is a real state — and
    // it must not be reported as a verdict on the condition.
    const result = await preflight(deps(), fromAlice(await fingerprint()) as never);

    expect(result).toEqual({ outcome: "refused", refusal: { reason: "empty-journal" } });
  });

  it("refuses a candidate this install's ontology does not admit", async () => {
    // The same check the store does, for the same reason: a candidate that
    // does not hold cannot be evaluated, and the diagnostics say more than any
    // number would.
    journal.commit({ events: [mail(1, "d0000000-0000-4000-8000-000000000001", "one")] });
    const drifted = fromAlice("a-fingerprint-from-another-install") as { nodes: unknown[] };

    const result = await preflight(deps(), drifted as never);

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("invalid");
  });

  it("bounds the window it replays", async () => {
    journal.commit({
      events: Array.from({ length: 6 }, (_, i) =>
        mail(1, `d0000000-0000-4000-8000-00000000000${i}`, `mail ${i}`),
      ),
    });

    const result = await preflight(deps(), fromAlice(await fingerprint()) as never, { events: 3 });

    expect(result.outcome).toBe("probed");
    if (result.outcome !== "probed") return;
    expect(result.report.window.events).toBe(3);
  });
});

describe("a candidate that cannot run", () => {
  it("is reported as broken, not as catching nothing", async () => {
    // The worst answer a diagnostic can give. The engine contains a node
    // failure and pauses rather than throwing, so a candidate whose query will
    // not run comes back looking merely quiet — indistinguishable from one
    // whose condition is simply never met.
    journal.commit({ events: [mail(1, "d0000000-0000-4000-8000-000000000001", "one")] });
    const broken = {
      name: "broken-query",
      firing_policy: "stays_active",
      ontology_fingerprint: await fingerprint(),
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
    };

    // The analytics surface as an install with none has it — the shape the
    // production port takes when no analytics database is configured.
    const noAnalytics = {
      ...deps(),
      analytics: () => ({
        query: () => Promise.reject(new Error("no analytics database is configured")),
      }),
    };

    const result = await preflight(noAnalytics as never, broken as never);

    expect(result.outcome).toBe("probed");
    if (result.outcome !== "probed") return;
    expect(result.report.failed, "a broken candidate read as a quiet one").toBeDefined();
    expect(result.report.failed?.[0]?.nodeId).toBe("gate");
  });
});

describe("a watch that stops before the window does", () => {
  it("reports the span it ran over, not the span it was offered", async () => {
    // A `once_ever` watch retires when it fires. Reporting the read window
    // would describe its behaviour over a stretch it never saw, and any rate a
    // reader computed from it would be wrong by however long the tail was.
    journal.commit({
      events: [
        mail(1, "d0000000-0000-4000-8000-000000000001", "one"),
        mail(2, "d0000000-0000-4000-8000-000000000002", "two"),
        mail(3, "d0000000-0000-4000-8000-000000000003", "three"),
      ],
    });
    const once = fromAlice(await fingerprint()) as { firing_policy: string };
    once.firing_policy = "once_ever";

    const result = await preflight(deps(), once as never);

    expect(result.outcome).toBe("probed");
    if (result.outcome !== "probed") return;
    expect(result.report.window.offered).toBe(3);
    expect(result.report.window.events, "the window counted events it never saw").toBeLessThan(3);
    expect(result.report.window.ended).toBe("fired");
  });
});

describe("replaying over a span rather than over recent traffic", () => {
  /** Mail on each of thirty consecutive days, so a span has something to cut. */
  function aMonthOfMail(): void {
    journal.commit({
      events: Array.from({ length: 30 }, (_, i) =>
        mail(i + 1, `d1111111-0000-4000-8000-0000000000${String(i + 10)}`, `day ${i + 1}`),
      ),
    });
  }

  it("cuts the window on when the install SAW an event, not on when it claims to have happened", async () => {
    // A backfilled document carries a semantic time years out. Cutting on that
    // would pull a save-the-date dated next spring into "the last seven days"
    // and drop a message that really arrived this morning.
    journal.commit({
      events: [
        {
          ...mail(1, "d1111111-0000-4000-8000-0000000000f1", "claims to be from 2020"),
          occurredAt: new Date(Date.UTC(2020, 0, 1, 9)).toISOString(),
          observedAt: at(19),
        },
      ],
    });

    const result = await preflight(deps(), fromAlice(await fingerprint()) as never, { days: 7 });

    expect(result.outcome).toBe("probed");
    if (result.outcome !== "probed") return;
    // Observed two days ago, so it is in a seven-day window despite its
    // semantic time being six years out.
    expect(result.report.window.events).toBe(1);
  });

  it("reports the span it consumed, not the span it was asked for", async () => {
    // The reach denominator. Asked for a year against a journal holding a
    // month, a caller told "365" divides by the wrong number and calls a
    // healthy watch quiet.
    aMonthOfMail();

    const result = await preflight(deps(), fromAlice(await fingerprint()) as never, { days: 365 });

    expect(result.outcome).toBe("probed");
    if (result.outcome !== "probed") return;
    expect(result.report.window.daysRequested).toBe(365);
    // Milliseconds, because a rounded day count is a bad denominator: a window
    // of eleven hours would round to zero and a reach divided by it is
    // infinite. A month of fixture mail is well under a year.
    expect(result.report.window.observedMs).toBeGreaterThan(0);
    expect(result.report.window.observedMs).toBeLessThan(365 * 86_400_000);
  });

  it("leaves out what the span excludes", async () => {
    aMonthOfMail();

    const wide = await preflight(deps(), fromAlice(await fingerprint()) as never, { days: 365 });
    const narrow = await preflight(deps(), fromAlice(await fingerprint()) as never, { days: 5 });

    expect(wide.outcome).toBe("probed");
    expect(narrow.outcome).toBe("probed");
    if (wide.outcome !== "probed" || narrow.outcome !== "probed") return;
    expect(narrow.report.window.events).toBeLessThan(wide.report.window.events);
    expect(narrow.report.window.events).toBeGreaterThan(0);
  });

  it("says when the event backstop bound the run, not just that the span was short", async () => {
    // A shortfall means two opposite things — the install is younger than the
    // question, or the question was too big for one replay — and only one of
    // them is a reason to ask again differently.
    aMonthOfMail();

    const result = await preflight(deps(), fromAlice(await fingerprint()) as never, { days: 365 });

    expect(result.outcome).toBe("probed");
    if (result.outcome !== "probed") return;
    expect(result.report.window.truncated, "nothing was truncated here").toBeUndefined();
  });

  it("separates an empty window from an empty journal", async () => {
    // The state the operator was in for four days while their collector was
    // down: tens of thousands of events, and nothing at all in the last one.
    // Telling them the journal is empty sends them to the wrong subsystem.
    aMonthOfMail();

    const result = await preflight(
      { ...deps(), now: () => Date.UTC(2027, 0, 1) },
      fromAlice(await fingerprint()) as never,
      { days: 1 },
    );

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") return;
    expect(result.refusal.reason).toBe("empty-window");
    if (result.refusal.reason !== "empty-window") return;
    expect(result.refusal.head, "the refusal does not say the journal has events").toBeGreaterThan(
      0,
    );
  });

  it("leaves the journal exactly as long as it found it", async () => {
    // Read-only is the whole licence for pointing this at the live journal.
    // The engine is given no store, so it builds an in-memory one and leaves
    // no cursor, no live instance and no firing behind; this is the check that
    // the journal itself is untouched too.
    aMonthOfMail();
    const before = journal.count();
    const head = journal.head();

    await preflight(deps(), fromAlice(await fingerprint()) as never, { days: 365 });

    expect(journal.count()).toBe(before);
    expect(journal.head()).toBe(head);
    // And no runtime state was left for a watch that was never installed.
    expect(journal.getState("watch:preflight")).toBeNull();
  });
});
