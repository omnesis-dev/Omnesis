// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The source version stored on every document.
 *
 * A sync page carries the version of the source that produced it, and each
 * document keeps the highest version it was written or re-read at. The case
 * that needs its own path is a re-read that finds the document unchanged: the
 * version must rise while everything a reader of the document's history looks
 * at stays exactly as it was.
 *
 * All fixture data is invented.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { EventBus, type DocumentUpsertedEvent } from "../../events.js";
import { EventService } from "../../http/services/EventService.js";
import { runMigrations } from "../migrations.js";
import { runSchemaSetup } from "../schema.js";
import {
  countDocumentsBySourceVersion,
  deleteDocuments,
  fetchDocumentProjections,
  listDocumentsLightweight,
  upsertDocuments,
  upsertWithCursor,
  upsertWithCursorYieldable,
  type UpsertWithCursorArgs,
} from "./DocumentRepository.js";
import { getSyncState } from "./SyncStateRepository.js";
import type { Db } from "../types.js";

const providerId = ProviderId("fixture-notes");
const sourceId = SourceId("fixture-notes:studio");
const T0 = Date.parse("2027-03-01T09:00:00.000Z");
const HOUR = 3_600_000;

let db: Db;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

function note(externalId: string, content = `Agenda for ${externalId}`): DocumentInput {
  return {
    providerId,
    sourceId,
    externalId,
    title: `Note ${externalId}`,
    content,
    contentHash: `hash:${content}`,
    metadata: {
      documentType: "note",
      people: [{ role: "author", emails: ["author@example.org"] }],
    },
    sourceCreatedAt: "2027-02-01T08:00:00.000Z",
    sourceUpdatedAt: "2027-02-01T08:00:00.000Z",
  };
}

function page(
  documents: DocumentInput[],
  sourceVersion: number | undefined,
  extra: Partial<UpsertWithCursorArgs> = {},
): UpsertWithCursorArgs {
  return {
    providerId,
    sourceId,
    documents,
    sourceVersion,
    hasMore: false,
    cursor: { read: documents.length },
    ...extra,
  };
}

interface StoredRow {
  id: string;
  source_version: number;
  content: string;
  updated_at: string;
  ingested_at: string;
  links_extracted_at: string | null;
  people_resolved_at: string | null;
  vocabulary_processed_at: string | null;
  vocabulary_revision: number;
  dates_extracted_at: string | null;
}

function stored(externalId: string, streamId = ""): StoredRow {
  return db
    .prepare<[string, string], StoredRow>(
      `SELECT id, source_version, content, updated_at, ingested_at, links_extracted_at,
              people_resolved_at, vocabulary_processed_at, vocabulary_revision, dates_extracted_at
         FROM documents WHERE external_id = ? AND stream_id = ?`,
    )
    .get(externalId, streamId)!;
}

function queued(): string[] {
  return db
    .prepare<[], { document_id: string }>(
      "SELECT document_id FROM document_filter_index_queue ORDER BY document_id",
    )
    .all()
    .map((row) => row.document_id);
}

/** Stand in for the passes that process a document after it is stored. */
function markDerivedWorkDone(): void {
  db.exec(`UPDATE documents SET
    links_extracted_at = '2027-03-01T09:05:00.000Z',
    people_resolved_at = '2027-03-01T09:05:00.000Z',
    vocabulary_processed_at = '2027-03-01T09:05:00.000Z',
    dates_extracted_at = '2027-03-01T09:05:00.000Z'`);
}

