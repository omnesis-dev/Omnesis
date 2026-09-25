// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each Notion source persists between runs.
 *
 * Neither cursor carries a `version` field of its own, and no branch in `sync`
 * recognises an older layout — the envelope's version is what routes a stored
 * value, and the databases cursor is the only one that has needed a migration.
 *
 * `DatabaseMeta.dataSourceId` (the Notion API v5 data-source id) looks like
 * the kind of field that would need one: it was added after the id-only
 * shape shipped. It doesn't, because nothing here treats its absence as a
 * signal — `getDatabase`/`queryDatabase` resolve a missing `dataSourceId`
 * from `id` on demand, and the next discovery cycle re-populates it from a
 * fresh search result regardless. An old `DatabaseMeta` entry is simply
 * handled, not migrated.
 */

import { isNotionPagesCursor, isNotionDatabasesCursor } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { NotionPagesCursor, NotionDatabasesCursor } from "./types.js";

/**
 * `lastEditedTime`/`startCursor` are fixed-size watermarks. `snapshotIds` is
 * not: it accumulates one page id per page found during the daily full
 * re-walk (`SNAPSHOT_INTERVAL_MS` in `snapshot-state.ts`) and is only cleared
 * when that re-walk completes, so its size tracks the whole workspace's page
 * count rather than one page of results.
 */
export const notionPagesStateSpec: SourceStateSpec<NotionPagesCursor> = {
  version: 1,

  decode(value: unknown): NotionPagesCursor | null {
    return isNotionPagesCursor(value) ? value : null;
  },

  /**
   * A runaway guard, not a capacity limit. Sized well above what even a
   * large personal workspace enumerates in one daily re-walk, so tripping it
   * means the re-walk stopped completing rather than that the workspace grew.
   */
  maxBytes: 32 * 1024 * 1024,

  /**
   * Notion's search API always re-lists every reachable page, so a discarded
   * cursor costs one full re-walk (which the source treats as this cycle's
   * snapshot too) and loses nothing.
   */
  onUnreadable: "rebootstrap",
};

/**
 * `databases`, `skippedDbs` and `summaryHashes` are trimmed to the live
 * database set on every discovery pass, so they track the workspace's
 * current database count rather than growing across renames or deletions.
 * The rewalk's `snapshot` ledger, `snapshotRowIdsByTable` and
 * `lastSnapshotRowIdsByTable` are not trimmed the same way while a rewalk is
 * in flight: they accumulate one entry per row across every database in the
 * workspace, cleared (or rolled into the next baseline) only when that rewalk
 * completes. Missing database IDs and empty table baselines remain so
 * repeated absence claims can reach the gateway's corroboration deadline;
 * reappearance removes the missing marker. They hold names, not retired row
 * lists, and remain subject to the state byte limit.
 */
export const notionDatabasesStateSpec: SourceStateSpec<NotionDatabasesCursor> = {
  version: 2,

  decode(value: unknown): NotionDatabasesCursor | null {
    return isNotionDatabasesCursor(value) ? value : null;
  },

  migrate: {
    /**
     * Version 1 accumulated a rewalk's external ids in one workspace-wide
     * `snapshotIds` list, with no record of which database each came from.
     * Version 2 keeps a `SnapshotLedger` instead, because that attribution is
     * what lets a rewalk that could not read one database still vouch for the
     * rest.
     *
     * A list that no longer says where its ids came from cannot be split back
     * up, so a rewalk caught mid-flight by an upgrade is ended rather than
     * resumed: the next cycle starts a fresh one, which is the only kind that
     * can vouch for the whole workspace. `lastSnapshotAt` is left as it was —
     * unstamped for the abandoned rewalk — so that next cycle starts
     * immediately rather than waiting out the interval.
     *
     * The page cursor inside the database being walked goes too. Notion issues
     * a `start_cursor` for the query that produced it, and ending the rewalk
     * changes that query: the next call would filter on `last_edited_time`
     * while resuming a cursor minted for an unfiltered walk. Restarting the
     * current database costs one query and removes the question.
     *
     * Everything a rewalk did not own survives: the discovered database list,
     * the incremental watermark, the backoff ladder, the summary hashes and
     * the analytics baseline a completed database already rolled forward.
     */
    1: (prior: unknown): unknown | null => {
      if (!prior || typeof prior !== "object") return null;
      const {
        snapshotIds: _snapshotIds,
        snapshotDirty: _snapshotDirty,
        snapshotRowIdsByTable: _snapshotRowIdsByTable,
        ...rest
      } = prior as Record<string, unknown>;
      if (rest.inSnapshotMode === true) {
        delete rest.dbPageCursor;
        delete rest.emittedSummary;
      }
      return { ...rest, inSnapshotMode: false };
    },
  },

  /**
   * A runaway guard, not a capacity limit. Sized well above what even a
   * large personal workspace's total row count produces across one full
   * rewalk, so tripping it means a rewalk stopped completing rather than
   * that the workspace grew.
   */
  maxBytes: 64 * 1024 * 1024,

  /**
   * Discovery re-lists every database the integration can see and, absent a
   * watermark, queries every row in each — Notion doesn't purge a live
   * database or row on its own, so a discarded cursor costs one full re-walk
   * and loses nothing.
   */
  onUnreadable: "rebootstrap",
};
