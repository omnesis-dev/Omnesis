// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  createDatabase,
  openReadOnlyDatabase,
  upsertDocuments,
  upsertWithCursor,
  upsertWithCursorYieldable,
  deleteDocuments,
  deleteDocumentForUser,
  deleteDocumentForRetention,
  completeDocumentRetention,
  computeSnapshotAbsencePlan,
  applySnapshotAbsencePlan,
  sweepDueAbsences,
  deleteDocumentsByIds,
  countPendingAbsences,
  deleteAllBySource,
  deleteAllByStream,
  deleteAllByProvider,
  listDocuments,
  checkExistingExternalIds,
  getSyncState,
  getDocumentCount,
  tombstoneDocuments,
  getWipeEpoch,
  bumpWipeEpoch,
  resetMemberCursor,
  beginSyncAttempt,
  revokeSyncAttempt,
  setSyncState,
  setSyncError,
  clearSyncError,
  listSyncStates,
  getSourceMeta,
  setSourceMeta,
  computeSourceStatsRow,
  upsertSourceStatsRow,
  refreshSourceStatsRow,
  getLatestActivityBySource,
  type StoredDocument,
} from "./db.js";
import { AccountId, SourceType, type DocumentInput } from "@omnesis/types";
import { aliasWriter } from "./data/repositories/PersonAliasRepository.js";
import { createDevice } from "./data/repositories/DeviceRepository.js";
import {
  addSourceMember,
  createSource,
  listSourceMembers,
  removeSourceMember,
  updateSource,
} from "./data/repositories/SourceRepository.js";
import { unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * The shipped snapshot-absence policy, for the pages that carry a snapshot.
 * See `AbsenceRepository`.
 */
const ABSENCE_POLICY = {
  minObservations: 3,
  minAgeMs: 24 * 60 * 60_000,
  maxMarksPerSnapshot: 10_000,
};

function testDbPath() {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function makeDoc(overrides: Partial<DocumentInput> = {}): DocumentInput {
  return {
    providerId: "google",
    sourceId: "gmail",
    externalId: "msg-1",
    title: "Test Email",
    content: "# Hello\nThis is a test email.",
    contentHash: "hash-1",
    metadata: {
      sourceUrl: "https://mail.google.com/mail/#inbox/msg-1",
      tags: ["INBOX"],
      people: [{ role: "sender" as const, emails: ["alice@example.com"] }],
    },
    sourceCreatedAt: "2024-01-15T10:00:00Z",
    sourceUpdatedAt: "2024-01-15T10:00:00Z",
    ...overrides,
  };
}

describe("createDatabase", () => {
  test("creates database with documents and sync_state tables", () => {
    const p = testDbPath();
    const db = createDatabase(p);
    const tables = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = tables.map((t) => t.name);
    expect(names).toContain("documents");
    expect(names).toContain("sync_state");
    db.close();
    cleanupDb(p);
  });

  test("uses WAL journal mode", () => {
    const p = testDbPath();
    const db = createDatabase(p);
    const result = db.prepare<[], { journal_mode: string }>("PRAGMA journal_mode").get();
    expect(result?.journal_mode).toBe("wal");
    db.close();
    cleanupDb(p);
  });

  test("is idempotent (can be called twice on same path)", () => {
    const p = testDbPath();
    const db1 = createDatabase(p);
    db1.close();
    const db2 = createDatabase(p);
    db2.close();
    cleanupDb(p);
  });
});

describe("openReadOnlyDatabase", () => {
  test("applies the requested page-cache budget and keeps mmap off", () => {
    const p = testDbPath();
    createDatabase(p).close();
    const db = openReadOnlyDatabase(p, { cacheSizeBytes: 256 * 1024 * 1024 });
    // Negative cache_size is a KiB byte-budget: 256 MiB → -262144.
    expect(db.prepare<[], { cache_size: number }>("PRAGMA cache_size").get()?.cache_size).toBe(
      -262144,
    );
    // mmap stays off on the encrypted read handle (SIGBUS guard).
    expect(db.prepare<[], { mmap_size: number }>("PRAGMA mmap_size").get()?.mmap_size).toBe(0);
    db.close();
    cleanupDb(p);
  });

  test("leaves the default cache when no budget is given", () => {
    const p = testDbPath();
    createDatabase(p).close();
    const db = openReadOnlyDatabase(p);
    // No PRAGMA applied → SQLite's own default, NOT our 256 MiB budget.
    expect(db.prepare<[], { cache_size: number }>("PRAGMA cache_size").get()!.cache_size).not.toBe(
      -262144,
    );
    db.close();
    cleanupDb(p);
  });
});

describe("upsertDocuments", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("yieldable: chunks the work + returns remaining when token requests yield", () => {
    // Token that requests yield after the second poll. Combined with
    // chunkSize=2, this means: chunk 1 (docs 0-1) commits, chunk 2
    // (docs 2-3) commits, then token poll → yield → return remaining.
    let polls = 0;
    const token = {
      requested: () => {
        polls += 1;
        return polls >= 2;
      },
    };
    const docs = [
      makeDoc({ externalId: "msg-1" }),
      makeDoc({ externalId: "msg-2" }),
      makeDoc({ externalId: "msg-3" }),
      makeDoc({ externalId: "msg-4" }),
      makeDoc({ externalId: "msg-5" }),
      makeDoc({ externalId: "msg-6" }),
    ];
    const result = upsertDocuments(db, docs, { token, chunkSize: 2 });
    expect(result.remaining).toHaveLength(2);
    expect(result.remaining[0].externalId).toBe("msg-5");
    expect(result.remaining[1].externalId).toBe("msg-6");
    // First two chunks (4 docs) actually persisted.
    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(4);
  });

  test("yieldable: completes without yielding when token never requests", () => {
    const token = { requested: () => false };
    const docs = [
      makeDoc({ externalId: "msg-a" }),
      makeDoc({ externalId: "msg-b" }),
      makeDoc({ externalId: "msg-c" }),
    ];
    const result = upsertDocuments(db, docs, { token, chunkSize: 2 });
    expect(result.remaining).toEqual([]);
    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(3);
  });

  test("yieldable: default chunkSize=5 yields a 20-doc batch at chunk boundaries", () => {
    // Regression guard: before the fix, chunkSize defaulted to 25, so a
    // 20-document batch never hit a yield check. With chunkSize=5 the same
    // batch must yield as soon as the
    // token requests it, leaving an exact-multiple-of-5 tail behind.
    let polls = 0;
    const token = {
      requested: () => {
        polls += 1;
        // Request yield on the first inter-chunk poll (after chunk
        // #1 of 5 docs has committed).
        return polls >= 1;
      },
    };
    const docs = Array.from({ length: 20 }, (_, i) => makeDoc({ externalId: `msg-${i}` }));
    // No explicit chunkSize → exercises the new default.
    const result = upsertDocuments(db, docs, { token });
    // After committing one chunk of 5, yield should fire.
    expect(result.remaining).toHaveLength(15);
    expect(result.remaining[0].externalId).toBe("msg-5");
    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(5);
  });

  test("yieldable: huge content (>=1MB) forces one-doc-per-chunk", () => {
    // A single huge doc dominates write cost; bundling siblings with
    // it pushes per-chunk wall time past budget. Override forces
    // chunkSize=1 so each commit is bounded by the heaviest single
    // row, not the batch.
    let polls = 0;
    const token = {
      requested: () => {
        polls += 1;
        // Yield after committing the first doc.
        return polls >= 1;
      },
    };
    const bigContent = "x".repeat(1_100_000); // > 1MB threshold
    const docs = [
      makeDoc({ externalId: "huge-1", content: bigContent, contentHash: "h1" }),
      makeDoc({ externalId: "small-1", contentHash: "h2" }),
      makeDoc({ externalId: "small-2", contentHash: "h3" }),
      makeDoc({ externalId: "small-3", contentHash: "h4" }),
    ];
    // Pass chunkSize=5 — the huge-doc override should pull it down
    // to 1 regardless.
    const result = upsertDocuments(db, docs, { token, chunkSize: 5 });
    expect(result.remaining).toHaveLength(3);
    expect(result.remaining[0].externalId).toBe("small-1");
    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(1);
  });

  test("inserts a new document", () => {
    upsertDocuments(db, [makeDoc()]);

    const rows = db.prepare<[], StoredDocument>("SELECT * FROM documents").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Test Email");
    expect(rows[0].provider_id).toBe("google");
    expect(rows[0].source_id).toBe("gmail");
    expect(rows[0].external_id).toBe("msg-1");
    expect(rows[0].content_hash).toBe("hash-1");
  });

  test("inserts multiple documents in a batch", () => {
    upsertDocuments(db, [
      makeDoc({ externalId: "msg-1" }),
      makeDoc({ externalId: "msg-2", title: "Second Email" }),
      makeDoc({ externalId: "msg-3", title: "Third Email" }),
    ]);

    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(3);
  });

  test("updates document when content hash changes", () => {
    upsertDocuments(db, [makeDoc()]);
    upsertDocuments(db, [makeDoc({ title: "Updated Email", contentHash: "hash-2" })]);

    const rows = db.prepare<[], StoredDocument>("SELECT * FROM documents").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Updated Email");
    expect(rows[0].content_hash).toBe("hash-2");
  });

  test("skips update when content hash, title, and source_updated_at are all unchanged", () => {
    upsertDocuments(db, [makeDoc()]);
    const before = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();

    // Same contentHash, title, and sourceUpdatedAt — should be a no-op
    upsertDocuments(db, [makeDoc()]);
    const after = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();

    expect(after?.updated_at).toBe(before?.updated_at);
  });

  test("updates when title changes even if content hash is unchanged", () => {
    upsertDocuments(db, [makeDoc()]);

    // Same contentHash but different title — should update
    upsertDocuments(db, [makeDoc({ title: "Updated Title" })]);
    const after = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();

    expect(after?.title).toBe("Updated Title");
  });

  test("updates when source_updated_at changes even if content hash is unchanged", () => {
    upsertDocuments(db, [makeDoc()]);

    // Same contentHash but different sourceUpdatedAt — should update
    upsertDocuments(db, [makeDoc({ sourceUpdatedAt: "2026-03-11T00:00:00Z" })]);
    const after = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();

    expect(after?.source_updated_at).toBe("2026-03-11T00:00:00Z");
  });

  test("replicated writes keep the newest source version regardless of arrival order", () => {
    const stale = makeDoc({
      title: "Earlier task title",
      content: "Earlier task body",
      contentHash: "hash-earlier",
      sourceUpdatedAt: "2026-03-10T00:00:00.000Z",
    });
    const fresh = makeDoc({
      title: "Later task title",
      content: "Later task body",
      contentHash: "hash-later",
      sourceUpdatedAt: "2026-03-11T00:00:00.000Z",
    });
    const replicated = {
      replicaVersionPolicies: { gmail: "source-updated-at" as const },
    };

    upsertDocuments(db, [fresh], replicated);
    const dirtyBeforeStale = db
      .prepare<
        [],
        { dirty_version: number }
      >("SELECT dirty_version FROM source_stats WHERE source_id = 'gmail'")
      .get()?.dirty_version;
    upsertDocuments(db, [stale], replicated);
    let stored = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();
    expect(stored?.title).toBe("Later task title");
    expect(stored?.source_updated_at).toBe("2026-03-11T00:00:00.000Z");
    expect(
      db
        .prepare<
          [],
          { dirty_version: number }
        >("SELECT dirty_version FROM source_stats WHERE source_id = 'gmail'")
        .get()?.dirty_version,
    ).toBe(dirtyBeforeStale);

    db.prepare("DELETE FROM documents").run();
    upsertDocuments(db, [stale], replicated);
    upsertDocuments(db, [fresh], replicated);
    stored = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();
    expect(stored?.title).toBe("Later task title");
    expect(stored?.source_updated_at).toBe("2026-03-11T00:00:00.000Z");
  });

  test("replica version policy rejects invalid input and repairs an invalid legacy version", () => {
    const replicated = {
      replicaVersionPolicies: { gmail: "source-updated-at" as const },
    };
    expect(() =>
      upsertDocuments(db, [makeDoc({ sourceUpdatedAt: "not-a-timestamp" })], replicated),
    ).toThrow(/canonical UTC ISO 8601/);

    // Simulate a pre-policy row that predates the canonical timestamp contract.
    upsertDocuments(db, [makeDoc()]);
    db.prepare("UPDATE documents SET source_updated_at = 'legacy-invalid'").run();
    upsertDocuments(
      db,
      [
        makeDoc({
          title: "Repaired",
          contentHash: "repaired",
          sourceUpdatedAt: "2026-03-12T00:00:00.000Z",
        }),
      ],
      replicated,
    );
    expect(db.prepare<[], StoredDocument>("SELECT * FROM documents").get()).toMatchObject({
      title: "Repaired",
      source_updated_at: "2026-03-12T00:00:00.000Z",
    });
  });

  test("updates when metadata changes even if content/title/source_updated_at all unchanged", () => {
    // Models the WhatsApp roster fix scenario: rendered markdown is identical
    // (one user spoke, content unchanged), but metadata.people now includes
    // silent group members. Without the metadata-aware WHERE clause, the
    // gateway silently dropped these improvements.
    upsertDocuments(db, [makeDoc()]);
    const before = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();

    upsertDocuments(db, [
      makeDoc({
        metadata: {
          sourceUrl: "https://mail.google.com/mail/#inbox/msg-1",
          tags: ["INBOX"],
          people: [
            { role: "sender" as const, emails: ["alice@example.com"] },
            { role: "participant" as const, name: "Bob", emails: ["bob@example.com"] },
          ],
        },
      }),
    ]);
    const after = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();

    expect(after?.metadata).not.toBe(before?.metadata);
    const md = JSON.parse(after!.metadata);
    expect(md.people).toHaveLength(2);
    expect(md.people[1].name).toBe("Bob");
  });

  test("metadata change clears people_resolved_at and links_extracted_at", () => {
    upsertDocuments(db, [makeDoc()]);
    // Simulate the people-resolver and link-extractor having processed this doc
    db.prepare(
      "UPDATE documents SET people_resolved_at = ?, links_extracted_at = ? WHERE external_id = 'msg-1'",
    ).run("2026-03-10T00:00:00Z", "2026-03-10T00:00:00Z");

    const beforeRefresh = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();
    expect(beforeRefresh?.people_resolved_at).toBe("2026-03-10T00:00:00Z");
    expect(beforeRefresh?.links_extracted_at).toBe("2026-03-10T00:00:00Z");

    // Re-emit with different metadata (same content + title + source_updated_at)
    upsertDocuments(db, [
      makeDoc({
        metadata: {
          sourceUrl: "https://mail.google.com/mail/#inbox/msg-1",
          tags: ["INBOX"],
          people: [
            { role: "sender" as const, emails: ["alice@example.com"] },
            { role: "participant" as const, name: "Bob" },
          ],
        },
      }),
    ]);

    const afterRefresh = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();
    expect(afterRefresh?.people_resolved_at).toBeNull();
    expect(afterRefresh?.links_extracted_at).toBeNull();
  });

  test("byte-identical metadata is still a no-op", () => {
    // Sanity: re-emitting with the exact same metadata stringification doesn't
    // touch the row.
    upsertDocuments(db, [makeDoc()]);
    const before = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();

    upsertDocuments(db, [makeDoc()]);
    const after = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();

    expect(after?.updated_at).toBe(before?.updated_at);
  });

  test("content_hash change still clears the derived-state markers", () => {
    // Regression guard: the new metadata-aware logic must not break the
    // existing "content changed → clear markers" behavior.
    upsertDocuments(db, [makeDoc()]);
    db.prepare(
      "UPDATE documents SET people_resolved_at = ?, links_extracted_at = ? WHERE external_id = 'msg-1'",
    ).run("2026-03-10T00:00:00Z", "2026-03-10T00:00:00Z");

    upsertDocuments(db, [makeDoc({ contentHash: "hash-2", content: "different" })]);

    const after = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();
    expect(after?.people_resolved_at).toBeNull();
    expect(after?.links_extracted_at).toBeNull();
  });

  test("stores metadata as JSON", () => {
    upsertDocuments(db, [makeDoc()]);

    const row = db.prepare<[], StoredDocument>("SELECT * FROM documents").get();
    const metadata = JSON.parse(row!.metadata);
    expect(metadata.people[0].emails[0]).toBe("alice@example.com");
    expect(metadata.sourceUrl).toBe("https://mail.google.com/mail/#inbox/msg-1");
    expect(metadata.tags).toEqual(["INBOX"]);
  });

  test("enforces unique constraint on (provider_id, source_id, external_id)", () => {
    upsertDocuments(db, [makeDoc()]);
    // Same key, different hash — should update, not create a second row
    upsertDocuments(db, [makeDoc({ contentHash: "hash-new" })]);

    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(1);
  });

  test("allows same external_id across different sources", () => {
    upsertDocuments(db, [
      makeDoc({ sourceId: "gmail", externalId: "id-1" }),
      makeDoc({ sourceId: "google-calendar", externalId: "id-1" }),
    ]);

    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(2);
  });
});

describe("deleteDocuments", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    upsertDocuments(db, [
      makeDoc({ externalId: "msg-1" }),
      makeDoc({ externalId: "msg-2" }),
      makeDoc({ externalId: "msg-3" }),
    ]);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("deletes specified documents", () => {
    deleteDocuments(db, "google", "gmail", ["msg-1", "msg-3"]);

    const rows = db.prepare<[], StoredDocument>("SELECT * FROM documents").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].external_id).toBe("msg-2");
  });

  test("does nothing with empty array", () => {
    deleteDocuments(db, "google", "gmail", []);

    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(3);
  });

  test("does nothing when external ids don't match", () => {
    deleteDocuments(db, "google", "gmail", ["nonexistent"]);

    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(3);
  });

  test("scopes deletion to provider and source", () => {
    // Add a doc from a different source with same external_id
    upsertDocuments(db, [makeDoc({ sourceId: "google-calendar", externalId: "msg-1" })]);

    deleteDocuments(db, "google", "gmail", ["msg-1"]);

    const rows = db.prepare<[], StoredDocument>("SELECT * FROM documents").all();
    // msg-2, msg-3 from gmail + msg-1 from calendar
    expect(rows).toHaveLength(3);
  });
});

