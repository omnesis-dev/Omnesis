// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  enqueueDocumentIndexPurge,
  openIndexDb,
  upsertChunks,
  type ChunkUpsertInput,
} from "../indexer/db.js";
import { bm25Search, type LexicalRanker } from "./bm25.js";
import { LexicalIndex } from "./lexical-index.js";
import { closeTempDb } from "./test-utils.js";

let db: Db;

beforeEach(() => {
  db = createIndexDatabase(`/tmp/omnesis-lexical-index-${randomUUID()}.db`);
});

afterEach(() => {
  closeTempDb(db);
});

function chunk(
  overrides: Partial<ChunkUpsertInput> & { id: string; documentId: string },
): ChunkUpsertInput {
  return {
    chunkIndex: 0,
    content: "",
    embedding: new Float32Array(EMBEDDING_DIM).fill(0),
    sourceId: "gmail",
    documentType: "email",
    title: "",
    sourceCreatedAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

const WORDS = [
  "budget",
  "review",
  "quarterly",
  "the",
  "a",
  "marathon",
  "training",
  "invoice",
  "studio",
  "northstar",
  "running",
  "runs",
  "café",
  "résumé",
  "meeting",
  "notes",
];

/** A deterministic corpus with skewed word frequencies, titles and accents. */
function seedCorpus(count: number): void {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const pick = () => WORDS[Math.floor(rnd() ** 2 * WORDS.length)];
  const rows: ChunkUpsertInput[] = [];
  for (let i = 0; i < count; i++) {
    const body = Array.from({ length: 5 + Math.floor(rnd() * 40) }, pick).join(" ");
    const title = Array.from({ length: 1 + Math.floor(rnd() * 3) }, pick).join(" ");
    rows.push(
      chunk({
        id: `c${i}`,
        documentId: `d${i}`,
        content: body,
        title,
        sourceId: i % 5 === 0 ? "notes" : "gmail",
      }),
    );
  }
  upsertChunks(db, rows);
}

function ftsTop(match: string, k: number): { rowid: number; score: number }[] {
  return db
    .prepare<[string, number], { rowid: number; s: number }>(
      `SELECT rowid, bm25(chunks_fts, 1.0, 2.0) AS s FROM chunks_fts
       WHERE chunks_fts MATCH ? ORDER BY s, rowid LIMIT ?`,
    )
    .all(match, k)
    .map((r) => ({ rowid: r.rowid, score: -r.s }));
}

describe("LexicalIndex", () => {
  test("reproduces FTS5 bm25(chunks_fts, 1.0, 2.0) scores and order", () => {
    seedCorpus(400);
    const index = LexicalIndex.build(db);
    for (const query of [
      "budget",
      "the budget review",
      "marathon training notes",
      "runs running",
      "cafe resume",
    ]) {
      const match = query
        .split(" ")
        .map((w) => `"${w}"`)
        .join(" OR ");
      const expected = ftsTop(match, 50);
      const actual = index.rank(db, query, 50)!;
      expect(actual.map((r) => r.rowid)).toEqual(expected.map((r) => r.rowid));
      actual.forEach((r, i) => expect(r.score).toBeCloseTo(expected[i].score, 6));
    }
  });

  test("reads the length of chunks longer than one varint byte", () => {
    // Token counts of 128 and above take multi-byte varints in chunks_fts_docsize.
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: `budget ${"word ".repeat(150)}` }),
      chunk({ id: "c2", documentId: "d2", content: `budget ${"word ".repeat(20000)}` }),
      chunk({ id: "c3", documentId: "d3", content: "budget review" }),
    ]);
    const index = LexicalIndex.build(db);
    const expected = ftsTop('"budget"', 10);
    const actual = index.rank(db, "budget", 10)!;
    expect(actual.map((r) => r.rowid)).toEqual(expected.map((r) => r.rowid));
    actual.forEach((r, i) => expect(r.score).toBe(expected[i].score));
  });

  test("stems query words with the index tokenizer", () => {
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "she runs every morning" })]);
    const index = LexicalIndex.build(db);
    expect(index.rank(db, "running", 10)!.length).toBe(1);
  });

  test("expands a type-ahead prefix over unstemmed terms", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: "dinner reservation confirmed" }),
      chunk({ id: "c2", documentId: "d2", content: "re: hello" }),
      ...[
        "re: budget review",
        "re: marathon training",
        "re: studio invoice",
        "quarterly notes",
      ].map((content, i) => chunk({ id: `f${i}`, documentId: `f${i}`, content })),
    ]);
    const index = LexicalIndex.build(db);
    // `res` completes to "reservation"; its stem `re` only adds the reply at the IDF floor.
    expect(index.rank(db, "dinner res", 10, { prefixLastToken: true })![0].rowid).toBe(1);
    const res = index.rank(db, "res", 10, { prefixLastToken: true })!;
    expect(res[0].rowid).toBe(1);
    expect(res.slice(1).every((r) => r.score < res[0].score / 1000)).toBe(true);
  });

  test("a finished word in type-ahead also matches its stem", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: "notes from the quarterly meeting" }),
      chunk({ id: "c2", documentId: "d2", content: "budget review" }),
      chunk({ id: "c3", documentId: "d3", content: "marathon training" }),
    ]);
    const index = LexicalIndex.build(db);
    // "meetings" is indexed as `meet`; no term starts with "meetings".
    expect(index.rank(db, "meetings", 10, { prefixLastToken: true })!.map((r) => r.rowid)).toEqual([
      1,
    ]);
  });

  test("ranks chunks written after the build through its delta", () => {
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "budget review" })]);
    const index = LexicalIndex.build(db);
    upsertChunks(db, [chunk({ id: "c2", documentId: "d2", content: "budget budget budget" })]);
    expect(
      index
        .rank(db, "budget", 10)!
        .map((r) => r.rowid)
        .sort(),
    ).toEqual([1, 2]);
  });

  test("finds words that only chunks written after the build contain", () => {
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "budget review" })]);
    const index = LexicalIndex.build(db);
    upsertChunks(db, [chunk({ id: "c2", documentId: "d2", content: "zephyr quokka invoice" })]);
    expect(index.rank(db, "zephyr", 10)!.map((r) => r.rowid)).toEqual([2]);
    expect(index.rank(db, "zep", 10, { prefixLastToken: true })!.map((r) => r.rowid)).toEqual([2]);
  });

  test("declines quoted phrases so FTS5 serves them", () => {
    seedCorpus(10);
    expect(LexicalIndex.build(db).rank(db, '"budget review"', 10)).toBeNull();
  });

  test("declines a word FTS5 reads as a phrase, like foo_bar", () => {
    seedCorpus(10);
    expect(LexicalIndex.build(db).rank(db, "budget_review notes", 10)).toBeNull();
  });

  test("follows a chunk rewritten in place: new words match, old words stop matching", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: "budget review" }),
      chunk({ id: "c2", documentId: "d2", content: "marathon training" }),
    ]);
    const index = LexicalIndex.build(db);
    // Same (document_id, chunk_index): an in-place update that keeps the rowid.
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "zephyr quokka" })]);
    expect(index.rank(db, "zephyr", 10)!.map((r) => r.rowid)).toEqual([1]);
    expect(index.rank(db, "budget", 10)).toEqual([]);
  });

  test("a reused rowid is ranked on its new text, not the deleted chunk's", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: "marathon training" }),
      chunk({ id: "c2", documentId: "d2", content: "budget review" }),
    ]);
    const index = LexicalIndex.build(db);
    db.prepare("DELETE FROM chunks WHERE id = 'c2'").run();
    upsertChunks(db, [chunk({ id: "c3", documentId: "d3", content: "zephyr quokka" })]);
    const reused = db
      .prepare<[], { rowid: number }>("SELECT rowid FROM chunks WHERE id = 'c3'")
      .get()!;
    expect(reused.rowid).toBe(2);
    expect(index.rank(db, "budget", 10)).toEqual([]);
    expect(index.rank(db, "zephyr", 10)!.map((r) => r.rowid)).toEqual([2]);
  });

  test("reads the change log at most once a second", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "budget review" })]);
      const index = LexicalIndex.build(db);
      expect(index.rank(db, "zephyr", 10)).toEqual([]);
      upsertChunks(db, [chunk({ id: "c2", documentId: "d2", content: "zephyr quokka" })]);
      expect(index.rank(db, "zephyr", 10)).toEqual([]);
      vi.advanceTimersByTime(1_000);
      expect(index.rank(db, "zephyr", 10)!.map((r) => r.rowid)).toEqual([2]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("declines once the change log was pruned past its position", () => {
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "budget review" })]);
    const index = LexicalIndex.build(db);
    upsertChunks(db, [
      chunk({ id: "c2", documentId: "d2", content: "zephyr quokka" }),
      chunk({ id: "c3", documentId: "d3", content: "marathon training" }),
    ]);
    const first = db
      .prepare<
        [],
        { seq: number }
      >("SELECT min(seq) AS seq FROM chunks_fts_changes WHERE chunk_rowid = 2")
      .get()!;
    db.prepare("DELETE FROM chunks_fts_changes WHERE seq <= ?").run(first.seq);
    expect(index.rank(db, "zephyr", 10)).toBeNull();
    expect(index.rank(db, "budget", 10)).toBeNull();
  });

  test("a chunk deleted and never replaced stops matching", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: "budget review" }),
      chunk({ id: "c2", documentId: "d2", content: "budget forecast" }),
    ]);
    const index = LexicalIndex.build(db);
    db.prepare("DELETE FROM chunks WHERE id = 'c1'").run();
    expect(index.rank(db, "budget", 10)!.map((r) => r.rowid)).toEqual([2]);
  });

  test("a chunk rewritten twice between reads is ranked on its latest text", () => {
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "budget review" })]);
    const index = LexicalIndex.build(db);
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "zephyr draft" })]);
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "quokka final" })]);
    expect(index.rank(db, "zephyr", 10)).toEqual([]);
    expect(index.rank(db, "quokka", 10)!.map((r) => r.rowid)).toEqual([1]);
  });

  test("past its time budget it declines, then resumes where it stopped", () => {
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "budget review" })]);
    const index = new LexicalIndex(LexicalIndex.build(db).data, {
      changesBatch: 1,
      changesBudgetMs: -1,
    });
    upsertChunks(db, [
      chunk({ id: "c2", documentId: "d2", content: "zephyr one" }),
      chunk({ id: "c3", documentId: "d3", content: "zephyr two" }),
    ]);
    // One change applied per query; FTS5 answers until the ranker has caught up.
    expect(index.rank(db, "zephyr", 10)).toBeNull();
    let ranked = index.rank(db, "zephyr", 10);
    for (let i = 0; ranked === null && i < 5; i++) ranked = index.rank(db, "zephyr", 10);
    expect(ranked!.map((r) => r.rowid).sort()).toEqual([2, 3]);
  });

  test("declines until the next build once its delta passes the memory cap", () => {
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "budget review" })]);
    const index = new LexicalIndex(LexicalIndex.build(db).data, { maxDeltaPostings: 3 });
    upsertChunks(db, [chunk({ id: "c2", documentId: "d2", content: "one two three four" })]);
    expect(index.rank(db, "budget", 10)).toBeNull();
    expect(index.rank(db, "budget", 10)).toBeNull();
  });

  test("on a handle holding a snapshot, changes appear when the snapshot moves", () => {
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "budget review" })]);
    const path = db.name;
    const reader = openIndexDb(path, { readonly: true, mmapBytes: 0 });
    try {
      // As the gateway's snapshot handle does: TEMP storage set before the snapshot opens.
      reader.exec("PRAGMA temp_store = MEMORY");
      reader.exec("BEGIN");
      const index = LexicalIndex.build(reader);
      upsertChunks(db, [chunk({ id: "c2", documentId: "d2", content: "zephyr quokka" })]);
      expect(index.rank(reader, "zephyr", 10)).toEqual([]);
      reader.exec("COMMIT; BEGIN");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.advanceTimersByTime(1_000);
      expect(index.rank(reader, "zephyr", 10)!.map((r) => r.rowid)).toEqual([2]);
    } finally {
      vi.useRealTimers();
      reader.exec("COMMIT");
      reader.close();
    }
  });

  test("a type-ahead prefix folds case and diacritics as the index does", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: "Café review" }),
      chunk({ id: "c2", documentId: "d2", content: "budget forecast" }),
    ]);
    const index = LexicalIndex.build(db);
    expect(index.rank(db, "CAFÉ", 10, { prefixLastToken: true })!.map((r) => r.rowid)).toEqual([1]);
    expect(index.rank(db, "Caf", 10, { prefixLastToken: true })!.map((r) => r.rowid)).toEqual([1]);
  });

  test("operator words and repeated words score as FTS5 scores them", () => {
    seedCorpus(300);
    const index = LexicalIndex.build(db);
    for (const query of [
      "budget AND review",
      "budget budget",
      "NOT marathon OR notes",
      "café NEAR résumé",
    ]) {
      const viaFts = bm25Search(db, query, {}, 30).candidates;
      const viaMemory = bm25Search(db, query, {}, 30, { ranker: index });
      expect(viaMemory.ranker).toBe("memory");
      expect(viaMemory.candidates.map((c) => c.chunkRowid)).toEqual(
        viaFts.map((c) => c.chunkRowid),
      );
    }
  });
});

