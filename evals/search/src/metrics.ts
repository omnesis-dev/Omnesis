// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Ranking metrics for one query, as MIRACL defines them: relevance is binary
 * and an unjudged passage counts as not relevant.
 */

export interface QueryScore {
  /** Rewards relevant passages near the top of the first ten; 1 is ideal. */
  ndcg10: number;
  /** Share of the query's relevant passages found in the first hundred. */
  recall100: number;
  /** 1 / rank of the first relevant passage in the first ten, else 0. */
  mrr10: number;
}

/**
 * @param ranked passage ids in ranked order, best first
 * @param relevant ids judged relevant for the query; must not be empty
 */
export function scoreQuery(ranked: readonly string[], relevant: ReadonlySet<string>): QueryScore {
  if (relevant.size === 0) throw new Error("A scored query needs at least one relevant passage");
  let dcg = 0;
  let mrr10 = 0;
  let found = 0;
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(ranked.length, 100); i += 1) {
    const id = ranked[i]!;
    if (seen.has(id) || !relevant.has(id)) {
      seen.add(id);
      continue;
    }
    seen.add(id);
    found += 1;
    if (i < 10) {
      dcg += 1 / Math.log2(i + 2);
      if (mrr10 === 0) mrr10 = 1 / (i + 1);
    }
  }
  let ideal = 0;
  for (let i = 0; i < Math.min(relevant.size, 10); i += 1) ideal += 1 / Math.log2(i + 2);
  return { ndcg10: dcg / ideal, recall100: found / relevant.size, mrr10 };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** The value below which `p` (0..1) of the samples fall; nearest rank. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/**
 * Mean of `b - a` over paired samples with a 95% bootstrap interval: the pairs
 * are resampled with replacement `rounds` times. `random` is injectable so a
 * comparison is reproducible.
 */
export function pairedBootstrap(
  a: readonly number[],
  b: readonly number[],
  random: () => number,
  rounds = 2000,
): { difference: number; low: number; high: number } {
  if (a.length !== b.length) throw new Error("Paired samples must have the same length");
  const n = a.length;
  if (n === 0) return { difference: 0, low: 0, high: 0 };
  const deltas = a.map((value, i) => b[i]! - value);
  const means: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += deltas[Math.floor(random() * n)]!;
    means.push(sum / n);
  }
  return {
    difference: mean(deltas),
    low: percentile(means, 0.025),
    high: percentile(means, 0.975),
  };
}

/** A small seeded generator (mulberry32) so bootstrap intervals are repeatable. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
