// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { murmur3_32_str } from "./hash.js";

/**
 * Parameters of a MinHash signature: how many hash functions and the
 * universal-hash family coefficients used to derive them from one base
 * hash. (a_i, b_i) are generated deterministically from `seed` so the
 * same parameters produce identical signatures across processes.
 *
 * Theoretical aside: this is a 2-independent hash family, not a
 * min-wise independent one. The estimator is slightly biased relative
 * to true Jaccard but the bias shrinks with signature size; for
 * N >= 128 it is well below our threshold precision.
 */
export interface MinhashParams {
  readonly numHashes: number;
  readonly a: Uint32Array;
  readonly b: Uint32Array;
  readonly seed: number;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return (r ^ (r >>> 14)) >>> 0;
  };
}

export function createMinhashParams(numHashes: number, seed = 0xc0ffee): MinhashParams {
  const rng = mulberry32(seed);
  const a = new Uint32Array(numHashes);
  const b = new Uint32Array(numHashes);
  for (let i = 0; i < numHashes; i++) {
    a[i] = (rng() | 1) >>> 0;
    b[i] = rng() >>> 0;
  }
  return { numHashes, a, b, seed };
}

const MAX_U32 = 0xffffffff;

/**
 * Compute the MinHash signature of a shingle set under the given
 * parameters. Output is a Uint32Array of length `numHashes`.
 */
export function minhash(shingles: Iterable<string>, params: MinhashParams): Uint32Array {
  const { numHashes, a, b } = params;
  const sig = new Uint32Array(numHashes).fill(MAX_U32);
  for (const s of shingles) {
    const base = murmur3_32_str(s, 0);
    for (let i = 0; i < numHashes; i++) {
      const h = (Math.imul(a[i], base) + b[i]) >>> 0;
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

export function packSignature(sig: Uint32Array): Buffer {
  const buf = Buffer.allocUnsafe(sig.length * 4);
  for (let i = 0; i < sig.length; i++) {
    buf.writeUInt32LE(sig[i], i * 4);
  }
  return buf;
}

export function unpackSignature(buf: Buffer, numHashes: number): Uint32Array {
  if (buf.length !== numHashes * 4) {
    throw new Error(`signature buffer size ${buf.length} does not match numHashes ${numHashes}`);
  }
  const sig = new Uint32Array(numHashes);
  for (let i = 0; i < numHashes; i++) {
    sig[i] = buf.readUInt32LE(i * 4);
  }
  return sig;
}
