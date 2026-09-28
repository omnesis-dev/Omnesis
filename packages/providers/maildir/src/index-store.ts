// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The source's local index of a Maildir tree.
 *
 * A mailbox can hold hundreds of thousands of messages, and knowing what each
 * file is — which message it holds, when that message was sent — means opening
 * it. The index remembers that per file, so a cycle opens only files it has
 * not seen before. It also remembers what each message was last emitted as, so
 * a cycle re-emits only messages whose folders or flags changed.
 *
 * Two tables with two different kinds of truth:
 *
 * - `files` describes the disk. It is derived from file contents alone, so it
 *   is valid whatever the gateway holds, and survives a resync.
 * - `emitted` describes what the gateway was sent. It is valid only together
 *   with the cursor the gateway stored: every row carries the `seq` of the page
 *   that emitted it, and the cursor carries the `seq` of the last page the
 *   gateway committed. Opening the index against a cursor undoes every row
 *   newer than it — rows from a page the gateway never committed — so a
 *   failed page is re-emitted rather than forgotten. A row re-emitted by that
 *   page goes back to the version the gateway did commit, which each row keeps
 *   beside its current one; a row the page added is dropped. A cursor from
 *   another generation (a resync, or a different collector) drops all of them.
 *
 * No message text is kept. Keys are hashes; folder and file names are the ones
 * already on disk beside it; the rest is dates, flags and, for each attachment,
 * its name, type, size and whether its text was extracted.
 */

import { DatabaseSync } from "node:sqlite";
import { SyncError } from "@omnesis/types";
import type { AttachmentInfo } from "@omnesis/core";

export interface FileRow {
  mailboxId: string;
  uniq: string;
  relPath: string;
  flags: string;
  /** Null until the file's headers have been read. */
  key: string | null;
  dateMs: number | null;
}

/**
 * An attachment as it was emitted: its child-id suffix, and the marker the
 * message's document carries for it — which says whether a child document
 * was made.
 */
export interface EmittedAttachment {
  stableId: string;
  info: AttachmentInfo;
}

export interface EmittedRow {
  key: string;
  /** Everything that decides the emitted documents: output, settings, folders and flags. */
  signature: string;
  /** The part of the signature that decides attachment documents: output and settings. */
  contentFingerprint: string;
  seq: number;
  attachments: EmittedAttachment[];
}

const SCHEMA_VERSION = "3";

