// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { pairedBootstrap, percentile, scoreQuery, seededRandom } from "./metrics.js";

describe("scoreQuery", () => {
  test("a perfect ranking scores 1 on every metric", () => {
    const score = scoreQuery(["a", "b", "x"], new Set(["a", "b"]));
    expect(score).toEqual({ ndcg10: 1, recall100: 1, mrr10: 1 });
  });

  test("a relevant passage at rank 3 is discounted", () => {
    const score = scoreQuery(["x", "y", "a"], new Set(["a"]));
    expect(score.ndcg10).toBeCloseTo(1 / Math.log2(4), 10);
    expect(score.mrr10).toBeCloseTo(1 / 3, 10);
    expect(score.recall100).toBe(1);
  });

  test("the ideal ranking is capped at ten relevant passages", () => {
    const relevant = new Set(Array.from({ length: 15 }, (_, i) => `r${i}`));
    const ranked = [...relevant].slice(0, 10);
    const score = scoreQuery(ranked, relevant);
    expect(score.ndcg10).toBeCloseTo(1, 10);
    expect(score.recall100).toBeCloseTo(10 / 15, 10);
  });

  test("a hit beyond rank 10 counts for recall only, and beyond 100 for nothing", () => {
    const filler = Array.from({ length: 120 }, (_, i) => `x${i}`);
    const ranked = [...filler.slice(0, 20), "a", ...filler.slice(20, 110), "b"];
    const score = scoreQuery(ranked, new Set(["a", "b"]));
    expect(score.ndcg10).toBe(0);
    expect(score.mrr10).toBe(0);
    expect(score.recall100).toBe(0.5);
  });

  test("a passage returned twice is counted once", () => {
    const score = scoreQuery(["a", "a", "b"], new Set(["a", "b"]));
    expect(score.recall100).toBe(1);
    expect(score.ndcg10).toBeCloseTo((1 + 1 / Math.log2(4)) / (1 + 1 / Math.log2(3)), 10);
  });

  test("a query with no relevant passage is refused", () => {
    expect(() => scoreQuery(["a"], new Set())).toThrow(/at least one relevant/);
  });
});

describe("percentile", () => {
  test("nearest rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("pairedBootstrap", () => {
  test("a uniform gain gives that gain with a zero-width interval", () => {
    const a = [0.1, 0.4, 0.7, 0.2];
    const b = a.map((v) => v + 0.1);
    const result = pairedBootstrap(a, b, seededRandom(1), 200);
    expect(result.difference).toBeCloseTo(0.1, 10);
    expect(result.low).toBeCloseTo(0.1, 10);
    expect(result.high).toBeCloseTo(0.1, 10);
  });

  test("the same seed gives the same interval, and it brackets the mean", () => {
    const a = [0, 0.5, 1, 0.2, 0.9, 0.1];
    const b = [0.3, 0.4, 1, 0.6, 0.2, 0.8];
    const first = pairedBootstrap(a, b, seededRandom(7), 500);
    const second = pairedBootstrap(a, b, seededRandom(7), 500);
    expect(first).toEqual(second);
    expect(first.low).toBeLessThanOrEqual(first.difference);
    expect(first.high).toBeGreaterThanOrEqual(first.difference);
  });

  test("unequal lengths are refused", () => {
    expect(() => pairedBootstrap([1], [1, 2], seededRandom(1))).toThrow(/same length/);
  });
});
