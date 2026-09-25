// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-render coverage for `omnesis brain calibration` — the table is
 * data-driven over whatever families/classes the gateway reports, empty
 * families say so instead of rendering a zero table, and the arg surface
 * parses. All fixture data is invented.
 */

import { describe, expect, test } from "vitest";
import { renderCalibrationReport, type CalibrationFamilyDto } from "./briefs.js";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function familyFixture(over: Partial<CalibrationFamilyDto> = {}): CalibrationFamilyDto {
  return {
    family: "brief",
    total: 6,
    labeled: 4,
    correct: 2,
    incorrect: 2,
    classCounts: { dismissed_wrong: 1, kept_read: 2, operator_flagged: 1, unlabeled: 2 },
    bins: [
      { lo: 0, hi: 0.1, n: 0, meanConfidence: null, empiricalCorrectness: null, gap: null },
      { lo: 0.8, hi: 0.9, n: 3, meanConfidence: 0.85, empiricalCorrectness: 0.667, gap: -0.183 },
      { lo: 0.9, hi: 1, n: 1, meanConfidence: 0.95, empiricalCorrectness: 0, gap: -0.95 },
    ],
    ece: 0.374,
    ...over,
  };
}

describe("renderCalibrationReport", () => {
  test("renders the family header, class counts, and only the occupied bins", () => {
    const text = renderCalibrationReport([familyFixture()]).map(stripAnsi).join("\n");
    expect(text).toContain("brief — 4 labeled of 6 (2 correct, 2 incorrect) · ECE 0.37");
    // Class counts render biggest-first, whatever the classes are.
    expect(text).toContain("kept_read 2 · unlabeled 2 · dismissed_wrong 1 · operator_flagged 1");
    // The empty 0.0-0.1 bin is omitted; the occupied ones show their stats.
    expect(text).not.toContain("0.0-0.1");
    expect(text).toContain("0.8-0.9");
    expect(text).toMatch(/0\.9-1\.0\s+1\s+0\.95\s+0\.00\s+-0\.95/);
  });

  test("a family with no labeled rows reports honestly instead of a zero table", () => {
    const text = renderCalibrationReport([
      familyFixture({
        family: "person-annotation",
        total: 0,
        labeled: 0,
        correct: 0,
        incorrect: 0,
        classCounts: {},
        bins: [],
        ece: null,
      }),
    ])
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("person-annotation — 0 labeled of 0 (0 correct, 0 incorrect) · ECE -");
    expect(text).toContain("no labeled data yet");
    expect(text).not.toContain("CONF");
  });

  test("renders every family the gateway sends — no hardcoded family list", () => {
    const text = renderCalibrationReport([
      familyFixture({ family: "brief" }),
      familyFixture({ family: "open-loop" }),
    ])
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("brief —");
    expect(text).toContain("open-loop —");
  });
});

describe("calibration command args", () => {
  test("the calibration subcommand is registered with family + since-days flags", async () => {
    const { brainCommand } = await import("./briefs.js");
    const sub = (brainCommand.subCommands as Record<string, unknown>).calibration as {
      args?: Record<string, unknown>;
      meta?: { name?: string };
    };
    expect(sub).toBeDefined();
    const args = sub.args ?? {};
    expect(Object.keys(args)).toEqual(expect.arrayContaining(["family", "since-days"]));
  });
});