describe("bm25Search — rank-first", () => {
  test("returns the same candidates as joining every match first", () => {
    seedCorpus(600);
    const rankFirst = bm25Search(db, "the budget review", {}, 50).candidates;
    // A one-document restriction set per doc forces the filter-first plan.
    const all = db.prepare<[], { document_id: string }>("SELECT document_id FROM chunks").all();
    const filterFirst = bm25Search(db, "the budget review", {}, 50, {
      documentIds: all.map((r) => r.document_id),
    }).candidates;
    expect(rankFirst.map((c) => c.chunkRowid)).toEqual(filterFirst.map((c) => c.chunkRowid));
    expect(rankFirst.map((c) => c.score)).toEqual(filterFirst.map((c) => c.score));
  });

  test("widens the ranked window when a filter rejects most of it", () => {
    seedCorpus(2000);
    const index = LexicalIndex.build(db);
    const { candidates } = bm25Search(db, "budget", { sourceIds: ["notes"] }, 50, {
      ranker: index,
    });
    const expected = db
      .prepare<[], { rowid: number }>(
        `SELECT c.rowid FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
         WHERE chunks_fts MATCH 'budget' AND c.source_id = 'notes'
         ORDER BY bm25(chunks_fts, 1.0, 2.0), c.rowid LIMIT 50`,
      )
      .all();
    expect(candidates.map((c) => c.chunkRowid)).toEqual(expected.map((r) => r.rowid));
  });

  test("uses the lexical ranker when one is supplied, and FTS5 when it declines", () => {
    seedCorpus(50);
    const calls: string[] = [];
    const declining: LexicalRanker = {
      rank: (_db, q) => {
        calls.push(q);
        return null;
      },
    };
    const viaFts = bm25Search(db, "budget", {}, 10).candidates;
    expect(bm25Search(db, "budget", {}, 10, { ranker: declining }).candidates).toEqual(viaFts);
    expect(calls).toEqual(["budget"]);

    const index = LexicalIndex.build(db);
    expect(
      bm25Search(db, "budget", {}, 10, { ranker: index }).candidates.map((c) => c.chunkRowid),
    ).toEqual(viaFts.map((c) => c.chunkRowid));
  });

  test("asks the ranker for wider windows, then answers filter-first", () => {
    seedCorpus(40);
    const windows: number[] = [];
    // Ranks rowids that do not exist, so no window ever yields enough rows.
    const phantom: LexicalRanker = {
      rank: (_db, _q, k) => {
        windows.push(k);
        return Array.from({ length: k }, (_, i) => ({ rowid: 1_000_000 + i, score: k - i }));
      },
    };
    const viaFts = bm25Search(db, "budget", {}, 10).candidates;
    const result = bm25Search(db, "budget", {}, 10, { ranker: phantom });
    expect(windows).toEqual([200, 1_600, 12_800, 25_000]);
    expect(result.candidates.map((c) => c.chunkRowid)).toEqual(viaFts.map((c) => c.chunkRowid));
  });

  test("a large limit starts from a proportionally larger window", () => {
    seedCorpus(40);
    const windows: number[] = [];
    const recording: LexicalRanker = {
      rank: (_db, _q, k) => {
        windows.push(k);
        return [];
      },
    };
    bm25Search(db, "budget", {}, 300, { ranker: recording });
    expect(windows).toEqual([1_200]);
  });

  test("a ranker that throws hands the query to FTS5", () => {
    seedCorpus(40);
    const failing: LexicalRanker = {
      rank: () => {
        throw new Error("simulated ranker failure");
      },
    };
    const result = bm25Search(db, "budget", {}, 10, { ranker: failing });
    expect(result.ranker).toBe("fts5");
    expect(result.candidates.map((c) => c.chunkRowid)).toEqual(
      bm25Search(db, "budget", {}, 10).candidates.map((c) => c.chunkRowid),
    );
  });

  test("filters, dates and pending purges give the same answer through either ranker", () => {
    seedCorpus(500);
    enqueueDocumentIndexPurge(db, "d3", true);
    enqueueDocumentIndexPurge(db, "d8", true);
    const index = LexicalIndex.build(db);
    const cases: Parameters<typeof bm25Search>[2][] = [
      {},
      { sourceIds: ["notes"] },
      { dateFrom: "2026-03-01", dateTo: "2026-03-31" },
      { documentTypes: ["email"] },
    ];
    for (const filters of cases) {
      const viaFts = bm25Search(db, "budget review", filters, 50);
      const viaMemory = bm25Search(db, "budget review", filters, 50, { ranker: index });
      expect(viaMemory.ranker).toBe("memory");
      expect(viaMemory.candidates.map((c) => c.chunkRowid)).toEqual(
        viaFts.candidates.map((c) => c.chunkRowid),
      );
      expect(viaMemory.candidates.some((c) => c.documentId === "d3" || c.documentId === "d8")).toBe(
        false,
      );
    }
  });

  test("drops the same common words as FTS5 ranking, from the ranker's own statistics", () => {
    seedCorpus(400);
    upsertChunks(
      db,
      [0, 1, 2].map((i) =>
        chunk({ id: `z${i}`, documentId: `z${i}`, content: `zephyr quokka the budget ${i}` }),
      ),
    );
    const index = LexicalIndex.build(db);
    const viaFts = bm25Search(db, "the budget zephyr", {}, 50, { commonTokenThreshold: 0.1 });
    const viaMemory = bm25Search(db, "the budget zephyr", {}, 50, {
      commonTokenThreshold: 0.1,
      ranker: index,
    });
    expect(viaFts.droppedTokens.length).toBeGreaterThan(0);
    expect(viaMemory.droppedTokens).toEqual(viaFts.droppedTokens);
    expect(viaMemory.ranker).toBe("memory");
    expect(viaMemory.candidates.map((c) => c.chunkRowid)).toEqual(
      viaFts.candidates.map((c) => c.chunkRowid),
    );
  });

  test("a quoted phrase goes to FTS5 even with the in-memory ranker attached", () => {
    seedCorpus(60);
    const index = LexicalIndex.build(db);
    const result = bm25Search(db, '"budget review"', {}, 10, { ranker: index });
    expect(result.ranker).toBe("fts5");
    expect(result.candidates.map((c) => c.chunkRowid)).toEqual(
      bm25Search(db, '"budget review"', {}, 10).candidates.map((c) => c.chunkRowid),
    );
  });

  test("skips ranked rowids that no longer exist", () => {
    seedCorpus(30);
    const index = LexicalIndex.build(db);
    db.prepare("DELETE FROM chunks WHERE id = 'c0'").run();
    const { candidates } = bm25Search(db, "budget", {}, 50, { ranker: index });
    expect(candidates.some((c) => c.documentId === "d0")).toBe(false);
  });
});
