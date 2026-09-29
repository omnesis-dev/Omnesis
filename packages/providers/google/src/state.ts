// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each Google source persists between runs, and how an older shape is
 * carried forward.
 *
 * Gmail, Drive and Contacts each hold a fixed-size cursor — a phase tag plus
 * a handful of scalar tokens — that has never changed shape, so their specs
 * are a `decode` and nothing else. Calendar is the exception: see
 * {@link googleCalendarStateSpec}.
 */

import { isGmailSyncCursor } from "./gmail.js";
import { isDriveSyncCursor } from "./drive.js";
import { isContactsSyncCursor } from "./contacts.js";
import { isCalendarSyncCursor } from "./calendar.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { GmailSyncCursor } from "./gmail.js";
import type { DriveSyncCursor } from "./drive.js";
import type { ContactsSyncCursor } from "./contacts.js";
import type { CalendarSyncCursor } from "./calendar.js";

/**
 * Gmail's cursor is a `historyId`/pagination bookmark, never an accumulating
 * structure — nothing here grows with the size of the mailbox.
 *
 * `historyId` expiring (Gmail retains history for about a week) or the whole
 * cursor going unreadable both fall back to the existing bootstrap phase,
 * which walks `messages.list` from scratch. Gmail never discards mail on its
 * own, so that walk is slower, not lossy — a discarded cursor costs one full
 * mailbox re-read, exactly what a first sync costs.
 */
export const gmailStateSpec: SourceStateSpec<GmailSyncCursor> = {
  version: 1,
  decode(value: unknown): GmailSyncCursor | null {
    return isGmailSyncCursor(value) ? value : null;
  },
  onUnreadable: "rebootstrap",
};

/**
 * Drive's cursor is a phase tag plus one pagination or `startPageToken`
 * string — fixed in size regardless of how many files the account holds.
 *
 * A `startPageToken` that Drive has expired (410) already falls back to a
 * fresh `files.list` bootstrap inside `sync`; an unreadable cursor takes the
 * identical path. Drive doesn't purge files on its own, so the cost is a full
 * re-list, not a loss.
 */
export const googleDriveStateSpec: SourceStateSpec<DriveSyncCursor> = {
  version: 1,
  decode(value: unknown): DriveSyncCursor | null {
    return isDriveSyncCursor(value) ? value : null;
  },
  onUnreadable: "rebootstrap",
};

/**
 * Contacts' cursor is a `syncToken`/pagination bookmark plus a per-cycle
 * counter — fixed in size regardless of how many contacts exist.
 *
 * A People API "sync token expired" error already drops the token and
 * re-bootstraps; an unreadable cursor takes the same path. Contacts are not
 * pruned by Google on their own, so re-listing them all costs time, not data.
 */
export const googleContactsStateSpec: SourceStateSpec<ContactsSyncCursor> = {
  version: 1,
  decode(value: unknown): ContactsSyncCursor | null {
    return isContactsSyncCursor(value) ? value : null;
  },
  onUnreadable: "rebootstrap",
};

/** The current shape: every stored cursor states its generation explicitly. */
function isVersionedCalendarCursor(
  value: unknown,
): value is CalendarSyncCursor & { occurrenceExpansion: boolean } {
  return isCalendarSyncCursor(value) && typeof value.occurrenceExpansion === "boolean";
}

/**
 * What google-calendar persists between runs.
 *
 * An account that started syncing before occurrence expansion existed
 * persists a cursor with per-calendar sync tokens and no `occurrenceExpansion`
 * field at all. `sync` must keep such an account on that same non-expanding
 * path forever — re-enumerating it under expansion would restart its bounded
 * window and backfill projections it never asked for — which means the
 * generation a cursor was minted under is a decision made once, not
 * re-derived from which fields happen to be set on every page of every
 * cycle for the life of the install.
 *
 * Declaring the version here is what lets `sync` read that decision straight
 * off the cursor's own `occurrenceExpansion` flag: `migrate` stamps
 * `occurrenceExpansion: false` onto such a cursor exactly once, and every
 * page `sync` writes back afterward — settled or mid-cycle — states the flag
 * explicitly, so there is nothing left to infer.
 */
export const googleCalendarStateSpec: SourceStateSpec<CalendarSyncCursor> = {
  version: 2,

  /** Accepts every cursor a cycle can produce, mid-paginate included, as long as it states its generation. */
  decode(value: unknown): CalendarSyncCursor | null {
    return isVersionedCalendarCursor(value) ? value : null;
  },

  /**
   * A value written before envelopes existed is version 2 if it already
   * carries the boolean flag (a build between expansion landing and envelope
   * support), or version 1 — the hand-rolled shape with per-calendar sync
   * tokens and no flag at all — otherwise.
   */
  legacyVersion(value: unknown): number | null {
    if (!isCalendarSyncCursor(value)) return null;
    return typeof value.occurrenceExpansion === "boolean" ? 2 : 1;
  },

  migrate: {
    /**
     * Token-bearing version-1 cursors retain the parameters that minted their
     * tokens. Snapshot bookkeeping alone does not identify that generation:
     * after a token reset such an account can opt into occurrence expansion.
     */
    1: (prior: unknown): CalendarSyncCursor => {
      const state = prior as CalendarSyncCursor;
      const hasLegacyTokens =
        Object.keys(state.calendarSyncTokens ?? {}).length > 0 ||
        state.pendingCalendars !== undefined ||
        state.resumePageToken !== undefined ||
        state.processedThisCycle !== undefined;
      return { ...state, occurrenceExpansion: !hasLegacyTokens };
    },
  },

  /**
   * A runaway guard, not a capacity limit. `snapshotPresentIds` accumulates
   * one event id per occurrence found during a full bounded-window
   * reconciliation and is only cleared when that reconciliation finishes, so
   * its size tracks a busy account's whole ~2-year occurrence window rather
   * than one page. The ceiling sits well above what even a heavily
   * double-booked account produces in one window, so tripping it means the
   * reconciliation stopped completing rather than that the window grew.
   */
  maxBytes: 64 * 1024 * 1024,

  /**
   * Google keeps calendar events until the owner deletes them, and expansion
   * enumerates only a bounded ~2-year window, so a discarded cursor costs one
   * bounded re-walk of that window and loses nothing.
   */
  onUnreadable: "rebootstrap",
};
