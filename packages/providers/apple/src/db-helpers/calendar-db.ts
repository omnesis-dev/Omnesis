// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Lazy-open helper for the Calendar.app `Calendar.sqlitedb`. Lifecycle and
 * failure recording come from `SingleFileAppleDb`; the Calendar source raises
 * a recorded failure as its own sync error.
 */

import { createLogger } from "@omnesis/core";
import { SingleFileAppleDb } from "./single-file-db.js";
import { fullDiskAccessDenial } from "./internal.js";

const log = createLogger("provider:apple:calendar-db");

// ── Store.type values the source branches on ─────────────────────────

/** Subscribed calendar feeds (holidays, sports fixtures, …). */
export const STORE_TYPE_SUBSCRIBED = 4;
/**
 * Derived calendars — "Found in Mail", "Found in Natural Language",
 * "Birthdays" — duplicating content already indexed from email and
 * contacts sources.
 */
const STORE_TYPE_DERIVED = 5;
/**
 * The store that mirrors scheduled Apple Reminders into the calendar
 * view; indexing it would duplicate the apple-reminders source.
 */
const STORE_TYPE_REMINDERS_MIRROR = 6;

/** FROM clause joining each event row to its calendar and owning store. */
export const CALENDAR_EVENTS_FROM = `FROM CalendarItem ci
      INNER JOIN Calendar c ON c.ROWID = ci.calendar_id
      INNER JOIN Store s ON s.ROWID = c.store_id`;

/**
 * Definition of an indexable event row, shared by every query the source
 * runs (page, count, snapshot signature, snapshot enumeration) and by this
 * helper's `count()` — a single constant so they can never disagree.
 *
 * - `entity_type = 2` — events (the only type observed in Calendar.sqlitedb;
 *   reminders live in their own store under group.com.apple.reminders).
 * - `hidden` — transient soft-delete state; excluded everywhere so a hidden
 *   row drops out of the snapshot and gets deleted via reconciliation.
 * - `UUID` — the externalId; a row without one can't be addressed.
 * - Derived and Reminders-mirror stores are excluded (see the store-type
 *   constants above for why).
 * - `junk_status` and `phantom_master` are deliberately NOT filtered: their
 *   enum semantics are unverified (all rows are 0 in observed databases),
 *   and snapshot reconciliation makes a later filter change self-healing.
 */
export const CALENDAR_EVENTS_FILTER = `ci.entity_type = 2
        AND COALESCE(ci.hidden, 0) = 0
        AND ci.UUID IS NOT NULL AND ci.UUID != ''
        AND s.type NOT IN (${STORE_TYPE_DERIVED}, ${STORE_TYPE_REMINDERS_MIRROR})`;

export class CalendarDbHelper extends SingleFileAppleDb {
  constructor(path: string) {
    super(path, "Apple Calendar", fullDiskAccessDenial(), log);
  }

  /** Best-effort indexable-event count — returns 0 on any error. */
  count(): number {
    try {
      if (!this.db) return 0;
      const result = this.db
        .prepare(`SELECT COUNT(*) as count ${CALENDAR_EVENTS_FROM} WHERE ${CALENDAR_EVENTS_FILTER}`)
        .get() as { count: number };
      return result.count;
    } catch {
      return 0;
    }
  }
}
