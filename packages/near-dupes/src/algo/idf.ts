// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { murmur3_32_str } from "./hash.js";

/**
 * Per-shingle document-frequency table, keyed by a 32-bit hash of the
 * shingle string. Collisions at the 32-bit hash space are tolerated:
 * for a 5-word shingle vocabulary in the millions, the collision rate
 * is negligible and the failure mode is a marginally-wrong weight, not
 * a crash.
 */
export class DfTable {
  totalDocs = 0;
  private readonly counts = new Map<number, number>();

  /**
   * Record the set of shingles seen in a single document. The set
   * semantics matter — multiple occurrences of the same shingle in one
   * document count as df += 1, not += occurrences.
   */
  observe(shingles: Iterable<string>): void {
    this.totalDocs++;
    const seen = new Set<number>();
    for (const s of shingles) {
      const h = murmur3_32_str(s, 0);
      if (seen.has(h)) continue;
      seen.add(h);
      this.counts.set(h, (this.counts.get(h) ?? 0) + 1);
    }
  }

  df(shingle: string): number {
    return this.counts.get(murmur3_32_str(shingle, 0)) ?? 0;
  }

  dfByHash(shingleHash: number): number {
    return this.counts.get(shingleHash >>> 0) ?? 0;
  }

  size(): number {
    return this.counts.size;
  }

  /**
   * Histogram of DF values — useful for tuning weight policies and for
   * surfacing how heavy the "templated boilerplate" tail is.
   */
  dfHistogram(): Map<number, number> {
    const h = new Map<number, number>();
    for (const v of this.counts.values()) {
      h.set(v, (h.get(v) ?? 0) + 1);
    }
    return h;
  }
}

export interface IdfWeightOpts {
  /** Lower bound applied to the weight; default 0 (no clamp). */
  minWeight?: number;
  /** Upper bound; useful to cap weights of singleton shingles. */
  maxWeight?: number;
}

/**
 * Smoothed IDF: log((totalDocs + 1) / (df + 1)). Guarantees w > 0 for
 * df < totalDocs + 1 and avoids div-by-zero on unseen shingles.
 */
export function idfWeight(df: number, totalDocs: number, opts?: IdfWeightOpts): number {
  const w = Math.log((totalDocs + 1) / (df + 1));
  const lo = opts?.minWeight ?? 0;
  const hi = opts?.maxWeight ?? Number.POSITIVE_INFINITY;
  return Math.min(Math.max(w, lo), hi);
}

/**
 * Map a shingle set to (shingle, weight) pairs using the given table.
 * Shingles unseen by the table get weight = idfWeight(0, totalDocs)
 * (the singleton weight), which is correct under the smoothed formula.
 */
export function* weighShingles(
  shingles: Iterable<string>,
  table: DfTable,
  opts?: IdfWeightOpts,
): Iterable<{ shingle: string; weight: number; df: number }> {
  for (const s of shingles) {
    const df = table.df(s);
    const weight = idfWeight(df, table.totalDocs, opts);
    if (weight > 0) yield { shingle: s, weight, df };
  }
}
