// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { attribution, maxWeightMatching, referenceForWindows } from "./metrics.js";

describe("maxWeightMatching", () => {
  test("finds the best one-to-one assignment on a rectangular matrix", () => {
    expect(
      maxWeightMatching([
        [1, 9],
        [8, 2],
        [5, 5],
      ]),
    ).toEqual([1, 0, -1]);
    expect(maxWeightMatching([[3, 1, 0]])).toEqual([0]);
  });
});

describe("referenceForWindows", () => {
  test("takes the speaker with most talk, and measures overlap and speech", () => {
    const turns = [
      { speaker: "a", startMs: 0, endMs: 3_000 },
      { speaker: "b", startMs: 2_000, endMs: 10_000 },
    ];
    expect(
      referenceForWindows(
        [
          { startMs: 0, endMs: 4_000 },
          { startMs: 11_000, endMs: 12_000 },
        ],
        turns,
      ),
    ).toEqual([
      { speaker: "a", overlapMs: 1_000, speechMs: 4_000 },
      { speaker: null, overlapMs: 0, speechMs: 0 },
    ]);
  });
});

describe("attribution", () => {
  const refs = ["a", "a", "b", "b"].map((speaker) => ({ speaker, overlapMs: 0, speechMs: 1 }));
  test("is zero for a perfect grouping under any label names", () => {
    expect(attribution([7, 7, 3, 3], [1, 1, 1, 1], refs).error).toBe(0);
  });
  test("counts an unmatched extra speaker as wrong, weighted by time", () => {
    expect(attribution([0, 0, 1, 2], [1, 1, 1, 3], refs).error).toBeCloseTo(1 / 6);
  });
  test("counts a merged speaker as wrong", () => {
    expect(attribution([0, 0, 0, 0], [1, 1, 1, 1], refs).error).toBe(0.5);
  });
});
