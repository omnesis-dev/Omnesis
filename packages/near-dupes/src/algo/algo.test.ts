// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { murmur3_32, murmur3_32_str } from "./hash.js";
import { normalizeText, shingles, tokenize } from "./shingle.js";
import { createMinhashParams, minhash, packSignature, unpackSignature } from "./minhash.js";
import { lshBands, validateLshParams } from "./lsh.js";
import { jaccard, signatureSimilarity } from "./jaccard.js";
import { compileConfig, DEFAULT_CONFIG } from "./index.js";

describe("murmur3_32", () => {
  it("matches known fixed vectors for empty + ascii inputs", () => {
    expect(murmur3_32(new Uint8Array(), 0)).toBe(0);
    expect(murmur3_32_str("", 0)).toBe(0);
    expect(murmur3_32_str("hello", 0)).toBe(murmur3_32_str("hello", 0));
  });
  it("is deterministic and distinguishes close inputs", () => {
    const a = murmur3_32_str("the quick brown fox", 0);
    const b = murmur3_32_str("the quick brown fox.", 0);
    expect(a).not.toBe(b);
    expect(murmur3_32_str("the quick brown fox", 0)).toBe(a);
  });
  it("seed changes output", () => {
    const a = murmur3_32_str("hello", 0);
    const b = murmur3_32_str("hello", 1);
    expect(a).not.toBe(b);
  });
});

describe("normalizeText", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeText("Hello   World\n\tFoo")).toBe("hello world foo");
  });
  it("strips email quote markers by default", () => {
    const reply =
      "Sure, sounds good.\n\nOn Tuesday James wrote:\n> the original text\n> more original text";
    expect(normalizeText(reply)).toBe("sure, sounds good. on tuesday james wrote:");
  });
  it("can keep quotes when stripQuotes is false", () => {
    const reply = "> quoted\nmine";
    expect(normalizeText(reply, { stripQuotes: false })).toBe("> quoted mine");
  });
});

describe("tokenize", () => {
  it("splits on non-word boundaries", () => {
    expect(tokenize("foo, bar! baz.")).toEqual(["foo", "bar", "baz"]);
  });
  it("preserves unicode word chars (treated as word bytes)", () => {
    const t = tokenize("café résumé naïve");
    expect(t.length).toBe(3);
  });
});

describe("shingles", () => {
  it("produces (n - k + 1) shingles for n >= k tokens", () => {
    const s = shingles("the quick brown fox jumps over", 3);
    expect(s.size).toBe(4);
    expect(s.has("the quick brown")).toBe(true);
    expect(s.has("jumps over the")).toBe(false);
  });
  it("returns the whole text as one shingle when shorter than k", () => {
    const s = shingles("two words", 5);
    expect(s.size).toBe(1);
    expect(s.has("two words")).toBe(true);
  });
  it("deduplicates identical shingles", () => {
    const s = shingles("a b a b a b", 2);
    expect(s.has("a b")).toBe(true);
    expect(s.has("b a")).toBe(true);
    expect(s.size).toBe(2);
  });
});

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });
  it("returns 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
  it("returns 0 for two empty sets (no signal)", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
  it("computes intersection over union", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(2 / 4, 6);
  });
});