describe("what a page stores", () => {
  test("a new document takes the version of the page that carried it", () => {
    upsertWithCursor(db, page([note("a")], 1));
    upsertWithCursor(db, page([note("b")], 4));

    expect(stored("a").source_version).toBe(1);
    expect(stored("b").source_version).toBe(4);
    expect(queued()).toEqual([]);
  });

  test("a page without a version, as an older host sends, stores 0", () => {
    upsertWithCursor(db, page([note("a")], undefined));

    expect(stored("a").source_version).toBe(0);
    expect(getSyncState(db, sourceId)?.source_version).toBe(0);
  });

  test("a document written outside a sync page, as a pushed one is, stores 0", () => {
    upsertDocuments(db, [note("pushed")]);

    expect(stored("pushed").source_version).toBe(0);
  });

  test("a changed document takes the page's higher version with its new content", () => {
    upsertWithCursor(db, page([note("a")], 1));
    const before = stored("a");
    vi.setSystemTime(T0 + HOUR);

    upsertWithCursor(db, page([note("a", "Agenda, revised")], 2));

    const after = stored("a");
    expect(after.source_version).toBe(2);
    expect(after.content).toBe("Agenda, revised");
    expect(after.id).toBe(before.id);
    expect(after.updated_at).not.toBe(before.updated_at);
    // The indexer sees the change through `updated_at`; the queue is only for
    // changes that clock does not show.
    expect(queued()).toEqual([]);
  });
});

describe("a re-read that finds the document unchanged", () => {
  test("raises the version and nothing else", () => {
    upsertWithCursor(db, page([note("a"), note("b")], 1));
    markDerivedWorkDone();
    const before = { a: stored("a"), b: stored("b") };
    const statsBefore = db
      .prepare("SELECT doc_count, needs_refresh, dirty_version FROM source_stats")
      .all();
    vi.setSystemTime(T0 + HOUR);

    upsertWithCursor(db, page([note("a"), note("b")], 2));

    for (const key of ["a", "b"] as const) {
      expect(stored(key)).toEqual({ ...before[key], source_version: 2 });
    }
    expect(
      db.prepare("SELECT doc_count, needs_refresh, dirty_version FROM source_stats").all(),
    ).toEqual(statsBefore);
    expect(queued()).toEqual([before.a.id, before.b.id].sort());
  });

  test("leaves the indexer's clock with nothing new to read", () => {
    upsertWithCursor(db, page([note("a")], 1));
    vi.setSystemTime(T0 + HOUR);
    const watermark = new Date(T0 + 1).toISOString();
    expect(listDocumentsLightweight(db, { updatedSince: watermark }).documents).toEqual([]);

    upsertWithCursor(db, page([note("a")], 2));

    expect(stored("a").source_version).toBe(2);
    expect(listDocumentsLightweight(db, { updatedSince: watermark }).documents).toEqual([]);
  });

  test("emits no document event", async () => {
    upsertWithCursor(db, page([note("a")], 1));
    const before = new Map(
      [...fetchDocumentProjections(db, providerId, sourceId, ["a"])].map(([externalId, row]) => [
        `${providerId}|${sourceId}|${externalId}`,
        row,
      ]),
    );
    expect(before.size).toBe(1);
    const bus = new EventBus();
    const events: DocumentUpsertedEvent[] = [];
    bus.on("document.upserted", (event) => events.push(event));

    upsertWithCursor(db, page([note("a")], 2));
    await new EventService(db, bus, false).emitDocumentUpserted([note("a")], before);

    expect(stored("a").source_version).toBe(2);
    expect(events).toEqual([]);
  });

  test("at the same version writes nothing, and queues nothing", () => {
    upsertWithCursor(db, page([note("a")], 2));
    const before = stored("a");

    upsertWithCursor(db, page([note("a")], 2));

    expect(stored("a")).toEqual(before);
    expect(queued()).toEqual([]);
  });

  test("queues a document once however often its version rises", () => {
    upsertWithCursor(db, page([note("a")], 1));
    upsertWithCursor(db, page([note("a")], 2));
    upsertWithCursor(db, page([note("a")], 3));

    expect(stored("a").source_version).toBe(3);
    expect(queued()).toEqual([stored("a").id]);
  });

  test("reaches every document of a page committed in several writer chunks", () => {
    const notes = Array.from({ length: 23 }, (_, i) => note(`n${i}`));
    upsertWithCursor(db, page(notes, 1));
    const ids = notes.map((n) => stored(n.externalId).id).sort();
    vi.setSystemTime(T0 + HOUR);

    let outcome = upsertWithCursorYieldable(db, page(notes, 2), {
      token: { requested: () => true },
      chunkSize: 5,
    });
    let turns = 0;
    while (outcome.kind === "yield") {
      turns += 1;
      outcome = upsertWithCursorYieldable(db, outcome.resume, {
        token: { requested: () => true },
        chunkSize: 5,
      });
    }

    expect(turns).toBeGreaterThan(0);
    expect(countDocumentsBySourceVersion(db, sourceId)).toEqual([{ sourceVersion: 2, count: 23 }]);
    expect(queued()).toEqual(ids);
  });

  test("a queued document that is then deleted leaves the queue", () => {
    upsertWithCursor(db, page([note("a"), note("b")], 1));
    upsertWithCursor(db, page([note("a"), note("b")], 2));
    const kept = stored("b").id;

    deleteDocuments(db, providerId, sourceId, ["a"]);

    expect(queued()).toEqual([kept]);
  });
});

