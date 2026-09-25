// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createDatabase, upsertDocuments } from "../db.js";
import {
  SourceUrlRecanonicalizationService,
  applySourceUrlRecanonicalizationPage,
  finishSourceUrlRecanonicalization,
  planSourceUrlRecanonicalization,
} from "../domain/SourceUrlRecanonicalization.js";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  getChunkCount,
  getChunkSourceUrls,
  getIndexedDocument,
  getIndexedDocumentCount,
  getIndexErrorCountsBySource,
  getDegradedStatsBySource,
  getIndexStatsBySource,
  refreshIndexStats,
  getWatermark,
  recordIndexError,
} from "./db.js";
import { Indexer } from "./indexer.js";
import { DocumentChunker } from "./chunker.js";
import type { UrlCanonicalizerSpec } from "@omnesis/core";
import type { DocumentSource, Embedder, IndexableDocument } from "./types.js";
import type { DocumentInput } from "@omnesis/types";
import type Database from "better-sqlite3";
type Db = Database.Database;

// Mock embedder that returns deterministic vectors, with optional failure injection
class MockEmbedder implements Embedder {
  embedCount = 0;
  /** Set of doc content strings that should cause embed to throw */
  failOn = new Set<string>();

  async embed(texts: string[]): Promise<Float32Array[]> {
    for (const text of texts) {
      for (const fail of this.failOn) {
        if (text.includes(fail)) {
          throw new Error(`Embedding failed for text containing "${fail}"`);
        }
      }
    }
    this.embedCount += texts.length;
    return texts.map(() => {
      const v = new Float32Array(EMBEDDING_DIM);
      v[0] = 1;
      return v;
    });
  }

  async embedQuery(query: string): Promise<Float32Array> {
    const v = new Float32Array(EMBEDDING_DIM);
    v[0] = 1;
    return v;
  }

  async dispose() {}
}

/**
 * Embedder whose per-input outcome is decided by the input string, throwing
 * errors that the classifier recognises as deterministic (overflow / malformed)
 * so the resilient orchestrator's shrink/drop path can be exercised. Mirrors
 * the HTTP backend: any failing input fails the whole batch.
 */
class KindEmbedder implements Embedder {
  constructor(private readonly decide: (text: string) => "ok" | "overflow" | "malformed") {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    for (const t of texts) {
      const d = this.decide(t);
      if (d === "overflow") throw new Error("maximum context length is 2048 tokens");
      if (d === "malformed") throw new Error("TextEncodeInput must be Union[...]");
    }
    return texts.map(() => {
      const v = new Float32Array(EMBEDDING_DIM);
      v[0] = 1;
      return v;
    });
  }
  async embedQuery(): Promise<Float32Array> {
    const v = new Float32Array(EMBEDDING_DIM);
    v[0] = 1;
    return v;
  }
  async dispose(): Promise<void> {}
}

// Mock document source
class MockSource implements DocumentSource {
  documents: IndexableDocument[] = [];
  allIds: string[] = [];
  /** Counters used to assert call shape — e.g. retryFailed should call
   *  `getByIds` once total, not once per failed doc. */
  listUpdatedCalls = 0;
  listUpdatedLightweightCalls = 0;
  getByIdsCalls = 0;
  /** Ids per `getByIds` call — every fetch of full document CONTENT is paged. */
  getByIdsBatchSizes: number[] = [];

  async listUpdated(since: string | null, limit: number, afterId?: string) {
    this.listUpdatedCalls += 1;
    let docs = this.documents;
    if (since) {
      docs = docs.filter((d) => d.updatedAt > since);
    }
    if (afterId) {
      const idx = docs.findIndex((d) => d.id === afterId);
      docs = idx >= 0 ? docs.slice(idx + 1) : docs;
    }
    const page = docs.slice(0, limit);
    return {
      documents: page,
      hasMore: docs.length > limit,
    };
  }

  async listUpdatedLightweight(since: string | null, limit: number, afterId?: string) {
    this.listUpdatedLightweightCalls += 1;
    let docs = this.documents;
    if (since) {
      docs = docs.filter((d) => d.updatedAt > since);
    }
    if (afterId) {
      const idx = docs.findIndex((d) => d.id === afterId);
      docs = idx >= 0 ? docs.slice(idx + 1) : docs;
    }
    const page = docs.slice(0, limit);
    return {
      documents: page.map((d) => ({
        id: d.id,
        sourceId: d.sourceId,
        contentHash: d.contentHash,
        sourceUrl: d.metadata.sourceUrl ?? null,
        sourceCreatedAt: d.metadata.sourceCreatedAt,
        updatedAt: d.updatedAt,
        documentType: d.metadata.documentType ?? null,
      })),
      hasMore: docs.length > limit,
    };
  }

  async listAllIds() {
    return this.allIds;
  }

  async getByIds(ids: string[]) {
    this.getByIdsCalls += 1;
    this.getByIdsBatchSizes.push(ids.length);
    const ix = new Map(this.documents.map((d) => [d.id, d]));
    return ids.map((id) => ix.get(id)).filter((d): d is IndexableDocument => !!d);
  }

  async hasDocuments(sourceId: string) {
    return this.documents.some((d) => d.sourceId === sourceId);
  }

  async getSourceIdsByIds(ids: string[]) {
    const ix = new Map(this.documents.map((d) => [d.id, d.sourceId]));
    const out = new Map<string, string>();
    for (const id of ids) {
      const s = ix.get(id);
      if (s !== undefined) out.set(id, s);
    }
    return out;
  }
}

let db: Db;
let source: MockSource;
let embedder: MockEmbedder;
let indexer: Indexer;

