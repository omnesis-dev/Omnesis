// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { murmur3_32 } from "./hash.js";

const enc = new TextEncoder();
const h = (s: string, seed?: number) => murmur3_32(enc.encode(s), seed);

/**
 * Characterization vectors for MurmurHash3 x86 32-bit. These pin the exact
 * outputs across every tail length (len % 4 ∈ {0,1,2,3}) and the high-byte
 * sign paths, so the tail-mixing logic is locked byte-for-byte: the near-dup
 * MinHash universal-hash family is built on top of this hash and any drift
 * would silently change every signature.
 */
describe("murmur3_32 characterization", () => {
  it("matches known outputs across all tail lengths", () => {
    expect(h("")).toBe(0); // empty
    expect(h("a")).toBe(1009084850); // tail 1
    expect(h("ab")).toBe(2613040991); // tail 2
    expect(h("abc")).toBe(3017643002); // tail 3
    expect(h("abcd")).toBe(1139631978); // 1 block, tail 0
    expect(h("abcde")).toBe(3902511862); // 1 block + tail 1
    expect(h("abcdef")).toBe(1635893381); // 1 block + tail 2
    expect(h("abcdefg")).toBe(2285673222); // 1 block + tail 3
    expect(h("abcdefgh")).toBe(1239272644); // 2 blocks, tail 0
    expect(h("hello world")).toBe(1586663183);
    expect(h("The quick brown fox jumps over the lazy dog")).toBe(776992547);
  });

  it("respects the seed", () => {
    expect(h("abc", 42)).toBe(1313807976);
    expect(h("abcde", 1)).toBe(4289507611);
  });

  it("sign-extends high tail bytes correctly", () => {
    expect(murmur3_32(new Uint8Array([255, 128, 1]))).toBe(957812471); // tail 3
    expect(murmur3_32(new Uint8Array([255, 128]))).toBe(1817059852); // tail 2
    expect(murmur3_32(new Uint8Array([200]))).toBe(223053920); // tail 1
  });
});
