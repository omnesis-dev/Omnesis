// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keyword search across scripts, through the real index: the triggers analyze
 * what is stored, the query compiler analyzes what is asked, and the SQLite and
 * in-memory rankers must agree on the outcome.
 */

import { randomUUID } from "node:crypto";
import { join as fixtureJoin } from "node:path";
import { tmpdir as fixtureTmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createIndexDatabase,
  deleteChunksByDocument,
  EMBEDDING_DIM,
  upsertChunks,
  type ChunkUpsertInput,
} from "../indexer/db.js";
import { lexicalRebuildStep, switchLexicalIndex } from "../indexer/lexical-index-store.js";
import { bm25Search } from "./bm25.js";
import { LexicalIndex } from "./lexical-index.js";
import { closeTempDb } from "./test-utils.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;

beforeEach(() => {
  db = createIndexDatabase(
    fixtureJoin(fixtureTmpdir(), `omnesis-lexical-multilingual-${randomUUID()}.db`),
  );
});

afterEach(() => {
  closeTempDb(db);
});

function chunk(documentId: string, content: string, title = ""): ChunkUpsertInput {
  return {
    id: `chunk-${documentId}`,
    documentId,
    chunkIndex: 0,
    content,
    embedding: new Float32Array(EMBEDDING_DIM).fill(0),
    sourceId: "notes",
    documentType: "note",
    title,
    sourceCreatedAt: "2026-03-10T00:00:00Z",
  };
}

/** Document ids in ranked order from the SQLite ranker and the in-memory one. */
function search(query: string): { fts: string[]; memory: string[] | null } {
  const fts = bm25Search(db, query, {}, 10).candidates.map((c) => c.documentId);
  const viaMemory = bm25Search(db, query, {}, 10, { ranker: LexicalIndex.build(db) });
  const memory =
    viaMemory.ranker === "memory" ? viaMemory.candidates.map((c) => c.documentId) : null;
  return { fts, memory };
}

const CORPUS: ChunkUpsertInput[] = [
  chunk("zh-library", "我昨天在图书馆借了三本书"),
  chunk("zh-weather", "今天的天气非常好，我们去公园散步"),
  chunk("ja-meeting", "明日の会議は午後三時に始まります"),
  chunk("ja-station", "東京駅で友達と待ち合わせをしました"),
  chunk("th-market", "ฉันไปตลาดเมื่อวานนี้เพื่อซื้อผลไม้"),
  chunk("hi-books", "किताबें मेज़ पर रखी हैं"),
  chunk("hi-rain", "आज बहुत तेज़ बारिश हो रही है"),
  chunk("ko-mailbox", "파란고래우체통입니다"),
  chunk("ko-postoffice", "파란고래우체국입니다"),
  chunk("ko-ticket", "어제 승차권을 예매했습니다"),
  chunk("ar-name", "كتب مُحَمَّد رسالة طويلة"),
  chunk("en-budget", "The quarterly budget review covers the marathon entry forms"),
  chunk("fr-school", "Nous avons visité l’école après la cérémonie"),
];

describe("keyword search across scripts", () => {
  beforeEach(() => {
    upsertChunks(db, CORPUS);
  });

  test.each([
    ["图书馆", "zh-library"],
    ["公园", "zh-weather"],
    ["会議", "ja-meeting"],
    ["東京駅", "ja-station"],
    ["ตลาด", "th-market"],
    ["किताबें", "hi-books"],
    ["बारिश", "hi-rain"],
    ["승차권", "ko-ticket"],
    ["محمد", "ar-name"],
    ["budgets", "en-budget"],
    ["ecole", "fr-school"],
    ["ceremonie", "fr-school"],
  ])("%s finds %s with both rankers", (query, expected) => {
    const { fts, memory } = search(query);
    expect(fts[0]).toBe(expected);
    expect(memory?.[0]).toBe(expected);
  });

  test("a Korean noun ranks the document that holds all of it first", () => {
    const { fts, memory } = search("파란고래우체통");
    expect(fts.slice(0, 2)).toEqual(["ko-mailbox", "ko-postoffice"]);
    expect(memory?.slice(0, 2)).toEqual(["ko-mailbox", "ko-postoffice"]);
  });

  test("a quoted Korean phrase matches only the document that contains it", () => {
    expect(search('"고래우체통"').fts).toEqual(["ko-mailbox"]);
  });

  test("a quoted Chinese phrase matches adjacent words only", () => {
    expect(search('"图书馆借了"').fts).toEqual(["zh-library"]);
    expect(search('"图书馆散步"').fts).toEqual([]);
  });

  test("a sentence in an unspaced script is searched as words, not as one phrase", () => {
    // Words from two different documents: a phrase would match neither.
    const { fts, memory } = search("图书馆公园");
    expect([...fts].sort()).toEqual(["zh-library", "zh-weather"]);
    expect([...(memory ?? [])].sort()).toEqual(["zh-library", "zh-weather"]);
  });

  test("a deleted document leaves no terms behind", () => {
    deleteChunksByDocument(db, "ko-mailbox");
    deleteChunksByDocument(db, "zh-library");
    // The post-office document still shares one syllable pair with the query.
    expect(search("우체통").fts).toEqual(["ko-postoffice"]);
    expect(search("图书馆").fts).toEqual([]);
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('integrity-check')");
  });

  test("a rebuild from the stored text gives the same index", () => {
    const before = db.prepare("SELECT term, doc, cnt FROM chunks_fts_vocab ORDER BY term").all();
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    const after = db.prepare("SELECT term, doc, cnt FROM chunks_fts_vocab ORDER BY term").all();
    expect(after).toEqual(before);
  });
});

describe("an index built by version 0", () => {
  test("keeps answering by version 0 until its version 1 rebuild switches in", () => {
    const path = fixtureJoin(fixtureTmpdir(), `omnesis-lexical-multilingual-${randomUUID()}.db`);
    const first = createIndexDatabase(path);
    upsertChunks(first, [chunk("zh-library", "我昨天在图书馆借了三本书")]);
    // What an install from before version 1 holds: version 0's index.
    first.exec(`
      DROP TRIGGER chunks_ai; DROP TRIGGER chunks_ad; DROP TRIGGER chunks_au;
      DROP TABLE chunks_fts_vocab; DROP TABLE chunks_fts;
      DELETE FROM lexical_index_state;
      CREATE VIRTUAL TABLE chunks_fts USING fts5(content, title, content='chunks',
        content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2');
      INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
    `);
    first.close();

    const reopened = createIndexDatabase(path);
    try {
      const find = () => bm25Search(reopened, "图书馆", {}, 10);
      // Version 0 holds the whole sentence as one token: the word is not found.
      expect(find()).toMatchObject({ lexicalVersion: 0, candidates: [] });
      while (lexicalRebuildStep(reopened, { batchSize: 10 }) !== "backfill-complete");
      expect(find().lexicalVersion).toBe(0);
      expect(switchLexicalIndex(reopened, 1)).toBe(true);
      const after = find();
      expect(after.lexicalVersion).toBe(1);
      expect(after.candidates.map((c) => c.documentId)).toEqual(["zh-library"]);
    } finally {
      closeTempDb(reopened);
    }
  });
});
