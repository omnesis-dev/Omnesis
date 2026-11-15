// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bm25Search } from "../search/bm25.js";
import { targetLexicalVersion } from "../search/lexical-versions.js";
import { LexicalIndex } from "../search/lexical-index.js";
import { createIndexDatabase, upsertChunks, type ChunkUpsertInput } from "./db.js";
import {
  lexicalIndexStatus,
  lexicalRebuildStep,
  readLexicalIndexState,
  switchLexicalIndex,
  type LexicalStep,
} from "./lexical-index-store.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const paths: string[] = [];
const dbs: Db[] = [];

function openDb(path = `/tmp/omnesis-lexical-store-${randomUUID()}.db`): Db {
  paths.push(path);
  const db = createIndexDatabase(path);
  dbs.push(db);
  return db;
}

function chunk(documentId: string, content: string, title = ""): ChunkUpsertInput {
  return {
    id: `${documentId}:0`,
    documentId,
    chunkIndex: 0,
    content,
    embedding: null,
    sourceId: "notes:test",
    title,
    sourceCreatedAt: "2026-03-10T00:00:00Z",
  };
}

const CORPUS: Array<[string, string]> = [
  ["d1", "quarterly budget review with the finance team"],
  ["d2", "marathon training plan for the spring"],
  ["d3", "dinner reservation at the riverside bistro"],
  ["d4", "budget spreadsheet for the studio renovation"],
  ["d5", "notes from the hiking trip to the lakes"],
  ["d6", "insurance renewal reminder for the car"],
];

function seed(db: Db): void {
  upsertChunks(
    db,
    CORPUS.map(([id, text]) => chunk(id, text)),
  );
}

function documentsMatching(db: Db, query: string): string[] {
  return bm25Search(db, query, {}, 10)
    .candidates.map((c) => c.documentId)
    .sort();
}

/** Every term of the active index with its document and occurrence counts. */
function vocabulary(db: Db): Array<{ term: string; doc: number; cnt: number }> {
  return db
    .prepare<[], { term: string; doc: number; cnt: number }>(
      "SELECT term, doc, cnt FROM chunks_fts_vocab ORDER BY term",
    )
    .all();
}

function runUntil(db: Db, wanted: LexicalStep, batchSize = 2): LexicalStep[] {
  const steps: LexicalStep[] = [];
  for (let i = 0; i < 100; i++) {
    const step = lexicalRebuildStep(db, { batchSize });
    steps.push(step);
    if (step === wanted) return steps;
    if (step === "idle") break;
  }
  throw new Error(`never reached ${wanted}: ${steps.join(", ")}`);
}

/** The version this build targets without a test override: what a real gateway rebuilds to. */
function current(): number {
  const saved = process.env.OMNESIS_LEXICAL_TEST_VERSION;
  delete process.env.OMNESIS_LEXICAL_TEST_VERSION;
  const version = targetLexicalVersion().version;
  if (saved !== undefined) process.env.OMNESIS_LEXICAL_TEST_VERSION = saved;
  return version;
}

function target(version: number | null): void {
  if (version === null) delete process.env.OMNESIS_LEXICAL_TEST_VERSION;
  else process.env.OMNESIS_LEXICAL_TEST_VERSION = String(version);
}

beforeEach(() => {
  // The test-only lexical versions are known only on a synthetic gateway.
  process.env.OMNESIS_SYNTHETIC = "1";
  target(null);
});

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(p + suffix, { force: true });
  }
  delete process.env.OMNESIS_SYNTHETIC;
  target(null);
});

describe("a new index database", () => {
  test("starts at the version this build targets, with nothing to rebuild", () => {
    const db = openDb();
    expect(readLexicalIndexState(db).active?.version).toBe(current());
    expect(lexicalRebuildStep(db, { batchSize: 10 })).toBe("idle");
    seed(db);
    expect(documentsMatching(db, "budget")).toEqual(["d1", "d4"]);
  });

  test("is created directly at a test version when that is the target", () => {
    target(9001);
    const db = openDb();
    expect(readLexicalIndexState(db).active?.version).toBe(9001);
    seed(db);
    // The index holds reversed words; the query is reversed the same way.
    expect(documentsMatching(db, "budget")).toEqual(["d1", "d4"]);
    const indexed = db
      .prepare<[], { n: number }>(
        "SELECT count(*) AS n FROM chunks_fts_vocab WHERE term = 'tegdub'",
      )
      .get()?.n;
    expect(indexed).toBe(1);
  });
});

