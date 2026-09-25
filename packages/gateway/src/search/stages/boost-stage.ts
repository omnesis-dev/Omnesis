// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isHiddenSearchType } from "../hidden-sources.js";
import type { ResolvedSourcePriorsConfig, SearchResultItem } from "../types.js";
import type { SearchStage, SearchStageContext } from "./stage.js";
import type { ResolvedSearchSettings } from "../search-config.js";

/**
 * Multiplicative penalty applied to a surfaced cognitive mirror (an open-loop
 * projection). Mirrors are short and term-dense, so BM25 length-normalisation
 * plus the rank-1 fusion bonus can float one above the real documents it
 * summarises; this pulls it back below them. A source-prior penalty would NOT
 * work here — `applySourcePriors` is bypassed for strong-BM25 hits, which is
 * exactly when a short mirror wins. Applied unconditionally, which is safe: a
 * mirror only enters the frame when cognitive projection surfaced it (a mixed
 * doc+mirror frame — the case this reorders) or a `documentTypes:["open-loop"]`
 * scoped query fetched it (a homogeneous frame, where a uniform factor is
 * order-preserving), so an ordinary search is untouched.
 */
const COGNITIVE_MIRROR_DOWNWEIGHT = 0.5;

export class BoostStage implements SearchStage {
  readonly name = "boost";

  isEnabled(ctx: SearchStageContext): boolean {
    // Always run: even without settings boosts we still need the final
    // sort to honor whatever scoring the upstream stages produced.
    return true;
  }

  async execute(ctx: SearchStageContext): Promise<void> {
    const start = Date.now();
    applyBoostPass(ctx.results, ctx.settings, ctx.sourcePriors);
    ctx.stageReports.boost = {
      status: "ran",
      durationMs: Date.now() - start,
      resultCount: ctx.results.length,
    };
  }
}

/**
 * The boost stage's pure core: type/relevance boosts (when the settings declare
 * any), the per-source-type prior, the cognitive-mirror down-weight, then the
 * single re-sort by score. Shared by {@link BoostStage} (main-thread stage
 * wrapper) and the candidate-generation core so the two paths apply byte-
 * identical scoring. Mutates `results` in place.
 */
export function applyBoostPass(
  results: SearchResultItem[],
  settings: ResolvedSearchSettings,
  sourcePriors: ResolvedSourcePriorsConfig,
): void {
  applyBoosts(results, settings);
  applySourcePriors(results, sourcePriors);
  applyCognitiveMirrorDownweight(results);
  results.sort((a, b) => b.score - a.score);
}

function applyBoosts(results: SearchResultItem[], settings: ResolvedSearchSettings): void {
  const typeBoosts = settings.boosts.typeBoosts;
  const relevanceWeight = settings.boosts.relevanceBoostWeight;

  for (const result of results) {
    let boost = 1.0;

    if (typeBoosts && typeBoosts[result.documentType]) {
      const typeBst = typeBoosts[result.documentType];
      boost *= typeBst;
      if (result.scoreBreakdown) result.scoreBreakdown.typeBoost = typeBst;
    }

    // Relevance boost only applies when source provides a score (null = neutral 1.0x).
    if (relevanceWeight && result.relevanceScore != null) {
      const rb = 1.0 + relevanceWeight * (result.relevanceScore - 0.5) * 2;
      boost *= rb;
      if (result.scoreBreakdown) result.scoreBreakdown.relevanceBoost = rb;
    }

    result.score *= boost;
    if (result.scoreBreakdown) result.scoreBreakdown.finalScore = result.score;
  }
}

/**
 * Pull surfaced cognitive mirrors below the real documents they summarise. A
 * no-op on ordinary searches (mirrors are excluded and never in the frame);
 * only matters when cognitive projection surfaced them.
 */
function applyCognitiveMirrorDownweight(results: SearchResultItem[]): void {
  for (const result of results) {
    if (!isHiddenSearchType(result.documentType)) continue;
    result.score *= COGNITIVE_MIRROR_DOWNWEIGHT;
    if (result.scoreBreakdown) result.scoreBreakdown.finalScore = result.score;
  }
}

/**
 * Apply the configurable per-source-type score prior to every result
 * whose `sourceId` starts with one of the configured prefixes — unless
 * the candidate has a strong BM25 hit (its `bm25Rank` is at or below
 * `bm25BypassRank`). The adjustment is additive on the post-fusion
 * score so it composes with `typeBoost` / `relevanceBoost` (which are
 * multiplicative) without surprising interactions.
 *
 * Re-sorting is handled by the surrounding stage execution.
 */
function applySourcePriors(
  results: SearchResultItem[],
  sourcePriors: ResolvedSourcePriorsConfig,
): void {
  const { weights, bm25BypassRank } = sourcePriors;
  const prefixes = Object.keys(weights);
  if (prefixes.length === 0) return;

  for (const result of results) {
    const prior = lookupSourcePrior(result, weights, prefixes);
    const bypassed =
      bm25BypassRank > 0 &&
      result.scoreBreakdown?.bm25Rank !== undefined &&
      result.scoreBreakdown.bm25Rank <= bm25BypassRank;

    const applied = bypassed ? 0 : prior;
    if (applied !== 0) {
      result.score += applied;
    }

    if (result.scoreBreakdown) {
      // Always surface `sourcePrior` when the feature is on so eval
      // tooling can distinguish "no prefix matched" (`0`), "matched
      // but bypassed by strong BM25" (`0` + visible bm25Rank), and
      // "matched and applied" (non-zero) without inspecting config.
      result.scoreBreakdown.sourcePrior = applied;
      result.scoreBreakdown.finalScore = result.score;
    }
  }
}

function lookupSourcePrior(
  result: SearchResultItem,
  weights: Record<string, number>,
  prefixes: readonly string[],
): number {
  const sourceId = result.sourceId;
  if (!sourceId) return 0;
  // Longest-prefix-match: a more specific key wins over a less specific one
  // regardless of object key order. This makes precedence deterministic when
  // both a bare source-type key (`gmail`, e.g. a source-advertised default)
  // and a full source-id key (`gmail:acct`, e.g. an auto inverse-frequency
  // prior) match the same result.
  let best: number | undefined;
  let bestLen = -1;
  for (const prefix of prefixes) {
    if (prefix.length > bestLen && sourceId.startsWith(prefix)) {
      best = weights[prefix];
      bestLen = prefix.length;
    }
  }
  return best ?? 0;
}
