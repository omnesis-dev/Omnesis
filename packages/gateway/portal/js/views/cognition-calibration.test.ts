// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-logic coverage for the Calibration panel: family display names stay
 * data-driven (unknown families render as themselves), bin/gap/ECE
 * formatting, class-count summarization, and the module import health.
 * Plain function calls in the node env — same harness as cognition.test.ts.
 */

import { describe, expect, test } from "vitest";
// @ts-expect-error plain-JS portal module without type declarations
import * as calibration from "./cognition-calibration.js";

describe("familyDisplayName", () => {
  test("labels the known families and passes unknown ones through (data-driven)", () => {
    expect(calibration.familyDisplayName("brief")).toBe("Briefs");
    expect(calibration.familyDisplayName("doc-annotation")).toBe("Doc annotations");
    expect(calibration.familyDisplayName("person-annotation")).toBe("Person annotations");
    // A family the gateway grows later must still render, not vanish.
    expect(calibration.familyDisplayName("open-loop")).toBe("open-loop");
  });
});

describe("bin formatting", () => {
  test("formatBinRange renders the confidence span", () => {
    expect(calibration.formatBinRange({ lo: 0.6, hi: 0.7 })).toBe("0.6–0.7");
  });

  test("fmt2 and formatGap render numbers and em-dash nulls", () => {
    expect(calibration.fmt2(0.875)).toBe("0.88");
    expect(calibration.fmt2(null)).toBe("—");
    expect(calibration.formatGap(0.121)).toBe("+0.12");
    expect(calibration.formatGap(-0.3)).toBe("-0.30");
    expect(calibration.formatGap(null)).toBe("—");
  });

  test("occupiedBins keeps only bins with labeled artifacts", () => {
    const family = {
      bins: [
        { lo: 0, hi: 0.1, n: 0 },
        { lo: 0.1, hi: 0.2, n: 3 },
        { lo: 0.9, hi: 1, n: 1 },
      ],
    };
    expect(calibration.occupiedBins(family).map((b: { n: number }) => b.n)).toEqual([3, 1]);
    // A family with no labeled rows yields an empty table, never a crash.
    expect(calibration.occupiedBins({ bins: [] })).toEqual([]);
    expect(calibration.occupiedBins(undefined)).toEqual([]);
  });
});

describe("formatClassCounts", () => {
  test("renders biggest-first, and an empty string for no classes", () => {
    expect(
      calibration.formatClassCounts({ verified: 2, superseded: 5, unlabeled: 1 }),
    ).toBe("superseded 5 · verified 2 · unlabeled 1");
    expect(calibration.formatClassCounts({})).toBe("");
    expect(calibration.formatClassCounts(undefined)).toBe("");
  });
});

describe("module health", () => {
  test("exports the CalibrationTab component", () => {
    expect(typeof calibration.CalibrationTab).toBe("function");
  });
});
