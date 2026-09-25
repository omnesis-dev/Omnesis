// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { parseCountries, validatePlaidCursor } from "./types.js";

describe("validatePlaidCursor", () => {
  test("accepts a cursor the sync wrote", () => {
    const cursor = {
      phase: "transactions",
      transactionsCursor: "c1",
      loopStartCursor: "c0",
      lastSnapshotDate: "2026-05-15",
      paginationRestarts: 2,
    };
    expect(validatePlaidCursor(cursor)).toEqual(cursor);
  });

  test("re-bootstraps rather than trusting a cursor it cannot use", () => {
    // Each of these would otherwise reach Plaid or a date comparison as the
    // wrong type: a non-string cursor is rejected on every call with nothing
    // to clear it, and a non-string date never equals today so the snapshot
    // would re-run every tick. Returning null re-bootstraps, which recovers.
    for (const bad of [
      null,
      "a string",
      {},
      { phase: "nonsense" },
      { phase: "transactions", transactionsCursor: 12345 },
      { phase: "transactions", loopStartCursor: {} },
      { phase: "incremental", lastSnapshotDate: {} },
      { phase: "transactions", backfillWaitSince: 0 },
      { phase: "transactions", paginationRestarts: "many" },
    ]) {
      expect(validatePlaidCursor(bad)).toBeNull();
    }
  });
});

describe("parseCountries", () => {
  test("normalises the operator's list", () => {
    expect(parseCountries(" gb , us ")).toEqual(["GB", "US"]);
  });

  test("falls back to the default markets when nothing usable is given", () => {
    for (const raw of [undefined, "", "   ", ",,", "not-a-code"]) {
      expect(parseCountries(raw)).toEqual(["US", "CA"]);
    }
  });

  test("drops anything that is not a two-letter code", () => {
    expect(parseCountries("us, usa, g, ca")).toEqual(["US", "CA"]);
  });
});
