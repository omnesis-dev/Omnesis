// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  upsertChunks,
  type ChunkUpsertInput,
} from "../indexer/db.js";
import { bm25Search } from "./bm25.js";
import { buildLexicalIndexData } from "./lexical-index-data.js";
import { LexicalIndexFollower } from "./lexical-index-follower.js";
import { closeTempDb } from "./test-utils.js";

let db: Db;
let follower: LexicalIndexFollower | undefined;

beforeEach(() => {
  db = createIndexDatabase(`/tmp/omnesis-lexical-follower-${randomUUID()}.db`);
});

afterEach(() => {
  follower?.stop();
  follower = undefined;
  vi.useRealTimers();
  closeTempDb(db);
});

function write(id: string, content: string): void {
  const input: ChunkUpsertInput = {
    id,
    documentId: id,
    chunkIndex: 0,
    content,
    embedding: new Float32Array(EMBEDDING_DIM).fill(0),
    sourceId: "notes",
    documentType: "note",
    title: "",
    sourceCreatedAt: "2026-03-10T00:00:00Z",
  };
  upsertChunks(db, [input]);
}

function rowids(query: string): number[] | null {
  const ranked = follower!.ranker!.rank(db, query, 50);
  return ranked && ranked.map((r) => r.rowid).sort((a, b) => a - b);
}

function rowidOf(id: string): number {
  return db.prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE id = ?").get(id)!
    .rowid;
}

describe("LexicalIndexFollower", () => {
  test("catches the ranker up between queries, so a query finds no change log to apply", () => {
    vi.useFakeTimers();
    write("a", "budget review");
    follower = new LexicalIndexFollower(db);
    follower.attach(buildLexicalIndexData(db));
    vi.advanceTimersByTime(0);
    for (let i = 0; i < 300; i++) write(`z${i}`, `zephyr sighting ${i}`);
    // The loop's next slices apply the 300 changes with no query involved.
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(0);
    const ranker = follower.ranker!;
    expect(ranker.follow(db, 25)).toBe(false);
    // Within the query path's read interval, the ranker reads no log, yet ranks every new chunk.
    expect(bm25Search(db, "zephyr", {}, 500, { ranker }).candidates).toHaveLength(300);
  });

  test("a query ranks in memory with the changes applied so far when a burst outruns its budget", () => {
    write("a", "budget review");
    follower = new LexicalIndexFollower(db, { idleMs: 60_000 });
    follower.attach(buildLexicalIndexData(db));
    follower.step();
    for (let i = 0; i < 600; i++) write(`z${i}`, `zephyr sighting ${i}`);
    const result = bm25Search(db, "zephyr budget", {}, 10, { ranker: follower.ranker });
    expect(result.ranker).toBe("memory");
    while (follower.step());
    const caughtUp = bm25Search(db, "zephyr budget", {}, 10_000, { ranker: follower.ranker });
    const viaFts = bm25Search(db, "zephyr budget", {}, 10_000, {});
    expect(caughtUp.ranker).toBe("memory");
    expect(caughtUp.candidates.map((c) => c.chunkRowid)).toEqual(
      viaFts.candidates.map((c) => c.chunkRowid),
    );
  });

  test("a fresh build serves at once when there is no ranker yet", () => {
    write("a", "budget review");
    follower = new LexicalIndexFollower(db, { idleMs: 60_000 });
    expect(follower.ranker).toBeUndefined();
    follower.attach(buildLexicalIndexData(db));
    expect(rowids("budget")).toEqual([rowidOf("a")]);
  });

  test("the current ranker keeps serving until a newer build has caught up, then hands over", () => {
    write("a", "budget review");
    follower = new LexicalIndexFollower(db, { idleMs: 60_000 });
    follower.attach(buildLexicalIndexData(db));
    const first = follower.ranker!;
    const rebuilt = buildLexicalIndexData(db);
    // Changes after the new build's snapshot, which it must apply before serving.
    write("b", "budget forecast");
    follower.attach(rebuilt);
    expect(follower.ranker).toBe(first);
    while (follower.step());
    expect(follower.ranker).not.toBe(first);
    expect(follower.ranker!.data).toBe(rebuilt);
    expect(rowids("budget")).toEqual([rowidOf("a"), rowidOf("b")]);
  });

  test("a declined ranker is replaced by the next build at once", () => {
    write("a", "budget review");
    follower = new LexicalIndexFollower(db, { idleMs: 60_000 });
    follower.attach(buildLexicalIndexData(db));
    write("b", "zephyr quokka");
    write("c", "marathon training");
    db.prepare(
      "DELETE FROM chunks_fts_changes WHERE seq <= (SELECT seq FROM chunks_fts_changes WHERE chunk_rowid = ?)",
    ).run(rowidOf("b"));
    follower.step();
    expect(follower.ranker!.declined).toBe(true);
    const rebuilt = buildLexicalIndexData(db);
    follower.attach(rebuilt);
    expect(follower.ranker!.data).toBe(rebuilt);
    expect(rowids("zephyr")).toEqual([rowidOf("b")]);
  });

  test("a newer build that declines while catching up is dropped and the current ranker serves on", () => {
    write("a", "budget review");
    follower = new LexicalIndexFollower(db, { idleMs: 60_000 });
    follower.attach(buildLexicalIndexData(db));
    const first = follower.ranker!;
    const rebuilt = buildLexicalIndexData(db);
    write("b", "zephyr quokka");
    write("c", "marathon training");
    // The current ranker applies both changes; the log then loses the newer
    // build's position before it reads it.
    follower.step();
    follower.attach(rebuilt);
    db.prepare(
      "DELETE FROM chunks_fts_changes WHERE seq <= (SELECT seq FROM chunks_fts_changes WHERE chunk_rowid = ?)",
    ).run(rowidOf("b"));
    follower.step();
    expect(follower.ranker).toBe(first);
    expect(first.declined).toBe(false);
    expect(rowids("zephyr")).toEqual([rowidOf("b")]);
  });

  test("stop ends the loop", () => {
    vi.useFakeTimers();
    write("a", "budget review");
    follower = new LexicalIndexFollower(db);
    follower.attach(buildLexicalIndexData(db));
    follower.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
