// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Automatic per-source ranking priors derived from the live corpus source
 * distribution — the source-level analogue of IDF ("inverse source
 * frequency").
 *
 * The problem this solves is volume dominance: when one source holds the vast
 * majority of documents, it floods both the BM25 and vector candidate lists
 * and crowds genuinely-relevant documents from rarer sources out of the top-k.
 * A hand-written per-source weight table (e.g. "gmail: -0.025") would fix this
 * for one specific corpus while overfitting to it — it bakes in a source name
 * and a constant tuned to one user's mix.
 *
 * Instead, this derives a prior for every source purely from its document
 * frequency, names no source, and scales the result to the fusion score so it
 * adapts to whatever distribution a corpus actually has. The most common
 * source gets no adjustment; rarer sources get an additive boost proportional
 * to their rarity, capped at roughly one RRF rank's worth of score so a rare
 * source can climb a position or two past a borderline common-source result
 * without ever dominating. The boost stage's `bm25BypassRank` still exempts
 * genuine top keyword hits, so the dominant source keeps its explicit matches.
 */

export interface SourceDocCount {
  sourceId: string;
  docCount: number;
}

export interface IsfPriorOptions {
  /**
   * Dimensionless multiplier on the derived strength. 1 = the principled
   * default (rarest source boosted by ~one RRF rank-1 score). Higher spreads
   * sources more aggressively; lower is gentler. This is the single exposed
   * knob — there is no per-source tuning.
   */
  strength?: number;
  /**
   * The RRF constant `k` from the fusion config. The strength is derived from
   * the fusion score scale (a rank-1 single-list RRF score ≈ `1/(k+1)`), so
   * the prior auto-scales if fusion is retuned rather than being a magic
   * constant of its own.
   */
  rrfK: number;
}

/** Neutral multiplier used when no automatic source-prior strength is configured. */
export const DEFAULT_AUTO_ISF_STRENGTH = 1;

/**
 * Compute additive per-source priors (in RRF-score units), keyed by full
 * `sourceId`. The boost stage looks weights up by `startsWith`, and full
 * source ids are mutually non-prefixing in practice, so each result matches
 * exactly its own source's prior.
 *
 * Returns `{}` (feature inert) when there is nothing to diversify: fewer than
 * two sources, no documents, or every source equally common.
 */
export function computeIsfPriors(
  counts: readonly SourceDocCount[],
  opts: IsfPriorOptions,
): Record<string, number> {
  const total = counts.reduce((sum, c) => sum + Math.max(0, c.docCount), 0);
  if (total <= 0 || counts.length < 2) return {};

  // Inverse source frequency: a rarer source has a larger value. `log(total /
  // docCount)` is the source-level idf; clamp docCount to >= 1 so a transient
  // zero-count row can't produce a non-finite value.
  const isf = (c: SourceDocCount): number => Math.log(total / Math.max(1, c.docCount));

  const values = counts.map(isf);
  const minIsf = Math.min(...values); // the most common source
  const maxIsf = Math.max(...values); // the rarest source
  const span = maxIsf - minIsf;
  if (span < 1e-9) return {}; // all sources equally common — no signal

  // Derived score scale: a rank-1 single-list RRF score ≈ 1/(k+1). The rarest
  // source is boosted by at most `strength` of that; everything in between
  // scales linearly with its normalized rarity.
  const strength = opts.strength ?? DEFAULT_AUTO_ISF_STRENGTH;
  const maxBoost = strength * (1 / (opts.rrfK + 1));

  const priors: Record<string, number> = {};
  for (const c of counts) {
    const rarity = (isf(c) - minIsf) / span; // 0 = most common, 1 = rarest
    const prior = rarity * maxBoost;
    if (prior > 0) priors[c.sourceId] = prior;
  }
  return priors;
}
