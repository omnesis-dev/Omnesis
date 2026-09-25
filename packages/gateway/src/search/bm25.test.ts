// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  enqueueDocumentIndexPurge,
  upsertChunks,
  type ChunkUpsertInput,
} from "../indexer/db.js";
import { bm25Search, filterCommonTokens, toFts5Query } from "./bm25.js";
import { closeTempDb } from "./test-utils.js";

let db: Db;

beforeEach(() => {
  db = createIndexDatabase(`/tmp/omnesis-bm25-search-${randomUUID()}.db`);
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

describe("bm25Search — documentIds pushdown", () => {
  test("hides source-deleted documents while their bounded index purge is pending", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "pending", content: "budget review" }),
      chunk({ id: "c2", documentId: "visible", content: "budget review" }),
    ]);
    enqueueDocumentIndexPurge(db, "pending", true);

    const { candidates } = bm25Search(db, "budget", {}, 10);

    expect(candidates.map((candidate) => candidate.documentId)).toEqual(["visible"]);
  });

  test("documentIds=[] short-circuits to empty result", () => {
    upsertChunks(db, [chunk({ id: "c1", documentId: "d1", content: "budget review" })]);
    const { candidates: res } = bm25Search(db, "budget", {}, 10, { documentIds: [] });
    expect(res).toEqual([]);
  });

  test("documentIds restricts BM25 to the listed docs", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: "Q3 budget review with finance" }),
      chunk({ id: "c2", documentId: "d2", content: "annual budget overview" }),
      chunk({ id: "c3", documentId: "d3", content: "budget allocation strategy" }),
    ]);
    const { candidates: res } = bm25Search(db, "budget", {}, 10, { documentIds: ["d1", "d3"] });
    const ids = res.map((r) => r.documentId).sort();
    expect(ids).toEqual(["d1", "d3"]);
  });

  test("documentIds combines with metadata filters (AND, not OR)", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", sourceId: "gmail", content: "budget" }),
      chunk({ id: "c2", documentId: "d2", sourceId: "gmail", content: "budget" }),
      chunk({ id: "c3", documentId: "d3", sourceId: "notes", content: "budget" }),
    ]);
    // sourceIds restricts to gmail; documentIds restricts to {d1, d3}.
    // Intersection = {d1}.
    const { candidates: res } = bm25Search(db, "budget", { sourceIds: ["gmail"] }, 10, {
      documentIds: ["d1", "d3"],
    });
    expect(res).toHaveLength(1);
    expect(res[0].documentId).toBe("d1");
  });

  test("limit is applied AFTER the docId filter (recall preservation)", () => {
    // 20 candidates that all match "budget"; the filter picks only 2.
    // Limit=10. Expected: 2 results (the filter intersection size),
    // NOT some smaller number from a pre-fusion trim.
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(chunk({ id: `c${i}`, documentId: `d${i}`, content: "budget review notes" }));
    }
    upsertChunks(db, rows);
    const { candidates: res } = bm25Search(db, "budget", {}, 10, {
      documentIds: ["d3", "d11"],
    });
    expect(res.map((r) => r.documentId).sort()).toEqual(["d11", "d3"]);
  });

  test("no documentIds option preserves the original behaviour", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: "budget" }),
      chunk({ id: "c2", documentId: "d2", content: "budget" }),
    ]);
    const { candidates: res } = bm25Search(db, "budget", {}, 10);
    expect(res).toHaveLength(2);
  });

  test("a documentIds set far above SQLite's variable cap does not 500", () => {
    // A `from:`/`with:` filter on a very high-volume person resolves to more
    // doc ids than SQLite's 32766 bound-variable limit. An inline IN-list
    // throws "too many SQL variables"; the temp-table path must absorb it.
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "real-1", content: "budget review with finance" }),
      chunk({ id: "c2", documentId: "real-2", content: "annual budget overview" }),
      chunk({ id: "c3", documentId: "noise", content: "budget allocation strategy" }),
    ]);
    // 40000 ids (> 32766 cap, > INLINE_DOCID_LIMIT) — two real, the rest absent.
    const documentIds = ["real-1", "real-2"];
    for (let i = 0; i < 40000; i++) documentIds.push(`absent-${i}`);

    const { candidates: res } = bm25Search(db, "budget", {}, 10, { documentIds });
    expect(res.map((r) => r.documentId).sort()).toEqual(["real-1", "real-2"]);
  });
});

