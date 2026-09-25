// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The host, driving real watches over a real journal.
 *
 * Everything below writes journal events through the store the materializer
 * writes, stores a watch through the store the admin surface stores one
 * through, and reads firings back out of the state the engine keeps — so what
 * is exercised is the wiring, not a mock of it.
 *
 * The cases are the four things a host can get wrong without anyone noticing: a
 * watch that starts at the wrong place in the journal, a watch that speaks
 * twice about one thing after a restart, a watch whose ontology moved under it
 * and kept running anyway, and one broken watch taking the others down.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { WatchStateStore } from "@omnesis/watch";
import { runSchemaSetup } from "../data/schema.js";
import { WatchDefinitionStore } from "./definitions.js";
import { nodeFailedNote } from "./health.js";
import { WatchEngineHost } from "./engine-host.js";
import { buildOntologySnapshot } from "./ontology.js";
import { WatchJournalStore } from "./store.js";
import { WatchTraceStore } from "./traces.js";
import { WriteLease } from "./write-lease.js";
import type { DeliveryCaps, WatchNotification, WatchThreadDegrade } from "./engine-host.js";
import type { Db } from "../data/types.js";
import type { EncryptedSqliteDatabase } from "../sqlite-encryption.js";
import type { NewJournalEvent } from "./store.js";
import type { AnalyticsPort, JudgeProvider } from "@omnesis/watch";

const SELF = "0a1b2c3d-0000-4000-8000-000000000001";
const ALICE = "b3f2a9d4-0000-4000-8000-000000000002";

let dir: string;
let db: Db;
let journal: WatchJournalStore;
/** The host's own connection — never the journal's. */
let hostDb: EncryptedSqliteDatabase;
let definitions: WatchDefinitionStore;

function at(day: number, hour = 9): string {
  return new Date(Date.UTC(2026, 2, day, hour)).toISOString();
}

/** A gmail message landing on the journal. */
function mail(day: number, docId: string, title: string): NewJournalEvent {
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
      metadata: { extra: { threadId: `t-${docId}` } },
      people: [
        { personId: ALICE, role: "sender", isSelf: false },
        { personId: SELF, role: "recipient", isSelf: true },
      ],
    },
  };
}

/**
 * A watch that fires on any email from Alice. Procedural — no judge involved.
 *
 * Carries the live fingerprint, because a watch that does not is one the
 * runtime refuses — which is the drift discipline, and is exercised on purpose
 * further down.
 */
function fromAlice(fingerprint: string, name = "alice-writes"): unknown {
  return {
    watch: {
      name,
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
            people: [{ role: "sender", person: ALICE }],
          },
          output_map: { doc_id: "$e.docId" },
        },
      ],
      sink: { input: "mail", output_map: { doc_id: "$n.mail.doc_id" } },
    },
  };
}