describe("rebuilding to a new version", () => {
  test("keeps searching the old index until the switch, then the new one", () => {
    const db = openDb();
    seed(db);
    target(9001);

    expect(lexicalRebuildStep(db, { batchSize: 2 })).toBe("build-started");
    expect(lexicalRebuildStep(db, { batchSize: 2 })).toBe("backfilled-batch");
    const midway = lexicalIndexStatus(db);
    expect(midway).toMatchObject({
      activeVersion: current(),
      targetVersion: 9001,
      building: { version: 9001, chunksDone: 2, chunksTotal: 6, percent: 33, phase: "copying" },
    });
    // Mid-build, queries are cut by the active version and matched against its index.
    expect(documentsMatching(db, "budget")).toEqual(["d1", "d4"]);

    runUntil(db, "backfill-complete");
    expect(lexicalIndexStatus(db).building).toMatchObject({ percent: 100, phase: "switching" });
    expect(documentsMatching(db, "budget")).toEqual(["d1", "d4"]);

    expect(switchLexicalIndex(db, 9001)).toBe(true);
    expect(readLexicalIndexState(db).active?.version).toBe(9001);
    expect(readLexicalIndexState(db).build).toBeNull();
    expect(documentsMatching(db, "budget")).toEqual(["d1", "d4"]);

    // The old index waits as `chunks_fts_retired`, emptied a batch at a time,
    // then dropped.
    expect(lexicalRebuildStep(db, { batchSize: 2 })).toBe("retired-batch");
    const emptying = runUntil(db, "retired-dropped");
    expect(emptying.slice(0, -1).every((step) => step === "retired-batch")).toBe(true);
    expect(lexicalRebuildStep(db, { batchSize: 2 })).toBe("idle");
    // SQLite again refuses direct writes to an index's storage.
    expect(() => db.exec("DELETE FROM chunks_fts_data")).toThrow(/may not be modified/);
    const leftovers = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE name LIKE 'chunks_fts_retired%' OR name LIKE 'chunks_fts_next%'",
      )
      .all();
    expect(leftovers).toEqual([]);
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
  });

  test("chunks written during the build end up exactly as in a fresh build", () => {
    const db = openDb();
    seed(db);
    target(9001);
    expect(lexicalRebuildStep(db, { batchSize: 2 })).toBe("build-started");
    expect(lexicalRebuildStep(db, { batchSize: 2 })).toBe("backfilled-batch");
    // The cursor is past d1 and d2. Change one chunk on each side of it, add a
    // chunk past the high-water mark, and delete one of each.
    upsertChunks(db, [chunk("d1", "quarterly budget forecast with the board")]);
    upsertChunks(db, [chunk("d5", "notes from the cycling trip to the coast")]);
    upsertChunks(db, [chunk("d7", "budget approval for the new studio lights")]);
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run("d2");
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run("d6");
    runUntil(db, "backfill-complete");
    // More writes after the backfill, before the switch.
    upsertChunks(db, [chunk("d8", "budget meeting moved to friday")]);
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run("d3");
    expect(switchLexicalIndex(db, 9001)).toBe(true);
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");

    // A database built at 9001 from the final chunks holds the same index.
    const freshTarget = openDb();
    upsertChunks(
      freshTarget,
      db
        .prepare<[], { document_id: string; content: string }>(
          "SELECT document_id, content FROM chunks ORDER BY document_id",
        )
        .all()
        .map((r) => chunk(r.document_id, r.content)),
    );
    expect(readLexicalIndexState(freshTarget).active?.version).toBe(9001);
    expect(vocabulary(db)).toEqual(vocabulary(freshTarget));
    expect(documentsMatching(db, "budget")).toEqual(["d1", "d4", "d7", "d8"]);
    expect(documentsMatching(db, "cycling")).toEqual(["d5"]);
    expect(documentsMatching(db, "marathon")).toEqual([]);
  });

  test("resumes from its cursor after the database is reopened", () => {
    const path = `/tmp/omnesis-lexical-store-${randomUUID()}.db`;
    const first = openDb(path);
    seed(first);
    target(9001);
    lexicalRebuildStep(first, { batchSize: 2 });
    lexicalRebuildStep(first, { batchSize: 2 });
    lexicalRebuildStep(first, { batchSize: 2 });
    expect(readLexicalIndexState(first).build).toMatchObject({ done: 4, cursor: 4 });
    first.close();
    dbs.splice(dbs.indexOf(first), 1);

    const reopened = openDb(path);
    expect(readLexicalIndexState(reopened).build).toMatchObject({ version: 9001, done: 4 });
    expect(lexicalRebuildStep(reopened, { batchSize: 2 })).toBe("backfill-complete");
    expect(switchLexicalIndex(reopened, 9001)).toBe(true);
    reopened.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
    expect(documentsMatching(reopened, "budget")).toEqual(["d1", "d4"]);
  });

  test("a newer target discards an unfinished build and starts over", () => {
    const db = openDb();
    seed(db);
    target(9001);
    runUntil(db, "backfilled-batch");
    target(9002);
    expect(lexicalRebuildStep(db, { batchSize: 2 })).toBe("stale-build-dropped");
    // The discarded build is emptied and dropped before the new one starts.
    expect(lexicalIndexStatus(db).retiring).toBe(true);
    runUntil(db, "retired-dropped");
    expect(lexicalRebuildStep(db, { batchSize: 2 })).toBe("build-started");
    expect(readLexicalIndexState(db).build).toMatchObject({ version: 9002, done: 0 });
    // The superseded build's switch is refused.
    expect(switchLexicalIndex(db, 9001)).toBe(false);
    runUntil(db, "backfill-complete");
    expect(switchLexicalIndex(db, 9002)).toBe(true);
    expect(readLexicalIndexState(db).active?.version).toBe(9002);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'chunks_lexical_v9001'").get(),
    ).toBeUndefined();
  });

  test("a build is dropped when the active index already matches the target", () => {
    const db = openDb();
    seed(db);
    target(9001);
    runUntil(db, "backfilled-batch");
    target(null);
    expect(lexicalRebuildStep(db, { batchSize: 2 })).toBe("stale-build-dropped");
    runUntil(db, "retired-dropped");
    expect(lexicalRebuildStep(db, { batchSize: 2 })).toBe("idle");
    expect(readLexicalIndexState(db).build).toBeNull();
    // Chunk writes no longer touch the dropped build.
    upsertChunks(db, [chunk("d9", "budget notes")]);
    expect(documentsMatching(db, "budget")).toEqual(["d1", "d4", "d9"]);
  });

  test("an index built by a version this build does not know is rebuilt to the target", () => {
    target(9001);
    const db = openDb();
    seed(db);
    // Forget the test versions, as a release without them would.
    delete process.env.OMNESIS_SYNTHETIC;
    target(null);
    const state = readLexicalIndexState(db);
    expect(state.active).toMatchObject({ version: 9001 });
    expect(state.active?.rewrite).toBeUndefined();
    runUntil(db, "backfill-complete");
    expect(switchLexicalIndex(db, current())).toBe(true);
    expect(documentsMatching(db, "budget")).toEqual(["d1", "d4"]);
  });

  test("after a downgrade, an index this build cannot maintain stays as it was until it is replaced", () => {
    const path = `/tmp/omnesis-lexical-store-${randomUUID()}.db`;
    target(9001);
    const newer = openDb(path);
    seed(newer);
    newer.close();
    dbs.splice(dbs.indexOf(newer), 1);
    // A release without version 9001, which rewrites text, opens the database.
    delete process.env.OMNESIS_SYNTHETIC;
    target(null);

    const db = openDb(path);
    expect(readLexicalIndexState(db).active?.version).toBe(9001);
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('chunks_ai', 'chunks_ad', 'chunks_au')",
      )
      .all();
    expect(triggers).toEqual([]);
    // Chunk writes leave the index untouched rather than misindexing them.
    const before = vocabulary(db);
    upsertChunks(db, [chunk("d9", "budget notes for the spring")]);
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run("d1");
    expect(vocabulary(db)).toEqual(before);

    runUntil(db, "backfill-complete");
    expect(switchLexicalIndex(db, current())).toBe(true);
    runUntil(db, "retired-dropped");
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
    expect(documentsMatching(db, "budget")).toEqual(["d4", "d9"]);
  });

  test("an existing index gets the current trigger shape when it opens", () => {
    const path = `/tmp/omnesis-lexical-store-${randomUUID()}.db`;
    const first = openDb(path);
    seed(first);
    // The update trigger as older releases created it: it fires on any update.
    first.exec(`
      DROP TRIGGER chunks_au;
      CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content, title)
        VALUES ('delete', old.rowid, old.content, old.title);
        INSERT INTO chunks_fts(rowid, content, title) VALUES (new.rowid, new.content, new.title);
      END;
    `);
    first.close();
    dbs.splice(dbs.indexOf(first), 1);

    const reopened = openDb(path);
    const sql = (
      reopened.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_au'").get() as {
        sql: string;
      }
    ).sql;
    expect(sql).toMatch(/AFTER UPDATE ON chunks WHEN /);
    upsertChunks(reopened, [chunk("d1", "budget review moved to monday")]);
    reopened.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
    expect(documentsMatching(reopened, "monday")).toEqual(["d1"]);
  });

  test("the switch refuses a build that has not finished copying", () => {
    const db = openDb();
    seed(db);
    target(9001);
    runUntil(db, "backfilled-batch");
    expect(switchLexicalIndex(db, 9001)).toBe(false);
    expect(readLexicalIndexState(db).active?.version).toBe(current());
  });
});

