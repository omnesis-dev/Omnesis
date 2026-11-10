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
 * The map is fitted by quantile matching on a shared reference set: the
 * candidate and Jev answer the same questions, and the candidate's k-th
 * quantile is mapped to Jev's k-th quantile. The map is monotone, so it never
 * changes which of two items a model ranks higher; it only moves where a
 * fixed threshold cuts. It works on scores normalised to 0–1 (level ÷ last
 * level), so one calibration serves questions with any number of levels.
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
}

/** Fewer paired answers than this give a map too noisy to trust. */
export const MIN_CALIBRATION_SAMPLES = 40;
const KNOTS = 11;

function quantile(sorted: readonly number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * Fit the knots that map `candidate` scores onto `reference` scores, both
 * already normalised to 0–1 and answering the same items. Throws when there
 * are too few samples, or when the candidate gives nearly every item the same
 * score (nothing to rank, so nothing to map).
 */
export function fitDecisionCalibration(
  candidate: readonly number[],
  reference: readonly number[],
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
  const ys = reference.map(clamp01).sort((a, b) => a - b);
  if (quantile(xs, 0.9) - quantile(xs, 0.1) < 0.02) {
    throw new Error("The model scored almost every item the same; there is nothing to calibrate");
  }
  const points: Array<[number, number]> = [];
  // The y of the first knot of a pile of equal x: a model that scores many
  // items alike. The pile's knot takes the midpoint of the ys it spans, so a
  // threshold cuts the pile where Jev's distribution would.
  let pileStartY = 0;
  for (let k = 0; k < KNOTS; k += 1) {
    const q = k / (KNOTS - 1);
    const x = round4(quantile(xs, q));
    const y = round4(quantile(ys, q));
    const last = points[points.length - 1];
    if (last && x <= last[0]) {
      last[1] = round4((pileStartY + y) / 2);
      continue;
    }
    pileStartY = y;
    points.push([x, Math.max(y, last?.[1] ?? 0)]);
  }
  return points;
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

/**
 * Share of items where two score lists agree on pass (≥ threshold) or skip.
 * Used to report how close a calibrated model comes to Jev at a gate.
 */
export function decisionPassAgreement(
  a: readonly number[],
  b: readonly number[],
  threshold: number,
): number {
  if (!a.length || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i]! >= threshold === b[i]! >= threshold) same += 1;
  return same / a.length;
}
