// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each Apple source persists between runs.
 *
 * Every store here is a local Core Data / SQLite database the OS itself
 * maintains as the user's actual content — Notes, Contacts, Reminders,
 * Calendar, Call History and Voicemail are kept until the user (or another
 * synced device) deletes them, not rotated out by the OS on a schedule. A
 * discarded cursor therefore costs a re-read of that same store, not a gap
 * upstream can no longer fill: `onUnreadable: "rebootstrap"` (the default)
 * is correct for all seven.
 *
 * That re-read is also safe rather than merely cheap, because six of the
 * seven sources already reconcile their document set against the store's
 * current contents on every settled cycle — five via a corpus-wide
 * `presentExternalIds` snapshot (Notes, Contacts, Calendar, Call Log,
 * iMessage), one by reading a delete flag the OS itself writes on the row
 * (Reminders' `ZMARKEDFORDELETION`) — and Voicemail re-derives its entire
 * output from a full table read on every cycle regardless of cursor. None of
 * the seven trusts an accumulated cursor to be the only record of what
 * should still exist, so a forced rebootstrap reproduces exactly what a
 * normal cycle would already converge on, just in one pass instead of many.
 *
 * None of the seven cursor shapes has changed since it was introduced. Every
 * field this file has ever added was optional from the start — a composite
 * pagination tie-breaker, a pinned queue total, a snapshot signature — and
 * each source's own cursor validator already tolerates its absence, so there
 * is nothing for a `migrate` step to do. `version` stays at 1 for all seven.
 */

import { isAppleIMessageSyncCursor, type AppleIMessageSyncCursor } from "./imessage-types.js";
import {
  isAppleNotesSyncCursor,
  isAppleContactsSyncCursor,
  isAppleRemindersSyncCursor,
  isAppleCalendarSyncCursor,
  isAppleCallLogSyncCursor,
  isAppleVoicemailSyncCursor,
  type AppleNotesSyncCursor,
  type AppleContactsSyncCursor,
  type AppleRemindersSyncCursor,
  type AppleCalendarSyncCursor,
  type AppleCallLogSyncCursor,
  type AppleVoicemailSyncCursor,
} from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";

export const appleNotesStateSpec: SourceStateSpec<AppleNotesSyncCursor> = {
  version: 1,
  // The validator already accepts every field this source's `sync` can leave
  // out of a page — `lastModifiedPk`, `cycleQueueTotal` and
  // `lastSnapshotSignature` are all optional, so a mid-cycle page (which
  // omits whichever of these it has no value for yet) decodes the same as a
  // settled one.
  decode: (value) => (isAppleNotesSyncCursor(value) ? value : null),
  // A note carries its own delete flag (`markedForDeletion`), and the
  // corpus-wide `presentExternalIds` snapshot catches the rest. A rebootstrap
  // re-reads every note and re-derives both, so it costs a full vault-sized
  // read rather than an unrecoverable gap.
  onUnreadable: "rebootstrap",
};

export const appleContactsStateSpec: SourceStateSpec<AppleContactsSyncCursor> = {
  version: 1,
  decode: (value) => (isAppleContactsSyncCursor(value) ? value : null),
  onUnreadable: "rebootstrap",
};

export const appleRemindersStateSpec: SourceStateSpec<AppleRemindersSyncCursor> = {
  version: 1,
  decode: (value) => (isAppleRemindersSyncCursor(value) ? value : null),
  // Reminders has no corpus-wide snapshot at all — deletion rides entirely on
  // `ZMARKEDFORDELETION`, a flag the store sets on the row itself. A
  // rebootstrap re-reads every row (not just those modified since the lost
  // cursor) and so sees every flag currently set, which is strictly more
  // complete than an incremental catch-up would have been.
  onUnreadable: "rebootstrap",
};

export const appleCalendarStateSpec: SourceStateSpec<AppleCalendarSyncCursor> = {
  version: 1,
  decode: (value) => (isAppleCalendarSyncCursor(value) ? value : null),
  onUnreadable: "rebootstrap",
};

export const appleCallLogStateSpec: SourceStateSpec<AppleCallLogSyncCursor> = {
  version: 1,
  decode: (value) => (isAppleCallLogSyncCursor(value) ? value : null),
  /**
   * A runaway guard, not a capacity limit.
   *
   * Legacy `affectedDates` cursors may contain a cycle's day list. New
   * cursors retain only watermarks, a content signature and one day key;
   * history growth no longer grows the cursor. Keep the legacy ceiling so
   * a valid in-flight cursor can finish its canonical reconciliation.
   */
  maxBytes: 2 * 1024 * 1024,
  onUnreadable: "rebootstrap",
};

export const appleVoicemailStateSpec: SourceStateSpec<AppleVoicemailSyncCursor> = {
  version: 1,
  decode: (value) => (isAppleVoicemailSyncCursor(value) ? value : null),
  /**
   * A runaway guard, not a capacity limit.
   *
   * `daySignatures` holds one content-hash entry per calendar day that has
   * ever had a voicemail. Unlike call-log's fixed-size reconciliation key,
   * it grows for the life of the install. The
   * ceiling sits well above what even decades of daily voicemail would
   * produce, so tripping it means an entry stopped being a per-day
   * signature and started being something larger.
   */
  maxBytes: 8 * 1024 * 1024,
  /**
   * This source has no incremental watermark to lose: every sync re-reads
   * the whole voicemail table and recomputes `daySignatures` and
   * `presentExternalIds` from that full read, cursor or no cursor. An
   * unreadable cursor only costs re-emitting day documents whose content
   * did not actually change — the same documents a normal cycle would
   * already converge on.
   */
  onUnreadable: "rebootstrap",
};

export const appleImessageStateSpec: SourceStateSpec<AppleIMessageSyncCursor> = {
  version: 1,
  decode: (value) => (isAppleIMessageSyncCursor(value) ? value : null),
  /**
   * A runaway guard, not a capacity limit.
   *
   * `lastDaySignatures` holds one entry per `chatIdentifier:date` pair ever
   * seen, and is never cleared — a heavy multi-thread account can carry far
   * more of these than `apple-call-log` or `apple-voicemail` carry of their
   * own per-day entries, so the ceiling is set higher to match. Tripping it
   * means the map stopped being one signature per chat-day, not that the
   * conversation history grew.
   */
  maxBytes: 32 * 1024 * 1024,
  /**
   * chat.db is re-read from ROWID 0 on a lost cursor, and the corpus-wide
   * day-key snapshot this source already builds on every settled cycle
   * reconciles the result against what iMessage currently holds — the same
   * reconciliation a normal cycle performs whenever its cheap signature
   * check detects a change. A rebootstrap costs a full re-scan of chat.db,
   * not a gap nothing will notice.
   */
  onUnreadable: "rebootstrap",
};
