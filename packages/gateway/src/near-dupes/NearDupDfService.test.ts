// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import {
  buildInMemoryDfFromTable,
  computeNearDupDfSnapshot,
  fetchDfDocChunk,
  nearDupFileLikeDocsSince,
  ShingleDfAccumulator,
} from "./NearDupDfService.js";
import { extractDfChunk } from "./NearDupDfCpu.js";
import {
  applyNearDupDfFromStaging,
  applyNearDupDfSnapshot,
  DF_APPLY_CHUNK_SIZE,
} from "./NearDupWriterOps.js";
import { setActiveAlgoVersion, setDfBuiltAt } from "./meta.js";
import type { Db } from "../data/types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-near-dup-df-svc-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
  // Match the gateway journal while retaining fully synchronized commits.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedDf(algo: string, rows: Array<[string, number]>): void {
  const stmt = db.prepare("INSERT INTO near_dup_df (algo_version, shingle, df) VALUES (?, ?, ?)");
  for (const [shingle, df] of rows) stmt.run(algo, shingle, df);
}

describe("ShingleDfAccumulator", () => {
  test("sums counts across batches, prunes below minDf, reports unique count", () => {
    const acc = new ShingleDfAccumulator();
    acc.add([
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ]);
    acc.add([
      ["b", 1],
      ["c", 2],
      ["d", 1],
    ]);
    // a=1, b=2, c=3, d=1
    expect(acc.uniqueCount()).toBe(4);
    const entries = acc.entries(2).sort((x, y) => x.shingle.localeCompare(y.shingle));
    expect(entries).toEqual([
      { shingle: "b", df: 2 },
      { shingle: "c", df: 3 },
    ]);
    // Threshold is inclusive (df >= minDf): at minDf=3, b (df=2) is pruned.
    expect(acc.entries(3)).toEqual([{ shingle: "c", df: 3 }]);
    acc.close();
  });

  test("an empty batch is a no-op", () => {
    const acc = new ShingleDfAccumulator();
    acc.add([]);
    expect(acc.uniqueCount()).toBe(0);
    expect(acc.entries(1)).toEqual([]);
    acc.close();
  });
});

