// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * JSON-number → DECIMAL-column carrier conversion for Plaid money columns.
 *
 * Unlike Coinbase (which serves decimal STRINGS), Plaid serves transaction and
 * balance amounts as JSON **numbers** (`amount: 12.34`), always denominated in
 * the currency's standard unit with at most two fractional digits. The number
 * already round-tripped through Plaid's own IEEE-754, so there is no
 * exact-upstream value to protect beyond what Plaid sent — the job here is to
 * render that number as a canonical 2-scale decimal string WITHOUT injecting a
 * fresh float artifact of our own, so the gateway casts the quoted literal
 * exactly into a `DECIMAL(p,2)` column and `SUM()` over `run_sql` never drifts
 * cents (the frozen exact-money criterion).
 *
 * The render uses `Number.toFixed(scale)`, which rounds the binary value at
 * the requested scale on the string side — never a second float operation. A
 * non-finite number maps to null (a malformed amount must never reach DuckDB
 * as `NaN`).
 */

/** Canonical decimal-string carrier shape for DECIMAL columns. */
export const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

/** The DuckDB scale Plaid money columns use — currency minor units (cents). */
export const MONEY_SCALE = 2;

/**
 * Render a finite JS number as a DECIMAL-column carrier with exactly `scale`
 * fractional digits. `null`/`undefined`/non-finite → null. Normalizes a
 * `-0` result to `0` so a zero is always a plain zero.
 *
 * `toFixed` is the right tool here precisely because the input is already a
 * float: it produces the shortest correctly-rounded fixed-point string for the
 * double, with no scientific notation, matching what a human reading the Plaid
 * dashboard sees. (For a decimal-STRING source we would instead operate on the
 * string with BigInt to avoid ever constructing a double — but Plaid never
 * gives us a string to preserve.)
 */
export function decimalFromNumberOrNull(
  value: number | null | undefined,
  scale: number = MONEY_SCALE,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new Error(`decimalFromNumberOrNull: scale must be an integer in [0,18], got ${scale}`);
  }
  const out = value.toFixed(scale);
  // toFixed can emit "-0.00" for a tiny negative; collapse it to "0.00".
  return /^-0(\.0+)?$/.test(out) ? out.slice(1) : out;
}
