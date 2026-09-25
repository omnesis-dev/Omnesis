// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { computeIndexingProgress } from "./indexing-progress.js";

describe("computeIndexingProgress", () => {
  test("all indexed, none errored → 100% / 0 remaining", () => {
    expect(computeIndexingProgress(100, 0, 100)).toEqual({ percent: 100, remaining: 0 });
  });

  test("errored docs count toward completion so the bar reaches 100%", () => {
    // The whole point: a source fully attempted — some indexed, some terminally
    // errored — is DONE, not stuck at 99%. (Mirrors the live google-drive row:
    // 1046 indexed + 6 errored = 1052 total.)
    expect(computeIndexingProgress(1046, 6, 1052)).toEqual({ percent: 100, remaining: 0 });
    expect(computeIndexingProgress(82, 1, 83)).toEqual({ percent: 100, remaining: 0 });
  });

  test("without the errored docs it would still read 99% — proving errors are the gap", () => {
    // Same corpus, errors NOT counted: the pre-fix behaviour.
    expect(computeIndexingProgress(1046, 0, 1052).percent).toBe(99);
  });

  test("partial progress reflects indexed + errored over total", () => {
    expect(computeIndexingProgress(40, 10, 100)).toEqual({ percent: 50, remaining: 50 });
  });

  test("clamps to 100 / 0 if indexed + errored somehow exceeds total", () => {
    // Defensive: a doc counted in both indexed_documents and indexing_errors
    // must never push the bar past 100 or the remaining below 0.
    expect(computeIndexingProgress(100, 5, 100)).toEqual({ percent: 100, remaining: 0 });
  });

  test("empty corpus → 0% / 0 remaining (no division by zero)", () => {
    expect(computeIndexingProgress(0, 0, 0)).toEqual({ percent: 0, remaining: 0 });
    expect(computeIndexingProgress(0, 0, -1)).toEqual({ percent: 0, remaining: 0 });
  });

  test("rounds to the nearest whole percent", () => {
    // 1 of 3 done → 33.33% → 33.
    expect(computeIndexingProgress(1, 0, 3).percent).toBe(33);
    // 2 of 3 → 66.67% → 67.
    expect(computeIndexingProgress(2, 0, 3).percent).toBe(67);
  });
});
