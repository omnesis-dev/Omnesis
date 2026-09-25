// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Exact Jaccard similarity over two shingle sets.
 *
 * | A ∩ B | / | A ∪ B |
 *
 * Returns 0 when both sets are empty (no signal in either direction).
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const item of small) {
    if (large.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/**
 * Exact weighted Jaccard over two shingle sets with per-shingle
 * weights drawn from a shared external table (the IDF use case). When
 * the same shingle appears in both A and B, its weight is identical in
 * both — so the formula reduces to
 *
 *     Σ_{s ∈ A∩B} w(s) / Σ_{s ∈ A∪B} w(s)
 *
 * Either set may be empty; result is 0 in that case.
 */
export function weightedJaccard(
  weightOf: (shingle: string) => number,
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number {
  if (a.size === 0 && b.size === 0) return 0;
  let unionSum = 0;
  let interSum = 0;
  const seen = new Set<string>();
  for (const s of a) {
    seen.add(s);
    const w = weightOf(s);
    unionSum += w;
    if (b.has(s)) interSum += w;
  }
  for (const s of b) {
    if (seen.has(s)) continue;
    unionSum += weightOf(s);
  }
  return unionSum > 0 ? interSum / unionSum : 0;
}

/**
 * Estimated Jaccard from two MinHash signatures: fraction of positions
 * where the two signatures agree. Cheap; useful as a coarse pre-filter
 * before computing exact Jaccard.
 */
export function signatureSimilarity(sigA: Uint32Array, sigB: Uint32Array): number {
  if (sigA.length !== sigB.length) {
    throw new Error(`signature length mismatch: ${sigA.length} vs ${sigB.length}`);
  }
  let matches = 0;
  for (let i = 0; i < sigA.length; i++) {
    if (sigA[i] === sigB[i]) matches++;
  }
  return matches / sigA.length;
}