describe("buildInMemoryDfFromTable — caching", () => {
  test("loads df + totalDocs from the table", () => {
    setActiveAlgoVersion(db, "v1");
    setDfBuiltAt(db, "v1", 42, 3, 1700000000);
    seedDf("v1", [
      ["alpha bravo charlie delta echo", 5],
      ["foxtrot golf hotel india juliet", 2],
      ["kilo lima mike november oscar", 9],
    ]);
    const loaded = buildInMemoryDfFromTable(db, "v1");
    expect(loaded.totalDocs).toBe(42);
    expect(loaded.size()).toBe(3);
    expect(loaded.df("alpha bravo charlie delta echo")).toBe(5);
    expect(loaded.df("foxtrot golf hotel india juliet")).toBe(2);
    expect(loaded.df("not-in-table")).toBe(0);
  });

  test("returns the same object on consecutive calls when built_at is unchanged (cache hit)", () => {
    setActiveAlgoVersion(db, "v1");
    setDfBuiltAt(db, "v1", 10, 1, 1700000000);
    seedDf("v1", [["the quick brown fox jumps", 2]]);
    const a = buildInMemoryDfFromTable(db, "v1");
    const b = buildInMemoryDfFromTable(db, "v1");
    // Same object reference: the cache must NOT reload the table on
    // every tick of the compute drip. The whole point is to avoid
    // re-allocating a ~100MB Map every 2 seconds in steady state.
    expect(b).toBe(a);
  });

  test("invalidates when built_at changes (fresh DF apply)", () => {
    setActiveAlgoVersion(db, "v1");
    setDfBuiltAt(db, "v1", 10, 1, 1700000000);
    seedDf("v1", [["original shingle one two three", 2]]);
    const before = buildInMemoryDfFromTable(db, "v1");
    expect(before.df("original shingle one two three")).toBe(2);

    // Simulate a fresh DF apply: wipe + reinsert + new built_at.
    db.exec("DELETE FROM near_dup_df WHERE algo_version='v1'");
    seedDf("v1", [["replacement shingle four five six", 7]]);
    setDfBuiltAt(db, "v1", 11, 1, 1700001000);

    const after = buildInMemoryDfFromTable(db, "v1");
    expect(after).not.toBe(before);
    expect(after.df("original shingle one two three")).toBe(0);
    expect(after.df("replacement shingle four five six")).toBe(7);
  });

  test("isolates caches across distinct db handles (no cross-test bleed)", () => {
    setActiveAlgoVersion(db, "v1");
    setDfBuiltAt(db, "v1", 5, 1, 1700000000);
    seedDf("v1", [["handle-a shingle here for test", 3]]);
    const fromA = buildInMemoryDfFromTable(db, "v1");

    // Brand-new handle on a separate temp DB — must NOT share the
    // cache. (WeakMap<Db, CachedDf> guarantees this; a module-level
    // `let dfCache` would leak.)
    const dir2 = mkdtempSync(join(tmpdir(), "omnesis-near-dup-df-svc-iso-"));
    const dbB = new Database(join(dir2, "omnesis.db")) as unknown as Db;
    try {
      dbB.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
      runSchemaSetup(dbB);
      runMigrations(dbB);
      setActiveAlgoVersion(dbB, "v1");
      setDfBuiltAt(dbB, "v1", 99, 1, 1700000000);
      const stmt = dbB.prepare(
        "INSERT INTO near_dup_df (algo_version, shingle, df) VALUES (?, ?, ?)",
      );
      stmt.run("v1", "handle-b shingle distinct from a", 11);
      const fromB = buildInMemoryDfFromTable(dbB, "v1");
      expect(fromB).not.toBe(fromA);
      expect(fromB.totalDocs).toBe(99);
      expect(fromB.df("handle-b shingle distinct from a")).toBe(11);
      expect(fromB.df("handle-a shingle here for test")).toBe(0);
    } finally {
      dbB.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("DF build equivalence — staging pipeline vs the in-memory one", () => {
  const ALGO = "equiv-algo-v1";

  /** A corpus with shared phrasing, so most shingles survive the prune. */
  function seedCorpus(target: Db, count: number): void {
    const stmt = target.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = "2026-01-01T00:00:00Z";
    for (let n = 0; n < count; n++) {
      // Shared boilerplate plus a per-document tail: the shared runs reach
      // df >= 2 and survive, the tails are singletons and are pruned.
      const content =
        `invoice for studio rental covering the agreed period and the agreed rate ` +
        `with the usual terms attached for reference number ${n} ` +
        `unique tail phrase ${n} ${n * 7} ${n * 13}`;
      stmt.run(
        `doc-${String(n).padStart(4, "0")}`,
        "prov",
        "src",
        `ext-${n}`,
        `Title ${n}`,
        content,
        `hash-${n}`,
        JSON.stringify({ documentType: "document" }),
        now,
        now,
        now,
        now,
      );
    }
  }

  function dfRows(target: Db): Array<{ shingle: string; df: number }> {
    // The live generation only — the same rows a reader gets. Summing
    // every generation would hide a build that landed in two of them, or
    // one still on disk waiting for the sweep.
    return target
      .prepare<[string, string], { shingle: string; df: number }>(
        `SELECT shingle, df FROM near_dup_df
          WHERE algo_version = ?
            AND generation = (SELECT live_generation FROM near_dup_df_meta WHERE algo_version = ?)
          ORDER BY shingle`,
      )
      .all(ALGO, ALGO);
  }

  // The whole point of the rework is that the rows never become JavaScript
  // values. That is a change of pipeline, not of algorithm, so the table it
  // produces must be identical — this compares the two, row for row, on the
  // same corpus, with paging small enough to exercise the cursor.
  test("produces exactly the table the array-sourced apply produced", async () => {
    const docCount = 40;
    const pageSize = 7; // forces six pages plus a short final one
    const minDf = 2;

    seedCorpus(db, docCount);
    setActiveAlgoVersion(db, ALGO);

    const config = {
      algorithm: { shingleSize: 5, stripQuotes: true, algoVersion: ALGO },
      eligibleDocTypes: new Set(["document"]),
      minContentLength: 10,
      maxContentLength: 2_000_000,
    } as unknown as Parameters<typeof computeNearDupDfSnapshot>[1];

    // Reference: the single-threaded computation, applied from an array.
    const snapshot = computeNearDupDfSnapshot(db, config);
    applyNearDupDfSnapshot(db, snapshot, 0);
    const expected = dfRows(db);
    expect(expected.length).toBeGreaterThan(10);

    // Same corpus, second database, built the way the task now builds it:
    // page by keyset, shingle per document, accumulate into a file, and let
    // the writer attach that file.
    const otherDir = mkdtempSync(join(tmpdir(), "omnesis-near-dup-df-equiv-"));
    const other = new Database(join(otherDir, "omnesis.db")) as unknown as Db;
    try {
      other.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
      runSchemaSetup(other);
      runMigrations(other);
      seedCorpus(other, docCount);
      setActiveAlgoVersion(other, ALGO);

      const stagingPath = join(otherDir, "staging.sqlite");
      const accum = new ShingleDfAccumulator(stagingPath, null);
      let totalDocs = 0;
      let afterId: string | null = null;
      for (;;) {
        const page = fetchDfDocChunk(
          other,
          new Set(["document"]),
          10,
          2_000_000,
          afterId,
          pageSize,
        );
        if (page.length === 0) break;
        afterId = page[page.length - 1].id;
        const pending: Array<[string, number]> = [];
        for (const row of page) {
          const result = extractDfChunk({
            contents: [row.content],
            shingleSize: 5,
            stripQuotes: true,
          });
          totalDocs += result.docsProcessed;
          for (const pair of result.shingleCounts) pending.push(pair);
        }
        accum.add(pending);
      }
      accum.checkpoint();
      accum.close({ deleteFile: false });

      expect(totalDocs).toBe(snapshot.totalDocs);

      const applied = applyNearDupDfFromStaging(other, {
        stagingPath,
        algoVersion: ALGO,
        totalDocs,
        minDf,
        capturedVersion: 0,
        expectedRows: expected.length,
      });
      expect(applied.done).toBe(true);
      expect(applied.rebuilt).toBe(expected.length);
      expect(dfRows(other)).toEqual(expected);
    } finally {
      other.close();
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("an interrupted apply resumes without duplicating or losing rows", () => {
    const stagingPath = join(dir, "resume-staging.sqlite");
    const accum = new ShingleDfAccumulator(stagingPath, null);
    // More rows than one apply chunk holds, so the yield lands between two.
    const rowCount = DF_APPLY_CHUNK_SIZE + 25;
    accum.add(
      Array.from({ length: rowCount }, (_, n) => [`shingle-${String(n).padStart(6, "0")}`, 2]),
    );
    accum.add([["singleton", 1]]);
    accum.checkpoint();
    accum.close({ deleteFile: false });

    let calls = 0;
    const token = { requested: () => ++calls > 1 };
    const first = applyNearDupDfFromStaging(
      db,
      {
        stagingPath,
        algoVersion: ALGO,
        totalDocs: 5,
        minDf: 2,
        capturedVersion: 0,
        expectedRows: rowCount,
      },
      { afterShingle: null, applied: 0 },
      { token },
    );
    expect(first.done).toBe(false);

    const second = applyNearDupDfFromStaging(
      db,
      {
        stagingPath,
        algoVersion: ALGO,
        totalDocs: 5,
        minDf: 2,
        capturedVersion: 0,
        expectedRows: rowCount,
      },
      // Carrying the generation is what the writer handler does; without it
      // the tail of this build lands in a generation after its head.
      {
        afterShingle: first.nextAfterShingle,
        applied: first.rebuilt,
        generation: first.generation,
      },
    );
    expect(second.done).toBe(true);

    const rows = dfRows(db);
    expect(rows).toHaveLength(rowCount);
    // No duplicates across the resume boundary, and the singleton stayed out.
    expect(new Set(rows.map((r) => r.shingle)).size).toBe(rowCount);
    expect(rows.some((r) => r.shingle === "singleton")).toBe(false);
  });
});

describe("nearDupFileLikeDocsSince", () => {
  const FILE_LIKE = ["attachment", "file", "document"];

  function seed(id: string, documentType: string, ingestedAt: string): void {
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'prov', 'src', ?, ?, 'body', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      id,
      `Title ${id}`,
      `hash-${id}`,
      JSON.stringify({ documentType }),
      ingestedAt,
      ingestedAt,
      ingestedAt,
      ingestedAt,
    );
  }

  /** Unix seconds for an ISO instant, the unit the trigger passes in. */
  function at(iso: string): number {
    return Math.floor(Date.parse(iso) / 1000);
  }

  test("is false on a corpus with nothing newer than the build", () => {
    seed("f1", "file", "2026-01-01T00:00:00Z");
    expect(nearDupFileLikeDocsSince(db, at("2026-02-01T00:00:00Z"), FILE_LIKE)).toBe(false);
  });

  test("is true once a file-like document arrives after the build", () => {
    seed("f1", "file", "2026-01-01T00:00:00Z");
    seed("f2", "attachment", "2026-03-01T00:00:00Z");
    expect(nearDupFileLikeDocsSince(db, at("2026-02-01T00:00:00Z"), FILE_LIKE)).toBe(true);
  });

  test("ignores a new document that is not file-like", () => {
    // Mail and messages still take part in detection; they just do not make
    // the corpus-wide weighting worth rebuilding on their own.
    seed("m1", "email", "2026-03-01T00:00:00Z");
    expect(nearDupFileLikeDocsSince(db, at("2026-02-01T00:00:00Z"), FILE_LIKE)).toBe(false);
  });

  test("asks when the install received the document, not when it was authored", () => {
    // A long-archived file synced today is new material for the statistic.
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('old', 'prov', 'src', 'old', 'Old file', 'body', 'h-old', ?, '2019-05-05T00:00:00Z', '2019-05-05T00:00:00Z', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z')`,
    ).run(JSON.stringify({ documentType: "file" }));
    expect(nearDupFileLikeDocsSince(db, at("2026-02-01T00:00:00Z"), FILE_LIKE)).toBe(true);
  });
});
