// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type Database from "better-sqlite3";
import { createIndexDatabase, upsertChunks } from "../indexer/db.js";
import { LexicalIndex } from "./lexical-index.js";
import { fts5Tokenizer, type ChunkRow, type Fts5Tokenizer } from "./lexical-tokenizer.js";
import { closeTempDb } from "./test-utils.js";

let db: Database.Database;

beforeEach(() => {
  db = createIndexDatabase(`/tmp/omnesis-lexical-terms-${randomUUID()}.db`);
});

afterEach(() => closeTempDb(db));

function put(id: string, content: string, title = ""): void {
  upsertChunks(db, [
    {
      id,
      documentId: `document-${id}`,
      chunkIndex: 0,
      content,
      title,
      sourceId: "synthetic-notes",
      documentType: "note",
      sourceCreatedAt: "2026-01-01T00:00:00Z",
      embedding: null,
    },
  ]);
}

function sqliteTerms(terms: readonly string[]) {
  if (terms.length === 0) return [];
  const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  return db
    .prepare<[string], { rowid: number; score: number }>(
      `SELECT rowid, -bm25(chunks_fts, 1.0, 2.0) AS score
       FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score DESC, rowid LIMIT 20`,
    )
    .all(expression);
}

describe("already-analyzed lexical queries", () => {
  test("ranks separated analyzed terms instead of imposing an implicit phrase", () => {
    put("a", "blue garden");
    put("b", "whale observation");
    put("c", "blue whale mailbox");
    const index = LexicalIndex.build(db);
    expect(index.rank(db, "blue_whale", 20)).toBeNull();
    const terms = fts5Tokenizer(db).words(["blue_whale"])[0];
    expect(terms).toEqual(["blue", "whale"]);
    const actual = index.rankTerms(db, terms, 20)!;
    const expected = sqliteTerms(terms);
    expect(actual.map((row) => row.rowid)).toEqual(expected.map((row) => row.rowid));
    expect(actual).toHaveLength(3);
    actual.forEach((row, i) => expect(row.score).toBeCloseTo(expected[i].score, 10));
    expect(index.rankTerms(db, [], 20)).toEqual([]);
  });

  test("preserves repeated-term contributions and title weighting", () => {
    put("a", "running blue", "run");
    put("b", "runs running running", "blue whale");
    put("c", "garden observation", "mailbox");
    const index = LexicalIndex.build(db);
    const terms = ["run", "run", "blue"];
    const expected = sqliteTerms(terms);
    const actual = index.rankTerms(db, terms, 20)!;
    expect(actual.map((row) => row.rowid)).toEqual(expected.map((row) => row.rowid));
    actual.forEach((row, i) => expect(row.score).toBeCloseTo(expected[i].score, 10));
  });

  test("uses the injected document analysis for change-log deltas without reanalyzing queries", () => {
    put("a", "garden");
    put("b", "observatory");
    const analyzed: string[] = [];
    const tokenizer = (handle: Database.Database): Fts5Tokenizer => ({
      words() {
        throw new Error("Already-analyzed terms must not be tokenized again");
      },
      fold() {
        throw new Error("Term queries must not use prefix folding");
      },
      chunks(rows: readonly ChunkRow[]) {
        analyzed.push(...rows.map((row) => row.content ?? ""));
        return fts5Tokenizer(handle).chunks(rows);
      },
    });
    const index = LexicalIndex.build(db, { tokenizer });
    put("a", "running");
    const rowid = db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE id=?")
      .get("a")!.rowid;
    expect(index.rankTerms(db, ["run"], 20)?.map((row) => row.rowid)).toEqual([rowid]);
    expect(analyzed).toEqual(["running"]);
    put("a", "mailbox");
    expect(index.rankTerms(db, ["run"], 20)).toEqual([]);
    expect(index.rankTerms(db, ["mailbox"], 20)?.map((row) => row.rowid)).toEqual([rowid]);
    db.prepare("DELETE FROM chunks WHERE id=?").run("a");
    expect(index.rankTerms(db, ["mailbox"], 20)).toEqual([]);
  });

  test("declines compiled queries when its update budget requires a fallback", () => {
    put("a", "garden");
    const built = LexicalIndex.build(db);
    const index = new LexicalIndex(built.data, { maxDeltaPostings: 0 });
    put("b", "whale");
    expect(index.rankTerms(db, ["whale"], 20)).toBeNull();
    expect(index.declined).toBe(true);
    expect(sqliteTerms(["whale"])).toHaveLength(1);
  });
});
