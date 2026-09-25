// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { rrfFuse, singleStageFuse } from "./fusion.js";
import type { SearchCandidate } from "./types.js";

function makeCandidate(
  documentId: string,
  rank: number,
  overrides: Partial<SearchCandidate> = {},
): SearchCandidate {
  return {
    documentId,
    chunkRowid: rank,
    sourceId: "gmail:test",
    documentType: "email",
    title: `Doc ${documentId}`,
    sourceUrl: null,
    sourceCreatedAt: "2026-03-01T00:00:00Z",
    author: null,
    tags: null,
    chunkText: `Content of ${documentId}`,
    score: 1 / rank,
    rank,
    ...overrides,
  };
}

describe("rrfFuse", () => {
  test("combines BM25 and vector results", () => {
    const bm25 = [makeCandidate("a", 1), makeCandidate("b", 2), makeCandidate("c", 3)];
    const vector = [makeCandidate("b", 1), makeCandidate("a", 2), makeCandidate("d", 3)];

    const results = rrfFuse(bm25, vector, {
      k: 60,
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      limit: 10,
    });

    expect(results.length).toBe(4);
    // "b" appears in both lists at good ranks, should rank high
    const docIds = results.map((r) => r.documentId);
    expect(docIds).toContain("a");
    expect(docIds).toContain("b");
    expect(docIds).toContain("c");
    expect(docIds).toContain("d");
  });

  test("documents in both lists score higher than single-list docs", () => {
    const bm25 = [makeCandidate("a", 1), makeCandidate("b", 2)];
    const vector = [makeCandidate("a", 1), makeCandidate("c", 2)];

    const results = rrfFuse(bm25, vector, {
      k: 60,
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      limit: 10,
    });

    // "a" is rank 1 in both → highest score
    expect(results[0].documentId).toBe("a");
  });

  test("respects limit", () => {
    const bm25 = Array.from({ length: 20 }, (_, i) => makeCandidate(`doc${i}`, i + 1));
    const vector = Array.from({ length: 20 }, (_, i) => makeCandidate(`doc${i + 10}`, i + 1));

    const results = rrfFuse(bm25, vector, {
      k: 60,
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      limit: 5,
    });

    expect(results.length).toBe(5);
  });

  test("deduplicates by document", () => {
    // Same document, different chunks
    const bm25 = [
      makeCandidate("a", 1, { chunkRowid: 1 }),
      makeCandidate("a", 2, { chunkRowid: 2 }),
    ];
    const vector = [makeCandidate("b", 1)];

    const results = rrfFuse(bm25, vector, {
      k: 60,
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      limit: 10,
    });

    const docIds = results.map((r) => r.documentId);
    expect(docIds.filter((id) => id === "a").length).toBe(1);
  });

  test("includes score breakdown", () => {
    // Use different chunkRowids so they merge correctly
    const bm25 = [makeCandidate("a", 1, { chunkRowid: 100 })];
    const vector = [makeCandidate("a", 2, { chunkRowid: 100 })];

    const results = rrfFuse(bm25, vector, {
      k: 60,
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      limit: 10,
    });

    expect(results[0].scoreBreakdown).toBeDefined();
    expect(results[0].scoreBreakdown!.bm25Rank).toBe(1);
    expect(results[0].scoreBreakdown!.vectorRank).toBe(2);
    expect(results[0].scoreBreakdown!.rrfScore).toBeGreaterThan(0);
  });

  test("applies weight differences", () => {
    const bm25 = [makeCandidate("a", 1)];
    const vector = [makeCandidate("b", 1)];

    // Heavy BM25 weight
    const heavyBm25 = rrfFuse(bm25, vector, {
      k: 60,
      bm25Weight: 2.0,
      vectorWeight: 0.5,
      limit: 10,
    });

    // "a" (BM25) should rank first with heavy BM25 weight
    expect(heavyBm25[0].documentId).toBe("a");
  });

  // ── top-rank bonus surfacing ──
  test("rank-1 result has rrfScore (raw) + rankBonus = finalScore", () => {
    const bm25 = [makeCandidate("a", 1), makeCandidate("b", 2), makeCandidate("c", 3)];
    const vector: SearchCandidate[] = [];
    const results = rrfFuse(bm25, vector, {
      k: 60,
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      limit: 10,
      topRankBonus: 0.05,
      nearTopRankBonus: 0.02,
    });
    expect(results[0].scoreBreakdown!.rankBonus).toBeCloseTo(0.05, 6);
    expect(results[0].scoreBreakdown!.rrfScore).toBeCloseTo(1 / (60 + 1), 6);
    expect(
      (results[0].scoreBreakdown!.rrfScore ?? 0) + (results[0].scoreBreakdown!.rankBonus ?? 0),
    ).toBeCloseTo(results[0].scoreBreakdown!.finalScore!, 6);
  });

  test("ranks 2-3 carry the near-top bonus; rank 4+ has no bonus key", () => {
    const bm25 = [
      makeCandidate("a", 1),
      makeCandidate("b", 2),
      makeCandidate("c", 3),
      makeCandidate("d", 4),
    ];
    const results = rrfFuse(bm25, [], {
      k: 60,
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      limit: 10,
      topRankBonus: 0.05,
      nearTopRankBonus: 0.02,
    });
    expect(results[1].scoreBreakdown!.rankBonus).toBeCloseTo(0.02, 6);
    expect(results[2].scoreBreakdown!.rankBonus).toBeCloseTo(0.02, 6);
    // Rank-4 omits rankBonus rather than carrying a 0.
    expect(results[3].scoreBreakdown!.rankBonus).toBeUndefined();
  });

  test("topRankBonus=0 disables the rank-1 bump (rrfScore == finalScore)", () => {
    const bm25 = [makeCandidate("a", 1), makeCandidate("b", 2)];
    const results = rrfFuse(bm25, [], {
      k: 60,
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      limit: 10,
      topRankBonus: 0,
      nearTopRankBonus: 0,
    });
    // No bonus → rankBonus omitted, rrfScore equals finalScore.
    expect(results[0].scoreBreakdown!.rankBonus).toBeUndefined();
    expect(results[0].scoreBreakdown!.rrfScore).toBeCloseTo(
      results[0].scoreBreakdown!.finalScore!,
      6,
    );
  });

  test("rank flip: rank-2 rrfScore close to rank-1 → bonus determines order", () => {
    // Two candidates only in BM25; the bonus is what makes rank-1 lead
    // by a meaningful margin. Without the bonus they're separated by
    // ~0.0003 (1/61 vs 1/62); with bonus 0.05 the gap is ~0.05.
    const bm25 = [makeCandidate("a", 1), makeCandidate("b", 2)];
    const results = rrfFuse(bm25, [], {
      k: 60,
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      limit: 10,
      topRankBonus: 0.05,
      nearTopRankBonus: 0.02,
    });
    const lead = results[0].score - results[1].score;
    // (1/61 + 0.05) - (1/62 + 0.02) ≈ 0.030
    expect(lead).toBeGreaterThan(0.025);
  });
});

describe("singleStageFuse", () => {
  test("deduplicates by document", () => {
    const candidates = [
      makeCandidate("a", 1, { chunkRowid: 1 }),
      makeCandidate("a", 2, { chunkRowid: 2 }),
      makeCandidate("b", 3),
    ];

    const results = singleStageFuse(candidates, 10, "bm25");
    expect(results.length).toBe(2);
    expect(results[0].documentId).toBe("a");
    expect(results[1].documentId).toBe("b");
  });

  test("respects limit", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => makeCandidate(`doc${i}`, i + 1));

    const results = singleStageFuse(candidates, 3, "vector");
    expect(results.length).toBe(3);
  });
});
