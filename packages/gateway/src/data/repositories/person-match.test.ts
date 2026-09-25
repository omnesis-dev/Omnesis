// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Match-quality primitives for people search: the edit-distance budget and the
 * bounded distance function the fuzzy rescue pass is built on.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { describe, expect, test } from "vitest";
import {
  MATCH_RANK,
  MATCH_RANK_NONE,
  boundedEditDistance,
  matchRankParams,
  maxEditDistanceFor,
} from "./person-match.js";

describe("maxEditDistanceFor", () => {
  test("gives short queries no budget at all", () => {
    // One edit on a three-letter string reaches a large share of all
    // three-letter strings, so fuzziness there is noise, not rescue.
    expect(maxEditDistanceFor("")).toBe(0);
    expect(maxEditDistanceFor("j")).toBe(0);
    expect(maxEditDistanceFor("jo")).toBe(0);
    expect(maxEditDistanceFor("jon")).toBe(0);
  });

  test("allows one edit at nickname length", () => {
    expect(maxEditDistanceFor("rite")).toBe(1);
    expect(maxEditDistanceFor("sarah")).toBe(1);
    expect(maxEditDistanceFor("miriam")).toBe(1);
  });

  test("allows two edits once the query is long enough to absorb them", () => {
    expect(maxEditDistanceFor("mendoza")).toBe(2);
    expect(maxEditDistanceFor("constantine")).toBe(2);
  });

  test("is monotonic in query length", () => {
    let prev = 0;
    for (let n = 0; n <= 20; n++) {
      const budget = maxEditDistanceFor("x".repeat(n));
      expect(budget).toBeGreaterThanOrEqual(prev);
      prev = budget;
    }
  });
});

describe("boundedEditDistance", () => {
  test("identical strings are distance zero", () => {
    expect(boundedEditDistance("reyes", "reyes", 2)).toBe(0);
    expect(boundedEditDistance("", "", 2)).toBe(0);
  });

  test("counts a single substitution, insertion, or deletion as one", () => {
    expect(boundedEditDistance("rite", "rate", 2)).toBe(1); // substitution
    expect(boundedEditDistance("rit", "rite", 2)).toBe(1); // insertion
    expect(boundedEditDistance("rite", "rit", 2)).toBe(1); // deletion
  });

  test("counts a transposition as two edits", () => {
    // Levenshtein rather than Damerau — a swap is a delete plus an insert.
    expect(boundedEditDistance("reyes", "reyse", 3)).toBe(2);
  });

  test("is symmetric", () => {
    const pairs: [string, string][] = [
      ["ritika", "rit"],
      ["marguerite", "margarite"],
      ["nakamura", "nakomura"],
      ["", "vance"],
    ];
    for (const [a, b] of pairs) {
      expect(boundedEditDistance(a, b, 4)).toBe(boundedEditDistance(b, a, 4));
    }
  });

  test("handles an empty string against a non-empty one", () => {
    expect(boundedEditDistance("", "abc", 5)).toBe(3);
    expect(boundedEditDistance("abc", "", 5)).toBe(3);
    // Still capped when the other string is longer than the budget.
    expect(boundedEditDistance("", "abcdef", 2)).toBe(3);
  });

  test("returns max + 1 rather than the true distance once the cap is passed", () => {
    // The contract callers rely on: any value above `max` means "too far",
    // and its exact magnitude is not meaningful.
    expect(boundedEditDistance("ritika", "vance", 1)).toBe(2);
    expect(boundedEditDistance("ritika", "vance", 2)).toBe(3);
    expect(boundedEditDistance("abcdefgh", "zzzzzzzz", 3)).toBe(4);
  });

  test("never reports a distance above the cap as within it", () => {
    // Property check: for every pair and every cap, a returned value <= max
    // must equal the uncapped distance, and a value > max must mean the
    // uncapped distance really did exceed the cap.
    const words = ["rit", "rite", "ritika", "marguerite", "vance", "", "reyes", "rates"];
    for (const a of words) {
      for (const b of words) {
        const truth = boundedEditDistance(a, b, Number.MAX_SAFE_INTEGER);
        for (let max = 0; max <= 4; max++) {
          const got = boundedEditDistance(a, b, max);
          if (truth <= max) expect(got).toBe(truth);
          else expect(got).toBe(max + 1);
        }
      }
    }
  });

  test("short-circuits on length difference without scanning", () => {
    // A long string against a short one cannot be close; the guard returns
    // immediately rather than building the matrix.
    expect(boundedEditDistance("a", "a".repeat(5000), 2)).toBe(3);
  });

  test("a zero budget admits only equality", () => {
    expect(boundedEditDistance("rit", "rit", 0)).toBe(0);
    expect(boundedEditDistance("rit", "rite", 0)).toBe(1);
  });
});

describe("matchRankParams", () => {
  test("lowercases the query into every pattern under the given prefix", () => {
    const params = matchRankParams("Rite", "q");
    expect(params.qExact).toBe("rite");
    expect(params.qPrefix).toBe("rite%");
    expect(params.qInfix).toBe("%rite%");
  });

  test("emits one word-boundary pattern per separator", () => {
    const params = matchRankParams("bose", "q");
    const word = Object.entries(params).filter(([k]) => k.startsWith("qWord"));
    expect(word.length).toBeGreaterThan(0);
    // Space and the address/compound-name separators are all covered, so a
    // surname or an email domain scores as a word start.
    const values = word.map(([, v]) => v);
    expect(values).toContain("% bose%");
    expect(values).toContain("%.bose%");
    expect(values).toContain("%@bose%");
    expect(values).toContain("%-bose%");
    // The underscore separator is escaped — unescaped it is LIKE's
    // single-character wildcard, which would score any one-character prefix
    // as a word start.
    expect(values).toContain("%\\_bose%");
  });

  test("escapes LIKE wildcards inside the query itself", () => {
    const params = matchRankParams("a_b%c", "q");
    expect(params.qInfix).toBe("%a\\_b\\%c%");
    // The exact comparison is a plain equality, so it keeps the raw text.
    expect(params.qExact).toBe("a_b%c");
  });

  test("two prefixes produce disjoint parameter names", () => {
    const a = matchRankParams("bose", "matchRaw");
    const b = matchRankParams("bose", "matchNorm");
    for (const key of Object.keys(a)) expect(key in b).toBe(false);
  });

  test("tier constants are ordered best to worst and distinct", () => {
    const tiers = [
      MATCH_RANK.EXACT,
      MATCH_RANK.PREFIX,
      MATCH_RANK.WORD,
      MATCH_RANK.INFIX,
      MATCH_RANK.FUZZY,
    ];
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(new Set(tiers).size).toBe(tiers.length);
    // The sentinel must lose to every real tier so a MIN() over it is safe.
    expect(MATCH_RANK_NONE).toBeGreaterThan(MATCH_RANK.FUZZY);
  });
});
