// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  computeRatePerSec,
  computeEtaSeconds,
  MIN_RATE_WINDOW_MS,
  type IndexRateSample,
} from "./indexer-rate.js";

describe("computeRatePerSec", () => {
  test("empty history -> null", () => {
    expect(computeRatePerSec([])).toBeNull();
  });

  test("single sample -> null", () => {
    expect(computeRatePerSec([{ ts: 1_000, totalIndexed: 100 }])).toBeNull();
  });

  test("two samples spanning less than the min window -> null", () => {
    const history: IndexRateSample[] = [
      { ts: 0, totalIndexed: 0 },
      { ts: MIN_RATE_WINDOW_MS - 1, totalIndexed: 500 },
    ];
    expect(computeRatePerSec(history)).toBeNull();
  });

  test("two samples over 10s with 100 docs -> 10 docs/sec", () => {
    const history: IndexRateSample[] = [
      { ts: 0, totalIndexed: 1_000 },
      { ts: 10_000, totalIndexed: 1_100 },
    ];
    expect(computeRatePerSec(history)).toBe(10);
  });

  test("uses oldest and newest across many samples (widest window)", () => {
    const history: IndexRateSample[] = [
      { ts: 0, totalIndexed: 0 },
      { ts: 2_000, totalIndexed: 10 },
      { ts: 5_000, totalIndexed: 40 },
      { ts: 8_000, totalIndexed: 80 },
    ];
    // (80 - 0) docs over (8000 - 0) ms = 80 / 8 = 10 docs/sec.
    expect(computeRatePerSec(history)).toBe(10);
  });

  test("non-positive progress over the window -> null (idle / went backwards)", () => {
    const flat: IndexRateSample[] = [
      { ts: 0, totalIndexed: 500 },
      { ts: 10_000, totalIndexed: 500 },
    ];
    expect(computeRatePerSec(flat)).toBeNull();
    const backwards: IndexRateSample[] = [
      { ts: 0, totalIndexed: 500 },
      { ts: 10_000, totalIndexed: 400 },
    ];
    expect(computeRatePerSec(backwards)).toBeNull();
  });
});

describe("computeEtaSeconds", () => {
  test("null rate -> null", () => {
    expect(computeEtaSeconds(1_000, null)).toBeNull();
  });

  test("non-positive rate -> null", () => {
    expect(computeEtaSeconds(1_000, 0)).toBeNull();
    expect(computeEtaSeconds(1_000, -5)).toBeNull();
  });

  test("remaining 0 -> null", () => {
    expect(computeEtaSeconds(0, 10)).toBeNull();
  });

  test("negative remaining -> null", () => {
    expect(computeEtaSeconds(-50, 10)).toBeNull();
  });

  test("500 remaining at 10 docs/sec -> 50 seconds", () => {
    expect(computeEtaSeconds(500, 10)).toBe(50);
  });

  test("rounds to the nearest whole second", () => {
    // 100 / 3 = 33.33… -> 33.
    expect(computeEtaSeconds(100, 3)).toBe(33);
    // 100 / 1.5 = 66.66… -> 67.
    expect(computeEtaSeconds(100, 1.5)).toBe(67);
  });
});
