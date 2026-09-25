// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What this source persists between runs, and how an older version of it is
 * carried forward.
 *
 * knowledgeC.db is not this source's data — it is macOS's own rolling
 * activity log, and the OS reclaims space from it on its own schedule. Unlike
 * Notes, Contacts, Things or a vault of files, there is no companion
 * mechanism here that reconciles the output against what the store currently
 * holds: this source only ever appends `screen_time_sessions` /
 * `screen_time_daily` rows and rewrites a digest document for a date that saw
 * new sessions, and nothing ever asks the database "what have you got now" on
 * a corpus-wide basis. That combination is what makes a lost cursor
 * dangerous here in a way it is not for this package's local-database
 * siblings: a rebootstrap resumes at `lastCreationDate: 0` and walks forward
 * through whatever the OS still has, so any session that both arrived and
 * aged out of the OS's window while the cursor was unreadable is gone from
 * the source's only record of "what still needs reading" — and the sync
 * that lost it completes looking exactly like a normal one. `onUnreadable:
 * "stop"` parks the source instead, so that gap gets an operator's attention
 * rather than a clean-looking log line.
 *
 * `lastPk` is the one shape change this cursor has had: it was added to
 * break ties on `ZCREATIONDATE`, which is not unique, so a page boundary
 * landing mid-tie would otherwise skip every row sharing the boundary
 * timestamp. A cursor written before that addition has no `lastPk` at all,
 * which `legacyVersion` reads as version 1; `migrate[1]` supplies the
 * missing floor of 0, matching the safe interpretation `pk` was always
 * meant to have when absent (0 disambiguates nothing, so every row at
 * `lastCreationDate` is still matched).
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { ScreenTimeSyncCursor } from "./types.js";

/** The shape stored today: a composite `(creationDate, pk)` watermark. */
export const SCREEN_TIME_STATE_VERSION = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export const screenTimeStateSpec: SourceStateSpec<ScreenTimeSyncCursor> = {
  version: SCREEN_TIME_STATE_VERSION,

  /**
   * Accepts every phase a cycle can be paused in — `sessions`, `daily` and
   * `done` all persist the same fields, so there is no settled-vs-partial
   * distinction to make here (unlike a source whose mid-cycle bookkeeping is
   * optional, every field below is always present once a cycle has run
   * once).
   */
  decode(value: unknown): ScreenTimeSyncCursor | null {
    if (!isRecord(value)) return null;
    if (value.phase !== "sessions" && value.phase !== "daily" && value.phase !== "done") {
      return null;
    }
    if (typeof value.lastCreationDate !== "number") return null;
    if (typeof value.lastPk !== "number") return null;
    if (typeof value.sessionsProcessed !== "number") return null;
    if (!isStringArray(value.affectedDates)) return null;
    return value as unknown as ScreenTimeSyncCursor;
  },

  /** A value with no `pk` floor predates the composite cursor: version 1. */
  legacyVersion(value: unknown): number | null {
    if (!isRecord(value)) return null;
    return typeof value.lastPk === "number" ? SCREEN_TIME_STATE_VERSION : 1;
  },

  migrate: {
    /**
     * Supplies the missing `pk` tie-breaker as 0, which is the value this
     * source's own code already substitutes for a `lastPk`-less cursor
     * (`cur.lastPk ?? 0`) — 0 disambiguates nothing, so every session at
     * `lastCreationDate` is still matched exactly as it was before the
     * tie-breaker existed.
     */
    1: (prior: unknown): unknown | null => {
      if (!isRecord(prior)) return null;
      // Only the absent tie-breaker has a known interpretation. Preserve all
      // other fields for decode(), so corrupt state still obeys onUnreadable.
      return { ...prior, lastPk: prior.lastPk === undefined ? 0 : prior.lastPk };
    },
  },

  /**
   * A runaway guard, not a capacity limit.
   *
   * `affectedDates` accumulates the calendar dates seen across every page of
   * the `sessions` phase and is only cleared once the `daily` phase drains
   * it, so a bootstrap spanning many pages can carry more than one page's
   * worth of dates at a time. The ceiling sits well above the distinct dates
   * knowledgeC.db's own rolling window could plausibly span, so tripping it
   * means the drain stopped running rather than that the window grew.
   */
  maxBytes: 4 * 1024 * 1024,

  /**
   * See the module doc comment: this source has no corpus-wide reconciliation
   * to fall back on, so a lost cursor can silently drop whatever aged out of
   * knowledgeC.db's window before the next successful sync — a gap nothing
   * downstream would ever surface. Parking the source is what makes that gap
   * visible instead.
   */
  onUnreadable: "stop",
};
