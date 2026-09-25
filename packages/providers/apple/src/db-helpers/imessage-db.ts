// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Lazy-open helper for the iMessage `chat.db`. Messages writes on every
 * send and receive, so SQLITE_BUSY here is routine and stays retryable;
 * a denial is recorded for the iMessage source to raise as a permission
 * error. Both are handled by `SingleFileAppleDb`.
 *
 * What is specific to iMessage is the file identity: Messages replaces
 * `chat.db` outright (a restore, a re-download), and a handle held onto the
 * replaced inode reads a database nobody is writing to any more.
 */

import { statSync } from "node:fs";
import { createLogger } from "@omnesis/core";
import { SingleFileAppleDb } from "./single-file-db.js";
import { fullDiskAccessDenial, type Db } from "./internal.js";

const log = createLogger("provider:apple:imessage-db");

interface FileIdentity {
  dev: number;
  ino: number;
}

export class IMessageDbHelper extends SingleFileAppleDb {
  private openedIdentity: FileIdentity | null = null;

  constructor(path: string) {
    super(path, "iMessage", fullDiskAccessDenial(), log);
  }

  override open(): void {
    super.open();
    if (this.db && !this.openedIdentity) this.openedIdentity = readFileIdentity(this.path);
  }

  /**
   * Get the DB, reopening it first if the file it was opened from has been
   * replaced.
   */
  override getDb(): Db | null {
    if (this.db && this.openedIdentity) {
      const current = readFileIdentity(this.path);
      if (current && !sameIdentity(current, this.openedIdentity)) {
        log.warn("iMessage database file identity changed — reopening chat.db");
        this.close();
      }
    }
    if (!this.db) this.open();
    return this.db;
  }

  override close(): void {
    super.close();
    this.openedIdentity = null;
  }

  /** Best-effort message count — returns 0 on any error. */
  count(): number {
    try {
      if (!this.db) return 0;
      const result = this.db.prepare("SELECT COUNT(*) as count FROM message").get() as {
        count: number;
      };
      return result.count;
    } catch {
      return 0;
    }
  }
}

function readFileIdentity(path: string): FileIdentity | null {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
