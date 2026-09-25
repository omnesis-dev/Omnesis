// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { scoreQuery, percentile, median, mean } from "./metrics.js";
import type { RetrievedDoc } from "./types.js";

function retrieved(...ids: string[]): RetrievedDoc[] {
  return ids.map((id, i) => ({ rank: i + 1, document_id: id }));
}

/** Each doc gets a chunk_text of `chunkChars` chars → tokenCost = ceil(chars/4). */
function retrievedWithChunks(chunkChars: number, ...ids: string[]): RetrievedDoc[] {
  return ids.map((id, i) => ({
    rank: i + 1,
    document_id: id,
    chunk_text: "x".repeat(chunkChars),
  }));
}

describe("scoreQuery", () => {
  it("counts a hit at rank 1 with single ground-truth", () => {
    const s = scoreQuery(retrieved("a", "b", "c"), [["a"]], 10);
    expect(s.hit_at_1).toBe(1);
    expect(s.hit_at_5).toBe(1);
    expect(s.hit_at_10).toBe(1);
    expect(s.recall_at_10).toBe(1);
    expect(s.mrr).toBe(1);
    expect(s.best_rank).toBe(1);
    expect(s.hit_any).toBe(true);
  });

  it("misses when ground-truth absent", () => {
    const s = scoreQuery(retrieved("a", "b"), [["z"]], 10);
    expect(s.hit_at_1).toBe(0);
    expect(s.hit_at_10).toBe(0);
    expect(s.recall_at_10).toBe(0);
    expect(s.mrr).toBe(0);
    expect(s.best_rank).toBeNull();
    expect(s.hit_any).toBe(false);
  });

  it("uses 1/rank for MRR", () => {
    const s = scoreQuery(retrieved("x", "y", "a"), [["a"]], 10);
    expect(s.mrr).toBeCloseTo(1 / 3);
    expect(s.best_rank).toBe(3);
    expect(s.hit_at_1).toBe(0);
    expect(s.hit_at_5).toBe(1);
  });

  it("recall_at_k curve reflects the cut-off where the answer enters the window", () => {
    // Gold at rank 3 → in window at k>=3, absent at k=1.
    const s = scoreQuery(retrieved("x", "y", "a"), [["a"]], 10);
    expect(s.recall_at_k).toEqual({ "1": 0, "3": 1, "5": 1, "10": 1, "20": 1 });
  });

  it("context_tokens_to_hit sums snippet tokens up to (and including) the first hit", () => {
    // 40-char chunks → 10 tokens each (chars/4). Gold at rank 3 → 3 × 10 = 30.
    const s = scoreQuery(retrievedWithChunks(40, "x", "y", "a", "b"), [["a"]], 10);
    expect(s.context_tokens_to_hit).toBe(30);
    expect(s.best_rank).toBe(3);
  });

  it("context_tokens_to_hit is null on a miss; context_tokens_at_10 still counts the window", () => {
    const s = scoreQuery(retrievedWithChunks(40, "x", "y", "z"), [["a"]], 10);
    expect(s.context_tokens_to_hit).toBeNull();
    // top-10 cost = all 3 retrieved × 10 tokens.
    expect(s.context_tokens_at_10).toBe(30);
  });

  it("promoting the answer lowers context_tokens_to_hit at equal recall", () => {
    // Same doc set, answer at rank 5 vs promoted to rank 2; both hit within 10.
    const before = scoreQuery(retrievedWithChunks(40, "p", "q", "r", "s", "a"), [["a"]], 10);
    const after = scoreQuery(retrievedWithChunks(40, "p", "a", "q", "r", "s"), [["a"]], 10);
    expect(before.recall_at_k!["10"]).toBe(after.recall_at_k!["10"]); // recall unchanged
    expect(after.context_tokens_to_hit!).toBeLessThan(before.context_tokens_to_hit!); // cheaper context
    expect(before.context_tokens_to_hit).toBe(50);
    expect(after.context_tokens_to_hit).toBe(20);
  });

  it("recall_at_10 = fraction of expected docs hit within top-10", () => {
    // 3 expected docs, 2 of them appear in top-10
    const s = scoreQuery(retrieved("a", "x", "y", "b", "z"), [["a"], ["b"], ["c"]], 10);
    expect(s.recall_at_10).toBeCloseTo(2 / 3);
  });

  it("alias groups: any alias in the group satisfies the doc", () => {
    // One expected doc with two alias IDs. Only the second alias appears.
    const s = scoreQuery(retrieved("x", "alt-id"), [["primary-id", "alt-id"]], 10);
    expect(s.recall_at_10).toBe(1);
    expect(s.hit_at_1).toBe(0);
    expect(s.hit_at_5).toBe(1);
  });

  it("counts hit_at_5 even when rank=5", () => {
    const s = scoreQuery(retrieved("x", "y", "z", "w", "a"), [["a"]], 10);
    expect(s.hit_at_5).toBe(1);
    expect(s.hit_at_1).toBe(0);
  });

  it("empty retrieved → all zero", () => {
    const s = scoreQuery([], [["a"]], 0);
    expect(s.hit_at_10).toBe(0);
    expect(s.recall_at_10).toBe(0);
    expect(s.mrr).toBe(0);
    expect(s.best_rank).toBeNull();
  });
});

describe("percentile", () => {
  it("returns 0 for empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });
  it("returns the single value", () => {
    expect(percentile([42], 95)).toBe(42);
  });
  it("interpolates between sorted values", () => {
    // [10, 20, 30, 40, 50], p50 should be 30
    expect(percentile([50, 10, 30, 20, 40], 50)).toBe(30);
    // p100 = max
    expect(percentile([50, 10, 30, 20, 40], 100)).toBe(50);
    // p0 = min
    expect(percentile([50, 10, 30, 20, 40], 0)).toBe(10);
  });
});

describe("median / mean", () => {
  it("median is the p50", () => {
    expect(median([1, 2, 3, 4, 5])).toBe(3);
  });
  it("mean averages the values", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
    expect(mean([])).toBe(0);
  });
});
