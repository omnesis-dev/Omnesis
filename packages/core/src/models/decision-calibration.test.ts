// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  CALIBRATION_RECALL,
  MIN_CALIBRATION_SAMPLES,
  calibrateDecisionScore,
  calibrateNormalized,
  decisionGateRates,
  fitDecisionCalibration,
} from "./decision-calibration.js";

/** The worth gate's threshold on the 0–1 scale of a four-level question. */
const CUT = 1.08 / 3;

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
 * like Jev with some noise but rates every item higher (square root of Jev's
 * 0–1 score, plus noise) — a model that lets junk through at Jev's threshold.
 */
function optimistic(n: number): { jev: number[]; candidate: number[] } {
  const r = rng(7);
  const jev = Array.from({ length: n }, () => r() ** 0.7);
  const candidate = jev.map((v) => Math.min(1, Math.max(0, Math.sqrt(v) + (r() - 0.5) * 0.2)));
  return { jev, candidate };
}

describe("fitDecisionCalibration", () => {
  it("anchors the score that keeps 95% of what Jev keeps on Jev's threshold", () => {
    const { jev, candidate } = optimistic(300);
    const points = fitDecisionCalibration(candidate, jev, CUT);
    expect(points).toHaveLength(1);
    const [[x, y]] = points as [[number, number]];
    expect(y).toBeCloseTo(CUT, 4);
    expect(x).toBeGreaterThan(CUT);
    const calibrated = candidate.map((v) => calibrateNormalized(points, v));
    const rates = decisionGateRates(calibrated, jev, CUT);
    expect(rates.keeps).toBeGreaterThanOrEqual(CALIBRATION_RECALL - 0.01);
  });

  it("skips far more of what Jev skips than the raw scores, while keeping what Jev keeps", () => {
    const { jev, candidate } = optimistic(300);
    const before = decisionGateRates(candidate, jev, CUT);
    const points = fitDecisionCalibration(candidate, jev, CUT);
    const after = decisionGateRates(
      candidate.map((v) => calibrateNormalized(points, v)),
      jev,
      CUT,
    );
    expect(before.keeps).toBeGreaterThan(0.99);
    expect(before.skips).toBeLessThan(0.5);
    expect(after.keeps).toBeGreaterThan(0.93);
    expect(after.skips).toBeGreaterThan(before.skips + 0.3);
    expect(after.agreement).toBeGreaterThan(before.agreement);
  });

  it("barely moves a model already on Jev's scale", () => {
    const r = rng(3);
    const jev = Array.from({ length: 200 }, () => r());
    const points = fitDecisionCalibration(jev, jev, CUT);
    const kept = jev.filter((v) => v >= CUT).sort((a, b) => a - b);
    expect(points[0]![0]).toBeCloseTo(kept[Math.floor(0.05 * (kept.length - 1))]!, 1);
  });

  it("refuses too few samples, too few items Jev keeps, or a model that scores everything alike", () => {
    expect(() => fitDecisionCalibration([0.1, 0.2], [0.1, 0.2], CUT)).toThrow(
      `at least ${MIN_CALIBRATION_SAMPLES}`,
    );
    const flat = Array.from({ length: 100 }, () => 0.5);
    expect(() => fitDecisionCalibration(flat, optimistic(100).jev, CUT)).toThrow(
      /nothing to calibrate/,
    );
    const r = rng(5);
    const lowJev = Array.from({ length: 100 }, () => r() * 0.3);
    const spread = Array.from({ length: 100 }, () => r());
    expect(() => fitDecisionCalibration(spread, lowJev, CUT)).toThrow(/reference items Jev passes/);
    expect(() => fitDecisionCalibration([0.1], [0.1, 0.2], CUT)).toThrow(/one candidate score/);
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

describe("decisionGateRates", () => {
  it("reports agreement, the share of passes kept and of skips skipped", () => {
    const reference = [0.9, 0.8, 0.7, 0.1, 0.2];
    const model = [0.9, 0.1, 0.7, 0.9, 0.2];
    expect(decisionGateRates(model, reference, 0.5)).toEqual({
      agreement: 3 / 5,
      keeps: 2 / 3,
      skips: 1 / 2,
    });
  });
});
