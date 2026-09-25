// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each Outlook/Microsoft Graph source persists between runs.
 *
 * All three sources fall back to a fresh bootstrap the moment Graph tells
 * them their delta token has expired (410 Gone) — that recovery path lives
 * in each source's own `sync` and is independent of this declaration. A
 * stored value this build cannot parse at all takes the same bootstrap path,
 * which is the right answer here too: Graph doesn't purge mail, calendar
 * events or files on its own, so a bootstrap never loses data. Declaring the
 * shape here doesn't change that answer — it means the fallback happens by
 * the host naming the value unreadable rather than by a source's own decode
 * silently treating an unfamiliar shape as a familiar one.
 */

import { isOutlookEmailCursor } from "./outlook-types.js";
import { isOutlookCalendarCursor } from "./outlook-calendar-types.js";
import { isOneDriveCursor } from "./onedrive-types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { OutlookEmailCursor } from "./outlook-types.js";
import type { OutlookCalendarCursor } from "./outlook-calendar-types.js";
import type { OneDriveCursor } from "./onedrive-types.js";

/**
 * `folderDeltas` is bounded by the account's folder count. `backfillIds` is
 * not: bootstrap pass 1 lists every message's headers, queues every id it
 * finds for pass 2's body fetch, and drains that queue over many `sync()`
 * calls — so for the span of one bootstrap, the cursor holds an id per
 * message in the mailbox rather than per page.
 */
export const outlookEmailStateSpec: SourceStateSpec<OutlookEmailCursor> = {
  version: 1,

  decode(value: unknown): OutlookEmailCursor | null {
    return isOutlookEmailCursor(value) ? value : null;
  },

  /**
   * A runaway guard, not a capacity limit. Sized well above what even a very
   * large personal mailbox queues during one bootstrap, so tripping it means
   * the backfill queue stopped draining rather than that the mailbox grew.
   */
  maxBytes: 64 * 1024 * 1024,

  /**
   * Graph never discards a message on its own, so a discarded cursor costs
   * one full mailbox bootstrap (header list, then body backfill) and loses
   * nothing.
   */
  onUnreadable: "rebootstrap",
};

/**
 * `calendarLinks`, `pendingCalendars` and `snapshotCalendars` are bounded by
 * the account's calendar count. The enumeration's `snapshot` ledger and
 * `enumeratedMasters` are not: both accumulate one entry per event
 * (respectively per recurring series) found during a full bounded-window
 * reconciliation, cleared only when that reconciliation completes.
 *
 * `decode` already refuses the single-calendar cursor shape a build before
 * per-calendar delta links existed would have written — its events are keyed
 * on the bare Graph event id, which nothing this source emits still matches
 * — so that shape reads as unreadable rather than as a value to migrate. There
 * is no way to carry it forward: resuming from it would leave those old
 * documents unreconciled, and the fresh cycle's whole-source snapshot is what
 * retires them.
 */
export const outlookCalendarStateSpec: SourceStateSpec<OutlookCalendarCursor> = {
  version: 2,

  legacyVersion(value: unknown): number | null {
    if (!isOutlookCalendarCursor(value)) return null;
    return value.snapshot !== undefined || value.snapshotCalendars !== undefined ? 2 : 1;
  },

  migrate: {
    1: (prior: unknown): OutlookCalendarCursor | null => {
      if (!isOutlookCalendarCursor(prior)) return null;
      const { snapshotPresentIds, enumeratedMasters, ...state } = prior;
      // A flat partial snapshot cannot establish per-calendar completeness.
      // Finish its delta page queue, then promptly enumerate again while
      // retaining the original window's past edge and all delta bookmarks.
      return snapshotPresentIds === undefined
        ? { ...state, ...(enumeratedMasters ? { enumeratedMasters } : {}) }
        : { ...state, windowRefreshAfter: "1970-01-01T00:00:00.000Z" };
    },
  },

  decode(value: unknown): OutlookCalendarCursor | null {
    return isOutlookCalendarCursor(value) ? value : null;
  },

  /**
   * A runaway guard, not a capacity limit. Sized well above what even a
   * heavily double-booked account produces across every calendar in one
   * bounded ~2-year occurrence window, so tripping it means a reconciliation
   * stopped completing rather than that the window grew.
   */
  maxBytes: 64 * 1024 * 1024,

  /**
   * Graph keeps calendar events until the owner deletes them, and the source
   * enumerates only a bounded window, so a discarded cursor costs one bounded
   * re-walk and loses nothing.
   */
  onUnreadable: "rebootstrap",
};

/**
 * `seen` is a content fingerprint per file, bounded by the drive's file
 * count rather than by page — it exists precisely so a bounded re-walk on
 * delta-token expiry can skip re-downloading content for files that haven't
 * changed. `rewalk.seen`/`rewalk.deleted` accumulate the same way while one
 * such re-walk is in progress.
 *
 * Losing the map entirely costs no more than a first-ever sync: `phase`
 * resets to `bootstrap`, so metadata is re-enumerated **and** every file's
 * content is re-downloaded and re-extracted, since there is no fingerprint
 * to diff against. That is the definition of a bootstrap, not a worse case
 * of one.
 */
export const oneDriveStateSpec: SourceStateSpec<OneDriveCursor> = {
  version: 1,

  decode(value: unknown): OneDriveCursor | null {
    return isOneDriveCursor(value) ? value : null;
  },

  /**
   * A runaway guard, not a capacity limit. Sized well above what even a
   * large personal drive's fingerprint map costs (a few bytes per file), so
   * tripping it means something stopped pruning rather than that the drive
   * grew.
   */
  maxBytes: 64 * 1024 * 1024,

  /**
   * Graph never discards a file on its own, so a discarded cursor costs one
   * full-content bootstrap — identical to a first sync — and loses nothing.
   */
  onUnreadable: "rebootstrap",
};