describe("bm25Search — before:/until: date boundary", () => {
  test("dateTo date-only includes docs created ON that date", () => {
    // Regression: before:2026-05-19 excluded everything on 2026-05-19
    // because lexicographic "2026-05-19T12:00:00Z" > "2026-05-19".
    upsertChunks(db, [
      chunk({
        id: "c1",
        documentId: "d1",
        content: "budget review",
        sourceCreatedAt: "2026-05-19T12:00:00Z",
      }),
      chunk({
        id: "c2",
        documentId: "d2",
        content: "budget overview",
        sourceCreatedAt: "2026-05-18T12:00:00Z",
      }),
      chunk({
        id: "c3",
        documentId: "d3",
        content: "budget forecast",
        sourceCreatedAt: "2026-05-20T06:00:00Z",
      }),
    ]);
    const { candidates: res } = bm25Search(db, "budget", { dateTo: "2026-05-19" }, 10);
    const ids = res.map((r) => r.documentId).sort();
    expect(ids).toEqual(["d1", "d2"]);
  });

  test("same-day window (dateFrom = dateTo) returns docs from that day", () => {
    upsertChunks(db, [
      chunk({
        id: "c1",
        documentId: "d1",
        content: "budget morning",
        sourceCreatedAt: "2026-05-19T08:00:00Z",
      }),
      chunk({
        id: "c2",
        documentId: "d2",
        content: "budget evening",
        sourceCreatedAt: "2026-05-19T22:00:00Z",
      }),
      chunk({
        id: "c3",
        documentId: "d3",
        content: "budget other day",
        sourceCreatedAt: "2026-05-20T01:00:00Z",
      }),
    ]);
    const { candidates: res } = bm25Search(
      db,
      "budget",
      { dateFrom: "2026-05-19", dateTo: "2026-05-19" },
      10,
    );
    const ids = res.map((r) => r.documentId).sort();
    expect(ids).toEqual(["d1", "d2"]);
  });
});