describe("a restored database", () => {
  test("indexes chunks that arrived without a full-text index, and drops stale triggers", () => {
    const path = `/tmp/omnesis-lexical-store-${randomUUID()}.db`;
    const original = openDb(path);
    seed(original);
    target(9001);
    runUntil(original, "backfilled-batch");
    // What a restore leaves: chunks and their triggers, no derived index.
    original.exec(`
      DROP TABLE chunks_fts_vocab;
      DROP TABLE chunks_fts;
      DROP TABLE chunks_fts_next;
      DROP TABLE lexical_index_state;
    `);
    original.close();
    dbs.splice(dbs.indexOf(original), 1);
    target(null);

    const restored = openDb(path);
    expect(readLexicalIndexState(restored)).toMatchObject({
      active: { version: current() },
      build: null,
    });
    expect(documentsMatching(restored, "budget")).toEqual(["d1", "d4"]);
    // Chunk writes succeed: no trigger points at a missing index.
    upsertChunks(restored, [chunk("d9", "budget notes")]);
    expect(documentsMatching(restored, "budget")).toEqual(["d1", "d4", "d9"]);
    restored.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
  });
});

describe("a restored database with an unfinished build", () => {
  test("sets the build aside and can start a new one", () => {
    const path = `/tmp/omnesis-lexical-store-${randomUUID()}.db`;
    const original = openDb(path);
    seed(original);
    target(9001);
    runUntil(original, "backfilled-batch");
    // Only the active index is missing; the build's table, triggers and state remain.
    original.exec("DROP TABLE chunks_fts_vocab; DROP TABLE chunks_fts;");
    original.close();
    dbs.splice(dbs.indexOf(original), 1);
    target(null);

    const restored = openDb(path);
    expect(readLexicalIndexState(restored).build).toBeNull();
    upsertChunks(restored, [chunk("d9", "budget notes")]);
    expect(documentsMatching(restored, "budget")).toEqual(["d1", "d4", "d9"]);
    runUntil(restored, "retired-dropped");
    target(9001);
    expect(lexicalRebuildStep(restored, { batchSize: 2 })).toBe("build-started");
    runUntil(restored, "backfill-complete");
    expect(switchLexicalIndex(restored, 9001)).toBe(true);
    expect(documentsMatching(restored, "budget")).toEqual(["d1", "d4", "d9"]);
  });
});

