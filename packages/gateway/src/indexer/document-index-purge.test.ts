// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  getIndexedDocumentCount,
  listPendingDocumentIndexPurges,
  upsertChunks,
  upsertChunksAndMarkIndexed,
} from "./db.js";
import { purgeDocumentIndexBatch } from "./document-index-purge.js";
import type { UsearchWriteHandle } from "./usearch-index.js";

const opened: ReturnType<typeof createIndexDatabase>[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
function fixture(documents = 100, chunks = 1) {
  const indexDb = createIndexDatabase(":memory:");
  opened.push(indexDb);
  const ids = Array.from({ length: documents }, (_, i) => `doc-${i}`);
  for (const documentId of ids)
    upsertChunksAndMarkIndexed(
      indexDb,
      documentId,
      "fixture-hash",
      Array.from({ length: chunks }, (_, chunkIndex) => ({
        id: `${documentId}-chunk-${chunkIndex}`,
        documentId,
        chunkIndex,
        content: "Fictional archive text",
        sourceId: "notes:example",
        documentType: "note",
        title: "Example",
        embedding: new Float32Array(EMBEDDING_DIM).fill(0.01),
        sourceCreatedAt: "2020-01-01T00:00:00.000Z",
      })),
    );
  const save = vi.fn();
  const removeBatch = vi.fn();
  const usearchHandle = { save, removeBatch, isDetached: false } as unknown as UsearchWriteHandle;
  return { indexDb, usearchHandle, ids, save, removeBatch };
}
function count(db: ReturnType<typeof createIndexDatabase>, table: string) {
  return db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

test("one hundred document purges publish one graph save and maintain SQL counters", () => {
  const f = fixture();
  expect(getIndexedDocumentCount(f.indexDb)).toBe(100);
  expect(purgeDocumentIndexBatch(f, f.ids, 64, true, false)).toMatchObject({
    deletedChunks: 100,
    complete: true,
  });
  expect(f.save).toHaveBeenCalledOnce();
  expect(count(f.indexDb, "chunks")).toBe(0);
  expect(getIndexedDocumentCount(f.indexDb)).toBe(0);
  expect(listPendingDocumentIndexPurges(f.indexDb)).toEqual([]);
  expect(count(f.indexDb, "pending_vector_deletes")).toBe(0);
});

test("chunk-heavy documents stay bounded and incomplete until later batches", () => {
  const f = fixture(2, 65);
  expect(purgeDocumentIndexBatch(f, f.ids, 64, true, false)).toMatchObject({
    deletedChunks: 128,
    complete: false,
  });
  expect(count(f.indexDb, "chunks")).toBe(2);
  expect(f.save).not.toHaveBeenCalled();
  expect(listPendingDocumentIndexPurges(f.indexDb)).toHaveLength(2);
  expect(purgeDocumentIndexBatch(f, f.ids, 64, true, false)).toMatchObject({
    deletedChunks: 2,
    complete: true,
  });
  expect(f.save).toHaveBeenCalledOnce();
  expect(count(f.indexDb, "pending_vector_deletes")).toBe(0);
});

test("a graph save failure retains durable purge obligations for retry after SQL commits", () => {
  const f = fixture(3);
  f.save.mockImplementationOnce(() => {
    throw new Error("Synthetic publication failure");
  });
  expect(() => purgeDocumentIndexBatch(f, f.ids, 64, true, false)).toThrow(
    "Synthetic publication failure",
  );
  expect(count(f.indexDb, "chunks")).toBe(0);
  expect(listPendingDocumentIndexPurges(f.indexDb)).toHaveLength(3);
  expect(count(f.indexDb, "pending_vector_deletes")).toBe(3);
  expect(purgeDocumentIndexBatch(f, f.ids, 64, true, false)).toMatchObject({
    deletedChunks: 0,
    complete: true,
  });
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(listPendingDocumentIndexPurges(f.indexDb)).toEqual([]);
  expect(count(f.indexDb, "pending_vector_deletes")).toBe(0);
});

test("an in-flight cycle cannot earn completion before its restored chunks are removed", () => {
  const f = fixture(2);
  expect(purgeDocumentIndexBatch(f, f.ids, 64, true, true)).toMatchObject({
    deletedChunks: 2,
    complete: false,
  });
  expect(f.save).not.toHaveBeenCalled();
  expect(listPendingDocumentIndexPurges(f.indexDb)).toHaveLength(2);
  upsertChunks(f.indexDb, [
    {
      id: "restored",
      documentId: f.ids[0]!,
      chunkIndex: 0,
      content: "Late cycle write",
      title: "Example",
      sourceCreatedAt: "2020-01-01T00:00:00.000Z",
      sourceId: "notes:example",
      embedding: new Float32Array(EMBEDDING_DIM).fill(0.01),
    },
  ]);
  expect(purgeDocumentIndexBatch(f, f.ids, 64, true, false)).toMatchObject({
    deletedChunks: 1,
    complete: true,
  });
  expect(f.save).toHaveBeenCalledOnce();
  expect(count(f.indexDb, "chunks")).toBe(0);
  expect(listPendingDocumentIndexPurges(f.indexDb)).toEqual([]);
});

test("a lexical owner clears SQL reapply rows but leaves vector publication durable", () => {
  const f = fixture(2);
  expect(purgeDocumentIndexBatch({ indexDb: f.indexDb }, f.ids, 64, true, false)).toMatchObject({
    complete: true,
  });
  expect(listPendingDocumentIndexPurges(f.indexDb)).toEqual([]);
  expect(count(f.indexDb, "pending_vector_deletes")).toBe(2);
});

test("oversized groups and invalid chunk bounds fail before deleting or enqueuing anything", () => {
  const f = fixture(101);
  expect(() => purgeDocumentIndexBatch(f, f.ids, 64, true, false)).toThrow("at most 100");
  for (const limit of [0, 65, NaN, 1.5])
    expect(() => purgeDocumentIndexBatch(f, [f.ids[0]!], limit, true, false)).toThrow(
      "chunk limit",
    );
  expect(count(f.indexDb, "chunks")).toBe(101);
  expect(listPendingDocumentIndexPurges(f.indexDb)).toEqual([]);
  expect(f.save).not.toHaveBeenCalled();
});

test("deleting a cached date endpoint invalidates stale date bounds without a corpus scan", () => {
  const f = fixture(2);
  f.indexDb
    .prepare(
      "UPDATE source_index_stats SET earliest_source_date = '2020-01-01', latest_source_date = '2021-01-01' WHERE source_id = 'notes:example'",
    )
    .run();
  purgeDocumentIndexBatch(f, [f.ids[0]!], 64, true, false);
  expect(
    f.indexDb
      .prepare(
        "SELECT earliest_source_date AS earliest, latest_source_date AS latest FROM source_index_stats WHERE source_id = 'notes:example'",
      )
      .get(),
  ).toEqual({ earliest: null, latest: null });
  expect(getIndexedDocumentCount(f.indexDb)).toBe(1);
});
