// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { configDefaultAt, validateConfig } from "@omnesis/config";

import { describe, expect, it } from "vitest";
import { resolveSearchV2Config } from "./search-config.js";

describe("resolveSearchV2Config", () => {
  it("enables bounded agent context for legacy and empty configuration", () => {
    for (const config of [undefined, {}, { v2: {} }]) {
      expect(resolveSearchV2Config(config)).toEqual({
        enabled: true,
        topN: 3,
        minRefCount: 3,
        maxDepth: 4,
        fanout: 6,
        maxNodes: 24,
        maxCopies: 8,
        maxSummaryChars: 700,
      });
    }
  });

  it("keeps displayed defaults and explicit-block schema defaults aligned with runtime", () => {
    const resolved = resolveSearchV2Config();
    for (const [key, value] of Object.entries(resolved)) {
      expect(configDefaultAt(["search", "v2", key])).toBe(value);
    }
    const parsed = validateConfig({ search: { v2: {} } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.search?.v2).toEqual(resolved);
  });

  it("preserves supplied budgets and permits explicit legacy fallback", () => {
    expect(resolveSearchV2Config({ v2: { topN: 5, maxNodes: 12 } })).toMatchObject({
      enabled: true,
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