describe("in-memory indexes across a switch", () => {
  test("each answers by its own version, before and after the switch", () => {
    const db = openDb();
    seed(db);
    const oldRanker = LexicalIndex.build(db);
    const old = current();
    expect(oldRanker.rules.version).toBe(old);
    target(9001);
    runUntil(db, "backfill-complete");
    const newRanker = LexicalIndex.build(db, { source: "building" });
    expect(newRanker.rules.version).toBe(9001);

    const search = (ranker?: LexicalIndex) => {
      const result = bm25Search(db, "budget", {}, 10, ranker ? { ranker } : {});
      return {
        ranker: result.ranker,
        version: result.lexicalVersion,
        docs: result.candidates.map((c) => c.documentId).sort(),
      };
    };
    // Before the switch: the new index answers by its rules already.
    expect(search(newRanker)).toEqual({ ranker: "memory", version: 9001, docs: ["d1", "d4"] });
    expect(search()).toEqual({ ranker: "fts5", version: old, docs: ["d1", "d4"] });

    expect(switchLexicalIndex(db, 9001)).toBe(true);
    upsertChunks(db, [chunk("d9", "budget for the winter retreat")]);

    // After it: the old in-memory index still cuts queries and new chunks by
    // its version, the new one by 9001, and FTS5 by the active version.
    expect(search(oldRanker)).toEqual({ ranker: "memory", version: old, docs: ["d1", "d4", "d9"] });
    expect(search(newRanker)).toEqual({
      ranker: "memory",
      version: 9001,
      docs: ["d1", "d4", "d9"],
    });
    expect(search()).toEqual({ ranker: "fts5", version: 9001, docs: ["d1", "d4", "d9"] });
  });
});
