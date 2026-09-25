// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a watch's recall arm would have nominated, against documents that
 * already exist.
 *
 * A watch starts at the journal head and watches the future, so the first
 * evidence that its threshold is right arrives with the first matching
 * document — and if the threshold is a little too high, that evidence never
 * arrives at all. The watch is simply silent, which is indistinguishable from
 * a quiet month. Every other number about it looks fine.
 *
 * So this asks the question backwards: over documents the install already
 * holds, how many would this arm have put in front of the judge, and by how
 * much did the rest miss? A watch that would have nominated nothing over a
 * quarter has a threshold problem now, before the month it was supposed to
 * cover goes past in silence.
 *
 * **Nothing here reads a document's content out.** The result is counts and
 * scores. A probe that returned the matching documents would be a search
 * endpoint wearing a diagnostic's clothes, and the answer to "is this
 * threshold right" does not need one.
 */

export interface ProbeSummary {
  /** Documents the structural filter admitted and the arm scored. */
  readonly considered: number;
  /** Of those, how many cleared the installed threshold. */
  readonly nominated: number;
  readonly threshold: number;
  /** The score distribution, so a near miss is distinguishable from a rout. */
  readonly best: number;
  readonly p95: number;
  readonly median: number;
  /**
   * How far the threshold would have to move to nominate anything at all.
   * Zero when something already clears it; null when nothing was scored.
   */
  readonly shortfall: number | null;
  /**
   * The best score that did **not** clear the threshold — how close the next
   * document down came. A threshold set to this value would admit that
   * document too, since the comparison is inclusive. Null when nothing was
   * scored, or when everything cleared.
   */
  readonly nextThreshold: number | null;
}

/**
 * Summarise scores against a threshold.
 *
 * Separated from the scoring so it is testable without an embedder, an index,
 * or a corpus — the arithmetic here is what decides whether an operator is
 * told their watch is fine, and it is the part that can be wrong quietly.
 */
export function summariseProbe(scores: readonly number[], threshold: number): ProbeSummary {
  const sorted = [...scores].sort((a, b) => a - b);
  const considered = sorted.length;
  if (considered === 0) {
    return {
      considered: 0,
      nominated: 0,
      threshold,
      best: 0,
      p95: 0,
      median: 0,
      shortfall: null,
      nextThreshold: null,
    };
  }
  const at = (fraction: number): number =>
    sorted[Math.min(considered - 1, Math.floor(fraction * considered))]!;
  const best = sorted[considered - 1]!;
  const nominated = sorted.filter((score) => score >= threshold).length;
  const misses = sorted.filter((score) => score < threshold);
  return {
    considered,
    nominated,
    threshold,
    best,
    p95: at(0.95),
    median: at(0.5),
    // A watch that nominated nothing is the case this exists for, and the
    // number an operator needs is not "the best score" but "how much lower
    // would the threshold have to be" — the same quantity, said as an action.
    shortfall: nominated > 0 ? 0 : round(threshold - best),
    nextThreshold: misses.length > 0 ? round(misses[misses.length - 1]!) : null,
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