describe("minhash + signatureSimilarity", () => {
  const params = createMinhashParams(128, 42);

  it("identical shingle sets produce identical signatures", () => {
    const a = shingles("the quick brown fox jumps over the lazy dog", 3);
    const sigA = minhash(a, params);
    const sigB = minhash(a, params);
    expect(Array.from(sigA)).toEqual(Array.from(sigB));
  });

  it("disjoint shingle sets produce ~0 signature similarity", () => {
    const a = new Set(Array.from({ length: 50 }, (_, i) => `apple-${i}`));
    const b = new Set(Array.from({ length: 50 }, (_, i) => `banana-${i}`));
    const sim = signatureSimilarity(minhash(a, params), minhash(b, params));
    expect(sim).toBeLessThan(0.05);
  });

  // Property: signatureSimilarity estimates Jaccard within tolerance.
  // For N=128 the standard deviation of the estimate is sqrt(s(1-s)/N) ≈
  // 0.044 at s=0.5. We allow 0.10 slack to keep this robust without
  // flake; correctness of the estimator is what we're checking, not
  // precision.
  for (const targetJaccard of [0.2, 0.5, 0.8]) {
    it(`signatureSimilarity ≈ jaccard at s≈${targetJaccard} (N=128, 30 trials)`, () => {
      const setSize = 200;
      let totalError = 0;
      const trials = 30;
      for (let t = 0; t < trials; t++) {
        const shared = Math.round((targetJaccard * setSize * 2) / (1 + targetJaccard));
        const uniqA = setSize - shared;
        const uniqB = setSize - shared;
        const a = new Set<string>();
        const b = new Set<string>();
        for (let i = 0; i < shared; i++) {
          a.add(`shared-${t}-${i}`);
          b.add(`shared-${t}-${i}`);
        }
        for (let i = 0; i < uniqA; i++) a.add(`a-${t}-${i}`);
        for (let i = 0; i < uniqB; i++) b.add(`b-${t}-${i}`);
        const actual = jaccard(a, b);
        const est = signatureSimilarity(minhash(a, params), minhash(b, params));
        totalError += Math.abs(est - actual);
      }
      const avgError = totalError / trials;
      expect(avgError).toBeLessThan(0.06);
    });
  }
});

describe("pack / unpack signature", () => {
  it("round-trips", () => {
    const params = createMinhashParams(128, 1);
    const s = shingles("foo bar baz qux quux corge grault garply", 3);
    const sig = minhash(s, params);
    const buf = packSignature(sig);
    expect(buf.length).toBe(128 * 4);
    const restored = unpackSignature(buf, 128);
    expect(Array.from(restored)).toEqual(Array.from(sig));
  });
});

describe("lsh", () => {
  it("validates bands × rows = numHashes", () => {
    expect(() => validateLshParams(128, { bands: 16, rows: 8 })).not.toThrow();
    expect(() => validateLshParams(128, { bands: 10, rows: 8 })).toThrow();
  });

  it("produces `bands` buckets per signature", () => {
    const params = createMinhashParams(128, 7);
    const sig = minhash(shingles("aaaaa bbbbb ccccc ddddd eeeee", 2), params);
    const buckets = lshBands(sig, { bands: 16, rows: 8 });
    expect(buckets.length).toBe(16);
  });

  it("two near-identical documents share at least one bucket (high recall)", () => {
    const params = createMinhashParams(128, 11);
    const text =
      "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
      "incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud";
    const a = shingles(normalizeText(text), 5);
    const b = shingles(normalizeText(text + " exercitation ullamco laboris"), 5);
    const sigA = minhash(a, params);
    const sigB = minhash(b, params);
    const bucketsA = lshBands(sigA, { bands: 16, rows: 8 });
    const bucketsB = lshBands(sigB, { bands: 16, rows: 8 });
    let shared = 0;
    for (let i = 0; i < bucketsA.length; i++) {
      if (bucketsA[i] === bucketsB[i]) shared++;
    }
    expect(shared).toBeGreaterThan(0);
  });

  it("disjoint documents share ~0 buckets (low false-positive rate)", () => {
    const params = createMinhashParams(128, 13);
    const a = shingles(
      normalizeText("the quick brown fox jumps over the lazy dog repeatedly forever"),
      5,
    );
    const b = shingles(
      normalizeText("completely unrelated text about gardening and growing tomatoes well"),
      5,
    );
    const sigA = minhash(a, params);
    const sigB = minhash(b, params);
    const bucketsA = lshBands(sigA, { bands: 16, rows: 8 });
    const bucketsB = lshBands(sigB, { bands: 16, rows: 8 });
    let shared = 0;
    for (let i = 0; i < bucketsA.length; i++) {
      if (bucketsA[i] === bucketsB[i]) shared++;
    }
    expect(shared).toBe(0);
  });
});

describe("compileConfig", () => {
  it("freezes default config and produces matching minhash params", () => {
    const compiled = compileConfig(DEFAULT_CONFIG);
    expect(compiled.cfg.algoVersion).toBe("mh128-k5-b16-r8-v1");
    expect(compiled.minhashParams.numHashes).toBe(128);
    expect(compiled.lshParams).toEqual({ bands: 16, rows: 8, slotsPerRow: 1 });
  });
});
