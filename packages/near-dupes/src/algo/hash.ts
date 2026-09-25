// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * MurmurHash3 x86 32-bit. Input is a UTF-8 byte sequence; output is an
 * unsigned 32-bit integer. Deterministic and fast — used as the base hash
 * underneath the MinHash universal-hash family.
 */
export function murmur3_32(bytes: Uint8Array, seed = 0): number {
  const len = bytes.length;
  let h = seed | 0;
  let i = 0;

  while (i + 4 <= len) {
    let k = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    i += 4;

    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);

    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  // Tail bytes (0–3 remaining). MurmurHash folds the trailing bytes in
  // cumulatively — a 3-byte tail also runs the 2- and 1-byte steps.
  // Reference implementations express this as a fall-through switch; the
  // equivalent cumulative `>=` guards satisfy noFallthroughCasesInSwitch.
  let k1 = 0;
  const rem = len - i;
  if (rem >= 3) k1 ^= bytes[i + 2] << 16;
  if (rem >= 2) k1 ^= bytes[i + 1] << 8;
  if (rem >= 1) {
    k1 ^= bytes[i];
    k1 = Math.imul(k1, 0xcc9e2d51);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, 0x1b873593);
    h ^= k1;
  }

  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const utf8Encoder = new TextEncoder();

export function murmur3_32_str(s: string, seed = 0): number {
  return murmur3_32(utf8Encoder.encode(s), seed);
}