describe("a version never goes down", () => {
  test("an unchanged re-read at a lower version, or at none, keeps the stored one", () => {
    upsertWithCursor(db, page([note("a")], 3));
    const before = stored("a");

    upsertWithCursor(db, page([note("a")], 2));
    upsertWithCursor(db, page([note("a")], undefined));
    upsertDocuments(db, [note("a")]);

    expect(stored("a")).toEqual(before);
    expect(queued()).toEqual([]);
  });

  test("a rewrite from a host on an older build changes the document and keeps the version", () => {
    upsertWithCursor(db, page([note("a")], 3));

    upsertWithCursor(db, page([note("a", "Agenda from the older host")], 1));
    expect(stored("a")).toMatchObject({ source_version: 3, content: "Agenda from the older host" });

    upsertDocuments(db, [note("a", "Agenda, pushed")]);
    expect(stored("a")).toMatchObject({ source_version: 3, content: "Agenda, pushed" });
  });
});

describe("several hosts of one source", () => {
  const replicated = { replicaVersionPolicy: "source-updated-at" as const };
  const at = (document: DocumentInput, sourceUpdatedAt: string): DocumentInput => ({
    ...document,
    sourceUpdatedAt,
  });

  test("replicated: the member on the older build does not lower what the newer one raised", () => {
    const shared = at(note("a"), "2027-02-01T08:00:00.000Z");
    upsertWithCursor(db, page([shared], 1, { ...replicated, cursorDeviceId: "old-host" }));
    upsertWithCursor(db, page([shared], 2, { ...replicated, cursorDeviceId: "new-host" }));
    expect(stored("a").source_version).toBe(2);

    upsertWithCursor(db, page([shared], 1, { ...replicated, cursorDeviceId: "old-host" }));

    expect(stored("a").source_version).toBe(2);
    expect(getSyncState(db, sourceId, "old-host")?.source_version).toBe(1);
    expect(getSyncState(db, sourceId, "new-host")?.source_version).toBe(2);
  });

  test("replicated: a newer copy from the older build replaces the content, not the version", () => {
    upsertWithCursor(
      db,
      page([at(note("a"), "2027-02-01T08:00:00.000Z")], 2, {
        ...replicated,
        cursorDeviceId: "new-host",
      }),
    );

    upsertWithCursor(
      db,
      page([at(note("a", "Edited on the older host"), "2027-02-02T08:00:00.000Z")], 1, {
        ...replicated,
        cursorDeviceId: "old-host",
      }),
    );

    expect(stored("a")).toMatchObject({ source_version: 2, content: "Edited on the older host" });
  });

  test("replicated: a copy the gateway declines says nothing about the stored document", () => {
    upsertWithCursor(
      db,
      page([at(note("a", "The current text"), "2027-02-02T08:00:00.000Z")], 1, {
        ...replicated,
        cursorDeviceId: "old-host",
      }),
    );
    const before = stored("a");

    // The newer build's replica is behind: its copy loses to the stored one,
    // which was written at version 1 and is not what this page read.
    const outcome = upsertWithCursor(
      db,
      page([at(note("a", "A stale text"), "2027-02-01T08:00:00.000Z")], 2, {
        ...replicated,
        cursorDeviceId: "new-host",
      }),
    );

    expect(outcome.ignoredReplicaDocuments).toEqual([{ sourceId, externalId: "a" }]);
    expect(stored("a")).toEqual(before);
    expect(queued()).toEqual([]);
  });

  test("partitioned: each host's stream keeps its own versions", () => {
    const phone = { cursorDeviceId: "phone", streamId: "phone" };
    const laptop = { cursorDeviceId: "laptop", streamId: "laptop" };
    upsertWithCursor(db, page([note("a"), note("b")], 1, phone));
    upsertWithCursor(db, page([note("a"), note("b"), note("c")], 1, laptop));

    upsertWithCursor(db, page([note("a"), note("b")], 2, laptop));

    expect(stored("a", "phone").source_version).toBe(1);
    expect(stored("a", "laptop").source_version).toBe(2);
    expect(countDocumentsBySourceVersion(db, sourceId, "phone")).toEqual([
      { sourceVersion: 1, count: 2 },
    ]);
    expect(countDocumentsBySourceVersion(db, sourceId, "laptop")).toEqual([
      { sourceVersion: 1, count: 1 },
      { sourceVersion: 2, count: 2 },
    ]);
    expect(countDocumentsBySourceVersion(db, sourceId)).toEqual([
      { sourceVersion: 1, count: 3 },
      { sourceVersion: 2, count: 2 },
    ]);
    expect(getSyncState(db, sourceId, "phone")?.source_version).toBe(1);
    expect(getSyncState(db, sourceId, "laptop")?.source_version).toBe(2);
    expect(queued()).toEqual([stored("a", "laptop").id, stored("b", "laptop").id].sort());
  });

  test("handoff: the shared cursor row follows whichever host committed last", () => {
    upsertWithCursor(db, page([note("a")], 2));
    expect(getSyncState(db, sourceId)?.source_version).toBe(2);

    // The lease passes to a host on an older build, which re-reads the item.
    upsertWithCursor(db, page([note("a")], 1));

    expect(getSyncState(db, sourceId)?.source_version).toBe(1);
    expect(stored("a").source_version).toBe(2);
  });
});

