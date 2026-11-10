// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Score calibration for decision models.
 *
 * Every threshold that reads a decision score (the worth gates at 1.08, the
 * Brain's record and task checks) was chosen on TypeSafe Jev's answers. Other
 * decision models rank content much like Jev does but spread their scores
 * differently: one puts most junk at 1.3, another most worthwhile mail at 0.9.
 * A calibration maps a model's scores onto Jev's scale so those thresholds
 * keep their meaning.
 *
 * The map is anchored on what the gates need from Jev: keeping the mail it
 * keeps. On a shared reference set — items Jev has scored — the fit finds the
 * model score above which the model keeps 95% of the items Jev passes at the
 * gate's threshold, and maps that score onto the threshold, linearly on each
 * side and through (0, 0) and (1, 1). A model that rates everything higher than
 * Jev is moved down, one that rates it lower is moved up, and either then skips
 * as much of the rest as its own ranking allows. The map is monotone, so it
 * never reverses which of two items a model ranks higher. It works on scores
 * normalised to 0–1 (level ÷ last level), so one calibration serves questions
 * with any number of levels.
 *
 * Matching the model's whole score distribution to Jev's (quantile mapping)
 * or regressing Jev's score on the model's were measured and rejected: with a
 * model whose ranking only partly agrees with Jev's they keep far less of
 * what Jev keeps, which is the one thing a worth gate must not do.
 */

export interface DecisionCalibration {
  /**
   * Knots of a piecewise-linear, non-decreasing map from the model's
   * normalised score to Jev's, sorted by x; both coordinates in 0–1. The map
   * runs through (0, 0) and (1, 1) beyond the outermost knots.
   */
  readonly points: ReadonlyArray<readonly [number, number]>;
  /** What the map was fitted against, e.g. `jev-worth/email-worth-v1/jev-1.13.0`. */
  readonly reference: string;
  /** ISO time of the fit. */
  readonly fittedAt: string;
  /** Requests both models answered. */
  readonly samples?: number;
  /** Share of reference items where the calibrated model and Jev agree on pass or skip at the reference threshold. */
  readonly agreement?: number;
  /** The same agreement before calibration, for comparison. */
  readonly agreementBefore?: number;
  /** Share of the items Jev passes that the calibrated model passes too. */
  readonly keeps?: number;
  readonly keepsBefore?: number;
  /** Share of the items Jev skips that the calibrated model skips too. */
  readonly skips?: number;
  readonly skipsBefore?: number;
}

/** Fewer paired answers than this give a map too noisy to trust. */
export const MIN_CALIBRATION_SAMPLES = 40;
/** Fewer reference items Jev passes than this leave the anchor unknown. */
const MIN_KEPT_SAMPLES = 20;
/** Share of what Jev keeps a calibrated model keeps at the anchored threshold. */
export const CALIBRATION_RECALL = 0.95;

function quantile(sorted: readonly number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * Fit the knot that maps `candidate` scores onto `reference` scores at
 * `threshold`, all normalised to 0–1, the scores answering the same items.
 * Throws when there are too few samples or too few items the reference
 * passes, or when the candidate gives nearly every item the same score
 * (nothing to rank, so nothing to anchor).
 */
export function fitDecisionCalibration(
  candidate: readonly number[],
  reference: readonly number[],
  threshold: number,
): Array<[number, number]> {
  if (candidate.length !== reference.length) {
    throw new Error("Calibration needs one candidate score per reference score");
  }
  if (candidate.length < MIN_CALIBRATION_SAMPLES) {
    throw new Error(
      `Calibration needs at least ${MIN_CALIBRATION_SAMPLES} answered items; got ${candidate.length}`,
    );
  }
  const xs = candidate.map(clamp01).sort((a, b) => a - b);
  if (quantile(xs, 0.9) - quantile(xs, 0.1) < 0.02) {
    throw new Error("The model scored almost every item the same; there is nothing to calibrate");
  }
  const kept = candidate
    .filter((_, i) => reference[i]! >= threshold)
    .map(clamp01)
    .sort((a, b) => a - b);
  if (kept.length < MIN_KEPT_SAMPLES) {
    throw new Error(
      `Calibration needs at least ${MIN_KEPT_SAMPLES} reference items Jev passes; got ${kept.length}`,
    );
  }
  const anchor = Math.min(0.999, Math.max(0.001, quantile(kept, 1 - CALIBRATION_RECALL)));
  return [[round4(anchor), round4(clamp01(threshold))]];
}

/** Map one normalised score through a calibration's knots. */
export function calibrateNormalized(
  points: ReadonlyArray<readonly [number, number]>,
  x: number,
): number {
  const v = clamp01(x);
  const knots: Array<readonly [number, number]> = [];
  if (!points.length || points[0]![0] > 0) knots.push([0, 0]);
  knots.push(...points);
  if (knots[knots.length - 1]![0] < 1) knots.push([1, 1]);
  for (let i = 1; i < knots.length; i += 1) {
    const [x0, y0] = knots[i - 1]!;
    const [x1, y1] = knots[i]!;
    if (v <= x1) {
      if (v === x1 || x1 === x0) return y1;
      return clamp01(y0 + ((y1 - y0) * (v - x0)) / (x1 - x0));
    }
  }
  return knots[knots.length - 1]![1];
}

/** Map a score on a question with `levels` levels (score 0 … levels-1). */
export function calibrateDecisionScore(
  calibration: Pick<DecisionCalibration, "points">,
  score: number,
  levels: number,
): number {
  const top = Math.max(1, levels - 1);
  return calibrateNormalized(calibration.points, score / top) * top;
}

/** How a model's pass or skip at a threshold compares with the reference's. */
export interface DecisionGateRates {
  /** Share of items where both pass or both skip. */
  agreement: number;
  /** Share of the items the reference passes that the model passes. */
  keeps: number;
  /** Share of the items the reference skips that the model skips. */
  skips: number;
}

/** Compare a model's scores with the reference's at a gate threshold. */
export function decisionGateRates(
  model: readonly number[],
  reference: readonly number[],
  threshold: number,
): DecisionGateRates {
  let same = 0;
  let passed = 0;
  let kept = 0;
  let skipped = 0;
  let alsoSkipped = 0;
  for (let i = 0; i < model.length; i += 1) {
    const m = model[i]! >= threshold;
    const r = reference[i]! >= threshold;
    if (m === r) same += 1;
    if (r) {
      passed += 1;
      if (m) kept += 1;
    } else {
      skipped += 1;
      if (!m) alsoSkipped += 1;
    }
  }
  return {
    agreement: model.length ? same / model.length : 0,
    keeps: passed ? kept / passed : 0,
    skips: skipped ? alsoSkipped / skipped : 0,
  };
}
