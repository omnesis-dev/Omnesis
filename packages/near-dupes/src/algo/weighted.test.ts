// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  createWeightedMinhashParams,
  weightedMinhash,
  weightedSignatureSimilarity,
  packWeightedSignature,
  unpackWeightedSignature,
} from "./weighted-minhash.js";
import { DfTable, idfWeight, weighShingles } from "./idf.js";
import { weightedJaccard, jaccard } from "./jaccard.js";
import { shingles, normalizeText } from "./shingle.js";
import { lshBands } from "./lsh.js";
import { computeExclusivity } from "./sketcher.js";
import { compileConfig, DEFAULT_CONFIG, IDF_CONFIG } from "./index.js";

describe("weightedJaccard", () => {
  const wOf = (s: string) => (s === "boilerplate" ? 0.1 : 5.0);

  it("equals 1 when both sets are identical", () => {
    const a = new Set(["foo", "bar", "boilerplate"]);
    expect(weightedJaccard(wOf, a, a)).toBe(1);
  });

  it("equals 0 on disjoint sets", () => {
    expect(weightedJaccard(wOf, new Set(["foo"]), new Set(["bar"]))).toBe(0);
  });

  it("down-weights shared boilerplate vs unique content", () => {
    const a = new Set(["alpha", "beta", "boilerplate"]);
    const b = new Set(["gamma", "delta", "boilerplate"]);
    // Only "boilerplate" is shared. Unweighted Jaccard = 1/5 = 0.2.
    // Weighted: 0.1 / (5+5+5+5+0.1) = 0.1 / 20.1 ≈ 0.005.
    const j = jaccard(a, b);
    const wj = weightedJaccard(wOf, a, b);
    expect(j).toBeCloseTo(0.2, 6);
    expect(wj).toBeLessThan(0.01);
  });

  it("preserves similarity when shared content is high-weight", () => {
    const a = new Set(["body-clause-1", "body-clause-2", "body-clause-3", "boilerplate"]);
    const b = new Set([
      "body-clause-1",
      "body-clause-2",
      "body-clause-3",
      "boilerplate",
      "signature",
    ]);
    // Same body, b has an extra signature shingle.
    const wj = weightedJaccard(wOf, a, b);
    // Shared weight: 3*5 + 0.1 = 15.1. Union weight: 4*5 + 0.1 = 20.1. WJ ≈ 0.75.
    expect(wj).toBeGreaterThan(0.7);
  });
});

describe("DfTable + idfWeight", () => {
  it("counts unique shingles per document", () => {
    const t = new DfTable();
    t.observe(["a", "b", "a", "c"]);
    t.observe(["b", "c", "d"]);
    expect(t.totalDocs).toBe(2);
    expect(t.df("a")).toBe(1);
    expect(t.df("b")).toBe(2);
    expect(t.df("c")).toBe(2);
    expect(t.df("d")).toBe(1);
  });

  it("idfWeight is high for rare shingles, low for common ones", () => {
    const N = 1000;
    const rare = idfWeight(1, N);
    const common = idfWeight(900, N);
    expect(rare).toBeGreaterThan(5);
    expect(common).toBeLessThan(0.2);
  });

  it("respects maxWeight clamp", () => {
    expect(idfWeight(1, 1_000_000, { maxWeight: 5 })).toBe(5);
  });
});

