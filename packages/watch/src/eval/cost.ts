// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a run has spent so far.
 *
 * Tokens are the ground truth — the provider reports them and they are exact.
 * Money is an estimate on top, because prices are a published table that
 * changes without the API changing. So both are reported, and the estimate
 * names the rates it used rather than presenting a number with no provenance.
 *
 * The ceiling exists because this runs against a prepaid account. It is
 * checked before each call rather than after, so a run stops *below* its limit
 * instead of discovering it went over.
 */

import type { ModelUsage } from "../compiler/model.js";

/** USD per million tokens. */
export interface ModelPrices {
  readonly cachedInput: number;
  readonly uncachedInput: number;
  readonly output: number;
}

/**
 * Published rates, by model id.
 *
 * A model that is not listed is priced at zero and reported as unpriced rather
 * than guessed at: a wrong estimate presented confidently is worse than an
 * absent one, and the token counts are still exact.
 */
export const PUBLISHED_PRICES: Readonly<Record<string, ModelPrices>> = {
  "deepseek-v4-flash": { cachedInput: 0.0028, uncachedInput: 0.14, output: 0.28 },
  "deepseek-v4-pro": { cachedInput: 0.003625, uncachedInput: 0.435, output: 0.87 },
};

export function estimateCost(usage: ModelUsage, prices: ModelPrices | undefined): number | null {
  if (!prices) return null;
  const uncached = Math.max(0, usage.promptTokens - usage.cachedPromptTokens);
  return (
    (usage.cachedPromptTokens * prices.cachedInput +
      uncached * prices.uncachedInput +
      usage.completionTokens * prices.output) /
    1_000_000
  );
}

/** Thrown when a run would cross its ceiling. Ends the run; never caught. */
export class BudgetExhausted extends Error {
  constructor(spent: number, ceiling: number) {
    super(
      `stopping: estimated spend $${spent.toFixed(2)} has reached the $${ceiling.toFixed(2)} ceiling`,
    );
    this.name = "BudgetExhausted";
  }
}

/**
 * Running totals for one evaluation.
 *
 * A ceiling of `null` means unpriced or unbounded — the totals are still kept,
 * because a run with no estimate still wants its token counts reported.
 */
export class Budget {
  private usage: ModelUsage = { promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0 };

  constructor(
    readonly prices: ModelPrices | undefined,
    readonly ceilingUsd: number | null,
  ) {}

  add(usage: ModelUsage): void {
    this.usage = {
      promptTokens: this.usage.promptTokens + usage.promptTokens,
      cachedPromptTokens: this.usage.cachedPromptTokens + usage.cachedPromptTokens,
      completionTokens: this.usage.completionTokens + usage.completionTokens,
    };
  }

  get spent(): ModelUsage {
    return this.usage;
  }

  get spentUsd(): number | null {
    return estimateCost(this.usage, this.prices);
  }

  /** Called before starting more work. Throws rather than returning false. */
  check(): void {
    const spent = this.spentUsd;
    if (this.ceilingUsd !== null && spent !== null && spent >= this.ceilingUsd) {
      throw new BudgetExhausted(spent, this.ceilingUsd);
    }
  }

  describe(): string {
    const { promptTokens, cachedPromptTokens, completionTokens } = this.usage;
    const spent = this.spentUsd;
    const money = spent === null ? "cost unpriced for this model" : `~$${spent.toFixed(3)}`;
    return `${promptTokens} prompt (${cachedPromptTokens} cached) + ${completionTokens} completion — ${money}`;
  }
}
