// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the materializer has to get right, and what happens when it doesn't.
 *
 * Each case here is the gateway half of a journal commitment: a document that
 * waits for its people, a row that arrives twice and counts once, a source
 * reconnecting and saying nothing, a gap after a crash. All of them are silent
 * failures on the shipped path — the wrong behaviour produces a watch that
 * wakes too often or not at all, with no error anywhere and nothing to read
 * except the firings themselves.
 *
 * The crash cases in particular are written the way a crash actually happens:
 * the in-memory queue is thrown away, and the only route back to a lost
 * document is the recovery sweep. A test that keeps the queue between drains
 * proves the queue works, which nobody doubted.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { ANALYTICS_STREAM_COLUMN } from "@omnesis/source-sdk";
import { runSchemaSetup } from "../data/schema.js";
import { Materializer, type JournalTableSchema } from "./materializer.js";
import { capture, MaterializerQueue } from "./queue.js";
import { WatchJournalStore } from "./store.js";
import type { Db } from "../data/types.js";
import type { DocumentProjection, DocumentUpsertedEvent } from "../events.js";
import type { QueuedDocument } from "./queue.js";
import type { DocumentEventProfile } from "@omnesis/source-sdk";

/** The reserved column the store keys a partitioned source's rows by. */
const STREAM = ANALYTICS_STREAM_COLUMN;

const SELF = "0a1b2c3d-0000-4000-8000-000000000001";
const ALICE = "b3f2a9d4-0000-4000-8000-000000000002";

/** Gmail's declaration, trimmed to what these cases exercise. */
const GMAIL_PROFILE: DocumentEventProfile = {
  documentTypes: ["email"],
  personRoles: ["sender", "recipient"],
  metadataFields: [
    { path: "tags", type: "string-array", description: "labels" },
    { path: "extra.threadId", type: "string", description: "conversation id" },
  ],
};

/** A transactions table with one bookkeeping column the source declared. */
const TRANSACTIONS: JournalTableSchema & { tableName: string } = {
  tableName: "plaid_transactions",
  columns: [
    { name: "id", type: "VARCHAR", description: "row id" },
    { name: "amount", type: "DOUBLE", description: "amount" },
    { name: "transacted_at", type: "TIMESTAMPTZ", description: "when" },
    { name: "fetched_at", type: "TIMESTAMPTZ", description: "stamp", volatile: true },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "transacted_at",
};

let dir: string;
let db: Db;
let store: WatchJournalStore;
let queue: MaterializerQueue;
let clock: number;

function projection(overrides: Partial<DocumentProjection> = {}): DocumentProjection {
  return {
    id: randomUUID(),
    providerId: "google",
    sourceId: "gmail",
    externalId: "msg-1",
    documentType: "email",
    title: "Spring works — revised quote",
    contentHash: "hash-1",
    metadata: {
      documentType: "email",
      tags: ["INBOX"],
      extra: { threadId: "t-1" },
      secretsNobodyDeclared: "should not reach the journal",
    },
    sourceCreatedAt: "2026-03-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-03-01T09:00:00.000Z",
    people: [{ role: "sender", personId: null }],
    ...overrides,
  };
}

/** Write the document row the materializer will read back. */
function insertDocument(
  after: DocumentProjection,
  peopleResolved: boolean,
  updatedAt = "2026-03-01T09:00:00.000Z",
): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
                            metadata, source_created_at, source_updated_at, ingested_at, updated_at,
                            people_resolved_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    after.id,
    after.providerId,
    after.sourceId,
    after.externalId,
    after.title,
    after.contentHash,
    JSON.stringify(after.metadata),
    after.sourceCreatedAt,
    after.sourceUpdatedAt,
    "2026-03-01T09:00:00.000Z",
    updatedAt,
    peopleResolved ? "2026-03-01T09:00:01.000Z" : null,
  );
}

function resolvePeople(docId: string): void {
  db.prepare("UPDATE documents SET people_resolved_at = ? WHERE id = ?").run(
    "2026-03-01T09:00:06.000Z",
    docId,
  );
}

function insertPerson(id: string, name: string, isSelf: boolean, mergedInto?: string): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, merged_into, source, is_self, first_seen, last_seen,
                         created_at, updated_at)
     VALUES (?, ?, ?, 'test', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name, mergedInto ?? null, isSelf ? 1 : 0);
}

