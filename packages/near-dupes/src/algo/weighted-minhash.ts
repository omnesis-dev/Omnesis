// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mix32, mulberry32, u32ToUnit } from "./prng.js";
import { murmur3_32_str } from "./hash.js";

/**
 * Ioffe's Improved Consistent Weighted Sampling (ICWS).
 *
 * For a multiset {x_1, …, x_n} with positive weights w(x_i), the
 * sketch position k stores a pair (k_winner, t_winner) such that
 * Pr[ sketch_A[k] == sketch_B[k] ] equals the weighted Jaccard
 *
 *     J_W(A, B) = Σ min(w_A(x), w_B(x)) / Σ max(w_A(x), w_B(x))
 *
 * Reference: Sergey Ioffe, "Improved Consistent Sampling, Weighted
 * Minhash and L1 Sketching", ICDM 2010.
 *
 * Each shingle's three randomness draws — r ~ Γ(2,1), c ~ Γ(2,1),
 * β ~ U(0,1) — must be functions only of (shingle, hashIndex), so we
 * derive them via `mix32(murmur32(shingle), const(hashIndex))` and
 * pull five uniforms from a `mulberry32` stream seeded with that mix.
 */

export interface WeightedMinhashParams {
  readonly numHashes: number;
  readonly seed: number;
  // Per-hash-index constant mixed with the shingle hash to make each
  // hash function statistically distinct.
  readonly hashSalts: Uint32Array;
}

export function createWeightedMinhashParams(
  numHashes: number,
  seed = 0xc0ffee,
): WeightedMinhashParams {
  const rng = mulberry32(seed);
  const salts = new Uint32Array(numHashes);
  for (let i = 0; i < numHashes; i++) salts[i] = rng();
  return { numHashes, seed, hashSalts: salts };
}

export interface WeightedShingle {
  readonly shingle: string;
  readonly weight: number;
}

/**
 * Compute the ICWS sketch of a weighted shingle set. Returns a flat
 * Uint32Array of length 2*numHashes — pairs (winnerHash, t) packed
 * interleaved. The second slot stores `t` mod 2^32 (t can be negative
 * for sub-unit weights — twos-complement preserves equality compare).
 */
export function weightedMinhash(
  weighted: Iterable<WeightedShingle>,
  params: WeightedMinhashParams,
): Uint32Array {
  const N = params.numHashes;
  const out = new Uint32Array(2 * N);
  const minA = new Float64Array(N).fill(Number.POSITIVE_INFINITY);

  for (const { shingle, weight } of weighted) {
    if (!(weight > 0)) continue;
    const shingleHash = murmur3_32_str(shingle, 0);
    const logW = Math.log(weight);
    for (let k = 0; k < N; k++) {
      const seed = mix32(shingleHash, params.hashSalts[k]);
      const rng = mulberry32(seed);
      const u1 = u32ToUnit(rng());
      const u2 = u32ToUnit(rng());
      const u3 = u32ToUnit(rng());
      const u4 = u32ToUnit(rng());
      const u5 = u32ToUnit(rng());

      // r, c ~ Gamma(2, 1)
      const r = -Math.log(u1) - Math.log(u2);
      const c = -Math.log(u3) - Math.log(u4);
      const beta = u5;

      const tF = Math.floor(logW / r + beta);
      const y = Math.exp(r * (tF - beta));
      const z = y * Math.exp(r);
      const a = c / z;

      if (a < minA[k]) {
        minA[k] = a;
        out[2 * k] = shingleHash >>> 0;
        out[2 * k + 1] = tF | 0;
      }
    }
  }
  return out;
}

/**
 * Estimated weighted-Jaccard between two ICWS sketches: fraction of
 * positions where both the winner-hash and the t value agree.
 */
export function weightedSignatureSimilarity(sigA: Uint32Array, sigB: Uint32Array): number {
  if (sigA.length !== sigB.length || sigA.length % 2 !== 0) {
    throw new Error(`weighted signature length mismatch or odd: ${sigA.length}, ${sigB.length}`);
  }
  const N = sigA.length / 2;
  let matches = 0;
  for (let k = 0; k < N; k++) {
    if (sigA[2 * k] === sigB[2 * k] && sigA[2 * k + 1] === sigB[2 * k + 1]) matches++;
  }
  return matches / N;
}

export function packWeightedSignature(sig: Uint32Array): Buffer {
  if (sig.length % 2 !== 0) throw new Error(`expected even length, got ${sig.length}`);
  const buf = Buffer.allocUnsafe(sig.length * 4);
  for (let i = 0; i < sig.length; i++) buf.writeUInt32LE(sig[i], i * 4);
  return buf;
}

export function unpackWeightedSignature(buf: Buffer, numHashes: number): Uint32Array {
  if (buf.length !== 2 * numHashes * 4) {
    throw new Error(`weighted buffer ${buf.length} bytes, expected ${2 * numHashes * 4}`);
  }
  const sig = new Uint32Array(2 * numHashes);
  for (let i = 0; i < sig.length; i++) sig[i] = buf.readUInt32LE(i * 4);
  return sig;
}
