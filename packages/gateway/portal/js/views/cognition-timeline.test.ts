// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The history timeline's arithmetic. Plain function calls in the node env —
 * the rendered shape is covered by the render suite.
 *
 * All fixture data is invented; none comes from any real corpus.
 */

import { describe, expect, test } from "vitest";
// @ts-expect-error plain-JS portal module without type declarations
import * as tl from "./cognition-timeline.js";

const M = (month: string, o: Record<string, number> = {}) => ({
  month,
  reviewed: 0,
  failed: 0,
  owed: 0,
  discarded: 0,
  unscanned: 0,
  ...o,
});

describe("monthTotal", () => {
  test("measures the lane's own population, not the whole corpus", () => {
    // What is drawn. `discarded` is excluded deliberately: on a real corpus it
    // is the great majority of every month, and stacking it flattens the bands
    // that carry the answer into a one-pixel line — the chart then reports the
    // size of the library rather than how far the Brain has read it.
    expect(
      tl.monthTotal(M("2026-01", { reviewed: 1, failed: 2, owed: 3, discarded: 4, unscanned: 5 })),
    ).toBe(11);
  });

  test("the corpus total still counts everything, for the tooltip", () => {
    expect(
      tl.monthCorpusTotal(
        M("2026-01", { reviewed: 1, failed: 2, owed: 3, discarded: 4, unscanned: 5 }),
      ),
    ).toBe(15);
  });

  test("survives a month missing keys entirely", () => {
    expect(tl.monthTotal({ month: "2026-01" })).toBe(0);
    expect(tl.monthTotal(null)).toBe(0);
  });
});

describe("frontierMonth", () => {
  test("is the oldest month in an unbroken swept run back from now", () => {
    const months = [
      M("2024-01", { owed: 5 }),
      M("2024-02", { reviewed: 3, owed: 2 }),
      M("2024-03", { reviewed: 9 }),
      M("2024-04", { reviewed: 4 }),
    ];
    // 2024-02 still holds unread candidates, so the run starts after it.
    expect(tl.frontierMonth(months)).toBe("2024-03");
  });

  test("a single stray old document does not claim fifty years of progress", () => {
    // The defect this exists for, seen on a live corpus: one document carrying
    // a 1976 timestamp — an epoch default, a mis-parsed header — had been
    // reviewed, and the panel announced the Brain had read back to 1976 while
    // everything between was untouched.
    const months = [
      M("1976-04", { reviewed: 1 }),
      M("2019-01", { owed: 40 }),
      M("2024-01", { owed: 30 }),
      M("2026-07", { reviewed: 12 }),
      M("2026-08", { reviewed: 8 }),
    ];
    expect(tl.frontierMonth(months)).toBe("2026-07");
  });

  test("steps over months that had nothing to read", () => {
    // A quiet month says nothing about how far the sweep has got, so it must
    // neither end the run nor be reported as its edge.
    const months = [
      M("2024-01", { owed: 2 }),
      M("2024-02", { reviewed: 5 }),
      M("2024-03", { discarded: 900 }),
      M("2024-04", { reviewed: 7 }),
    ];
    expect(tl.frontierMonth(months)).toBe("2024-02");
  });

  test("is null before anything has been read", () => {
    expect(tl.frontierMonth([M("2024-01", { owed: 5 })])).toBeNull();
    expect(tl.frontierMonth([])).toBeNull();
    expect(tl.frontierMonth(null)).toBeNull();
  });

  test("a month that was only given up on is not progress", () => {
    // Reading and abandoning are different outcomes; a frontier drawn from
    // failures would claim ground the lane never actually covered.
    expect(tl.frontierMonth([M("2024-01", { failed: 4 }), M("2024-02", { reviewed: 1 })])).toBe(
      "2024-02",
    );
  });

  test("unscanned months end the run — they may yet hold work", () => {
    // Reporting a frontier past a month whose documents have no verdict would
    // claim ground that might still turn out to be unread.
    const months = [M("2026-06", { reviewed: 4 }), M("2026-07", { unscanned: 50 })];
    expect(tl.frontierMonth(months)).toBeNull();
  });
});

describe("timelineTotals", () => {
  test("sums each band across every month", () => {
    const totals = tl.timelineTotals([
      M("2024-01", { reviewed: 1, owed: 2, unscanned: 3 }),
      M("2024-02", { reviewed: 4, discarded: 5, failed: 6 }),
    ]);
    expect(totals).toMatchObject({
      reviewed: 5,
      owed: 2,
      unscanned: 3,
      discarded: 5,
      failed: 6,
      total: 21,
    });
  });

  test("is zero-safe on an empty corpus", () => {
    expect(tl.timelineTotals([]).total).toBe(0);
    expect(tl.timelineTotals(null).total).toBe(0);
  });
});