describe("the lowest version of one enumeration", () => {
  const inventory = {
    id: "0b9f1d3e-4c2a-4e7b-9a51-6f2d8c3e1a70",
    startedAt: "2027-03-01T09:00:00.000Z",
  };
  const row = (id = inventory.id) =>
    db
      .prepare<[string], { min_source_version: number | null; completed_at: number | null }>(
        "SELECT min_source_version, completed_at FROM source_inventories WHERE id = ?",
      )
      .get(id);

  test("is the page's version while every page agrees, and completes on the last page", () => {
    upsertWithCursor(db, page([note("a")], 2, { initialInventory: inventory, hasMore: true }));
    expect(row()).toEqual({ min_source_version: 2, completed_at: null });

    upsertWithCursor(db, page([note("b")], 2, { initialInventory: inventory }));

    expect(row()).toEqual({ min_source_version: 2, completed_at: T0 });
  });

  test("stays at the lower version when the host is upgraded part way through", () => {
    upsertWithCursor(db, page([note("a")], 1, { initialInventory: inventory, hasMore: true }));
    upsertWithCursor(db, page([note("b")], 2, { initialInventory: inventory, hasMore: true }));
    upsertWithCursor(db, page([], 2, { initialInventory: inventory }));

    expect(row()).toMatchObject({ min_source_version: 1 });
    expect(row()?.completed_at).not.toBeNull();
    expect(getSyncState(db, sourceId)?.source_version).toBe(2);
    expect(countDocumentsBySourceVersion(db, sourceId)).toEqual([
      { sourceVersion: 1, count: 1 },
      { sourceVersion: 2, count: 1 },
    ]);
  });

  test("drops to 0 when one page of it came from a host that sends no version", () => {
    upsertWithCursor(db, page([note("a")], 2, { initialInventory: inventory, hasMore: true }));
    upsertWithCursor(db, page([note("b")], undefined, { initialInventory: inventory }));

    expect(row()).toMatchObject({ min_source_version: 0 });
  });

  test("a later enumeration starts from its own first page", () => {
    upsertWithCursor(db, page([note("a")], 1, { initialInventory: inventory }));
    const next = { id: "5a7c2e90-1b3d-4f68-8c24-9e0d7b6a5f31", startedAt: inventory.startedAt };

    upsertWithCursor(db, page([note("a")], 2, { initialInventory: next }));

    expect(row()).toMatchObject({ min_source_version: 1 });
    expect(row(next.id)).toMatchObject({ min_source_version: 2 });
    expect(stored("a").source_version).toBe(2);
  });
});

