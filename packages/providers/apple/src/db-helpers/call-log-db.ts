// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Lazy-open helper for the iCloud-synced call-history database
 * (`CallHistory.storedata`). Lifecycle and failure recording come from
 * `SingleFileAppleDb`; the Call Log source raises a recorded failure as its
 * own sync error. Unlike Notes/Reminders, this DB requires no decryption or
 * keychain access — it's a plain readable SQLite file (verified empirically
 * on macOS 26.3.1) behind the Full Disk Access grant that covers
 * `~/Library/Application Support`.
 */

import { createLogger } from "@omnesis/core";
import { SingleFileAppleDb } from "./single-file-db.js";
import { fullDiskAccessDenial } from "./internal.js";

const log = createLogger("provider:apple:call-log-db");

/**
 * Definition of an indexable call row, shared by every query the source
 * runs (page, count, snapshot signature, snapshot enumeration) and this
 * helper's `count()` — a single constant so they can never disagree.
 * `ZUNIQUE_ID` is required as the externalId for the analytics table.
 */
export const CALL_LOG_FILTER = `ZUNIQUE_ID IS NOT NULL AND ZUNIQUE_ID != ''`;

export class CallLogDbHelper extends SingleFileAppleDb {
  constructor(path: string) {
    super(path, "Apple Call Log", fullDiskAccessDenial(), log);
  }

  /** Best-effort indexable-call count — returns 0 on any error. */
  count(): number {
    try {
      if (!this.db) return 0;
      const result = this.db
        .prepare(`SELECT COUNT(*) as count FROM ZCALLRECORD WHERE ${CALL_LOG_FILTER}`)
        .get() as { count: number };
      return result.count;
    } catch {
      return 0;
    }
  }
}
