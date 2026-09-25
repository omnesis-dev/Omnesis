// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { DEFAULT_HTTP_MAX_OUTPUT_TOKENS } from "./http-error.js";

export const EXTENDED_HTTP_INITIAL_OUTPUT_TOKENS = 16_384;
export const EMPTY_LENGTH_RETRY_OUTPUT_TOKENS = 32_768;
export const ORDINARY_HTTP_TIMEOUT_MS = 120_000;
export const EXTENDED_HTTP_TIMEOUT_MS = 600_000;
export const SELECTED_REASONING_ANSWER_HEADROOM_TOKENS = 4_096;

/** Keep an explicitly selected reasoning budget below the total output cap. */
export function outputBudgetForSelectedReasoning(
  baseOutputTokens: number,
  configuredMax: number | undefined,
  reasoningBudgetTokens: number | undefined,
): number {
  if (reasoningBudgetTokens === undefined || reasoningBudgetTokens <= 0) return baseOutputTokens;
  const required = reasoningBudgetTokens + SELECTED_REASONING_ANSWER_HEADROOM_TOKENS;
  if (configuredMax !== undefined && configuredMax < required) {
    throw new Error(
      `The selected ${reasoningBudgetTokens}-token reasoning budget needs at least ${required} output tokens, ` +
        `but this model is configured for ${configuredMax}.`,
    );
  }
  return Math.max(baseOutputTokens, required);
}

export function initialHttpOutputBudget(
  extendedOutputObserved: boolean,
  configuredMax: number | undefined,
): number {
  if (configuredMax !== undefined) return configuredMax;
  return extendedOutputObserved
    ? EXTENDED_HTTP_INITIAL_OUTPUT_TOKENS
    : DEFAULT_HTTP_MAX_OUTPUT_TOKENS;
}

export function retryHttpOutputBudget(configuredMax: number | undefined): number {
  return Math.min(
    configuredMax ?? EMPTY_LENGTH_RETRY_OUTPUT_TOKENS,
    EMPTY_LENGTH_RETRY_OUTPUT_TOKENS,
  );
}