describe("deleteDocumentForUser (single-document privacy delete)", () => {
  let db: Db;
  let dbPath: string;

  const docCount = (): number =>
    db.prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents").get()?.count ?? 0;
  const tombstoneCount = (): number =>
    db.prepare<[], { count: number }>("SELECT COUNT(*) as count FROM removed_documents").get()
      ?.count ?? 0;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    upsertDocuments(db, [makeDoc({ externalId: "msg-1" }), makeDoc({ externalId: "msg-2" })]);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("deletes the target document and records a tombstone", () => {
    const deletedIds = deleteDocumentForUser(db, "google", "gmail", "msg-1");

    expect(deletedIds).toHaveLength(1);
    const rows = db.prepare<[], StoredDocument>("SELECT * FROM documents").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].external_id).toBe("msg-2");
    expect(tombstoneCount()).toBe(1);
    const tomb = db
      .prepare<
        [],
        {
          provider_id: string;
          source_id: string;
          external_id: string;
          original_document_id: string | null;
        }
      >("SELECT provider_id, source_id, external_id, original_document_id FROM removed_documents")
      .get();
    expect(tomb).toMatchObject({
      provider_id: "google",
      source_id: "gmail",
      external_id: "msg-1",
      original_document_id: deletedIds[0],
    });
  });

  test("cascades to extracted-attachment child documents", () => {
    upsertDocuments(db, [
      makeDoc({ externalId: "msg-1/att/a1", contentHash: "att-1" }),
      makeDoc({ externalId: "msg-1/att/a2", contentHash: "att-2" }),
    ]);
    expect(docCount()).toBe(4); // msg-1, msg-2, + 2 attachments

    const deletedIds = deleteDocumentForUser(db, "google", "gmail", "msg-1");

    // Parent + both attachment children gone; msg-2 survives.
    expect(deletedIds).toHaveLength(3);
    const survivors = db
      .prepare<[], { external_id: string }>("SELECT external_id FROM documents")
      .all()
      .map((r) => r.external_id);
    expect(survivors).toEqual(["msg-2"]);
    // The parent and both children are tombstoned.
    expect(tombstoneCount()).toBe(3);
  });

  test("escapes LIKE metacharacters so a sibling isn't over-deleted", () => {
    // Parent external_id contains a literal underscore. A doc whose
    // external_id differs only where the `_` would match a wildcard must
    // NOT be treated as a child.
    db.exec("DELETE FROM documents");
    upsertDocuments(db, [
      makeDoc({ externalId: "a_b", contentHash: "h-parent" }),
      makeDoc({ externalId: "aXb/att/1", contentHash: "h-sibling" }),
    ]);

    const deletedIds = deleteDocumentForUser(db, "google", "gmail", "a_b");

    // Only the literal `a_b` parent is removed; `aXb/att/1` is unrelated.
    expect(deletedIds).toHaveLength(1);
    const survivors = db
      .prepare<[], { external_id: string }>("SELECT external_id FROM documents")
      .all()
      .map((r) => r.external_id);
    expect(survivors).toEqual(["aXb/att/1"]);
  });

  test("without a tombstone only this copy goes and the next upsert brings it back", () => {
    const deletedIds = deleteDocumentForUser(db, "google", "gmail", "msg-1", "", false);
    expect(deletedIds).toHaveLength(1);
    expect(docCount()).toBe(1);
    expect(tombstoneCount()).toBe(0);

    const result = upsertDocuments(db, [makeDoc({ externalId: "msg-1", contentHash: "fresh" })]);
    expect(result.suppressedDocuments).toEqual([]);
    expect(result.acceptedDocumentCount).toBe(1);
    expect(docCount()).toBe(2);
  });

  test("suppresses re-creation of a deleted document on the next upsert", () => {
    deleteDocumentForUser(db, "google", "gmail", "msg-1");
    expect(docCount()).toBe(1);

    // Collector re-syncs / browser re-captures the same page.
    const result = upsertDocuments(db, [makeDoc({ externalId: "msg-1", contentHash: "fresh" })]);

    // It stays gone — the tombstone wins — and the refused key is reported.
    expect(result.remaining).toEqual([]);
    expect(result.suppressedDocuments).toEqual([{ sourceId: "gmail", externalId: "msg-1" }]);
    expect(result.acceptedDocumentCount).toBe(0);
    expect(docCount()).toBe(1);
    const survivors = db
      .prepare<[], { external_id: string }>("SELECT external_id FROM documents")
      .all()
      .map((r) => r.external_id);
    expect(survivors).toEqual(["msg-2"]);
  });

  test("suppression is scoped to the tombstoned key only", () => {
    deleteDocumentForUser(db, "google", "gmail", "msg-1");

    // A different doc on the same source is unaffected.
    upsertDocuments(db, [makeDoc({ externalId: "msg-3", contentHash: "new" })]);
    const survivors = db
      .prepare<[], { external_id: string }>(
        "SELECT external_id FROM documents ORDER BY external_id",
      )
      .all()
      .map((r) => r.external_id);
    expect(survivors).toEqual(["msg-2", "msg-3"]);
  });

  test("a full source wipe clears the tombstone so re-add starts fresh", () => {
    deleteDocumentForUser(db, "google", "gmail", "msg-1");
    expect(tombstoneCount()).toBe(1);

    // Remove & re-add the source (deleteAllBySource is the wipe primitive).
    deleteAllBySource(db, "gmail");
    expect(tombstoneCount()).toBe(0);

    // The previously-deleted doc can now be ingested again.
    upsertDocuments(db, [makeDoc({ externalId: "msg-1", contentHash: "again" })]);
    const survivors = db
      .prepare<[], { external_id: string }>("SELECT external_id FROM documents")
      .all()
      .map((r) => r.external_id);
    expect(survivors).toContain("msg-1");
  });

  test("tombstone is per-(provider,source) — a same-id doc on another source is unaffected", () => {
    upsertDocuments(db, [makeDoc({ sourceId: "google-calendar", externalId: "msg-1" })]);

    deleteDocumentForUser(db, "google", "gmail", "msg-1");

    // Re-upserting msg-1 on gmail is suppressed, but the calendar msg-1 is
    // untouched and a fresh calendar upsert of it still works.
    upsertDocuments(db, [makeDoc({ externalId: "msg-1", contentHash: "x" })]); // gmail — suppressed
    upsertDocuments(db, [
      makeDoc({ sourceId: "google-calendar", externalId: "msg-1", contentHash: "y" }),
    ]);
    const gmail = db
      .prepare<
        [],
        { count: number }
      >("SELECT COUNT(*) as count FROM documents WHERE source_id = 'gmail' AND external_id = 'msg-1'")
      .get();
    const cal = db
      .prepare<
        [],
        { count: number }
      >("SELECT COUNT(*) as count FROM documents WHERE source_id = 'google-calendar' AND external_id = 'msg-1'")
      .get();
    expect(gmail?.count).toBe(0);
    expect(cal?.count).toBe(1);
  });
});

describe("activity document retention", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    upsertDocuments(db, [
      makeDoc({ externalId: "conversation-1" }),
      makeDoc({ externalId: "conversation-1/att/legacy", contentHash: "child" }),
    ]);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("deletes and tombstones only the exact trace, then clears the temporary tombstone", () => {
    const id = deleteDocumentForRetention(db, "google", "gmail", "conversation-1");
    expect(id).toEqual(expect.any(String));
    expect(
      db
        .prepare<[], { external_id: string }>(
          "SELECT external_id FROM documents ORDER BY external_id",
        )
        .all()
        .map((row) => row.external_id),
    ).toEqual(["conversation-1/att/legacy"]);
    expect(
      db
        .prepare<
          [],
          { original_document_id: string | null }
        >("SELECT original_document_id FROM removed_documents")
        .get()?.original_document_id,
    ).toBe(id);

    completeDocumentRetention(db, "google", "gmail", "conversation-1");
    expect(db.prepare("SELECT 1 FROM removed_documents").get()).toBeUndefined();
  });

  test("rolls the document delete back when the retention tombstone cannot commit", () => {
    db.exec(`
      CREATE TRIGGER reject_retention_tombstone
      BEFORE INSERT ON removed_documents
      BEGIN
        SELECT RAISE(ABORT, 'synthetic tombstone failure');
      END;
    `);

    expect(() => deleteDocumentForRetention(db, "google", "gmail", "conversation-1")).toThrow(
      /synthetic tombstone failure/,
    );
    expect(
      db
        .prepare<
          [],
          { id: string }
        >("SELECT id FROM documents WHERE source_id = 'gmail' AND external_id = 'conversation-1'")
        .get(),
    ).toBeDefined();
    expect(db.prepare("SELECT 1 FROM removed_documents").get()).toBeUndefined();
  });
});

