// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How large a thinking budget to ask for, given what the turn may spend in total.
 *
 * One rule for every backend that can express a budget, because the trade is
 * the same wherever it is made: reasoning and the visible answer come out of
 * one pool, so a budget is only a bound if it leaves the answer room, and a
 * provider that enforces a floor will refuse anything under it.
 *
 * Its own module for the same reason `http-output-budget.ts` is one — budget
 * arithmetic is a decision with consequences worth stating, not a detail of
 * whichever backend happens to need it first.
 */

import type { ReasoningBound } from "./backend.js";

/**
 * The smallest thinking budget a provider will accept.
 *
 * Anthropic and the OpenAI-compatible servers that take a `thinking` block
 * enforce the same floor. A caller asking for less gets this rather than an
 * error: the point of a bound is to make a turn finish, and failing the request
 * outright would be the one outcome worse than thinking too long.
 */
const MIN_THINKING_BUDGET_TOKENS = 1_024;

/**
 * Tokens held back from the budget so the answer itself has room.
 *
 * Measured against a reasoning model behind an OpenAI-compatible server: given
 * `max_tokens: 8000` and no bound, the turn reported 8,000 reasoning tokens,
 * 8,000 completion tokens and returned no answer at all. It spent the whole
 * pool deciding. A bound set at the whole pool reproduces that exactly, so a
 * bound has to reserve something — and it reserves a share rather than a fixed
 * slice, because a fixed 4,096 consumes an entire modest output ceiling and
 * leaves no bound to apply.
 */
const THINKING_ANSWER_HEADROOM_TOKENS = 4_096;

/**
 * The budget to send, or `undefined` to leave the turn unbounded.
 *
 * `undefined` where the floor and the answer's share cannot both hold: sending
 * the floor anyway would hand a small-ceilinged model a far tighter bound than
 * anyone chose, arrived at by accident, on exactly the path a bound exists to
 * improve.
 */
export function thinkingBudgetTokens(
  reasoning: ReasoningBound | undefined,
  outputBudgetTokens: number,
): number | undefined {
  if (!reasoning) return undefined;
  // Never more than half the pool, so the answer's share scales with what there
  // is to share rather than being priced for a large ceiling and starving a
  // small one.
  const headroom = Math.min(THINKING_ANSWER_HEADROOM_TOKENS, Math.floor(outputBudgetTokens / 2));
  const ceiling = outputBudgetTokens - headroom;
  if (ceiling < MIN_THINKING_BUDGET_TOKENS) return undefined;
  return Math.min(Math.max(reasoning.maxTokens, MIN_THINKING_BUDGET_TOKENS), ceiling);
}
