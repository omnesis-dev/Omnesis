// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { bm25Search } from "../search/bm25.js";
import {
  EMBEDDING_DIM,
  createIndexDatabase,
  getWatermark,
  setWatermark,
  getIndexedDocument,
  setIndexedDocument,
  markIndexedDocumentEvent,
  removeIndexedDocument,
  getAllIndexedDocumentIds,
  upsertChunks,
  upsertChunksAndMarkIndexed,
  upsertChunksAndMarkIndexedBatch,
  deleteChunksByDocument,
  deleteChunksByDocumentBatch,
  getVectorWriteSeq,
  deleteIndexBySource,
  preparePendingVectorDeletes,
  completePendingVectorDeletes,
  enqueueSourceIndexPurge,
  listPendingSourceIndexPurges,
  enqueueDocumentIndexPurge,
  listPendingDocumentIndexPurges,
  completeDocumentIndexPurges,
  scrubPendingSourceIndexPurges,
  getBuildableDocumentCount,
  getChunkCount,
  getIndexedDocumentCount,
  recordIndexError,
  recordIndexDegraded,
  clearIndexError,
  getIndexErrorCountsBySource,
  getDegradedStatsBySource,
  getErroredDocumentIds,
  refreshIndexStats,
  getIndexStatsBySource,
  wipeAndRecreateVectorIndex,
  getIndexEmbedModel,
  setIndexEmbedModel,
  migrateAdoptInPlaceVersion,
  getIndexVersion,
  reconcileIndexForGatewaySchema,
} from "./db.js";
import { UsearchWriteHandle, UsearchReadHandle } from "./usearch-index.js";
import type { ChunkUpsertInput } from "./db.js";
type Db = Database.Database;

let db: Db;

beforeEach(() => {
  db = createIndexDatabase(`/tmp/omnesis-indexer-test-${randomUUID()}.db`);
});

afterEach(() => {
  db.close();
});

