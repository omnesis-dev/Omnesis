// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { createWeightedMinhashParams, weightedMinhash } from "./weighted-minhash.js";

/**
 * Boundary test for the ICWS argmin in weighted-minhash.ts:
 *
 *   if (a < minA[k]) { ... }   // keep the strict-min winner
 *
 * `minA[k]` is seeded with +Infinity and `a = c / z`. For a normal
 * weight, `a` is finite and the first shingle's `a < Infinity` claims
 * the slot. But for a denormal-tiny weight, `logW / r` is enormously
 * negative, so `tF` is enormously negative, `z = exp(r·(tF − β + 1))`
 * UNDERFLOWS to exactly 0, and `a = c / 0 = +Infinity`.
 *
 * At that point the two branches diverge on the EXACT sentinel boundary:
 *
 *   correct `a <  minA[k]`  → `Infinity <  Infinity` → false → slot NEVER
 *                             written → signature stays all-zero.
 *   mutant  `a <= minA[k]`  → `Infinity <= Infinity` → true  → slot written
 *                             with the shingle hash + tF → signature non-zero.
 *
 * `Number.MIN_VALUE` (5e-324) is the smallest positive double, so it
 * passes the `if (!(weight > 0)) continue;` guard yet drives every slot
 * to the underflow. The all-zero-vs-non-zero outcome is deterministic
 * across any (numHashes, seed) choice.
 */
describe("weightedMinhash ICWS argmin boundary (a < +Infinity sentinel)", () => {
  for (const [numHashes, seed] of [
    [64, 1],
    [128, 42],
    [16, 0xc0ffee],
  ] as const) {
    it(`a denormal-weight shingle yields an all-zero signature (N=${numHashes}, seed=${seed})`, () => {
      const params = createWeightedMinhashParams(numHashes, seed);
      // Single shingle whose weight underflows z to 0 ⇒ a = c/0 = +Infinity
      // at every slot. The strict `<` never beats the +Infinity sentinel.
      const sig = weightedMinhash(
        [{ shingle: "denormal-token-x", weight: Number.MIN_VALUE }],
        params,
      );

      expect(sig.length).toBe(2 * numHashes);
      // Correct code: no slot ever wins against the +Infinity init, so the
      // whole signature is left at its zero-fill. The `<=` mutant would
      // claim every slot (Infinity <= Infinity) and produce a non-zero sig.
      expect(Array.from(sig).every((v) => v === 0)).toBe(true);
    });
  }

  it("a normal-weight shingle DOES claim every slot (control: finite a beats +Infinity)", () => {
    // Same single-shingle setup but with a normal weight: `a` is finite at
    // every slot, so `a < Infinity` is true and the slots are written. This
    // proves the all-zero outcome above is specific to the underflow
    // boundary, not an artifact of a one-element input.
    const params = createWeightedMinhashParams(64, 1);
    const sig = weightedMinhash([{ shingle: "denormal-token-x", weight: 1.0 }], params);
    expect(sig.length).toBe(128);
    // The winner-hash slots (even indices) are the (non-zero) shingle hash.
    let nonZeroWinners = 0;
    for (let k = 0; k < 64; k++) if (sig[2 * k] !== 0) nonZeroWinners++;
    expect(nonZeroWinners).toBe(64);
  });

  it("a finite-weight shingle still wins slots even when a denormal one is also present", () => {
    // With both a normal and a denormal-weight shingle in the set, the
    // normal one's finite `a` always beats the denormal one's +Infinity, so
    // every slot is claimed by the normal shingle under the correct `<`.
    // (The mutant's behavior on the denormal shingle is moot here because
    // the finite shingle already owns each slot — the all-zero case above
    // is the discriminating one.)
    const params = createWeightedMinhashParams(64, 1);
    const onlyNormal = weightedMinhash([{ shingle: "normal-token", weight: 1.0 }], params);
    const mixed = weightedMinhash(
      [
        { shingle: "normal-token", weight: 1.0 },
        { shingle: "denormal-token-x", weight: Number.MIN_VALUE },
      ],
      params,
    );
    // The denormal shingle contributes nothing, so the mixed signature is
    // identical to the normal-only one.
    expect(Array.from(mixed)).toEqual(Array.from(onlyNormal));
    expect(Array.from(mixed).some((v) => v !== 0)).toBe(true);
  });
});
