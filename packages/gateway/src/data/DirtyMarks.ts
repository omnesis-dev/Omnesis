// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;

/**
 * Shared dirty-mark helpers. Each public export bumps the singleton
 * `dirty_version` counter for the named job in `refresh_meta` so a
 * periodic compute → writer pair invalidates any in-flight snapshot
 * via OCC.
 *
 * Lives in its own module so db.ts (cascade-delete paths) and
 * people.ts / links.ts (mutation paths) can both call it without
 * forming an import cycle on each other.
 *
 * The link_graph job additionally toggles `needs_refresh` — the
 * link-stats reader (`readMaterializedLinkStats`) treats that flag as
 * the trigger for a fresh compute pass even without consulting
 * `last_computed_version`. The other two jobs don't use the flag.
 */

type RefreshJob =
  | "link_graph"
  | "interaction_scores"
  | "merge_rules"
  | "near_dup_df"
  | "people_counts";

function bumpDirtyState(db: Db, job: RefreshJob, withNeedsRefresh: boolean): void {
  // UPSERT — not just UPDATE — so the mark self-heals when the
  // singleton seed row is missing (a power-cut between the CREATE TABLE
  // and the matching seed INSERT would leave the table empty; the
  // older UPDATE would silently no-op and the dirty-version mechanism
  // would never fire). With ON CONFLICT, the first dirty mark after a
  // partial schema setup populates the row with `dirty_version = 1`
  // and proceeds normally.
  const setClause = withNeedsRefresh
    ? "needs_refresh = 1, dirty_version = refresh_meta.dirty_version + 1"
    : "dirty_version = refresh_meta.dirty_version + 1";
  const insertNeedsRefresh = withNeedsRefresh ? 1 : 0;
  db.prepare(
    `INSERT INTO refresh_meta (job, dirty_version, needs_refresh) VALUES (?, 1, ?)
     ON CONFLICT(job) DO UPDATE SET ${setClause}`,
  ).run(job, insertNeedsRefresh);
}

export function markLinkStatsDirty(db: Db): void {
  bumpDirtyState(db, "link_graph", true);
}

/**
 * A change to the people graph.
 *
 * Marks both jobs that read that graph: interaction scores and the
 * per-person document and alias counts. They are dirtied by the same
 * events — a merge, a document resolving to a person, an alias moving —
 * and marking them together is what keeps a gated counts sweep from going
 * stale because one call site remembered scores and forgot counts.
 * Over-marking costs one sweep; under-marking leaves wrong numbers on the
 * People page indefinitely.
 */
export function markPeopleGraphDirty(db: Db): void {
  bumpDirtyState(db, "interaction_scores", false);
  bumpDirtyState(db, "people_counts", false);
}

export function markMergeRulesDirty(db: Db): void {
  bumpDirtyState(db, "merge_rules", false);
}

export function markNearDupDfDirty(db: Db): void {
  bumpDirtyState(db, "near_dup_df", false);
}
