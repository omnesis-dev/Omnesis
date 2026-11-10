// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  MIN_CALIBRATION_SAMPLES,
  calibrateDecisionScore,
  calibrateNormalized,
  decisionPassAgreement,
  fitDecisionCalibration,
} from "./decision-calibration.js";

/** Knots sorted by x with non-decreasing y, inside 0–1. */
function isMonotone(points: ReadonlyArray<readonly [number, number]>): boolean {
  return points.every(
    ([x, y], i) =>
      x >= 0 &&
      x <= 1 &&
      y >= 0 &&
      y <= 1 &&
      (i === 0 || (x > points[i - 1]![0] && y >= points[i - 1]![1])),
  );
}

/** A seeded generator, so the synthetic score sets are the same on every run. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/**
 * Paired scores for one set of items: Jev's, and a candidate that ranks them
 * the same way but runs high (its scores are Jev's square root — every item
 * looks more worth recording).
 */
function pairedScores(n: number): { jev: number[]; candidate: number[] } {
  const r = rng(7);
  const jev = Array.from({ length: n }, () => r());
  return { jev, candidate: jev.map((v) => Math.sqrt(v)) };
}

describe("fitDecisionCalibration", () => {
  it("maps a candidate's distribution onto the reference's", () => {
    const { jev, candidate } = pairedScores(300);
    const points = fitDecisionCalibration(candidate, jev);
    expect(isMonotone(points)).toBe(true);
    for (const v of [0.1, 0.3, 0.5, 0.8]) {
      expect(calibrateNormalized(points, Math.sqrt(v))).toBeCloseTo(v, 1);
    }
  });

  it("makes a fixed threshold pass the same share of items as the reference", () => {
    const { jev, candidate } = pairedScores(300);
    const cut = 1.08 / 3;
    const before = decisionPassAgreement(candidate, jev, cut);
    const points = fitDecisionCalibration(candidate, jev);
    const calibrated = candidate.map((x) => calibrateNormalized(points, x));
    const after = decisionPassAgreement(calibrated, jev, cut);
    expect(before).toBeLessThan(0.9);
    expect(after).toBeGreaterThan(0.97);
  });

  it("collapses a pile of equal scores into one knot and stays monotone", () => {
    const jev = Array.from({ length: 100 }, (_, i) => i / 100);
    const candidate = jev.map((v) => (v < 0.6 ? 0.2 : v));
    const points = fitDecisionCalibration(candidate, jev);
    expect(isMonotone(points)).toBe(true);
    expect(points.filter(([x]) => x === 0.2)).toHaveLength(1);
  });

  it("puts a pile's knot at the midpoint of the reference values it spans", () => {
    // 100 items: the candidate scores the lowest 50 all at 0.2; Jev spreads
    // them evenly over 0–0.49. The knots at q = 0 … 0.4 all land on x = 0.2
    // (at q = 0.5 the candidate's quantile is already between 0.2 and 0.5),
    // spanning Jev's 0 … 0.396, so the pile's knot is their midpoint.
    const jev = Array.from({ length: 100 }, (_, i) => i / 100);
    const candidate = jev.map((v) => (v < 0.5 ? 0.2 : v));
    const points = fitDecisionCalibration(candidate, jev);
    const pile = points.find(([x]) => x === 0.2)!;
    expect(pile[1]).toBeCloseTo((0 + 0.396) / 2, 3);
  });

  it("refuses too few samples or a model that scores everything alike", () => {
    expect(() => fitDecisionCalibration([0.1, 0.2], [0.1, 0.2])).toThrow(
      `at least ${MIN_CALIBRATION_SAMPLES}`,
    );
    const flat = Array.from({ length: 100 }, () => 0.5);
    expect(() => fitDecisionCalibration(flat, pairedScores(100).jev)).toThrow(
      /nothing to calibrate/,
    );
    expect(() => fitDecisionCalibration([0.1], [0.1, 0.2])).toThrow(/one candidate score/);
  });
});

describe("calibrateNormalized", () => {
  const points: Array<[number, number]> = [
    [0.2, 0.1],
    [0.6, 0.3],
  ];

  it("interpolates between knots and runs through (0,0) and (1,1) beyond them", () => {
    expect(calibrateNormalized(points, 0)).toBe(0);
    expect(calibrateNormalized(points, 0.1)).toBeCloseTo(0.05);
    expect(calibrateNormalized(points, 0.4)).toBeCloseTo(0.2);
    expect(calibrateNormalized(points, 0.8)).toBeCloseTo(0.65);
    expect(calibrateNormalized(points, 1)).toBe(1);
  });

  it("clamps out-of-range input", () => {
    expect(calibrateNormalized(points, -3)).toBe(0);
    expect(calibrateNormalized(points, 4)).toBe(1);
  });
});

describe("calibrateDecisionScore", () => {
  it("works in levels, so one map serves any level count", () => {
    const cal = { points: [[0.5, 0.25]] as Array<[number, number]> };
    expect(calibrateDecisionScore(cal, 1.5, 4)).toBeCloseTo(0.75);
    expect(calibrateDecisionScore(cal, 1, 3)).toBeCloseTo(0.5);
    expect(calibrateDecisionScore(cal, 3, 4)).toBe(3);
  });
});
