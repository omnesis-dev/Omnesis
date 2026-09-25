// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the HNSW vector retrieval half of hybrid search.
 *
 * The production `UsearchReadHandle` is backed by a native usearch index;
 * here we substitute a deterministic stub whose `search(vector, k)`
 * returns a fixed list of `{ key, distance }` truncated to `k`. That lets
 * us exercise everything `hnswSearchCandidates` owns on the JS side: the
 * over-fetch multiplier, the JOIN to a real in-memory `chunks` table, the
 * post-filters (sourceId / documentType / date / tags / docIdSet), the
 * `score = 1 − distance` conversion, the sort + rank reassignment, the
 * final `slice(0, limit)`, and the adaptive retry that doubles `effectiveK`
 * when a selective filter leaves fewer than `limit` rows on the first pass.
 */

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
import { hnswSearchCandidates } from "./vector-hnsw.js";
import type { UsearchReadHandle } from "../indexer/usearch-index.js";
import type { SearchFilters } from "./types.js";
import { closeTempDb } from "./test-utils.js";

let db: Db;

beforeEach(() => {
  db = createIndexDatabase(`/tmp/omnesis-vector-hnsw-${randomUUID()}.db`);
});

afterEach(() => {
  closeTempDb(db);
});

const QUERY_VEC = new Float32Array(EMBEDDING_DIM).fill(0.01);