describe("snapshot reconcile (absence, not deletion)", () => {
  let db: Db;
  let dbPath: string;

  /** The shipped policy: three corroborating snapshots spanning a day. */
  const POLICY = {
    minObservations: 3,
    minAgeMs: 24 * 60 * 60_000,
    maxMarksPerSnapshot: 10_000,
  };

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    upsertDocuments(db, [
      makeDoc({ externalId: "msg-1" }),
      makeDoc({ externalId: "msg-2" }),
      makeDoc({ externalId: "msg-3" }),
      makeDoc({ externalId: "msg-4" }),
    ]);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  function reconcile(present: string[], streamId = "") {
    const plan = computeSnapshotAbsencePlan(db, "google", "gmail", present, POLICY, streamId);
    applySnapshotAbsencePlan(db, plan);
    return plan;
  }

  function storedFor(sourceId: string): string[] {
    return db
      .prepare<[string], StoredDocument>(
        "SELECT external_id FROM documents WHERE source_id = ? ORDER BY external_id",
      )
      .all(sourceId)
      .map((r) => r.external_id);
  }

  test("documents absent from the snapshot are marked, not deleted", () => {
    const plan = reconcile(["msg-1", "msg-3"]);

    expect(plan.mark.map((m) => m.externalId).sort()).toEqual(["msg-2", "msg-4"]);
    expect(storedFor("gmail")).toEqual(["msg-1", "msg-2", "msg-3", "msg-4"]);
    expect(countPendingAbsences(db)).toBe(2);
  });

  test("a replicated snapshot deletion resets every member for self-healing", () => {
    const owner = createDevice(db, { name: "replica-owner", kind: "collector" }).id;
    const sibling = createDevice(db, { name: "replica-sibling", kind: "collector" }).id;
    const source = createSource(db, {
      type: SourceType("fictional-tasks"),
      accountId: AccountId("shared"),
      deviceId: owner,
      multiDeviceMode: "replicated",
    });
    addSourceMember(db, source.id, sibling);
    setSyncState(db, source.id, { page: 1 }, undefined, undefined, true, undefined, owner);
    setSyncState(db, source.id, { page: 1 }, undefined, undefined, true, undefined, sibling);
    upsertDocuments(db, [
      makeDoc({ providerId: "fictional-tasks", sourceId: source.id, externalId: "gone" }),
    ]);
    const immediate = { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 10 };
    const plan = computeSnapshotAbsencePlan(db, "fictional-tasks", source.id, [], immediate);
    applySnapshotAbsencePlan(db, plan);
    const documentId = db
      .prepare<
        [],
        { id: string }
      >("SELECT id FROM documents WHERE source_id = 'fictional-tasks:shared'")
      .get()!.id;

    sweepDueAbsences(db, [documentId], {
      minObservations: 1,
      dueBefore: Date.now() + 1,
      now: Date.now(),
      deleteDocumentsByIds,
    });

    expect(getSyncState(db, source.id, owner)?.last_synced_at).toBeNull();
    expect(getSyncState(db, source.id, sibling)?.last_synced_at).toBeNull();
    expect(getWipeEpoch(db, source.id, owner)).toBe(1);
    expect(getWipeEpoch(db, source.id, sibling)).toBe(1);
  });

  test("an arriving document revokes its pending absence without requiring a new snapshot", () => {
    reconcile(["msg-1", "msg-3"]);
    expect(countPendingAbsences(db)).toBe(2);

    upsertDocuments(db, [makeDoc({ externalId: "msg-2" })]);

    expect(
      db
        .prepare<[], { external_id: string }>(
          "SELECT external_id FROM document_absences ORDER BY external_id",
        )
        .all()
        .map((row) => row.external_id),
    ).toEqual(["msg-4"]);
  });

  test("an old snapshot identity stays superseded after a newer document arrival", () => {
    const stale = computeSnapshotAbsencePlan(db, "google", "gmail", ["msg-1", "msg-3"], POLICY, {
      observationId: "snapshot-before-arrival",
    });

    upsertDocuments(db, [makeDoc({ externalId: "msg-2" })]);
    expect(applySnapshotAbsencePlan(db, stale)).toEqual({ marked: 0, cleared: 0 });

    const retry = computeSnapshotAbsencePlan(db, "google", "gmail", ["msg-1", "msg-3"], POLICY, {
      observationId: "snapshot-before-arrival",
    });
    expect(applySnapshotAbsencePlan(db, retry)).toEqual({ marked: 0, cleared: 0 });
    expect(
      db
        .prepare<[], { external_id: string }>(
          "SELECT external_id FROM document_absences ORDER BY external_id",
        )
        .all()
        .map((row) => row.external_id),
    ).not.toContain("msg-2");
  });

  test("an empty snapshot marks every doc for the source and deletes none", () => {
    const plan = reconcile([]);

    expect(plan.absentCount).toBe(4);
    expect(storedFor("gmail")).toEqual(["msg-1", "msg-2", "msg-3", "msg-4"]);
  });

  test("a snapshot superset of the known ids marks nothing", () => {
    const plan = reconcile(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5", "msg-6"]);

    expect(plan.absentCount).toBe(0);
    expect(plan.mark).toEqual([]);
    // The two ids the source names that the corpus does not hold are the
    // detector for the opposite failure — a corpus that lost documents.
    expect(plan.missingCount).toBe(2);
    expect(countPendingAbsences(db)).toBe(0);
  });

  test("scoped to (providerId, sourceId) — a sibling source is never marked", () => {
    upsertDocuments(db, [
      makeDoc({ sourceId: "google-calendar", externalId: "evt-1" }),
      makeDoc({ sourceId: "google-calendar", externalId: "evt-2" }),
    ]);

    reconcile([]);

    const marked = db
      .prepare<[], { source_id: string }>("SELECT DISTINCT source_id FROM document_absences")
      .all()
      .map((r) => r.source_id);
    expect(marked).toEqual(["gmail"]);
    expect(storedFor("google-calendar")).toEqual(["evt-1", "evt-2"]);
  });

  test("scoped to providerId — the same sourceId under another provider is untouched", () => {
    upsertDocuments(db, [makeDoc({ providerId: "imap", sourceId: "gmail", externalId: "msg-x" })]);

    const plan = reconcile([]);

    expect(plan.storedCount).toBe(4);
    const marked = db
      .prepare<[], { provider_id: string }>("SELECT DISTINCT provider_id FROM document_absences")
      .all()
      .map((r) => r.provider_id);
    expect(marked).toEqual(["google"]);
  });

  test("a document upserted between the compute and the write invalidates the stale snapshot", () => {
    // Arrival is newer positive evidence. The upsert advances the scope
    // revision, so the older plan cannot mark either that document or its
    // siblings from a read that no longer describes the current source state.
    const plan = computeSnapshotAbsencePlan(db, "google", "gmail", ["msg-1"], POLICY);
    upsertDocuments(db, [makeDoc({ externalId: "msg-5" })]);
    applySnapshotAbsencePlan(db, plan);

    const marked = db
      .prepare<[], { external_id: string }>(
        "SELECT external_id FROM document_absences ORDER BY external_id",
      )
      .all()
      .map((r) => r.external_id);
    expect(marked).toEqual([]);
    expect(storedFor("gmail")).toEqual(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
  });

  test("handles a snapshot well above the SQLite parameter cap", () => {
    // The diff runs in memory over one scan, so a 50k-id snapshot costs no
    // bound variables at all.
    const present = Array.from({ length: 50_000 }, (_, i) => `bulk-${i}`);
    present.push("msg-1");
    const plan = reconcile(present);

    expect(plan.snapshotCount).toBe(50_001);
    expect(plan.mark.map((m) => m.externalId).sort()).toEqual(["msg-2", "msg-3", "msg-4"]);
    expect(storedFor("gmail")).toHaveLength(4);
  });
});

describe("deleteAllByStream", () => {
  let db: Db;
  let dbPath: string;
  const page = (streamId: string, externalIds: string[]) =>
    upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: externalIds.map((externalId) =>
        makeDoc({ externalId, contentHash: `${streamId}-${externalId}` }),
      ),
      hasMore: false,
      cursor: { page: 1 },
      cursorDeviceId: streamId,
      streamId,
      wipeEpoch: getWipeEpoch(db, "gmail", streamId),
    });
  const linkCount = (): number =>
    db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_links").get()!.n;
  const tombstones = (): string[] =>
    db
      .prepare<[], { stream_id: string }>("SELECT stream_id FROM removed_documents ORDER BY 1")
      .all()
      .map((r) => r.stream_id);

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    page("device-a", ["day-1", "day-2"]);
    page("device-b", ["day-1", "day-3"]);
    upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [makeDoc({ externalId: "old-1", contentHash: "shared-old-1" })],
      hasMore: false,
      cursor: { page: 1 },
    });
    // One cascade row per document, so the stream's go and the others stay.
    for (const { id } of db.prepare<[], { id: string }>("SELECT id FROM documents").all()) {
      db.prepare(
        `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, created_at)
         VALUES (?, 'url', 'https://example.com/x', 'https://example.com/x', '2026-01-01T00:00:00Z')`,
      ).run(id);
    }
    tombstoneDocuments(db, "google", "gmail", ["gone-a"], undefined, "device-a");
    tombstoneDocuments(db, "google", "gmail", ["gone-b"], undefined, "device-b");
    tombstoneDocuments(db, "google", "gmail", ["gone-shared"]);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("removes one stream's documents, cascade rows and tombstones; the sibling and shared streams keep theirs", () => {
    expect(getDocumentCount(db, "gmail")).toBe(5);
    expect(linkCount()).toBe(5);
    const doomed = db
      .prepare<[], { id: string }>(
        "SELECT id FROM documents WHERE stream_id = 'device-a' ORDER BY id",
      )
      .all()
      .map((r) => r.id);

    const result = deleteAllByStream(db, "gmail", "device-a");

    expect(result.deleted).toBe(2);
    expect([...result.documentIds].sort()).toEqual(doomed);
    expect(getDocumentCount(db, "gmail")).toBe(3);
    expect(checkExistingExternalIds(db, "google", "gmail", ["day-1", "day-2"], "device-a")).toEqual(
      [],
    );
    expect(checkExistingExternalIds(db, "google", "gmail", ["day-1", "day-3"], "device-b")).toEqual(
      ["day-1", "day-3"],
    );
    expect(checkExistingExternalIds(db, "google", "gmail", ["old-1"])).toEqual(["old-1"]);
    expect(linkCount()).toBe(3);
    expect(tombstones()).toEqual(["", "device-b"]);
    // The sibling's tombstone still suppresses its re-push; A's is lifted.
    page("device-b", ["gone-b"]);
    page("device-a", ["gone-a"]);
    expect(checkExistingExternalIds(db, "google", "gmail", ["gone-b"], "device-b")).toEqual([]);
    expect(checkExistingExternalIds(db, "google", "gmail", ["gone-a"], "device-a")).toEqual([
      "gone-a",
    ]);
    // The source's stats row stays and is marked for a refresh.
    expect(
      db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM source_stats WHERE source_id = 'gmail'")
        .get()!.n,
    ).toBe(1);
  });

  test("advances the epoch of that stream's cursor row only; the shared and sibling claims survive", () => {
    const shared = beginSyncAttempt(db, "gmail", "");
    const a = beginSyncAttempt(db, "gmail", "device-a");
    const b = beginSyncAttempt(db, "gmail", "device-b");

    deleteAllByStream(db, "gmail", "device-a");

    expect(getWipeEpoch(db, "gmail", "device-a")).toBe(a + 1);
    expect(getWipeEpoch(db, "gmail", "device-b")).toBe(b);
    expect(getWipeEpoch(db, "gmail", "")).toBe(shared);
    // A's in-flight page loses its authority; B's still commits.
    expect(setSyncState(db, "gmail", { page: 9 }, undefined, undefined, false, a, "device-a")).toBe(
      false,
    );
    expect(setSyncState(db, "gmail", { page: 9 }, undefined, undefined, false, b, "device-b")).toBe(
      true,
    );
    // A stream that never claimed a row gets one, so a writer holding epoch 0 is refused too.
    deleteAllByStream(db, "gmail", "device-c");
    expect(getWipeEpoch(db, "gmail", "device-c")).toBe(1);
  });

  test("resetMemberCursor keeps the row with no completed sync and a fresh epoch; metadata survives", () => {
    setSyncState(
      db,
      "gmail",
      { page: 4 },
      { icon: "📧", label: "Mail" },
      undefined,
      true,
      undefined,
      "device-a",
    );
    const claimed = beginSyncAttempt(db, "gmail", "device-a");
    setSyncError(db, "gmail", "auth lapsed", "device-a");

    resetMemberCursor(db, "gmail", "device-a");

    const row = getSyncState(db, "gmail", "device-a");
    expect(row).toMatchObject({
      cursor: "{}",
      last_synced_at: null,
      last_error: null,
      errored_at: null,
      label: "Mail",
    });
    expect(getWipeEpoch(db, "gmail", "device-a")).toBe(claimed + 1);
    expect(
      setSyncState(db, "gmail", { page: 5 }, undefined, undefined, false, claimed, "device-a"),
    ).toBe(false);
    // A member that never had a row gets one, so it does not adopt the shared row.
    resetMemberCursor(db, "gmail", "device-b");
    expect(getSyncState(db, "gmail", "device-b")).toMatchObject({
      cursor: "{}",
      last_synced_at: null,
    });
    expect(getWipeEpoch(db, "gmail", "device-b")).toBe(1);
  });
});

describe("membership retires a member's cursor", () => {
  let db: Db;
  let dbPath: string;
  const cursorArgs = [undefined, undefined, false] as const;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  const host = (name: string) => createDevice(db, { name, kind: "collector" }).id;
  const seed = () =>
    createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("shared"),
      deviceId: host("owner"),
    });

  test("a detach keeps the member's epoch row and advances it: the in-flight claim is refused, a re-join claims past it", () => {
    const source = seed();
    const member = host("member");
    addSourceMember(db, source.id, member);
    setSyncState(db, source.id, { page: 3 }, ...cursorArgs, undefined, member);
    const claimed = beginSyncAttempt(db, source.id, member);

    expect(removeSourceMember(db, source.id, member).removed).toBe(true);

    // The cursor is forgotten; the fence is not.
    expect(getSyncState(db, source.id, member)).toBeNull();
    expect(getWipeEpoch(db, source.id, member)).toBe(claimed + 1);
    expect(setSyncState(db, source.id, { page: 4 }, ...cursorArgs, claimed, member)).toBe(false);
    expect(getSyncState(db, source.id, member)).toBeNull();
    // A re-join continues the row: its first claim is newer than the stale one.
    addSourceMember(db, source.id, member);
    expect(beginSyncAttempt(db, source.id, member)).toBeGreaterThan(claimed);
  });

  test("a move retires every old cursor, including the shared row", () => {
    const source = seed();
    const claimer = host("claimer");
    const silent = host("silent");
    const target = host("target");
    addSourceMember(db, source.id, claimer);
    addSourceMember(db, source.id, silent);
    const shared = beginSyncAttempt(db, source.id);
    const owner = beginSyncAttempt(db, source.id, source.deviceId);
    const claimed = beginSyncAttempt(db, source.id, claimer);

    expect(updateSource(db, source.id, { deviceId: target })?.deviceId).toBe(target);

    expect(listSourceMembers(db, source.id).map((m) => m.deviceId)).toEqual([target]);
    expect(getWipeEpoch(db, source.id, source.deviceId)).toBe(owner + 1);
    expect(getWipeEpoch(db, source.id, claimer)).toBe(claimed + 1);
    expect(getWipeEpoch(db, source.id, silent)).toBe(1);
    expect(getWipeEpoch(db, source.id)).toBe(shared + 1);
    expect(setSyncState(db, source.id, { page: 4 }, ...cursorArgs, claimed, claimer)).toBe(false);
    expect(setSyncState(db, source.id, { page: 4 }, ...cursorArgs, shared)).toBe(false);
  });

  test("a move onto a member keeps that member's cursor and write authority", () => {
    const source = seed();
    const target = host("target");
    addSourceMember(db, source.id, target);
    const claimed = beginSyncAttempt(db, source.id, target);
    expect(setSyncState(db, source.id, { page: 2 }, ...cursorArgs, claimed, target)).toBe(true);

    expect(updateSource(db, source.id, { deviceId: target })?.deviceId).toBe(target);

    expect(listSourceMembers(db, source.id).map((m) => m.deviceId)).toEqual([target]);
    expect(getWipeEpoch(db, source.id, target)).toBe(claimed);
    expect(JSON.parse(String(getSyncState(db, source.id, target)?.cursor))).toEqual({ page: 2 });
    expect(setSyncState(db, source.id, { page: 3 }, ...cursorArgs, claimed, target)).toBe(true);
  });
});