function link(docId: string, personId: string, role: string): void {
  db.prepare(
    "INSERT INTO document_people (document_id, person_id, role, source_id) VALUES (?, ?, ?, 'gmail')",
  ).run(docId, personId, role);
}

/** What the bus hands a handler, reduced the way the handler reduces it. */
function upserted(after: DocumentProjection, before: DocumentProjection | null): QueuedDocument {
  const event: DocumentUpsertedEvent = {
    before,
    after,
    afterContent: "",
    changedFields: before ? ["metadata"] : [],
    contentChanged: before === null,
  };
  return capture(event, clock);
}

function build(
  overrides: {
    settlementMs?: number;
    batchSize?: number;
    analyticsOutbox?: ConstructorParameters<typeof Materializer>[0]["analyticsOutbox"];
  } = {},
): Materializer {
  return new Materializer({
    db,
    indexDb: null,
    store,
    queue,
    tableSchema: (table) => Promise.resolve(table === TRANSACTIONS.tableName ? TRANSACTIONS : null),
    documentProfile: (sourceType) => (sourceType === "gmail" ? GMAIL_PROFILE : null),
    now: () => clock,
    settlementMs: overrides.settlementMs ?? 60_000,
    ...(overrides.analyticsOutbox === undefined
      ? {}
      : { analyticsOutbox: overrides.analyticsOutbox }),
    ...(overrides.batchSize === undefined ? {} : { batchSize: overrides.batchSize }),
  });
}

/**
 * A materializer already past its startup sweep, so a later drain exercises the
 * steady state rather than first-boot behaviour.
 */
async function settled(overrides: Parameters<typeof build>[0] = {}): Promise<Materializer> {
  const materializer = build(overrides);
  const first = await materializer.drain();
  expect(first.recovered, "the fixture was not in the steady state").toBe(0);
  return materializer;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-watch2-"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  store = WatchJournalStore.open(join(dir, "watch.db"), null);
  queue = new MaterializerQueue();
  clock = Date.parse("2026-03-01T09:00:05.000Z");
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a document whose people have not settled", () => {
  it("waits rather than journaling an event nobody can key on", async () => {
    const after = projection();
    insertDocument(after, false);
    queue.pushDocument(upserted(after, null));

    const result = await build().drain();

    expect(result.documents, "an unpeopled document was journaled").toBe(0);
    expect(result.deferred, "the document was dropped rather than held").toBe(1);
    expect(store.count()).toBe(0);
  });

  it("journals it with canonical ids once they land", async () => {
    const after = projection();
    insertDocument(after, false);
    insertPerson(SELF, "Self", true);
    insertPerson(ALICE, "Maya Reeves", false);
    queue.pushDocument(upserted(after, null));

    const materializer = build();
    await materializer.drain();

    // Resolution completes between the two drains, which is exactly the race
    // the deferral exists for.
    resolvePeople(after.id);
    link(after.id, ALICE, "sender");
    link(after.id, SELF, "recipient");

    const result = await materializer.drain();
    expect(result.documents).toBe(1);

    const [event] = store.read(0, 10);
    if (event?.kind !== "doc.event") throw new Error("expected a document event");
    expect(event.payload.degraded, "a settled document was marked degraded").toBeUndefined();
    // Ordered by role, so the recipient (self) comes before the sender.
    expect(event.payload.people, "the journal did not carry the resolved people").toEqual([
      { personId: SELF, role: "recipient", isSelf: true },
      { personId: ALICE, role: "sender", isSelf: false },
    ]);
  });

  it("ships degraded once the deadline runs out, rather than waiting forever", async () => {
    const after = projection();
    insertDocument(after, false);
    queue.pushDocument(upserted(after, null));

    clock += 61_000;
    const result = await build().drain();

    expect(result.documents).toBe(1);
    expect(result.degraded).toBe(1);
    const [event] = store.read(0, 10);
    if (event?.kind !== "doc.event") throw new Error("expected a document event");
    expect(event.payload.degraded, "the event did not admit it was incomplete").toBe(true);
    expect(event.payload.people.every((p) => p.personId === null)).toBe(true);
  });

  it("follows a merge, so a watch bound to a person survives one", async () => {
    // The runtime re-canonicalizes at comparison time too, but a journal that
    // carried the pre-merge id would make every replay of it disagree with a
    // live run of the same events.
    const after = projection();
    insertDocument(after, true);
    insertPerson(ALICE, "Maya Reeves", false);
    const duplicate = "b3f2a9d4-0000-4000-8000-000000000009";
    insertPerson(duplicate, "M. Reeves", false, ALICE);
    link(after.id, duplicate, "sender");
    queue.pushDocument(upserted(after, null));

    await build().drain();
    const [event] = store.read(0, 10);
    if (event?.kind !== "doc.event") throw new Error("expected a document event");
    expect(event.payload.people[0]?.personId, "the journal kept a merged-away id").toBe(ALICE);
  });
});

