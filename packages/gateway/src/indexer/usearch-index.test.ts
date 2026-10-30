// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { UsearchWriteHandle, UsearchReadHandle } from "./usearch-index.js";
import { EMBEDDING_DIM, createIndexDatabase, getVectorChangeHead, upsertChunks } from "./db.js";
import type Database from "better-sqlite3";

const DIMS = 32;

function randomVector(dims: number = DIMS): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = Math.random() - 0.5;
  return v;
}

function deterministicVector(seed: number, dims: number = DIMS): Float32Array {
  const vector = new Float32Array(dims);
  vector[seed % dims] = 1;
  return vector;
}

/** Linux exposes native mmap ownership directly; other platforms keep the functional assertions. */
function mappingsFor(path: string): string[] | null {
  const mapsPath = "/proc/self/maps";
  if (process.platform !== "linux" || !existsSync(mapsPath)) return null;
  return readFileSync(mapsPath, "utf8")
    .split("\n")
    .filter((line) => line.includes(path));
}

/** Deterministic unit-normalized embedding of `EMBEDDING_DIM` seeded from `val`. */
function makeEmbedding(val: number): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM);
  let s = (val * 0x9e3779b9) >>> 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    arr[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  let n = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) n += arr[i] * arr[i];
  const norm = Math.sqrt(n) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) arr[i] /= norm;
  return arr;
}

describe("UsearchWriteHandle", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usearch-test-"));
    path = join(dir, "test.usearch");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates an empty index and adds vectors", () => {
    const handle = new UsearchWriteHandle(path, DIMS);
    expect(handle.size()).toBe(0);

    handle.add(1n, randomVector());
    handle.add(2n, randomVector());
    expect(handle.size()).toBe(2);
    handle.close();
  });

  it("saves and loads from disk", () => {
    const h1 = new UsearchWriteHandle(path, DIMS);
    h1.add(1n, randomVector());
    h1.add(2n, randomVector());
    h1.save();

    const h2 = new UsearchWriteHandle(path, DIMS);
    expect(h2.size()).toBe(2);
    h2.close();
    h1.close();
  });

  it("discards a stale on-disk index whose dimension differs from the handle's", () => {
    // Persist a 32-dim index, then reopen the same path at a DIFFERENT
    // dimension — a stale file left by a previous embedder. Pre-fix, load()
    // adopted the file's 32 dims and the first 64-dim add() threw "flattened
    // vectors must be a multiple of the dimension", wedging the indexer. The
    // dim-guard must discard the stale file and start empty at the new dim.
    const h1 = new UsearchWriteHandle(path, 32);
    h1.add(1n, randomVector(32));
    h1.add(2n, randomVector(32));
    h1.save();
    h1.close();

    const h2 = new UsearchWriteHandle(path, 64);
    expect(h2.size()).toBe(0); // stale file discarded, fresh empty index
    expect(() => h2.add(1n, randomVector(64))).not.toThrow();
    expect(h2.size()).toBe(1);
    h2.close();
  });

  it("removes vectors", () => {
    const handle = new UsearchWriteHandle(path, DIMS);
    handle.add(1n, randomVector());
    handle.add(2n, randomVector());
    handle.remove(1n);
    expect(handle.size()).toBe(1);
    handle.close();
  });

  it("remove of non-existent key is a no-op", () => {
    const handle = new UsearchWriteHandle(path, DIMS);
    handle.remove(999n);
    expect(handle.size()).toBe(0);
    handle.close();
  });

  it("add with existing key updates the vector", () => {
    const handle = new UsearchWriteHandle(path, DIMS);
    const v1 = randomVector();
    const v2 = randomVector();
    handle.add(1n, v1);
    handle.add(1n, v2);
    expect(handle.size()).toBe(1);
    handle.close();
  });

  it("clear resets the index", () => {
    const handle = new UsearchWriteHandle(path, DIMS);
    handle.add(1n, randomVector());
    handle.add(2n, randomVector());
    handle.save();
    handle.clear();
    expect(handle.size()).toBe(0);
    handle.close();
  });

  it("addBatch and removeBatch work", () => {
    const handle = new UsearchWriteHandle(path, DIMS);
    handle.addBatch([
      { key: 1n, vector: randomVector() },
      { key: 2n, vector: randomVector() },
      { key: 3n, vector: randomVector() },
    ]);
    expect(handle.size()).toBe(3);
    handle.removeBatch([1n, 3n]);
    expect(handle.size()).toBe(1);
    handle.close();
  });
});

