// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Snapshot-state primitives shared by `pages.ts` and `databases.ts`.
 *
 * Both Notion sources rely on a periodic snapshot rewalk to catch deletions
 * — Notion's search/query APIs simply stop returning archived/trashed rows,
 * so the only way to detect a deletion is to enumerate the live set and
 * diff against the gateway's record. The cadence and the cursor-shape mixin
 * are identical between the two sources; this module is the single source
 * of truth.
 */

/**
 * Safety margin subtracted from a `last_edited_time` watermark before it's
 * passed back to Notion's API. `last_edited_time` is minute-granular: a row
 * edited at 12:30:45 is stored as 12:30:00, so an exact-match filter would
 * miss edits that landed in the same minute as the previous sync's
 * watermark.
 */
export const INCREMENTAL_MARGIN_MS = 2 * 60 * 1000;

/**
 * Cadence for snapshot reconciliation. Once per 24h each Notion source
 * walks its full search/query result set without the incremental cutoff
 * and emits `presentExternalIds` so the gateway can prune deletions. At
 * thousands of pages the snapshot is ~30s of API calls — daily is the
 * balance between freshness and rate budget.
 */
export const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Cursor shape mixin for sources that ride the snapshot cadence. Both
 * `NotionPagesCursor` and `NotionDatabasesCursor` extend this.
 */
export interface SnapshotState {
  /** Already mid-snapshot — keep walking until completion. */
  snapshotMode?: boolean;
  /** Accumulated externalIds seen in the in-flight snapshot. */
  snapshotIds?: string[];
  /** ISO timestamp of the last snapshot completion. */
  lastSnapshotAt?: string;
}

/**
 * Decide whether the current sync cycle should enter snapshot-rewalk mode.
 *
 * - Already mid-snapshot ⇒ stay in snapshot mode.
 * - No prior snapshot recorded ⇒ bootstrap doubles as the first snapshot.
 * - Otherwise ⇒ enter snapshot mode if `SNAPSHOT_INTERVAL_MS` has elapsed.
 */
export function shouldEnterSnapshotMode(
  cursor: SnapshotState | null | undefined,
  now: () => number = Date.now,
): boolean {
  if (cursor?.snapshotMode) return true;
  if (!cursor?.lastSnapshotAt) return true;
  const elapsedMs = now() - new Date(cursor.lastSnapshotAt).getTime();
  return elapsedMs >= SNAPSHOT_INTERVAL_MS;
}

/**
 * Accumulate the snapshot ID set across pages of a snapshot run. Returns
 * `undefined` when not in snapshot mode (callers preserve the previous
 * cursor's `snapshotIds` when they're outside a rewalk).
 */
export function accumulateSnapshotIds(
  previous: ReadonlyArray<string> | undefined,
  thisPage: ReadonlyArray<string>,
  snapshotMode: boolean,
): string[] | undefined {
  if (!snapshotMode) return undefined;
  return [...(previous ?? []), ...thisPage];
}

/**
 * Truncate an ISO timestamp to the minute boundary.
 *
 * `last_edited_time` from Notion is minute-granular (a row edited at
 * 12:30:45 is stored as 12:30:00). When we persist the cycle's max
 * `last_edited_time` as the next cursor, the in-memory value carries
 * sub-minute precision from `Date.toISOString()`. Subtracting the 2-minute
 * margin from a 12:30:45 watermark yields 12:28:45, which is fine — but a
 * row edited at 12:30:30 that persisted as 12:30:00 ends up compared with
 * the slightly different floor on the *next* cycle. Truncating before we
 * persist keeps the comparison consistent across cycles regardless of the
 * sub-minute slop in the in-memory representation.
 */
export function truncateIsoToMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setSeconds(0, 0);
  return d.toISOString();
}
