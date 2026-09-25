// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Lazy-open helper for Phone.app's carrier-voicemail store. Lifecycle and
 * failure recording come from `SingleFileAppleDb`; the Voicemail source raises
 * a recorded failure as its own sync error.
 */

import { createLogger } from "@omnesis/core";
import { SingleFileAppleDb } from "./single-file-db.js";
import type { Db } from "./internal.js";

const log = createLogger("provider:apple:voicemail-db");

export const VOICEMAIL_FILTER =
  "ZPROVIDER = 'com.apple.coretelephony' AND ZMAILBOXTYPE = 0 AND ZDATEDELETED IS NULL AND ZRECORDUUID IS NOT NULL";

const REQUIRED_COLUMNS = [
  "Z_PK",
  "ZISREAD",
  "ZMAILBOXTYPE",
  "ZDATECREATED",
  "ZDATEMODIFIED",
  "ZDATEDELETED",
  "ZDURATION",
  "ZFROM",
  "ZPROVIDER",
  "ZRECORDUUID",
  "ZTRANSCRIPTDATA",
] as const;

export class VoicemailDbHelper extends SingleFileAppleDb {
  constructor(path: string) {
    super(
      path,
      "Apple Voicemail",
      // Phone's store is not behind Full Disk Access, so name the binary
      // whose privacy permissions to check without sending the operator to a
      // pane that cannot help them.
      {
        hint: `macOS refused the read. Check the privacy permissions of the binary running the collector (${process.execPath}).`,
      },
      log,
    );
  }

  /**
   * A store whose schema this provider has not been taught is worse than an
   * absent one: every query below would fail deep in the walk. Reject it at
   * the open, naming the columns, so the source reports one legible reason
   * instead of syncing nothing for a reason nobody can see.
   */
  protected override reject(db: Db): string | null {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(ZSTOREDMESSAGE)").all() as Array<{ name?: string }>)
        .map((column) => column.name)
        .filter((name): name is string => name !== undefined),
    );
    const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length === 0) return null;
    return (
      `The Apple Voicemail database has an unsupported schema (missing ${missing.join(", ")}); ` +
      `skipping until the provider is updated.`
    );
  }

  count(): number {
    try {
      return this.db
        ? (
            this.db
              .prepare(`SELECT COUNT(*) AS count FROM ZSTOREDMESSAGE WHERE ${VOICEMAIL_FILTER}`)
              .get() as { count: number }
          ).count
        : 0;
    } catch {
      return 0;
    }
  }
}