describe("UsearchReadHandle", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usearch-test-"));
    path = join(dir, "test.usearch");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens an empty handle when the file does not exist yet, then self-fills on refresh", () => {
    // A gateway can boot before its first index build, so the handle must be
    // usable (empty) without a file, and pick up the writer's first save via
    // maybeRefresh() — no restart needed.
    const reader = UsearchReadHandle.open(path, DIMS);
    expect(reader.size()).toBe(0);
    expect(reader.search(randomVector(), 5)).toEqual([]);

    const writer = new UsearchWriteHandle(path, DIMS);
    writer.add(1n, randomVector());
    writer.save();
    writer.close();

    reader.maybeRefresh();
    expect(reader.size()).toBe(1);
    reader.close();
  });

  it("maybeRefresh re-views only when the file changed (mtime-gated)", () => {
    const writer = new UsearchWriteHandle(path, DIMS);
    writer.add(1n, randomVector());
    writer.save();

    const reader = UsearchReadHandle.open(path, DIMS);
    expect(reader.size()).toBe(1);

    // No new save → maybeRefresh is a no-op (mtime unchanged).
    reader.maybeRefresh();
    expect(reader.size()).toBe(1);

    writer.add(2n, randomVector());
    writer.add(3n, randomVector());
    writer.save();

    reader.maybeRefresh();
    expect(reader.size()).toBe(3);

    reader.close();
    writer.close();
  });

  it("keeps one native mapping across repeated atomic publications", () => {
    const writer = new UsearchWriteHandle(path, DIMS);
    const first = deterministicVector(1);
    writer.add(1n, first);
    writer.save();

    const reader = UsearchReadHandle.open(path, DIMS);
    expect(reader.search(first, 1)[0]?.key).toBe(1n);

    for (let publication = 2; publication <= 10; publication++) {
      const vector = deterministicVector(publication);
      writer.add(BigInt(publication), vector);
      writer.save();
      reader.maybeRefresh();

      expect(reader.size()).toBe(publication);
      expect(reader.search(vector, 1)[0]?.key).toBe(BigInt(publication));
      const mappings = mappingsFor(path);
      if (mappings) {
        expect(mappings.filter((line) => line.includes("(deleted)"))).toEqual([]);
        expect(mappings).toHaveLength(1);
      }
    }

    reader.close();
    writer.close();
  });

  it("recovers after native view fails without retaining the failed mapping", () => {
    const initial = randomVector(DIMS);
    const writer = new UsearchWriteHandle(path, DIMS);
    writer.add(1n, initial);
    writer.save();
    writer.close();

    const reader = UsearchReadHandle.open(path, DIMS);
    expect(reader.search(initial, 1)[0]?.key).toBe(1n);

    // A directory has a valid stat signature but cannot be mmap-viewed as an
    // index. Unlike arbitrary corrupt graph bytes, this reaches a catchable
    // native view() failure without risking USearch aborting the test process.
    rmSync(path, { force: true });
    mkdirSync(path);
    expect(() => reader.rebind(path, DIMS)).toThrow();
    rmSync(path, { recursive: true, force: true });

    const recovered = randomVector(DIMS);
    const recoveryPath = join(dir, "recovery.usearch");
    const recoveryWriter = new UsearchWriteHandle(recoveryPath, DIMS);
    recoveryWriter.add(3n, recovered);
    recoveryWriter.save();
    recoveryWriter.close();
    renameSync(recoveryPath, path);

    expect(reader.rebind(path, DIMS)).toBe(true);
    expect(reader.search(recovered, 1)[0]?.key).toBe(3n);
    const mappings = mappingsFor(path);
    if (mappings) {
      expect(mappings.filter((line) => line.includes("(deleted)"))).toEqual([]);
      expect(mappings).toHaveLength(1);
    }
    reader.close();
  });

  it("retries the durability callback after it fails", () => {
    const writer = new UsearchWriteHandle(path, DIMS);
    writer.add(1n, randomVector());
    const onSaved = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error("stamp failed");
      })
      .mockImplementationOnce(() => {});
    writer.setOnSaved(onSaved);

    expect(() => writer.save()).toThrow("stamp failed");
    const reader = UsearchReadHandle.open(path, DIMS);
    expect(reader.size()).toBe(1);
    reader.close();

    expect(() => writer.save()).not.toThrow();
    expect(onSaved).toHaveBeenCalledTimes(2);
    writer.close();
  });

  it("maybeRefresh re-dimensions the read index after a dimension change", () => {
    // Simulates an embedder swap: the index file is rebuilt at a different
    // dimension. view() adopts the file's stored dim, so the reader follows
    // along and can search the new-dimension vectors without a restart.
    const writerA = new UsearchWriteHandle(path, DIMS);
    writerA.add(1n, randomVector(DIMS));
    writerA.save();
    writerA.close();

    const reader = UsearchReadHandle.open(path, DIMS);
    expect(reader.size()).toBe(1);
    expect(reader.search(randomVector(DIMS), 1).length).toBe(1);

    // The real swap wipes the index file before the new worker writes (the
    // write handle loads any existing file, which would mismatch the new
    // dimension), so simulate that wipe here.
    rmSync(path, { force: true });
    const otherDims = DIMS * 2;
    const writerB = new UsearchWriteHandle(path, otherDims);
    writerB.add(10n, randomVector(otherDims));
    writerB.add(11n, randomVector(otherDims));
    writerB.save();
    writerB.close();

    reader.maybeRefresh();
    expect(reader.size()).toBe(2);
    // A query at the NEW dimension searches cleanly (no dim-mismatch throw).
    expect(reader.search(randomVector(otherDims), 2).length).toBe(2);
    reader.close();
  });

  it("opens a saved index and searches", () => {
    const writer = new UsearchWriteHandle(path, DIMS);
    const target = randomVector();
    writer.add(1n, target);
    writer.add(2n, randomVector());
    writer.add(3n, randomVector());
    writer.save();
    writer.close();

    const reader = UsearchReadHandle.open(path, DIMS);
    expect(reader.size()).toBe(3);

    const results = reader.search(target, 3);
    expect(results.length).toBe(3);
    expect(results[0].key).toBe(1n);
    expect(results[0].distance).toBeCloseTo(0, 1);
    reader.close();
  });

  it("reopen picks up new writes", () => {
    const writer = new UsearchWriteHandle(path, DIMS);
    writer.add(1n, randomVector());
    writer.save();

    const reader = UsearchReadHandle.open(path, DIMS);
    expect(reader.size()).toBe(1);

    writer.add(2n, randomVector());
    writer.add(3n, randomVector());
    writer.save();

    expect(reader.size()).toBe(1);
    reader.reopen();
    expect(reader.size()).toBe(3);

    reader.close();
    writer.close();
  });

  it("search returns empty when index has one vector and k exceeds size", () => {
    const writer = new UsearchWriteHandle(path, DIMS);
    writer.add(1n, randomVector());
    writer.save();
    writer.close();

    const reader = UsearchReadHandle.open(path, DIMS);
    const results = reader.search(randomVector(), 5);
    expect(results.length).toBe(1);
    reader.close();
  });
});

