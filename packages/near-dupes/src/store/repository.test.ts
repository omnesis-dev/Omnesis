// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createMinhashParams, minhash } from "../algo/minhash.js";
import { shingles, normalizeText } from "../algo/shingle.js";
import { DupeStore } from "./repository.js";

describe("DupeStore", () => {
  let path: string;
  let store: DupeStore;

  beforeEach(() => {
    path = `/tmp/omnesis-dupes-test-${randomUUID()}.db`;
    store = new DupeStore(path);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(path + suffix);
      } catch {
        // ignore
      }
    }
  });

  it("creates and reads back a minhash row", () => {
    const params = createMinhashParams(64, 1);
    const sig = minhash(shingles(normalizeText("hello world foo bar"), 2), params);
    store.upsertMinhash({
      documentId: "doc-1",
      algoVersion: "test-v1",
      signature: sig,
      shingleCount: 5,
      contentHash: "abc123",
      docType: "note",
      pluginId: "apple-notes:default",
      sourceCreatedAt: 1700000000,
      computedAt: 1700000001,
    });
    const round = store.getMinhash("doc-1", "test-v1");
    expect(round).not.toBeNull();
    expect(round!.shingleCount).toBe(5);
    expect(Array.from(round!.signature)).toEqual(Array.from(sig));
  });

  it("LSH lookup returns candidates that share any band bucket", () => {
    const algo = "test-v1";
    store.insertBuckets([
      { algoVersion: algo, bandIdx: 0, bucketHash: 100, documentId: "doc-a" },
      { algoVersion: algo, bandIdx: 0, bucketHash: 100, documentId: "doc-b" },
      { algoVersion: algo, bandIdx: 1, bucketHash: 200, documentId: "doc-b" },
      { algoVersion: algo, bandIdx: 1, bucketHash: 200, documentId: "doc-c" },
      { algoVersion: algo, bandIdx: 2, bucketHash: 999, documentId: "doc-d" },
    ]);
    // Doc-a's buckets: only band 0 matches → doc-b is a candidate.
    const buckets = new Uint32Array([100, 12345, 0]);
    const cands = store.findCandidates(algo, buckets, "doc-a");
    expect(cands).toEqual(["doc-b"]);
  });

  it("canonicalPairOrder sorts lex-min first", () => {
    expect(DupeStore.canonicalPairOrder("z", "a")).toEqual(["a", "z"]);
    expect(DupeStore.canonicalPairOrder("a", "z")).toEqual(["a", "z"]);
  });

  it("pair upsert is idempotent on (doc_a, doc_b, algo)", () => {
    const pair = {
      docA: "a",
      docB: "b",
      algoVersion: "v1",
      jaccard: 0.8,
      sigSimilarity: 0.79,
      runId: "run-1",
    };
    store.upsertPair(pair);
    store.upsertPair({ ...pair, jaccard: 0.9 });
    expect(store.countPairs("v1")).toBe(1);
    expect(store.countPairs("v1", 0.85)).toBe(1);
  });

  it("run lifecycle tracks counts", () => {
    store.beginRun({
      runId: "run-1",
      algoVersion: "v1",
      configJson: '{"k":5}',
      startedAt: 1700000000,
    });
    store.finishRun("run-1", 42, 7, "notes");
    const runs = store.listRuns();
    expect(runs.length).toBe(1);
    expect(runs[0].docsProcessed).toBe(42);
    expect(runs[0].pairsRecorded).toBe(7);
    expect(runs[0].finishedAt).not.toBeNull();
  });
});

describe("DupeStore.migrate (legacy pairs table)", () => {
  let path: string;

  beforeEach(() => {
    path = `/tmp/omnesis-dupes-migrate-${randomUUID()}.db`;
  });

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(path + suffix);
      } catch {
        // ignore
      }
    }
  });

  /**
   * Seed a DB at `path` with the pre-exclusivity `pairs` schema — the
   * shape older study DBs carry, before exclusivity / gate / annotation
   * columns existed — plus one legacy row.
   */
  function seedLegacyDb(): void {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE pairs (
        doc_a TEXT NOT NULL,
        doc_b TEXT NOT NULL,
        algo_version TEXT NOT NULL,
        jaccard REAL NOT NULL,
        sig_similarity REAL NOT NULL,
        run_id TEXT NOT NULL,
        PRIMARY KEY (doc_a, doc_b, algo_version)
      )
    `);
    db.prepare(
      `INSERT INTO pairs (doc_a, doc_b, algo_version, jaccard, sig_similarity, run_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("doc-a", "doc-b", "legacy-v1", 0.81, 0.8, "old-run");
    db.close();
  }

  const NEW_COLUMNS = [
    "intersection_size",
    "pair_unique_df2",
    "pair_unique_df5",
    "is_exact_dupe",
    "is_same_thread",
    "annotated_at",
    "gate_status",
    "gate_family",
  ] as const;

  function pairColumns(db: Database.Database): Set<string> {
    const cols = db.prepare(`PRAGMA table_info(pairs)`).all() as Array<{ name: string }>;
    return new Set(cols.map((c) => c.name));
  }

  it("adds every missing exclusivity/gate/annotation column on a legacy DB", () => {
    seedLegacyDb();

    // Sanity: the legacy table truly lacks the new columns before migration.
    const pre = new Database(path);
    const preCols = pairColumns(pre);
    for (const col of NEW_COLUMNS) expect(preCols.has(col)).toBe(false);
    pre.close();

    const store = new DupeStore(path);
    const postCols = pairColumns(store.db);
    for (const col of NEW_COLUMNS) expect(postCols.has(col)).toBe(true);

    // Pre-existing data survives the additive migration; new columns default null.
    const row = store.db
      .prepare(`SELECT jaccard, gate_status, annotated_at FROM pairs WHERE doc_a = 'doc-a'`)
      .get() as { jaccard: number; gate_status: string | null; annotated_at: number | null };
    expect(row.jaccard).toBeCloseTo(0.81, 6);
    expect(row.gate_status).toBeNull();
    expect(row.annotated_at).toBeNull();
    store.close();
  });

  it("is idempotent — re-opening a migrated DB does not throw or duplicate columns", () => {
    seedLegacyDb();

    const first = new DupeStore(path);
    const colCount1 = pairColumns(first.db).size;
    first.close();

    // Re-open twice more; a non-idempotent ALTER would throw "duplicate column".
    const second = new DupeStore(path);
    const colCount2 = pairColumns(second.db).size;
    second.close();
    const third = new DupeStore(path);
    const colCount3 = pairColumns(third.db).size;

    expect(colCount2).toBe(colCount1);
    expect(colCount3).toBe(colCount1);
    third.close();
  });
});
