// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * DiversityStage — post-fusion per-source diversity / MMR re-ranking.
 *
 * Re-orders the post-boost candidate pool so a single source type (e.g.
 * `gmail`) can't monopolise the top-k. Two composable, independently-
 * optional mechanisms:
 *
 *   - a hard per-source-type quota (`maxPerSourceInTopK`): no more than N
 *     results per source bucket within the window. Surplus is demoted
 *     (deferred below the quota'd head), never dropped.
 *   - MMR (`lambda`): a soft relevance-vs-source-diversity tradeoff. At
 *     each output position pick the candidate maximising
 *     `lambda * relevanceNorm - (1 - lambda) * bucketRedundancy`. `lambda = 1`
 *     is pure relevance (a no-op ordering); lower values spread sources.
 *
 * It is the last stage that reorders: within candidate generation it runs
 * immediately after boost — the point at which every candidate carries one
 * comparable RRF/boost score, which is what makes the MMR relevance
 * normalisation meaningful — and everything downstream (the RefCount
 * enrichment, then the bounded finalize) preserves the order it produces. So
 * the ordering decided here is the ordering the caller sees, and the top-k it
 * shapes is the top-k that gets returned. The stage is recall-neutral: it only
 * reorders, never adds or drops documents.
 *
 * The reason to spend a stage on this at all is recall@10 on a lopsided corpus.
 * One high-volume source (mail, chat) can occupy every head slot on a
 * moderately generic query and bury the single relevant document another source
 * holds; spreading the head across buckets trades a little top-1 relevance for a
 * materially better chance the answer is on the first page.
 *
 * On by default: `isEnabled` requires `enabled` to be true AND at least one
 * mechanism configured, and the resolved default supplies MMR `lambda` 0.7, so
 * the stage runs by default. It degrades to a no-op on a single-source corpus
 * (one bucket = uniform redundancy = relevance order); `enabled: false`
 * disables it entirely, in which case it emits no stage report.
 */

import { parseSourceKey } from "@omnesis/core";
import type { ResolvedDiversityConfig } from "../search-config.js";
import type { SearchResultItem } from "../types.js";
import type { SearchStage, SearchStageContext } from "./stage.js";

/**
 * Numerical guard for the min-max range when normalising relevance: a
 * span at or below this is treated as "all equal" (rel = 1 for every
 * item).
 */
const RANGE_EPSILON = 1e-9;

export class DiversityStage implements SearchStage {
  readonly name = "diversity";

  isEnabled(ctx: SearchStageContext): boolean {
    return diversityIsEnabled(ctx.diversity, ctx.results.length);
  }

  async execute(ctx: SearchStageContext): Promise<void> {
    const start = Date.now();
    ctx.results = diversityReorder(ctx.results, ctx.diversity, ctx.candidateLimit);
    ctx.stageReports.diversity = {
      status: "ran",
      durationMs: Date.now() - start,
      resultCount: ctx.results.length,
    };
  }
}

/**
 * The diversity gate: the resolved config is enabled, there is more than one
 * result to reorder, and at least one mechanism (hard quota or MMR) is
 * configured. Shared by {@link DiversityStage} and the candidate-generation
 * core so both decide identically whether the pass runs (and emits a report).
 */
export function diversityIsEnabled(d: ResolvedDiversityConfig, resultCount: number): boolean {
  return d.enabled && resultCount > 1 && (d.maxPerSourceInTopK != null || d.lambda != null);
}

/**
 * The diversity stage's pure reorder core: window the pool, optionally MMR-
 * reorder (soft) then quota-reorder (hard) within the window, and leave the
 * tail untouched. Returns a new array; does not mutate the input. Shared by
 * {@link DiversityStage} and the candidate-generation core.
 */
export function diversityReorder(
  results: SearchResultItem[],
  d: ResolvedDiversityConfig,
  candidateLimit: number,
): SearchResultItem[] {
  const n = results.length;
  // Window the diversity pass acts over: explicit `topK`, else the
  // pipeline's candidate pool size. The tail beyond the window is left
  // untouched (it's already below the user-facing slice).
  const k = Math.min(d.topK ?? candidateLimit, n);
  let window = results.slice(0, k);
  const rest = results.slice(k);

  const useType = d.bucketBy !== "sourceId";
  const bucket = (r: SearchResultItem): string => safeSourceBucket(r.sourceId, useType);

  // Phase 1: optional MMR reorder (soft). `lambda === 1` is pure
  // relevance — identical to the input order — so skip it.
  if (d.lambda != null && d.lambda < 1) {
    window = mmrReorder(window, d.lambda, bucket);
  }

  // Phase 2: optional hard quota (cap N per bucket within the window).
  if (d.maxPerSourceInTopK != null) {
    window = quotaReorder(window, d.maxPerSourceInTopK, bucket);
  }

  return [...window, ...rest];
}

/**
 * Derive a result's source bucket. With `useType`, group by the source
 * TYPE (`gmail`, `whatsapp-messages`) so two accounts of the same source
 * count toward one bucket; otherwise group by the full source instance id.
 *
 * `parseSourceKey` throws on a malformed multi-colon `sourceId` (the
 * account part may not contain a colon). Catch it and degrade to instance-
 * id bucketing rather than failing the whole search.
 */
export function safeSourceBucket(sourceId: string, useType: boolean): string {
  if (!useType) return sourceId;
  try {
    return String(parseSourceKey(sourceId).sourceType);
  } catch {
    return sourceId;
  }
}

/**
 * Greedy MMR over a single comparable score scale (post-boost RRF).
 * Relevance is min-max normalized across the window; redundancy is the
 * fraction of already-selected items sharing a candidate's source bucket.
 * Deterministic: ties on the MMR value break on the original score.
 */
export function mmrReorder(
  items: SearchResultItem[],
  lambda: number,
  bucket: (r: SearchResultItem) => string,
): SearchResultItem[] {
  if (items.length === 0) return items;

  const scores = items.map((i) => i.score);
  const lo = Math.min(...scores);
  const hi = Math.max(...scores);
  const range = hi - lo;
  const rel = (i: SearchResultItem): number => (range > RANGE_EPSILON ? (i.score - lo) / range : 1);

  const selected: SearchResultItem[] = [];
  const selectedBucketCounts = new Map<string, number>();
  const pool = [...items];

  while (pool.length > 0) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const b = bucket(c);
      const redundancy =
        selected.length === 0 ? 0 : (selectedBucketCounts.get(b) ?? 0) / selected.length;
      const val = lambda * rel(c) - (1 - lambda) * redundancy;
      if (val > bestVal || (val === bestVal && c.score > bestScore)) {
        bestVal = val;
        bestScore = c.score;
        bestIdx = i;
      }
    }
    const [best] = pool.splice(bestIdx, 1);
    selected.push(best);
    const b = bucket(best);
    selectedBucketCounts.set(b, (selectedBucketCounts.get(b) ?? 0) + 1);
  }
  return selected;
}

/**
 * Stable per-bucket cap with deferral. Walks the items in their incoming
 * (post-MMR or post-boost) order; a candidate within its bucket's quota
 * stays in place, surplus is deferred. Deferred items keep their relative
 * order and are spliced back below the quota'd head — so nothing is
 * dropped (recall-neutral); the surplus is only demoted.
 */
export function quotaReorder(
  items: SearchResultItem[],
  maxPerBucket: number,
  bucket: (r: SearchResultItem) => string,
): SearchResultItem[] {
  const kept: SearchResultItem[] = [];
  const deferred: SearchResultItem[] = [];
  const counts = new Map<string, number>();
  for (const c of items) {
    const b = bucket(c);
    const used = counts.get(b) ?? 0;
    if (used < maxPerBucket) {
      kept.push(c);
      counts.set(b, used + 1);
    } else {
      deferred.push(c);
    }
  }
  return [...kept, ...deferred];
}