describe("filterCommonTokens", () => {
  // Words chosen so their Porter stem equals the word itself (no -s/-ed/-ing
  // suffix), so the unstemmed query term matches its `chunks_fts_vocab`
  // entry. "report"/"review"/"wombat" all stem to themselves.

  test("drops a token present in more than `threshold` of chunks, keeps the rare one", () => {
    // 10 chunks. "report" appears in 8 (doc=8), "wombat" in 2 (doc=2).
    // threshold 0.5 → cutoff = floor(10 * 0.5) = 5. report (8 > 5) is
    // dropped; wombat (2, not > 5) is kept.
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(chunk({ id: `r${i}`, documentId: `dr${i}`, content: "quarterly report data" }));
    }
    for (let i = 0; i < 2; i++) {
      rows.push(chunk({ id: `w${i}`, documentId: `dw${i}`, content: "wombat sighting log" }));
    }
    upsertChunks(db, rows);

    const { filtered, dropped } = filterCommonTokens(db, "report wombat", 0.5);
    expect(dropped).toEqual(["report"]);
    expect(filtered).toBe("wombat");
  });

  test("single-token query is never filtered, even when the token is common", () => {
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 9; i++) {
      rows.push(chunk({ id: `r${i}`, documentId: `dr${i}`, content: "weekly report" }));
    }
    upsertChunks(db, rows);
    // "report" is in 9/9 chunks (doc=9 > cutoff 4) but it is the ONLY token —
    // dropping it would leave an empty query, so it is preserved unchanged.
    const { filtered, dropped } = filterCommonTokens(db, "report", 0.5);
    expect(dropped).toEqual([]);
    expect(filtered).toBe("report");
  });

  test("all tokens common → returns the original query unchanged (something beats nothing)", () => {
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(chunk({ id: `c${i}`, documentId: `dc${i}`, content: "quarterly report review" }));
    }
    upsertChunks(db, rows);
    // Both tokens appear in all 8 chunks (doc=8 > cutoff 4). With every token
    // dropped, the filter falls back to the original query rather than an
    // empty MATCH that would return zero results.
    const { filtered, dropped } = filterCommonTokens(db, "report review", 0.5);
    expect(dropped).toEqual([]);
    expect(filtered).toBe("report review");
  });

  test("quoted phrase passes through untouched", () => {
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(chunk({ id: `c${i}`, documentId: `dc${i}`, content: "quarterly report data" }));
    }
    upsertChunks(db, rows);
    const { filtered, dropped } = filterCommonTokens(db, '"quarterly report"', 0.5);
    expect(dropped).toEqual([]);
    expect(filtered).toBe('"quarterly report"');
  });

  test("threshold outside (0,1) disables filtering entirely", () => {
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(chunk({ id: `c${i}`, documentId: `dc${i}`, content: "report report report" }));
    }
    upsertChunks(db, rows);
    // threshold 0 is the "off" sentinel — even a token in every chunk is kept.
    const { filtered, dropped } = filterCommonTokens(db, "report wombat", 0);
    expect(dropped).toEqual([]);
    expect(filtered).toBe("report wombat");
  });

  test("bm25Search routes commonTokenThreshold through and surfaces droppedTokens", () => {
    // "report" common (8 docs), "wombat" rare (1 doc); the dropped token is
    // reported on the result and the surviving query still ranks the rare doc.
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(chunk({ id: `r${i}`, documentId: `dr${i}`, content: "quarterly report data" }));
    }
    rows.push(chunk({ id: "w0", documentId: "dw0", content: "wombat sighting log" }));
    upsertChunks(db, rows);

    const { candidates, droppedTokens } = bm25Search(db, "report wombat", {}, 10, {
      commonTokenThreshold: 0.5,
    });
    expect(droppedTokens).toEqual(["report"]);
    // Only the rare doc matches the surviving "wombat" token.
    expect(candidates.map((c) => c.documentId)).toEqual(["dw0"]);
  });
});

