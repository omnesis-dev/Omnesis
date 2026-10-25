// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Reading the agent-owned deadline structure on open loops. */

import { cognitionSpendDay } from "./storage/spend.js";

/**
 * Extract the one scheduling signal a loop's deadline carries: an optional sortable due day (local `YYYY-MM-DD`).
 *
 * Deadlines are an agent-owned JSON structure the engine never
 * validates. The RECOMMENDED shape (advertised in the open-loop tool
 * descriptions) is
 *
 *   { "type": "any_time" | "by" | "approximate" | "on_day",
 *     "date"?: "YYYY-MM-DD", "note"?: string }
 *
 * A top-level `date` string — a bare day, or a full ISO date-time
 * converted to the local day — yields the due day; a bare-string
 * deadline that parses as a date is tolerated too. Anything else
 * ("any time", prose approximations, shapes of the agent's own
 * invention) yields null and is never treated as due.
 */
export function deadlineDueDay(deadline: unknown): string | null {
  if (typeof deadline === "string") return dueDayOfString(deadline);
  if (typeof deadline === "object" && deadline !== null) {
    const date = (deadline as Record<string, unknown>)["date"];
    if (typeof date === "string") return dueDayOfString(date);
  }
  return null;
}

const BARE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dueDayOfString(s: string): string | null {
  // A bare day is already a local day — never route it through
  // `Date.parse`, which reads it as UTC midnight and would shift it a
  // day in negative-offset timezones.
  if (BARE_DAY_RE.test(s)) return s;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : cognitionSpendDay(ms);
}
