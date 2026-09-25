// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeUrl, type UrlCanonicalizerSpec } from "@omnesis/core";
import { describe, expect, test } from "vitest";
import {
  fingerprintUrlCanonicalizerSpecs,
  getCachedSafeUrlCanonicalizerRegistry,
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