describe("toFts5Query", () => {
  test("multi-word query joins with OR, no per-term quotes", () => {
    expect(toFts5Query("foo bar")).toBe("foo OR bar");
  });

  test("already-quoted phrase passes through unchanged", () => {
    expect(toFts5Query('"hello world"')).toBe('"hello world"');
  });

  test("replaces FTS5 syntax characters with spaces so terms split, not concatenate", () => {
    // `*`, `(`, `)`, `:`, `^`, `-` etc. become spaces, so `foo*bar` splits
    // into two terms — matching how the tokenizer indexes the content —
    // rather than concatenating to `foobar`.
    expect(toFts5Query("foo*bar (baz) qu:ux")).toBe("foo OR bar OR baz OR qu OR ux");
  });

  test("hyphens become spaces so FTS5 doesn't read them as NOT", () => {
    // Regression: previously a stray `-` reached the BM25 stage and
    // surfaced as `SqliteError: fts5: syntax error near "-"`, which
    // bubbled to the HTTP layer as a 500.
    expect(toFts5Query("-foo -bar")).toBe("foo OR bar");
    expect(toFts5Query("real-world")).toBe("real OR world");
  });

  test("any punctuation-laden text yields a valid MATCH query, never a syntax error", () => {
    // Each of these used to reach FTS5 as invalid syntax and 500 the search.
    expect(toFts5Query("c++")).toBe("c");
    expect(toFts5Query("c#")).toBe("c");
    expect(toFts5Query("a+b")).toBe("a OR b");
    expect(toFts5Query("foo'bar")).toBe("foo OR bar");
    expect(toFts5Query("e=mc^2")).toBe("e OR mc OR 2");
    expect(toFts5Query("'; DROP TABLE documents;--")).toBe("DROP OR TABLE OR documents");
    expect(toFts5Query('a " b')).toBe("a OR b");
    // Non-Latin scripts survive (the `u` flag keeps \p{L}).
    expect(toFts5Query("日本語")).toBe("日本語");
  });

  test("drops bare boolean operators (AND/OR/NOT/NEAR) instead of crashing", () => {
    // Regression: `hello OR meeting` used to expand to
    // `hello OR OR OR meeting` after the implicit-OR join, blowing up
    // FTS5 with "fts5: syntax error near 'OR'". The parser treats
    // boolean keywords as noise so a casual query stays valid; users
    // who want literal phrase matching can quote the input.
    expect(toFts5Query("hello OR meeting")).toBe("hello OR meeting");
    expect(toFts5Query("budget AND finance")).toBe("budget OR finance");
    expect(toFts5Query("foo NOT bar")).toBe("foo OR bar");
    expect(toFts5Query("NEAR")).toBe("");
  });

  test("empty query returns empty string", () => {
    expect(toFts5Query("")).toBe("");
    expect(toFts5Query("   ")).toBe("");
  });

  test("single-term query has no operator", () => {
    expect(toFts5Query("budget")).toBe("budget");
  });
});

describe("bm25Search — FTS-special chars are sanitized end-to-end", () => {
  test("query with bare OR / leading hyphen returns results instead of throwing", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: "hello world" }),
      chunk({ id: "c2", documentId: "d2", content: "meeting notes for the team" }),
    ]);
    // Before sanitization these would surface as SqliteError 500s.
    // Now both terms drop down to plain OR matches.
    expect(() => bm25Search(db, "hello OR meeting", {}, 10)).not.toThrow();
    expect(() => bm25Search(db, "-foo hello", {}, 10)).not.toThrow();
  });
});

describe("bm25Search — tokenizer (Porter stemming + diacritic folding)", () => {
  test("singular query matches plural-indexed content (Porter stemming)", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: "I love recipes" }),
      chunk({ id: "c2", documentId: "d2", content: "unrelated content about cars" }),
    ]);
    const { candidates: res } = bm25Search(db, "recipe", {}, 10);
    expect(res.map((r) => r.documentId)).toContain("d1");
    expect(res.map((r) => r.documentId)).not.toContain("d2");
  });

  test("unaccented query matches diacritic-indexed content", () => {
    upsertChunks(db, [
      chunk({ id: "c1", documentId: "d1", content: "cérémonie laïque dans le jardin" }),
      chunk({ id: "c2", documentId: "d2", content: "unrelated content about cars" }),
    ]);
    const { candidates: res } = bm25Search(db, "ceremonie", {}, 10);
    expect(res.map((r) => r.documentId)).toContain("d1");
    expect(res.map((r) => r.documentId)).not.toContain("d2");
  });

  test("multi-word natural query with stopwords matches a partial-token doc (OR semantics)", () => {
    upsertChunks(db, [
      chunk({
        id: "c1",
        documentId: "d1",
        content: "speech we wrote for our wedding ceremony",
      }),
      chunk({
        id: "c2",
        documentId: "d2",
        content: "completely unrelated text about gardening tools",
      }),
    ]);
    // 9-word natural query, only ~3 tokens actually appear in d1; with
    // AND-default this returns 0, with OR-default d1 ranks first.
    const { candidates: res } = bm25Search(db, "the best man speech wrote for my wedding", {}, 10);
    expect(res.length).toBeGreaterThanOrEqual(1);
    expect(res[0].documentId).toBe("d1");
  });
});
