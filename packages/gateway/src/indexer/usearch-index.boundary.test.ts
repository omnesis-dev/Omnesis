// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Boundary test for the backfill rebuild branch.
 *
 * `backfillFromDb` takes the `currentSize > 0` rebuild branch when the index
 * is partially populated. The intended contract: after the rebuild the index
 * holds exactly one vector per stored chunk embedding and every key maps to a
 * real chunk rowid — no pre-existing orphan survives.
 *
 * NOTE on the surviving mutant (gateway-indexer-m4, which comments out
 * `this.clear()` inside this branch): that mutant is *equivalent* under the
 * current code. The very next line, `this.index = createIndex(this.dimensions)`,
 * unconditionally replaces the in-memory index with a fresh empty one, so the
 * only effect of `this.clear()` is an `unlinkSync` of the on-disk file — which
 * the subsequent `save()` overwrites via an atomic rename. In-memory size and
 * the persisted file are byte-identical with or without `this.clear()`, so no
 * behavioural assertion can distinguish them. This test instead locks down the
 * rebuild-branch contract itself: should a future refactor drop the redundant
 * `createIndex` line (making `this.clear()` load-bearing), this test would then
 * catch a stale-orphan regression.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { UsearchWriteHandle, UsearchReadHandle } from "./usearch-index.js";
import { EMBEDDING_DIM, createIndexDatabase, upsertChunks } from "./db.js";
import type Database from "better-sqlite3";

/** Deterministic unit-normalized embedding of EMBEDDING_DIM seeded from `val`. */
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

describe("backfillFromDb rebuild branch (currentSize > 0)", () => {
  let dir: string;
  let path: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usearch-boundary-"));
    path = join(dir, "test.usearch");
    db = createIndexDatabase(`/tmp/omnesis-usearch-boundary-${randomUUID()}.db`);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

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

  it("a pre-saved orphan does not survive the rebuild; every key maps to a real rowid", () => {
    seedChunks(10);
    const handle = new UsearchWriteHandle(path, EMBEDDING_DIM);

    // Pre-seed AND persist a stale vector at a key that is NOT any real chunk
    // rowid, so a real on-disk file exists before backfill runs.
    handle.add(999999n, makeEmbedding(1));
    handle.save();
    expect(handle.size()).toBe(1);

    // currentSize(1) < totalInDb(10) → the rebuild branch runs.
    handle.backfillFromDb(db);

    expect(handle.size()).toBe(10);
    handle.save();

    const realRowids = new Set(
      db
        .prepare<[], { rowid: number }>("SELECT rowid FROM chunks")
        .all()
        .map((r) => BigInt(r.rowid)),
    );
    const reader = UsearchReadHandle.open(path, EMBEDDING_DIM)!;
    // Ask for more than the live count: if the orphan lingered it would show
    // up here. Every returned key must be a real chunk rowid.
    const results = reader.search(makeEmbedding(1), 11);
    expect(results.length).toBe(10);
    for (const { key } of results) expect(realRowids.has(key)).toBe(true);
    expect(results.some(({ key }) => key === 999999n)).toBe(false);
    reader.close();
    handle.close();
  });
});