describe("counting a source's documents per version", () => {
  test("reports each version it holds, lowest first, with 0 for documents stored without one", () => {
    upsertWithCursor(db, page([note("a"), note("b"), note("c"), note("d")], undefined));
    upsertWithCursor(db, page([note("b"), note("c"), note("d")], 1));
    upsertWithCursor(db, page([note("d")], 2));
    upsertDocuments(db, [{ ...note("elsewhere"), sourceId: SourceId("fixture-notes:other") }]);

    expect(countDocumentsBySourceVersion(db, sourceId)).toEqual([
      { sourceVersion: 0, count: 1 },
      { sourceVersion: 1, count: 2 },
      { sourceVersion: 2, count: 1 },
    ]);
    expect(countDocumentsBySourceVersion(db, SourceId("fixture-notes:absent"))).toEqual([]);
  });

  /** The counts as a scan of the documents gives them, to hold the running ones against. */
  const scanned = () =>
    db
      .prepare(
        `SELECT source_id, stream_id, source_version, COUNT(*) AS document_count
           FROM documents GROUP BY source_id, stream_id, source_version
          ORDER BY source_id, stream_id, source_version`,
      )
      .all();
  const running = () =>
    db
      .prepare(
        `SELECT source_id, stream_id, source_version, document_count
           FROM source_version_counts ORDER BY source_id, stream_id, source_version`,
      )
      .all();

  test("is read from the running counts, a few rows whatever the source holds", () => {
    const plan = db
      .prepare<[string], { detail: string }>(
        `EXPLAIN QUERY PLAN SELECT source_version, SUM(document_count) FROM source_version_counts
          WHERE source_id = ? GROUP BY source_version ORDER BY source_version`,
      )
      .all(sourceId)
      .map((step) => step.detail);

    expect(plan[0]).toBe("SEARCH source_version_counts USING PRIMARY KEY (source_id=?)");
    expect(plan.join("\n")).not.toContain("documents");
  });

  test("the running counts follow every way a document comes, goes or moves", () => {
    const other = SourceId("fixture-notes:other");
    const phone = { cursorDeviceId: "phone", streamId: "phone" };
    upsertWithCursor(db, page([note("a"), note("b"), note("c")], 1));
    upsertWithCursor(db, page([note("a"), note("b")], 1, phone));
    upsertDocuments(db, [{ ...note("d"), sourceId: other }]);
    expect(running()).toEqual(scanned());

    // Unchanged re-reads, a rewrite and a first write, at a higher version.
    upsertWithCursor(db, page([note("a"), note("b", "Agenda, revised"), note("e")], 2));
    expect(running()).toEqual(scanned());

    // A tombstone, and a whole stream leaving.
    deleteDocuments(db, providerId, sourceId, ["c"]);
    db.prepare("DELETE FROM documents WHERE source_id = ? AND stream_id = 'phone'").run(sourceId);
    expect(running()).toEqual(scanned());
    expect(countDocumentsBySourceVersion(db, sourceId, "phone")).toEqual([]);

    // A document re-keyed to another stream or source takes its count with it.
    db.prepare("UPDATE documents SET stream_id = 'laptop' WHERE external_id = 'a'").run();
    db.prepare("UPDATE documents SET source_id = ? WHERE external_id = 'e'").run(other);
    expect(running()).toEqual(scanned());
    expect(countDocumentsBySourceVersion(db, sourceId)).toEqual([{ sourceVersion: 2, count: 2 }]);
    expect(countDocumentsBySourceVersion(db, other)).toEqual([
      { sourceVersion: 0, count: 1 },
      { sourceVersion: 2, count: 1 },
    ]);

    // The last document of a source leaves no count behind.
    db.prepare("DELETE FROM documents").run();
    expect(running()).toEqual([]);
  });
});