function chunk(
  overrides: Partial<ChunkUpsertInput> & { id: string; documentId: string },
): ChunkUpsertInput {
  return {
    chunkIndex: 0,
    content: "",
    embedding: new Float32Array(EMBEDDING_DIM).fill(0),
    sourceId: "gmail",
    documentType: "email",
    title: "title",
    sourceCreatedAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

/** rowid for a (documentId, chunkIndex=0) chunk just inserted. */
function rowidOf(documentId: string): bigint {
  const row = db
    .prepare<
      [string],
      { rowid: number }
    >("SELECT rowid FROM chunks WHERE document_id = ? AND chunk_index = 0")
    .get(documentId);
  if (!row) throw new Error(`no chunk for ${documentId}`);
  return BigInt(row.rowid);
}

/**
 * Build a usearch read-handle stub. `entries` is the ANN-ordered list of
 * (rowid, distance) the index "knows" — nearest first. `search(_, k)`
 * returns the first `k` of them, exactly like a KNN top-k cutoff, so a
 * larger `k` surfaces strictly more candidates (the property the adaptive
 * retry depends on).
 */
function stubUsearch(
  entries: Array<{ key: bigint; distance: number }>,
  observedK: number[] = [],
): UsearchReadHandle {
  return {
    search(_vector: Float32Array, k: number) {
      observedK.push(k);
      return entries.slice(0, k);
    },
    reopen() {},
    close() {},
    size() {
      return entries.length;
    },
  } as unknown as UsearchReadHandle;
}

describe("hnswSearchCandidates — score conversion, sort, rank, slice", () => {
  test("hides source-deleted documents while their bounded index purge is pending", () => {
    upsertChunks(db, [
      chunk({ id: "a", documentId: "pending", content: "alpha" }),
      chunk({ id: "b", documentId: "visible", content: "bravo" }),
    ]);
    enqueueDocumentIndexPurge(db, "pending", true);
    const entries = [
      { key: rowidOf("pending"), distance: 0.1 },
      { key: rowidOf("visible"), distance: 0.2 },
    ];

    const out = hnswSearchCandidates(stubUsearch(entries), db, QUERY_VEC, {}, 10);

    expect(out.map((candidate) => candidate.documentId)).toEqual(["visible"]);
  });

  test("score = 1 − distance, sorted desc, ranks reassigned 1..N, sliced to limit", () => {
    upsertChunks(db, [
      chunk({ id: "a", documentId: "dA", content: "alpha" }),
      chunk({ id: "b", documentId: "dB", content: "bravo" }),
      chunk({ id: "c", documentId: "dC", content: "charlie" }),
    ]);
    // Feed distances OUT OF score order so the sort has to do real work:
    // dB is nearest (0.10 → score 0.90), dA mid (0.25 → 0.75), dC far
    // (0.40 → 0.60). usearch returns them in key order; the function must
    // re-sort by score descending.
    const entries = [
      { key: rowidOf("dA"), distance: 0.25 },
      { key: rowidOf("dB"), distance: 0.1 },
      { key: rowidOf("dC"), distance: 0.4 },
    ];
    const filters: SearchFilters = {};
    const out = hnswSearchCandidates(stubUsearch(entries), db, QUERY_VEC, filters, 2);

    // Sliced to limit=2, ordered by score desc.
    expect(out.map((c) => c.documentId)).toEqual(["dB", "dA"]);
    expect(out[0].score).toBeCloseTo(0.9, 6);
    expect(out[1].score).toBeCloseTo(0.75, 6);
    // Ranks are reassigned to the post-sort position, NOT the ANN order.
    expect(out.map((c) => c.rank)).toEqual([1, 2]);
    // chunkText is left empty — the vector stage never reads the content blob;
    // the pipeline hydrates the final results by chunkRowid (hydrate-chunks.ts).
    expect(out.every((c) => c.chunkText === "")).toBe(true);
  });

  test("no filters → over-fetch multiplier is 1 (effectiveK == limit)", () => {
    upsertChunks(db, [chunk({ id: "a", documentId: "dA" }), chunk({ id: "b", documentId: "dB" })]);
    const observedK: number[] = [];
    const entries = [
      { key: rowidOf("dA"), distance: 0.2 },
      { key: rowidOf("dB"), distance: 0.3 },
    ];
    hnswSearchCandidates(stubUsearch(entries, observedK), db, QUERY_VEC, {}, 5, {
      hnswOverFetch: 10,
    });
    // hasFilters is false → multiplier 1 → effectiveK = max(limit, limit*1).
    expect(observedK).toEqual([5]);
  });
});

describe("hnswSearchCandidates — alwaysOverFetch un-gates over-fetch", () => {
  test("alwaysOverFetch true → unfiltered query fetches limit*overFetch from usearch", () => {
    upsertChunks(db, [chunk({ id: "a", documentId: "dA" }), chunk({ id: "b", documentId: "dB" })]);
    const observedK: number[] = [];
    const entries = [
      { key: rowidOf("dA"), distance: 0.2 },
      { key: rowidOf("dB"), distance: 0.3 },
    ];
    // No filters, but alwaysOverFetch forces the multiplier on:
    // effectiveK = max(5, 5*10) = 50.
    hnswSearchCandidates(stubUsearch(entries, observedK), db, QUERY_VEC, {}, 5, {
      hnswOverFetch: 10,
      alwaysOverFetch: true,
    });
    expect(observedK).toEqual([50]);
  });

  test("alwaysOverFetch default (false) leaves the unfiltered multiplier at 1", () => {
    upsertChunks(db, [chunk({ id: "a", documentId: "dA" }), chunk({ id: "b", documentId: "dB" })]);
    const observedK: number[] = [];
    const entries = [
      { key: rowidOf("dA"), distance: 0.2 },
      { key: rowidOf("dB"), distance: 0.3 },
    ];
    // Default behaviour: unset alwaysOverFetch behaves exactly like false →
    // unfiltered query fetches only `limit`.
    hnswSearchCandidates(stubUsearch(entries, observedK), db, QUERY_VEC, {}, 5, {
      hnswOverFetch: 10,
      alwaysOverFetch: false,
    });
    expect(observedK).toEqual([5]);
  });

  test("alwaysOverFetch does not trigger the adaptive retry on an unfiltered query", () => {
    // The adaptive retry stays gated on hasFilters: an unfiltered over-fetch
    // that comes up short is NOT re-fetched (a second identical fetch can't help).
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 3; i++) rows.push(chunk({ id: `c${i}`, documentId: `d${i}` }));
    upsertChunks(db, rows);
    const entries = rows.map((r, i) => ({ key: rowidOf(r.documentId), distance: i / 100 }));
    const observedK: number[] = [];
    // limit 10 > 3 available; over-fetch on but no filters → single fetch only.
    hnswSearchCandidates(stubUsearch(entries, observedK), db, QUERY_VEC, {}, 10, {
      hnswOverFetch: 10,
      alwaysOverFetch: true,
    });
    expect(observedK).toEqual([100]);
  });
});

describe("hnswSearchCandidates — post-filters drop the right rows", () => {
  test("sourceId / documentType / date / docIdSet filters each exclude non-matching rows", () => {
    upsertChunks(db, [
      chunk({
        id: "a",
        documentId: "dA",
        sourceId: "gmail",
        documentType: "email",
        sourceCreatedAt: "2026-03-10T12:00:00Z",
      }),
      chunk({
        id: "b",
        documentId: "dB",
        sourceId: "notes",
        documentType: "note",
        sourceCreatedAt: "2026-03-10T12:00:00Z",
      }),
      chunk({
        id: "c",
        documentId: "dC",
        sourceId: "gmail",
        documentType: "note",
        sourceCreatedAt: "2026-01-01T12:00:00Z",
      }),
    ]);
    const entries = [
      { key: rowidOf("dA"), distance: 0.1 },
      { key: rowidOf("dB"), distance: 0.2 },
      { key: rowidOf("dC"), distance: 0.3 },
    ];
    // sourceIds=[gmail] drops dB; documentTypes=[email] drops dC; only dA
    // survives both.
    const out = hnswSearchCandidates(
      stubUsearch(entries),
      db,
      QUERY_VEC,
      { sourceIds: ["gmail"], documentTypes: ["email"] },
      10,
    );
    expect(out.map((c) => c.documentId)).toEqual(["dA"]);
  });

  test("dateFrom / dateTo exclude rows outside the window", () => {
    upsertChunks(db, [
      chunk({ id: "a", documentId: "dA", sourceCreatedAt: "2026-05-18T12:00:00Z" }),
      chunk({ id: "b", documentId: "dB", sourceCreatedAt: "2026-05-20T12:00:00Z" }),
      chunk({ id: "c", documentId: "dC", sourceCreatedAt: "2026-05-22T12:00:00Z" }),
    ]);
    const entries = [
      { key: rowidOf("dA"), distance: 0.1 },
      { key: rowidOf("dB"), distance: 0.2 },
      { key: rowidOf("dC"), distance: 0.3 },
    ];
    const out = hnswSearchCandidates(
      stubUsearch(entries),
      db,
      QUERY_VEC,
      { dateFrom: "2026-05-19T00:00:00Z", dateTo: "2026-05-21T00:00:00Z" },
      10,
    );
    expect(out.map((c) => c.documentId)).toEqual(["dB"]);
  });

  test("tags filter is case-insensitive and requires ALL requested tags (every)", () => {
    upsertChunks(db, [
      chunk({ id: "a", documentId: "dA", tags: ["Finance", "Quarterly"] }),
      chunk({ id: "b", documentId: "dB", tags: ["Finance"] }),
      chunk({ id: "c", documentId: "dC", tags: ["Personal"] }),
    ]);
    const entries = [
      { key: rowidOf("dA"), distance: 0.1 },
      { key: rowidOf("dB"), distance: 0.2 },
      { key: rowidOf("dC"), distance: 0.3 },
    ];
    // Requesting both tags (lowercased) keeps only dA, which has both;
    // dB has only one of them and is dropped.
    const out = hnswSearchCandidates(
      stubUsearch(entries),
      db,
      QUERY_VEC,
      { tags: ["finance", "quarterly"] },
      10,
    );
    expect(out.map((c) => c.documentId)).toEqual(["dA"]);
  });

  test("documentIds restricts to the listed docs (docIdSet post-filter)", () => {
    upsertChunks(db, [
      chunk({ id: "a", documentId: "dA" }),
      chunk({ id: "b", documentId: "dB" }),
      chunk({ id: "c", documentId: "dC" }),
    ]);
    const entries = [
      { key: rowidOf("dA"), distance: 0.1 },
      { key: rowidOf("dB"), distance: 0.2 },
      { key: rowidOf("dC"), distance: 0.3 },
    ];
    const out = hnswSearchCandidates(stubUsearch(entries), db, QUERY_VEC, {}, 10, {
      documentIds: ["dA", "dC"],
    });
    expect(out.map((c) => c.documentId).sort()).toEqual(["dA", "dC"]);
  });
});

describe("hnswSearchCandidates — adaptive retry doubles effectiveK", () => {
  test("selective filter short on the first pass triggers a second fetch with doubled K", () => {
    // 25 candidate chunks. Only the LAST four (by ANN order) belong to the
    // allowed source `match`; the rest are `other`. With limit=3 and
    // overFetch=2, the first pass fetches effectiveK = max(3, 3*2) = 6 ANN
    // hits — all `other` — yielding 0 after the source filter (< limit).
    // The retry doubles to effectiveK = max(12, 3*2*2) = 12, still short of
    // the matches at positions 21..24, so a THIRD design would be needed —
    // instead we place the matches within reach of the doubled K.
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 25; i++) {
      rows.push(
        chunk({
          id: `c${i}`,
          documentId: `d${i}`,
          sourceId: i >= 8 && i < 12 ? "match" : "other",
        }),
      );
    }
    upsertChunks(db, rows);

    const entries = rows.map((r, i) => ({
      key: rowidOf(r.documentId),
      distance: i / 100, // nearest first, ANN order == insertion order
    }));
    const observedK: number[] = [];
    const out = hnswSearchCandidates(
      stubUsearch(entries, observedK),
      db,
      QUERY_VEC,
      { sourceIds: ["match"] },
      3,
      { hnswOverFetch: 2 },
    );

    // First pass: effectiveK = max(3, 3*2) = 6 → ANN hits d0..d5, all
    // `other` → 0 matches < limit 3 → retry.
    // Retry: effectiveK = max(6*2, 3*2*2) = 12 → ANN hits d0..d11, which
    // now includes d8..d11 (source `match`) → 4 matches, sliced to 3.
    expect(observedK).toEqual([6, 12]);
    expect(out).toHaveLength(3);
    for (const c of out) expect(c.sourceId).toBe("match");
    // Ranks are 1..3 over the post-slice survivors.
    expect(out.map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  test("first pass already satisfies limit → no retry", () => {
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push(chunk({ id: `c${i}`, documentId: `d${i}`, sourceId: "match" }));
    }
    upsertChunks(db, rows);
    const entries = rows.map((r, i) => ({ key: rowidOf(r.documentId), distance: i / 100 }));
    const observedK: number[] = [];
    hnswSearchCandidates(
      stubUsearch(entries, observedK),
      db,
      QUERY_VEC,
      { sourceIds: ["match"] },
      3,
      {
        hnswOverFetch: 10,
      },
    );
    // effectiveK = max(3, 3*10) = 30 → all 10 ANN hits pass → 10 >= limit 3,
    // so the second fetchAndFilter never runs.
    expect(observedK).toEqual([30]);
  });
});

describe("hnswSearchCandidates — dateTo end-of-day boundary", () => {
  test("a bare `dateTo` (YYYY-MM-DD) keeps same-day docs (end-of-day inclusive)", () => {
    upsertChunks(db, [
      chunk({ id: "a", documentId: "doc-1", sourceCreatedAt: "2026-05-19T10:00:00Z" }),
      chunk({ id: "b", documentId: "doc-2", sourceCreatedAt: "2026-05-19T14:30:00Z" }),
    ]);
    const entries = [
      { key: rowidOf("doc-1"), distance: 0.1 },
      { key: rowidOf("doc-2"), distance: 0.2 },
    ];
    // Both same-day docs must survive — a raw `>` compare drops them because
    // "2026-05-19T10:00:00Z" > "2026-05-19".
    const out = hnswSearchCandidates(
      stubUsearch(entries),
      db,
      QUERY_VEC,
      { dateTo: "2026-05-19" },
      10,
    );
    expect(out.map((c) => c.documentId).sort()).toEqual(["doc-1", "doc-2"]);
  });

  test("a bare `dateTo` still excludes docs on the following day", () => {
    upsertChunks(db, [
      chunk({ id: "a", documentId: "doc-in", sourceCreatedAt: "2026-05-19T23:59:00Z" }),
      chunk({ id: "b", documentId: "doc-out", sourceCreatedAt: "2026-05-20T00:30:00Z" }),
    ]);
    const entries = [
      { key: rowidOf("doc-in"), distance: 0.1 },
      { key: rowidOf("doc-out"), distance: 0.2 },
    ];
    const out = hnswSearchCandidates(
      stubUsearch(entries),
      db,
      QUERY_VEC,
      { dateTo: "2026-05-19" },
      10,
    );
    expect(out.map((c) => c.documentId)).toEqual(["doc-in"]);
  });
});