beforeEach(() => {
  db = createIndexDatabase(`/tmp/omnesis-indexer-test-${randomUUID()}.db`);
  source = new MockSource();
  embedder = new MockEmbedder();
  indexer = new Indexer(db, source, new DocumentChunker(), embedder);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

function makeDoc(id: string, content = "Hello world"): IndexableDocument {
  return {
    id,
    title: `Doc ${id}`,
    content,
    contentHash: `hash-${id}-${content.length}`,
    sourceId: "test-source",
    metadata: {
      documentType: "note",
      sourceCreatedAt: "2026-03-10T00:00:00Z",
    },
    updatedAt: "2026-03-10T00:00:00Z",
  };
}

describe("Indexer", () => {
  test("drops documents deleted while their page was embedding", async () => {
    // The HTTP delete cascade (privacy delete, sync tombstone, stream wipe)
    // writes `index.db` from the main thread while this worker is mid-page.
    // The page was read before the delete and is written after it, so without
    // a re-check the deleted document's title + full chunk text land back in
    // `chunks` and stay searchable until the hourly deletion reconcile.
    source.documents = [makeDoc("keep-1"), makeDoc("gone-1", "Ephemeral note by Maya Reeves")];
    const vanish = new (class extends MockEmbedder {
      async embed(texts: string[]): Promise<Float32Array[]> {
        const out = await super.embed(texts);
        // The delete lands here — after the read, before the write.
        source.documents = source.documents.filter((d) => d.id !== "gone-1");
        return out;
      }
    })();
    indexer = new Indexer(db, source, new DocumentChunker(), vanish);

    const result = await indexer.indexUpdated();

    expect(getIndexedDocument(db, "gone-1")).toBeNull();
    expect(
      db
        .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE document_id = ?")
        .get("gone-1")?.c,
    ).toBe(0);
    // The surviving document of the same page is still indexed.
    expect(getIndexedDocument(db, "keep-1")).not.toBeNull();
    expect(result.indexed).toBe(1);
  });

  test("indexes new documents", async () => {
    source.documents = [makeDoc("d1"), makeDoc("d2")];

    const result = await indexer.indexUpdated();

    expect(result.indexed).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(getChunkCount(db)).toBe(2); // short docs = 1 chunk each
    expect(embedder.embedCount).toBe(2);
  });

  test("skips unchanged documents on second run", async () => {
    source.documents = [makeDoc("d1")];

    await indexer.indexUpdated();
    embedder.embedCount = 0;

    // Second run with same watermark won't re-fetch (watermark advanced)
    // But if we reset the watermark, it will find the doc and skip
    const result = await indexer.indexUpdated();

    expect(result.indexed).toBe(0);
    expect(result.skipped).toBe(0); // No docs returned since watermark advanced
  });

  test("re-indexes updated documents", async () => {
    source.documents = [makeDoc("d1", "original content")];
    await indexer.indexUpdated();

    // Update the document with new content (different hash)
    source.documents = [makeDoc("d1", "updated content")];
    // The updatedAt must be > watermark for the doc to be returned
    source.documents[0].updatedAt = "2026-03-10T01:00:00Z";

    const result = await indexer.indexUpdated();

    expect(result.updated).toBe(1);
    expect(result.indexed).toBe(0);
  });

  test("reconciles deleted documents", async () => {
    source.documents = [makeDoc("d1"), makeDoc("d2")];
    await indexer.indexUpdated();
    expect(getChunkCount(db)).toBe(2);

    // d2 no longer exists in gateway
    source.allIds = ["d1"];
    const deleted = await indexer.reconcileDeletedDocuments();

    expect(deleted).toBe(1);
    expect(getChunkCount(db)).toBe(1);
    expect(getIndexedDocument(db, "d2")).toBeNull();
    expect(getIndexedDocument(db, "d1")).not.toBeNull();
  });

  test("advances watermark", async () => {
    source.documents = [
      { ...makeDoc("d1"), updatedAt: "2026-03-10T01:00:00Z" },
      { ...makeDoc("d2"), updatedAt: "2026-03-10T02:00:00Z" },
    ];
    await indexer.indexUpdated();

    expect(getWatermark(db, "last_updated_at")).toBe("2026-03-10T02:00:00Z");
  });

  test("getStats returns document and chunk counts", async () => {
    source.documents = [makeDoc("d1"), makeDoc("d2")];
    await indexer.indexUpdated();

    const stats = indexer.getStats();
    expect(stats.documents).toBe(2);
    expect(stats.chunks).toBe(2);
  });

  test("returns errors count", async () => {
    embedder.failOn.add("fail content");
    source.documents = [makeDoc("d1", "good content"), makeDoc("d2", "fail content")];

    const result = await indexer.indexUpdated();

    expect(result.indexed).toBe(1);
    expect(result.errors).toBe(1);
  });

  test("watermark does not advance past failed documents", async () => {
    embedder.failOn.add("fail content");
    source.documents = [
      { ...makeDoc("d1", "good content"), updatedAt: "2026-03-10T01:00:00Z" },
      { ...makeDoc("d2", "fail content"), updatedAt: "2026-03-10T02:00:00Z" },
      { ...makeDoc("d3", "also good"), updatedAt: "2026-03-10T03:00:00Z" },
    ];

    await indexer.indexUpdated();

    // Watermark should advance to d3 (03:00) because d1 and d3 succeeded.
    // d2 failed but d3 (later) succeeded, so watermark goes to d3.
    // This is fine — the key fix is that d2 is tracked for retry.
    const wm = getWatermark(db, "last_updated_at");
    expect(wm).toBe("2026-03-10T03:00:00Z");

    // But d2 should NOT be in indexed_documents
    expect(getIndexedDocument(db, "d2")).toBeNull();
    // d1 and d3 should be indexed
    expect(getIndexedDocument(db, "d1")).not.toBeNull();
    expect(getIndexedDocument(db, "d3")).not.toBeNull();
  });

  test("watermark does not advance when ALL docs fail", async () => {
    embedder.failOn.add("fail");
    source.documents = [
      { ...makeDoc("d1", "fail A"), updatedAt: "2026-03-10T01:00:00Z" },
      { ...makeDoc("d2", "fail B"), updatedAt: "2026-03-10T02:00:00Z" },
    ];

    await indexer.indexUpdated();

    // Watermark should NOT advance since no docs succeeded
    const wm = getWatermark(db, "last_updated_at");
    expect(wm).toBeNull();
    expect(getChunkCount(db)).toBe(0);
  });

  test("failed documents are retried on next cycle", async () => {
    // First cycle: d2 fails
    embedder.failOn.add("transient fail");
    source.documents = [
      { ...makeDoc("d1", "good content"), updatedAt: "2026-03-10T01:00:00Z" },
      { ...makeDoc("d2", "transient fail"), updatedAt: "2026-03-10T02:00:00Z" },
    ];

    const result1 = await indexer.indexUpdated();
    expect(result1.indexed).toBe(1);
    expect(result1.errors).toBe(1);
    expect(getIndexedDocument(db, "d2")).toBeNull();

    // Second cycle: fix the embedder, d2 should be retried
    embedder.failOn.clear();
    // Source still has both docs (listUpdated returns docs with updatedAt > watermark)
    // But d2's updatedAt is 02:00 and watermark is now 01:00 (only d1 succeeded)
    // So d2 will be re-fetched AND retried from the failed set
    source.documents = [
      { ...makeDoc("d1", "good content"), updatedAt: "2026-03-10T01:00:00Z" },
      { ...makeDoc("d2", "transient fail"), updatedAt: "2026-03-10T02:00:00Z" },
    ];

    const result2 = await indexer.indexUpdated();
    // d2 should now be indexed (either via normal fetch or retry)
    expect(getIndexedDocument(db, "d2")).not.toBeNull();
    expect(getChunkCount(db)).toBe(2);
  });

  test("reindexMissing finds and indexes gap documents", async () => {
    // Index d1 normally
    source.documents = [makeDoc("d1", "doc one")];
    source.allIds = ["d1", "d2", "d3"];
    await indexer.indexUpdated();

    expect(getChunkCount(db)).toBe(1);
    expect(getIndexedDocument(db, "d1")).not.toBeNull();
    expect(getIndexedDocument(db, "d2")).toBeNull();

    // Now add d2 and d3 to the source (simulating the gap)
    source.documents = [
      makeDoc("d1", "doc one"),
      makeDoc("d2", "doc two"),
      makeDoc("d3", "doc three"),
    ];

    const result = await indexer.reindexMissing();
    expect(result.indexed).toBe(2);
    expect(result.errors).toBe(0);
    expect(getChunkCount(db)).toBe(3);
    expect(getIndexedDocument(db, "d2")).not.toBeNull();
    expect(getIndexedDocument(db, "d3")).not.toBeNull();
  });

  test("reindexMissing skips docs older than cutoff", async () => {
    const cutoffIndexer = new Indexer(db, source, new DocumentChunker(), embedder, {
      dataCutoff: "2026-01-01T00:00:00Z",
    });

    source.documents = [
      {
        ...makeDoc("d-old", "old doc"),
        metadata: { ...makeDoc("d-old").metadata, sourceCreatedAt: "2025-06-01T00:00:00Z" },
        updatedAt: "2026-03-10T01:00:00Z",
      },
    ];
    source.allIds = ["d-old"];

    const result = await cutoffIndexer.reindexMissing();
    expect(result.indexed).toBe(0);
    expect(getIndexedDocument(db, "d-old")).toBeNull();
  });

  test("indexes pre-cutoff contacts, which ingest deliberately keeps", async () => {
    // `DocumentService.applyMaxAgeCutoff` exempts contacts from the retention
    // cutoff — "they stay relevant indefinitely" — so an old contact IS in
    // `documents`. Applying the cutoff again here would leave it retained and
    // permanently unsearchable, with `/index/stats` still reading 100%.
    const cutoffIndexer = new Indexer(db, source, new DocumentChunker(), embedder, {
      dataCutoff: "2026-01-01T00:00:00Z",
    });
    const old = (id: string, documentType: string): IndexableDocument => ({
      ...makeDoc(id, `content ${id}`),
      metadata: { documentType, sourceCreatedAt: "2019-06-01T00:00:00Z" },
      updatedAt: "2026-03-10T01:00:00Z",
    });
    source.documents = [old("maya-reeves", "contact"), old("stale-note", "note")];
    source.allIds = source.documents.map((d) => d.id);

    const cycle = await cutoffIndexer.indexUpdated();
    expect(cycle.indexed).toBe(1);
    expect(cycle.skipped).toBe(1);
    expect(getIndexedDocument(db, "maya-reeves")).not.toBeNull();
    expect(getIndexedDocument(db, "stale-note")).toBeNull();

    // The reindexMissing backstop honours the same exemption, so a contact
    // the main scan missed is not stranded there either.
    const missing = await cutoffIndexer.reindexMissing();
    expect(missing.indexed).toBe(0);
    expect(missing.errors).toBe(0);
  });

  test("records indexing_errors per source on failure, clears on retry success", async () => {
    // Source with two docs under the same sourceId. One will fail embedding.
    const mkDoc = (id: string, content: string): IndexableDocument => ({
      id,
      title: `Doc ${id}`,
      content,
      contentHash: `hash-${id}-${content.length}`,
      sourceId: "gmail:a@b.com",
      metadata: { documentType: "email", sourceCreatedAt: "2026-03-10T00:00:00Z" },
      updatedAt: `2026-03-10T01:0${id.slice(-1)}:00Z`,
    });

    embedder.failOn.add("boom");
    source.documents = [mkDoc("a", "ok content"), mkDoc("b", "boom content")];

    await indexer.indexUpdated();

    expect(getIndexErrorCountsBySource(db)).toEqual({ "gmail:a@b.com": 1 });
    expect(getIndexedDocument(db, "b")).toBeNull();

    // Fix the embedder and re-run — the failed doc is still in the in-memory
    // retry set so it gets picked up; the error row should clear.
    embedder.failOn.clear();
    await indexer.indexUpdated();

    expect(getIndexedDocument(db, "b")).not.toBeNull();
    expect(getIndexErrorCountsBySource(db)).toEqual({});
  });

  test("reindexMissing returns zero when no gaps exist", async () => {
    source.documents = [makeDoc("d1"), makeDoc("d2")];
    source.allIds = ["d1", "d2"];
    await indexer.indexUpdated();

    const result = await indexer.reindexMissing();
    expect(result.indexed).toBe(0);
    expect(result.errors).toBe(0);
  });

  test("stop() interrupts indexUpdated between documents", async () => {
    // Slow embedder so we can call stop() mid-cycle.
    class SlowEmbedder implements Embedder {
      embedCount = 0;
      async embed(texts: string[]): Promise<Float32Array[]> {
        await new Promise((r) => setTimeout(r, 20));
        this.embedCount += texts.length;
        return texts.map(() => {
          const v = new Float32Array(EMBEDDING_DIM);
          v[0] = 1;
          return v;
        });
      }
      async embedQuery() {
        return new Float32Array(EMBEDDING_DIM);
      }
      async dispose() {}
    }

    const slow = new SlowEmbedder();
    const stopIndexer = new Indexer(db, source, new DocumentChunker(), slow);

    // Many pages worth of documents.
    source.documents = Array.from({ length: 500 }, (_, i) => makeDoc(`d${i}`, `content ${i}`));

    const runPromise = stopIndexer.indexUpdated();

    // Let a couple of docs process, then request stop.
    await new Promise((r) => setTimeout(r, 50));
    stopIndexer.stop();

    const result = await runPromise;
    // Should have stopped well before all 500 docs.
    expect(result.indexed).toBeLessThan(500);
    // No exception was thrown.
    expect(result.errors).toBe(0);

    // A subsequent call bails immediately (stop is terminal).
    const again = await stopIndexer.indexUpdated();
    expect(again.indexed).toBe(0);
    expect(again.updated).toBe(0);
    expect(again.errors).toBe(0);
  });

  test("retryFailed batches the source fetch — one getByIds call regardless of failure count", async () => {
    // Seed 5 docs and make the embedder fail on 3 specific ones, so
    // the cycle records them in failedDocIds. Then unblock the embedder
    // and run another cycle to trigger retryFailed.
    source.documents = Array.from({ length: 5 }, (_, i) => makeDoc(`r${i}`, `content r${i}`));
    embedder.failOn = new Set(["content r0", "content r2", "content r4"]);

    const first = await indexer.indexUpdated();
    expect(first.errors).toBe(3);

    // Unblock and re-run: retryFailed should pick up the three failed
    // docs in one batched getByIds call.
    embedder.failOn = new Set();
    const beforeListCalls = source.listUpdatedCalls;
    const beforeBatchCalls = source.getByIdsCalls;
    const second = await indexer.indexUpdated();
    expect(second.indexed).toBe(3);
    expect(second.errors).toBe(0);
    // Exactly one getByIds for the retry, regardless of failure count.
    expect(source.getByIdsCalls - beforeBatchCalls).toBe(1);
    // listUpdated still drives the regular cycle but is NOT used by
    // retryFailed any more (the old O(N×M) shape called it once per
    // failure).
    expect(source.listUpdatedCalls - beforeListCalls).toBeLessThan(3 + 5);
  });

  test("a document that fails the retry twice stays in the fast retry set", async () => {
    // The failed set is the only fast path back for a document the page scan
    // has already moved past: once the watermark is beyond it, nothing but
    // the hourly `reindexMissing` backstop will look at it again. A second
    // consecutive transient embed failure must therefore not drop it.
    const stale = { ...makeDoc("flaky", "flaky content"), updatedAt: "2026-03-10T00:00:00Z" };
    const fresh = { ...makeDoc("solid", "solid content"), updatedAt: "2026-03-11T00:00:00Z" };
    source.documents = [stale, fresh];
    embedder.failOn = new Set(["flaky content"]);

    // Cycle 1: "flaky" fails, "solid" succeeds and carries the watermark past
    // "flaky", so the page scan will never offer it again.
    const first = await indexer.indexUpdated();
    expect(first.errors).toBe(1);
    expect(getWatermark(db, "last_updated_at")).toBe("2026-03-11T00:00:00Z");

    // Cycle 2: the page scan is empty; the retry runs and fails again.
    const second = await indexer.indexUpdated();
    expect(second.errors).toBe(1);
    expect(second.indexed).toBe(0);

    // Cycle 3: the embedder is healthy again. Only the retry set can reach
    // "flaky" now.
    embedder.failOn = new Set();
    const third = await indexer.indexUpdated();
    expect(third.indexed).toBe(1);
    expect(getIndexedDocument(db, "flaky")).not.toBeNull();
  });

  test("pages the failed-document and errored-document content fetches", async () => {
    // `getByIds` materialises full document CONTENT. An embedder outage across
    // a backlog puts every failed document in the retry set, so an unpaged
    // fetch there is an O(corpus) allocation in the indexer worker's heap —
    // exactly the shape every other fetch in the cycle avoids.
    const paged = new Indexer(db, source, new DocumentChunker(), embedder, { pageSize: 2 });
    source.documents = Array.from({ length: 7 }, (_, i) => makeDoc(`p${i}`, `content p${i}`));
    embedder.failOn = new Set(source.documents.map((d) => d.content));

    const first = await paged.indexUpdated();
    expect(first.errors).toBe(7);

    // Cycle 2 runs the retry over all seven, still failing, and then the
    // persistent-error reconcile over the same seven.
    source.getByIdsBatchSizes = [];
    await paged.indexUpdated();
    await paged.reindexMissing();

    expect(source.getByIdsBatchSizes.length).toBeGreaterThan(0);
    expect(Math.max(...source.getByIdsBatchSizes)).toBeLessThanOrEqual(2);
  });

  test("drops an unembeddable chunk but still indexes the document (degraded)", async () => {
    // Two chunks: the second contains POISON and is rejected as malformed.
    const content = "A".repeat(3000) + "POISON" + "B".repeat(100);
    const failEmbedder = new KindEmbedder((t) => (t.includes("POISON") ? "malformed" : "ok"));
    const idx = new Indexer(db, source, new DocumentChunker(), failEmbedder);
    source.documents = [makeDoc("d1", content)];

    const result = await idx.indexUpdated();

    expect(result.indexed).toBe(1);
    expect(getIndexedDocument(db, "d1")).not.toBeNull();
    expect(getIndexedDocumentCount(db)).toBe(1);
    expect(getChunkCount(db)).toBe(1); // the clean chunk survived
    // Surfaced as degraded, not a hard error.
    expect(getIndexErrorCountsBySource(db)).toEqual({});
    const degraded = getDegradedStatsBySource(db);
    expect(degraded["test-source"].docs).toBe(1);
    expect(degraded["test-source"].droppedChunks).toBe(1);
  });

  test("shrinks an overflowing chunk to fit rather than failing the document", async () => {
    const content = "X".repeat(2000); // single chunk, embedding input overflows at first
    const failEmbedder = new KindEmbedder((t) => (t.length > 1000 ? "overflow" : "ok"));
    const idx = new Indexer(db, source, new DocumentChunker(), failEmbedder);
    source.documents = [makeDoc("d1", content)];

    const result = await idx.indexUpdated();

    expect(result.indexed).toBe(1);
    expect(getChunkCount(db)).toBe(1); // chunk kept (truncated embedding)
    expect(getIndexErrorCountsBySource(db)).toEqual({});
    const degraded = getDegradedStatsBySource(db);
    expect(degraded["test-source"].docs).toBe(1);
    expect(degraded["test-source"].truncatedChunks).toBe(1);
    expect(degraded["test-source"].droppedChunks).toBe(0);
  });

  test("marks a document terminal even when every chunk is unembeddable", async () => {
    const content = "POISON ".repeat(400); // both windows contain POISON
    const failEmbedder = new KindEmbedder((t) => (t.includes("POISON") ? "malformed" : "ok"));
    const idx = new Indexer(db, source, new DocumentChunker(), failEmbedder);
    source.documents = [makeDoc("d1", content)];

    const result = await idx.indexUpdated();

    // The doc reaches a terminal indexed state with zero chunks — counts toward
    // 100% and isn't reprocessed — rather than failing forever.
    expect(result.indexed).toBe(1);
    expect(getIndexedDocument(db, "d1")).not.toBeNull();
    expect(getIndexedDocumentCount(db)).toBe(1);
    expect(getChunkCount(db)).toBe(0);
    expect(getIndexErrorCountsBySource(db)).toEqual({});
    expect(getDegradedStatsBySource(db)["test-source"].droppedChunks).toBeGreaterThanOrEqual(1);
  });

  test("reindexMissing clears a stale error row for an already-indexed doc", async () => {
    source.documents = [makeDoc("d1")];
    source.allIds = ["d1"];
    await indexer.indexUpdated(); // d1 fully indexed, hash current
    // A transient error recorded in a prior session whose retry was lost.
    recordIndexError(db, "d1", "test-source", "fetch failed");
    expect(getIndexErrorCountsBySource(db)).toEqual({ "test-source": 1 });

    await indexer.reindexMissing();

    // The index is current, so the stale error row is cleared — no phantom fail.
    expect(getIndexErrorCountsBySource(db)).toEqual({});
    expect(getIndexedDocument(db, "d1")).not.toBeNull();
  });

  test("reindexMissing retries an errored doc whose content has since changed", async () => {
    source.documents = [makeDoc("d1", "orig")];
    source.allIds = ["d1"];
    await indexer.indexUpdated(); // indexed at "orig"

    // Content changed but a prior transient failure left it stale + errored.
    source.documents = [makeDoc("d1", "updated longer content")];
    recordIndexError(db, "d1", "test-source", "fetch failed");

    await indexer.reindexMissing();

    // Re-attempted successfully against current content; error cleared.
    expect(getIndexErrorCountsBySource(db)).toEqual({});
    expect(getIndexedDocument(db, "d1")?.content_hash).toBe(
      makeDoc("d1", "updated longer content").contentHash,
    );
  });

  test("reindexMissing retries an errored metadata update when content is unchanged", async () => {
    source.documents = [makeDoc("d1", "stable content")];
    source.allIds = ["d1"];
    await indexer.indexUpdated();
    embedder.embedCount = 0;

    const updated = makeDoc("d1", "stable content");
    updated.title = "Revised fictional retry title";
    updated.updatedAt = "2026-03-10T01:00:00Z";
    source.documents = [updated];
    recordIndexError(db, "d1", "test-source", "prior metadata embed failed");

    await indexer.reindexMissing();

    expect(getIndexErrorCountsBySource(db)).toEqual({});
    expect(embedder.embedCount).toBe(1);
    expect(
      db
        .prepare<
          [string],
          { title: string }
        >("SELECT title FROM chunks WHERE document_id = ? AND chunk_index = 0")
        .get("d1")?.title,
    ).toBe("Revised fictional retry title");
  });

  test("a transient embed failure leaves the document pending, not degraded", async () => {
    embedder.failOn.add("transient content"); // generic error → classified transient
    source.documents = [makeDoc("d1", "transient content")];

    const result = await indexer.indexUpdated();

    expect(result.indexed).toBe(0);
    expect(getIndexedDocument(db, "d1")).toBeNull();
    // Recorded as a hard error (retryable), never as degraded.
    expect(getIndexErrorCountsBySource(db)).toEqual({ "test-source": 1 });
    expect(getDegradedStatsBySource(db)).toEqual({});
  });

  describe("pagination + pipelining across multiple pages", () => {
    test("indexUpdated paginates across >1 page, advancing afterId in page order", async () => {
      // 7 docs with strictly-increasing updatedAt so the watermark assertion
      // is unambiguous. pageSize 2 → 4 lightweight pages (2,2,2,1).
      const docs = Array.from({ length: 7 }, (_, i) => ({
        ...makeDoc(`d${i}`, `content ${i}`),
        updatedAt: `2026-03-10T0${i}:00:00Z`,
      }));
      source.documents = docs;

      const paged = new Indexer(db, source, new DocumentChunker(), embedder, {
        pageSize: 2,
        betweenPageSleepMs: 0,
      });

      const result = await paged.indexUpdated();

      // Every doc was indexed exactly once across the page boundaries.
      expect(result.indexed).toBe(7);
      expect(result.errors).toBe(0);
      expect(getIndexedDocumentCount(db)).toBe(7);
      expect(getChunkCount(db)).toBe(7); // short docs = 1 chunk each
      for (let i = 0; i < 7; i++) {
        expect(getIndexedDocument(db, `d${i}`)).not.toBeNull();
      }

      // afterId-driven pagination required more than one lightweight scan:
      // ceil(7/2) pages + one trailing empty/hasMore-false page.
      expect(source.listUpdatedLightweightCalls).toBeGreaterThan(1);

      // Watermark advanced to the last (max) successfully-indexed doc.
      expect(getWatermark(db, "last_updated_at")).toBe("2026-03-10T06:00:00Z");
    });

    test("a document edited after the scan passed its id is re-indexed by a later cycle", async () => {
      // The scan filters on `updated_at` but pages on `id`, and the cycle ends
      // by advancing the watermark to the largest `updated_at` it processed. A
      // write landing behind the id cursor is invisible to this cycle, and a
      // later write landing ahead of it carries the watermark past the first
      // one's stamp — stranding it for every future cycle, since nothing
      // re-examines a document the watermark has moved past.
      //
      // Stamps are relative to the wall clock because that is the relationship
      // that matters: a document written while the cycle runs is stamped after
      // the cycle began, and that is what keeps it in front of the next filter.
      const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
      source.documents = [
        { ...makeDoc("d0", "original zero"), updatedAt: at(-30_000) },
        { ...makeDoc("d1", "content one"), updatedAt: at(-20_000) },
        { ...makeDoc("d2", "content two"), updatedAt: at(-10_000) },
      ];

      // Two writes land once d0 has been read AND fully fetched — the scan is
      // on page two, so the cursor is past d0's id. d0 is edited behind that
      // cursor, and d2 — still ahead of it — is edited later still, so the
      // cycle would otherwise finish on a stamp above d0's.
      const readPage = source.listUpdatedLightweight.bind(source);
      let pagesRead = 0;
      source.listUpdatedLightweight = async (since, limit, afterId) => {
        const page = await readPage(since, limit, afterId);
        pagesRead += 1;
        if (pagesRead === 2) {
          source.documents[0] = { ...makeDoc("d0", "edited zero"), updatedAt: at(1_000) };
          source.documents[2] = { ...source.documents[2]!, updatedAt: at(2_000) };
        }
        return page;
      };

      const paged = new Indexer(db, source, new DocumentChunker(), embedder, {
        pageSize: 1,
        betweenPageSleepMs: 0,
      });

      await paged.indexUpdated();
      // d0 was read, and indexed, before the edit — so this cycle legitimately
      // holds its old content. The claim under test is about the NEXT cycle.
      expect(getIndexedDocument(db, "d0")?.content_hash).toBe(
        makeDoc("d0", "original zero").contentHash,
      );

      await paged.indexUpdated();
      expect(getIndexedDocument(db, "d0")?.content_hash).toBe(
        makeDoc("d0", "edited zero").contentHash,
      );
    });

    test("a page-2 embed failure does not lose the writes flushed from page 1", async () => {
      // Page 1 = [d0, d1] (clean). Page 2 = [d2, d3] where d2 fails to embed.
      // The pipeline flushes page 1's embeds at the top of the page-2
      // iteration, so page-1 docs must already be persisted even though a
      // page-2 doc errors out.
      const docs = Array.from({ length: 4 }, (_, i) => ({
        ...makeDoc(`d${i}`, i === 2 ? "explode here" : `content ${i}`),
        updatedAt: `2026-03-10T0${i}:00:00Z`,
      }));
      source.documents = docs;
      embedder.failOn.add("explode here");

      const paged = new Indexer(db, source, new DocumentChunker(), embedder, {
        pageSize: 2,
        betweenPageSleepMs: 0,
      });

      const result = await paged.indexUpdated();

      // The whole of page 2's embed batch failed, so it fell back to per-doc
      // resilient embedding: d2 (transient "explode here") is recorded as a
      // hard error and stays unindexed; d3 still indexes cleanly.
      expect(result.errors).toBe(1);
      expect(getIndexedDocument(db, "d2")).toBeNull();
      expect(getIndexErrorCountsBySource(db)).toEqual({ "test-source": 1 });

      // Critically, page-1 writes survived the page-2 failure.
      expect(getIndexedDocument(db, "d0")).not.toBeNull();
      expect(getIndexedDocument(db, "d1")).not.toBeNull();
      expect(getIndexedDocument(db, "d3")).not.toBeNull();
      expect(result.indexed).toBe(3);
    });

    test("reindexMissing spans multiple pages and indexes every gap document", async () => {
      // 7 docs known to the gateway, none yet indexed → all missing.
      const docs = Array.from({ length: 7 }, (_, i) => makeDoc(`m${i}`, `gap ${i}`));
      source.documents = docs;
      source.allIds = docs.map((d) => d.id);

      const paged = new Indexer(db, source, new DocumentChunker(), embedder, {
        pageSize: 2,
        betweenPageSleepMs: 0,
      });

      const result = await paged.reindexMissing();

      // The batchStart += pageSize loop ran across 4 batches, processing all 7.
      expect(result.indexed).toBe(7);
      expect(result.errors).toBe(0);
      expect(getIndexedDocumentCount(db)).toBe(7);
      expect(getChunkCount(db)).toBe(7);
      // getByIds is called once per batch (ceil(7/2) = 4 batches).
      expect(source.getByIdsCalls).toBeGreaterThanOrEqual(4);
    });
  });

  describe("source-url-only change propagation", () => {
    test("a metadata.sourceUrl-only change updates chunks.source_url in place without re-embedding", async () => {
      const doc = makeDoc("d1", "stable content");
      doc.metadata.sourceUrl = "https://example.com/items/123?utm_source=newsletter";
      source.documents = [doc];

      await indexer.indexUpdated();
      expect(getChunkSourceUrls(db, "d1")).toEqual([
        "https://example.com/items/123?utm_source=newsletter",
      ]);
      expect(embedder.embedCount).toBe(1);
      embedder.embedCount = 0;

      // Change ONLY the source URL — same content, same content hash. Bump
      // updatedAt so the indexer's lightweight scan returns the doc again.
      const reUrled = makeDoc("d1", "stable content");
      reUrled.metadata.sourceUrl = "https://example.com/items/123";
      reUrled.updatedAt = "2026-03-10T01:00:00Z";
      source.documents = [reUrled];

      const result = await indexer.indexUpdated();

      // The new canonical URL reached the denormalized chunks column...
      expect(getChunkSourceUrls(db, "d1")).toEqual(["https://example.com/items/123"]);
      // ...without paying for a re-embed (content hash unchanged).
      expect(embedder.embedCount).toBe(0);
      // It counts as an update, and the chunk row was reused (no churn).
      expect(result.updated).toBe(1);
      expect(getChunkCount(db)).toBe(1);
      // Watermark still advances past the URL-only change.
      expect(getWatermark(db, "last_updated_at")).toBe("2026-03-10T01:00:00Z");
    });
  });

  describe("non-content document event propagation", () => {
    function indexedEvent(documentId: string) {
      return db
        .prepare<
          [string],
          { source_event_at: string; event_indexed_at: string }
        >("SELECT source_event_at, event_indexed_at FROM indexed_documents WHERE document_id = ?")
        .get(documentId)!;
    }

    test("a title-only update re-embeds the changed preamble and stamps a new event", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-10T10:00:00Z"));
      source.documents = [makeDoc("d1", "stable content")];
      await indexer.indexUpdated();
      const before = indexedEvent("d1");
      embedder.embedCount = 0;

      const renamed = makeDoc("d1", "stable content");
      renamed.title = "Revised fictional title";
      renamed.updatedAt = "2026-03-10T01:00:00Z";
      source.documents = [renamed];
      vi.setSystemTime(new Date("2026-03-10T10:01:00Z"));

      await expect(indexer.indexUpdated()).resolves.toMatchObject({ updated: 1, errors: 0 });
      expect(embedder.embedCount).toBe(1);
      expect(
        db
          .prepare<
            [string],
            { title: string }
          >("SELECT title FROM chunks WHERE document_id = ? AND chunk_index = 0")
          .get("d1")?.title,
      ).toBe("Revised fictional title");
      expect(indexedEvent("d1")).toEqual({
        source_event_at: "2026-03-10T01:00:00Z",
        event_indexed_at: "2026-03-10T10:01:00.000Z",
      });
      expect(indexedEvent("d1").event_indexed_at).not.toBe(before.event_indexed_at);
    });

    test("an author-metadata update re-embeds the changed preamble", async () => {
      source.documents = [makeDoc("d1", "stable content")];
      await indexer.indexUpdated();
      embedder.embedCount = 0;

      const attributed = makeDoc("d1", "stable content");
      attributed.metadata.people = [{ role: "author", name: "Maya Reeves" }];
      attributed.updatedAt = "2026-03-10T01:00:00Z";
      source.documents = [attributed];

      await expect(indexer.indexUpdated()).resolves.toMatchObject({ updated: 1, errors: 0 });
      expect(embedder.embedCount).toBe(1);
      expect(
        db
          .prepare<
            [string],
            { author: string | null }
          >("SELECT author FROM chunks WHERE document_id = ? AND chunk_index = 0")
          .get("d1")?.author,
      ).toBe("Maya Reeves");
      expect(indexedEvent("d1").source_event_at).toBe("2026-03-10T01:00:00Z");
    });

    test("non-preamble metadata reuses vectors but still stamps the corpus event", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-10T10:00:00Z"));
      source.documents = [makeDoc("d1", "stable content")];
      await indexer.indexUpdated();
      embedder.embedCount = 0;

      const retagged = makeDoc("d1", "stable content");
      retagged.metadata.tags = ["fictional-review"];
      retagged.metadata.relevanceScore = 0.72;
      retagged.updatedAt = "2026-03-10T01:00:00Z";
      source.documents = [retagged];
      vi.setSystemTime(new Date("2026-03-10T10:01:00Z"));

      await expect(indexer.indexUpdated()).resolves.toMatchObject({ updated: 1, errors: 0 });
      expect(embedder.embedCount).toBe(0);
      expect(
        db
          .prepare<
            [string],
            { tags: string | null; relevance_score: number | null }
          >("SELECT tags, relevance_score FROM chunks WHERE document_id = ? AND chunk_index = 0")
          .get("d1"),
      ).toEqual({
        tags: JSON.stringify(["fictional-review"]),
        relevance_score: 0.72,
      });
      expect(indexedEvent("d1")).toEqual({
        source_event_at: "2026-03-10T01:00:00Z",
        event_indexed_at: "2026-03-10T10:01:00.000Z",
      });
    });

    test("an updated-at-only source event reuses vectors but remains observable", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-10T10:00:00Z"));
      source.documents = [makeDoc("d1", "stable content")];
      await indexer.indexUpdated();
      embedder.embedCount = 0;

      const sourceTouched = makeDoc("d1", "stable content");
      sourceTouched.updatedAt = "2026-03-10T01:00:00Z";
      source.documents = [sourceTouched];
      vi.setSystemTime(new Date("2026-03-10T10:01:00Z"));

      await expect(indexer.indexUpdated()).resolves.toMatchObject({ updated: 1, errors: 0 });
      expect(embedder.embedCount).toBe(0);
      expect(indexedEvent("d1")).toEqual({
        source_event_at: "2026-03-10T01:00:00Z",
        event_indexed_at: "2026-03-10T10:01:00.000Z",
      });
    });

    test("an upgraded legacy row adopts its current source revision without replaying it", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-10T10:00:00Z"));
      source.documents = [makeDoc("d1", "stable content")];
      await indexer.indexUpdated();
      const before = indexedEvent("d1");
      db.prepare("UPDATE indexed_documents SET source_event_at = '' WHERE document_id = ?").run(
        "d1",
      );
      embedder.embedCount = 0;

      const currentAtUpgrade = makeDoc("d1", "stable content");
      currentAtUpgrade.updatedAt = "2026-03-10T01:00:00Z";
      source.documents = [currentAtUpgrade];
      vi.setSystemTime(new Date("2026-03-10T10:01:00Z"));

      await expect(indexer.indexUpdated()).resolves.toMatchObject({
        updated: 0,
        skipped: 1,
        errors: 0,
      });
      expect(embedder.embedCount).toBe(0);
      expect(indexedEvent("d1")).toEqual({
        source_event_at: "2026-03-10T01:00:00Z",
        event_indexed_at: before.event_indexed_at,
      });
    });
  });

  describe("recanonicalizeSourceUrls bumps updated_at only on changed rows", () => {
    async function recanonicalize(
      gw: ReturnType<typeof createDatabase>,
      specs: readonly UrlCanonicalizerSpec[],
    ): Promise<{ scanned: number; touched: number }> {
      return new SourceUrlRecanonicalizationService({
        plan: async (input, cursor) => planSourceUrlRecanonicalization(gw, input, cursor),
        apply: async (cursor, mutations) =>
          applySourceUrlRecanonicalizationPage(gw, cursor, mutations),
        finish: async (cursor) => finishSourceUrlRecanonicalization(gw, cursor),
      }).recompute(specs);
    }

    function gwDbPath() {
      return `/tmp/omnesis-recanon-test-${randomUUID()}.db`;
    }

    function makeGwDoc(overrides: Partial<DocumentInput> = {}): DocumentInput {
      return {
        providerId: "web",
        sourceId: "bookmarks",
        externalId: "b-1",
        title: "Bookmark",
        content: "some content",
        contentHash: "ch-1",
        metadata: { sourceUrl: "https://example.com/page" },
        sourceCreatedAt: "2026-01-01T00:00:00Z",
        sourceUpdatedAt: "2026-01-01T00:00:00Z",
        ...overrides,
      };
    }

    test("only the row whose canonicalized source_url actually changes gets a fresh updated_at", async () => {
      const path = gwDbPath();
      const gw = createDatabase(path);
      try {
        // Both rows ingest with NO canonicalizers registered, so their
        // stored source_url is just the generic normalization (== input,
        // for these tracking-param-free URLs). The recanonicalize pass then
        // applies a host rule that rewrites only the "changed" row's path.
        upsertDocuments(gw, [
          makeGwDoc({
            externalId: "changed",
            metadata: { sourceUrl: "https://example.com/legacy/42" },
          }),
          makeGwDoc({
            externalId: "stable",
            metadata: { sourceUrl: "https://example.com/items/42" },
          }),
        ]);

        // Pin both rows to a known-old updated_at so a bump (or its absence)
        // is unambiguous regardless of wall-clock millisecond collisions.
        gw.prepare("UPDATE documents SET updated_at = ?").run("2020-01-01T00:00:00.000Z");

        const before = new Map(
          gw
            .prepare<[], { external_id: string; updated_at: string }>(
              "SELECT external_id, updated_at FROM documents",
            )
            .all()
            .map((r) => [r.external_id, r.updated_at]),
        );

        // Rewrite `/legacy/<id>` to `/items/<id>`. The "changed" row's
        // source_url moves to https://example.com/items/42; the "stable"
        // row already matches that canonical form, so it's a no-op.
        await recanonicalize(gw, [
          {
            hosts: ["example.com"],
            rules: [
              {
                match: "^https://example\\.com/legacy/([0-9]+)$",
                replacement: "https://example.com/items/$1",
              },
            ],
          },
        ]);

        const after = new Map(
          gw
            .prepare<[], { external_id: string; updated_at: string; source_url: string | null }>(
              "SELECT external_id, updated_at, source_url FROM documents",
            )
            .all()
            .map((r) => [r.external_id, r]),
        );

        // The changed row's source_url was re-derived AND its updated_at bumped.
        expect(after.get("changed")!.source_url).toBe("https://example.com/items/42");
        expect(after.get("changed")!.updated_at).not.toBe(before.get("changed"));
        // The stable row's updated_at is untouched (no needless re-index churn).
        expect(after.get("stable")!.updated_at).toBe(before.get("stable"));
        expect(after.get("stable")!.source_url).toBe("https://example.com/items/42");
      } finally {
        gw.close();
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          if (existsSync(path + suffix)) unlinkSync(path + suffix);
        }
      }
    });

    test("skips the full scan when specs are empty or unchanged since the last run", async () => {
      const path = gwDbPath();
      const gw = createDatabase(path);
      try {
        upsertDocuments(gw, [
          makeGwDoc({ externalId: "d1", metadata: { sourceUrl: "https://example.com/legacy/1" } }),
          makeGwDoc({ externalId: "d2", metadata: { sourceUrl: "https://example.com/legacy/2" } }),
        ]);
        const specs = [
          {
            hosts: ["example.com", "example.org"],
            rules: [
              {
                match: "^https://example\\.com/legacy/([0-9]+)$",
                replacement: "https://example.com/items/$1",
              },
            ],
          },
        ];

        // Empty specs → never scans (nothing could change).
        await expect(recanonicalize(gw, [])).resolves.toEqual({
          scanned: 0,
          touched: 0,
        });

        // First run with a real spec set: full scan, rows rewritten.
        const first = await recanonicalize(gw, specs);
        expect(first.scanned).toBe(2);
        expect(first.touched).toBe(2);

        // Second run with the SAME specs (as the collector re-fires on every
        // reconnect): the fingerprint matches, so it short-circuits WITHOUT
        // scanning — the freeze this guard removes.
        const second = await recanonicalize(gw, specs);
        expect(second).toEqual({ scanned: 0, touched: 0 });

        // Same logical specs with the host list in a different order still
        // short-circuits — the fingerprint is order-independent.
        const reordered = [
          {
            hosts: ["example.org", "example.com"],
            rules: [
              {
                match: "^https://example\\.com/legacy/([0-9]+)$",
                replacement: "https://example.com/items/$1",
              },
            ],
          },
        ];
        await expect(recanonicalize(gw, reordered)).resolves.toEqual({
          scanned: 0,
          touched: 0,
        });

        // A genuine spec change (different replacement) forces exactly one re-scan.
        const changedSpecs = [
          {
            hosts: ["example.com"],
            rules: [
              {
                match: "^https://example\\.com/items/([0-9]+)$",
                replacement: "https://example.com/v2/$1",
              },
            ],
          },
        ];
        const third = await recanonicalize(gw, changedSpecs);
        expect(third.scanned).toBe(2);
        expect(third.touched).toBe(2);
      } finally {
        gw.close();
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          if (existsSync(path + suffix)) unlinkSync(path + suffix);
        }
      }
    });

    test("reader plans fifty-row pages against a fixed high-water mark", async () => {
      const path = gwDbPath();
      const gw = createDatabase(path);
      try {
        upsertDocuments(
          gw,
          Array.from({ length: 120 }, (_, index) =>
            makeGwDoc({
              externalId: `bounded-${index}`,
              metadata: { sourceUrl: `https://example.com/legacy/${index}` },
            }),
          ),
        );
        const specs = [
          {
            hosts: ["example.com"],
            rules: [
              {
                match: "^https://example[.]com/legacy/([0-9]+)$",
                replacement: "https://example.com/items/$1",
              },
            ],
          },
        ];
        let plan = planSourceUrlRecanonicalization(gw, specs);
        const rewritten = () =>
          gw
            .prepare<
              [],
              { count: number }
            >("SELECT COUNT(*) AS count FROM documents WHERE source_url LIKE 'https://example.com/items/%'")
            .get()!.count;

        expect(plan.mutations).toHaveLength(50);
        expect(plan.done).toBe(false);
        expect(applySourceUrlRecanonicalizationPage(gw, plan.cursor, plan.mutations)).toEqual({
          touched: 50,
          abandoned: false,
        });
        expect(rewritten()).toBe(50);
        upsertDocuments(
          gw,
          Array.from({ length: 60 }, (_, index) =>
            makeGwDoc({
              externalId: `arrived-during-pass-a-${index}`,
              metadata: { sourceUrl: `https://example.com/legacy/${1_000 + index}` },
            }),
          ),
        );
        plan = planSourceUrlRecanonicalization(gw, specs, plan.cursor);
        expect(plan.mutations).toHaveLength(50);
        expect(applySourceUrlRecanonicalizationPage(gw, plan.cursor, plan.mutations).touched).toBe(
          50,
        );
        expect(rewritten()).toBe(100);
        upsertDocuments(
          gw,
          Array.from({ length: 60 }, (_, index) =>
            makeGwDoc({
              externalId: `arrived-during-pass-b-${index}`,
              metadata: { sourceUrl: `https://example.com/legacy/${2_000 + index}` },
            }),
          ),
        );
        plan = planSourceUrlRecanonicalization(gw, specs, plan.cursor);
        expect(plan.mutations).toHaveLength(20);
        expect(plan.done).toBe(true);
        expect(applySourceUrlRecanonicalizationPage(gw, plan.cursor, plan.mutations).touched).toBe(
          20,
        );
        expect(rewritten()).toBe(120);
        expect(finishSourceUrlRecanonicalization(gw, plan.cursor)).toBe(true);
        expect(plan.cursor.scanned).toBe(120);
        expect(rewritten()).toBe(120);
      } finally {
        gw.close();
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          if (existsSync(path + suffix)) unlinkSync(path + suffix);
        }
      }
    });
  });

  describe("reconcileSourceAttribution", () => {
    function chunkSourceIds(documentId: string): string[] {
      return db
        .prepare<[string], { source_id: string }>(
          "SELECT DISTINCT source_id FROM chunks WHERE document_id = ?",
        )
        .all(documentId)
        .map((r) => r.source_id);
    }

    test("re-points chunks of a re-homed source onto its survivor", async () => {
      // Index a doc under a legacy producer.
      source.documents = [{ ...makeDoc("d1"), sourceId: "old-source" }];
      await indexer.indexUpdated();
      expect(chunkSourceIds("d1")).toEqual(["old-source"]);

      // Re-home: the migration moved the doc onto `web` without changing its
      // content; `old-source` no longer owns any document.
      source.documents = [{ ...makeDoc("d1"), sourceId: "web" }];

      const result = await indexer.reconcileSourceAttribution();

      expect(result).toEqual({ repaired: 1, sources: 1 });
      expect(chunkSourceIds("d1")).toEqual(["web"]);
      // The method repairs chunks only; the caller refreshes the summary (the
      // worker boot does this). After a refresh, stats credit the survivor and
      // drop the retired source.
      refreshIndexStats(db);
      const stats = getIndexStatsBySource(db);
      expect(stats.web?.indexedDocs).toBe(1);
      expect(stats["old-source"]).toBeUndefined();
    });

    test("fans a split re-home out across multiple surviving sources", async () => {
      // One legacy source whose documents the fold split onto two survivors.
      source.documents = [
        { ...makeDoc("d1"), sourceId: "old-source" },
        { ...makeDoc("d2"), sourceId: "old-source" },
      ];
      await indexer.indexUpdated();

      source.documents = [
        { ...makeDoc("d1"), sourceId: "web" },
        { ...makeDoc("d2"), sourceId: "news" },
      ];

      const result = await indexer.reconcileSourceAttribution();

      expect(result).toEqual({ repaired: 2, sources: 1 });
      expect(chunkSourceIds("d1")).toEqual(["web"]);
      expect(chunkSourceIds("d2")).toEqual(["news"]);
      refreshIndexStats(db);
      const stats = getIndexStatsBySource(db);
      expect(stats.web?.indexedDocs).toBe(1);
      expect(stats.news?.indexedDocs).toBe(1);
      expect(stats["old-source"]).toBeUndefined();
    });

    test("is idempotent and a no-op for a live source", async () => {
      source.documents = [{ ...makeDoc("d1"), sourceId: "web" }];
      await indexer.indexUpdated();

      // First pass: nothing has drifted.
      expect(await indexer.reconcileSourceAttribution()).toEqual({ repaired: 0, sources: 0 });

      // Re-home, repair, then a second pass finds nothing left to do.
      source.documents = [{ ...makeDoc("d1"), sourceId: "web2" }];
      // Re-index so chunks exist under `web` while the doc now reports `web2`.
      expect((await indexer.reconcileSourceAttribution()).repaired).toBe(1);
      expect(await indexer.reconcileSourceAttribution()).toEqual({ repaired: 0, sources: 0 });
      expect(chunkSourceIds("d1")).toEqual(["web2"]);
    });

    test("leaves a deleted doc's chunks for the deletion reconcile", async () => {
      source.documents = [{ ...makeDoc("d1"), sourceId: "old-source" }];
      await indexer.indexUpdated();

      // Doc removed entirely from the gateway — not re-homed.
      source.documents = [];

      const result = await indexer.reconcileSourceAttribution();
      expect(result).toEqual({ repaired: 0, sources: 0 });
      // Still attributed to the old source until reconcileDeletedDocuments runs.
      expect(chunkSourceIds("d1")).toEqual(["old-source"]);
    });
  });
});
