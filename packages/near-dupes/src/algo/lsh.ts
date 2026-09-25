// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { murmur3_32 } from "./hash.js";

export interface LshParams {
  readonly bands: number;
  readonly rows: number;
  /**
   * uint32s per sketch position. 1 for vanilla MinHash, 2 for ICWS
   * (which stores (winnerHash, t) pairs). Defaults to 1.
   */
  readonly slotsPerRow?: number;
}

/**
 * Validate that bands × rows × slotsPerRow matches the signature length
 * in uint32s.
 *
 * For vanilla MinHash with B=16, R=8, the LSH S-curve has its
 * inflection near s ≈ (1/B)^(1/R) ≈ 0.72 — well-aligned to a 0.75
 * verification threshold. The math is identical for ICWS because the
 * per-position collision probability is exactly weighted Jaccard.
 */
export function validateLshParams(sigUint32Length: number, p: LshParams): void {
  const slots = p.slotsPerRow ?? 1;
  if (p.bands * p.rows * slots !== sigUint32Length) {
    throw new Error(
      `LSH bands (${p.bands}) × rows (${p.rows}) × slotsPerRow (${slots}) = ` +
        `${p.bands * p.rows * slots}, expected ${sigUint32Length}`,
    );
  }
}

/**
 * Project a MinHash (or weighted MinHash) signature into LSH band
 * hashes. Returns one 32-bit bucket id per band. For weighted
 * signatures, set `slotsPerRow = 2` so each band covers R weighted
 * hash positions (= 2R uint32s).
 */
export function lshBands(sig: Uint32Array, p: LshParams): Uint32Array {
  validateLshParams(sig.length, p);
  const slots = p.slotsPerRow ?? 1;
  const bandBytes = new Uint8Array(p.rows * slots * 4);
  const buckets = new Uint32Array(p.bands);
  for (let band = 0; band < p.bands; band++) {
    const offset = band * p.rows * slots;
    for (let i = 0; i < p.rows * slots; i++) {
      const v = sig[offset + i];
      bandBytes[i * 4 + 0] = v & 0xff;
      bandBytes[i * 4 + 1] = (v >>> 8) & 0xff;
      bandBytes[i * 4 + 2] = (v >>> 16) & 0xff;
      bandBytes[i * 4 + 3] = (v >>> 24) & 0xff;
    }
    buckets[band] = murmur3_32(bandBytes, band);
  }
  return buckets;
}
