// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";

import { containsNormalized, containsNormalizedForContent } from "./quote-match.js";

describe("containsNormalized", () => {
  it("matches case- and whitespace-insensitively", () => {
    expect(containsNormalized("Invoice   TOTAL\ndue  NOW", "invoice total due now")).toBe(true);
    expect(containsNormalized("hello world", "goodbye")).toBe(false);
  });

  it("rejects an empty needle", () => {
    expect(containsNormalized("anything", "")).toBe(false);
    expect(containsNormalized("anything", "   ")).toBe(false);
  });

  // The curly-apostrophe regression: a doc rendering U+2019 must accept a
  // straight-quoted needle, and vice versa — the fold works in both directions.
  it("matches across curly and straight apostrophes in both directions", () => {
    expect(containsNormalized("the report says it’s ready to ship", "it's ready")).toBe(true);
    expect(containsNormalized("the report says it's ready to ship", "it’s ready")).toBe(true);
  });

  it("matches across curly and straight double quotes and dashes", () => {
    expect(containsNormalized("the “scope freeze” runs 9–5", '"scope freeze" runs 9-5')).toBe(true);
    expect(containsNormalized('the "scope freeze" runs 9-5', "“scope freeze” runs 9–5")).toBe(true);
  });
});

describe("containsNormalizedForContent", () => {
  it("agrees with containsNormalized", () => {
    const content = "Checkout is on   Saturday,\n25 July.";
    expect(containsNormalizedForContent("h1", content, "saturday, 25 july")).toBe(
      containsNormalized(content, "saturday, 25 july"),
    );
    expect(containsNormalizedForContent("h1", content, "sunday")).toBe(false);
  });

  it("normalizes a given content body once across repeated quote checks", () => {
    const big = "word ".repeat(50_000) + "NEEDLE token";
    const spy = vi.spyOn(String.prototype, "replace");
    // Calibrate the fixed replace-call cost of one normalization (the shared
    // normalizer chains several folds), so the bound below tracks it.
    const calibrateFrom = spy.mock.calls.length;
    containsNormalized("tiny haystack", "tiny"); // needle + haystack = 2 normalizations
    const perNormalization = (spy.mock.calls.length - calibrateFrom) / 2;
    const before = spy.mock.calls.length;
    // Same content hash, three different needles → body normalized once.
    containsNormalizedForContent("hash-A", big, "needle token");
    containsNormalizedForContent("hash-A", big, "word word");
    containsNormalizedForContent("hash-A", big, "absent phrase");
    // Each call still normalizes its short needle (3), but the huge haystack
    // is normalized only on the first call — 4 normalizations total, not 6.
    const added = spy.mock.calls.length - before;
    expect(added).toBeLessThanOrEqual(perNormalization * 4);
    spy.mockRestore();

    expect(containsNormalizedForContent("hash-A", big, "needle token")).toBe(true);
  });

  it("re-normalizes when the content hash changes (no stale match)", () => {
    // A quote present in v1's body must NOT pass against v2 that no longer has it,
    // even at the same cache slot — the hash key guarantees invalidation.
    expect(containsNormalizedForContent("v1", "the flight is AC482", "ac482")).toBe(true);
    expect(containsNormalizedForContent("v2", "the flight was cancelled", "ac482")).toBe(false);
  });

  it("caches the punctuation-folded form, so curly content matches straight needles", () => {
    const content = "the reply reads: “it’s approved — ship it”";
    // First call populates the cache under this hash; the second must hit the
    // cached (already-folded) haystack and still match a straight-quoted needle.
    expect(containsNormalizedForContent("fold-1", content, "it’s approved")).toBe(true);
    expect(containsNormalizedForContent("fold-1", content, '"it\'s approved - ship it"')).toBe(
      true,
    );
  });
});
