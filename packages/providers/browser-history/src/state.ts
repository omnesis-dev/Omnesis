// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What this source persists between runs.
 *
 * A browser's history database carries no record of what it used to hold, so
 * this source treats "no longer in the browser's database" as the one true
 * deletion signal on *every* settled cycle: `syncDocuments` enumerates the
 * dates the browser's database currently backs with at least one visit and
 * reports them as `presentExternalIds` regardless of whether the cycle in
 * progress is a bootstrap or an incremental catch-up. A lost cursor
 * therefore does not open a gap this source could not already produce on
 * its own — it forces the next cycle to re-derive the whole corpus in one
 * pass (re-reading every profile from its genesis timestamp) instead of a
 * per-profile delta, which is more work but not a different outcome.
 * `onUnreadable: "rebootstrap"` (the default) is correct regardless of how
 * much of that history the browser had already aged out on its own before
 * either cycle ran — see `HISTORY_COVERAGE_DETAIL` in `index.ts` for what
 * this source can and cannot vouch for about that.
 *
 * This cursor's shape has not changed since it was introduced —
 * `lastVisitTime` has always been the per-profile map it is today. `sync`
 * separately falls back to a single `browserId`-keyed entry
 * (`cur.lastVisitTime[browserId]`) as the default watermark for a profile
 * that has no entry of its own yet, a carry-over from before per-profile
 * watermarks existed. That fallback is not a version distinction a decoder
 * could make: both the old single-key value and today's per-profile map are
 * the same `Record<string, number>`, so there is no shape for
 * `legacyVersion` to recognise — only a difference in what a given key
 * means, which `sync` already resolves correctly forever. `version` stays
 * at 1 with no migration.
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { BrowserHistoryCursor } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberMap(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === "number");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

const PHASES = ["visits", "daily", "search_terms", "documents", "done"] as const;

export const browserHistoryStateSpec: SourceStateSpec<BrowserHistoryCursor> = {
  version: 1,

  /**
   * Accepts every phase a cycle can be paused in. All five phases persist
   * the same fields, so there is no settled-vs-partial distinction to make
   * — the cursor built by the default initializer and every phase's return
   * value share this one shape.
   */
  decode(value: unknown): BrowserHistoryCursor | null {
    if (!isRecord(value)) return null;
    if (!PHASES.includes(value.phase as (typeof PHASES)[number])) return null;
    if (!isNumberMap(value.lastVisitTime)) return null;
    if (typeof value.visitsProcessed !== "number") return null;
    if (!isStringArray(value.affectedDates)) return null;
    return value as unknown as BrowserHistoryCursor;
  },

  /**
   * A runaway guard, not a capacity limit.
   *
   * `affectedDates` accumulates the calendar dates touched across every page
   * of the `visits` phase and is drained once the `daily`/`documents` phases
   * run, so a bootstrap spanning many pages can carry more than one page's
   * worth of dates. `lastVisitTime` is bounded by the number of browser
   * profiles, not by history size. The ceiling sits well above the distinct
   * dates even a decades-long browsing history could span in one bootstrap,
   * so tripping it means a drain stopped running rather than that history
   * grew.
   */
  maxBytes: 2 * 1024 * 1024,

  onUnreadable: "rebootstrap",
};
