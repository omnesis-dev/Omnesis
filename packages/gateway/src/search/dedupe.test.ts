// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { describe, test, expect, afterEach } from "vitest";
import { createIndexDatabase, setIndexedDocument } from "../indexer/db.js";
import { dedupeByContentHash } from "./dedupe.js";
import { closeTempDb } from "./test-utils.js";
import type { SearchResultItem } from "./types.js";

function makeResult(documentId: string, score: number): SearchResultItem {
  return {
    documentId,
    sourceId: "test:src",
    documentType: "email",
    title: `Doc ${documentId}`,
    sourceCreatedAt: "2026-05-01T00:00:00Z",
    chunkText: `Content of ${documentId}`,
    score,
  };
}

describe("dedupeByContentHash", () => {
  const dbs: Array<ReturnType<typeof createIndexDatabase>> = [];

  function newDb() {
    const db = createIndexDatabase(`/tmp/omnesis-dedupe-test-${randomUUID()}.db`);
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    while (dbs.length > 0) closeTempDb(dbs.pop()!);
  });

  test("collapses duplicate-hash results to highest-scoring representative, preserves order", () => {
    const db = newDb();
    // Three distinct documents share hash "H1"; two share "H2"; one unique "H3".
    setIndexedDocument(db, "doc-a", "H1", 1);
    setIndexedDocument(db, "doc-b", "H1", 1);
    setIndexedDocument(db, "doc-c", "H1", 1);
    setIndexedDocument(db, "doc-d", "H2", 1);
    setIndexedDocument(db, "doc-e", "H2", 1);
    setIndexedDocument(db, "doc-f", "H3", 1);

    // Input ordered by score descending — what the pipeline produces
    // after fusion + boost.
    const results = [
      makeResult("doc-a", 0.95),
      makeResult("doc-b", 0.93),
      makeResult("doc-c", 0.91),
      makeResult("doc-d", 0.8),
      makeResult("doc-e", 0.78),
      makeResult("doc-f", 0.5),
    ];

    const deduped = dedupeByContentHash(db, results, 10);
    expect(deduped.map((r) => r.documentId)).toEqual(["doc-a", "doc-d", "doc-f"]);
    // Highest-scoring representative per hash wins (input was score-sorted).
    expect(deduped[0].score).toBe(0.95);
    expect(deduped[1].score).toBe(0.8);
    expect(deduped[2].score).toBe(0.5);
  });

  test("respects limit after dedupe", () => {
    const db = newDb();
    setIndexedDocument(db, "doc-1", "H1", 1);
    setIndexedDocument(db, "doc-2", "H2", 1);
    setIndexedDocument(db, "doc-3", "H3", 1);
    setIndexedDocument(db, "doc-4", "H4", 1);

    const results = [
      makeResult("doc-1", 0.9),
      makeResult("doc-2", 0.8),
      makeResult("doc-3", 0.7),
      makeResult("doc-4", 0.6),
    ];

    const deduped = dedupeByContentHash(db, results, 2);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((r) => r.documentId)).toEqual(["doc-1", "doc-2"]);
  });

  test("passes results through unconditionally when content_hash is missing", () => {
    const db = newDb();
    // Only doc-known has an indexed_documents row. doc-fresh1 / doc-fresh2
    // simulate very-recent ingests not yet indexed — they must not be
    // collapsed into each other even if their content happens to match,
    // because we have no hash to compare on.
    setIndexedDocument(db, "doc-known", "H1", 1);

    const results = [
      makeResult("doc-known", 0.9),
      makeResult("doc-fresh1", 0.8),
      makeResult("doc-fresh2", 0.7),
    ];

    const deduped = dedupeByContentHash(db, results, 10);
    expect(deduped).toHaveLength(3);
    expect(deduped.map((r) => r.documentId)).toEqual(["doc-known", "doc-fresh1", "doc-fresh2"]);
  });

  test("returns [] for empty input", () => {
    const db = newDb();
    expect(dedupeByContentHash(db, [], 10)).toEqual([]);
  });

  test("no-op when every result has a distinct hash", () => {
    const db = newDb();
    setIndexedDocument(db, "doc-1", "H1", 1);
    setIndexedDocument(db, "doc-2", "H2", 1);
    setIndexedDocument(db, "doc-3", "H3", 1);

    const results = [makeResult("doc-1", 0.9), makeResult("doc-2", 0.8), makeResult("doc-3", 0.7)];

    const deduped = dedupeByContentHash(db, results, 10);
    expect(deduped.map((r) => r.documentId)).toEqual(["doc-1", "doc-2", "doc-3"]);
  });
});