describe("weightedMinhash sketch", () => {
  const params = createWeightedMinhashParams(128, 42);

  it("identical weighted sets produce identical sketches", () => {
    const sh = [
      { shingle: "alpha", weight: 1.0 },
      { shingle: "beta", weight: 2.0 },
      { shingle: "gamma", weight: 0.5 },
    ];
    const a = weightedMinhash(sh, params);
    const b = weightedMinhash(sh, params);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("disjoint sets → near-zero signature similarity", () => {
    const a = Array.from({ length: 30 }, (_, i) => ({ shingle: `a-${i}`, weight: 1 }));
    const b = Array.from({ length: 30 }, (_, i) => ({ shingle: `b-${i}`, weight: 1 }));
    const sigA = weightedMinhash(a, params);
    const sigB = weightedMinhash(b, params);
    expect(weightedSignatureSimilarity(sigA, sigB)).toBeLessThan(0.05);
  });

  // Property: signature collision rate ≈ weighted Jaccard.
  // For N=128, stdev ≈ sqrt(s(1-s)/N). We use 30 trials and average to
  // bring the std error down further; 0.07 slack is comfortable.
  for (const target of [0.2, 0.5, 0.8]) {
    it(`signature collision rate ≈ weighted Jaccard at s≈${target} (N=128, 30 trials)`, () => {
      const setSize = 80;
      const trials = 30;
      let totalErr = 0;
      for (let t = 0; t < trials; t++) {
        const shared = Math.round((target * setSize * 2) / (1 + target));
        const uniq = setSize - shared;
        const a = new Set<string>();
        const b = new Set<string>();
        for (let i = 0; i < shared; i++) {
          a.add(`s-${t}-${i}`);
          b.add(`s-${t}-${i}`);
        }
        for (let i = 0; i < uniq; i++) {
          a.add(`a-${t}-${i}`);
          b.add(`b-${t}-${i}`);
        }
        const wOf = (_s: string) => 1.0;
        const actual = weightedJaccard(wOf, a, b);
        const weightedA = [...a].map((s) => ({ shingle: s, weight: 1.0 }));
        const weightedB = [...b].map((s) => ({ shingle: s, weight: 1.0 }));
        const est = weightedSignatureSimilarity(
          weightedMinhash(weightedA, params),
          weightedMinhash(weightedB, params),
        );
        totalErr += Math.abs(est - actual);
      }
      expect(totalErr / trials).toBeLessThan(0.07);
    });
  }

  it("non-uniform weights matter — adding a heavy unique shingle reduces similarity", () => {
    const shared = [
      { shingle: "common-1", weight: 1.0 },
      { shingle: "common-2", weight: 1.0 },
      { shingle: "common-3", weight: 1.0 },
    ];
    const a = [...shared, { shingle: "a-unique", weight: 10.0 }];
    const b = [...shared, { shingle: "b-unique", weight: 10.0 }];
    const sigA = weightedMinhash(a, params);
    const sigB = weightedMinhash(b, params);
    // Weighted Jaccard ≈ 3 / 23 ≈ 0.13 — sketch collision should match.
    const sim = weightedSignatureSimilarity(sigA, sigB);
    expect(sim).toBeLessThan(0.3);
    expect(sim).toBeGreaterThan(0.05);
  });
});

describe("pack/unpack weighted signature", () => {
  it("round-trips", () => {
    const params = createWeightedMinhashParams(64, 1);
    const sh = [
      { shingle: "foo", weight: 1 },
      { shingle: "bar", weight: 2 },
    ];
    const sig = weightedMinhash(sh, params);
    expect(sig.length).toBe(128);
    const buf = packWeightedSignature(sig);
    expect(buf.length).toBe(128 * 4);
    expect(Array.from(unpackWeightedSignature(buf, 64))).toEqual(Array.from(sig));
  });

  it("round-trips a sub-unit-weight sketch whose t slots go negative (twos-complement)", () => {
    // weight < 1 ⇒ logW < 0 ⇒ tF = floor(logW/r + beta) can be negative.
    // A tiny weight drives logW strongly negative so at least one of the
    // 128 t-slots is guaranteed < 0, exercising the `tF | 0` twos-complement
    // store path. The contract: pack→unpack must reproduce the array exactly,
    // and equality compare across the round-trip must still hold.
    const params = createWeightedMinhashParams(128, 11);
    const sh = [
      { shingle: "alpha-shingle", weight: 0.001 },
      { shingle: "beta-shingle", weight: 0.002 },
      { shingle: "gamma-shingle", weight: 0.5 },
    ];
    const sig = weightedMinhash(sh, params);

    // Prove the negative-t path actually fired: at least one odd (t) slot
    // holds a value with the high bit set, i.e. the unsigned image of a
    // negative int32.
    let sawNegativeT = false;
    for (let k = 0; k < 128; k++) {
      // Odd slots hold t; even slots hold the winner hash.
      if ((sig[2 * k + 1] | 0) < 0) sawNegativeT = true;
    }
    expect(sawNegativeT).toBe(true);

    const buf = packWeightedSignature(sig);
    const restored = unpackWeightedSignature(buf, 128);
    expect(Array.from(restored)).toEqual(Array.from(sig));

    // Equality compare survives the round-trip: a sketch compared against its
    // own packed-then-unpacked copy must report perfect similarity, which only
    // holds if the negative t values compare equal post-restore.
    expect(weightedSignatureSimilarity(sig, restored)).toBe(1);
  });

  it("skips weight<=0 shingles — zero/negative weights cannot win a slot", () => {
    // The `if (!(weight > 0)) continue` guard means a set augmented with
    // non-positive-weight shingles sketches identically to the set without
    // them: they never participate, so the signature is unchanged.
    const params = createWeightedMinhashParams(64, 3);
    const base = [
      { shingle: "keep-1", weight: 2.0 },
      { shingle: "keep-2", weight: 1.5 },
      { shingle: "keep-3", weight: 3.0 },
    ];
    const withDead = [
      ...base,
      { shingle: "dead-zero", weight: 0 },
      { shingle: "dead-neg", weight: -4.0 },
      { shingle: "dead-nan", weight: Number.NaN },
    ];
    const sigBase = weightedMinhash(base, params);
    const sigWithDead = weightedMinhash(withDead, params);
    expect(Array.from(sigWithDead)).toEqual(Array.from(sigBase));
  });
});

describe("weightedSignatureSimilarity validation", () => {
  it("throws on odd-length or mismatched signatures", () => {
    const params = createWeightedMinhashParams(8, 1);
    const ok = weightedMinhash([{ shingle: "x", weight: 1 }], params);
    expect(ok.length).toBe(16);
    // Length mismatch (16 vs 14) throws.
    expect(() => weightedSignatureSimilarity(ok, new Uint32Array(14))).toThrow();
    // Odd length (15 vs 15) throws on the `% 2 !== 0` guard.
    expect(() => weightedSignatureSimilarity(new Uint32Array(15), new Uint32Array(15))).toThrow();
  });
});

describe("LSH on weighted signatures", () => {
  it("near-identical weighted docs share ≥1 band", () => {
    const params = createWeightedMinhashParams(128, 5);
    const base = Array.from({ length: 40 }, (_, i) => ({ shingle: `shared-${i}`, weight: 1 }));
    const a = [...base, { shingle: "a-only", weight: 2 }];
    const b = [...base, { shingle: "b-only", weight: 2 }];
    const sigA = weightedMinhash(a, params);
    const sigB = weightedMinhash(b, params);
    const bA = lshBands(sigA, { bands: 16, rows: 8, slotsPerRow: 2 });
    const bB = lshBands(sigB, { bands: 16, rows: 8, slotsPerRow: 2 });
    let shared = 0;
    for (let i = 0; i < bA.length; i++) if (bA[i] === bB[i]) shared++;
    expect(shared).toBeGreaterThan(0);
  });

  it("disjoint weighted docs share ~0 bands", () => {
    const params = createWeightedMinhashParams(128, 7);
    const a = Array.from({ length: 40 }, (_, i) => ({ shingle: `a-${i}`, weight: 1 }));
    const b = Array.from({ length: 40 }, (_, i) => ({ shingle: `b-${i}`, weight: 1 }));
    const sigA = weightedMinhash(a, params);
    const sigB = weightedMinhash(b, params);
    const bA = lshBands(sigA, { bands: 16, rows: 8, slotsPerRow: 2 });
    const bB = lshBands(sigB, { bands: 16, rows: 8, slotsPerRow: 2 });
    let shared = 0;
    for (let i = 0; i < bA.length; i++) if (bA[i] === bB[i]) shared++;
    expect(shared).toBe(0);
  });
});

describe("compileConfig (weighted)", () => {
  it("vanilla and idf both compile to valid LSH params", () => {
    expect(() => compileConfig(DEFAULT_CONFIG)).not.toThrow();
    expect(() => compileConfig(IDF_CONFIG)).not.toThrow();
    const cidf = compileConfig(IDF_CONFIG);
    expect(cidf.lshParams.slotsPerRow).toBe(2);
  });
});

describe("end-to-end: Hyrox-style boilerplate ↔ contract-style unique-body", () => {
  it("IDF weighting reduces similarity for boilerplate-only overlap", () => {
    // Construct two docs that share a long legal notice but differ in
    // unique body. Boilerplate (high DF), unique body (low DF).
    const boilerplate = Array.from({ length: 30 }, (_, i) => `legal-${i}`);
    const docA = [...boilerplate, "event-aurora", "date-march", "name-alice"];
    const docB = [...boilerplate, "event-zenith", "date-october", "name-bob"];

    // A corpus where the boilerplate appears in 50 other docs; uniques are singletons.
    const table = new DfTable();
    for (let i = 0; i < 50; i++) table.observe(boilerplate);
    table.observe(docA);
    table.observe(docB);

    const setA = new Set(docA);
    const setB = new Set(docB);
    const unweighted = jaccard(setA, setB);
    const weighted = weightedJaccard((s) => idfWeight(table.df(s), table.totalDocs), setA, setB);

    // Unweighted: 30 boilerplate shared / 36 union ≈ 0.83
    // Weighted: shared boilerplate carries low weight; uniques are heavy.
    expect(unweighted).toBeGreaterThan(0.7);
    expect(weighted).toBeLessThan(0.3);
  });

  it("IDF weighting preserves similarity when shared content is unique-per-corpus", () => {
    // Two near-identical contracts: identical body of rare shingles,
    // one has a signature block.
    const body = Array.from({ length: 30 }, (_, i) => `contract-body-${i}`);
    const docA = [...body];
    const docB = [...body, "signed-by-alice", "date-2026-04-01"];

    const table = new DfTable();
    // Each body shingle is essentially unique (appears only here).
    table.observe(docA);
    table.observe(docB);
    for (let i = 0; i < 50; i++) {
      // Other unrelated docs in the corpus.
      table.observe([`other-${i}-a`, `other-${i}-b`, `other-${i}-c`]);
    }

    const setA = new Set(docA);
    const setB = new Set(docB);
    const weighted = weightedJaccard((s) => idfWeight(table.df(s), table.totalDocs), setA, setB);
    expect(weighted).toBeGreaterThan(0.85);
  });
});

describe("weighShingles helper", () => {
  it("attaches weights and drops zero-weight shingles", () => {
    const t = new DfTable();
    t.observe(["a", "b"]);
    t.observe(["a", "c"]);
    t.observe(["d"]);
    const out = [...weighShingles(["a", "b"], t)];
    expect(out.length).toBe(2);
    expect(out[0].df).toBe(2);
    expect(out[1].df).toBe(1);
    expect(out[1].weight).toBeGreaterThan(out[0].weight);
  });
});

describe("computeExclusivity", () => {
  it("zero for pairs whose shared content is all template (high DF)", () => {
    const t = new DfTable();
    // Boilerplate appears in 11 other docs (the Hyrox-cluster pattern).
    const boilerplate = Array.from({ length: 30 }, (_, i) => `legal-${i}`);
    for (let i = 0; i < 11; i++) t.observe(boilerplate);
    // Two docs that only share the boilerplate.
    const a = new Set([...boilerplate, "kelly", "ticket-001"]);
    const b = new Set([...boilerplate, "nico", "ticket-002"]);
    const e = computeExclusivity(t, a, b);
    expect(e.intersectionSize).toBe(30);
    expect(e.pairUniqueDf2).toBe(0);
    expect(e.pairUniqueDf5).toBe(0);
  });

  it("non-zero for true near-dupe pairs (intersection contains pair-unique shingles)", () => {
    const t = new DfTable();
    const boilerplate = Array.from({ length: 30 }, (_, i) => `legal-${i}`);
    // Boilerplate appears across many docs.
    for (let i = 0; i < 11; i++) t.observe(boilerplate);
    // Eve has her name in both copies — these shingles are pair-unique.
    const eveA = new Set([...boilerplate, "eve-spec-ticket-123"]);
    const eveB = new Set([...boilerplate, "eve-spec-ticket-123"]);
    t.observe(eveA);
    t.observe(eveB);

    const e = computeExclusivity(t, eveA, eveB);
    expect(e.intersectionSize).toBe(31);
    // "eve-spec-ticket-123" appears in exactly 2 docs (her two copies).
    expect(e.pairUniqueDf2).toBe(1);
    expect(e.pairUniqueDf5).toBe(1);
  });

  it("counts scale with cap — DF<=5 includes more shingles than DF<=2", () => {
    const t = new DfTable();
    // 'common-3' has DF=3, 'common-5' has DF=5, 'rare' has DF=2.
    t.observe(["common-3", "common-5"]);
    t.observe(["common-3", "common-5"]);
    t.observe(["common-3", "common-5"]);
    t.observe(["common-5"]);
    t.observe(["common-5"]);
    t.observe(["rare", "x"]);
    t.observe(["rare", "y"]);

    const a = new Set(["common-3", "common-5", "rare"]);
    const b = new Set(["common-3", "common-5", "rare"]);
    const e = computeExclusivity(t, a, b);
    expect(e.intersectionSize).toBe(3);
    expect(e.pairUniqueDf2).toBe(1); // only "rare"
    expect(e.pairUniqueDf5).toBe(3); // all three (df=3, 5, 2)
  });
});

describe("vanilla LSH unchanged by slotsPerRow default", () => {
  it("works with no slotsPerRow set (legacy callers)", () => {
    const sig = new Uint32Array(128).fill(0);
    const b = lshBands(sig, { bands: 16, rows: 8 });
    expect(b.length).toBe(16);
  });
});

describe("normalizeText + shingles still work (regression)", () => {
  it("yields the same shingle set when called twice", () => {
    const s1 = shingles(normalizeText("foo bar baz qux quux"), 3);
    const s2 = shingles(normalizeText("foo bar baz qux quux"), 3);
    expect([...s1]).toEqual([...s2]);
  });
});
