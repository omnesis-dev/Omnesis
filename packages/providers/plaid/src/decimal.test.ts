// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { DECIMAL_STRING_RE, MONEY_SCALE, decimalFromNumberOrNull } from "./decimal.js";

describe("decimalFromNumberOrNull", () => {
  test("renders a number at the default 2-scale carrier", () => {
    expect(decimalFromNumberOrNull(12.34)).toBe("12.34");
    expect(decimalFromNumberOrNull(5)).toBe("5.00");
    expect(decimalFromNumberOrNull(0)).toBe("0.00");
    expect(MONEY_SCALE).toBe(2);
  });

  test("pads/rounds to the requested scale without a fresh float artifact", () => {
    // Plaid serves at most 2 fractional digits; these confirm canonical output.
    expect(decimalFromNumberOrNull(99.5)).toBe("99.50");
    expect(decimalFromNumberOrNull(-42.1)).toBe("-42.10");
    // A value with more precision than the scale rounds at the string level.
    expect(decimalFromNumberOrNull(1.005, 2)).toMatch(DECIMAL_STRING_RE);
  });

  test("never emits negative zero", () => {
    expect(decimalFromNumberOrNull(-0)).toBe("0.00");
    expect(decimalFromNumberOrNull(-0.001, 2)).toBe("0.00");
  });

  test("a sum over rendered carriers does not drift cents", () => {
    // The frozen exact-money oracle, at the carrier level: summing the string
    // carriers (as the gateway's DECIMAL column does) is exact where summing the
    // raw JS floats would drift. 0.1 + 0.2 famously != 0.3 in IEEE-754.
    const carriers = [0.1, 0.2, 0.3].map((n) => decimalFromNumberOrNull(n));
    expect(carriers).toEqual(["0.10", "0.20", "0.30"]);
    const cents = carriers.reduce((acc, c) => acc + Math.round(Number(c) * 100), 0);
    expect(cents).toBe(60); // 0.60 exactly, no 0.6000000000000001
  });

  test("null/undefined/non-finite map to null", () => {
    expect(decimalFromNumberOrNull(null)).toBeNull();
    expect(decimalFromNumberOrNull(undefined)).toBeNull();
    expect(decimalFromNumberOrNull(Number.NaN)).toBeNull();
    expect(decimalFromNumberOrNull(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("rejects an out-of-range scale", () => {
    expect(() => decimalFromNumberOrNull(1, 19)).toThrow(/scale/);
    expect(() => decimalFromNumberOrNull(1, -1)).toThrow(/scale/);
  });
});
