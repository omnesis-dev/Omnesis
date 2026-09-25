// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  DECIMAL_STRING_RE,
  decimalFromString,
  decimalFromStringOrNull,
  decimalFromLooseOrNull,
} from "./decimal.js";

describe("decimalFromString", () => {
  test("pads to the requested scale", () => {
    expect(decimalFromString("123.45", 4)).toBe("123.4500");
    expect(decimalFromString("5", 6)).toBe("5.000000");
    expect(decimalFromString("0", 8)).toBe("0.00000000");
  });

  test("carries an exact crypto value verbatim with no float drift", () => {
    // The Success-criteria oracle: 0.12345678 must survive ingest exactly.
    expect(decimalFromString("0.12345678", 18)).toBe("0.123456780000000000");
    // A full-precision 18dp ETH-class value is preserved digit-for-digit.
    expect(decimalFromString("0.123456789012345678", 18)).toBe("0.123456789012345678");
    // A value that Number() would round (>15 significant digits) is untouched.
    expect(decimalFromString("12345678.123456789012345678", 18)).toBe(
      "12345678.123456789012345678",
    );
  });

  test("rounds half away from zero when the input is more precise than the scale", () => {
    expect(decimalFromString("1.23455", 4)).toBe("1.2346");
    expect(decimalFromString("9.99995", 4)).toBe("10.0000");
    expect(decimalFromString("-1.23455", 4)).toBe("-1.2346");
  });

  test("handles negatives and never emits negative zero", () => {
    expect(decimalFromString("-12.34", 4)).toBe("-12.3400");
    expect(decimalFromString("-0.00000001", 4)).toBe("0.0000");
    expect(decimalFromString("-0", 8)).toBe("0.00000000");
  });

  test("tolerates a leading + and surrounding whitespace defensively", () => {
    expect(decimalFromString("+1.5", 2)).toBe("1.50");
    expect(decimalFromString("  2.5  ", 2)).toBe("2.50");
  });

  test("scale 0 yields integers without a decimal point", () => {
    expect(decimalFromString("2.5", 0)).toBe("3");
    expect(decimalFromString("2.4", 0)).toBe("2");
    expect(decimalFromString("100", 0)).toBe("100");
  });

  test("very large balances survive exactly", () => {
    expect(decimalFromString("999999999999999.99999999", 8)).toBe("999999999999999.99999999");
  });

  test("output always matches the carrier format", () => {
    for (const s of ["0", "1.5", "-22.125", "0.000001", "123456789.987654"]) {
      expect(decimalFromString(s, 8)).toMatch(DECIMAL_STRING_RE);
    }
  });

  test("throws on a non-decimal string", () => {
    expect(() => decimalFromString("abc", 4)).toThrow(/decimal string/);
    expect(() => decimalFromString("1.2.3", 4)).toThrow(/decimal string/);
    expect(() => decimalFromString("", 4)).toThrow(/decimal string/);
  });

  test("throws on invalid scale", () => {
    expect(() => decimalFromString("1", -1)).toThrow(/scale/);
    expect(() => decimalFromString("1", 1.5)).toThrow(/scale/);
  });
});

describe("decimalFromStringOrNull", () => {
  test("passes null/undefined/empty through", () => {
    expect(decimalFromStringOrNull(null, 4)).toBeNull();
    expect(decimalFromStringOrNull(undefined, 4)).toBeNull();
    expect(decimalFromStringOrNull("", 4)).toBeNull();
    expect(decimalFromStringOrNull("1.25", 4)).toBe("1.2500");
  });
});

describe("decimalFromLooseOrNull (portfolio-breakdown floats)", () => {
  test("renders a JSON number as a canonical DECIMAL carrier", () => {
    expect(decimalFromLooseOrNull(0.025, 18)).toBe("0.025000000000000000");
    expect(decimalFromLooseOrNull(1234.56, 8)).toBe("1234.56000000");
    expect(decimalFromLooseOrNull(2, 18)).toBe("2.000000000000000000");
  });

  test("avoids scientific notation for dust amounts a number would stringify to", () => {
    // String(1e-8) === "1e-8" would be rejected by decimalFromString; toFixed
    // keeps it a plain decimal.
    expect(decimalFromLooseOrNull(1e-8, 18)).toBe("0.000000010000000000");
  });

  test("still accepts the exact decimal string form (forward-compatible)", () => {
    expect(decimalFromLooseOrNull("0.50000001", 18)).toBe("0.500000010000000000");
  });

  test("passes null/undefined/empty and non-finite numbers through as null", () => {
    expect(decimalFromLooseOrNull(null, 8)).toBeNull();
    expect(decimalFromLooseOrNull(undefined, 8)).toBeNull();
    expect(decimalFromLooseOrNull("", 8)).toBeNull();
    expect(decimalFromLooseOrNull(Number.NaN, 8)).toBeNull();
    expect(decimalFromLooseOrNull(Number.POSITIVE_INFINITY, 8)).toBeNull();
  });
});
