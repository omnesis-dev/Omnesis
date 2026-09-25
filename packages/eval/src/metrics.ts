// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { QueryMetrics, RetrievedDoc, SuiteQuery } from "./types.js";

/**
 * Score a single query result against the resolved
 * ground-truth doc id sets.
 *
 * Binary relevance: a "hit" means at least one of an expected doc's
 * resolved ids appears at rank ≤ k. `recall_at_10` is the fraction of
 * distinct expected docs that hit within top-10; `mrr` is the
 * reciprocal rank of the *first* matching expected doc (any group).
 *
 * `latencyMs` is the median across timed repeats — the caller passes it
 * in so this function stays pure and reusable for any latency definition.
 */
export function scoreQuery(
  retrieved: RetrievedDoc[],
  resolvedDocIdGroups: string[][],
  latencyMs: number,
): QueryMetrics & { hit_any: boolean; best_rank: number | null } {
  const sets = resolvedDocIdGroups.map((g) => new Set(g));
  const totalGroups = sets.length;

  let bestRank: number | null = null;
  // Per-group: did any rank match?
  const groupHit = sets.map(() => false);

  for (let i = 0; i < retrieved.length; i++) {
    const docId = retrieved[i]!.document_id;
    for (let g = 0; g < sets.length; g++) {
      if (sets[g]!.has(docId)) {
        groupHit[g] = true;
        const rank = i + 1;
        if (bestRank === null || rank < bestRank) bestRank = rank;
      }
    }
  }

  const hit_at_1 = anyHitWithinRank(retrieved, sets, 1);
  const hit_at_5 = anyHitWithinRank(retrieved, sets, 5);
  const hit_at_10 = anyHitWithinRank(retrieved, sets, 10);

  const groupsHitWithin10 = groupsHitWithinRank(retrieved, sets, 10);
  const recall_at_10 = totalGroups > 0 ? groupsHitWithin10 / totalGroups : 0;
  const mrr = bestRank === null ? 0 : 1 / bestRank;

  // Recall@k curve (fraction of expected groups hit within k) for a few cut-offs.
  const recall_at_k: Record<string, number> = {};
  for (const k of [1, 3, 5, 10, 20]) {
    recall_at_k[String(k)] =
      totalGroups > 0 ? groupsHitWithinRank(retrieved, sets, k) / totalGroups : 0;
  }

  // Context-token cost (chars/4 proxy over chunk_text). `context_tokens_to_hit`
  // is the cost to surface the answer (snippets ranked ≤ first hit); falls when
  // the answer is promoted toward the top.
  const context_tokens_to_hit = bestRank === null ? null : sumTokens(retrieved.slice(0, bestRank));
  const context_tokens_at_10 = sumTokens(retrieved.slice(0, 10));

  return {
    hit_at_1: hit_at_1 ? 1 : 0,
    hit_at_5: hit_at_5 ? 1 : 0,
    hit_at_10: hit_at_10 ? 1 : 0,
    recall_at_10,
    mrr,
    latency_ms: latencyMs,
    recall_at_k,
    context_tokens_to_hit,
    context_tokens_at_10,
    hit_any: bestRank !== null,
    best_rank: bestRank,
  };
}

/** Cheap token proxy: ~4 chars per token, matching the `query_lengths` convention. */
function tokenCost(text: string | undefined): number {
  return Math.ceil((text ?? "").length / 4);
}

function sumTokens(docs: RetrievedDoc[]): number {
  let total = 0;
  for (const d of docs) total += tokenCost(d.chunk_text);
  return total;
}

function anyHitWithinRank(retrieved: RetrievedDoc[], sets: Set<string>[], k: number): boolean {
  const top = retrieved.slice(0, k);
  for (const r of top) {
    for (const s of sets) if (s.has(r.document_id)) return true;
  }
  return false;
}

function groupsHitWithinRank(retrieved: RetrievedDoc[], sets: Set<string>[], k: number): number {
  const top = retrieved.slice(0, k);
  let count = 0;
  for (const s of sets) {
    if (top.some((r) => s.has(r.document_id))) count++;
  }
  return count;
}

/**
 * Percentile of a numeric array (linear interpolation on sorted values).
 * `p` in [0, 100]. Returns 0 for empty input.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

export function median(values: number[]): number {
  return percentile(values, 50);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Determine whether the `must_rank_above` assertion (if set) held for
 * this query's best-matching expected doc. Returned for the run output;
 * not surfaced as a hard failure in v1 (just recorded).
 */
export function assertionsHeld(
  query: SuiteQuery,
  bestRank: number | null,
): { mustRankAbove: boolean | null } {
  if (query.mustRankAbove === undefined) {
    return { mustRankAbove: null };
  }
  if (bestRank === null) return { mustRankAbove: false };
  return { mustRankAbove: bestRank <= query.mustRankAbove };
}
