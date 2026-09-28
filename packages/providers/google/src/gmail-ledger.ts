// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the Gmail source last recorded about each message's attachments.
 *
 * Reading an attachment's text can mean OCR, which is slow and shares one
 * backend with everything else. The ledger remembers, per message, what each
 * attachment came to — extracted into a child document, skipped by type or
 * size, no text found, or failed — so a message fetched again (a label
 * changed, a refresh walk after the output changed) reuses those results
 * and extracts only what failed. It also schedules those failures for a
 * bounded number of retries.
 *
 * It is a cache the gateway's cursor vouches for, never a record of truth:
 *
 * - Every row carries the sequence number of the page that wrote it, and the
 *   cursor carries the ledger's id and the sequence of the last page the
 *   gateway committed. Opening the ledger against a cursor drops rows newer
 *   than that page, so an attachment whose child document never reached the
 *   gateway is extracted again rather than assumed present.
 * - A cursor naming another ledger (another collector wrote it, or the
 *   gateway reset the source) drops every row. A missing ledger costs
 *   re-extraction, nothing more.
 *
 * No message text is kept — only attachment names, types, sizes and outcomes.
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "@omnesis/core";
import type { AttachmentInfo } from "@omnesis/core";

const log = createLogger("source:gmail").child("ledger");

/** Bumped when what an attachment outcome means changes; older rows are ignored. */
const LEDGER_SCHEMA = "1";

/** One attachment as last emitted: the id its child document is keyed by, and its marker. */
export interface LedgerAttachment {
  stableId: string;
  info: AttachmentInfo;
}

export interface LedgerEntry {
  attachments: LedgerAttachment[];
  /** When the message is due to be fetched again for its failed attachments; null when nothing is owed. */
  retryAt: number | null;
  /** Retries made so far for the failures still outstanding. */
  attempts: number;
}

/** The ledger position a cursor vouches for. */
export interface LedgerMark {
  id: string;
  seq: number;
}

export class GmailLedger {
  private constructor(
    private readonly db: DatabaseSync,
    readonly id: string,
  ) {}

  /** Open (or create) the ledger at `path`; null when it cannot be opened, which only costs re-extraction. */
  static open(path: string): GmailLedger | null {
    try {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      db.exec(
        `CREATE TABLE IF NOT EXISTS messages (
           id TEXT PRIMARY KEY,
           attachments TEXT NOT NULL,
           retry_at INTEGER,
           attempts INTEGER NOT NULL,
           seq INTEGER NOT NULL
         )`,
      );
      db.exec(`CREATE INDEX IF NOT EXISTS messages_retry ON messages(retry_at)`);
      const read = (key: string) =>
        (
          db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
            | { value: string }
            | undefined
        )?.value;
      let id = read("id");
      if (read("schema") !== LEDGER_SCHEMA || !id) {
        db.exec("DELETE FROM messages");
        id = randomUUID();
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(
          LEDGER_SCHEMA,
        );
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('id', ?)").run(id);
      }
      return new GmailLedger(db, id);
    } catch (err) {
      log.warn(
        `Cannot open the attachment ledger, attachments will be extracted every time: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Keep only what the cursor's page vouches for. Returns the sequence the
   * next page writes under.
   */
  align(mark: LedgerMark | undefined): number {
    if (!mark || mark.id !== this.id) {
      this.db.exec("DELETE FROM messages");
      return 1;
    }
    this.db.prepare("DELETE FROM messages WHERE seq > ?").run(mark.seq);
    return mark.seq + 1;
  }

  get(messageId: string): LedgerEntry | undefined {
    const row = this.db
      .prepare("SELECT attachments, retry_at, attempts FROM messages WHERE id = ?")
      .get(messageId) as
      | { attachments: string; retry_at: number | null; attempts: number }
      | undefined;
    if (!row) return undefined;
    return {
      attachments: JSON.parse(row.attachments) as LedgerAttachment[],
      retryAt: row.retry_at,
      attempts: row.attempts,
    };
  }

  /** Record a message's attachments as emitted by the page `seq`; a message with none is forgotten. */
  put(messageId: string, entry: LedgerEntry, seq: number): void {
    if (entry.attachments.length === 0) {
      this.forget([messageId]);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO messages (id, attachments, retry_at, attempts, seq) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET attachments = excluded.attachments,
           retry_at = excluded.retry_at, attempts = excluded.attempts, seq = excluded.seq`,
      )
      .run(messageId, JSON.stringify(entry.attachments), entry.retryAt, entry.attempts, seq);
  }

  forget(messageIds: readonly string[]): void {
    const del = this.db.prepare("DELETE FROM messages WHERE id = ?");
    for (const id of messageIds) del.run(id);
  }

  /** Messages whose retry is due, soonest first. */
  due(now: number, limit: number): string[] {
    return (
      this.db
        .prepare(
          "SELECT id FROM messages WHERE retry_at IS NOT NULL AND retry_at <= ? ORDER BY retry_at LIMIT ?",
        )
        .all(now, limit) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  close(): void {
    this.db.close();
  }
}
