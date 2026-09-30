// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { resolveSearchV2Config } from "./search-config.js";

describe("resolveSearchV2Config", () => {
  it("leaves legacy and empty configuration disabled", () => {
    for (const config of [undefined, {}, { v2: {} }]) {
      expect(resolveSearchV2Config(config)).toEqual({
        enabled: false,
        topN: 3,
        maxDepth: 4,
        fanout: 6,
        maxNodes: 24,
        maxCopies: 8,
        maxSummaryChars: 700,
      });
    }
  });

  it("requires explicit enrollment and preserves independently supplied budgets", () => {
    expect(resolveSearchV2Config({ v2: { topN: 5, maxNodes: 12 } })).toMatchObject({
      enabled: false,
      topN: 5,
      maxNodes: 12,
      maxDepth: 4,
    });
    expect(resolveSearchV2Config({ v2: { enabled: true, maxCopies: 3 } })).toMatchObject({
      enabled: true,
      maxCopies: 3,
      maxSummaryChars: 700,
    });
    expect(resolveSearchV2Config({ v2: { enabled: false } }).enabled).toBe(false);
  });
});
