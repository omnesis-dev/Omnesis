// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Decimal-string → DECIMAL-column carrier conversion for Coinbase money and
 * quantity columns.
 *
 * Coinbase returns money and quantities as decimal **strings**
 * (`available_balance.value: "1.23456789"`), not JSON numbers — so there is
 * never a double in the loop, and there must never be one:
 * `Number("0.12345678")` would silently lose precision on large balances. These
 * helpers therefore operate purely on the string representation, validating the
 * carrier format and rescaling to the column's `scale` with BigInt arithmetic.
 *
 * `DECIMAL(p,s)` columns require a validated decimal string with exactly
 * `scale` fractional digits (see `ColumnType` in `@omnesis/source-sdk`). A
 * value with fewer fractional digits is zero-padded; one with more is rounded
 * half away from zero — both at the string/BigInt level so no binary-float
 * artifact can ever perturb an exact upstream amount.
 */

/** Matches the validated decimal-string carrier format for DECIMAL columns. */
export const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

/**
 * Render a Coinbase decimal string as a DECIMAL-column carrier with exactly
 * `scale` fractional digits (`scale = 0` → no decimal point). Rounds half away
 * from zero when the input carries more fractional digits than `scale`.
 *
 * Throws on a non-decimal string — a malformed money field reaching a DECIMAL
 * column is an upstream-shape bug, never something to coerce to zero. Accepts
 * an optional leading `+` and surrounding whitespace (defensive against API
 * drift), but the output is always canonical (`DECIMAL_STRING_RE`).
 */
export function decimalFromString(value: string, scale: number): string {
  if (typeof value !== "string") {
    throw new Error(`decimalFromString: value must be a string, got ${String(value)}`);
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new Error(`decimalFromString: scale must be an integer in [0,18], got ${String(scale)}`);
  }

  let s = value.trim();
  let sign = "";
  if (s.startsWith("-")) {
    sign = "-";
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`decimalFromString: not a decimal string: ${value}`);
  }

  const dot = s.indexOf(".");
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? "" : s.slice(dot + 1);

  let intDigits: string;
  let fracDigits: string;
  if (fracPart.length <= scale) {
    intDigits = intPart;
    fracDigits = fracPart.padEnd(scale, "0");
  } else {
    // Round at `scale` using integer arithmetic on the concatenated digits —
    // half away from zero — so an over-precise upstream value can never inject
    // a float artifact.
    const kept = intPart + fracPart.slice(0, scale);
    let scaled = BigInt(kept === "" ? "0" : kept);
    if (fracPart.charCodeAt(scale) >= 0x35 /* '5' */) {
      scaled += 1n;
    }
    const padded = scaled.toString().padStart(scale + 1, "0");
    intDigits = scale === 0 ? padded : padded.slice(0, -scale);
    fracDigits = scale === 0 ? "" : padded.slice(-scale);
  }

  intDigits = intDigits.replace(/^0+(?=\d)/, "");
  const out = scale === 0 ? intDigits : `${intDigits}.${fracDigits}`;
  // Never emit "-0.00000000" — a zero is a zero.
  if (sign === "-" && /^0(\.0+)?$/.test(out)) return out;
  return sign + out;
}

/**
 * `decimalFromString` for nullable inputs: null/undefined/"" pass through as
 * null. Coinbase omits some money fields (e.g. `cost_basis` on a position with
 * no recorded basis) rather than sending `"0"`.
 */
export function decimalFromStringOrNull(
  value: string | null | undefined,
  scale: number,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return decimalFromString(value, scale);
}

/**
 * Like {@link decimalFromStringOrNull} but also accepts a JSON **number** —
 * the form Coinbase's portfolio-breakdown endpoint uses for spot-position
 * crypto quantities (unlike the exact decimal strings elsewhere). The number
 * has already lost precision to a float on Coinbase's side, so there is no
 * exact value to protect; `toFixed(scale)` renders it without the scientific
 * notation that {@link decimalFromString} would reject (e.g. dust like
 * `1e-8`). A non-finite number maps to null.
 */
export function decimalFromLooseOrNull(
  value: string | number | null | undefined,
  scale: number,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // `String(n)` is the shortest decimal that round-trips to the same double
    // (e.g. 0.025 → "0.025", not toFixed's float-noise "0.025000000000000001").
    // It only uses scientific notation for very small/large magnitudes, which
    // `decimalFromString` rejects — fall back to `toFixed` (plain decimal) there.
    const str = String(value);
    return decimalFromString(/[eE]/.test(str) ? value.toFixed(scale) : str, scale);
  }
  return decimalFromString(value, scale);
}