describe("what a document event says happened", () => {
  it("calls a first sighting a creation and a revision an update", async () => {
    // `op` is the difference between "this arrived" and "this changed", and a
    // compiler is told to read an arrival request as `created` only. Getting
    // it wrong makes every arrival watch either silent or permanently noisy.
    const first = projection();
    insertDocument(first, true);
    queue.pushDocument(upserted(first, null));
    await build().drain();

    queue.pushDocument(upserted(first, projection({ id: first.id, contentHash: "hash-0" })));
    await build().drain();

    const ops = store.read(0, 10).map((e) => (e.kind === "doc.event" ? e.payload.op : e.kind));
    expect(ops, "a revision was journaled as a first sighting, or the other way round").toEqual([
      "created",
      "updated",
    ]);
  });

  it("holds the declared fields and nothing else", async () => {
    const after = projection();
    insertDocument(after, true);
    queue.pushDocument(upserted(after, null));

    await build().drain();
    const [event] = store.read(0, 10);
    if (event?.kind !== "doc.event") throw new Error("expected a document event");

    expect(event.payload.metadata).toEqual({ tags: ["INBOX"], extra: { threadId: "t-1" } });
    expect(event.payload.contentHash).toBe("hash-1");
    expect(
      event.payload.metadata["secretsNobodyDeclared"],
      "an undeclared field reached the journal, so a watch could depend on it",
    ).toBeUndefined();
  });

  it("says the document has no type when its source declared none", async () => {
    const after = projection({ documentType: null, metadata: { tags: [] } });
    insertDocument(after, true);
    queue.pushDocument(upserted(after, null));

    await build().drain();
    const [event] = store.read(0, 10);
    if (event?.kind !== "doc.event") throw new Error("expected a document event");
    expect(event.payload.documentType).toBeNull();
  });
});

