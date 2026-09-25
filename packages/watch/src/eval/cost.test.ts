// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The ceiling exists because this runs against a prepaid account, so the thing
 * worth testing is that it stops, and that it stops below the number.
 *
 * The estimate is checked against rates written out by hand here rather than
 * read from the same table the code reads: a test that imported the price list
 * would confirm the arithmetic and nothing else, and the arithmetic is not the
 * part anyone gets wrong. Cache accounting is — an estimate that priced cached
 * input at the uncached rate would report a run costing fifty times what it did.
 */

import { describe, expect, it } from "vitest";

import { Budget, BudgetExhausted, PUBLISHED_PRICES, estimateCost } from "./cost.js";
import type { ModelUsage } from "../compiler/model.js";

const FLASH = PUBLISHED_PRICES["deepseek-v4-flash"]!;

function usage(over: Partial<ModelUsage> = {}): ModelUsage {
  return { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, ...over };
}

describe("estimating a cost", () => {
  it("prices cached and uncached input differently", () => {
    // The whole reason the prompt has a static prefix. A million cached tokens
    // and a million uncached ones are two orders of magnitude apart, and an
    // estimate that could not tell them apart would make the layout look
    // pointless.
    const cached = estimateCost(
      usage({ promptTokens: 1_000_000, cachedPromptTokens: 1_000_000 }),
      FLASH,
    );
    const fresh = estimateCost(usage({ promptTokens: 1_000_000 }), FLASH);
    expect(cached).toBeCloseTo(0.0028, 6);
    expect(fresh).toBeCloseTo(0.14, 6);
    expect(fresh! / cached!).toBeGreaterThan(40);
  });

  it("prices the part of the prompt that missed the cache", () => {
    const mixed = estimateCost(
      usage({ promptTokens: 1_000_000, cachedPromptTokens: 900_000, completionTokens: 1_000_000 }),
      FLASH,
    );
    expect(mixed).toBeCloseTo(0.9 * 0.0028 + 0.1 * 0.14 + 0.28, 6);
  });

  it("says nothing rather than guessing for a model with no published rate", () => {
    // A confident wrong number is worse than an absent one, and the token
    // counts are exact either way.
    expect(estimateCost(usage({ promptTokens: 1_000_000 }), undefined)).toBeNull();
    expect(PUBLISHED_PRICES["some-model-nobody-priced"]).toBeUndefined();
  });
});

describe("a budget", () => {
  it("adds up every call", () => {
    const budget = new Budget(FLASH, 1);
    budget.add(usage({ promptTokens: 100, cachedPromptTokens: 40, completionTokens: 10 }));
    budget.add(usage({ promptTokens: 200, cachedPromptTokens: 60, completionTokens: 20 }));
    expect(budget.spent).toEqual({
      promptTokens: 300,
      cachedPromptTokens: 100,
      completionTokens: 30,
    });
  });

  it("stops when the estimate reaches the ceiling", () => {
    const budget = new Budget(FLASH, 0.1);
    expect(() => budget.check()).not.toThrow();
    budget.add(usage({ promptTokens: 1_000_000 }));
    expect(() => budget.check()).toThrow(BudgetExhausted);
  });

  it("checks before the work, so a run stops below its ceiling", () => {
    // Checked after, a run discovers it went over. The last call it makes is
    // the one that reached the number, not the one after it.
    const budget = new Budget(FLASH, 0.1);
    budget.add(usage({ promptTokens: 700_000 }));
    expect(budget.spentUsd!).toBeLessThan(0.1);
    expect(() => budget.check()).not.toThrow();
  });

  it("does not stop a run whose cost cannot be estimated", () => {
    // An unpriced model still runs; it just reports tokens instead of money.
    const budget = new Budget(undefined, 0.000_001);
    budget.add(usage({ promptTokens: 10_000_000 }));
    expect(budget.spentUsd).toBeNull();
    expect(() => budget.check()).not.toThrow();
  });

  it("does not stop a run with no ceiling", () => {
    const budget = new Budget(FLASH, null);
    budget.add(usage({ promptTokens: 100_000_000 }));
    expect(() => budget.check()).not.toThrow();
  });

  it("reports tokens whether or not it can report money", () => {
    const priced = new Budget(FLASH, null);
    const unpriced = new Budget(undefined, null);
    priced.add(usage({ promptTokens: 100, cachedPromptTokens: 40 }));
    unpriced.add(usage({ promptTokens: 100, cachedPromptTokens: 40 }));
    expect(priced.describe()).toContain("100 prompt (40 cached)");
    expect(unpriced.describe()).toContain("100 prompt (40 cached)");
    expect(unpriced.describe()).toContain("unpriced");
  });
});