export class MaildirIndex {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    const version = this.meta("schema");
    if (version !== undefined && version !== SCHEMA_VERSION) {
      // Everything here can be rebuilt from the disk and the cursor, so an
      // index written in another shape is discarded rather than migrated.
      this.db.exec("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS emitted; DELETE FROM meta;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        mailbox_id TEXT NOT NULL,
        uniq TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        flags TEXT NOT NULL,
        key TEXT,
        date_ms INTEGER,
        PRIMARY KEY (mailbox_id, uniq)
      );
      CREATE INDEX IF NOT EXISTS files_key ON files(key);
      CREATE TABLE IF NOT EXISTS emitted (
        key TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        seq INTEGER NOT NULL,
        attachments TEXT NOT NULL,
        prev_signature TEXT,
        prev_content_fingerprint TEXT,
        prev_seq INTEGER,
        prev_attachments TEXT
      );
    `);
    this.setMeta("schema", SCHEMA_VERSION);
  }

  close(): void {
    this.db.close();
  }

  private meta(key: string): string | undefined {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(key) as
      | { v: string }
      | undefined;
    return row?.v;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(key, value);
  }

  get generation(): string | undefined {
    return this.meta("generation");
  }

  /**
   * Align the emission record with the cursor the gateway holds.
   *
   * A different generation clears it; the same generation drops only what
   * pages after `committedSeq` wrote.
   */
  alignWithCursor(generation: string, committedSeq: number): void {
    this.transaction(() => {
      if (this.generation !== generation) {
        this.db.exec("DELETE FROM emitted");
        this.setMeta("generation", generation);
      } else {
        this.db
          .prepare(
            `UPDATE emitted SET signature = prev_signature,
               content_fingerprint = prev_content_fingerprint, seq = prev_seq,
               attachments = prev_attachments, prev_signature = NULL,
               prev_content_fingerprint = NULL, prev_seq = NULL, prev_attachments = NULL
             WHERE seq > ? AND prev_seq IS NOT NULL AND prev_seq <= ?`,
          )
          .run(committedSeq, committedSeq);
        this.db.prepare("DELETE FROM emitted WHERE seq > ?").run(committedSeq);
      }
    });
  }

  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  allFiles(): FileRow[] {
    return this.selectFiles(false);
  }

  private selectFiles(unscannedOnly: boolean): FileRow[] {
    return (
      this.db
        .prepare(
          `SELECT mailbox_id, uniq, rel_path, flags, key, date_ms FROM files${unscannedOnly ? " WHERE key IS NULL" : ""}`,
        )
        .all() as Array<{
        mailbox_id: string;
        uniq: string;
        rel_path: string;
        flags: string;
        key: string | null;
        date_ms: number | null;
      }>
    ).map((row) => ({
      mailboxId: row.mailbox_id,
      uniq: row.uniq,
      relPath: row.rel_path,
      flags: row.flags,
      key: row.key,
      dateMs: row.date_ms,
    }));
  }

  /** Files whose headers have not been read yet. */
  unscannedFiles(): FileRow[] {
    return this.selectFiles(true);
  }

  /** Apply a listing's differences: files that appeared, moved or changed flags, and files that went. */
  applyListing(
    upserts: Array<{ mailboxId: string; uniq: string; relPath: string; flags: string }>,
    removals: Array<{ mailboxId: string; uniq: string }>,
  ): void {
    if (upserts.length === 0 && removals.length === 0) return;
    const upsert = this.db.prepare(`
      INSERT INTO files (mailbox_id, uniq, rel_path, flags) VALUES (?, ?, ?, ?)
      ON CONFLICT(mailbox_id, uniq) DO UPDATE SET rel_path = excluded.rel_path, flags = excluded.flags
    `);
    const remove = this.db.prepare("DELETE FROM files WHERE mailbox_id = ? AND uniq = ?");
    this.transaction(() => {
      for (const file of upserts) upsert.run(file.mailboxId, file.uniq, file.relPath, file.flags);
      for (const file of removals) remove.run(file.mailboxId, file.uniq);
    });
  }

  recordScans(
    scans: Array<{ mailboxId: string; uniq: string; key: string; dateMs: number }>,
  ): void {
    if (scans.length === 0) return;
    const update = this.db.prepare(
      "UPDATE files SET key = ?, date_ms = ? WHERE mailbox_id = ? AND uniq = ?",
    );
    this.transaction(() => {
      for (const scan of scans) update.run(scan.key, scan.dateMs, scan.mailboxId, scan.uniq);
    });
  }

  allEmitted(): Map<string, EmittedRow> {
    const rows = this.db
      .prepare("SELECT key, signature, content_fingerprint, seq, attachments FROM emitted")
      .all() as Array<{
      key: string;
      signature: string;
      content_fingerprint: string;
      seq: number;
      attachments: string;
    }>;
    return new Map(
      rows.map((row) => [
        row.key,
        {
          key: row.key,
          signature: row.signature,
          contentFingerprint: row.content_fingerprint,
          seq: row.seq,
          attachments: JSON.parse(row.attachments) as EmittedAttachment[],
        },
      ]),
    );
  }

  /**
   * Record one page's emissions, and forget messages no longer on disk.
   *
   * Refuses when another generation has taken the index since the page began:
   * that is a resync that started over while this page was being built, and
   * its rows would claim messages the new generation has not sent.
   */
  recordEmissions(generation: string, rows: EmittedRow[], forget: string[]): void {
    // The version being replaced is kept, so an uncommitted page can be undone
    // back to it (see `alignWithCursor`).
    const upsert = this.db.prepare(`
      INSERT INTO emitted (key, signature, content_fingerprint, seq, attachments)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        prev_signature = emitted.signature,
        prev_content_fingerprint = emitted.content_fingerprint,
        prev_seq = emitted.seq, prev_attachments = emitted.attachments,
        signature = excluded.signature, content_fingerprint = excluded.content_fingerprint,
        seq = excluded.seq, attachments = excluded.attachments
    `);
    const remove = this.db.prepare("DELETE FROM emitted WHERE key = ?");
    this.transaction(() => {
      if (this.generation !== generation) {
        throw new SyncError(
          "transient",
          "The Maildir index was restarted while this page was being built",
        );
      }
      for (const row of rows) {
        upsert.run(
          row.key,
          row.signature,
          row.contentFingerprint,
          row.seq,
          JSON.stringify(row.attachments),
        );
      }
      for (const key of forget) remove.run(key);
    });
  }
}