/** The gateway's declared surface, as this fixture install has it. */
function seedOntologySources(): void {
  db.prepare(
    `INSERT INTO source_document_profiles (source_type, profile_json, published_at)
     VALUES ('gmail', ?, 0)`,
  ).run(
    JSON.stringify({
      documentTypes: ["email"],
      personRoles: ["sender", "recipient"],
      metadataFields: [{ path: "extra.threadId", type: "string", description: "thread" }],
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
  // One document, so the corpus records which provider owns gmail.
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
                            metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES ('11111111-2222-4333-8444-555555555555', 'google', 'gmail', 'seed', 'seed', '', 'h',
             '{}', ?, ?, ?, ?)`,
  ).run(at(1), at(1), at(1), at(1));
}

/** A judge nothing here needs — every watch under test is procedural. */
const NEVER_ASKED: JudgeProvider = {
  judge: () => {
    throw new Error("a procedural watch reached the judge");
  },
};

const NO_ANALYTICS: AnalyticsPort = {
  query: () => Promise.resolve({ rows: [], columns: [] } as never),
};

function host(
  overrides: {
    eventsPerWatch?: number;
    now?: () => number;
    writes?: WriteLease;
    analytics?: AnalyticsPort;
  } = {},
): WatchEngineHost {
  return new WatchEngineHost({
    db: hostDb,
    journal,
    definitions,
    analytics: NO_ANALYTICS,
    judge: NEVER_ASKED,
    recall: { score: () => 0 },
    traces: new WatchTraceStore(hostDb),
    writes: new WriteLease(),
    ontology: { db, analyticsDb: null, semanticallyIndexed: () => true },
    ...overrides,
  });
}

/** The fingerprint the install currently declares. */
async function fingerprint(): Promise<string> {
  const snapshot = await buildOntologySnapshot({
    db,
    analyticsDb: null,
    semanticallyIndexed: () => true,
  });
  return snapshot.fingerprint;
}

function addWatch(dsl: unknown, fromSeq: number, id = "w-1"): void {
  definitions.put({
    id,
    name: (dsl as { watch: { name: string } }).watch.name,
    status: "active",
    dsl,
    addedAt: at(1),
    fromSeq,
    note: null,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-wv2-host-"));
  db = new Database(":memory:");
  runSchemaSetup(db);
  seedOntologySources();
  journal = WatchJournalStore.open(join(dir, "watch.db"), null);
  // The second connection to the same file, which is the decision this host is
  // built on: never share the materializer's.
  hostDb = new Database(join(dir, "watch.db")) as unknown as EncryptedSqliteDatabase;
  hostDb.pragma("busy_timeout = 5000");
  definitions = new WatchDefinitionStore(hostDb);
});

afterEach(() => {
  hostDb.close();
  journal.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("where a watch starts", () => {
  it("watches the future, not the corpus", async () => {
    // Three emails already in the journal when the watch is added. A watch that
    // woke on them would be answering a question nobody asked — "tell me when
    // Alice writes" is a claim about what happens next.
    journal.commit({
      events: [
        mail(1, "d1111111-0000-4000-8000-000000000001", "one"),
        mail(2, "d1111111-0000-4000-8000-000000000002", "two"),
        mail(3, "d1111111-0000-4000-8000-000000000003", "three"),
      ],
    });
    addWatch(fromAlice(await fingerprint()), 3);

    const first = await host().evaluate();
    expect(first.firings, "the watch woke on the corpus it was added after").toBe(0);

    journal.commit({ events: [mail(4, "d1111111-0000-4000-8000-000000000004", "four")] });
    const second = await host().evaluate();
    expect(second.firings, "the watch did not hear what happened next").toBe(1);
  });

  it("can be pointed at the past when a test asks for it", async () => {
    journal.commit({
      events: [
        mail(1, "d1111111-0000-4000-8000-000000000001", "one"),
        mail(2, "d1111111-0000-4000-8000-000000000002", "two"),
      ],
    });
    addWatch(fromAlice(await fingerprint()), 0);
    expect((await host().evaluate()).firings).toBe(2);
  });
});

describe("a host that keeps running", () => {
  it("rotates fairly when every pass is cooperatively preempted", async () => {
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    const shape = await fingerprint();
    addWatch(fromAlice(shape, "first"), 0, "w-1");
    addWatch(fromAlice(shape, "second"), 0, "w-2");
    addWatch(fromAlice(shape, "third"), 0, "w-3");
    const running = host();

    for (let pass = 0; pass < 3; pass += 1) {
      const result = await running.evaluate(() => true);
      expect(result.watches).toBe(1);
      expect(result.idle, "a preempted continuation was put on the idle cadence").toBe(false);
    }

    expect(running.firingCount("w-1")).toBe(1);
    expect(running.firingCount("w-2")).toBe(1);
    expect(running.firingCount("w-3")).toBe(1);
  });

  it("does not say the same thing twice across ticks", async () => {
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(fromAlice(await fingerprint()), 0);

    const running = host();
    expect((await running.evaluate()).firings).toBe(1);
    expect((await running.evaluate()).firings, "the cursor did not advance").toBe(0);

    journal.commit({ events: [mail(2, "d1111111-0000-4000-8000-000000000002", "two")] });
    expect((await running.evaluate()).firings).toBe(1);
  });

  it("reports itself idle when the journal has nothing new", async () => {
    addWatch(fromAlice(await fingerprint()), 0);
    expect((await host().evaluate()).idle, "an empty pass claimed to have worked").toBe(true);
  });

  it("takes only its batch, and comes back for the rest", async () => {
    const events = [];
    for (let i = 1; i <= 5; i += 1) {
      events.push(mail(i, `d1111111-0000-4000-8000-00000000000${i}`, `mail ${i}`));
    }
    journal.commit({ events });
    addWatch(fromAlice(await fingerprint()), 0);

    const running = host({ eventsPerWatch: 2 });
    expect((await running.evaluate()).firings).toBe(2);
    expect((await running.evaluate()).firings).toBe(2);
    expect((await running.evaluate()).firings).toBe(1);
    expect((await running.evaluate()).firings).toBe(0);
  });
});

describe("what a firing can be explained by", () => {
  it("keeps the trace that produced it", async () => {
    // A firing on its own is unreviewable — "this watch fired" says nothing
    // about whether it fired for the right reason, which is most of what a
    // shadow week is for.
    const traces = new WatchTraceStore(hostDb);
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(fromAlice(await fingerprint()), 0);

    await new WatchEngineHost({
      db: hostDb,
      journal,
      definitions,
      analytics: NO_ANALYTICS,
      judge: NEVER_ASKED,
      recall: { score: () => 0 },
      traces,
      writes: new WriteLease(),
      ontology: { db, analyticsDb: null, semanticallyIndexed: () => true },
    }).evaluate();

    // Keyed by the definition's id, which is what the runtime holds state
    // under — the DSL's name is a label two watches may share.
    const records = traces.recent("w-1");
    expect(records.length, "the firing was recorded with no account of itself").toBeGreaterThan(0);
    expect(records.map((r) => r.transition)).toContain("fired");
    expect(records[0]?.nodeId).toBe("mail");
  });
});

describe("a host that restarts", () => {
  it("picks up where it left off rather than repeating itself", async () => {
    // The cursor and the cells are on disk, so a new host over the same file is
    // a restarted gateway. What must not happen is the watch speaking again
    // about mail it already spoke about.
    journal.commit({
      events: [
        mail(1, "d1111111-0000-4000-8000-000000000001", "one"),
        mail(2, "d1111111-0000-4000-8000-000000000002", "two"),
      ],
    });
    addWatch(fromAlice(await fingerprint()), 0);
    expect((await host().evaluate()).firings).toBe(2);

    journal.commit({ events: [mail(3, "d1111111-0000-4000-8000-000000000003", "three")] });
    const afterRestart = await host().evaluate();
    expect(afterRestart.firings, "a restarted host repeated itself").toBe(1);
  });
});

describe("a watch the install has moved out from under", () => {
  it("is paused rather than reinterpreted", async () => {
    addWatch(fromAlice(await fingerprint()), 0);
    // The source ships a new profile: it stops declaring the document type this
    // watch filters on. What that filter means has changed, and a watch that
    // quietly means something else is not the watch the operator approved.
    db.prepare(
      "UPDATE source_document_profiles SET profile_json = ? WHERE source_type = 'gmail'",
    ).run(JSON.stringify({ documentTypes: ["note"], personRoles: ["sender"], metadataFields: [] }));
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });

    const result = await host().evaluate();
    expect(result.paused, "a drifted watch kept running").toBe(1);
    expect(result.firings).toBe(0);
    expect(definitions.get("w-1")?.status).toBe("paused");
    expect(definitions.get("w-1")?.note).toContain("no longer validates");
  });

  it("keeps running when the install only grew, and re-stamps it to say so", async () => {
    // The whole install's shape is one hash, so a source declaring something
    // no watch has ever heard of moves it for every watch at once. Observed
    // live: a new analytics table arrived and all thirty active watches
    // stopped, each of them told that the shape had moved under it, none of
    // them referring to anything that had changed. Re-stamping healed all
    // thirty with no definition edited.
    //
    // Drift lands when new *data* first arrives, not at the deploy that made
    // it possible, so a deploy-time fingerprint check passes and the stop
    // comes later.
    const before = await fingerprint();
    addWatch(fromAlice(before), 0);
    // One pass first, because "nothing this watch reads moved" is a comparison
    // and a comparison needs something to compare against: the surface a watch
    // is measured against is the one its last successful validation consulted,
    // and until it has had one there is nothing on record.
    await host().evaluate();

    // A second source declares itself. Nothing this watch names is touched.
    db.prepare(
      `INSERT INTO source_document_profiles (source_type, profile_json, published_at)
       VALUES ('fictional-ledger', ?, 1)`,
    ).run(
      JSON.stringify({
        documentTypes: ["receipt"],
        personRoles: ["sender"],
        metadataFields: [{ path: "extra.total", type: "string", description: "total" }],
      }),
    );
    const after = await fingerprint();
    expect(after, "the fixture did not actually move the fingerprint").not.toBe(before);

    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    const result = await host().evaluate();

    expect(result.paused, "an additive change stopped a watch it does not concern").toBe(0);
    expect(result.firings, "the watch stopped seeing what it was asked to see").toBe(1);
    expect(definitions.get("w-1")?.status).toBe("active");
    expect(definitions.get("w-1")?.note).toBeNull();
    // Re-stamped, not merely tolerated: the stored definition now records the
    // world it was actually checked against, so the next pass does not re-ask.
    const stored = definitions.get("w-1")!.dsl as { watch: { ontology_fingerprint: string } };
    expect(stored.watch.ontology_fingerprint).toBe(after);
  });

  it("holds a watch whose own source moved, even though it still validates", async () => {
    // The dangerous half of the same mechanism. This profile change leaves the
    // watch valid — it names a document type, a role and a source that all
    // still exist — so a rule that re-stamped on validity alone would wave it
    // through and the watch would go on running against a source that is not
    // the source it was approved against.
    //
    // The line is byte-identity rather than "we can show this particular
    // change matters", because deciding which changes matter is precisely the
    // judgement nothing should be making unattended. A field gaining allowed
    // values, a type widening, an enum growing a member: each re-validates
    // cleanly and each can move what an existing filter selects.
    const before = await fingerprint();
    addWatch(fromAlice(before), 0);
    await host().evaluate();

    db.prepare(
      "UPDATE source_document_profiles SET profile_json = ? WHERE source_type = 'gmail'",
    ).run(
      JSON.stringify({
        documentTypes: ["email"],
        personRoles: ["sender", "recipient"],
        metadataFields: [
          { path: "extra.threadId", type: "string", description: "thread" },
          { path: "extra.label", type: "string", description: "label" },
        ],
      }),
    );
    expect(await fingerprint(), "the fixture did not move the fingerprint").not.toBe(before);

    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    const result = await host().evaluate();

    expect(result.paused, "a watch whose own source moved was re-stamped anyway").toBe(1);
    expect(definitions.get("w-1")?.status).toBe("paused");
    // Its own sentence, because it is its own problem. This watch validates;
    // telling its owner it "no longer validates" would send them to rewrite
    // something that is not broken.
    expect(definitions.get("w-1")?.note).toContain("the ontology it reads has changed");
    expect(definitions.get("w-1")?.note).not.toContain("no longer validates");
    // Still carrying the fingerprint a person approved, so `watch restamp`
    // remains the operator's decision to make.
    const held = definitions.get("w-1")!.dsl as { watch: { ontology_fingerprint: string } };
    expect(held.watch.ontology_fingerprint).toBe(before);
  });

  it("will not re-stamp a watch whose surface it has never recorded", async () => {
    // No evaluation before the drift, so nothing is on record about what this
    // watch reads. The change is the purely additive one the case above
    // re-stamps through — and it is held anyway, because unproven is not the
    // same as unchanged.
    addWatch(fromAlice(await fingerprint()), 0);
    db.prepare(
      `INSERT INTO source_document_profiles (source_type, profile_json, published_at)
       VALUES ('fictional-ledger', ?, 1)`,
    ).run(
      JSON.stringify({ documentTypes: ["receipt"], personRoles: ["sender"], metadataFields: [] }),
    );

    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    const result = await host().evaluate();

    expect(result.paused, "a watch with no recorded surface was re-stamped").toBe(1);
    expect(definitions.get("w-1")?.status).toBe("paused");
    // And says which of the two it is. "We never checked" and "we checked and
    // it moved" are the same status and the same cause, and send an operator
    // to different places.
    expect(definitions.get("w-1")?.note).toContain("never recorded");
  });
});

describe("one watch failing", () => {
  it("does not take the others with it", async () => {
    addWatch(fromAlice(await fingerprint(), "healthy"), 0, "ok");
    // A definition that is not a watch at all. It cannot validate, so it pauses
    // — and the point is that the pass continues.
    definitions.put({
      id: "broken",
      name: "broken",
      status: "active",
      dsl: { watch: { nonsense: true } },
      addedAt: at(1),
      fromSeq: 0,
      note: null,
    });
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });

    const result = await host().evaluate();
    expect(result.paused).toBe(1);
    expect(result.firings, "a broken sibling silenced a healthy watch").toBe(1);
    expect(definitions.get("ok")?.status).toBe("active");
    expect(definitions.get("broken")?.status).toBe("paused");
  });
});

describe("a watch's identity", () => {
  it("is the definition's, so a replacement does not inherit its predecessor", async () => {
    // The ordinary way an operator revises a watch: remove it, edit the file,
    // add it again. Keying durable state on the name its DSL carries handed the
    // replacement the first one's cursor — so it woke up already past every
    // event it was added to watch — along with its firings and, if the first
    // had retired, its retirement.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(fromAlice(await fingerprint()), 0, "first");
    const running = host();
    expect((await running.evaluate()).firings).toBe(1);

    // Removed, and a new definition of the same name added behind it.
    definitions.remove("first");
    running.forget("first");
    addWatch(fromAlice(await fingerprint()), 0, "second");

    expect(
      (await host().evaluate()).firings,
      "the replacement inherited its predecessor's cursor and saw nothing",
    ).toBe(1);
    expect(running.firingCount("second")).toBe(1);
    expect(running.firingCount("first"), "removing a watch left its firings behind").toBe(0);
  });

  it("survives a removal, so nothing of it is left to inherit", async () => {
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(fromAlice(await fingerprint()), 0);
    const running = host();
    await running.evaluate();

    expect(running.firingCount("w-1")).toBe(1);
    running.forget("w-1");
    expect(running.firingCount("w-1"), "a forgotten watch kept its firings").toBe(0);
  });
});

describe("how a watch stops", () => {
  it("retires when it fired once and was asked for nothing more", async () => {
    const dsl = fromAlice(await fingerprint()) as { watch: Record<string, unknown> };
    dsl.watch.firing_policy = "once_ever";
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(dsl, 0);

    await host().evaluate();

    expect(definitions.get("w-1")?.status).toBe("retired");
    expect(definitions.get("w-1")?.note).toContain("fired once");
  });

  it("is held, not retired, when one of its nodes broke", async () => {
    // The engine deactivates a watch both when it is finished and when a node
    // threw — it contains the failure rather than raising it, so `run()` returns
    // normally either way. Reading only the active flag filed a watch whose
    // embedder refused a connection as one that fired and finished, which is a
    // note an operator would believe.
    journal.commit({
      events: [
        mail(1, "d1111111-0000-4000-8000-000000000001", "one"),
        {
          kind: "doc.indexed",
          occurredAt: at(1),
          observedAt: at(1),
          payload: {
            docId: "d1111111-0000-4000-8000-000000000001",
            eventIndexedAt: at(1),
          },
        },
      ],
    });

    const dsl = fromAlice(await fingerprint()) as {
      watch: { nodes: Record<string, unknown>[] };
    };
    dsl.watch.nodes[0]!.recall = { semantic: { query: "anything", threshold: 0.1 } };
    dsl.watch.nodes[0]!.judge = {
      proposition: "it is about anything",
      output_schema: { because: "string" },
    };
    addWatch(dsl, 0);

    const broken = new WatchEngineHost({
      db: hostDb,
      journal,
      definitions,
      analytics: NO_ANALYTICS,
      judge: NEVER_ASKED,
      recall: {
        score: () => {
          throw new Error("embedder refused the connection");
        },
      },
      traces: new WatchTraceStore(hostDb),
      writes: new WriteLease(),
      ontology: { db, analyticsDb: null, semanticallyIndexed: () => true },
    });
    const result = await broken.evaluate();

    expect(definitions.get("w-1")?.status, "a broken watch was filed as finished").toBe("paused");
    // The class and the node, and nothing the backend said. A status note is
    // read on a listing, copied into a report and kept for as long as the watch
    // exists; an error message can quote a value out of the corpus.
    expect(definitions.get("w-1")?.note).toBe(nodeFailedNote("mail", "provider"));
    expect(
      definitions.get("w-1")?.note,
      "a backend's own words reached a durable note",
    ).not.toContain("embedder refused");

    // The half that was missing: the pass reported no paused watches while a
    // watch was stopped, because the engine contains a node failure rather than
    // raising it and this counted the return as an ordinary evaluation.
    expect(result.paused, "a stopped watch did not appear in the tick's own count").toBe(1);

    const failure = broken.failure("w-1");
    expect(failure?.failure).toBe("provider");
    expect(failure?.nodeId).toBe("mail");
    expect(failure?.seq, "the failing event was not recorded, so nothing can move past it").toBe(2);
  });

  it("does not read a crashed-out failure as a watch that finished", async () => {
    // The pause and the note are two writes to two stores: the engine commits
    // the watch inactive with its failure record, and the host writes the note
    // after. A crash in between leaves definitions=active and state=inactive —
    // and the next tick has to decide what that means. Reading only the flag
    // called it "fired once and was done": a broken watch filed as completed,
    // out of the layer alarm, with a note the operator would believe and
    // nothing left to correct it.
    journal.commit({
      events: [
        mail(1, "d1111111-0000-4000-8000-000000000001", "one"),
        {
          kind: "doc.indexed",
          occurredAt: at(1),
          observedAt: at(1),
          payload: {
            docId: "d1111111-0000-4000-8000-000000000001",
            eventIndexedAt: at(1),
          },
        },
      ],
    });
    const dsl = fromAlice(await fingerprint()) as { watch: { nodes: Record<string, unknown>[] } };
    dsl.watch.nodes[0]!.recall = { semantic: { query: "anything", threshold: 0.1 } };
    dsl.watch.nodes[0]!.judge = {
      proposition: "it is about anything",
      output_schema: { because: "string" },
    };
    addWatch(dsl, 0);

    await new WatchEngineHost({
      db: hostDb,
      journal,
      definitions,
      analytics: NO_ANALYTICS,
      judge: NEVER_ASKED,
      recall: {
        score: () => {
          throw new Error("embedder refused the connection");
        },
      },
      traces: new WatchTraceStore(hostDb),
      writes: new WriteLease(),
      ontology: { db, analyticsDb: null, semanticallyIndexed: () => true },
    }).evaluate();
    expect(definitions.get("w-1")?.status).toBe("paused");

    // The crash: the note write is undone, leaving the definition as the
    // failing pass found it. The state store keeps its failure record, which
    // is the fact that outlived the process.
    definitions.setStatus("w-1", "active", null);

    const next = host();
    await next.evaluate();

    expect(definitions.get("w-1")?.status, "a broken watch was filed as finished").toBe("paused");
    expect(definitions.get("w-1")?.note).toBe(nodeFailedNote("mail", "provider"));
    expect(next.failure("w-1")?.nodeId).toBe("mail");
  });

  it("can be let go again after being held", async () => {
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    const dsl = fromAlice(await fingerprint()) as { watch: Record<string, unknown> };
    dsl.watch.firing_policy = "once_ever";
    addWatch(dsl, 0);

    const running = host();
    await running.evaluate();
    expect(definitions.get("w-1")?.status).toBe("retired");

    // Both halves. Setting the definition back to active while the runtime's
    // own flag stayed down would show a watch visibly running and silently
    // doing nothing.
    running.reactivate("w-1");
    definitions.setStatus("w-1", "active", null);
    journal.commit({ events: [mail(2, "d2222222-0000-4000-8000-000000000002", "two")] });

    expect((await host().evaluate()).firings, "a resumed watch stayed silent").toBe(1);
  });
});

describe("what the shadow report can say about cost", () => {
  it("keeps the evaluation times the percentiles are read from", async () => {
    // Collected and then dropped is the failure that matters here: the goal
    // asked for p50/p95 and the numbers existed, but nothing read the field, so
    // the report had nothing to show.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(fromAlice(await fingerprint()), 0);

    const running = host();
    expect(running.latency().samples, "latency was recorded before anything ran").toBe(0);
    await running.evaluate();
    await running.evaluate();

    const latency = running.latency();
    expect(latency.samples, "an evaluation was not measured").toBe(2);
    expect(latency.maxMs).toBeGreaterThanOrEqual(latency.p50Ms);
  });

  it("puts the percentiles the right way round", async () => {
    // A single sample makes every percentile the same number, so p50 and p95
    // could be swapped and nothing would notice. Distinct samples are what make
    // the arithmetic falsifiable.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(fromAlice(await fingerprint()), 0);

    // A clock that advances by a growing amount per read, so the passes are
    // measured as 1ms, 2ms, 3ms … and the two percentiles must differ.
    let tick = 0;
    let clock = 0;
    const stepping = host({ now: () => (clock += ++tick % 2 === 1 ? 0 : tick) });
    for (let pass = 0; pass < 20; pass += 1) await stepping.evaluate();

    const latency = stepping.latency();
    expect(latency.samples).toBe(20);
    expect(latency.p95Ms, "p95 is not above p50 — the two are swapped").toBeGreaterThan(
      latency.p50Ms,
    );
    expect(latency.maxMs).toBeGreaterThanOrEqual(latency.p95Ms);
  });

  it("does not report a pass that fired a timer as idle", async () => {
    // Idleness is about what happened, not about what was read. A purely
    // time-driven watch fires with no events at all, and a pass that called
    // that idle would have the scheduler back off to its idle cadence — so
    // whether a daily digest is late depends on whether anything else happened.
    const dsl = {
      watch: {
        name: "every-minute",
        firing_policy: "stays_active",
        ontology_fingerprint: await fingerprint(),
        nodes: [
          {
            id: "tick",
            type: "source.time",
            recurring: "* * * * *",
            output_map: { at: "$e.dueAt" },
          },
        ],
        sink: { input: "tick", output_map: { at: "$n.tick.at" } },
      },
    };
    addWatch(dsl, 0);

    // The first pass arms the boundary; a later one, with the clock past it,
    // fires — with nothing in the journal at all.
    await host().evaluate();
    const later = host({ now: () => Date.now() + 120_000 });
    const result = await later.evaluate();

    // Two minutes past the first boundary, so the catch-up produces the
    // boundaries it missed — in order, and each exactly once.
    expect(result.firings, "a time-driven watch never fired").toBeGreaterThanOrEqual(1);
    expect(result.events, "this pass should have read no events").toBe(0);
    expect(result.idle, "a pass that fired was reported idle").toBe(false);
  });
});

describe("a host that keeps running for a week", () => {
  it("sees a person who joined after its first pass", async () => {
    // The flagship failure this cache has to avoid. A watch naming someone who
    // joined since the ontology was built is accepted by the admin route, which
    // builds its own snapshot — and then paused by the very next evaluation
    // with PERSON_UNKNOWN. The route and the runtime have to agree.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(fromAlice(await fingerprint()), 0);
    const running = host();
    await running.evaluate();

    // A new contact, and a watch naming them.
    const jamie = "d4e5f6a7-0000-4000-8000-000000000009";
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'Jamie Lopez', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(jamie);
    const naming = fromAlice(await fingerprint(), "from-jamie") as {
      watch: { nodes: { filter: { people: { person: string }[] } }[] };
    };
    naming.watch.nodes[0]!.filter.people[0]!.person = jamie;
    addWatch(naming, 0, "w-2");

    // The SAME host instance, not a fresh one: a cache that froze the directory
    // at its first pass would pause this watch rather than run it.
    await running.evaluate();

    expect(
      definitions.get("w-2")?.status,
      `a watch naming a new person was ${definitions.get("w-2")?.note ?? "held"}`,
    ).toBe("active");
  });
});

/**
 * The way out of a permanent pause.
 *
 * A node failure rolls its event back, cursor included, so the next pass
 * re-reads exactly the event that broke and breaks on it again. That is right —
 * an event whose effects were lost must not be skipped in silence — but it left
 * a watch that met one poison event stopped forever, with deleting and re-adding
 * it the only escape. That escape costs the watch its cursor, its live instances
 * and every firing it ever recorded, which is a high price for one bad event.
 */
describe("a watch stopped on one event it cannot get through", () => {
  /** A host whose recall refuses for exactly one document. */
  function hostRefusing(docId: string): WatchEngineHost {
    return new WatchEngineHost({
      db: hostDb,
      journal,
      definitions,
      analytics: NO_ANALYTICS,
      judge: { judge: () => ({ fired: true, output: { because: "it is" } }) },
      recall: {
        score: (request) => {
          if (request.documentId === docId) throw new Error("embedder refused the connection");
          return 1;
        },
      },
      traces: new WatchTraceStore(hostDb),
      writes: new WriteLease(),
      ontology: { db, analyticsDb: null, semanticallyIndexed: () => true },
    });
  }

  /** What a resume is: the runtime's own flag and the definition's status. */
  function letGo(running: WatchEngineHost): void {
    running.reactivate("w-1");
    definitions.setStatus("w-1", "active", null);
  }

  const POISON = "d1111111-0000-4000-8000-000000000001";
  const NEXT = "d1111111-0000-4000-8000-000000000002";

  /** Two mails, each with its index event, and a watch that scores both. */
  async function twoMailsOneOfWhichBreaks(): Promise<void> {
    const indexed = (day: number, docId: string): NewJournalEvent => ({
      kind: "doc.indexed",
      occurredAt: at(day),
      observedAt: at(day),
      payload: { docId, eventIndexedAt: at(day) },
    });
    journal.commit({
      events: [mail(1, POISON, "one"), indexed(1, POISON), mail(2, NEXT, "two"), indexed(2, NEXT)],
    });
    const dsl = fromAlice(await fingerprint()) as { watch: { nodes: Record<string, unknown>[] } };
    dsl.watch.nodes[0]!.recall = { semantic: { query: "anything", threshold: 0.1 } };
    dsl.watch.nodes[0]!.judge = {
      proposition: "it is about anything",
      output_schema: { because: "string" },
    };
    addWatch(dsl, 0);
  }

  it("stays stopped on it, however many passes go by", async () => {
    // The behaviour the escape exists for, asserted rather than assumed: a
    // second pass is not a recovery, and never becomes one.
    await twoMailsOneOfWhichBreaks();
    const running = hostRefusing(POISON);
    await running.evaluate();
    expect(running.failure("w-1")?.seq).toBe(2);

    letGo(running);
    await running.evaluate();
    expect(running.failure("w-1")?.seq, "a bare resume got past the failing event").toBe(2);
  });

  it("moves past it on request, keeping everything it had already said", async () => {
    await twoMailsOneOfWhichBreaks();
    const running = hostRefusing(POISON);
    await running.evaluate();

    const plan = running.skipPlan("w-1");
    expect(plan?.what, "the failing event was not recognised as skippable").toBe("event");
    expect(plan?.seq, "nothing was skipped").toBe(2);
    running.applySkip("w-1", plan!);

    letGo(running);
    const after = await running.evaluate();

    expect(after.paused, "the watch stopped again on an event it had been moved past").toBe(0);
    expect(running.failure("w-1"), "the failure outlived the skip").toBeNull();
    // The second mail is the point: the watch is not merely unstuck, it is
    // working again on everything after the event it could not answer.
    expect(after.firings, "the watch never got to the event behind the poison one").toBe(1);
  });

  it("writes the skip into the ledger rather than leaving a silent gap", async () => {
    // A reader of a trace has to be able to tell "considered and decided
    // nothing" from "never looked at". A cursor quietly moved forward destroys
    // that distinction, which is the one thing a trace is for.
    await twoMailsOneOfWhichBreaks();
    const running = hostRefusing(POISON);
    await running.evaluate();
    const plan = running.skipPlan("w-1")!;
    running.applySkip("w-1", plan);

    const traces = new WatchTraceStore(hostDb);
    const record = traces.recent("w-1", 100).find((r) => r.transition === "skipped");
    expect(record, "the skipped event left no trace at all").toBeDefined();
    expect(record?.seq).toBe(2);
    expect(record?.detail).toContain("provider");
  });

  it("moves past a parked nomination, which no cursor can be advanced past", async () => {
    // The likeliest shape by far: a judge or embedder outage while the parked
    // queue drains. A parked nomination's sequence committed *with* the cursor,
    // so it is always behind it — advancing a cursor already past it moves
    // nothing, and a skip that reported success there would leave the operator
    // certain the watch was unstuck and watching it stop again on the next pass.
    journal.commit({ events: [mail(1, POISON, "one")] });
    addWatch(fromAlice(await fingerprint()), 0);
    const state = WatchStateStore.on(hostDb, "watch.db");
    state.advanceCursor("w-1", 9);
    state.parkNomination("w-1", "mail", POISON, 4, 0);
    state.recordFailure("w-1", { seq: 4, nodeId: "mail", failure: "provider" });

    const running = host();
    const plan = running.skipPlan("w-1");
    expect(plan?.what, "a parked nomination was mistaken for an event").toBe("nomination");
    expect(plan?.seq).toBe(4);

    running.applySkip("w-1", plan!);
    expect(state.pendingCount("w-1"), "the nomination the watch was stuck on survived").toBe(0);
    expect(state.cursor("w-1"), "a cursor already past it was moved anyway").toBe(9);
  });

  it("refuses when the failure is behind the cursor and nothing is parked", async () => {
    // Work replayed over an already-consumed event fails at a sequence the
    // cursor is long past and has no parked entry either. There is nothing a
    // skip can act on, and saying so is better than a skip that does nothing
    // and reports a sequence.
    journal.commit({ events: [mail(1, POISON, "one")] });
    addWatch(fromAlice(await fingerprint()), 0);
    const state = WatchStateStore.on(hostDb, "watch.db");
    state.advanceCursor("w-1", 12);
    state.recordFailure("w-1", { seq: 3, nodeId: "<watch>", failure: "internal" });

    expect(host().skipPlan("w-1")).toBeNull();
  });

  it("refuses to skip a failure that was not on a journal event", async () => {
    // A journaled timer carries a sequence of its own, below every real event's.
    // Advancing a consumer cursor to it moves nothing — so a skip here would
    // report success and leave the watch exactly as stuck as it was.
    journal.commit({ events: [mail(1, POISON, "one")] });
    addWatch(fromAlice(await fingerprint()), 0);
    const state = WatchStateStore.on(hostDb, "watch.db");
    state.recordFailure("w-1", { seq: -3, nodeId: "morning", failure: "query" });

    expect(host().skipPlan("w-1")).toBeNull();
  });

  it("refuses to skip when nothing failed", async () => {
    // Otherwise `--skip` becomes a way to nudge a healthy watch past whatever
    // it happens to be about to read.
    journal.commit({ events: [mail(1, POISON, "one")] });
    addWatch(fromAlice(await fingerprint()), 0);
    const running = host();
    await running.evaluate();
    expect(running.skipPlan("w-1")).toBeNull();
  });
});

/**
 * A firing that interrupts a person.
 *
 * Shadow mode is the default and stays it: a firing is a row and a trace, and
 * nothing leaves the host. A watch opts into delivery, and the two caps bound
 * how often it may take someone's attention — because the failure mode of a
 * notification is not that it is wrong, it is that there are too many of them
 * and the person stops reading any of them.
 */
describe("delivering a firing", () => {
  const SENT: WatchNotification[] = [];

  /** A host whose delivery port records rather than sends. */
  function deliveringHost(
    overrides: {
      caps?: Partial<DeliveryCaps>;
      accepts?: boolean;
      throws?: boolean;
      degraded?: WatchThreadDegrade;
      now?: () => number;
      /** Whether this install has an agent integration wired. Unset: unknown. */
      agentIntegration?: boolean;
      afterSend?: () => void;
    } = {},
  ): WatchEngineHost {
    return new WatchEngineHost({
      db: hostDb,
      journal,
      definitions,
      analytics: NO_ANALYTICS,
      judge: NEVER_ASKED,
      recall: { score: () => 0 },
      traces: new WatchTraceStore(hostDb),
      writes: new WriteLease(),
      ontology: { db, analyticsDb: null, semanticallyIndexed: () => true },
      delivery: () => ({
        send: (notification) => {
          SENT.push(notification);
          if (overrides.throws === true) throw new Error("the device table was unreadable");
          const outcome = {
            delivered: overrides.accepts === false ? 0 : 1,
            ...(overrides.degraded ? { degraded: overrides.degraded } : {}),
          };
          overrides.afterSend?.();
          return Promise.resolve(outcome);
        },
      }),
      ...(overrides.caps ? { deliveryCaps: overrides.caps } : {}),
      ...(overrides.now ? { now: overrides.now } : {}),
      ...(overrides.agentIntegration === undefined
        ? {}
        : { agentIntegration: () => overrides.agentIntegration === true }),
    });
  }

  /** The `alice-writes` watch, delivering by push. */
  async function delivering(): Promise<Record<string, unknown>> {
    const dsl = fromAlice(await fingerprint()) as { watch: Record<string, unknown> };
    dsl.watch.delivery = { kind: "omnesis-notify" };
    return dsl;
  }

  beforeEach(() => {
    SENT.length = 0;
  });

  it("sends nothing at all for a watch that did not ask", async () => {
    // The default, and the whole shape of the shadow period. A watch that says
    // nothing about delivery must not acquire it by being installed on a
    // gateway where push happens to be wired.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(fromAlice(await fingerprint()), 0);

    const result = await deliveringHost().evaluate();

    expect(result.firings, "the fixture did not fire").toBe(1);
    expect(SENT, "a shadow watch delivered").toEqual([]);
    expect(result.delivered).toBe(0);
  });

  it("sends one notification for one firing, naming the watch", async () => {
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);

    const result = await deliveringHost().evaluate();

    expect(result.delivered).toBe(1);
    expect(SENT).toHaveLength(1);
    // A watch with no request behind it is one someone hand-wrote, and its own
    // name is the closest thing to a sentence they gave it.
    expect(SENT[0]?.body).toContain("alice-writes");
  });

  it("keeps its own allowance per day, and says so in the trace when it is spent", async () => {
    // The cap is the product decision: two firings and a cap of one means one
    // banner. The second firing is still a firing — a row, a trace record —
    // and only the notification is withheld.
    journal.commit({
      events: [
        mail(1, "d1111111-0000-4000-8000-000000000001", "one"),
        mail(2, "d1111111-0000-4000-8000-000000000002", "two"),
      ],
    });
    addWatch(await delivering(), 0);

    const result = await deliveringHost({ caps: { perWatchDailyCap: 1 } }).evaluate();

    expect(result.firings, "the cap swallowed a firing rather than a notification").toBe(2);
    expect(result.delivered).toBe(1);
    expect(result.suppressed).toBe(1);
    expect(SENT).toHaveLength(1);

    const record = new WatchTraceStore(hostDb)
      .recent("w-1", 100)
      .find((r) => r.transition === "suppressed");
    expect(record, "a notification was withheld in silence").toBeDefined();
    expect(record?.detail).toContain("already notified you");
  });

  /**
   * A watch keyed per thread, so every firing belongs to a real instance.
   *
   * The suppression record used to name `singleton` whatever the firing's key
   * was, which grew a phantom cell on the node and left the real key's history
   * missing exactly the records that explain why nothing arrived.
   */
  function perThread(fingerprint: string): unknown {
    return {
      watch: {
        name: "quiet-thread",
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
              people: [{ role: "sender", person: ALICE }],
            },
            output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
          },
          {
            id: "hold",
            type: "stateful.wait",
            inputs: { mail: { role: "arm", key: { thread_id: ".thread_id" } } },
            on_collision: "spawn",
            max_live_instances: 3,
            duration: "1 hour",
            output_map: { doc: "$n.mail.doc_id" },
          },
        ],
        sink: { input: "hold", output_map: { doc: "$n.hold.doc" } },
        delivery: { kind: "omnesis-notify" },
      },
    };
  }

  it("names the key a withheld notification belonged to, not the singleton", async () => {
    journal.commit({
      events: [
        mail(1, "d1111111-0000-4000-8000-000000000001", "one"),
        mail(2, "d1111111-0000-4000-8000-000000000002", "two"),
      ],
    });
    addWatch(perThread(await fingerprint()), 0);

    const result = await deliveringHost({ caps: { perWatchDailyCap: 1 } }).evaluate();

    expect(result.firings, "the fixture fired on neither thread").toBe(2);
    expect(result.suppressed, "nothing was withheld, so there is no record to check").toBe(1);

    const records = new WatchTraceStore(hostDb).recent("w-1", 200);
    const withheld = records.filter((r) => r.transition === "suppressed");
    expect(withheld).toHaveLength(1);
    // The key the firing actually belonged to. `singleton` here would be a cell
    // this watch has never had, beside the two it does.
    expect(withheld[0]?.key).toMatch(/^thread_id=/);
    expect(withheld[0]?.key).not.toBe("singleton");
    // And it is one of the node's own keys, so the record lands in a cell the
    // reader can already see rather than opening a new one.
    const armed = new Set(
      records.filter((r) => r.nodeId === "hold" && r.key !== "singleton").map((r) => r.key),
    );
    expect(armed.has(withheld[0]!.key), "the suppression opened a cell of its own").toBe(true);
  });

  it("bounds the day across every watch, not only within one", async () => {
    // Two watches under their own cap can still add up to a day nobody wants.
    journal.commit({
      events: [
        mail(1, "d1111111-0000-4000-8000-000000000001", "one"),
        mail(2, "d1111111-0000-4000-8000-000000000002", "two"),
      ],
    });
    addWatch(await delivering(), 0, "w-1");
    const second = (await delivering()) as { watch: Record<string, unknown> };
    second.watch.name = "alice-writes-too";
    addWatch(second, 0, "w-2");

    const result = await deliveringHost({ caps: { dailyCap: 1, perWatchDailyCap: 10 } }).evaluate();

    expect(result.delivered).toBe(1);
    expect(result.suppressed, "the global cap did not bind").toBe(3);
  });

  it("counts a notification the moment it is sent, so a restart cannot un-cap the day", async () => {
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);
    await deliveringHost().evaluate();

    // A fresh host over the same store: the allowance is a fact about the day,
    // not about this process.
    expect(deliveringHost().deliveryToday().attempted).toBe(1);
    expect(deliveringHost().attemptedToday("w-1")).toBe(1);
  });

  it("spends the allowance even when no device accepted", async () => {
    // A push that reached the transport has already taken the person's
    // attention as far as this host can tell. Retrying it against the cap
    // would let an install with a stale device token send without limit.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);

    const result = await deliveringHost({ accepts: false }).evaluate();

    expect(result.delivered, "nothing accepted it, so nothing was delivered").toBe(0);
    expect(deliveringHost().deliveryToday().attempted, "the attempt was not counted").toBe(1);
  });

  it("does not stop the watch when the transport throws", async () => {
    // A device-table read or an APNs client can fail transiently. That is a
    // fact about the transport, and pausing the watch for it would cost every
    // firing behind this one and leave an operator resuming a watch that was
    // never wrong.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);

    const result = await deliveringHost({ throws: true }).evaluate();

    expect(result.paused, "a throwing transport stopped the watch").toBe(0);
    expect(definitions.get("w-1")?.status).toBe("active");
    expect(result.delivered, "a throw was counted as a delivery").toBe(0);

    // And it is written down. A notification that never arrived is otherwise
    // indistinguishable from a watch that never fired — the operator sees
    // silence either way, and a log line is not something they can read later.
    const state = WatchStateStore.on(hostDb, "watch.db");
    const [outcome] = state.deliveries("w-1");
    expect(outcome?.delivered).toBe(0);
    expect(outcome?.error).toContain("the device table was unreadable");
    expect(outcome?.kind).toBe("omnesis-notify");
  });

  it("writes down that a firing arrived as less than it should have", async () => {
    // The silence this closes: a firing landing while the agent backend is
    // swapping in ships the plain banner, and every number on its row says
    // the delivery went fine. Without this the operator has a log line they
    // do not have, or nothing at all.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);

    await deliveringHost({ degraded: "no-agent" }).evaluate();

    const state = WatchStateStore.on(hostDb, "watch.db");
    const [row] = state.deliveries("w-1");
    expect(row?.delivered, "a degrade is still a delivery").toBe(1);
    expect(row?.degraded).toBe("no-agent");
    // And countable, because one degraded banner is a curiosity and a week of
    // them is a broken install.
    expect(deliveringHost().deliveryToday().degraded).toBe(1);
  });

  it("does not count 'there is no agent here' as a degrade on an install with no agent", async () => {
    // Every firing on such an install ships the plain banner, so counting them
    // makes the number equal to the day's firings — which reads as an outage
    // and is really a configuration. Nothing is failing and there is nothing
    // for the operator to fix, so it does not accumulate into an alarm.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);

    await deliveringHost({ degraded: "no-agent" }).evaluate();

    expect(deliveringHost({ agentIntegration: false }).deliveryToday().degraded).toBe(0);
    // The row is untouched — this firing's own account of why its banner was
    // the plain one is still exactly true.
    expect(WatchStateStore.on(hostDb, "watch.db").deliveries("w-1")[0]?.degraded).toBe("no-agent");
    // And on an install that *does* have one, the same class is a real degrade:
    // an agent that was there and did not answer.
    expect(deliveringHost({ agentIntegration: true }).deliveryToday().degraded).toBe(1);
  });

  it("keeps the cap and outcome on the attempt's local day when delivery crosses midnight", async () => {
    const beforeMidnight = new Date(2026, 4, 14, 23, 59, 59).getTime();
    const afterMidnight = new Date(2026, 4, 15, 0, 0, 1).getTime();
    let now = beforeMidnight;
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);

    await deliveringHost({
      degraded: "no-agent",
      now: () => now,
      afterSend: () => {
        now = afterMidnight;
      },
    }).evaluate();

    const previousDay = deliveringHost({
      now: () => beforeMidnight,
      agentIntegration: true,
    });
    expect(previousDay.attemptedToday("w-1")).toBe(1);
    expect(previousDay.deliveryToday().degraded).toBe(1);
    expect(WatchStateStore.on(hostDb, "watch.db").deliveries("w-1")[0]?.at).toBe(
      new Date(beforeMidnight).toISOString(),
    );

    const nextDay = deliveringHost({ now: () => afterMidnight, agentIntegration: true });
    expect(nextDay.attemptedToday("w-1")).toBe(0);
    expect(nextDay.deliveryToday().degraded).toBe(0);
  });

  it.each([
    ["Europe/London", "2026-08-16T23:30:00.000Z"],
    ["America/Los_Angeles", "2026-08-17T00:30:00.000Z"],
  ])("reports the local day's outcome when its UTC date differs in %s", async (timezone, iso) => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = timezone;
    try {
      const attemptedAt = Date.parse(iso);
      journal.commit({
        events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")],
      });
      addWatch(await delivering(), 0);

      const running = deliveringHost({
        degraded: "no-agent",
        now: () => attemptedAt,
        agentIntegration: true,
      });
      await running.evaluate();

      expect(running.attemptedToday("w-1")).toBe(1);
      expect(running.deliveryToday().degraded).toBe(1);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("leaves the degrade column empty when nothing was lost", async () => {
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);

    await deliveringHost().evaluate();

    const state = WatchStateStore.on(hostDb, "watch.db");
    expect(state.deliveries("w-1")[0]?.degraded).toBeNull();
    expect(deliveringHost().deliveryToday().degraded).toBe(0);
  });

  it("records a delivery that worked, keyed by the firing it was for", async () => {
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);

    await deliveringHost().evaluate();

    const state = WatchStateStore.on(hostDb, "watch.db");
    const rows = state.deliveries("w-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivered).toBe(1);
    expect(rows[0]?.error).toBeNull();
    // Keyed on the firing's full identity, so two firings of one pass keep two
    // answers rather than overwriting each other.
    expect(rows[0]?.seq).toBeTypeOf("number");
    expect(rows[0]?.nodeId.length).toBeGreaterThan(0);
  });

  it("gives the day back at the operator's midnight, not at UTC's", async () => {
    // A cap bounds how often a person is interrupted, which is a claim about
    // *their* day. Keyed on UTC, an operator west of it gets their allowance
    // back in the afternoon, and an evening bills to a different day from the
    // morning after it.
    //
    // All three instants below are the same UTC day and straddle a local
    // midnight, so the third one is the whole test: under UTC keying it shares
    // its allowance with the first and would be suppressed.
    const previous = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      // 20:00, then 23:30, then 00:30 the next morning, in that zone.
      let at = Date.parse("2026-03-05T04:00:00Z");
      journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
      addWatch(await delivering(), 0);
      await deliveringHost({ caps: { perWatchDailyCap: 1 }, now: () => at }).evaluate();
      expect(SENT).toHaveLength(1);

      at = Date.parse("2026-03-05T07:30:00Z");
      journal.commit({ events: [mail(2, "d1111111-0000-4000-8000-000000000002", "two")] });
      const same = await deliveringHost({
        caps: { perWatchDailyCap: 1 },
        now: () => at,
      }).evaluate();
      expect(same.suppressed, "the allowance came back inside one evening").toBe(1);

      at = Date.parse("2026-03-05T08:30:00Z");
      journal.commit({ events: [mail(3, "d1111111-0000-4000-8000-000000000003", "three")] });
      const next = await deliveringHost({
        caps: { perWatchDailyCap: 1 },
        now: () => at,
      }).evaluate();
      expect(next.delivered, "a new local day did not restore the allowance").toBe(1);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("hands the transport what was asked for, never what the watch found", async () => {
    // The firing's payload is corpus — a subject line, a correspondent, an
    // amount — and none of it belongs in what the host composes. The transport
    // may go on to say more (a firing the agent wrote about quotes its opening
    // sentence), but that is its decision to make and its bounds to state;
    // what leaves here is the operator's own request.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    const dsl = (await delivering()) as { watch: Record<string, unknown> };
    dsl.watch.nl_query = "Tell me when Maya writes";
    addWatch(dsl, 0);

    await deliveringHost().evaluate();

    expect(SENT[0]?.body).toBe("Tell me when Maya writes");
    expect(SENT[0]?.body, "a payload value reached the banner").not.toContain("d1111111");
    expect(SENT[0]?.title, "the banner named the watch on a lock screen").toBe("Omnesis");
    // The request travels beside the copy, because the two can differ: an
    // author may write their own banner text, and an agent briefed on that
    // instead of on what was asked would be briefed on the wrong thing.
    expect(SENT[0]?.condition).toBe("Tell me when Maya writes");
    expect(SENT[0]?.authoredCopy, "copy nobody wrote read as authored").toEqual({});
  });

  it("keeps the author's own banner copy distinguishable from the composed default", async () => {
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    const dsl = (await delivering()) as { watch: Record<string, unknown> };
    dsl.watch.nl_query = "Tell me when Maya writes";
    (dsl.watch.delivery as Record<string, unknown>).body = "Someone wrote to you.";
    addWatch(dsl, 0);

    await deliveringHost().evaluate();

    expect(SENT[0]?.body).toBe("Someone wrote to you.");
    expect(SENT[0]?.authoredCopy).toEqual({ body: "Someone wrote to you." });
    // Still the request, not the copy: the two answer different questions.
    expect(SENT[0]?.condition).toBe("Tell me when Maya writes");
  });

  it("gives every firing of one pass its own identity", async () => {
    // The deep-link key names a line of the ledger and can repeat within a
    // pass; the identity cannot, because the store is unique on all four of
    // its components. Anything that must tell two firings apart — which
    // conversation a banner is about — has to key on the second.
    journal.commit({
      events: [
        mail(1, "d1111111-0000-4000-8000-000000000001", "one"),
        mail(2, "d1111111-0000-4000-8000-000000000002", "two"),
      ],
    });
    addWatch(await delivering(), 0);

    await deliveringHost().evaluate();

    const ids = SENT.map((n) => n.firingId);
    expect(new Set(ids).size, "two firings shared one identity").toBe(ids.length);
    for (const sent of SENT) {
      expect(sent.firingId.startsWith(`${sent.firingKey}:`)).toBe(true);
    }
  });

  it("notifies once per firing, not once per pass", async () => {
    // A gateway evaluates every few seconds forever, so most passes read
    // nothing. Delivery is driven by the trace's firings rather than by the
    // watch being active, and this is what holds that line: anything that
    // notified per pass would interrupt someone every few seconds about a
    // firing that happened once.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);
    const running = deliveringHost();

    await running.evaluate();
    expect(SENT).toHaveLength(1);

    // Three more passes over the same journal, which is what a quiet gateway
    // does every few seconds for the rest of the day.
    await running.evaluate();
    await running.evaluate();
    await running.evaluate();

    expect(SENT, "a quiet pass notified about an old firing").toHaveLength(1);
    expect(running.attemptedToday("w-1"), "the allowance was spent by doing nothing").toBe(1);
  });

  it("does not give the day back when a watch is removed", async () => {
    // The count is a ledger of how often a person has been interrupted today,
    // not state belonging to the watch. Clearing it on removal would hand every
    // other watch its allowance back because one was deleted.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);
    const running = deliveringHost();
    await running.evaluate();
    expect(running.deliveryToday().attempted).toBe(1);

    running.forget("w-1");

    expect(running.deliveryToday().attempted, "removing a watch un-capped the day").toBe(1);
  });

  it("keeps running when the install has no push wired at all", async () => {
    // An operator can turn delivery on before APNs is configured. That is a
    // thing to say out loud, not a reason to stop the watch.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await delivering(), 0);

    const result = await host().evaluate();

    expect(result.firings).toBe(1);
    expect(result.delivered).toBe(0);
    expect(definitions.get("w-1")?.status, "an unwired push stopped the watch").toBe("active");
  });
});

/**
 * Firing a watch by hand.
 *
 * A watch's condition is the half you can read. The other half — the caps, the
 * transport, the anchor, whatever the delivery block names — only runs when
 * the world produces the condition, so a delivery path that is broken stays
 * broken silently until the day it was needed.
 *
 * The properties here are the ones that keep that from costing more than it
 * proves: it must never be counted as something the watch caught, it must not
 * collide with an organic firing, and it must not touch the watch's own state.
 */
describe("firing a watch by hand", () => {
  const SENT: WatchNotification[] = [];

  function firingHost(overrides: { caps?: Partial<DeliveryCaps> } = {}): WatchEngineHost {
    return new WatchEngineHost({
      db: hostDb,
      journal,
      definitions,
      analytics: NO_ANALYTICS,
      judge: NEVER_ASKED,
      recall: { score: () => 0 },
      traces: new WatchTraceStore(hostDb),
      writes: new WriteLease(),
      ontology: { db, analyticsDb: null, semanticallyIndexed: () => true },
      delivery: () => ({
        send: (notification) => {
          SENT.push(notification);
          return Promise.resolve({ delivered: 1 });
        },
      }),
      ...(overrides.caps ? { deliveryCaps: overrides.caps } : {}),
    });
  }

  async function deliveringWatch(): Promise<Record<string, unknown>> {
    const dsl = fromAlice(await fingerprint()) as { watch: Record<string, unknown> };
    dsl.watch.delivery = { kind: "omnesis-notify" };
    return dsl;
  }

  beforeEach(() => {
    SENT.length = 0;
  });

  it("runs the delivery path without evaluating anything", async () => {
    // The whole point: no journal event, no node armed, no judge asked — and a
    // notification all the same. `NEVER_ASKED` throws if the judge is reached,
    // so the absence of judge spend is enforced rather than asserted.
    addWatch(await deliveringWatch(), 0);

    const result = await firingHost().fireByHand("w-1");

    expect(result).toMatchObject({ outcome: "fired", delivered: 1, suppressed: 0 });
    expect(SENT).toHaveLength(1);
    expect(SENT[0]?.watchName).toBe("alice-writes");
  });

  it("records the firing as forced, so it is never counted as a catch", async () => {
    // A watch credited with catching something it never saw is a watch that
    // looks like it works.
    addWatch(await deliveringWatch(), 0);

    await firingHost().fireByHand("w-1");

    const state = WatchStateStore.on(hostDb, "watch.db");
    const recorded = state.firings("w-1");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.forced).toBe(true);
    const records = new WatchTraceStore(hostDb).recent("w-1");
    expect(records.map((r) => r.transition)).toContain("forced");
  });

  it("cannot collide with a firing the runtime reached on its own", async () => {
    // The firings table is INSERT OR IGNORE on (watch, seq, node, key), so a
    // forced firing reusing an organic identity would be silently dropped —
    // and the deliveries table upserts on the same tuple, so it would
    // overwrite what the real firing recorded.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await deliveringWatch(), 0);
    await firingHost().evaluate();

    await firingHost().fireByHand("w-1");
    await firingHost().fireByHand("w-1");

    const seqs = WatchStateStore.on(hostDb, "watch.db")
      .firings("w-1")
      .map((f) => f.seq);
    expect(new Set(seqs).size, "two firings shared a sequence").toBe(seqs.length);
    // The forced ones come from the timer counter, which only ever goes down.
    expect(seqs.filter((seq) => seq < 0)).toHaveLength(2);
  });

  it("refuses a watch that delivers nowhere rather than recording a firing", async () => {
    // `deliver()` returns immediately for a watch with no delivery block, so a
    // firing forced into one would be a row, a trace and a reported success
    // with nothing having gone anywhere — which reads as a broken path.
    addWatch(fromAlice(await fingerprint()), 0);

    expect(await firingHost().fireByHand("w-1")).toEqual({ outcome: "delivers-nowhere" });
    expect(WatchStateStore.on(hostDb, "watch.db").firings("w-1")).toEqual([]);
    expect(SENT).toEqual([]);
  });

  it("answers for a watch that is not there", async () => {
    expect(await firingHost().fireByHand("no-such-watch")).toEqual({ outcome: "no-watch" });
  });

  it("refuses a watch the runtime is not running", async () => {
    // Paused means held. An operator who paused a watch because it was wrong
    // would not expect it to interrupt them — and a retired watch has had its
    // anchor swept, so a wake would report an attempt with nothing delivered
    // and read as a broken transport rather than as a watch that is over.
    addWatch(await deliveringWatch(), 0);
    definitions.setStatus("w-1", "paused", "an operator held it");

    expect(await firingHost().fireByHand("w-1")).toEqual({
      outcome: "not-active",
      status: "paused",
    });
    expect(SENT).toEqual([]);
  });

  it("is not counted among what the watch has caught", async () => {
    // The listing's number is read as "what this watch has found". A watch
    // credited with catching something it never saw is a watch that looks like
    // it works — so the count is organic firings, and the detail view lists
    // the forced ones marked, which is what reconciles the two.
    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-000000000001", "one")] });
    addWatch(await deliveringWatch(), 0);
    const host = firingHost();
    await host.evaluate();

    await host.fireByHand("w-1");

    expect(WatchStateStore.on(hostDb, "watch.db").firings("w-1")).toHaveLength(2);
    expect(host.firingCount("w-1"), "a forced firing was counted as a catch").toBe(1);
  });

  it("says why nothing arrived, rather than leaving it on a row", async () => {
    // Finding out that the transport is not wired is the answer an operator
    // runs this to get. Reporting `delivered: 0` and nothing else sends them
    // to look for a reason on a surface they have to know exists.
    addWatch(await deliveringWatch(), 0);
    const host = new WatchEngineHost({
      db: hostDb,
      journal,
      definitions,
      analytics: NO_ANALYTICS,
      judge: NEVER_ASKED,
      recall: { score: () => 0 },
      traces: new WatchTraceStore(hostDb),
      writes: new WriteLease(),
      ontology: { db, analyticsDb: null, semanticallyIndexed: () => true },
      delivery: () => ({
        send: () =>
          Promise.resolve({ delivered: 0, attempted: 0, error: "no push transport is configured" }),
      }),
    });

    const result = await host.fireByHand("w-1");

    expect(result).toMatchObject({
      outcome: "fired",
      delivered: 0,
      suppressed: 0,
      error: "no push transport is configured",
    });
  });

  it("carries the payload the operator chose", async () => {
    addWatch(await deliveringWatch(), 0);

    await firingHost().fireByHand("w-1", { payload: { note: "checking the path" } });

    expect(WatchStateStore.on(hostDb, "watch.db").firings("w-1")[0]?.payload).toEqual({
      note: "checking the path",
    });
  });

  it("still honours the daily cap, and says the cap is why", async () => {
    // The caps are what `deliver()` does, and this runs `deliver()` as it is.
    // A forced firing that ignored them would not be exercising the path it
    // claims to prove — and a cap that stopped one in silence would read as
    // the path being broken.
    addWatch(await deliveringWatch(), 0);
    const host = firingHost({ caps: { perWatchDailyCap: 1, dailyCap: 10 } });

    expect(await host.fireByHand("w-1")).toMatchObject({ delivered: 1, suppressed: 0 });
    const second = await host.fireByHand("w-1");

    expect(second).toMatchObject({ delivered: 0, suppressed: 1 });
    expect(SENT, "the cap was spent and something was still sent").toHaveLength(1);
    const records = new WatchTraceStore(hostDb).recent("w-1");
    expect(records.some((r) => r.transition === "suppressed")).toBe(true);
  });

  it("leaves the watch's own state exactly as it was", async () => {
    // A `once_ever` watch is retired by the engine when it fires. Forcing one
    // must not retire the operator's real watch as a side effect of a test,
    // and the cursor must not move: a stalled runtime made to look alive is
    // the failure the liveness alarm exists to catch.
    const dsl = (await deliveringWatch()) as { watch: Record<string, unknown> };
    dsl.watch.firing_policy = "once_ever";
    addWatch(dsl, 0);
    const before = WatchStateStore.on(hostDb, "watch.db").cursor("w-1");

    await firingHost().fireByHand("w-1");

    expect(definitions.get("w-1")?.status).toBe("active");
    expect(WatchStateStore.on(hostDb, "watch.db").cursor("w-1")).toBe(before);
  });
});

describe("reading what a watch is holding", () => {
  /**
   * A wait keyed by thread, opening a parallel instance per arm.
   *
   * `spawn` is what makes the fixture multi-cell inside one key: two mails on
   * one thread leave two live instances, and a reading that collapsed them
   * would look identical to a correct one on a single-instance fixture.
   */
  function threadWait(fingerprint: string): unknown {
    return {
      watch: {
        name: "quiet-thread",
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
              people: [{ role: "sender", person: ALICE }],
            },
            output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
          },
          {
            id: "hold",
            type: "stateful.wait",
            inputs: { mail: { role: "arm", key: { thread_id: ".thread_id" } } },
            on_collision: "spawn",
            max_live_instances: 3,
            duration: "6 days",
            output_map: { doc: "$n.mail.doc_id" },
          },
        ],
        sink: { input: "hold", output_map: { doc: "$n.hold.doc" } },
      },
    };
  }

  /** The moment the host is told it is, so the fixture's deadlines are ahead. */
  const NOW = Date.parse("2026-03-10T09:00:00Z");

  function mailOn(thread: string, hoursAgo: number, docId: string): NewJournalEvent {
    const at = new Date(NOW - hoursAgo * 3_600_000).toISOString();
    return {
      kind: "doc.event",
      occurredAt: at,
      observedAt: at,
      payload: {
        op: "created",
        docId,
        sourceId: "gmail",
        providerId: "google",
        documentType: "email",
        title: `message ${docId.slice(-1)}`,
        semanticTime: at,
        changedFields: [],
        contentChanged: true,
        metadata: { extra: { threadId: thread } },
        people: [
          { personId: ALICE, role: "sender", isSelf: false },
          { personId: SELF, role: "recipient", isSelf: true },
        ],
      },
    };
  }

  /** A lease that counts its turns, so "took one" is assertable. */
  function countingLease(): { lease: WriteLease; turns: () => number } {
    const lease = new WriteLease();
    const run = lease.run.bind(lease);
    let turns = 0;
    Object.assign(lease, {
      run: <T>(work: () => Promise<T>): Promise<T> => {
        turns += 1;
        return run(work);
      },
    });
    return { lease, turns: () => turns };
  }

  async function runningHost(): Promise<{ engine: WatchEngineHost; turns: () => number }> {
    journal.commit({
      events: [
        mailOn("alder", 5, "d2222222-0000-4000-8000-000000000001"),
        mailOn("alder", 4, "d2222222-0000-4000-8000-000000000002"),
        mailOn("birch", 3, "d2222222-0000-4000-8000-000000000003"),
      ],
    });
    addWatch(threadWait(await fingerprint()), 0);
    const counting = countingLease();
    const engine = host({ now: () => NOW, writes: counting.lease });
    await engine.evaluate();
    return { engine, turns: counting.turns };
  }

  it("holds three cells over two keys, and says so per node", async () => {
    const { engine } = await runningHost();
    const result = await engine.stateSnapshot("w-1", 50);
    expect(result.outcome).toBe("read");
    if (result.outcome !== "read") return;

    const nodes = new Map(result.snapshot.nodes.map((node) => [node.nodeId, node]));
    // The trip-wire holds nothing and is still listed: "holds nothing" and "is
    // not in this watch" must not read the same on the canvas.
    expect(nodes.get("mail")?.cells).toEqual([]);
    const hold = nodes.get("hold")!;
    expect(hold.cells).toHaveLength(3);
    const threads = hold.cells.map((cell) => cell.key.thread_id);
    expect(threads.filter((thread) => thread === "alder")).toHaveLength(2);
    expect(threads.filter((thread) => thread === "birch")).toHaveLength(1);
    // One key, two instances: the ordinals are what tell them apart.
    const alder = hold.cells.filter((cell) => cell.key.thread_id === "alder");
    expect(new Set(alder.map((cell) => cell.keyHash)).size).toBe(1);
    expect(alder.map((cell) => cell.instance).sort()).toEqual([0, 1]);
  });

  it("cuts the snapshot at the cursor, with the journal head beside it", async () => {
    const { engine } = await runningHost();
    const result = await engine.stateSnapshot("w-1", 50);
    if (result.outcome !== "read") throw new Error("expected a reading");

    // The watch has consumed the whole journal, so the two agree — and the
    // head can never be behind the cursor whatever the watch has read.
    expect(result.snapshot.asOfSeq).toBe(journal.head());
    expect(result.journalHead).toBeGreaterThanOrEqual(result.snapshot.asOfSeq);
    // Every timer belongs to a cell the same reading returned. A snapshot that
    // mixed two moments is exactly what this would catch.
    const cells = new Set(
      result.snapshot.nodes.flatMap((node) =>
        node.cells.map((cell) => `${node.nodeId}:${cell.keyHash}:${cell.instance}`),
      ),
    );
    expect(result.snapshot.timers).toHaveLength(3);
    for (const timer of result.snapshot.timers) {
      expect(cells.has(`${timer.nodeId}:${timer.keyHash}:${timer.instance}`)).toBe(true);
    }
  });

  it("takes a write turn, so it cannot land inside a half-applied event", async () => {
    const { engine, turns } = await runningHost();
    const before = turns();
    await engine.stateSnapshot("w-1", 50);
    expect(turns(), "the state read went around the lease").toBeGreaterThan(before);
  });

  it("refuses a watch this build cannot parse rather than reporting it empty", async () => {
    addWatch({ watch: { name: "nonsense", nodes: "not a list" } }, 0, "w-broken");
    const result = await host({ now: () => NOW }).stateSnapshot("w-broken", 50);
    // Reporting "no live state" here would be a lie in the one direction that
    // matters: the runtime may well be holding cells for it.
    expect(result.outcome).toBe("unreadable");
  });

  it("says so when there is no such watch", async () => {
    const result = await host({ now: () => NOW }).stateSnapshot("w-missing", 50);
    expect(result.outcome).toBe("no-watch");
  });
});

/**
 * What the host counts as held, over its own definitions.
 *
 * The store can tell a husk from a live cell only if it is told how each node
 * type reads its own; the host is the only place those readings are derived
 * from the stored definitions, and handing the store none would silently
 * restore the count that included husks.
 */
describe("the host's own reading of what is held", () => {
  /** A cooldown, so the fixture leaves a cell that stops holding on the clock. */
  function cooldownWatch(stamp: string): unknown {
    return {
      watch: {
        name: "at-most-daily",
        firing_policy: "stays_active",
        ontology_fingerprint: stamp,
        nodes: [
          {
            id: "mail",
            type: "source.document_event",
            filter: {
              source: "gmail",
              event: ["created"],
              documentType: "email",
              people: [{ role: "sender", person: ALICE }],
            },
            output_map: { thread_id: "$e.metadata.extra.threadId", doc_id: "$e.docId" },
          },
          {
            id: "cool",
            type: "stateful.cooldown",
            inputs: { mail: { role: "arm", key: { thread_id: ".thread_id" } } },
            min_interval: "1 day",
            output_map: { doc: "$n.mail.doc_id" },
          },
        ],
        sink: { input: "cool", output_map: { doc: "$n.cool.doc" } },
      },
    };
  }

  it("stops counting a cooldown stamp once its interval has elapsed", async () => {
    const fired = Date.parse("2026-03-01T09:00:00Z");
    const stamped = new Date(fired).toISOString();
    journal.commit({
      events: [
        {
          kind: "doc.event",
          occurredAt: stamped,
          observedAt: stamped,
          payload: {
            op: "created",
            docId: "d1111111-0000-4000-8000-00000000000a",
            sourceId: "gmail",
            providerId: "google",
            documentType: "email",
            title: "message a",
            semanticTime: stamped,
            changedFields: [],
            contentChanged: true,
            metadata: { extra: { threadId: "alder" } },
            people: [
              { personId: ALICE, role: "sender", isSelf: false },
              { personId: SELF, role: "recipient", isSelf: true },
            ],
          },
        },
      ],
    });
    addWatch(cooldownWatch(await fingerprint()), 0);

    // Evaluated on the day it fired: the stamp genuinely suppresses.
    const suppressing = host({ now: () => fired + 3_600_000 });
    await suppressing.evaluate();
    expect((await suppressing.liveState()).held.get("w-1")).toMatchObject({
      keys: 1,
      holdingKeys: 1,
    });

    // Read a week later. Nothing about the watch changed; the stamp suppresses
    // nothing now, and a list saying it is tracking one thing would be false.
    const spent = host({ now: () => fired + 7 * 86_400_000 });
    expect((await spent.liveState()).held.get("w-1")).toMatchObject({
      keys: 1,
      holdingKeys: 0,
    });
  });
});

/**
 * A judge that writes something down before it answers.
 *
 * The live judge records what it decided on the admin connection, and takes the
 * shared write turn to do it — the engine and the materializer write that file
 * too, and the one that loses a race blocks the whole event loop inside
 * SQLite's busy handler rather than yielding. That is only safe because the
 * engine fetches an off-host answer with nothing open and no turn held; the
 * attempt unwinds first and runs again with the answer in hand. If it ever
 * asked while holding the turn, the judge's own write would queue behind the
 * evaluation waiting for it, and the gateway would stop rather than fail.
 */
describe("a judge that takes the write turn before answering", () => {
  it("does not deadlock against the evaluation that asked it", async () => {
    const writes = new WriteLease();
    const running = new WatchEngineHost({
      db: hostDb,
      journal,
      definitions,
      analytics: NO_ANALYTICS,
      judge: {
        judge: () =>
          writes.run(() => Promise.resolve({ fired: true, output: { because: "it is" } })),
      },
      recall: { score: () => 1 },
      traces: new WatchTraceStore(hostDb),
      writes,
      ontology: { db, analyticsDb: null, semanticallyIndexed: () => true },
    });

    const docId = "d1111111-0000-4000-8000-000000000009";
    journal.commit({
      events: [
        mail(1, docId, "one"),
        {
          kind: "doc.indexed",
          occurredAt: at(1),
          observedAt: at(1),
          payload: { docId, eventIndexedAt: at(1) },
        },
      ],
    });
    const dsl = fromAlice(await fingerprint()) as { watch: { nodes: Record<string, unknown>[] } };
    dsl.watch.nodes[0]!.recall = { semantic: { query: "anything", threshold: 0.1 } };
    dsl.watch.nodes[0]!.judge = {
      proposition: "it is about anything",
      output_schema: { because: "string" },
    };
    addWatch(dsl, 0);

    // Resolved rather than hung: a deadlock here has no error to report, so the
    // race is against the suite's own timeout.
    const result = await running.evaluate();

    expect(result.firings, "the judged watch produced nothing").toBe(1);
  });
});

/**
 * A node that throws while the evaluation holds the write turn.
 *
 * Pausing is the one effect of a failure that has to survive the rollback that
 * takes everything else back, so it is a write — and every write to this file
 * takes the turn. The turn is a FIFO queue and is deliberately not reentrant:
 * taking it from inside a section that already holds it queues the taker behind
 * itself. Applying the pause from inside the attempt therefore does not fail:
 * it hangs, holding the lease as it does, so materialization, evaluation and
 * every watch admin route stop with it until the process restarts.
 *
 * The engine's own suites cannot see this: absent a host, `serializeWrites`
 * defaults to running the section directly, and a pass-through turn is reentrant
 * by construction. Only the real lease reproduces it, which is why this case
 * lives here.
 */
describe("a node that throws inside the write turn", () => {
  /** Analytics that refuse, so the `sql` node fails where the turn is held. */
  const BROKEN_ANALYTICS: AnalyticsPort = {
    query: () => Promise.reject(new Error("the catalog moved")),
  };

  /** Alice's mail, then a predicate over it that cannot be answered. */
  function brokenPredicate(fp: string): unknown {
    const dsl = fromAlice(fp, "predicate-that-throws") as {
      watch: { nodes: Record<string, unknown>[]; sink: Record<string, unknown> };
    };
    dsl.watch.nodes[0]!.output_map = {
      doc_id: "$e.docId",
      thread_id: "$e.metadata.extra.threadId",
    };
    dsl.watch.nodes.push({
      id: "check",
      type: "sql",
      inputs: { mail: { role: "arm", key: { thread_id: ".thread_id" } } },
      query: "SELECT true AS fires",
      output_map: {},
    });
    dsl.watch.sink = { input: "check", output_map: {} };
    return dsl;
  }

  /**
   * A deadline the deadlock loses against.
   *
   * A wedged lease has no error to raise — the evaluation simply never settles
   * — so the only way to read one is to stop waiting. Generous rather than
   * tight: what is being distinguished is "finished" from "never finishes", and
   * a budget so small that a loaded box can exceed it turns a precise message
   * into a misleading one.
   */
  const SETTLE_BUDGET_MS = 5_000;

  /** Resolve to `stalled` if `work` has not settled inside the budget. */
  function within<T>(work: Promise<T>, stalled: T): Promise<T> {
    let timer: NodeJS.Timeout;
    const deadline = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(stalled), SETTLE_BUDGET_MS);
      // Nothing should be kept alive by a deadline that was not needed.
      timer.unref();
    });
    return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
  }

  it("applies the pause and leaves the lease free for the next turn", async () => {
    const writes = new WriteLease();
    const running = host({ writes, analytics: BROKEN_ANALYTICS });

    journal.commit({ events: [mail(1, "d1111111-0000-4000-8000-00000000000a", "one")] });
    addWatch(brokenPredicate(await fingerprint()), 0);

    const settled = await within(
      running.evaluate().then(() => "evaluated" as const),
      "wedged" as const,
    );
    expect(settled, "the pause never returned — the write turn is wedged").toBe("evaluated");

    // The pause landed, durably. Read off the watch's own state row rather
    // than off its definition status: the status is written from the trace,
    // which a failure fills whether or not the pause was ever applied, so it
    // would report a pause that no restart would find.
    const failure = running.failure("w-1");
    expect(failure?.nodeId, "the node that threw was not recorded").toBe("check");
    expect(failure?.failure).toBe("query");

    // And the lease is free. Anything queued behind the failed attempt runs.
    const after = await within(
      writes.run(() => Promise.resolve("free" as const)),
      "held" as const,
    );
    expect(after, "the failed attempt never released the write turn").toBe("free");

    // The next tick runs rather than hanging behind it — the whole point of
    // containing the failure to the watch that caused it.
    const next = await within(running.evaluate(), null);
    expect(next, "the tick after the pause never completed").not.toBeNull();
  });
});