describe("the same document event arriving more than once", () => {
  it("journals the first and drops an identical repeat", async () => {
    // The writer emits several change notifications for one change often
    // enough to matter: on a live day roughly one document event in twelve was
    // an exact repeat of the one before it — same op, same changed fields,
    // same people, same semantic time.
    const materializer = build();
    const doc = projection();
    insertDocument(doc);
    resolvePeople(doc.id);

    queue.pushDocument(upserted(doc, null));
    expect((await materializer.drain()).documents).toBe(1);

    queue.pushDocument(upserted(doc, null));
    const second = await materializer.drain();
    expect(second.documents, "an identical repeat was journaled again").toBe(0);
    expect(second.droppedRedeliveries).toBe(1);
    expect(store.read(0, 10).filter((e) => e.kind === "doc.event")).toHaveLength(1);
  });

  it("lets through anything that is not an exact repeat", async () => {
    // Exact duplicates only. Deciding that a *different* event is
    // uninteresting is nomination's job — the journal saying so would silently
    // remove a watch's ability to see it.
    const materializer = build();
    const doc = projection();
    insertDocument(doc);
    resolvePeople(doc.id);

    queue.pushDocument(upserted(doc, null));
    await materializer.drain();

    // Same document, but now an update carrying a changed field.
    queue.pushDocument(upserted(doc, doc));
    const second = await materializer.drain();
    expect(second.documents, "a genuine change was swallowed as a duplicate").toBe(1);
    expect(second.droppedRedeliveries).toBe(0);
  });

  it("recognises a repeat across a restart", async () => {
    // The hash is persisted, not held in memory: a process that forgot what it
    // had journaled would re-emit the first event after every restart.
    const first = build();
    const doc = projection();
    insertDocument(doc);
    resolvePeople(doc.id);
    queue.pushDocument(upserted(doc, null));
    expect((await first.drain()).documents).toBe(1);

    const afterRestart = build();
    queue.pushDocument(upserted(doc, null));
    const again = await afterRestart.drain();
    expect(again.documents, "a restart made an old event look new").toBe(0);
    expect(again.droppedRedeliveries).toBe(1);
  });

  it("does not treat a moved semantic time as a repeat", async () => {
    // The document's own clock is part of what an event says. Two events
    // identical in every other respect but naming different moments are two
    // different statements, and a hash that ignored the clock would silence
    // the second.
    const materializer = build();
    const doc = projection();
    insertDocument(doc);
    resolvePeople(doc.id);

    queue.pushDocument(upserted(doc, null));
    expect((await materializer.drain()).documents).toBe(1);

    const moved = { ...doc, sourceCreatedAt: "2026-03-02T09:00:00.000Z" };
    queue.pushDocument(upserted(moved, null));
    const second = await materializer.drain();
    expect(second.documents, "a document that moved in time was silenced").toBe(1);
    expect(second.droppedRedeliveries).toBe(0);
  });

  it("treats a drain of only duplicates as handled, not as empty", async () => {
    // A dropped duplicate is still a document accounted for. The drain reports
    // no new events, and the checkpoint it leaves must reflect a batch that was
    // handled rather than one that never arrived.
    const materializer = build();
    const doc = projection();
    insertDocument(doc, true);
    queue.pushDocument(upserted(doc, null));
    await materializer.drain();
    const afterFirst = store.getState("documents.checkpoint");
    expect(afterFirst).not.toBeNull();

    queue.pushDocument(upserted(doc, null));
    const second = await materializer.drain();
    expect(second.documents).toBe(0);
    expect(second.droppedRedeliveries).toBe(1);
    expect(second.deferred, "a duplicate was held back instead of handled").toBe(0);
    expect(store.getState("documents.checkpoint")).toBe(afterFirst);
  });

  it("keeps two different documents apart", async () => {
    // The hash is per document. Keying it any more loosely would let one
    // document's event suppress another's.
    const materializer = build();
    const one = projection();
    const two = projection({ externalId: "msg-2", title: one.title });
    insertDocument(one);
    insertDocument(two);
    resolvePeople(one.id);
    resolvePeople(two.id);

    queue.pushDocument(upserted(one, null));
    queue.pushDocument(upserted(two, null));
    expect((await materializer.drain()).documents).toBe(2);
  });
});

