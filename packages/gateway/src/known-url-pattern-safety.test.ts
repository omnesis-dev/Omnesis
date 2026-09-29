// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeUrl, type UrlCanonicalizerSpec } from "@omnesis/core";
import { describe, expect, test } from "vitest";
import {
  compileSafeUrlPattern,
  fingerprintUrlCanonicalizerSpecs,
  getCachedSafeUrlCanonicalizerRegistry,
  isSafeKnownUrlPattern,
} from "./known-url-pattern-safety.js";
import { urlCanonicalizersBody } from "./http/schemas/admin.js";

function declaration(generation: number): UrlCanonicalizerSpec[] {
  return [
    {
      hosts: ["tickets.example"],
      rules: Array.from({ length: 8 }, (_, index) => ({
        match: `[?&]route${index}=${generation}[^#&]*`,
        replacement: "",
      })),
    },
  ];
}

describe("safe URL canonicalizer registry lifecycle", () => {
  test("reuses one compiled registry for an unchanged declaration", () => {
    const specs = declaration(1);
    const fingerprint = fingerprintUrlCanonicalizerSpecs(specs);
    const first = getCachedSafeUrlCanonicalizerRegistry(specs, fingerprint);
    const second = getCachedSafeUrlCanonicalizerRegistry(specs, fingerprint);

    expect(second).toBe(first);
    expect(normalizeUrl("https://tickets.example/item?route0=1", second)).toBe(
      "https://tickets.example/item",
    );
  });

  test("explicitly releases replaced native generations under sustained declaration churn", () => {
    // Eight rules are representative of a production-shaped declaration. If
    // old RE2-WASM handles are merely dereferenced instead of deleted, this
    // many distinct generations exhaust the module's fixed 16 MiB heap.
    for (let generation = 2; generation < 2_002; generation += 1) {
      const registry = getCachedSafeUrlCanonicalizerRegistry(declaration(generation));
      expect(normalizeUrl(`https://tickets.example/item?route7=${generation}`, registry)).toBe(
        "https://tickets.example/item",
      );
    }
  });

  test("sustained HTTP-boundary validation releases its temporary native matchers", () => {
    for (let generation = 2_002; generation < 4_002; generation += 1) {
      expect(
        urlCanonicalizersBody.safeParse({ canonicalizers: declaration(generation) }).success,
      ).toBe(true);
    }
  });
});

// Disposing a matcher frees only its wrapper. Unpatched, re2-wasm's constructor
// also strands native values of its own on the same fixed heap, which
// `patches/re2-wasm+1.0.2.patch` frees. The HTTP boundary validates a source's
// declared patterns on every sync page, so any per-compile leak eventually fills
// the heap. After that no pattern compiles, and every sync page is refused as
// declaring an unsafe one.
describe("RE2 compilation leaves nothing on the heap", () => {
  test("an accepted pattern gives back the group-name table its compile read", () => {
    // Ten 1,000-character group names strand ~10 KB per compile, which fills
    // the heap (16 MiB, 5 MiB of it the Emscripten stack) in about 1,000
    // compiles. A pattern with no named groups strands 32 bytes the same way,
    // an empty table and key list: some 350,000 compiles.
    const pattern = Array.from(
      { length: 10 },
      (_, group) => `(?<g${String(group).padStart(999, "0")}>x)`,
    ).join("");
    for (let compile = 0; compile < 2_000; compile += 1) {
      expect(isSafeKnownUrlPattern(pattern)).toBe(true);
    }
  });

  test("a rejected pattern gives back the wrapper it never handed over", () => {
    // Each rejection strands ~200 bytes; about 53,000 fill the heap.
    let accepted = 0;
    for (let attempt = 0; attempt < 120_000; attempt += 1) {
      if (isSafeKnownUrlPattern("(unclosed")) accepted += 1;
    }
    expect(accepted).toBe(0);
    expect(isSafeKnownUrlPattern("example\\.com/items/(\\d+)")).toBe(true);
  });

  test("a rejected pattern still throws re2-wasm's own SyntaxError", () => {
    expect(() => compileSafeUrlPattern("(unclosed")).toThrow(SyntaxError);
    expect(() => compileSafeUrlPattern("(unclosed")).toThrow(
      /^Invalid regular expression: \/\(unclosed\/iu: missing \)/,
    );
    // re2-wasm checks group names with `in` on a plain object, so a name
    // Object.prototype already has takes its duplicate-name branch.
    expect(() => compileSafeUrlPattern("(?<constructor>x)")).toThrow(
      /Duplicate capture group name/,
    );
  });
});
