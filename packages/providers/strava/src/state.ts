// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What Strava Activities persists between runs, and what should happen when
 * it cannot be read.
 *
 * The cursor is a phase machine (`types.ts` documents the full walk), and a
 * phase machine is exactly the shape that breaks across releases: renaming or
 * retiring a phase leaves an installed cursor's `phase` string pointing at
 * something this build no longer recognises. Before this declaration, the
 * source's own validator answered that with `null`, which the host read as
 * "no bookmark" and restarted from `backfill` — silently.
 *
 * That restart is not the cheap kind. `backfill` re-lists every activity
 * (cheap: one call per 100), but `buildOutputs` calls `activityToRecord`
 * without any enrichment options during backfill, which writes all four
 * `*_fetched_at` columns as `null` on every row it re-emits — and the
 * analytics store's upsert replaces the full row. So a lost cursor doesn't
 * just re-list activities, it clears the enrichment stamps on the account's
 * entire history and sends every activity back through `detail-backfill`,
 * `social-backfill`, `zones-backfill` and `streams-backfill`: 1 + 2 + 1 + 1 =
 * 5 calls per activity, not just the new ones. An account with a couple of
 * thousand activities — unremarkable after a few years on Strava — is tens of
 * thousands of calls against a read quota this source already treats as ~90
 * calls per 15-minute window (see `quota.ts`'s `DEFAULT_SAFETY_PCT`) and under
 * a thousand per day: days of quota-limited grinding to reproduce data the
 * account already had. `onUnreadable: "stop"` refuses instead of paying that
 * cost silently, and leaves the bookmark for a build that can read it.
 */

import { STRAVA_PHASES } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { EnrichmentTier, StravaActivitiesCursor } from "./types.js";

export const STRAVA_ACTIVITIES_STATE_VERSION = 1;

const TIERS: ReadonlySet<string> = new Set<EnrichmentTier>([
  "detail",
  "social",
  "zones",
  "streams",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

export const stravaActivitiesStateSpec: SourceStateSpec<StravaActivitiesCursor> = {
  version: STRAVA_ACTIVITIES_STATE_VERSION,

  /**
   * Every field but `phase` is optional, and every phase in `activities.ts`,
   * `enrichment.ts` and `athlete-refresh.ts` returns some subset of this same
   * flat shape — there is no settled-vs-partial split to reconcile the way
   * Obsidian's cycle bookkeeping needs one. Checking each field's type once
   * covers a mid-`snapshot-rewalk` page (`snapshotIds` filling up), a
   * mid-`edit-sweep` page, every enrichment tier's pass-through cursor, and
   * the settled `incremental` shape alike.
   */
  decode(value: unknown): StravaActivitiesCursor | null {
    if (!isRecord(value)) return null;
    if (!isOptionalStringArray(value.pendingSocialStamps)) return null;
    if (!isOptionalStringArray(value.pendingDetailStamps)) return null;
    if (typeof value.phase !== "string" || !STRAVA_PHASES.has(value.phase)) return null;
    if (!isOptionalNumber(value.backfillBefore)) return null;
    if (!isOptionalNumber(value.backfillPage)) return null;
    if (!isOptionalNumber(value.lastActivityTimestamp)) return null;
    if (!isOptionalString(value.lastSnapshotAt)) return null;
    if (!isOptionalNumber(value.snapshotBefore)) return null;
    if (!isOptionalNumber(value.snapshotPage)) return null;
    if (!isOptionalStringArray(value.snapshotIds)) return null;
    if (!isOptionalString(value.lastEditSweepAt)) return null;
    if (!isOptionalNumber(value.editSweepAfter)) return null;
    if (!isOptionalNumber(value.editSweepPage)) return null;
    if (!isOptionalString(value.lastAthleteRefreshAt)) return null;
    if (value.enrichTier !== undefined) {
      if (typeof value.enrichTier !== "string" || !TIERS.has(value.enrichTier)) return null;
    }
    return value as unknown as StravaActivitiesCursor;
  },

  /**
   * A runaway guard, not a capacity limit.
   *
   * `snapshotIds` is the one field that grows with the corpus: a
   * `snapshot-rewalk` accumulates every activity id it has walked across the
   * pass's pages, cleared only when the rewalk completes. Even an athlete
   * with decades of daily activity tops out in the tens of thousands, so this
   * ceiling is set for a rewalk that stopped clearing — a pagination bug that
   * never reaches a short page — rather than for a plausible corpus.
   */
  maxBytes: 4 * 1024 * 1024,

  /**
   * See the module comment: a lost cursor here does not cost a re-walk, it
   * costs re-enriching the account's entire activity history through four
   * quota-metered tiers. Spending that silently, with no signal beyond "sync
   * is slow again", is worse than parking the source until the bookmark is
   * restored or the source is deliberately resynced.
   */
  onUnreadable: "stop",
};