describe("analytics rows arriving more than once", () => {
  function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "txn-1",
      amount: 42.5,
      transacted_at: "2026-03-01T08:00:00.000Z",
      fetched_at: "2026-03-01T09:00:00.000Z",
      ...overrides,
    };
  }

  function push(r: Record<string, unknown>, backfill = false): void {
    queue.pushRow({
      at: clock,
      table: TRANSACTIONS.tableName,
      sourceId: "plaid",
      row: r,
      backfill,
    });
  }

  it("counts the first arrival and drops the redelivery", async () => {
    const materializer = build();
    push(row());
    expect((await materializer.drain()).rows).toBe(1);

    push(row());
    const second = await materializer.drain();
    expect(second.rows, "a re-synced row was journaled as news").toBe(0);
    expect(second.droppedRedeliveries).toBe(1);
  });

  it("stays quiet when only a bookkeeping column moved", async () => {
    // The observed failure: an enrichment pass clears and repopulates a fetch
    // stamp, and every rewrite reads as a change.
    const materializer = build();
    push(row());
    await materializer.drain();

    push(row({ fetched_at: "2026-03-02T04:00:00.000Z" }));
    const second = await materializer.drain();
    expect(second.rows, "bookkeeping churn woke the journal").toBe(0);
    expect(second.droppedRedeliveries).toBe(1);
  });

  it("reports a real change as an update, not another insert", async () => {
    const materializer = build();
    push(row());
    await materializer.drain();

    push(row({ amount: 51 }));
    await materializer.drain();

    const events = store.read(0, 10);
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.kind === "analytics.row" ? e.payload.op : e.kind))).toEqual([
      "inserted",
      "updated",
    ]);
  });

  it("says nothing when a source replays rows the journal has already seen", async () => {
    const materializer = build();
    push(row());
    await materializer.drain();

    // What a removed-and-re-added source does: the same rows come round again,
    // now flagged as history. The seen-hashes outlive the source, so they are
    // recognised.
    push(row(), true);
    const replay = await materializer.drain();
    expect(replay.rows, "a replayed row minted an event for a row already seen").toBe(0);
  });

  it("carries the backfill flag on rows the journal has genuinely not seen", async () => {
    push(row(), true);
    await build().drain();

    const [event] = store.read(0, 10);
    if (event?.kind !== "analytics.row") throw new Error("expected an analytics event");
    expect(event.payload.backfill).toBe(true);
    expect(event.occurredAt, "the row's own time was replaced by its arrival time").toBe(
      "2026-03-01T08:00:00.000Z",
    );
  });

  it("refuses a row it cannot identify rather than journaling one it can never dedup", async () => {
    push(row({ id: null }));
    const result = await build().drain();
    expect(result.rows).toBe(0);
    expect(store.count()).toBe(0);
  });

  it("keeps two devices' identically-keyed rows apart on a partitioned source", async () => {
    // Two phones host one partitioned source. The store keys their rows by the
    // declared key PLUS the device stream, so the same declared key from each
    // phone is two rows — and the journal has to say so. Deduplicating on the
    // declared key alone loses the second phone's row entirely when the two
    // agree.
    const materializer = build();
    push(row({ [STREAM]: "device-a" }));
    push(row({ [STREAM]: "device-b" }));

    const first = await materializer.drain();
    expect(first.rows, "one phone's row was dropped as the other's redelivery").toBe(2);
    expect(first.droppedRedeliveries).toBe(0);
    const ops = store.read(0, 10).map((e) => (e.kind === "analytics.row" ? e.payload.op : e.kind));
    expect(ops).toEqual(["inserted", "inserted"]);

    // And each stream still deduplicates against itself.
    push(row({ [STREAM]: "device-a" }));
    const second = await materializer.drain();
    expect(second.rows).toBe(0);
    expect(second.droppedRedeliveries).toBe(1);
  });

  it("does not report an endless update when two devices disagree on one key", async () => {
    // The other half of the same bug: with one journal identity for both
    // phones, each page flips the stored hash to the other phone's row, so a
    // row nobody edited emits `updated` forever.
    const materializer = build();
    push(row({ [STREAM]: "device-a", amount: 42.5 }));
    push(row({ [STREAM]: "device-b", amount: 99 }));
    await materializer.drain();

    for (let i = 0; i < 3; i += 1) {
      push(row({ [STREAM]: "device-a", amount: 42.5 }));
      push(row({ [STREAM]: "device-b", amount: 99 }));
      const again = await materializer.drain();
      expect(again.rows, "an unchanged row was journaled as an update").toBe(0);
      expect(again.droppedRedeliveries).toBe(2);
    }
  });

  it("names the contributing stream in the event's primary key", async () => {
    push(row({ [STREAM]: "device-a" }));
    await build().drain();

    const [event] = store.read(0, 10);
    if (event?.kind !== "analytics.row") throw new Error("expected an analytics event");
    expect(event.payload.pk).toEqual({ id: "txn-1", [STREAM]: "device-a" });
  });

  it("leaves what a batch cap could not reach in the queue", async () => {
    // Each row costs two hashes and a lookup, and the queue holds tens of
    // thousands. Without the cap, one drain of a bootstrap flood is an
    // uninterruptible freeze of the whole main thread.
    for (let i = 0; i < 5; i += 1) push(row({ id: `txn-${i}` }));
    const materializer = build({ batchSize: 2 });

    const first = await materializer.drain();
    expect(first.rows).toBe(2);
    expect(queue.depth, "the unread tail was thrown away").toBe(3);
    expect(
      first.idle,
      "a drain leaving rows queued reported idle, so the scheduler backs off under load",
    ).toBe(false);
    expect((await materializer.drain()).rows).toBe(2);
    expect((await materializer.drain()).rows).toBe(1);
    expect(store.count()).toBe(5);
  });

  it("resumes a durable outbox page after restart without losing or repeating rows", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      at: clock,
      table: TRANSACTIONS.tableName,
      sourceId: "plaid:fictional",
      row: row({ id: `durable-${index}` }),
      schema: TRANSACTIONS,
      backfill: false,
    }));
    const analyticsOutbox = {
      readWatchOutbox: (cursor: { pageSeq: number; rowOffset: number }, limit: number) => {
        const offset = cursor.pageSeq <= 1 ? cursor.rowOffset : rows.length;
        const batch = rows.slice(offset, offset + limit);
        const finished = offset + batch.length >= rows.length;
        return Promise.resolve({
          rows: batch,
          next: finished
            ? { pageSeq: 2, rowOffset: 0 }
            : { pageSeq: 1, rowOffset: offset + batch.length },
          pending: !finished,
        });
      },
    };

    expect((await build({ batchSize: 2, analyticsOutbox }).drain()).rows).toBe(2);
    // A new materializer stands in for the restarted gateway. Its only cursor
    // is the one committed atomically with the first two journal events.
    expect((await build({ batchSize: 2, analyticsOutbox }).drain()).rows).toBe(2);
    expect((await build({ batchSize: 2, analyticsOutbox }).drain()).rows).toBe(1);
    expect(store.read(0, 10)).toHaveLength(5);
    expect((await build({ batchSize: 2, analyticsOutbox }).drain()).rows).toBe(0);
    expect(store.read(0, 10), "a completed outbox page replayed after restart").toHaveLength(5);
  });
});

