// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SharedArrayBuffer-backed near-dup DF (document-frequency) table.
 *
 * The DF table — millions of (shingle → df) rows — is read by the CPU pool to
 * IDF-weight shingles during signing and verification. Re-serializing it to a
 * worker per cycle (a structured clone of the whole table plus a Map rebuild)
 * dominated near-dup compute. Instead we pack it ONCE into a SharedArrayBuffer
 * (built off the main thread when the DF changes); every worker reads the same
 * memory by reference, with zero copying.
 *
 * Layout — a single Float64Array view over the buffer:
 *   [0]             totalDocs
 *   [1]             n = number of entries
 *   [2 .. 2+n)      shingle keys, ascending (for binary search)
 *   [2+n .. 2+2n)   df counts, aligned to the keys
 *
 * Shingles are keyed by a 53-bit hash (two Murmur3-32 hashes combined) so the
 * key fits exactly in a float64 and lookups need no string storage/compare.
 * At corpus scale (a few million shingles) the expected number of 53-bit key
 * collisions is < 0.01, so the (already soft) IDF weights are exact in
 * practice. A shingle that isn't present resolves to df 0 — matching the
 * previous `map.get(shingle) ?? 0`.
 */

import { murmur3_32_str } from "@omnesis/near-dupes";

/** 53-bit key for a shingle: two 32-bit Murmur hashes packed into a float64. */
function shingleKey(shingle: string): number {
  const h0 = murmur3_32_str(shingle, 0); // 32 bits
  const h1 = murmur3_32_str(shingle, 1); // 32 bits
  // h0 * 2^21 + top-21-bits-of-h1 → 53 bits, exactly representable in float64.
  return h0 * 0x200000 + (h1 >>> 11);
}

export interface DfLookup {
  totalDocs: number;
  df(shingle: string): number;
}

/** Header slots before the keys array. */
const HEADER = 2;

/**
 * Build a read-only, SharedArrayBuffer-backed DF table. Runs once per DF
 * change (ideally off the main thread, e.g. on the IO worker that fetched the
 * rows). The returned buffer is safe to hand to any worker by reference.
 */
export function buildDfSab(
  entries: ReadonlyArray<readonly [string, number]>,
  totalDocs: number,
): SharedArrayBuffer {
  const n = entries.length;
  const keys = new Float64Array(n);
  const dfs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    keys[i] = shingleKey(entries[i][0]);
    dfs[i] = entries[i][1];
  }
  // Sort an index permutation by key, then emit keys + dfs in key order.
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => keys[a] - keys[b]);

  const sab = new SharedArrayBuffer((HEADER + 2 * n) * Float64Array.BYTES_PER_ELEMENT);
  const view = new Float64Array(sab);
  view[0] = totalDocs;
  view[1] = n;
  for (let i = 0; i < n; i++) {
    const j = order[i];
    view[HEADER + i] = keys[j];
    view[HEADER + n + i] = dfs[j];
  }
  return sab;
}

/**
 * Read-only lookup over a buffer produced by `buildDfSab`. Constructing this is
 * O(1) (just a typed-array view); each `df()` is a binary search — no Map build,
 * no clone. Safe to call from any thread that received the buffer by reference.
 */
export function dfLookupFromSab(sab: SharedArrayBuffer): DfLookup {
  const view = new Float64Array(sab);
  const totalDocs = view[0];
  const n = view[1];
  const dfsOff = HEADER + n;
  return {
    totalDocs,
    df(shingle: string): number {
      const key = shingleKey(shingle);
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const mk = view[HEADER + mid];
        if (mk === key) return view[dfsOff + mid];
        if (mk < key) lo = mid + 1;
        else hi = mid - 1;
      }
      return 0;
    },
  };
}