describe("UsearchWriteHandle.backfillFromDb", () => {
  let dir: string;
  let path: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usearch-backfill-"));
    path = join(dir, "test.usearch");
    db = createIndexDatabase(`/tmp/omnesis-backfill-test-${randomUUID()}.db`);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed `count` chunks (one per doc) into `chunks` with stored embeddings. */
  function seedChunks(count: number): void {
    upsertChunks(
      db,
      Array.from({ length: count }, (_, i) => ({
        id: `chunk-${i}`,
        documentId: `doc-${i}`,
        chunkIndex: 0,
        content: `content ${i}`,
        embedding: makeEmbedding(i + 1),
        sourceId: "test-source",
        title: `Doc ${i}`,
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      })),
    );
  }

  it("rebuilds the HNSW index from chunks.embedding and is searchable", () => {
    seedChunks(12);
    const handle = new UsearchWriteHandle(path, EMBEDDING_DIM);
    expect(handle.size()).toBe(0);

    handle.backfillFromDb(db);

    // One vector per stored chunk embedding.
    expect(handle.size()).toBe(12);

    // The persisted index is searchable: the nearest neighbour of the
    // embedding seeded for doc-5 is the rowid that doc's chunk was stored at.
    handle.save();
    const rowid5 = db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = ?")
      .get("doc-5")!.rowid;
    const reader = UsearchReadHandle.open(path, EMBEDDING_DIM);
    const hit = reader.search(makeEmbedding(6), 1)[0]; // doc-5 seeded with makeEmbedding(6)
    expect(hit.key).toBe(BigInt(rowid5));
    reader.close();
    handle.close();
  });

  it("is idempotent — a second backfill into an already-full index is a fast no-op skip", () => {
    seedChunks(8);
    const handle = new UsearchWriteHandle(path, EMBEDDING_DIM);
    handle.backfillFromDb(db);
    expect(handle.size()).toBe(8);

    // Track progress callbacks to confirm the skip fast-path fires: it
    // reports a single onProgress(1) without paging through the rows again.
    const fractions: number[] = [];
    handle.backfillFromDb(db, { onProgress: (f) => fractions.push(f) });

    // Index unchanged — no duplicate vectors were added.
    expect(handle.size()).toBe(8);
    // Skip path emits exactly one terminal progress tick.
    expect(fractions).toEqual([1]);
    handle.close();
  });

  it("force-rebuilds a stale graph even when its vector count matches the DB", () => {
    seedChunks(2);
    const handle = new UsearchWriteHandle(path, EMBEDDING_DIM);
    handle.backfillFromDb(db);
    const staleRowid = db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = ?")
      .get("doc-0")!.rowid;

    db.prepare("DELETE FROM chunks WHERE document_id = ?").run("doc-0");
    upsertChunks(db, [
      {
        id: "chunk-replacement",
        documentId: "doc-replacement",
        chunkIndex: 0,
        content: "replacement content",
        embedding: makeEmbedding(99),
        sourceId: "test-source",
        title: "Replacement",
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
    expect(handle.size()).toBe(2);

    handle.backfillFromDb(db, { forceRebuild: true });

    const liveRowids = new Set(
      db
        .prepare<[], { rowid: number }>("SELECT rowid FROM chunks")
        .all()
        .map((row) => BigInt(row.rowid)),
    );
    const reader = UsearchReadHandle.open(path, EMBEDDING_DIM);
    const graphRowids = new Set(reader.search(makeEmbedding(99), 2).map((hit) => hit.key));
    expect(graphRowids).toEqual(liveRowids);
    expect(graphRowids.has(BigInt(staleRowid))).toBe(false);
    reader.close();
    handle.close();
  });

  it("rebuilds from scratch when the index is partially populated (stale/smaller than DB)", () => {
    seedChunks(10);
    const handle = new UsearchWriteHandle(path, EMBEDDING_DIM);
    // Pre-seed the index with a single stale vector at a key that does NOT
    // correspond to any real chunk rowid.
    handle.add(999999n, makeEmbedding(1));
    expect(handle.size()).toBe(1);

    // Backfill sees currentSize(1) < totalInDb(10): it clears the stale
    // vector and rebuilds the full set from chunks.embedding.
    handle.backfillFromDb(db);

    expect(handle.size()).toBe(10);
    handle.save();
    const reader = UsearchReadHandle.open(path, EMBEDDING_DIM);
    // The orphan key is gone after the rebuild — every key now maps to a
    // real chunk rowid.
    const realRowids = new Set(
      db
        .prepare<[], { rowid: number }>("SELECT rowid FROM chunks")
        .all()
        .map((r) => BigInt(r.rowid)),
    );
    const results = reader.search(makeEmbedding(1), 10);
    for (const { key } of results) expect(realRowids.has(key)).toBe(true);
    reader.close();
    handle.close();
  });

  it("honors the threads option — serial and multi-threaded builds are both correct + searchable", () => {
    seedChunks(20);
    const rowid7 = db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = ?")
      .get("doc-7")!.rowid;

    // The batched build must yield an all-vectors-present, correctly-searchable
    // index whether built single-threaded or in parallel.
    for (const threads of [1, 4]) {
      const p = join(dir, `threads-${threads}.usearch`);
      const handle = new UsearchWriteHandle(p, EMBEDDING_DIM);
      handle.backfillFromDb(db, { threads });
      expect(handle.size()).toBe(20);
      handle.save();
      const reader = UsearchReadHandle.open(p, EMBEDDING_DIM);
      // doc-7 was seeded with makeEmbedding(8) → its own vector is its NN.
      expect(reader.search(makeEmbedding(8), 1)[0].key).toBe(BigInt(rowid7));
      reader.close();
      handle.close();
    }
  });

  it("indexes correctly across multiple pages, including a skip in a later page", () => {
    seedChunks(7);
    // Corrupt a row that lands in a *later* page so the cross-page paging +
    // per-page skip interplay is exercised (offset must advance by rows
    // fetched, not vectors added, or a skip would desync the paging).
    db.prepare("UPDATE chunks SET embedding = ? WHERE document_id = 'doc-4'").run(
      Buffer.alloc((EMBEDDING_DIM + 1) * 4),
    );
    const handle = new UsearchWriteHandle(path, EMBEDDING_DIM);
    // pageSize 3 over 7 rows → pages of 3, 3, 1; doc-4 (rowid 5) is in page 2.
    handle.backfillFromDb(db, { pageSize: 3 });
    expect(handle.size()).toBe(6); // 7 seeded − 1 corrupt

    handle.save();
    const rowid6 = db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = ?")
      .get("doc-6")!.rowid;
    const reader = UsearchReadHandle.open(path, EMBEDDING_DIM);
    // doc-6 (seeded with makeEmbedding(7)) is in the last page and searchable.
    expect(reader.search(makeEmbedding(7), 1)[0].key).toBe(BigInt(rowid6));
    reader.close();
    handle.close();
  });

  it("skips a wrong-dimension embedding row and still indexes the rest", () => {
    seedChunks(6);
    // Corrupt one chunk's stored embedding to a wrong byte length (the shape a
    // stale mixed-dimension row would take). It must be skipped, never allowed
    // to misalign the contiguous batch matrix.
    db.prepare("UPDATE chunks SET embedding = ? WHERE document_id = 'doc-3'").run(
      Buffer.alloc((EMBEDDING_DIM + 2) * 4),
    );
    const handle = new UsearchWriteHandle(path, EMBEDDING_DIM);
    handle.backfillFromDb(db);
    // Five good vectors indexed; the corrupt one skipped rather than crashing.
    expect(handle.size()).toBe(5);
    handle.close();
  });
});

describe("UsearchWriteHandle durable rebuild and catch-up", () => {
  let dir: string;
  let path: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usearch-durable-"));
    path = join(dir, "test.usearch");
    db = createIndexDatabase(`/tmp/omnesis-durable-test-${randomUUID()}.db`);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function upsert(index: number, seed: number = index + 1): void {
    upsertChunks(db, [
      {
        id: `chunk-${index}`,
        documentId: `doc-${index}`,
        chunkIndex: 0,
        content: `content ${index}`,
        embedding: makeEmbedding(seed),
        sourceId: "test-source",
        title: `Doc ${index}`,
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      },
    ]);
  }

  function rowidOf(index: number): number {
    return db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE id = ?")
      .get(`chunk-${index}`)!.rowid;
  }

  function nearest(vector: Float32Array): { key: bigint; distance: number } {
    const reader = UsearchReadHandle.open(path, EMBEDDING_DIM);
    try {
      return reader.search(vector, 1)[0]!;
    } finally {
      reader.close();
    }
  }

  it("logs every vector insert, embedding update and delete", () => {
    upsert(0);
    upsert(1);
    upsert(0, 99);
    db.prepare("DELETE FROM chunks WHERE id = ?").run("chunk-1");
    db.prepare("UPDATE chunks SET title = 'renamed' WHERE id = ?").run("chunk-0");
    const logged = db
      .prepare<[], { chunk_rowid: number }>("SELECT chunk_rowid FROM vector_changes ORDER BY seq")
      .all()
      .map((row) => row.chunk_rowid);
    // Insert, insert, re-embed, delete — a title change is not a vector change.
    expect(logged).toEqual([rowidOf(0), 2, rowidOf(0), 2]);
  });

  it("a stopped build saves its partial graph and a resumed build completes it", () => {
    for (let i = 0; i < 10; i++) upsert(i);
    let pages = 0;
    let rebuildStarts = 0;
    const first = new UsearchWriteHandle(path, EMBEDDING_DIM);
    const outcome = first.backfillFromDb(db, {
      pageSize: 2,
      checkpointIntervalMs: 60_000,
      onRebuildStart: () => rebuildStarts++,
      shouldStop: () => ++pages === 3,
    });
    expect(outcome).toBe("stopped");
    expect(first.backfillCursor).toBe(rowidOf(5));
    expect(existsSync(path)).toBe(true);

    const resumed = new UsearchWriteHandle(path, EMBEDDING_DIM);
    expect(resumed.size()).toBe(6);
    const progress: number[] = [];
    expect(
      resumed.backfillFromDb(db, {
        pageSize: 2,
        resumeAfterRowid: rowidOf(5),
        onRebuildStart: () => rebuildStarts++,
        onProgress: (fraction) => progress.push(fraction),
      }),
    ).toBe("complete");
    expect(rebuildStarts).toBe(1);
    expect(resumed.size()).toBe(10);
    expect(resumed.backfillCursor).toBeNull();
    // Progress counts the vectors the resumed graph already had.
    expect(progress[0]).toBeCloseTo(0.8);
  });

  it("a resumed build replaces rowids its file already holds past the cursor", () => {
    for (let i = 0; i < 6; i++) upsert(i);
    new UsearchWriteHandle(path, EMBEDDING_DIM).backfillFromDb(db);
    const resumed = new UsearchWriteHandle(path, EMBEDDING_DIM);
    expect(resumed.backfillFromDb(db, { pageSize: 2, resumeAfterRowid: rowidOf(2) })).toBe(
      "complete",
    );
    expect(resumed.size()).toBe(6);
  });

  it("catching up from the change log brings a stale graph level with the database", async () => {
    for (let i = 0; i < 10; i++) upsert(i);
    new UsearchWriteHandle(path, EMBEDDING_DIM).backfillFromDb(db);
    const savedAt = getVectorChangeHead(db);
    const deletedRowid = rowidOf(2);

    // Changes the saved graph never saw: a re-embed, a delete, a new chunk.
    upsert(1, 501);
    db.prepare("DELETE FROM chunks WHERE id = ?").run("chunk-2");
    upsert(10);

    const handle = new UsearchWriteHandle(path, EMBEDDING_DIM);
    await expect(handle.catchUpFromChangeLog(db, savedAt)).resolves.toBe("complete");
    handle.save();

    expect(handle.size()).toBe(10);
    const reembedded = nearest(makeEmbedding(501));
    expect(reembedded.key).toBe(BigInt(rowidOf(1)));
    expect(reembedded.distance).toBeLessThan(1e-4);
    expect(nearest(makeEmbedding(11)).key).toBe(BigInt(rowidOf(10)));
    expect(nearest(makeEmbedding(3)).key).not.toBe(BigInt(deletedRowid));
  });

  it("a released handle gives the graph up and leaves the file alone", () => {
    for (let i = 0; i < 4; i++) upsert(i);
    const handle = new UsearchWriteHandle(path, EMBEDDING_DIM);
    handle.backfillFromDb(db);
    const before = readFileSync(path);

    handle.release();
    handle.add(99n, makeEmbedding(99));
    handle.remove(BigInt(rowidOf(0)));
    handle.save();

    expect(handle.isDetached).toBe(true);
    expect(handle.size()).toBe(0);
    expect(readFileSync(path).equals(before)).toBe(true);
    // A detached open is the same: nothing loaded, nothing written.
    const detached = new UsearchWriteHandle(path, EMBEDDING_DIM, { detached: true });
    expect(detached.size()).toBe(0);
    expect(detached.backfillFromDb(db)).toBe("skipped");
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("scans with a small page cache and restores the connection's own afterwards", () => {
    for (let i = 0; i < 4; i++) upsert(i);
    db.pragma("cache_size = -65536");
    const during: number[] = [];
    new UsearchWriteHandle(path, EMBEDDING_DIM).backfillFromDb(db, {
      pageSize: 2,
      onProgress: () => during.push(db.pragma("cache_size", { simple: true }) as number),
    });
    expect(during.slice(0, -1).every((size) => size === -16384)).toBe(true);
    expect(db.pragma("cache_size", { simple: true })).toBe(-65536);
  });
});