describe("a drain that fails before it commits", () => {
  it("puts everything back rather than reporting a drain that lost its input", async () => {
    const after = projection();
    insertDocument(after, true);
    queue.pushDocument(upserted(after, null));
    queue.pushRow({
      at: clock,
      table: TRANSACTIONS.tableName,
      sourceId: "plaid",
      row: { id: "txn-1", amount: 1, transacted_at: "2026-03-01T08:00:00.000Z" },
      backfill: false,
    });

    const failing = new Materializer({
      db,
      indexDb: null,
      store,
      queue,
      // The production implementation is a DuckDB read; a transient failure
      // there must not silently discard the batch it was drained for.
      tableSchema: () => Promise.reject(new Error("catalog unavailable")),
      documentProfile: () => GMAIL_PROFILE,
      now: () => clock,
    });

    await expect(failing.drain()).rejects.toThrow("catalog unavailable");
    expect(store.count(), "a failed drain wrote a partial batch").toBe(0);
    expect(queue.depth, "the drained batch was lost rather than returned").toBe(2);

    // And the retry lands everything.
    const result = await build().drain();
    expect(result.documents).toBe(1);
    expect(result.rows).toBe(1);
  });
});

describe("the gap a crash leaves", () => {
  it("starts from now on a fresh journal instead of replaying the corpus", async () => {
    insertDocument(projection(), true);

    const result = await build().drain();
    expect(result.recovered, "first boot replayed documents nobody asked about").toBe(0);
    expect(store.count()).toBe(0);
  });

  it("sweeps up what the bus lost while the gateway was down", async () => {
    insertDocument(projection(), true);
    await build().drain(); // parks the checkpoint at the newest document

    // A document lands while nothing is listening — the bus is in-memory, so
    // this is what a restart looks like from the journal's side.
    const missed = projection({ externalId: "msg-2", title: "Second quote" });
    insertDocument(missed, true, "2026-03-01T10:00:00.000Z");

    // A fresh materializer is a fresh process: the queue is empty and the only
    // trace of the missed document is that it is newer than the checkpoint.
    const result = await build().drain();
    expect(result.recovered).toBe(1);

    const [event] = store.read(0, 10);
    if (event?.kind !== "doc.event") throw new Error("expected a document event");
    expect(event.payload.docId).toBe(missed.id);
    expect(event.payload.op, "a recovered document claimed to be a creation").toBe("updated");
    expect(event.payload.changedFields, "recovery invented a change list it cannot know").toEqual(
      [],
    );
  });

  it("admits a recovered document is incomplete when its people never resolved", async () => {
    insertDocument(projection(), true);
    await build().drain();

    insertDocument(projection({ externalId: "msg-3" }), false, "2026-03-01T10:00:00.000Z");

    const result = await build().drain();
    expect(result.recovered).toBe(1);
    const [event] = store.read(0, 10);
    if (event?.kind !== "doc.event") throw new Error("expected a document event");
    expect(
      event.payload.degraded,
      "a recovered document with no people claimed to be complete",
    ).toBe(true);
  });

  it("keeps sweeping across drains until the gap is closed", async () => {
    // One page per drain, so an outage measured in days does not become one
    // tick measured in minutes. What must not happen is the sweep stopping
    // after its first page.
    insertDocument(projection(), true);
    await build().drain();

    for (let i = 0; i < 250; i += 1) {
      insertDocument(
        projection({ externalId: `gap-${i}` }),
        true,
        `2026-03-01T10:00:00.${String(i).padStart(3, "0")}Z`,
      );
    }

    const materializer = build();
    expect((await materializer.drain()).recovered, "the sweep did not page").toBe(200);
    expect((await materializer.drain()).recovered, "the sweep gave up after one page").toBe(50);
    expect((await materializer.drain()).recovered).toBe(0);
  });

  it("does not let a live document declare an unfinished sweep already done", async () => {
    // The sweep walks a historical gap one page at a time while live documents
    // keep arriving on the bus. A live document is newer than everything in the
    // gap by construction, so a checkpoint that followed it would jump past the
    // pages the sweep has not reached — and declare an outage recovered when
    // most of it never was.
    insertDocument(projection(), true);
    await build().drain();

    const gap: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      const missed = projection({ externalId: `gap-${i}` });
      insertDocument(missed, true, `2026-03-01T10:00:00.${String(i).padStart(3, "0")}Z`);
      gap.push(missed.id);
    }

    // And one document that did reach the bus, stamped after the whole gap.
    const live = projection({ externalId: "live" });
    insertDocument(live, true, "2026-03-01T12:00:00.000Z");
    queue.pushDocument(upserted(live, null));

    const materializer = build();
    const first = await materializer.drain();
    expect(first.recovered, "the sweep did not page").toBe(200);
    expect(first.documents, "the live document was not journaled").toBe(1);

    // Keep draining until the sweep says it is done.
    for (let i = 0; i < 5; i += 1) await materializer.drain();

    const journaled = new Set(
      store
        .read(0, 1000)
        .filter((e) => e.kind === "doc.event")
        .map((e) => (e.kind === "doc.event" ? e.payload.docId : "")),
    );
    const missing = gap.filter((id) => !journaled.has(id));
    expect(
      missing.length,
      `${missing.length} of ${gap.length} documents in the gap were never journaled`,
    ).toBe(0);
  });

  it("does not call a sweep finished when the drain that finished it never committed", async () => {
    // The sweep's last page is the dangerous one. If the materializer records
    // "caught up" before the commit and the commit then fails, it believes a
    // gap it never journaled is closed — and the next drain moves the
    // checkpoint straight past it. Nothing would ever look there again.
    insertDocument(projection(), true);
    await build().drain();

    const missed = projection({ externalId: "msg-missed" });
    insertDocument(missed, true, "2026-03-01T10:00:00.000Z");

    let failNext = true;
    const materializer = new Materializer({
      db,
      indexDb: null,
      store,
      queue,
      tableSchema: () => {
        if (!failNext) return Promise.resolve(TRANSACTIONS);
        failNext = false;
        return Promise.reject(new Error("catalog unavailable"));
      },
      documentProfile: () => GMAIL_PROFILE,
      now: () => clock,
    });

    // A queued row is what carries the drain into the failing call, after the
    // sweep has already walked its final page into the pending batch.
    queue.pushRow({
      at: clock,
      table: TRANSACTIONS.tableName,
      sourceId: "plaid",
      row: { id: "txn-1", amount: 1, transacted_at: "2026-03-01T08:00:00.000Z" },
      backfill: false,
    });
    await expect(materializer.drain()).rejects.toThrow("catalog unavailable");
    expect(store.count(), "the failed drain committed something").toBe(0);

    const retry = await materializer.drain();
    expect(retry.recovered, "the sweep was recorded as finished before it landed").toBe(1);
    const journaled = store
      .read(0, 100)
      .filter((e) => e.kind === "doc.event" && e.payload.docId === missed.id);
    expect(journaled.length, "the document the sweep was walking was never journaled").toBe(1);
  });

  it("does not move the checkpoint past a document it is still holding", async () => {
    // The hole this closes: advance past a deferred document, crash, and the
    // recovery sweep skips exactly the event that was lost. So the deferred
    // document is the OLDER of the two, and the queue is thrown away between
    // drains — which is what a crash is.
    insertDocument(projection(), true);
    const materializer = await settled();

    const held = projection({ externalId: "msg-held" });
    const later = projection({ externalId: "msg-later" });
    insertDocument(held, false, "2026-03-01T10:00:00.000Z");
    insertDocument(later, true, "2026-03-01T11:00:00.000Z");
    queue.pushDocument(upserted(held, null));
    queue.pushDocument(upserted(later, null));

    const drained = await materializer.drain();
    expect(drained.documents).toBe(1);
    expect(drained.deferred).toBe(1);

    // The crash. Everything in memory is gone; only the checkpoint survives.
    queue = new MaterializerQueue();
    const afterCrash = build();
    for (let i = 0; i < 5; i += 1) await afterCrash.drain();

    const recovered = store
      .read(0, 100)
      .filter((e) => e.kind === "doc.event" && e.payload.docId === held.id);
    expect(recovered.length, "the deferred document was never journaled at all").toBeGreaterThan(0);
  });

  it("does not step over a document that shares a timestamp with one it journaled", async () => {
    // One write stamps a whole page with a single `updated_at`, and the bus
    // delivers that page in sub-batches, so a drain routinely sees half a tie
    // group. Document ids are random, so "the last one I processed" is not
    // "the last one there is".
    insertDocument(projection(), true);
    const materializer = await settled();

    // The ids are fixed, and `unseen` sorts BELOW `seen`. With random ids the
    // naive checkpoint (`id: seen.id` rather than `id: ""`) would step over
    // `unseen` only half the time, so the test would miss the bug it names on
    // every other run.
    const tied = "2026-03-01T10:00:00.000Z";
    const seen = projection({
      externalId: "msg-seen",
      id: "ffffffff-0000-4000-8000-000000000002",
    });
    const unseen = projection({
      externalId: "msg-unseen",
      id: "00000000-0000-4000-8000-000000000001",
    });
    insertDocument(seen, true, tied);
    insertDocument(unseen, true, tied);
    // Only one of the pair reaches the queue — the other's bus event is still
    // in flight when the drain runs.
    queue.pushDocument(upserted(seen, null));
    expect((await materializer.drain()).documents).toBe(1);

    queue = new MaterializerQueue();
    const afterCrash = build();
    for (let i = 0; i < 3; i += 1) await afterCrash.drain();

    const recovered = store
      .read(0, 100)
      .filter((e) => e.kind === "doc.event" && e.payload.docId === unseen.id);
    expect(
      recovered.length,
      "the checkpoint moved into a timestamp group it had only half received",
    ).toBeGreaterThan(0);
  });
});

