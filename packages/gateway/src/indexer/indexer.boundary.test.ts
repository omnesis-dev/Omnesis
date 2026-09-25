// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Boundary tests for the indexer loop bounds.
 *
 * These pin the EXACT iteration count of the reindexMissing batch loop at the
 * point where `missingIds.length` is a whole multiple of `pageSize`. The loop
 * is written `batchStart < missingIds.length`; an off-by-one to
 * `batchStart <= missingIds.length` runs one extra, fully-empty batch that
 * fetches `getByIds([])`. Because that extra batch indexes nothing, the
 * `result.indexed` / document-count totals are unchanged — only the number of
 * `source.getByIds` calls differs. Asserting the exact call count on an
 * exact-multiple fixture is therefore the only way to catch the off-by-one.
 */

import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  getChunkCount,
  getIndexedDocument,
  getIndexedDocumentCount,
} from "./db.js";
import { Indexer } from "./indexer.js";
import { DocumentChunker } from "./chunker.js";
import type { DocumentSource, Embedder, IndexableDocument } from "./types.js";
import type Database from "better-sqlite3";
type Db = Database.Database;

/** Deterministic embedder — one fixed unit vector per input. */
class MockEmbedder implements Embedder {
  async embed(texts: string[]): Promise<Float32Array[]> {
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
  async dispose() {}
}

/** Source that counts `getByIds` invocations so we can pin batch iteration. */
class MockSource implements DocumentSource {
  documents: IndexableDocument[] = [];
  allIds: string[] = [];
  getByIdsCalls = 0;

  async listUpdated() {
    return { documents: [], hasMore: false };
  }
  async listUpdatedLightweight() {
    return { documents: [], hasMore: false };
  }
  async listAllIds() {
    return this.allIds;
  }
  async getByIds(ids: string[]) {
    this.getByIdsCalls += 1;
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

describe("reindexMissing batch-loop bound", () => {
  let db: Db;
  let source: MockSource;
  let embedder: MockEmbedder;

  beforeEach(() => {
    db = createIndexDatabase(`/tmp/omnesis-indexer-boundary-${randomUUID()}.db`);
    source = new MockSource();
    embedder = new MockEmbedder();
  });

  afterEach(() => {
    db.close();
  });

  test("missing count an exact multiple of pageSize fetches exactly count/pageSize batches", async () => {
    // 4 missing docs, pageSize 2 → exactly 2 batches: [m0,m1] and [m2,m3].
    // The boundary is `batchStart < 4`: 0 and 2 run, 4 stops. A `<=` mutant
    // would also enter batchStart=4, slicing missingIds.slice(4,6) === [] and
    // issuing one extra getByIds([]) — a 3rd call that indexes nothing.
    const docs = Array.from({ length: 4 }, (_, i) => makeDoc(`m${i}`, `gap ${i}`));
    source.documents = docs;
    source.allIds = docs.map((d) => d.id);

    const paged = new Indexer(db, source, new DocumentChunker(), embedder, {
      pageSize: 2,
      betweenPageSleepMs: 0,
    });

    const result = await paged.reindexMissing();

    // Outcome totals are identical whether or not the extra empty batch runs —
    // every gap doc is indexed exactly once.
    expect(result.indexed).toBe(4);
    expect(result.errors).toBe(0);
    expect(getIndexedDocumentCount(db)).toBe(4);
    expect(getChunkCount(db)).toBe(4); // short docs = 1 chunk each
    for (let i = 0; i < 4; i++) {
      expect(getIndexedDocument(db, `m${i}`)).not.toBeNull();
    }

    // The discriminating assertion: exactly ceil(4/2) = 2 batches were fetched.
    // No persistent indexing-error rows exist, so reconcilePersistentErrors
    // issues no further getByIds call — 2 is the precise count under the loop's
    // `<` bound, and 3 under the off-by-one `<=` bound.
    expect(source.getByIdsCalls).toBe(2);
  });

  test("a single full page (count === pageSize) fetches exactly one batch", async () => {
    // count === pageSize is the tightest exact-multiple boundary: one batch
    // covers everything, `batchStart < 3` stops after batchStart=0, but `<= 3`
    // re-enters at batchStart=3 with an empty slice for a spurious 2nd fetch.
    const docs = Array.from({ length: 3 }, (_, i) => makeDoc(`s${i}`, `solo ${i}`));
    source.documents = docs;
    source.allIds = docs.map((d) => d.id);

    const paged = new Indexer(db, source, new DocumentChunker(), embedder, {
      pageSize: 3,
      betweenPageSleepMs: 0,
    });

    const result = await paged.reindexMissing();

    expect(result.indexed).toBe(3);
    expect(getIndexedDocumentCount(db)).toBe(3);
    expect(source.getByIdsCalls).toBe(1);
  });
});