/** Deterministic unit-normalized embedding seeded from `val`. */
function makeEmbedding(val: number, dim: number = EMBEDDING_DIM): Float32Array {
  const arr = new Float32Array(dim);
  let s = (val * 0x9e3779b9) >>> 0;
  for (let i = 0; i < dim; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    arr[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += arr[i] * arr[i];
  const norm = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) arr[i] /= norm;
  return arr;
}

describe("schema", () => {
  test("chunks table has an embedding BLOB column", () => {
    const cols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('chunks')")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("embedding");
  });
});

describe("gateway schema reconciliation", () => {
  test("rejects invalid batch sizes", () => {
    const gatewayDb = new Database(":memory:");
    try {
      gatewayDb.exec("CREATE TABLE documents (id TEXT PRIMARY KEY)");
      expect(() => reconcileIndexForGatewaySchema(gatewayDb, db, 0)).toThrow(
        "Index reconciliation batch size must be a positive integer",
      );
    } finally {
      gatewayDb.close();
    }
  });

  test("removes stale BM25 rows before search and preserves live documents", () => {
    const gatewayDb = new Database(":memory:");
    try {
      gatewayDb.exec("CREATE TABLE documents (id TEXT PRIMARY KEY)");
      gatewayDb.prepare("INSERT INTO documents (id) VALUES (?)").run("live-extension-page");
      gatewayDb.pragma("user_version = 70");

      upsertChunks(db, [
        {
          id: "live-chunk",
          documentId: "live-extension-page",
          chunkIndex: 0,
          content: "retained browser extension content",
          embedding: makeEmbedding(1),
          sourceId: "web",
          documentType: "webpage",
          title: "Retained",
          sourceCreatedAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "stale-chunk",
          documentId: "retired-page",
          chunkIndex: 0,
          content: "retired private page content",
          embedding: makeEmbedding(2),
          sourceId: "web",
          documentType: "webpage",
          title: "Retired",
          sourceCreatedAt: "2026-03-10T00:00:00Z",
        },
      ]);
      setIndexedDocument(db, "live-extension-page", "live", 1);
      setIndexedDocument(db, "retired-page", "stale", 1);
      recordIndexError(db, "error-only-retired-page", "web", "retry");

      expect(reconcileIndexForGatewaySchema(gatewayDb, db, 1)).toEqual({
        ran: true,
        gatewaySchemaVersion: 70,
        removedDocuments: 2,
        removedChunks: 1,
      });
      expect(getIndexedDocument(db, "live-extension-page")).not.toBeNull();
      expect(getIndexedDocument(db, "retired-page")).toBeNull();
      expect(getErroredDocumentIds(db)).not.toContain("error-only-retired-page");
      expect(
        db
          .prepare<
            [],
            { count: number }
          >("SELECT COUNT(*) AS count FROM chunks WHERE document_id = 'retired-page'")
          .get()?.count,
      ).toBe(0);
      expect(
        db
          .prepare<
            [string],
            { count: number }
          >("SELECT COUNT(*) AS count FROM chunks_fts WHERE chunks_fts MATCH ?")
          .get("retired")?.count,
      ).toBe(0);
      expect(
        db
          .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM pending_vector_deletes")
          .get()?.count,
      ).toBe(1);
      expect(
        db
          .prepare<
            [],
            { value: string }
          >("SELECT value FROM index_meta WHERE key = 'gateway_schema_version_reconciled'")
          .get()?.value,
      ).toBe("70");

      expect(reconcileIndexForGatewaySchema(gatewayDb, db)).toEqual({
        ran: false,
        gatewaySchemaVersion: 70,
        removedDocuments: 0,
        removedChunks: 0,
      });
    } finally {
      gatewayDb.close();
    }
  });
});

describe("watermark", () => {
  test("returns null when no watermark set", () => {
    expect(getWatermark(db, "does_not_exist")).toBeNull();
  });

  test("set and get watermark", () => {
    setWatermark(db, "last_updated_at", "2026-03-10T00:00:00Z");
    expect(getWatermark(db, "last_updated_at")).toBe("2026-03-10T00:00:00Z");
  });

  test("overwrite watermark", () => {
    setWatermark(db, "last_updated_at", "2026-03-10T00:00:00Z");
    setWatermark(db, "last_updated_at", "2026-03-10T01:00:00Z");
    expect(getWatermark(db, "last_updated_at")).toBe("2026-03-10T01:00:00Z");
  });
});

describe("indexed documents", () => {
  test("returns null for unknown document", () => {
    expect(getIndexedDocument(db, "unknown")).toBeNull();
  });

  test("set and get indexed document", () => {
    setIndexedDocument(db, "doc-1", "hash-a", 3);
    const row = getIndexedDocument(db, "doc-1");
    expect(row).not.toBeNull();
    expect(row!.content_hash).toBe("hash-a");
    expect(row!.chunk_count).toBe(3);
    expect(row!.index_version).toBe(1);
  });

  test("update indexed document", () => {
    setIndexedDocument(db, "doc-1", "hash-a", 3);
    setIndexedDocument(db, "doc-1", "hash-b", 5);
    const row = getIndexedDocument(db, "doc-1");
    expect(row!.content_hash).toBe("hash-b");
    expect(row!.chunk_count).toBe(5);
    expect(row!.index_version).toBe(2);
  });

  test("document event clocks remain monotonic across a wall-clock regression", () => {
    setIndexedDocument(db, "doc-1", "hash-a", 3, "source-event-a");
    db.prepare("UPDATE indexed_documents SET event_indexed_at = ? WHERE document_id = ?").run(
      "2099-01-01T00:00:00.000Z",
      "doc-1",
    );

    expect(markIndexedDocumentEvent(db, "doc-1", "source-event-b")).toBe(true);
    expect(
      db
        .prepare<
          [string],
          { source_event_at: string; event_indexed_at: string }
        >("SELECT source_event_at, event_indexed_at FROM indexed_documents WHERE document_id = ?")
        .get("doc-1"),
    ).toEqual({
      source_event_at: "source-event-b",
      event_indexed_at: "2099-01-01T00:00:00.001Z",
    });
  });

  test("remove indexed document", () => {
    setIndexedDocument(db, "doc-1", "hash-a", 3);
    removeIndexedDocument(db, "doc-1");
    expect(getIndexedDocument(db, "doc-1")).toBeNull();
  });

  test("getAllIndexedDocumentIds", () => {
    setIndexedDocument(db, "doc-1", "h1", 1);
    setIndexedDocument(db, "doc-2", "h2", 2);
    const ids = getAllIndexedDocumentIds(db);
    expect(ids.size).toBe(2);
    expect(ids.has("doc-1")).toBe(true);
    expect(ids.has("doc-2")).toBe(true);
  });
});

describe("chunks", () => {
  test("upsert and count chunks", () => {
    upsertChunks(db, [
      {
        id: "chunk-1",
        documentId: "doc-1",
        chunkIndex: 0,
        content: "Hello world",
        embedding: makeEmbedding(1),
        sourceId: "gmail:user@example.com",
        documentType: "email",
        title: "Test Email",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    expect(getChunkCount(db)).toBe(1);
  });

  test("upsertChunks stores the embedding blob in chunks.embedding", () => {
    const emb = makeEmbedding(42);
    upsertChunks(db, [
      {
        id: "emb-1",
        documentId: "doc-emb",
        chunkIndex: 0,
        content: "Embedding test",
        embedding: emb,
        sourceId: "gmail:user@example.com",
        documentType: "email",
        title: "Emb Test",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    const row = db
      .prepare<
        [string],
        { embedding: Buffer | null }
      >("SELECT embedding FROM chunks WHERE document_id = ?")
      .get("doc-emb");
    expect(row).not.toBeNull();
    expect(row!.embedding).not.toBeNull();
    const stored = new Float32Array(
      row!.embedding!.buffer,
      row!.embedding!.byteOffset,
      row!.embedding!.byteLength / 4,
    );
    expect(stored.length).toBe(emb.length);
    for (let i = 0; i < emb.length; i++) {
      expect(stored[i]).toBeCloseTo(emb[i], 5);
    }
  });

  test("vector_write_seq advances on embedding writes and vector deletions", () => {
    const mk = (docId: string, i: number) => ({
      id: `s-${docId}-${i}`,
      documentId: docId,
      chunkIndex: i,
      content: `c ${docId} ${i}`,
      embedding: makeEmbedding(i + 1),
      sourceId: "test",
      title: "T",
      sourceCreatedAt: "2026-03-10T00:00:00Z",
    });
    expect(getVectorWriteSeq(db)).toBe(0);

    upsertChunks(db, [mk("doc-a", 0)]);
    expect(getVectorWriteSeq(db)).toBe(1);

    // Re-upsert (update) the same chunk → still an embedding write → bumps.
    upsertChunks(db, [mk("doc-a", 0)]);
    expect(getVectorWriteSeq(db)).toBe(2);

    // A batch of new chunks bumps exactly once (per call), not per row.
    upsertChunks(db, [mk("doc-b", 0), mk("doc-b", 1)]);
    expect(getVectorWriteSeq(db)).toBe(3);

    // An empty call does not bump.
    upsertChunks(db, []);
    expect(getVectorWriteSeq(db)).toBe(3);

    // A delete bumps too: until the worker publishes the queued HNSW removal,
    // a restored sidecar must not claim it matches the lexical rows.
    deleteChunksByDocument(db, "doc-a");
    expect(getVectorWriteSeq(db)).toBe(4);
  });

  test("delete chunks by document", () => {
    upsertChunks(db, [
      {
        id: "chunk-1",
        documentId: "doc-1",
        chunkIndex: 0,
        content: "Hello",
        embedding: makeEmbedding(1),
        sourceId: "test",
        title: "Test",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "chunk-2",
        documentId: "doc-1",
        chunkIndex: 1,
        content: "World",
        embedding: makeEmbedding(2),
        sourceId: "test",
        title: "Test",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "chunk-3",
        documentId: "doc-2",
        chunkIndex: 0,
        content: "Other",
        embedding: makeEmbedding(3),
        sourceId: "test",
        title: "Other",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);

    expect(getChunkCount(db)).toBe(3);
    deleteChunksByDocument(db, "doc-1");
    expect(getChunkCount(db)).toBe(1);
  });

  test("deleteChunksByDocument also clears the indexed_documents row", () => {
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "doc-orphan",
        chunkIndex: 0,
        content: "x",
        embedding: makeEmbedding(1),
        sourceId: "test",
        title: "x",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    setIndexedDocument(db, "doc-orphan", "hash-x", 1);

    expect(getIndexedDocumentCount(db)).toBe(1);
    expect(getChunkCount(db)).toBe(1);

    const removedChunkRows = deleteChunksByDocument(db, "doc-orphan");
    expect(removedChunkRows).toBe(1);

    // Both `chunks` and `indexed_documents` must be empty — without the
    // indexed_documents cleanup, getIndexedDocumentCount would over-report
    // (the orphan-chunks finding from QA).
    expect(getChunkCount(db)).toBe(0);
    expect(getIndexedDocumentCount(db)).toBe(0);
  });

  test("deleteChunksByDocumentBatch preserves its retry token until the final chunk", () => {
    upsertChunks(
      db,
      [0, 1, 2].map((chunkIndex) => ({
        id: `bounded-${chunkIndex}`,
        documentId: "doc-bounded",
        chunkIndex,
        content: `Bounded chunk ${chunkIndex}`,
        embedding: makeEmbedding(chunkIndex + 1),
        sourceId: "test",
        title: "Bounded cleanup",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      })),
    );
    setIndexedDocument(db, "doc-bounded", "hash-bounded", 3);

    expect(deleteChunksByDocumentBatch(db, "doc-bounded", 2, false)).toEqual({
      deletedChunks: 2,
      complete: false,
      readyForSourceDelete: false,
    });
    expect(getChunkCount(db)).toBe(1);
    expect(getIndexedDocumentCount(db)).toBe(1);

    expect(deleteChunksByDocumentBatch(db, "doc-bounded", 2, false)).toEqual({
      deletedChunks: 0,
      complete: false,
      readyForSourceDelete: true,
    });
    expect(getChunkCount(db)).toBe(1);
    expect(getIndexedDocumentCount(db)).toBe(1);

    expect(deleteChunksByDocumentBatch(db, "doc-bounded", 2, true)).toEqual({
      deletedChunks: 1,
      complete: true,
      readyForSourceDelete: false,
    });
    expect(getChunkCount(db)).toBe(0);
    expect(getIndexedDocumentCount(db)).toBe(0);
  });

  test("worker-side document batches journal vector removals before graph publication", () => {
    upsertChunks(
      db,
      [0, 1, 2].map((chunkIndex) => ({
        id: `durable-bounded-${chunkIndex}`,
        documentId: "doc-durable-bounded",
        chunkIndex,
        content: `Durable bounded chunk ${chunkIndex}`,
        embedding: makeEmbedding(chunkIndex + 1),
        sourceId: "test",
        title: "Durable bounded cleanup",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      })),
    );
    setIndexedDocument(db, "doc-durable-bounded", "hash-durable", 3);
    const removed: bigint[] = [];
    const usearch = {
      removeBatch: (rowids: bigint[]) => removed.push(...rowids),
    } as unknown as UsearchWriteHandle;

    expect(deleteChunksByDocumentBatch(db, "doc-durable-bounded", 2, false, { usearch })).toEqual({
      deletedChunks: 2,
      complete: false,
      readyForSourceDelete: false,
    });
    expect(removed).toHaveLength(2);
    expect(
      db
        .prepare<[], { chunk_rowid: number }>(
          "SELECT chunk_rowid FROM pending_vector_deletes ORDER BY chunk_rowid",
        )
        .all()
        .map((row) => row.chunk_rowid),
    ).toEqual(removed.map(Number).sort((a, b) => a - b));
  });

  test("deleteChunksByDocument is a no-op when the document has nothing indexed yet", () => {
    // Delete-before-index race: documents removed before the indexer
    // ever picked them up. Must not throw.
    const removed = deleteChunksByDocument(db, "never-indexed");
    expect(removed).toBe(0);
    expect(getChunkCount(db)).toBe(0);
  });

  test("deleteIndexBySource removes chunks and indexed_documents for that source only", () => {
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "doc-a",
        chunkIndex: 0,
        content: "Gmail email",
        embedding: makeEmbedding(1),
        sourceId: "gmail:user@example.com",
        title: "Email",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "c2",
        documentId: "doc-b",
        chunkIndex: 0,
        content: "A note",
        embedding: makeEmbedding(2),
        sourceId: "apple-notes",
        title: "Note",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    setIndexedDocument(db, "doc-a", "hash-a", 1);
    setIndexedDocument(db, "doc-b", "hash-b", 1);

    expect(getChunkCount(db)).toBe(2);
    expect(getIndexedDocumentCount(db)).toBe(2);

    const deleted = deleteIndexBySource(db, "gmail:user@example.com");
    expect(deleted).toBe(1);
    expect(getChunkCount(db)).toBe(1);
    expect(getIndexedDocumentCount(db)).toBe(1);
    expect(getIndexedDocument(db, "doc-a")).toBeNull();
    expect(getIndexedDocument(db, "doc-b")).not.toBeNull();
  });

  test("deleteIndexBySource returns 0 when source has no indexed data", () => {
    const deleted = deleteIndexBySource(db, "nonexistent");
    expect(deleted).toBe(0);
  });

  test("deleteIndexBySource is safe to re-run, including over rows written after it", () => {
    // The worker answers a source deletion immediately and re-applies it once
    // any in-flight indexing job stops, because that job can still write rows
    // for documents it read before the delete landed. Both halves of that are
    // asserted here: a second pass over an already-clean source is a harmless
    // no-op, and a second pass over rows written since actually removes them.
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "doc-a",
        chunkIndex: 0,
        content: "First pass",
        embedding: makeEmbedding(1),
        sourceId: "obsidian-notes:vault-alpha",
        title: "Note",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    setIndexedDocument(db, "doc-a", "hash-a", 1);

    expect(deleteIndexBySource(db, "obsidian-notes:vault-alpha")).toBe(1);
    // Re-running over a clean source removes nothing and does not throw.
    expect(deleteIndexBySource(db, "obsidian-notes:vault-alpha")).toBe(0);
    expect(getChunkCount(db)).toBe(0);

    // What the in-flight job leaves behind: rows for a document it had already
    // read. The re-apply pass is what clears them.
    upsertChunks(db, [
      {
        id: "c2",
        documentId: "doc-a",
        chunkIndex: 0,
        content: "Written by a cycle that was mid-page",
        embedding: makeEmbedding(2),
        sourceId: "obsidian-notes:vault-alpha",
        title: "Note",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    setIndexedDocument(db, "doc-a", "hash-a", 1);
    expect(getChunkCount(db)).toBe(1);

    expect(deleteIndexBySource(db, "obsidian-notes:vault-alpha")).toBe(1);
    expect(getChunkCount(db)).toBe(0);
    expect(getIndexedDocument(db, "doc-a")).toBeNull();
  });

  test("deleteIndexBySource also wipes source_index_stats and indexing_errors", () => {
    // Seed chunks + indexed_documents for two sources
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "doc-a",
        chunkIndex: 0,
        content: "WhatsApp msg",
        embedding: makeEmbedding(1),
        sourceId: "whatsapp:+1",
        title: "Day",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "c2",
        documentId: "doc-b",
        chunkIndex: 0,
        content: "Note",
        embedding: makeEmbedding(2),
        sourceId: "apple-notes",
        title: "Note",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    setIndexedDocument(db, "doc-a", "hash-a", 1);
    setIndexedDocument(db, "doc-b", "hash-b", 1);
    recordIndexError(db, "doc-a", "whatsapp:+1", "boom");
    recordIndexError(db, "doc-b", "apple-notes", "kaboom");

    // Manually insert a stats row for the source we'll delete (mirrors what
    // the periodic refresh does)
    db.prepare(
      `INSERT INTO source_index_stats (source_id, indexed_docs, chunks, earliest_source_date, latest_source_date, last_computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "whatsapp:+1",
      1,
      1,
      "2026-03-10T00:00:00Z",
      "2026-03-10T00:00:00Z",
      new Date().toISOString(),
    );
    db.prepare(
      `INSERT INTO source_index_stats (source_id, indexed_docs, chunks, earliest_source_date, latest_source_date, last_computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "apple-notes",
      1,
      1,
      "2026-03-10T00:00:00Z",
      "2026-03-10T00:00:00Z",
      new Date().toISOString(),
    );

    deleteIndexBySource(db, "whatsapp:+1");

    // The deleted source's rows are gone
    const statsRow = db
      .prepare<
        [string],
        { source_id: string }
      >("SELECT source_id FROM source_index_stats WHERE source_id = ?")
      .get("whatsapp:+1");
    expect(statsRow).toBeUndefined();

    const errorRow = db
      .prepare<
        [string],
        { document_id: string }
      >("SELECT document_id FROM indexing_errors WHERE source_id = ?")
      .get("whatsapp:+1");
    expect(errorRow).toBeUndefined();

    // The other source is untouched
    const otherStats = db
      .prepare<
        [string],
        { source_id: string }
      >("SELECT source_id FROM source_index_stats WHERE source_id = ?")
      .get("apple-notes");
    expect(otherStats?.source_id).toBe("apple-notes");

    const otherError = db
      .prepare<
        [string],
        { document_id: string }
      >("SELECT document_id FROM indexing_errors WHERE source_id = ?")
      .get("apple-notes");
    expect(otherError?.document_id).toBe("doc-b");
  });

  // #553: the HTTP delete cascade has no usearch write handle, so it must
  // enqueue the deleted chunks' rowids for the indexer worker to remove —
  // otherwise the vectors orphan forever and a large resync OOMs the box.
  describe("pending vector deletes (#553)", () => {
    function fakeUsearch(): { handle: UsearchWriteHandle; removed: bigint[] } {
      const removed: bigint[] = [];
      const handle = {
        removeBatch: (keys: bigint[]) => {
          removed.push(...keys);
        },
      } as unknown as UsearchWriteHandle;
      return { handle, removed };
    }
    const seedGmailChunk = () =>
      upsertChunks(db, [
        {
          id: "c1",
          documentId: "doc-a",
          chunkIndex: 0,
          content: "x",
          embedding: makeEmbedding(1),
          sourceId: "gmail:u@example.com",
          title: "T",
          sourceCreatedAt: "2026-03-10T00:00:00Z",
        },
      ]);
    const gmailRowid = (): number =>
      (
        db
          .prepare<
            [],
            { rowid: number }
          >("SELECT rowid FROM chunks WHERE source_id = 'gmail:u@example.com'")
          .get() as { rowid: number }
      ).rowid;
    const pendingRowids = (): number[] =>
      db
        .prepare<[], { chunk_rowid: number }>("SELECT chunk_rowid FROM pending_vector_deletes")
        .all()
        .map((r) => r.chunk_rowid);

    test("deleteIndexBySource without a usearch handle enqueues the deleted rowids", () => {
      seedGmailChunk();
      const rowid = gmailRowid();
      deleteIndexBySource(db, "gmail:u@example.com");
      expect(pendingRowids()).toEqual([rowid]);
    });

    test("pre-listen source scrub removes lexical rows but retains the publication obligation", () => {
      seedGmailChunk();
      const rowid = gmailRowid();
      enqueueSourceIndexPurge(db, "gmail:u@example.com");

      expect(scrubPendingSourceIndexPurges(db)).toEqual({
        sourceIds: ["gmail:u@example.com"],
        deletedDocuments: 1,
      });
      expect(
        db
          .prepare<
            [],
            { c: number }
          >("SELECT COUNT(*) AS c FROM chunks_fts WHERE chunks_fts MATCH 'x'")
          .get()?.c,
      ).toBe(0);
      expect(pendingRowids()).toEqual([rowid]);
      expect(listPendingSourceIndexPurges(db)).toEqual(["gmail:u@example.com"]);
    });

    test("persists a per-document reapply obligation across index database reopen", () => {
      enqueueDocumentIndexPurge(db, "doc-retained", false);
      enqueueDocumentIndexPurge(db, "doc-retained", true);
      expect(listPendingDocumentIndexPurges(db)).toEqual([
        { documentId: "doc-retained", sourceDeleted: true },
      ]);

      const path = db
        .prepare<[], { file: string }>("PRAGMA database_list")
        .all()
        .find((row) => row.file.length > 0)!.file;
      db.close();
      db = createIndexDatabase(path);
      expect(listPendingDocumentIndexPurges(db)).toEqual([
        { documentId: "doc-retained", sourceDeleted: true },
      ]);
      completeDocumentIndexPurges(db, ["doc-retained"]);
      expect(listPendingDocumentIndexPurges(db)).toEqual([]);
    });

    test("lists per-document purge work in bounded source-deleted batches", () => {
      enqueueDocumentIndexPurge(db, "doc-a", false);
      enqueueDocumentIndexPurge(db, "doc-b", true);
      enqueueDocumentIndexPurge(db, "doc-c", true);

      expect(listPendingDocumentIndexPurges(db, { limit: 1, sourceDeletedOnly: true })).toEqual([
        { documentId: "doc-b", sourceDeleted: true },
      ]);
      completeDocumentIndexPurges(db, ["doc-b"]);
      expect(listPendingDocumentIndexPurges(db, { limit: 1, sourceDeletedOnly: true })).toEqual([
        { documentId: "doc-c", sourceDeleted: true },
      ]);
      expect(listPendingDocumentIndexPurges(db, { sourceDeletedOnly: true })).toEqual([
        { documentId: "doc-c", sourceDeleted: true },
      ]);
    });

    test("vector deletes remain journaled until graph publication completes", () => {
      seedGmailChunk();
      const rowid = gmailRowid();
      deleteIndexBySource(db, "gmail:u@example.com");
      const { handle, removed } = fakeUsearch();
      const prepared = preparePendingVectorDeletes(db, handle);
      expect(prepared).toEqual([{ chunkRowid: rowid, generation: 1 }]);
      expect(removed).toEqual([BigInt(rowid)]);
      expect(pendingRowids()).toEqual([rowid]);
      completePendingVectorDeletes(db, prepared);
      expect(pendingRowids()).toEqual([]);
      expect(preparePendingVectorDeletes(db, handle)).toEqual([]);
    });

    test("does not complete a newer delete generation after an older graph save", () => {
      seedGmailChunk();
      const rowid = gmailRowid();
      deleteIndexBySource(db, "gmail:u@example.com");
      const { handle } = fakeUsearch();
      const first = preparePendingVectorDeletes(db, handle);
      db.prepare(
        `INSERT INTO pending_vector_deletes (chunk_rowid, generation) VALUES (?, 1)
         ON CONFLICT(chunk_rowid) DO UPDATE SET generation = generation + 1`,
      ).run(rowid);
      completePendingVectorDeletes(db, first);
      expect(pendingRowids()).toEqual([rowid]);
      expect(preparePendingVectorDeletes(db, handle)).toEqual([
        { chunkRowid: rowid, generation: 2 },
      ]);
    });

    test("does not remove a queued rowid after a live chunk reuses it", () => {
      seedGmailChunk();
      const rowid = gmailRowid();
      deleteIndexBySource(db, "gmail:u@example.com");
      upsertChunks(db, [
        {
          id: "replacement-before-drain",
          documentId: "replacement-before-drain",
          chunkIndex: 0,
          content: "fictional replacement before drain",
          embedding: makeEmbedding(43),
          sourceId: "synthetic:replacement@example.com",
          title: "Replacement",
          sourceCreatedAt: "2026-03-10T00:00:00Z",
        },
      ]);
      expect(
        db
          .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = ?")
          .get("replacement-before-drain")?.rowid,
      ).toBe(rowid);

      const { handle, removed } = fakeUsearch();
      const prepared = preparePendingVectorDeletes(db, handle);
      expect(prepared).toEqual([{ chunkRowid: rowid, generation: 1 }]);
      expect(removed).toEqual([]);
      completePendingVectorDeletes(db, prepared);
      expect(pendingRowids()).toEqual([]);
    });

    test("deleteIndexBySource WITH a usearch handle removes vectors directly, enqueues nothing", () => {
      seedGmailChunk();
      const rowid = gmailRowid();
      const { handle, removed } = fakeUsearch();
      deleteIndexBySource(db, "gmail:u@example.com", { usearch: handle });
      expect(removed).toEqual([BigInt(rowid)]);
      expect(pendingRowids()).toEqual([]);
    });

    test("deleteChunksByDocument without a usearch handle enqueues the deleted rowids", () => {
      seedGmailChunk();
      const rowid = gmailRowid();
      deleteChunksByDocument(db, "doc-a");
      expect(pendingRowids()).toEqual([rowid]);
    });
  });

  test("deleteIndexBySource wipes stats and errors even when no chunks remain", () => {
    // Simulate a partially-cleaned-up source: stats row + errors exist but
    // chunks/indexed_documents already gone.
    db.prepare(
      `INSERT INTO source_index_stats (source_id, indexed_docs, chunks, earliest_source_date, latest_source_date, last_computed_at)
       VALUES (?, 0, 0, NULL, NULL, ?)`,
    ).run("whatsapp:+1", new Date().toISOString());
    recordIndexError(db, "ghost-doc", "whatsapp:+1", "boom");

    const deleted = deleteIndexBySource(db, "whatsapp:+1");
    expect(deleted).toBe(0);

    const statsRow = db
      .prepare<
        [string],
        { source_id: string }
      >("SELECT source_id FROM source_index_stats WHERE source_id = ?")
      .get("whatsapp:+1");
    expect(statsRow).toBeUndefined();

    const errorRow = db
      .prepare<
        [string],
        { document_id: string }
      >("SELECT document_id FROM indexing_errors WHERE source_id = ?")
      .get("whatsapp:+1");
    expect(errorRow).toBeUndefined();
  });
});

describe("counts", () => {
  test("getIndexedDocumentCount", () => {
    expect(getIndexedDocumentCount(db)).toBe(0);
    setIndexedDocument(db, "d1", "h1", 1);
    setIndexedDocument(db, "d2", "h2", 2);
    expect(getIndexedDocumentCount(db)).toBe(2);
  });

  test("getBuildableDocumentCount counts distinct document_id over chunks — the honest rebuild denominator (epic #1011)", () => {
    expect(getBuildableDocumentCount(db)).toBe(0);

    // Two documents, the first with two chunks: distinct documents = 2.
    upsertChunks(db, [
      {
        id: "c-1a",
        documentId: "doc-1",
        chunkIndex: 0,
        content: "a",
        embedding: makeEmbedding(1),
        sourceId: "s",
        title: "t",
        sourceCreatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "c-1b",
        documentId: "doc-1",
        chunkIndex: 1,
        content: "b",
        embedding: makeEmbedding(2),
        sourceId: "s",
        title: "t",
        sourceCreatedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "c-2",
        documentId: "doc-2",
        chunkIndex: 0,
        content: "c",
        embedding: makeEmbedding(3),
        sourceId: "s",
        title: "t",
        sourceCreatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(getBuildableDocumentCount(db)).toBe(2);

    // A document that is indexed but has NO chunk (e.g. empty content) inflates
    // getIndexedDocumentCount but NOT the buildable count — exactly why a build's
    // denominator must come from this function, so the migration percentage can
    // reach 100% rather than stalling on a document the build never embeds.
    setIndexedDocument(db, "doc-1", "h1", 2);
    setIndexedDocument(db, "doc-2", "h2", 1);
    setIndexedDocument(db, "doc-empty", "h3", 0);
    expect(getIndexedDocumentCount(db)).toBe(3);
    expect(getBuildableDocumentCount(db)).toBe(2);
  });
});

describe("indexing_errors", () => {
  test("records, counts per source, and clears on success", () => {
    expect(getIndexErrorCountsBySource(db)).toEqual({});

    recordIndexError(db, "doc-a", "gmail:a@b.com", "Input is longer than the context size");
    recordIndexError(db, "doc-b", "gmail:a@b.com", "timeout");
    recordIndexError(
      db,
      "doc-c",
      "browser-history:chrome",
      "Input is longer than the context size",
    );

    expect(getIndexErrorCountsBySource(db)).toEqual({
      "gmail:a@b.com": 2,
      "browser-history:chrome": 1,
    });

    clearIndexError(db, "doc-a");
    expect(getIndexErrorCountsBySource(db)).toEqual({
      "gmail:a@b.com": 1,
      "browser-history:chrome": 1,
    });
  });

  test("re-recording same doc bumps attempts and refreshes message", () => {
    recordIndexError(db, "doc-a", "gmail:a@b.com", "first");
    recordIndexError(db, "doc-a", "gmail:a@b.com", "second");
    const row = db
      .prepare<
        [string],
        { attempts: number; error: string }
      >("SELECT attempts, error FROM indexing_errors WHERE document_id = ?")
      .get("doc-a");
    expect(row?.attempts).toBe(2);
    expect(row?.error).toBe("second");
  });

  test("clearing a non-existent doc is a no-op", () => {
    expect(() => clearIndexError(db, "never-seen")).not.toThrow();
    expect(getIndexErrorCountsBySource(db)).toEqual({});
  });

  test("error counts exclude degraded rows; degraded stats sum truncated/dropped", () => {
    recordIndexError(db, "doc-err", "gmail:a@b.com", "timeout");
    recordIndexDegraded(db, "doc-trunc", "gmail:a@b.com", 2, 0);
    recordIndexDegraded(db, "doc-drop", "gmail:a@b.com", 1, 3);
    recordIndexDegraded(db, "doc-gd", "google-drive:x", 0, 1);

    // getIndexErrorCountsBySource counts only severity='error'.
    expect(getIndexErrorCountsBySource(db)).toEqual({ "gmail:a@b.com": 1 });

    expect(getDegradedStatsBySource(db)).toEqual({
      "gmail:a@b.com": { docs: 2, truncatedChunks: 3, droppedChunks: 3 },
      "google-drive:x": { docs: 1, truncatedChunks: 0, droppedChunks: 1 },
    });
  });

  test("recordIndexDegraded flips a prior error row to degraded", () => {
    recordIndexError(db, "doc-x", "gmail:a@b.com", "fetch failed");
    expect(getIndexErrorCountsBySource(db)).toEqual({ "gmail:a@b.com": 1 });

    recordIndexDegraded(db, "doc-x", "gmail:a@b.com", 1, 0);
    expect(getIndexErrorCountsBySource(db)).toEqual({}); // no longer an error
    expect(getDegradedStatsBySource(db)).toEqual({
      "gmail:a@b.com": { docs: 1, truncatedChunks: 1, droppedChunks: 0 },
    });
  });

  test("getErroredDocumentIds returns only severity='error' rows", () => {
    recordIndexError(db, "doc-a", "gmail:a@b.com", "timeout");
    recordIndexError(db, "doc-b", "gmail:a@b.com", "fetch failed");
    recordIndexDegraded(db, "doc-c", "gmail:a@b.com", 1, 1);

    expect(getErroredDocumentIds(db).sort()).toEqual(["doc-a", "doc-b"]);
  });
});

describe("wipeAndRecreateVectorIndex", () => {
  test("invalidates vectors and the watermark, keeping the document row", () => {
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "d1",
        chunkIndex: 0,
        content: "hello",
        embedding: makeEmbedding(1),
        sourceId: "gmail:a@b.com",
        title: "Test",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    setIndexedDocument(db, "d1", "h1", 1);
    setWatermark(db, "last_updated_at", "2026-03-10T00:00:00Z");

    expect(getChunkCount(db)).toBe(1);

    wipeAndRecreateVectorIndex(db, 1024);

    // Vectors are gone, but the chunk row (and so the BM25 lane) and the
    // indexed_documents row survive; the empty hash forces the rebuild
    // without turning maintenance into a source event.
    expect(getChunkCount(db)).toBe(1);
    expect(getIndexedDocumentCount(db)).toBe(1);
    expect(getIndexedDocument(db, "d1")).toMatchObject({
      content_hash: "",
      chunk_count: 1,
    });
    // Watermark wiped so the indexer re-scans from epoch.
    expect(getWatermark(db, "last_updated_at")).toBeNull();
  });

  test("rejects invalid dimensions", () => {
    expect(() => wipeAndRecreateVectorIndex(db, 0)).toThrow();
    expect(() => wipeAndRecreateVectorIndex(db, -1)).toThrow();
    expect(() => wipeAndRecreateVectorIndex(db, 1.5)).toThrow();
  });

  test("keeps the keyword lane alive: chunk text + FTS postings survive, vectors do not", () => {
    // The hard-cutover contract the CLI, the portal and this function's own
    // docstring all promise is "keyword-only search until the rebuild
    // finishes". `chunks_fts` is external-content over `chunks` and the BM25
    // query joins `chunks`, so wiping chunk ROWS would take BM25 down with the
    // vector lane. Only the derived `embedding` may go.
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "d1",
        chunkIndex: 0,
        content: "moonstone ledger reconciliation notes",
        embedding: makeEmbedding(7),
        sourceId: "notes:maya@example.com",
        title: "Moonstone ledger",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    setIndexedDocument(db, "d1", "h1", 1);
    expect(bm25Search(db, "moonstone", {}, 10).candidates).toHaveLength(1);

    wipeAndRecreateVectorIndex(db, EMBEDDING_DIM, "new-model");

    // BM25 still answers — the whole point of the "keyword-only" promise.
    const after = bm25Search(db, "moonstone", {}, 10).candidates;
    expect(after).toHaveLength(1);
    expect(after[0].documentId).toBe("d1");
    expect(getChunkCount(db)).toBe(1);

    // …but every vector is gone, so the usearch backfill (which reads
    // `chunks.embedding`) cannot resurrect old-model vectors when the new
    // model happens to share the old dimension.
    const withVectors = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NOT NULL")
      .get();
    expect(withVectors?.c).toBe(0);

    // The re-embed is still forced for every document.
    expect(getIndexedDocument(db, "d1")).toMatchObject({ content_hash: "" });
  });

  test("stamps the new (model, dim) when called with a model name", () => {
    wipeAndRecreateVectorIndex(db, 384, "minilm-test");
    expect(getIndexEmbedModel(db)).toEqual({ name: "minilm-test", dim: 384 });
  });

  test("updates the active index_versions row to the new (model, dim) and zeroes docs", () => {
    // Bug A: a dimension-changing wipe must keep the version registry
    // consistent with index_meta. Pre-fix it stamped index_meta but left the
    // active index_versions row claiming the OLD model/dim, so a later
    // boot-resume read a stale identity and mis-handled the index.
    setIndexEmbedModel(db, "old-model", 768);
    migrateAdoptInPlaceVersion(db); // adopt the existing index as active v1
    // Give the row non-zero progress so the wipe's reset to 0 is genuinely
    // exercised (the adopted row starts at 0).
    db.prepare("UPDATE index_versions SET docs_built = 5, docs_total = 7 WHERE version = 1").run();
    expect(getIndexVersion(db, 1)).toMatchObject({ embed_model: "old-model", embed_dim: 768 });

    wipeAndRecreateVectorIndex(db, 1024, "new-model");

    expect(getIndexVersion(db, 1)).toMatchObject({
      embed_model: "new-model",
      embed_dim: 1024,
      docs_built: 0,
      docs_total: 0,
    });
  });
});

describe("index_meta — embed model identity", () => {
  test("getIndexEmbedModel returns null on a fresh DB", () => {
    expect(getIndexEmbedModel(db)).toBeNull();
  });

  test("setIndexEmbedModel + getIndexEmbedModel round-trip", () => {
    setIndexEmbedModel(db, "nomic-embed-text-v1.5", 768);
    expect(getIndexEmbedModel(db)).toEqual({
      name: "nomic-embed-text-v1.5",
      dim: 768,
    });
    setIndexEmbedModel(db, "minilm", 384);
    expect(getIndexEmbedModel(db)).toEqual({ name: "minilm", dim: 384 });
  });
});

describe("upsertChunksAndMarkIndexed — atomic chunks + summary upsert", () => {
  test("inserts both chunks and the indexed_documents summary in one transaction", () => {
    upsertChunksAndMarkIndexed(db, "doc-1", "hash-a", [
      {
        id: "c1",
        documentId: "doc-1",
        chunkIndex: 0,
        content: "chunk-content",
        embedding: makeEmbedding(1),
        sourceId: "test",
        title: "doc",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);

    expect(getIndexedDocument(db, "doc-1")?.content_hash).toBe("hash-a");
    expect(getChunkCount(db)).toBe(1);
  });

  test("atomically writes chunks and indexed_documents summary", () => {
    upsertChunksAndMarkIndexed(db, "doc-1", "hash-a", [
      {
        id: "c1",
        documentId: "doc-1",
        chunkIndex: 0,
        content: "chunk-content",
        embedding: makeEmbedding(1),
        sourceId: "test",
        title: "doc",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);

    // Both the chunk and the indexed_documents summary are written atomically.
    expect(getChunkCount(db)).toBe(1);
    expect(getIndexedDocument(db, "doc-1")?.content_hash).toBe("hash-a");
    expect(getIndexedDocument(db, "doc-1")?.chunk_count).toBe(1);
  });
});

describe("chunks_fts tokenizer migration", () => {
  test("fresh DB is created with the porter+diacritic-folding tokenizer", () => {
    const ddl = db
      .prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'")
      .get();
    expect(ddl?.sql).toContain("porter");
    expect(ddl?.sql).toContain("remove_diacritics 2");
  });

  test("legacy bare-unicode61 DB is migrated on next open + FTS index is rebuilt", () => {
    const path = `/tmp/omnesis-fts-migration-${randomUUID()}.db`;

    // First open: standard DB so we get all schema, chunks, triggers, etc.
    const legacy = createIndexDatabase(path);
    // Force the FTS table back to the legacy shape (bare unicode61, no
    // porter / no diacritic folding), simulating an existing install.
    legacy.exec("DROP TABLE chunks_fts");
    legacy.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        title,
        content='chunks',
        content_rowid='rowid'
      )
    `);
    // Insert a chunk via upsertChunks so triggers populate chunks_fts.
    upsertChunks(legacy, [
      {
        id: "c1",
        documentId: "d1",
        chunkIndex: 0,
        content: "I love recipes",
        embedding: new Float32Array(EMBEDDING_DIM),
        sourceId: "gmail",
        title: "",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
      {
        id: "c2",
        documentId: "d2",
        chunkIndex: 0,
        content: "cérémonie laïque",
        embedding: new Float32Array(EMBEDDING_DIM),
        sourceId: "gmail",
        title: "",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    // Legacy tokenizer doesn't stem or fold — confirm baseline misses.
    const legacyStemHit = legacy
      .prepare<
        [string],
        { c: number }
      >("SELECT COUNT(*) AS c FROM chunks_fts WHERE chunks_fts MATCH ?")
      .get("recipe");
    expect(legacyStemHit?.c ?? 0).toBe(0);
    legacy.close();

    // Reopen — the migration in createIndexDatabase should detect the
    // legacy tokenizer, drop+recreate, and rebuild the FTS index from
    // the external `chunks` content table.
    const migrated = createIndexDatabase(path);
    const ddl = migrated
      .prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'")
      .get();
    expect(ddl?.sql).toContain("porter");
    expect(ddl?.sql).toContain("remove_diacritics 2");

    // Same query that missed under the legacy tokenizer now matches.
    const stemHit = migrated
      .prepare<
        [string],
        { c: number }
      >("SELECT COUNT(*) AS c FROM chunks_fts WHERE chunks_fts MATCH ?")
      .get("recipe");
    expect(stemHit?.c ?? 0).toBeGreaterThanOrEqual(1);

    const accentHit = migrated
      .prepare<
        [string],
        { c: number }
      >("SELECT COUNT(*) AS c FROM chunks_fts WHERE chunks_fts MATCH ?")
      .get("ceremonie");
    expect(accentHit?.c ?? 0).toBeGreaterThanOrEqual(1);

    migrated.close();

    // Third open: migration is idempotent — DDL already includes
    // `porter`, the rebuild branch must not fire.
    const reopened = createIndexDatabase(path);
    const ddl2 = reopened
      .prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'")
      .get();
    expect(ddl2?.sql).toContain("porter");
    reopened.close();
  });

  test("rebuilds FTS when a restored database contains chunks but no shadow index", () => {
    const path = `/tmp/omnesis-fts-restored-${randomUUID()}.db`;
    const restored = createIndexDatabase(path);
    upsertChunks(restored, [
      {
        id: "fictional-restored#0",
        documentId: "fictional-restored",
        chunkIndex: 0,
        content: "Northstar workshop recipes",
        embedding: new Float32Array(EMBEDDING_DIM),
        sourceId: "test-source",
        title: "Workshop notes",
        sourceCreatedAt: "2026-08-24T00:00:00Z",
      },
    ]);
    restored.exec("DROP TABLE chunks_fts");
    restored.close();

    const reopened = createIndexDatabase(path);
    const hit = reopened
      .prepare<
        [string],
        { c: number }
      >("SELECT COUNT(*) AS c FROM chunks_fts WHERE chunks_fts MATCH ?")
      .get("recipe");
    expect(hit?.c).toBe(1);
    reopened.close();
  });
});

/** Minimal chunk-upsert input with a deterministic embedding. */
function makeChunk(
  documentId: string,
  chunkIndex: number,
  overrides: Partial<ChunkUpsertInput> = {},
): ChunkUpsertInput {
  return {
    id: `${documentId}#${chunkIndex}`,
    documentId,
    chunkIndex,
    content: `content ${documentId} ${chunkIndex}`,
    embedding: makeEmbedding(chunkIndex + 1),
    sourceId: "test-source",
    title: `Doc ${documentId}`,
    sourceCreatedAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

describe("dual-index write — usearch stays in sync with chunks", () => {
  let usearchDir: string;
  let usearch: UsearchWriteHandle;

  beforeEach(() => {
    usearchDir = mkdtempSync(join(tmpdir(), "omnesis-dual-index-"));
    usearch = new UsearchWriteHandle(join(usearchDir, "v.usearch"), EMBEDDING_DIM);
  });

  afterEach(() => {
    rmSync(usearchDir, { recursive: true, force: true });
  });

  test("insert adds one vector per chunk; update replaces them; delete removes them", () => {
    // Insert: a fresh 2-chunk doc.
    upsertChunksAndMarkIndexedBatch(
      db,
      [
        {
          documentId: "doc-1",
          contentHash: "hash-v1",
          chunks: [makeChunk("doc-1", 0), makeChunk("doc-1", 1)],
          isUpdate: false,
        },
      ],
      { usearch },
    );
    expect(getChunkCount(db)).toBe(2);
    // One HNSW vector per chunk — the dual write fired through the handle.
    expect(usearch.size()).toBe(2);

    // The vector for chunk 0 is keyed by the chunk's SQLite rowid and is
    // findable by nearest-neighbour search on its own embedding.
    const rowid0 = db
      .prepare<
        [string, number],
        { rowid: number }
      >("SELECT rowid FROM chunks WHERE document_id = ? AND chunk_index = ?")
      .get("doc-1", 0)!.rowid;
    usearch.save();
    {
      const reader = UsearchReadHandle.open(join(usearchDir, "v.usearch"), EMBEDDING_DIM)!;
      const hit = reader.search(makeEmbedding(1), 1)[0];
      expect(hit.key).toBe(BigInt(rowid0));
      reader.close();
    }

    // Update: re-index the same doc with a single chunk. The old two
    // vectors are removed before the new one is added, so the index
    // shrinks to exactly one vector — no orphans accumulate.
    upsertChunksAndMarkIndexedBatch(
      db,
      [
        {
          documentId: "doc-1",
          contentHash: "hash-v2",
          chunks: [makeChunk("doc-1", 0, { content: "rewritten", embedding: makeEmbedding(99) })],
          isUpdate: true,
        },
      ],
      { usearch },
    );
    expect(getChunkCount(db)).toBe(1);
    expect(usearch.size()).toBe(1);

    // Delete: the doc's remaining vector is removed from the index.
    const removed = deleteChunksByDocument(db, "doc-1", { usearch });
    expect(removed).toBe(1);
    expect(getChunkCount(db)).toBe(0);
    expect(usearch.size()).toBe(0);
  });

  test("upsertChunks (no mark) also dual-writes into the HNSW index", () => {
    upsertChunks(db, [makeChunk("doc-x", 0), makeChunk("doc-x", 1), makeChunk("doc-x", 2)], {
      usearch,
    });
    expect(getChunkCount(db)).toBe(3);
    expect(usearch.size()).toBe(3);
  });
});

describe("index_totals integrity — floor and delta", () => {
  test("a delete whose negative delta exceeds the stale totals row floors at zero", () => {
    // Write the chunks + indexed_documents directly so the materialized
    // index_totals row stays BEHIND the live tables — the delete→insert
    // race shape, where a delete carries a larger negative delta than the
    // totals row currently holds.
    upsertChunks(db, [makeChunk("doc-1", 0), makeChunk("doc-1", 1), makeChunk("doc-1", 2)]);
    setIndexedDocument(db, "doc-1", "hash-a", 3);
    // Seed the totals row low: only 1 chunk / 1 doc recorded, while 3 chunks
    // are actually live (e.g. a concurrent insert hadn't been counted yet).
    db.prepare(
      "INSERT INTO index_totals (id, total_indexed, total_chunks, last_computed_at) VALUES (1, 1, 1, ?)",
    ).run(new Date().toISOString());
    expect(getChunkCount(db)).toBe(1); // reads the (stale-low) materialized row
    expect(getIndexedDocumentCount(db)).toBe(1);

    // Deleting the doc applies -3 chunks / -1 doc against a row holding 1/1.
    // Without the MAX(0, …) floor this wraps to total_chunks = -2; with it,
    // the counters clamp at zero.
    const removed = deleteChunksByDocument(db, "doc-1");
    expect(removed).toBe(3); // all three live chunks were deleted
    expect(getChunkCount(db)).toBe(0);
    expect(getIndexedDocumentCount(db)).toBe(0);

    // Read the raw row to prove it clamped at zero rather than going negative.
    const row = db
      .prepare<
        [],
        { total_indexed: number; total_chunks: number }
      >("SELECT total_indexed, total_chunks FROM index_totals WHERE id = 1")
      .get();
    expect(row).toEqual({ total_indexed: 0, total_chunks: 0 });
  });

  test("re-indexing with fewer chunks decrements total_chunks by the delta, not the new count", () => {
    // Index a 3-chunk doc, then seed index_totals from the live tables.
    upsertChunksAndMarkIndexed(db, "doc-1", "hash-a", [
      makeChunk("doc-1", 0),
      makeChunk("doc-1", 1),
      makeChunk("doc-1", 2),
    ]);
    refreshIndexStats(db);
    expect(getChunkCount(db)).toBe(3);
    expect(getIndexedDocumentCount(db)).toBe(1);

    // Re-index the same doc with only 1 chunk (isUpdate). The chunk delta
    // is new(1) - old(3) = -2, so totals go 3 → 1, NOT 3 → 1-via-overwrite
    // or 3 → 4. The indexed-doc count is unchanged (still 1 doc).
    upsertChunksAndMarkIndexedBatch(db, [
      {
        documentId: "doc-1",
        contentHash: "hash-b",
        chunks: [makeChunk("doc-1", 0, { content: "smaller" })],
        isUpdate: true,
      },
    ]);

    expect(getChunkCount(db)).toBe(1);
    expect(getIndexedDocumentCount(db)).toBe(1);
    // Per-source materialized stats track the same delta.
    expect(getIndexStatsBySource(db)["test-source"]).toEqual({ indexedDocs: 1, chunks: 1 });
  });

  test("re-indexing with more chunks increments total_chunks by the positive delta", () => {
    upsertChunksAndMarkIndexed(db, "doc-1", "hash-a", [makeChunk("doc-1", 0)]);
    refreshIndexStats(db);
    expect(getChunkCount(db)).toBe(1);

    upsertChunksAndMarkIndexedBatch(db, [
      {
        documentId: "doc-1",
        contentHash: "hash-b",
        chunks: [makeChunk("doc-1", 0), makeChunk("doc-1", 1), makeChunk("doc-1", 2)],
        isUpdate: true,
      },
    ]);

    // delta = 3 - 1 = +2 → totals 1 → 3, doc count still 1.
    expect(getChunkCount(db)).toBe(3);
    expect(getIndexedDocumentCount(db)).toBe(1);
  });
});