describe("deleteAllBySource", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    upsertDocuments(db, [
      makeDoc({ sourceId: "gmail", externalId: "msg-1" }),
      makeDoc({ sourceId: "gmail", externalId: "msg-2" }),
      makeDoc({ sourceId: "google-calendar", externalId: "evt-1" }),
    ]);
    setSyncState(db, "gmail", { historyId: "100" });
    setSyncState(db, "google-calendar", { syncToken: "abc" });
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("deletes all documents for the specified source", () => {
    const deleted = deleteAllBySource(db, "gmail");
    expect(deleted).toBe(2);

    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(1);

    // Calendar doc should remain
    const rows = db.prepare<[], StoredDocument>("SELECT * FROM documents").all();
    expect(rows[0].source_id).toBe("google-calendar");
  });

  test("removes sync state for the source", () => {
    deleteAllBySource(db, "gmail");
    expect(getSyncState(db, "gmail")).toBeNull();
    // Other source's sync state should remain
    expect(getSyncState(db, "google-calendar")).not.toBeNull();
  });

  test("returns 0 when source has no documents", () => {
    const deleted = deleteAllBySource(db, "nonexistent");
    expect(deleted).toBe(0);
  });

  /**
   * Seed an identifier the way the product does — the insert and the record of
   * who vouches for it, together. A raw INSERT into `person_aliases` describes
   * a state no writer produces, and a removal cannot reason about it.
   */
  const claim = (sourceId: string, personId: string, aliasType: string, alias: string): void => {
    aliasWriter(db, sourceId, "2026-04-01T00:00:00Z").claim(personId, aliasType, alias);
  };
  const aliasesOf = (personId: string): string[] =>
    db
      .prepare<[string], { alias: string }>(
        "SELECT alias FROM person_aliases WHERE person_id = ? ORDER BY alias",
      )
      .all(personId)
      .map((r) => r.alias);

  test("withdraws the removed source's identifiers", () => {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES ('p1', 'Alice', 'gmail', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z')`,
    ).run();
    claim("gmail", "p1", "email", "alice@example.com");
    claim("whatsapp-messages:+phone", "p1", "phone", "+447700000006");
    claim("google-calendar", "p1", "name", "alice");

    deleteAllBySource(db, "gmail");

    expect(aliasesOf("p1")).toEqual(["+447700000006", "alice"]);
  });

  test("keeps an identifier another source still vouches for", () => {
    // The defect this replaced: `person_aliases.source_id` records only the
    // FIRST source to see an identifier, so an address a mail source happened
    // to see first went with the mail source — taking the person with it when
    // it was their last one, and the other sources' attribution with them.
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES ('p1', 'Alice', 'gmail', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z')`,
    ).run();
    claim("gmail", "p1", "email", "alice@example.com");
    claim("google-calendar", "p1", "email", "alice@example.com");

    deleteAllBySource(db, "gmail");

    expect(aliasesOf("p1")).toEqual(["alice@example.com"]);
    expect(db.prepare<[], { id: string }>("SELECT id FROM people").all()).toHaveLength(1);
  });

  test("an identifier the operator configured survives an unrelated source's removal", () => {
    // Config and device writers reach the same table. Under a first-writer
    // wins column their entry was invisible to the withdrawal, so removing a
    // mail source that also saw the address deleted the operator's own.
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES ('self', 'Me', 'config', TRUE, '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z')`,
    ).run();
    claim("config", "self", "email", "me@example.com");
    claim("gmail", "self", "email", "me@example.com");

    deleteAllBySource(db, "gmail");

    expect(aliasesOf("self")).toEqual(["me@example.com"]);
  });

  test("sweeps `people` rows that lost their last anchor (no aliases AND no document_people)", () => {
    // Person whose ONLY alias is from gmail. Document_people had a row
    // but it cascaded out when `documents` was deleted.
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES ('p1', 'Alice', 'gmail', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z'),
              ('p2', 'Bob',   'gmail', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z')`,
    ).run();
    claim("gmail", "p1", "email", "alice@example.com");
    claim("gmail", "p2", "email", "bob@example.com");
    claim("google-calendar", "p2", "email", "bob.calendar@example.com");

    deleteAllBySource(db, "gmail");

    const remaining = db.prepare<[], { id: string }>("SELECT id FROM people ORDER BY id").all();
    // p1 had only a gmail alias → swept.
    // p2 still has the calendar alias → kept.
    expect(remaining.map((r) => r.id)).toEqual(["p2"]);
  });

  test("DOES sweep people whose aliases are gone, even if document_people anchors remain (ghost cleanup)", () => {
    // Person p1 had a gmail alias and a document_people row from a
    // calendar doc. After gmail removal: alias gone. The document_people
    // row from calendar can't keep p1 alive — without aliases, p1 is a
    // ghost identity (can't match future mentions, clutters /people
    // search with alias_count=0). Sweep them. The calendar doc's
    // document_people row cascade-deletes — correct, since p1 has no
    // identifying aliases left to anchor the link to.
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES ('p1', 'Alice', 'gmail', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z')`,
    ).run();
    claim("gmail", "p1", "email", "alice@example.com");
    const calDoc = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE source_id = ? LIMIT 1")
      .get("google-calendar");
    expect(calDoc).toBeTruthy();
    db.prepare(
      `INSERT INTO document_people (document_id, person_id, role, source_id)
       VALUES (?, 'p1', 'attendee', 'google-calendar')`,
    ).run(calDoc!.id);

    deleteAllBySource(db, "gmail");

    const remaining = db.prepare<[], { id: string }>("SELECT id FROM people").all();
    expect(remaining.map((r) => r.id)).toEqual([]);
    // Cascade cleared the calendar doc's document_people row.
    const cascaded = db
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM document_people WHERE document_id = ?")
      .get(calDoc!.id)!.n;
    expect(cascaded).toBe(0);
  });

  test("preserves is_self person even when its only aliases came from the deleted source", () => {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES ('self', 'Me', 'gmail', TRUE, '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z')`,
    ).run();
    claim("gmail", "self", "email", "me@example.com");

    deleteAllBySource(db, "gmail");

    const remaining = db.prepare<[], { id: string }>("SELECT id FROM people").all();
    expect(remaining.map((r) => r.id)).toEqual(["self"]);
  });
});

describe("deleteAllByProvider", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    upsertDocuments(db, [
      makeDoc({ providerId: "google", sourceId: "gmail", externalId: "msg-1" }),
      makeDoc({ providerId: "google", sourceId: "google-calendar", externalId: "evt-1" }),
      makeDoc({ providerId: "apple", sourceId: "apple-notes", externalId: "note-1" }),
    ]);
    setSyncState(db, "gmail", { historyId: "100" });
    setSyncState(db, "google-calendar", { syncToken: "abc" });
    setSyncState(db, "apple-notes", { lastMtime: 12345 });
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("deletes all documents for the specified provider", () => {
    const deleted = deleteAllByProvider(db, "google");
    expect(deleted).toBe(2);

    const count = db
      .prepare<[], { count: number }>("SELECT COUNT(*) as count FROM documents")
      .get();
    expect(count?.count).toBe(1);

    const rows = db.prepare<[], StoredDocument>("SELECT * FROM documents").all();
    expect(rows[0].provider_id).toBe("apple");
  });

  test("removes sync state for all affected sources", () => {
    deleteAllByProvider(db, "google");
    expect(getSyncState(db, "gmail")).toBeNull();
    expect(getSyncState(db, "google-calendar")).toBeNull();
    // Apple sync state should remain
    expect(getSyncState(db, "apple-notes")).not.toBeNull();
  });

  test("withdraws the provider's claims without taking what another source asserts", () => {
    // The provider wipe retracts per source, the same way a single removal
    // does. It had no test, so reverting it alone stayed green — and it
    // reintroduces the whole defect.
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES ('p1', 'Alice', 'gmail', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z')`,
    ).run();
    const claim = (sourceId: string, aliasType: string, alias: string) =>
      aliasWriter(db, sourceId, "2026-04-01T00:00:00Z").claim("p1", aliasType, alias);
    claim("gmail", "email", "alice@example.com");
    claim("apple-notes", "email", "alice@example.com");
    claim("google-calendar", "phone", "+447700900001");

    deleteAllByProvider(db, "google");

    const remaining = db
      .prepare<[], { alias: string }>("SELECT alias FROM person_aliases ORDER BY alias")
      .all()
      .map((r) => r.alias);
    // The phone was google's alone and goes; the address a note still asserts
    // stays, and so does the person it identifies.
    expect(remaining).toEqual(["alice@example.com"]);
  });

  test("revokes a zero-document source lease during provider wipe", () => {
    setSyncState(db, "empty-google-source", { page: 0 });
    const staleEpoch = beginSyncAttempt(db, "empty-google-source");

    deleteAllByProvider(db, "google");
    const result = upsertWithCursor(db, {
      providerId: "google",
      sourceId: "empty-google-source",
      documents: [
        makeDoc({
          providerId: "google",
          sourceId: "empty-google-source",
          externalId: "late-page",
        }),
      ],
      hasMore: false,
      cursor: { page: 1 },
      wipeEpoch: staleEpoch,
    });

    expect(result.rejected).toBe(true);
    expect(checkExistingExternalIds(db, "google", "empty-google-source", ["late-page"])).toEqual(
      [],
    );
  });

  test("revokes a registered legacy zero-document source during provider wipe", () => {
    const device = createDevice(db, { name: "Fictional collector", kind: "collector" });
    const source = createSource(db, {
      type: SourceType("gmail"),
      accountId: AccountId("legacy@example.com"),
      deviceId: device.id,
    });
    expect(getWipeEpoch(db, source.id)).toBe(0);

    deleteAllByProvider(db, "google");
    expect(getWipeEpoch(db, source.id)).toBe(1);
    const result = upsertWithCursor(db, {
      providerId: "google",
      sourceId: source.id,
      documents: [
        makeDoc({ providerId: "google", sourceId: source.id, externalId: "legacy-late" }),
      ],
      hasMore: false,
      cursor: { page: 1 },
    });

    expect(result.rejected).toBe(true);
    expect(checkExistingExternalIds(db, "google", source.id, ["legacy-late"])).toEqual([]);
  });

  test("returns 0 when provider has no documents", () => {
    const deleted = deleteAllByProvider(db, "nonexistent");
    expect(deleted).toBe(0);
  });
});

describe("sync state", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("returns null for unknown source", () => {
    const state = getSyncState(db, "nonexistent");
    expect(state).toBeNull();
  });

  test("stores and retrieves sync state", () => {
    setSyncState(db, "gmail", { historyId: "12345" });

    const state = getSyncState(db, "gmail");
    expect(state).not.toBeNull();
    expect(JSON.parse(state!.cursor)).toEqual({ historyId: "12345" });
    expect(state!.source_id).toBe("gmail");
    expect(state!.last_synced_at).toBeTruthy();
  });

  test("updates existing sync state", () => {
    setSyncState(db, "gmail", { historyId: "100" });
    setSyncState(db, "gmail", { historyId: "200" });

    const state = getSyncState(db, "gmail");
    expect(JSON.parse(state!.cursor)).toEqual({ historyId: "200" });
  });

  test("maintains independent state per source", () => {
    setSyncState(db, "gmail", { historyId: "100" });
    setSyncState(db, "google-calendar", {
      calendarSyncTokens: { primary: "token-abc" },
    });

    const gmail = getSyncState(db, "gmail");
    const cal = getSyncState(db, "google-calendar");
    expect(JSON.parse(gmail!.cursor)).toEqual({ historyId: "100" });
    expect(JSON.parse(cal!.cursor)).toEqual({
      calendarSyncTokens: { primary: "token-abc" },
    });
  });

  test("setSyncError persists error without disturbing cursor or last_synced_at", () => {
    setSyncState(db, "gmail", { historyId: "100" });
    const before = getSyncState(db, "gmail");
    expect(before!.last_synced_at).toBeTruthy();

    setSyncError(db, "gmail", "something exploded");

    const after = getSyncState(db, "gmail");
    expect(JSON.parse(after!.cursor)).toEqual({ historyId: "100" });
    expect(after!.last_synced_at).toBe(before!.last_synced_at);
    expect(after!.last_error).toBe("something exploded");
    expect(after!.errored_at).toBeTruthy();
  });

  test("setSyncError works for a source with no prior sync row (last_synced_at stays NULL)", () => {
    setSyncError(db, "brand-new", "boom");

    const row = getSyncState(db, "brand-new");
    expect(row).not.toBeNull();
    expect(row!.last_synced_at).toBeNull();
    expect(row!.last_error).toBe("boom");
    expect(row!.errored_at).toBeTruthy();
  });

  test("setSyncState clears persisted error on next successful cursor save", () => {
    setSyncError(db, "gmail", "failed");
    expect(getSyncState(db, "gmail")!.last_error).toBe("failed");

    setSyncState(db, "gmail", { historyId: "1" });
    const row = getSyncState(db, "gmail");
    expect(row!.last_error).toBeNull();
    expect(row!.errored_at).toBeNull();
  });

  test("clearSyncError clears just the error fields", () => {
    setSyncState(db, "gmail", { historyId: "1" });
    setSyncError(db, "gmail", "boom");
    clearSyncError(db, "gmail");

    const row = getSyncState(db, "gmail")!;
    expect(row.last_error).toBeNull();
    expect(row.errored_at).toBeNull();
    expect(JSON.parse(row.cursor)).toEqual({ historyId: "1" });
    expect(row.last_synced_at).toBeTruthy();
  });

  test("listSyncStates returns every persisted row", () => {
    setSyncState(db, "gmail", { historyId: "1" });
    setSyncError(db, "outlook", "auth failed");

    const rows = listSyncStates(db);
    const byId = new Map(rows.map((r) => [r.source_id, r]));
    expect(byId.get("gmail")?.last_synced_at).toBeTruthy();
    expect(byId.get("gmail")?.last_error).toBeNull();
    expect(byId.get("outlook")?.last_synced_at).toBeNull();
    expect(byId.get("outlook")?.last_error).toBe("auth failed");
  });

  test("setSyncError truncates very long messages", () => {
    const big = "x".repeat(10_000);
    setSyncError(db, "gmail", big);
    const row = getSyncState(db, "gmail")!;
    expect(row.last_error!.length).toBeLessThanOrEqual(2001);
    expect(row.last_error!.endsWith("…")).toBe(true);
  });
});

