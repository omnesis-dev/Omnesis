// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A ceiling on what background cognition may spend.
 *
 * `cognition_spend` has always recorded what was spent and stopped there —
 * tracking with no enforcement anywhere. The only real limit was the
 * bootstrap sweep's run cap, which covers one workflow and counts runs, not
 * tokens. Two runs can differ by an order of magnitude in cost depending on
 * the document, the retrieved context, the model and the prompt cache, so a
 * run count is a poor proxy for a bill.
 *
 * Budgets here are in **tokens and runs**, both measured exactly and locally.
 * Currency is deliberately absent: pricing it needs a per-model price table
 * that has to be maintained and will go stale for exactly the providers whose
 * prices move, and a budget that silently uses last year's prices makes a
 * promise it cannot keep. Cost belongs on the surfaces as a best-effort
 * figure, not as the thing standing between the operator and a large spend.
 *
 * The window is the local day, matching how spend is already bucketed. At
 * exhaustion the queue parks rather than failing runs: a parked run is
 * resumable tomorrow, whereas a failed one burns its attempt budget and
 * eventually lands in the terminal state.
 */

import { getCognitionSpendDayTotal, cognitionSpendDay } from "../storage/spend.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** Operator-set ceilings. `null` means no limit on that dimension. */
export interface CognitionBudgetSettings {
  /** Total tokens (prompt + completion) per local day. */
  dailyTokens: number | null;
  /**
   * Completed runs per local day, counted across every mechanism the day's
   * spend records — background work, the interactive lanes, and the inline
   * runs (watch compilation), for the same reason the token ceiling is.
   */
  dailyRuns: number | null;
}

/** Why cognition is paused, or that it is not. */
export type CognitionBudgetVerdict =
  | { exhausted: false }
  | {
      exhausted: true;
      /** Which ceiling was reached — for the operator surfaces. */
      dimension: "tokens" | "runs";
      used: number;
      limit: number;
      reason: string;
    };

/**
 * Whether the day's budget is spent.
 *
 * Read fresh per drain tick rather than cached: the operator can raise a limit
 * mid-day and expect work to resume without a restart, which is the same
 * live-config discipline the rest of the gate follows.
 *
 * Counts the day's spend across every mechanism, including the interactive
 * lanes. A budget that background work could exhaust while an interactive
 * session spent freely alongside it would not be a budget.
 */
export function cognitionBudgetVerdict(
  db: Db,
  settings: CognitionBudgetSettings,
  now: number,
): CognitionBudgetVerdict {
  if (settings.dailyTokens === null && settings.dailyRuns === null) return { exhausted: false };

  const total = getCognitionSpendDayTotal(db, cognitionSpendDay(now));
  if (!total) return { exhausted: false };

  if (settings.dailyTokens !== null) {
    const tokens = total.promptTokens + total.completionTokens;
    if (tokens >= settings.dailyTokens) {
      return {
        exhausted: true,
        dimension: "tokens",
        used: tokens,
        limit: settings.dailyTokens,
        reason: `Today's cognition token budget is spent (${tokens.toLocaleString()} of ${settings.dailyTokens.toLocaleString()}). Background work resumes tomorrow, or when the limit is raised.`,
      };
    }
  }

  if (settings.dailyRuns !== null && total.runs >= settings.dailyRuns) {
    return {
      exhausted: true,
      dimension: "runs",
      used: total.runs,
      limit: settings.dailyRuns,
      reason: `Today's cognition run budget is spent (${total.runs} of ${settings.dailyRuns}). Background work resumes tomorrow, or when the limit is raised.`,
    };
  }

  return { exhausted: false };
}
