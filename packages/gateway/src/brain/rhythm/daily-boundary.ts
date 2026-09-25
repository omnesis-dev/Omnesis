// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Local-time daily-boundary math for the Cognition Steward's daily rhythm.
 *
 * There is no cron / wall-clock / timezone facility in the scheduler, so
 * the rhythm is a coarse periodic tick that asks "what was the most
 * recent daily boundary?" and a stored last-run day gates the work to
 * once per day (the poll-evaluator due-gate idiom).
 *
 * The boundary basis is the **gateway machine's local time** —
 * deliberately the simplest V1 basis; wrong-when-travelling is a known
 * rough edge. Calendar arithmetic goes through the `Date` local-time
 * constructor, so DST days (23h/25h) resolve to real local instants and
 * a nonexistent hour normalizes forward rather than throwing.
 */

import { cognitionSpendDay } from "../storage/spend.js";

export interface DailyBoundary {
  /** The most recent boundary instant (unix ms): today or yesterday at `hour`. */
  boundaryMs: number;
  /** The boundary one calendar day before `boundaryMs` (the batch range start). */
  prevBoundaryMs: number;
  /** Local `YYYY-MM-DD` of the boundary — the due-gate marker value. */
  day: string;
}

/**
 * The most recent local-time daily boundary at or before `nowMs`. After
 * any amount of downtime this is always exactly ONE boundary — the
 * missed-day catch-up rule (fire once, not N times) falls out of it.
 */
export function mostRecentDailyBoundary(nowMs: number, hour: number): DailyBoundary {
  const now = new Date(nowMs);
  const todayBoundary = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    0,
    0,
    0,
  ).getTime();
  const boundaryMs =
    todayBoundary <= nowMs
      ? todayBoundary
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, 0, 0, 0).getTime();
  const b = new Date(boundaryMs);
  const prevBoundaryMs = new Date(
    b.getFullYear(),
    b.getMonth(),
    b.getDate() - 1,
    hour,
    0,
    0,
    0,
  ).getTime();
  return { boundaryMs, prevBoundaryMs, day: cognitionSpendDay(boundaryMs) };
}