describe("listDocuments", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("returns all documents when no filters", () => {
    upsertDocuments(db, [makeDoc({ externalId: "msg-1" }), makeDoc({ externalId: "msg-2" })]);

    const result = listDocuments(db);
    expect(result.documents).toHaveLength(2);
    expect(result.hasMore).toBe(false);
    // Each document should have the expected shape
    for (const doc of result.documents) {
      expect(doc.id).toBeTruthy();
      expect(doc.sourceId).toBe("gmail");
      expect(doc.content).toBeTruthy();
      expect(doc.updatedAt).toBeTruthy();
    }
  });

  test("filters by updatedSince", () => {
    upsertDocuments(db, [makeDoc({ externalId: "msg-1" })]);
    // Insert another doc, then exercise bounds on both sides of their timestamps.
    upsertDocuments(db, [makeDoc({ externalId: "msg-2" })]);

    // Filter with a timestamp far in the future — should return nothing
    const result = listDocuments(db, { updatedSince: "2099-01-01T00:00:00Z" });
    expect(result.documents).toHaveLength(0);

    // Filter with a timestamp in the past — should return all
    const result2 = listDocuments(db, { updatedSince: "2000-01-01T00:00:00Z" });
    expect(result2.documents).toHaveLength(2);
  });

  test("filters by excludeSourceIds", () => {
    upsertDocuments(db, [
      makeDoc({ externalId: "msg-1", sourceId: "gmail" }),
      makeDoc({ externalId: "msg-2", sourceId: "google-calendar" }),
      makeDoc({ externalId: "msg-3", sourceId: "apple-notes" }),
    ]);

    const result = listDocuments(db, { excludeSourceIds: ["gmail", "apple-notes"] });
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].sourceId).toBe("google-calendar");
  });

  test("paginates with afterId and limit", () => {
    upsertDocuments(db, [
      makeDoc({ externalId: "msg-1" }),
      makeDoc({ externalId: "msg-2" }),
      makeDoc({ externalId: "msg-3" }),
    ]);

    // Get first page with limit 2
    const page1 = listDocuments(db, { limit: 2 });
    expect(page1.documents).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    // Get second page using afterId
    const lastId = page1.documents[page1.documents.length - 1].id;
    const page2 = listDocuments(db, { limit: 2, afterId: lastId });
    expect(page2.documents).toHaveLength(1);
    expect(page2.hasMore).toBe(false);

    // IDs should not overlap
    const page1Ids = page1.documents.map((d) => d.id);
    const page2Ids = page2.documents.map((d) => d.id);
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }
  });

  test("returns empty result when no documents match", () => {
    const result = listDocuments(db);
    expect(result.documents).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("filters by includeSourceIds (positive filter)", () => {
    upsertDocuments(db, [
      makeDoc({ externalId: "g1", sourceId: "gmail:alice@example.com" }),
      makeDoc({ externalId: "g2", sourceId: "gmail:alice@example.com" }),
      makeDoc({ externalId: "n1", sourceId: "notion-pages:wid" }),
      makeDoc({ externalId: "i1", sourceId: "apple-imessage:bob@example.com" }),
    ]);
    const result = listDocuments(db, {
      includeSourceIds: ["gmail:alice@example.com", "notion-pages:wid"],
    });
    expect(result.documents).toHaveLength(3);
    const ids = result.documents.map((d) => d.sourceId).sort();
    expect(ids).toEqual(["gmail:alice@example.com", "gmail:alice@example.com", "notion-pages:wid"]);
  });

  test("includeSourceIds composes with excludeSourceIds (intersection)", () => {
    upsertDocuments(db, [
      makeDoc({ externalId: "g1", sourceId: "gmail" }),
      makeDoc({ externalId: "b1", sourceId: "browser-history" }),
      makeDoc({ externalId: "n1", sourceId: "notion" }),
    ]);
    const result = listDocuments(db, {
      includeSourceIds: ["gmail", "browser-history", "notion"],
      excludeSourceIds: ["browser-history"],
    });
    expect(result.documents).toHaveLength(2);
    expect(result.documents.map((d) => d.sourceId).sort()).toEqual(["gmail", "notion"]);
  });

  // When includeSourceIds is set, the planner should be free to
  // pick the more selective `idx_documents_source_id_updated_at`
  // instead of the forced `idx_documents_updated_at_id`. We assert
  // the directive is dropped — that's what gives the planner the
  // freedom; planner choice itself is environment-dependent.
  test("listDocuments query plan: drops INDEXED BY when includeSourceIds is set", () => {
    upsertDocuments(db, [makeDoc({ externalId: "g1", sourceId: "gmail:alice@example.com" })]);
    // Reach into the same-shape SQL the production code emits and check
    // EXPLAIN. Without includeSourceIds + with updatedSince, planner is
    // forced onto idx_documents_updated_at_id. With includeSourceIds it
    // should pick a source-id-prefixed index.
    const planForced = db
      .prepare<[string, number], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT id FROM documents INDEXED BY idx_documents_updated_at_id
         WHERE updated_at >= ? ORDER BY id ASC LIMIT ?`,
      )
      .all("2000-01-01T00:00:00Z", 21);
    const planFree = db
      .prepare<[string, string, number], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT id FROM documents
         WHERE updated_at >= ? AND source_id IN (?) ORDER BY id ASC LIMIT ?`,
      )
      .all("2000-01-01T00:00:00Z", "gmail:alice@example.com", 21);
    // Forced query references the watermark index by name.
    expect(planForced.map((r) => r.detail).join(" ")).toMatch(/idx_documents_updated_at_id/);
    // Free query (the new shape with includeSourceIds) is allowed to
    // pick a different index — assert the planner picked one of the
    // source-id indexes, not the watermark one.
    const detailFree = planFree.map((r) => r.detail).join(" ");
    expect(detailFree).toMatch(/source_id|idx_documents_source/);
  });

  test("listDocuments discovery pagination is index-satisfied — no temp B-tree sort", () => {
    // A broad exclusion scan lists docs with `excludeSourceIds` (never a
    // positive `source_id IN`) and no `updatedSince`, so the SQL is
    // `WHERE source_id NOT IN (?) [AND id > ?] ORDER BY id ASC LIMIT ?`. The
    // `ORDER BY id` is satisfied by the `id` PRIMARY KEY index, so the plan
    // must NOT fall back to a temp-B-tree sort at any page. Pin that here so a
    // future query-shape change that reintroduces the sort reddens the build.
    for (let i = 0; i < 50; i++) {
      upsertDocuments(db, [
        makeDoc({
          externalId: `d${i}`,
          sourceId: i % 5 === 0 ? "web" : "gmail:alice@example.com",
        }),
      ]);
    }
    const planPage1 = db
      .prepare<[string, number], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT id, source_id, title, content, content_hash, metadata,
                source_created_at, updated_at
         FROM documents WHERE source_id NOT IN (?) ORDER BY id ASC LIMIT ?`,
      )
      .all("web", 21);
    const planResume = db
      .prepare<[string, string, number], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT id, source_id, title, content, content_hash, metadata,
                source_created_at, updated_at
         FROM documents WHERE source_id NOT IN (?) AND id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all("web", "0", 21);
    const detailPage1 = planPage1.map((r) => r.detail).join(" ");
    const detailResume = planResume.map((r) => r.detail).join(" ");
    expect(detailPage1).not.toMatch(/TEMP B-TREE/i);
    expect(detailResume).not.toMatch(/TEMP B-TREE/i);
    // Positively assert the id primary-key index carries the ordering.
    expect(detailPage1).toMatch(/sqlite_autoindex_documents_1|USING INTEGER PRIMARY KEY/);
    expect(detailResume).toMatch(/sqlite_autoindex_documents_1|USING INTEGER PRIMARY KEY/);
  });
});

describe("checkExistingExternalIds", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
    upsertDocuments(db, [
      makeDoc({ externalId: "msg-1" }),
      makeDoc({ externalId: "msg-2" }),
      makeDoc({ externalId: "msg-3" }),
    ]);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("returns correct subset of existing IDs", () => {
    const result = checkExistingExternalIds(db, "google", "gmail", ["msg-1", "msg-3", "msg-999"]);
    expect(result.sort()).toEqual(["msg-1", "msg-3"]);
  });

  test("returns empty array for empty input", () => {
    const result = checkExistingExternalIds(db, "google", "gmail", []);
    expect(result).toEqual([]);
  });

  test("returns empty array when no IDs match", () => {
    const result = checkExistingExternalIds(db, "google", "gmail", [
      "nonexistent-1",
      "nonexistent-2",
    ]);
    expect(result).toEqual([]);
  });

  test("scopes to provider and source", () => {
    // Same external IDs but different source — should not match
    const result = checkExistingExternalIds(db, "google", "google-calendar", ["msg-1", "msg-2"]);
    expect(result).toEqual([]);
  });
});

describe("getSourceMeta", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("an account's identity is its own, and the family's is declared", () => {
    setSyncState(
      db,
      "example-browser:one",
      { phase: "done" },
      {
        icon: "ONE_ICON",
        label: "BrowserOne",
        family: { icon: "FAMILY_ICON", label: "Browsers" },
      },
    );
    setSyncState(
      db,
      "example-browser:two",
      { phase: "done" },
      {
        icon: "TWO_ICON",
        label: "BrowserTwo",
        family: { icon: "FAMILY_ICON", label: "Browsers" },
      },
    );

    const meta = getSourceMeta(db);

    expect(meta["example-browser:one"]).toEqual({ icon: "ONE_ICON", label: "BrowserOne" });
    expect(meta["example-browser:two"]).toEqual({ icon: "TWO_ICON", label: "BrowserTwo" });
    // Neither account's, which is the point: they differ, so either choice
    // would name the family after one of its members.
    expect(meta["example-browser"]).toEqual({ icon: "FAMILY_ICON", label: "Browsers" });
  });

  test("an undeclared family has no entry, rather than one account's", () => {
    // What a source that labels each connection by institution would leak if
    // the family were assembled from accounts: the first row a scan reaches,
    // published under a key every account of that type resolves through.
    setSyncState(
      db,
      "example-bank:one",
      { phase: "done" },
      { icon: "ONE_ICON", label: "one institution" },
    );
    setSyncState(
      db,
      "example-bank:two",
      { phase: "done" },
      { icon: "TWO_ICON", label: "another institution" },
    );

    const meta = getSourceMeta(db);

    expect(meta["example-bank:one"]).toEqual({ icon: "ONE_ICON", label: "one institution" });
    expect(meta["example-bank"]).toBeUndefined();
  });

  test("a legacy single-source family retains its icon until a sibling appears", () => {
    setSyncState(db, "example-phone:local", {}, { icon: "PHONE", label: "Phone samples" });
    expect(getSourceMeta(db)["example-phone"]).toEqual({ icon: "PHONE", label: "Phone samples" });
    // A sibling without metadata still makes account-derived family naming ambiguous.
    setSyncState(db, "example-phone:second", {});
    expect(getSourceMeta(db)["example-phone"]).toBeUndefined();
    setSourceMeta(db, "example-phone:local", { family: { icon: "FAMILY", label: "Samples" } });
    expect(getSourceMeta(db)["example-phone"]).toEqual({ icon: "FAMILY", label: "Samples" });
  });

  test("a source that names no account owns its own type key", () => {
    // Its id IS its type, so its row is the family — and it wins over any
    // declaration, because it is the same declaration read where it belongs.
    setSyncState(
      db,
      "example-notes",
      { phase: "done" },
      { icon: "OWN_ICON", label: "Own", family: { icon: "FAMILY_ICON", label: "Family" } },
    );

    expect(getSourceMeta(db)["example-notes"]).toEqual({ icon: "OWN_ICON", label: "Own" });
  });

  test("a family declaration survives one account being re-synced", () => {
    setSyncState(
      db,
      "example-browser:one",
      { phase: "done" },
      { icon: "ONE_ICON", label: "BrowserOne", family: { label: "Browsers" } },
    );
    deleteAllBySource(db, "example-browser:one");

    // A resync deletes the account's row; the family is not that account's to
    // take with it.
    expect(getSourceMeta(db)["example-browser"]).toEqual({ label: "Browsers" });
  });

  test("a declared field is not clobbered by a later push that omits it", () => {
    setSyncState(
      db,
      "example-browser:one",
      { phase: "done" },
      { family: { icon: "FAMILY_ICON", label: "Browsers" } },
    );
    setSyncState(db, "example-browser:one", { phase: "done" }, { family: { label: "Renamed" } });

    expect(getSourceMeta(db)["example-browser"]).toEqual({
      icon: "FAMILY_ICON",
      label: "Renamed",
    });
  });

  test("metadata-only refresh preserves the stored cursor", () => {
    setSyncState(db, "gmail:a@example.com", { historyId: "newest" });
    setSourceMeta(db, "gmail:a@example.com", {
      label: "Mail",
      contentRetention: "best-effort",
      urlPatterns: [{ regex: "message/(.+)", idGroup: 1 }],
    });

    expect(JSON.parse(getSyncState(db, "gmail:a@example.com")!.cursor)).toEqual({
      historyId: "newest",
    });
    expect(getSyncState(db, "gmail:a@example.com")).toMatchObject({
      label: "Mail",
      content_retention: "best-effort",
    });
  });

  test("skips rows with no icon and no label", () => {
    setSyncState(db, "gmail:a@example.com", { historyId: "1" });
    const meta = getSourceMeta(db);
    expect(meta["gmail:a@example.com"]).toBeUndefined();
    expect(meta["gmail"]).toBeUndefined();
  });

  test("a family with nothing to declare writes no row", () => {
    setSyncState(db, "gmail:a@example.com", { historyId: "1" }, { family: {} });
    expect(getSourceMeta(db)["gmail"]).toBeUndefined();
  });
});

describe("source_stats — compute / upsert split", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("computeSourceStatsRow returns zeros for an empty source", () => {
    const agg = computeSourceStatsRow(db, "gmail:nobody@example.com");
    expect(agg).toEqual({
      count: 0,
      earliest: null,
      latest: null,
      dataSize: 0,
      totalUnits: null,
      capturedVersion: 0,
    });
  });

  test("computeSourceStatsRow captures dirty_version, upsertSourceStatsRow skips the row data and dirty-bit clear when version moved", () => {
    upsertDocuments(db, [makeDoc({ externalId: "a", content: "hello" })]);
    // Capture compute snapshot now (dirty_version at this moment).
    const agg1 = computeSourceStatsRow(db, "gmail");
    const versionAtCompute = agg1.capturedVersion;

    // Simulate a concurrent ingest landing during the compute → bumps
    // dirty_version, sets needs_refresh=1.
    upsertDocuments(db, [makeDoc({ externalId: "b", content: "world!" })]);

    // Now run the upsert with the (now-stale) compute snapshot.
    upsertSourceStatsRow(db, "gmail", agg1);

    // The upsert should have detected the version mismatch and:
    //   1. left needs_refresh = 1 (so backfill picks the source up
    //      again), and
    //   2. NOT applied the stale aggregation values over the fresher
    //      ones that upsertDocuments's inline refresh wrote.
    const row = db
      .prepare<
        [string],
        { needs_refresh: number; dirty_version: number; doc_count: number }
      >("SELECT needs_refresh, dirty_version, doc_count FROM source_stats WHERE source_id = ?")
      .get("gmail")!;
    expect(row.needs_refresh).toBe(1);
    expect(row.dirty_version).toBeGreaterThan(versionAtCompute);
    // doc_count reflects the post-second-ingest count (2), not the
    // stale 1 that agg1 carried.
    expect(row.doc_count).toBe(2);

    // Re-run compute + upsert against the now-current state — should
    // succeed cleanly.
    const agg2 = computeSourceStatsRow(db, "gmail");
    upsertSourceStatsRow(db, "gmail", agg2);
    const row2 = db
      .prepare<
        [string],
        { needs_refresh: number; doc_count: number }
      >("SELECT needs_refresh, doc_count FROM source_stats WHERE source_id = ?")
      .get("gmail")!;
    expect(row2.needs_refresh).toBe(0);
    expect(row2.doc_count).toBe(2);
  });

  test("computeSourceStatsRow aggregates count, dataSize, and date range", () => {
    upsertDocuments(db, [
      makeDoc({
        externalId: "a",
        sourceCreatedAt: "2024-01-15T10:00:00Z",
        title: "T1",
        content: "abc",
      }),
      makeDoc({
        externalId: "b",
        sourceCreatedAt: "2024-03-01T10:00:00Z",
        title: "TT",
        content: "defgh",
      }),
      makeDoc({
        externalId: "c",
        sourceCreatedAt: "2024-02-01T10:00:00Z",
        title: "TTT",
        content: "ij",
      }),
    ]);

    const agg = computeSourceStatsRow(db, "gmail");
    expect(agg.count).toBe(3);
    expect(agg.earliest).toBe("2024-01-15T10:00:00Z");
    expect(agg.latest).toBe("2024-03-01T10:00:00Z");
    // dataSize = SUM(LENGTH(content) + LENGTH(title) + LENGTH(metadata))
    // Don't pin the exact value (metadata serialization size depends on
    // people/tags handling), but it must be > sum of just content+title.
    expect(agg.dataSize).toBeGreaterThan(
      ("abc" + "defgh" + "ij").length + ("T1" + "TT" + "TTT").length,
    );
    expect(agg.totalUnits).toBeNull();
  });

  test("computeSourceStatsRow sums totalUnits when extra.unitCount / messageCount present", () => {
    upsertDocuments(db, [
      makeDoc({
        externalId: "u1",
        metadata: { extra: { unitCount: 4 } } as DocumentInput["metadata"],
      }),
      makeDoc({
        externalId: "u2",
        metadata: { extra: { messageCount: 7 } } as DocumentInput["metadata"],
      }),
      makeDoc({ externalId: "u3" }), // no unit
    ]);

    const agg = computeSourceStatsRow(db, "gmail");
    expect(agg.count).toBe(3);
    // unitCount preferred, falls back to messageCount; rows with neither
    // contribute null and don't poison the SUM.
    expect(agg.totalUnits).toBe(11);
  });

  test("computeSourceStatsRow correctly aggregates over a large corpus", () => {
    // Sanity check the read-only aggregation against a non-trivial
    // corpus — exercises the planner with enough rows that we'd notice
    // any plan regression that quietly dropped rows.
    const docs: DocumentInput[] = [];
    for (let i = 0; i < 1234; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      docs.push(
        makeDoc({
          externalId: `e${String(i).padStart(5, "0")}`,
          title: `Title ${i}`,
          content: "x".repeat(50),
          sourceCreatedAt: `2024-01-${day}T10:00:00Z`,
          metadata: { extra: { unitCount: 1 } } as DocumentInput["metadata"],
        }),
      );
    }
    upsertDocuments(db, docs);

    const agg = computeSourceStatsRow(db, "gmail");
    expect(agg.count).toBe(1234);
    expect(agg.totalUnits).toBe(1234);
    expect(agg.earliest).toBe("2024-01-01T10:00:00Z");
    expect(agg.latest).toBe("2024-01-28T10:00:00Z");
    // Each doc contributes >= 50 (content) + ≥7 (title "Title N") + some
    // metadata bytes — lower bound on dataSize without pinning the exact
    // metadata encoding.
    expect(agg.dataSize).toBeGreaterThan(1234 * 50);
  });

  test("upsertSourceStatsRow writes the aggregation and clears needs_refresh", () => {
    upsertDocuments(db, [makeDoc({ externalId: "x" })]);
    // Mark dirty so we can prove the upsert clears it.
    db.prepare("UPDATE source_stats SET needs_refresh = 1 WHERE source_id = ?").run("gmail");

    const agg = computeSourceStatsRow(db, "gmail");
    upsertSourceStatsRow(db, "gmail", agg);

    const row = db
      .prepare<
        [string],
        {
          doc_count: number;
          data_size_bytes: number;
          total_units: number | null;
          earliest_source_date: string | null;
          latest_source_date: string | null;
          needs_refresh: number;
        }
      >(
        "SELECT doc_count, data_size_bytes, total_units, earliest_source_date, latest_source_date, needs_refresh FROM source_stats WHERE source_id = ?",
      )
      .get("gmail")!;
    expect(row.doc_count).toBe(agg.count);
    expect(row.data_size_bytes).toBe(agg.dataSize);
    expect(row.total_units).toBe(agg.totalUnits);
    expect(row.earliest_source_date).toBe(agg.earliest);
    expect(row.latest_source_date).toBe(agg.latest);
    expect(row.needs_refresh).toBe(0);
  });

  test("refreshSourceStatsRow combines compute + upsert (regression: same result as direct call)", () => {
    upsertDocuments(db, [
      makeDoc({ externalId: "a", title: "T", content: "hello" }),
      makeDoc({ externalId: "b", title: "TT", content: "world" }),
    ]);

    refreshSourceStatsRow(db, "gmail");

    const row = db
      .prepare<
        [string],
        { doc_count: number; needs_refresh: number }
      >("SELECT doc_count, needs_refresh FROM source_stats WHERE source_id = ?")
      .get("gmail")!;
    expect(row.doc_count).toBe(2);
    expect(row.needs_refresh).toBe(0);
  });
});

describe("getLatestActivityBySource", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("returns most recent doc per source by updated_at", () => {
    upsertDocuments(db, [
      makeDoc({
        sourceId: "gmail",
        externalId: "old",
        title: "Old email",
        contentHash: "h-old",
        sourceCreatedAt: "2024-01-01T10:00:00Z",
        sourceUpdatedAt: "2024-01-01T10:00:00Z",
      }),
      makeDoc({
        sourceId: "gmail",
        externalId: "new",
        title: "Newest email",
        contentHash: "h-new",
        sourceCreatedAt: "2024-06-01T10:00:00Z",
        sourceUpdatedAt: "2024-06-01T10:00:00Z",
      }),
      makeDoc({
        sourceId: "calendar",
        externalId: "evt-1",
        title: "Event",
        contentHash: "h-evt",
        sourceCreatedAt: "2024-03-01T10:00:00Z",
        sourceUpdatedAt: "2024-03-01T10:00:00Z",
      }),
    ]);
    refreshSourceStatsRow(db, "gmail");
    refreshSourceStatsRow(db, "calendar");

    const result = getLatestActivityBySource(db);
    expect(result.gmail?.title).toBe("Newest email");
    expect(result.gmail?.isNew).toBe(true);
    expect(result.calendar?.title).toBe("Event");
  });

  test("isNew flips to false after content rewrite (re-upsert with new hash)", async () => {
    upsertDocuments(db, [
      makeDoc({
        sourceId: "gmail",
        externalId: "msg-1",
        title: "First version",
        contentHash: "h-1",
      }),
    ]);
    // Force a measurable gap between ingested_at and the next updated_at
    // so the ISO strings differ. better-sqlite3 uses millisecond precision.
    await new Promise((r) => setTimeout(r, 5));
    upsertDocuments(db, [
      makeDoc({
        sourceId: "gmail",
        externalId: "msg-1",
        title: "Rewritten",
        content: "different body",
        contentHash: "h-2",
      }),
    ]);
    refreshSourceStatsRow(db, "gmail");

    const result = getLatestActivityBySource(db);
    expect(result.gmail?.title).toBe("Rewritten");
    expect(result.gmail?.isNew).toBe(false);
    expect(result.gmail?.ingestedAt).not.toBe(result.gmail?.latestActivityAt);
  });

  test("omits sources with zero documents", () => {
    upsertDocuments(db, [makeDoc({ sourceId: "gmail", externalId: "a" })]);
    refreshSourceStatsRow(db, "gmail");

    const result = getLatestActivityBySource(db);
    expect(result.gmail).toBeDefined();
    expect(result["empty-source"]).toBeUndefined();
  });

  test("falls back to surviving doc after the latest doc is deleted", () => {
    upsertDocuments(db, [
      makeDoc({
        sourceId: "gmail",
        externalId: "old",
        title: "Old email",
        contentHash: "h-old",
        sourceCreatedAt: "2024-01-01T10:00:00Z",
        sourceUpdatedAt: "2024-01-01T10:00:00Z",
      }),
      makeDoc({
        sourceId: "gmail",
        externalId: "new",
        title: "Newest email",
        contentHash: "h-new",
        sourceCreatedAt: "2024-06-01T10:00:00Z",
        sourceUpdatedAt: "2024-06-01T10:00:00Z",
      }),
    ]);
    refreshSourceStatsRow(db, "gmail");

    const deletedId = db
      .prepare<[], { id: string }>("SELECT id FROM documents WHERE external_id = 'new'")
      .get()!.id;
    expect(getLatestActivityBySource(db).gmail?.docId).toBe(deletedId);

    // Delete the freshest doc. The heavy stats refresh does NOT recompute
    // latest_*, so without a delete-path recompute the row would keep
    // pointing at the deleted doc.
    deleteDocuments(db, "google", "gmail", ["new"]);
    refreshSourceStatsRow(db, "gmail");

    const after = getLatestActivityBySource(db).gmail;
    expect(after?.title).toBe("Old email");
    expect(after?.docId).not.toBe(deletedId);
  });

  test("clears latest activity when the source's last doc is deleted", () => {
    upsertDocuments(db, [makeDoc({ sourceId: "gmail", externalId: "only", title: "Only email" })]);
    refreshSourceStatsRow(db, "gmail");
    expect(getLatestActivityBySource(db).gmail).toBeDefined();

    deleteDocuments(db, "google", "gmail", ["only"]);
    refreshSourceStatsRow(db, "gmail");

    // No surviving docs → latest_* cleared → source dropped by the
    // `latest_doc_id IS NOT NULL` filter.
    expect(getLatestActivityBySource(db).gmail).toBeUndefined();
  });

  test("does not surface a doc removed by the page's tombstones", () => {
    // Mirrors the single-page upsertWithCursor sequence: upsertDocuments
    // records the latest doc, then the page's tombstones delete that very doc
    // within one transaction. latest_* must reflect the survivors.
    upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [
        makeDoc({
          sourceId: "gmail",
          externalId: "keep",
          title: "Kept email",
          contentHash: "h-keep",
          sourceCreatedAt: "2024-01-01T10:00:00Z",
          sourceUpdatedAt: "2024-01-01T10:00:00Z",
        }),
        makeDoc({
          sourceId: "gmail",
          externalId: "drop",
          title: "Dropped email",
          contentHash: "h-drop",
          sourceCreatedAt: "2024-06-01T10:00:00Z",
          sourceUpdatedAt: "2024-06-01T10:00:00Z",
        }),
      ],
      // The source asserts the deletion, so it applies in the same txn.
      deletedExternalIds: ["drop"],
      hasMore: false,
      cursor: { value: "c1" },
    });

    const activity = getLatestActivityBySource(db).gmail;
    expect(activity?.title).toBe("Kept email");
    const droppedExists = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM documents WHERE external_id = 'drop'")
      .get()!.c;
    expect(droppedExists).toBe(0);
    expect(activity?.docId).toBe(
      db.prepare<[], { id: string }>("SELECT id FROM documents WHERE external_id = 'keep'").get()!
        .id,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// upsertWithCursor — atomic per-page sync write
// ───────────────────────────────────────────────────────────────────────

describe("upsertWithCursor", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("commits documents + cursor atomically", () => {
    const doc = makeDoc();
    upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [doc],
      hasMore: false,
      cursor: { historyId: 42 },
    });

    const existing = checkExistingExternalIds(db, "google", "gmail", [doc.externalId]);
    expect(existing).toEqual([doc.externalId]);

    const state = getSyncState(db, "gmail");
    expect(state).not.toBeNull();
    expect(JSON.parse(state!.cursor)).toEqual({ historyId: 42 });
  });

  test("documents + deletions + cursor all land in one transaction", () => {
    upsertDocuments(db, [makeDoc({ externalId: "keep-1" }), makeDoc({ externalId: "delete-1" })]);

    upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [makeDoc({ externalId: "new-1", contentHash: "h-new-1" })],
      deletedExternalIds: ["delete-1"],
      hasMore: false,
      cursor: { historyId: 43 },
    });

    const present = checkExistingExternalIds(db, "google", "gmail", [
      "keep-1",
      "new-1",
      "delete-1",
    ]);
    expect(present.sort()).toEqual(["keep-1", "new-1"]);

    const state = getSyncState(db, "gmail");
    expect(JSON.parse(state!.cursor)).toEqual({ historyId: 43 });
  });

  test("snapshot reconcile runs only on final page (hasMore=false)", () => {
    upsertDocuments(db, [
      makeDoc({ externalId: "alpha" }),
      makeDoc({ externalId: "beta" }),
      makeDoc({ externalId: "gamma" }),
    ]);

    // Partial-page snapshot — the gateway-side guard refuses it outright: a
    // partial page names a fraction of what exists, so nothing is even marked.
    const partial = upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      presentExternalIds: ["alpha"],
      absencePolicy: ABSENCE_POLICY,
      hasMore: true,
      cursor: { historyId: 50 },
    });
    expect(partial.absence).toBeUndefined();
    expect(countPendingAbsences(db)).toBe(0);

    // Final-page snapshot — beta and gamma are marked, and still stored.
    const absencePlan = computeSnapshotAbsencePlan(
      db,
      "google",
      "gmail",
      ["alpha"],
      ABSENCE_POLICY,
    );
    const final = upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      absencePlan,
      hasMore: false,
      cursor: { historyId: 51 },
    });
    expect(final.absence).toMatchObject({ marked: 2, absent: 2, stored: 3, snapshot: 1 });
    expect(
      checkExistingExternalIds(db, "google", "gmail", ["alpha", "beta", "gamma"]).sort(),
    ).toEqual(["alpha", "beta", "gamma"]);
  });

  test("at-least-once: re-running the same page is idempotent (PK dedupe)", () => {
    const doc = makeDoc({ contentHash: "stable-hash" });

    // First page write succeeds end-to-end.
    upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [doc],
      hasMore: false,
      cursor: { historyId: 100 },
    });

    // Cursor lagged on the client (simulating a partial failure in the
    // non-atomic world). The same page replays. The
    // (provider_id, source_id, external_id) UNIQUE absorbs the dupe
    // and the cursor re-advances.
    upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [doc],
      hasMore: false,
      cursor: { historyId: 100 },
    });

    // Still exactly one row for this (provider, source, externalId).
    const present = checkExistingExternalIds(db, "google", "gmail", [doc.externalId]);
    expect(present).toEqual([doc.externalId]);
    const row = db
      .prepare<
        [string, string, string],
        { count: number }
      >("SELECT COUNT(*) AS count FROM documents WHERE provider_id = ? AND source_id = ? AND external_id = ?")
      .get("google", "gmail", doc.externalId);
    expect(row?.count).toBe(1);
  });

  test("transaction rollback: a mid-transaction throw leaves docs + cursor untouched", () => {
    // Seed a known-good cursor so we can assert it survives the throw.
    setSyncState(db, "gmail", { historyId: 1 });

    // A `BigInt` in the cursor object makes the inner `setSyncState`
    // throw at `JSON.stringify` time — but only AFTER `upsertDocuments`
    // has already run inside the same outer transaction. If the
    // composite txn isn't atomic, the doc would survive while the
    // cursor wouldn't advance — proving the rollback works when
    // exercised through `upsertWithCursor` itself.
    expect(() => {
      upsertWithCursor(db, {
        providerId: "google",
        sourceId: "gmail",
        documents: [makeDoc({ externalId: "would-commit" })],
        hasMore: false,
        // `BigInt` is not JSON-serialisable; serialize() will throw
        // `TypeError: Do not know how to serialize a BigInt` when the
        // final `setSyncState` step runs.
        cursor: { historyId: 1n as unknown as number },
      });
    }).toThrow(/BigInt/);

    // The throw aborts the outer transaction (SAVEPOINT rollback); the
    // original cursor (historyId: 1) and zero-doc state both survive.
    const state = getSyncState(db, "gmail");
    expect(JSON.parse(state!.cursor)).toEqual({ historyId: 1 });
    expect(checkExistingExternalIds(db, "google", "gmail", ["would-commit"])).toEqual([]);
  });

  test("empty body still advances the cursor (push-based sources rely on this)", () => {
    upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      // No documents, no deletions, no snapshot — just a cursor write.
      hasMore: false,
      cursor: { historyId: 7 },
    });

    const state = getSyncState(db, "gmail");
    expect(JSON.parse(state!.cursor)).toEqual({ historyId: 7 });
  });
});

describe("upsertWithCursor — wipe-epoch guard", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("getWipeEpoch starts at 0; bumpWipeEpoch increments it", () => {
    expect(getWipeEpoch(db, "gmail")).toBe(0);
    bumpWipeEpoch(db, "gmail");
    bumpWipeEpoch(db, "gmail");
    expect(getWipeEpoch(db, "gmail")).toBe(2);
    // Per-source — a different source is unaffected.
    expect(getWipeEpoch(db, "apple-notes")).toBe(0);
  });

  test("timeout revocation is compare-and-swap against the claimed epoch", () => {
    const first = beginSyncAttempt(db, "gmail");
    const newer = beginSyncAttempt(db, "gmail");

    expect(revokeSyncAttempt(db, "gmail", first)).toBe(false);
    expect(getWipeEpoch(db, "gmail")).toBe(newer);
    expect(revokeSyncAttempt(db, "gmail", newer)).toBe(true);
    expect(getWipeEpoch(db, "gmail")).toBe(newer + 1);
  });

  test("deleteAllBySource bumps the wipe epoch", () => {
    expect(getWipeEpoch(db, "gmail")).toBe(0);
    deleteAllBySource(db, "gmail");
    expect(getWipeEpoch(db, "gmail")).toBe(1);
  });

  test("each cursor row holds its own claim: a member's attempt never revokes a sibling's", () => {
    const shared = beginSyncAttempt(db, "notes");
    const phoneA = beginSyncAttempt(db, "notes", "device-a");
    const phoneB = beginSyncAttempt(db, "notes", "device-b");
    expect([shared, phoneA, phoneB]).toEqual([1, 1, 1]);

    // A new attempt on one row leaves the others' authority intact.
    expect(beginSyncAttempt(db, "notes", "device-a")).toBe(2);
    expect(getWipeEpoch(db, "notes")).toBe(shared);
    expect(getWipeEpoch(db, "notes", "device-b")).toBe(phoneB);

    // Revocation is compare-and-swap per row.
    expect(revokeSyncAttempt(db, "notes", phoneB, "device-a")).toBe(false);
    expect(revokeSyncAttempt(db, "notes", phoneB, "device-b")).toBe(true);
    expect(getWipeEpoch(db, "notes", "device-b")).toBe(phoneB + 1);
    expect(getWipeEpoch(db, "notes", "device-a")).toBe(2);
  });

  test("a wipe advances every row of the source, and only that source", () => {
    beginSyncAttempt(db, "notes", "device-a");
    beginSyncAttempt(db, "notes", "device-b");
    beginSyncAttempt(db, "gmail", "device-a");
    bumpWipeEpoch(db, "notes");
    expect(getWipeEpoch(db, "notes")).toBe(1);
    expect(getWipeEpoch(db, "notes", "device-a")).toBe(2);
    expect(getWipeEpoch(db, "notes", "device-b")).toBe(2);
    expect(getWipeEpoch(db, "gmail", "device-a")).toBe(1);
  });

  test("two devices' streams carry the same external id side by side; each snapshot and delete stays in its stream", () => {
    const page = (streamId: string, externalIds: string[], presentExternalIds?: string[]) => {
      const absencePlan =
        presentExternalIds === undefined
          ? undefined
          : computeSnapshotAbsencePlan(db, "google", "gmail", presentExternalIds, ABSENCE_POLICY, {
              streamId,
              arrivingExternalIds: externalIds,
            });
      return upsertWithCursor(db, {
        providerId: "google",
        sourceId: "gmail",
        documents: externalIds.map((externalId) =>
          makeDoc({ externalId, contentHash: `${streamId}-${externalId}` }),
        ),
        absencePlan,
        hasMore: false,
        cursor: { page: 1 },
        cursorDeviceId: streamId,
        streamId,
      });
    };
    page("device-a", ["day-1", "day-2"]);
    page("device-b", ["day-1", "day-3"]);
    expect(getDocumentCount(db, "gmail")).toBe(4);
    expect(checkExistingExternalIds(db, "google", "gmail", ["day-1", "day-3"], "device-a")).toEqual(
      ["day-1"],
    );

    // A's snapshot no longer lists day-2: only A's day-2 is marked absent, and
    // the mark names A's stream — B's day-1 was never in the diff at all.
    const reconciled = page("device-a", ["day-1"], ["day-1"]);
    expect(reconciled.absence).toMatchObject({ marked: 1, absent: 1, stored: 2 });
    expect(
      db
        .prepare<
          [],
          { stream_id: string; external_id: string }
        >("SELECT stream_id, external_id FROM document_absences")
        .all(),
    ).toEqual([{ stream_id: "device-a", external_id: "day-2" }]);
    expect(getDocumentCount(db, "gmail")).toBe(4);

    // A tombstone for A's day-1 is A's alone: A's re-push is suppressed, B's
    // re-push (with new content) lands.
    deleteDocuments(db, "google", "gmail", ["day-1"], undefined, "device-a", "device-a");
    tombstoneDocuments(db, "google", "gmail", ["day-1"], undefined, "device-a");
    expect(getDocumentCount(db, "gmail")).toBe(3);
    page("device-a", ["day-1"]);
    const contentHashOf = (streamId: string) =>
      db
        .prepare<
          [string],
          { content_hash: string }
        >("SELECT content_hash FROM documents WHERE source_id = 'gmail' AND external_id = 'day-1' AND stream_id = ?")
        .get(streamId)?.content_hash;
    expect(contentHashOf("device-a")).toBeUndefined();
    expect(getDocumentCount(db, "gmail")).toBe(3);
    upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [makeDoc({ externalId: "day-1", contentHash: "device-b-day-1-v2" })],
      hasMore: false,
      cursor: { page: 2 },
      cursorDeviceId: "device-b",
      streamId: "device-b",
    });
    expect(contentHashOf("device-b")).toBe("device-b-day-1-v2");
    expect(getDocumentCount(db, "gmail")).toBe(3);
  });

  test("a user delete removes one stream's document and its attachments, and tombstones that stream only", () => {
    const seed = (streamId: string) =>
      upsertWithCursor(db, {
        providerId: "google",
        sourceId: "gmail",
        documents: [
          makeDoc({ externalId: "day-1", contentHash: `${streamId}-day-1` }),
          makeDoc({ externalId: "day-1/att/1", contentHash: `${streamId}-att` }),
        ],
        hasMore: false,
        cursor: { page: 1 },
        cursorDeviceId: streamId,
        streamId,
      });
    seed("device-a");
    seed("device-b");
    expect(getDocumentCount(db, "gmail")).toBe(4);

    const deleted = deleteDocumentForUser(db, "google", "gmail", "day-1", "device-a");
    expect(deleted).toHaveLength(2);
    expect(getDocumentCount(db, "gmail")).toBe(2);
    expect(
      checkExistingExternalIds(db, "google", "gmail", ["day-1", "day-1/att/1"], "device-b"),
    ).toEqual(["day-1", "day-1/att/1"]);
    // Only device A's re-push is suppressed by the tombstone.
    seed("device-a");
    expect(getDocumentCount(db, "gmail")).toBe(2);
  });

  test("a chunked member page stores every chunk under the claim on its own row", () => {
    const memberEpoch = beginSyncAttempt(db, "gmail", "device-a");
    const docs = Array.from({ length: 120 }, (_, i) =>
      makeDoc({ externalId: `m-${i}`, contentHash: `mh-${i}` }),
    );
    const out = upsertWithCursorYieldable(
      db,
      {
        providerId: "google",
        sourceId: "gmail",
        documents: docs,
        hasMore: false,
        cursor: { historyId: 5 },
        wipeEpoch: memberEpoch,
        cursorDeviceId: "device-a",
      },
      { token: { requested: () => false }, chunkSize: 50 },
    );
    expect(out.kind).toBe("done");
    expect(out.kind === "done" && out.value.rejected).toBeFalsy();
    expect(getDocumentCount(db, "gmail")).toBe(120);
    expect(JSON.parse(getSyncState(db, "gmail", "device-a")!.cursor)).toEqual({ historyId: 5 });

    // A chunked page whose claim is stale is refused as a whole: no chunk
    // lands and the cursor stays.
    const stale = upsertWithCursorYieldable(
      db,
      {
        providerId: "google",
        sourceId: "gmail",
        documents: docs.map((d) => ({ ...d, externalId: `s-${d.externalId}` })),
        hasMore: false,
        cursor: { historyId: 6 },
        wipeEpoch: memberEpoch,
      },
      { token: { requested: () => false }, chunkSize: 50 },
    );
    expect(stale.kind === "done" && stale.value.rejected).toBe(true);
    expect(getDocumentCount(db, "gmail")).toBe(120);
    expect(getSyncState(db, "gmail")).toBeNull();
  });

  test("a member's page lands its documents, tombstones and cursor under the claim on its own row", () => {
    const memberEpoch = beginSyncAttempt(db, "gmail", "device-a");
    expect(memberEpoch).toBe(1);
    expect(getWipeEpoch(db, "gmail")).toBe(0);

    const first = upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [makeDoc({ externalId: "keep" }), makeDoc({ externalId: "gone" })],
      hasMore: false,
      cursor: { historyId: 1 },
      wipeEpoch: memberEpoch,
      cursorDeviceId: "device-a",
    });
    expect(first.rejected).toBeFalsy();
    expect(getDocumentCount(db, "gmail")).toBe(2);

    const second = upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [],
      deletedExternalIds: ["gone"],
      hasMore: false,
      cursor: { historyId: 2 },
      wipeEpoch: memberEpoch,
      cursorDeviceId: "device-a",
    });
    expect(second.rejected).toBeFalsy();
    expect(second.tombstoneDeletedDocumentIds).toHaveLength(1);
    expect(getDocumentCount(db, "gmail")).toBe(1);
    expect(JSON.parse(getSyncState(db, "gmail", "device-a")!.cursor)).toEqual({ historyId: 2 });
    expect(getSyncState(db, "gmail")).toBeNull();

    // The same page against the shared row is stale: that row was never claimed.
    const stale = upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [makeDoc({ externalId: "late" })],
      hasMore: false,
      cursor: { historyId: 3 },
      wipeEpoch: memberEpoch,
    });
    expect(stale.rejected).toBe(true);
    expect(getDocumentCount(db, "gmail")).toBe(1);
  });

  test("a write whose wipeEpoch is current is applied", () => {
    const doc = makeDoc();
    const r = upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [doc],
      hasMore: false,
      cursor: { historyId: 1 },
      wipeEpoch: 0,
    });
    expect(r.rejected).toBeFalsy();
    expect(JSON.parse(getSyncState(db, "gmail")!.cursor)).toEqual({ historyId: 1 });
  });

  test("a stale wipeEpoch (source wiped mid-sync) rejects the write — no docs, no cursor", () => {
    // The collector started its sync at epoch 0.
    const startEpoch = getWipeEpoch(db, "gmail");
    // A resync wipes the source mid-sync (delete-all bumps the epoch).
    deleteAllBySource(db, "gmail");
    expect(getWipeEpoch(db, "gmail")).toBe(1);
    // The in-flight sync now tries to write back with its stale epoch.
    const doc = makeDoc();
    const r = upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [doc],
      hasMore: false,
      cursor: { historyId: 99 },
      wipeEpoch: startEpoch,
    });
    expect(r.rejected).toBe(true);
    // The document was NOT re-added and the cursor was NOT resurrected, so the
    // next sync reads an empty cursor and re-bootstraps cleanly.
    expect(checkExistingExternalIds(db, "google", "gmail", [doc.externalId])).toEqual([]);
    expect(getSyncState(db, "gmail")).toBeNull();
  });

  test("an unclaimed future epoch is rejected", () => {
    const doc = makeDoc();
    const result = upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [doc],
      hasMore: false,
      cursor: { historyId: 2 },
      wipeEpoch: 1,
    });

    expect(result.rejected).toBe(true);
    expect(checkExistingExternalIds(db, "google", "gmail", [doc.externalId])).toEqual([]);
    expect(getSyncState(db, "gmail")).toBeNull();
  });

  test("an omitted wipeEpoch is accepted only before any modern attempt claims the source", () => {
    const legacyDoc = makeDoc();
    const legacy = upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [legacyDoc],
      hasMore: false,
      cursor: { historyId: 1 },
    });
    expect(legacy.rejected).toBeFalsy();

    beginSyncAttempt(db, "gmail");
    const stale = upsertWithCursor(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [{ ...legacyDoc, externalId: "stale-legacy" }],
      hasMore: false,
      cursor: { historyId: 7 },
    });
    expect(stale.rejected).toBe(true);
    expect(JSON.parse(getSyncState(db, "gmail")!.cursor)).toEqual({ historyId: 1 });
  });
});

// ───────────────────────────────────────────────────────────────────────
// upsertWithCursorYieldable — chunked-with-yield variant of the above
// ───────────────────────────────────────────────────────────────────────

describe("upsertWithCursorYieldable", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("small batch (≤chunkSize) takes the legacy single-transaction fast path", () => {
    // No token but small docs[] — even without a token, this must
    // delegate to the atomic legacy path. Tests that the function is a
    // drop-in replacement for upsertWithCursor on the small-batch
    // path (no per-doc commits, no semantic divergence).
    const doc = makeDoc();
    const out = upsertWithCursorYieldable(db, {
      providerId: "google",
      sourceId: "gmail",
      documents: [doc],
      hasMore: false,
      cursor: { historyId: 1 },
    });
    expect(out.kind).toBe("done");
    if (out.kind !== "done") throw new Error("typeguard");
    expect(out.value.absence).toBeUndefined();
    expect(checkExistingExternalIds(db, "google", "gmail", [doc.externalId])).toEqual([
      doc.externalId,
    ]);
    expect(JSON.parse(getSyncState(db, "gmail")!.cursor)).toEqual({ historyId: 1 });
  });

  test("token never requests yield: large batch lands fully with cursor advanced", () => {
    // 5 chunks worth of docs, token returns false every time. Should
    // process all docs across multiple sub-transactions and finish
    // with cursor advanced and all docs visible. This is the
    // happy-path equivalent of one big batched ingest under quiet
    // writer queue.
    const docs = Array.from({ length: 220 }, (_, i) =>
      makeDoc({ externalId: `e-${i}`, contentHash: `h-${i}` }),
    );
    const token = { requested: () => false };
    const out = upsertWithCursorYieldable(
      db,
      {
        providerId: "google",
        sourceId: "gmail",
        documents: docs,
        hasMore: false,
        cursor: { historyId: 999 },
      },
      { token, chunkSize: 50 },
    );
    expect(out.kind).toBe("done");
    const present = checkExistingExternalIds(
      db,
      "google",
      "gmail",
      docs.map((d) => d.externalId),
    );
    expect(present.length).toBe(220);
    expect(JSON.parse(getSyncState(db, "gmail")!.cursor)).toEqual({ historyId: 999 });
  });

  test("claimed source rejects an omitted epoch before any large-page chunk commits", () => {
    beginSyncAttempt(db, "gmail");
    const docs = Array.from({ length: 51 }, (_, index) =>
      makeDoc({ externalId: `stale-${index}`, contentHash: `stale-hash-${index}` }),
    );

    const out = upsertWithCursorYieldable(
      db,
      {
        providerId: "google",
        sourceId: "gmail",
        documents: docs,
        hasMore: false,
        cursor: { historyId: 2 },
      },
      { token: { requested: () => false }, chunkSize: 50 },
    );

    expect(out).toMatchObject({ kind: "done", value: { rejected: true } });
    expect(
      checkExistingExternalIds(
        db,
        "google",
        "gmail",
        docs.map((document) => document.externalId),
      ),
    ).toEqual([]);
    expect(getSyncState(db, "gmail")).toBeNull();
  });

  test("yield mid-stream: cursor NOT advanced, processed docs ARE committed", () => {
    // 5 chunks. Token requests yield after the very first chunk —
    // simulating "high-priority writer op arrived while we were
    // mid-batch". Expectations:
    //   - Outcome is `{ kind: "yield", resume: ... }`.
    //   - Cursor NOT advanced (no syncState row OR the row's cursor
    //     reflects whatever was there before this call).
    //   - The first 50 docs are already in the DB (chunk upsert
    //     committed in its own sub-transaction).
    //   - Resume args carry the remaining 170 docs + sidecar fields.
    const docs = Array.from({ length: 220 }, (_, i) =>
      makeDoc({ externalId: `y-${i}`, contentHash: `hy-${i}` }),
    );
    let polls = 0;
    const token = {
      requested(): boolean {
        polls += 1;
        return polls >= 1;
      },
    };
    const out = upsertWithCursorYieldable(
      db,
      {
        providerId: "google",
        sourceId: "gmail",
        documents: docs,
        hasMore: false,
        cursor: { historyId: 777 },
      },
      { token, chunkSize: 50 },
    );
    expect(out.kind).toBe("yield");
    if (out.kind !== "yield") throw new Error("typeguard");

    // First chunk committed.
    const present50 = checkExistingExternalIds(
      db,
      "google",
      "gmail",
      docs.slice(0, 50).map((d) => d.externalId),
    );
    expect(present50.length).toBe(50);
    // Some later chunk NOT committed.
    const presentLast = checkExistingExternalIds(
      db,
      "google",
      "gmail",
      docs.slice(200).map((d) => d.externalId),
    );
    expect(presentLast.length).toBe(0);

    // Cursor not advanced — the syncState row should be absent (no
    // prior cursor in this test's fresh DB).
    const state = getSyncState(db, "gmail");
    expect(state).toBeNull();

    // Resume args carry forward all non-doc fields exactly, with a
    // smaller documents[] slice.
    expect(out.resume.providerId).toBe("google");
    expect(out.resume.sourceId).toBe("gmail");
    expect(out.resume.hasMore).toBe(false);
    expect(out.resume.cursor).toEqual({ historyId: 777 });
    expect(out.resume.documents?.length).toBe(170);
    expect(out.resume.documents?.[0].externalId).toBe("y-50");
  });

  test("resume-after-yield finishes the work and advances cursor exactly once", () => {
    // Drive the yield case to completion: keep re-entering with
    // resume args until we get a `done` outcome. The end state must
    // be identical to running upsertWithCursor in one shot.
    const docs = Array.from({ length: 220 }, (_, i) =>
      makeDoc({ externalId: `r-${i}`, contentHash: `hr-${i}` }),
    );
    let nextArgs = {
      providerId: "google",
      sourceId: "gmail",
      documents: docs,
      hasMore: false,
      cursor: { historyId: 12345 },
    } as Parameters<typeof upsertWithCursorYieldable>[1];
    // Token flips between yield and no-yield to exercise multiple
    // yield/resume cycles.
    let polls = 0;
    const token = {
      requested(): boolean {
        polls += 1;
        return polls % 2 === 1; // yield, run, yield, run, ...
      },
    };

    let iterations = 0;
    while (iterations < 20) {
      iterations += 1;
      const out = upsertWithCursorYieldable(db, nextArgs, { token, chunkSize: 50 });
      if (out.kind === "done") break;
      nextArgs = out.resume;
    }
    expect(iterations).toBeLessThan(20);

    // Every doc landed, exactly once.
    const present = checkExistingExternalIds(
      db,
      "google",
      "gmail",
      docs.map((d) => d.externalId),
    );
    expect(present.length).toBe(220);
    const row = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM documents WHERE source_id = 'gmail'")
      .get();
    expect(row?.c).toBe(220);

    // Cursor advanced exactly to the final value.
    expect(JSON.parse(getSyncState(db, "gmail")!.cursor)).toEqual({ historyId: 12345 });
  });

  test("replica acceptance and stale ignores survive cooperative yield continuations", () => {
    const fresh = Array.from({ length: 60 }, (_, index) =>
      makeDoc({
        externalId: `versioned-${index}`,
        contentHash: `fresh-${index}`,
        sourceUpdatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    upsertDocuments(db, fresh, {
      replicaVersionPolicies: { gmail: "source-updated-at" },
    });
    const stale = fresh.map((document, index) =>
      makeDoc({
        externalId: document.externalId,
        contentHash: `stale-${index}`,
        sourceUpdatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    const newDocuments = Array.from({ length: 60 }, (_, index) =>
      makeDoc({
        externalId: `new-${index}`,
        contentHash: `new-${index}`,
        sourceUpdatedAt: "2026-03-03T00:00:00.000Z",
      }),
    );
    let args: Parameters<typeof upsertWithCursorYieldable>[1] = {
      providerId: "google",
      sourceId: "gmail",
      // Accepted rows deliberately precede stale-only continuations. The
      // final chunk cannot hide lost accepted-row accounting.
      documents: [...newDocuments, ...stale],
      replicaVersionPolicy: "source-updated-at",
      hasMore: false,
      cursor: { historyId: 2468 },
    };
    let final: Extract<ReturnType<typeof upsertWithCursorYieldable>, { kind: "done" }> | null =
      null;
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const out = upsertWithCursorYieldable(db, args, {
        token: { requested: () => true },
        chunkSize: 10,
      });
      if (out.kind === "done") {
        final = out;
        break;
      }
      args = out.resume;
    }

    expect(final?.value.ignoredReplicaDocuments).toHaveLength(60);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM documents").get()?.count,
    ).toBe(120);
    expect(JSON.parse(getSyncState(db, "gmail")!.cursor)).toEqual({ historyId: 2468 });
    expect(getSyncState(db, "gmail")?.last_document_at).not.toBeNull();
  });

  test("yield-mid-stream then commit applies tombstones + absence marks + cursor only once at the end", () => {
    // Seed two docs the final snapshot omits. The call adds 220 docs split
    // across yield-chunks; the final chunk carries presentExternalIds +
    // hasMore=false + deletedExternalIds, and none of those may apply during a
    // pre-final chunk — only in the very last transaction.
    upsertDocuments(db, [makeDoc({ externalId: "orphan-1" }), makeDoc({ externalId: "orphan-2" })]);

    const docs = Array.from({ length: 220 }, (_, i) =>
      makeDoc({ externalId: `f-${i}`, contentHash: `hf-${i}` }),
    );
    let polls = 0;
    const token = {
      requested(): boolean {
        polls += 1;
        // Yield after the first chunk only.
        return polls === 1;
      },
    };

    // First call yields.
    const first = upsertWithCursorYieldable(
      db,
      {
        providerId: "google",
        sourceId: "gmail",
        documents: docs,
        absencePlan: computeSnapshotAbsencePlan(
          db,
          "google",
          "gmail",
          docs.map((d) => d.externalId), // explicitly NOT orphan-*
          ABSENCE_POLICY,
          { arrivingExternalIds: docs.map((d) => d.externalId) },
        ),
        deletedExternalIds: ["f-non-existent"],
        hasMore: false,
        cursor: { historyId: 555 },
      },
      { token, chunkSize: 50 },
    );
    expect(first.kind).toBe("yield");
    // After the yield the orphans are unmarked — the snapshot has not been
    // consumed yet — and the cursor has not advanced.
    expect(countPendingAbsences(db)).toBe(0);
    expect(getSyncState(db, "gmail")).toBeNull();

    // Resume to completion (no more yields).
    if (first.kind !== "yield") throw new Error("typeguard");
    const second = upsertWithCursorYieldable(db, first.resume, {
      token: { requested: () => false },
      chunkSize: 50,
    });
    expect(second.kind).toBe("done");

    // The final chunk consumed the snapshot exactly once: both orphans carry a
    // pending absence, and both are still stored.
    expect(countPendingAbsences(db)).toBe(2);
    expect(
      checkExistingExternalIds(db, "google", "gmail", ["orphan-1", "orphan-2"]).sort(),
    ).toEqual(["orphan-1", "orphan-2"]);
    // And the cursor is at the final value.
    expect(JSON.parse(getSyncState(db, "gmail")!.cursor)).toEqual({ historyId: 555 });
  });

  test("a yielded stale page cannot resume after a source wipe", () => {
    const docs = Array.from({ length: 120 }, (_, i) =>
      makeDoc({ externalId: `stale-${i}`, contentHash: `stale-hash-${i}` }),
    );
    const first = upsertWithCursorYieldable(
      db,
      {
        providerId: "google",
        sourceId: "gmail",
        documents: docs,
        hasMore: false,
        cursor: { historyId: 700 },
        wipeEpoch: 0,
      },
      { token: { requested: () => true }, chunkSize: 50 },
    );
    expect(first.kind).toBe("yield");
    deleteAllBySource(db, "gmail");
    expect(getWipeEpoch(db, "gmail")).toBe(1);

    if (first.kind !== "yield") throw new Error("typeguard");
    const resumed = upsertWithCursorYieldable(db, first.resume, {
      token: { requested: () => false },
      chunkSize: 50,
    });

    expect(resumed).toEqual({
      kind: "done",
      value: {
        tombstoneDeletedDocumentIds: [],
        ignoredReplicaDocuments: [],
        rejected: true,
      },
    });
    expect(
      checkExistingExternalIds(
        db,
        "google",
        "gmail",
        docs.map((doc) => doc.externalId),
      ),
    ).toEqual([]);
    expect(getSyncState(db, "gmail")).toBeNull();
  });

  test("no token + large batch falls back to the legacy single-transaction path", () => {
    // When no token is provided, the caller doesn't want cooperative
    // yield — preserve the original atomic semantics regardless of
    // batch size. Verifies the function doesn't accidentally chunk
    // when it shouldn't.
    const docs = Array.from({ length: 120 }, (_, i) =>
      makeDoc({ externalId: `nt-${i}`, contentHash: `hnt-${i}` }),
    );
    const out = upsertWithCursorYieldable(
      db,
      {
        providerId: "google",
        sourceId: "gmail",
        documents: docs,
        hasMore: false,
        cursor: { historyId: 222 },
      },
      // chunkSize override is ignored when no token is passed (fast path).
      { chunkSize: 50 },
    );
    expect(out.kind).toBe("done");
    expect(
      checkExistingExternalIds(
        db,
        "google",
        "gmail",
        docs.map((d) => d.externalId),
      ).length,
    ).toBe(120);
    expect(JSON.parse(getSyncState(db, "gmail")!.cursor)).toEqual({ historyId: 222 });
  });

  test("a huge (>=1MB) doc in the pre-final slice forces per-doc commits (guard reaches the cursor path)", () => {
    // Pre-final docs flow through `upsertDocuments` WITH the token, so its
    // huge-doc guard applies on the collector/cursor path too: a >=1MB doc
    // commits alone in its own transaction, never bundled with its chunk peers.
    // With a >=1MB doc at index 0 and chunkSize 5, the guard collapses to one
    // doc per transaction, so the first yield lands EXACTLY that one huge doc.
    const bigContent = "x".repeat(1_000_000);
    const docs = [
      makeDoc({ externalId: "big-0", content: bigContent, contentHash: "hbig-0" }),
      ...Array.from({ length: 11 }, (_, i) =>
        makeDoc({ externalId: `small-${i}`, contentHash: `hsmall-${i}` }),
      ),
    ];
    let polls = 0;
    const token = {
      requested(): boolean {
        polls += 1;
        return polls >= 1; // yield at the first inter-chunk poll
      },
    };
    const out = upsertWithCursorYieldable(
      db,
      {
        providerId: "google",
        sourceId: "gmail",
        documents: docs,
        hasMore: false,
        cursor: { historyId: 42 },
      },
      { token, chunkSize: 5 },
    );
    expect(out.kind).toBe("yield");
    if (out.kind !== "yield") throw new Error("typeguard");

    // Exactly ONE doc committed (the huge one), not a 5-doc chunk.
    const committed = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM documents WHERE source_id = 'gmail'")
      .get();
    expect(committed?.c).toBe(1);
    expect(checkExistingExternalIds(db, "google", "gmail", ["big-0"])).toEqual(["big-0"]);
    expect(out.resume.documents?.[0].externalId).toBe("small-0");
    // Cursor not advanced yet.
    expect(getSyncState(db, "gmail")).toBeNull();

    // Drive to completion → every doc lands and the cursor advances once.
    let nextArgs = out.resume;
    let iterations = 0;
    for (;;) {
      iterations += 1;
      if (iterations > 30) throw new Error("did not converge");
      const step = upsertWithCursorYieldable(db, nextArgs, {
        token: { requested: () => false },
        chunkSize: 5,
      });
      if (step.kind === "done") break;
      nextArgs = step.resume;
    }
    expect(
      checkExistingExternalIds(
        db,
        "google",
        "gmail",
        docs.map((d) => d.externalId),
      ).length,
    ).toBe(12);
    expect(JSON.parse(getSyncState(db, "gmail")!.cursor)).toEqual({ historyId: 42 });
  });

  test("yield with tombstoned docs in the page loses NO document (identity-based resume)", () => {
    // Regression: upsertDocuments drops tombstoned (privacy-deleted) docs
    // up front, so `remaining` is a slice of the FILTERED array. Resuming by a
    // recomputed index (preFinal.length - remaining.length) mixes a filtered
    // length with an unfiltered one and silently skips real docs. Resume must
    // be identity-based. Here t-90..t-99 are tombstoned and sit in the
    // un-processed pre-final region at yield time; t-50..t-59 are the docs the
    // buggy index arithmetic dropped.
    const docs = Array.from({ length: 220 }, (_, i) =>
      makeDoc({ externalId: `t-${i}`, contentHash: `ht-${i}` }),
    );
    // Tombstone t-90..t-99 the production way (deleteDocumentForUser writes the
    // removed_documents row AND invalidates the presence cache — a raw INSERT
    // would leave the module-level cache stale). The docs need not exist first;
    // the tombstone is created regardless, suppressing them on the next sync.
    for (let i = 90; i < 100; i++) {
      deleteDocumentForUser(db, "google", "gmail", `t-${i}`);
    }
    let polls = 0;
    const token = {
      requested(): boolean {
        polls += 1;
        return polls >= 1; // yield after the first chunk
      },
    };
    let nextArgs: Parameters<typeof upsertWithCursorYieldable>[1] = {
      providerId: "google",
      sourceId: "gmail",
      documents: docs,
      hasMore: false,
      cursor: { historyId: 7 },
    };
    let iterations = 0;
    for (;;) {
      iterations += 1;
      if (iterations > 60) throw new Error("did not converge");
      const step = upsertWithCursorYieldable(db, nextArgs, { token, chunkSize: 50 });
      if (step.kind === "done") break;
      nextArgs = step.resume;
    }

    // Every non-tombstoned doc landed; the ten tombstoned ids did not.
    const wantPresent = docs
      .map((d) => d.externalId)
      .filter((id) => {
        const n = Number(id.slice(2));
        return n < 90 || n >= 100;
      });
    const present = checkExistingExternalIds(db, "google", "gmail", wantPresent);
    expect(present.length).toBe(210);
    // The docs the buggy arithmetic dropped are specifically present.
    expect(
      checkExistingExternalIds(db, "google", "gmail", ["t-50", "t-55", "t-59"]).sort(),
    ).toEqual(["t-50", "t-55", "t-59"]);
    // Tombstoned docs stay suppressed.
    expect(checkExistingExternalIds(db, "google", "gmail", ["t-90", "t-95", "t-99"])).toEqual([]);
    expect(JSON.parse(getSyncState(db, "gmail")!.cursor)).toEqual({ historyId: 7 });
  });
});

describe("sync_state per-device rows", () => {
  let db: Db;
  let dbPath: string;
  const phone = "11111111-1111-4111-8111-111111111111";
  const tablet = "22222222-2222-4222-8222-222222222222";
  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("a member's row is separate from the shared row and from other members", () => {
    setSyncState(db, "apple-health:local", { anchor: "shared" });
    setSyncState(
      db,
      "apple-health:local",
      { anchor: "p1" },
      undefined,
      undefined,
      false,
      undefined,
      phone,
    );
    setSyncState(
      db,
      "apple-health:local",
      { anchor: "t1" },
      undefined,
      undefined,
      false,
      undefined,
      tablet,
    );
    expect(getSyncState(db, "apple-health:local")?.cursor).toContain("shared");
    expect(getSyncState(db, "apple-health:local", phone)?.cursor).toContain("p1");
    expect(getSyncState(db, "apple-health:local", tablet)?.cursor).toContain("t1");
    expect(
      getSyncState(db, "apple-health:local", "33333333-3333-4333-8333-333333333333"),
    ).toBeNull();
    expect(listSyncStates(db).filter((r) => r.source_id === "apple-health:local")).toHaveLength(3);
  });

  test("errors are stamped and cleared per row, or across every row of the source", () => {
    setSyncState(db, "apple-health:local", { anchor: "shared" });
    setSyncState(
      db,
      "apple-health:local",
      { anchor: "p1" },
      undefined,
      undefined,
      false,
      undefined,
      phone,
    );
    setSyncError(db, "apple-health:local", "phone lost auth", phone);
    expect(getSyncState(db, "apple-health:local", phone)?.last_error).toBe("phone lost auth");
    expect(getSyncState(db, "apple-health:local")?.last_error).toBeNull();
    // A member's error row is created when it has no cursor row yet.
    setSyncError(db, "apple-health:local", "tablet lost auth", tablet);
    expect(getSyncState(db, "apple-health:local", tablet)?.last_error).toBe("tablet lost auth");
    clearSyncError(db, "apple-health:local", phone);
    expect(getSyncState(db, "apple-health:local", phone)?.last_error).toBeNull();
    expect(getSyncState(db, "apple-health:local", tablet)?.last_error).toBe("tablet lost auth");
    clearSyncError(db, "apple-health:local");
    expect(getSyncState(db, "apple-health:local", tablet)?.last_error).toBeNull();
  });
});