describe("the semantic clock", () => {
  /** A minimal `indexed_documents` — the shape the sweep pages over. */
  function indexDb(rows: { id: string; at: string }[]): Db {
    const index = new Database(":memory:") as unknown as Db;
    index.exec(
      `CREATE TABLE indexed_documents (document_id TEXT PRIMARY KEY, event_indexed_at TEXT NOT NULL)`,
    );
    const insert = index.prepare<[string, string]>(
      "INSERT INTO indexed_documents (document_id, event_indexed_at) VALUES (?, ?)",
    );
    for (const row of rows) insert.run(row.id, row.at);
    return index;
  }

  function withIndex(index: Db): Materializer {
    return new Materializer({
      db,
      indexDb: index,
      store,
      queue,
      tableSchema: () => Promise.resolve(null),
      documentProfile: () => GMAIL_PROFILE,
      now: () => clock,
    });
  }

  it("starts at the newest indexed row rather than replaying the whole index", async () => {
    // Symmetric with the document checkpoint, and for the same reason: a
    // corpus of three hundred thousand documents would otherwise produce three
    // hundred thousand events describing nothing that just happened.
    const index = indexDb([
      { id: randomUUID(), at: "2026-02-01T00:00:00.000Z" },
      { id: randomUUID(), at: "2026-02-02T00:00:00.000Z" },
    ]);
    const result = await withIndex(index).drain();
    expect(result.indexed, "first boot replayed the existing index").toBe(0);
    expect(store.count()).toBe(0);
  });

  it("emits a doc.indexed event for each document indexed after it started", async () => {
    const index = indexDb([{ id: randomUUID(), at: "2026-02-01T00:00:00.000Z" }]);
    const materializer = withIndex(index);
    await materializer.drain();

    const fresh = randomUUID();
    index
      .prepare<
        [string, string]
      >("INSERT INTO indexed_documents (document_id, event_indexed_at) VALUES (?, ?)")
      .run(fresh, "2026-03-01T09:00:00.000Z");

    const result = await materializer.drain();
    expect(result.indexed).toBe(1);
    const [event] = store.read(0, 10);
    if (event?.kind !== "doc.indexed") throw new Error("expected an indexed event");
    expect(event.payload.docId).toBe(fresh);
    expect(
      (await materializer.drain()).indexed,
      "the cursor did not advance, so the sweep repeats itself",
    ).toBe(0);
  });
});
