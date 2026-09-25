// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deterministic PRNG utilities. Used by the weighted-minhash sketch to
 * derive r, c, β draws per (shingle, hash index) in a way that
 * reproduces across processes and runs.
 *
 * `mix32` is a splitmix-style finalizer for combining two 32-bit
 * values into a single seed without bias. `mulberry32` is a small,
 * fast PRNG with good statistical properties for the sample sizes we
 * draw per (shingle, hash). All values are unsigned 32-bit.
 */

export function mix32(a: number, b: number): number {
  let x = ((a >>> 0) + Math.imul(b >>> 0, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return (r ^ (r >>> 14)) >>> 0;
  };
}

/**
 * Convert a uint32 to a uniform float in the half-open interval (0, 1].
 * Mapping never returns exactly 0 — useful for callers that pass the
 * result through log().
 */
export function u32ToUnit(u: number): number {
  return ((u >>> 0) + 1) / 4294967297;
}
