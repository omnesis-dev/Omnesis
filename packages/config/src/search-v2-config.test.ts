// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { validateConfig } from "./config-schema.js";

describe("search v2 configuration", () => {
  it("keeps legacy configurations valid without rewriting an omitted v2 block", () => {
    const result = validateConfig({ search: {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.search?.v2).toBeUndefined();
  });

  it("defaults an explicit block to enabled with bounded budgets", () => {
    const result = validateConfig({ search: { v2: {} } });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.config.search?.v2).toEqual({
        enabled: true,
        topN: 3,
        maxDepth: 4,
        fanout: 6,
        maxNodes: 24,
        maxCopies: 8,
        maxSummaryChars: 700,
      });
  });

  it("accepts explicit enrollment and maximum budgets", () => {
    const v2 = {
      enabled: true,
      topN: 10,
      maxDepth: 5,
      fanout: 12,
      maxNodes: 48,
      maxCopies: 24,
      maxSummaryChars: 2000,
    };
    const result = validateConfig({ search: { v2 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.search?.v2).toEqual(v2);
  });

  it("preserves an explicit false fallback rather than replacing it with the default", () => {
    const result = validateConfig({ search: { v2: { enabled: false } } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.search?.v2?.enabled).toBe(false);
  });

  it.each([
    { enabled: "true" },
    { topN: 0 },
    { topN: 11 },
    { topN: 1.5 },
    { maxDepth: 0 },
    { maxDepth: 6 },
    { fanout: 0 },
    { fanout: 13 },
    { maxNodes: 0 },
    { maxNodes: 49 },
    { maxCopies: 0 },
    { maxCopies: 25 },
    { maxSummaryChars: 99 },
    { maxSummaryChars: 2001 },
    { maxNodes: "24" },
  ])("rejects invalid budgets even with unknown-key stripping: %j", (v2) => {
    expect(validateConfig({ search: { v2 } }).ok).toBe(false);
    expect(validateConfig({ search: { v2 } }, { stripUnknownKeys: true }).ok).toBe(false);
  });

  it("rejects unknown keys strictly and strips them when explicitly requested", () => {
    const input = { search: { v2: { enabled: true, futureBudget: 4 } } };
    expect(validateConfig(input).ok).toBe(false);
    const result = validateConfig(input, { stripUnknownKeys: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.search?.v2?.enabled).toBe(true);
      expect(result.config.search?.v2).not.toHaveProperty("futureBudget");
      expect(result.strippedKeys).toEqual(["/search/v2/futureBudget"]);
    }
  });
});
