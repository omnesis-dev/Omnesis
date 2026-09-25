// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Durable transcript sidecar for iMessage voice clips.
 *
 * iMessage's `chat.db` is Apple's database — Omnesis reads it strictly
 * read-only, so a transcript can't be written back into it. Whisper
 * transcription is slow (seconds per clip), and the iMessage source re-reads a
 * whole day's messages on every affected sync, so without a cache a busy day
 * would re-transcribe its voice clips on every cycle. This better-sqlite3 store,
 * rooted under the collector's `configDir`, persists each clip's transcript so a
 * second sync reuses it instead of re-calling the transcriber.
 *
 * Keyed by Apple attachment GUID when present, with a file-path fallback for
 * older rows. Stored size and mtime guard against local file replacements:
 * a mismatch is treated as a cache miss. `""` is a valid cached transcript
 * (no speech detected) and is honored, not retried.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { readStorageKeySync, storageEncryptionRequired } from "@omnesis/core";
import { openTranscriptDatabase } from "./imessage-transcript-storage.js";

/** A cached transcript row. */
export interface CachedTranscript {
  transcript: string;
  durationSec?: number;
}

/**
 * SQLite-backed transcript cache. Opens (and creates) a `transcripts.db` under
 * `<configDir>/apple-imessage/`. A `:memory:` database is used when `configDir`
 * is undefined (tests / no durable home) — the cache then lives only for the
 * process, which still de-dupes within a single sync run.
 */
export class IMessageTranscriptCache {
  private db: Database.Database;
  private closeDb?: () => void;
  private getStmt: Database.Statement;
  private setStmt: Database.Statement;

  constructor(configDir?: string) {
    this.db = this.openDb(configDir);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcripts (
        attachment_guid TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ms REAL,
        transcript TEXT NOT NULL,
        duration_sec REAL
      )
    `);
      const columns = this.db.prepare("PRAGMA table_info(transcripts)").all() as { name: string }[];
      if (!columns.some((c) => c.name === "mtime_ms")) {
        this.db.exec("ALTER TABLE transcripts ADD COLUMN mtime_ms REAL");
      }
      this.getStmt = this.db.prepare(
        "SELECT transcript, duration_sec as durationSec, size, mtime_ms as mtimeMs FROM transcripts WHERE attachment_guid = ?",
      );
      this.setStmt = this.db.prepare(
        `INSERT INTO transcripts (attachment_guid, size, mtime_ms, transcript, duration_sec)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(attachment_guid) DO UPDATE SET
         size = excluded.size,
         mtime_ms = excluded.mtime_ms,
         transcript = excluded.transcript,
         duration_sec = excluded.duration_sec`,
      );
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private openDb(configDir?: string): Database.Database {
    if (!configDir) return new Database(":memory:");
    const key = readStorageKeySync("imessage-transcripts", { configDir });
    if (!key && storageEncryptionRequired(configDir)) {
      throw new Error(
        "iMessage transcript encryption key is unavailable; restore the local keyring before syncing",
      );
    }
    try {
      const dir = join(configDir, "apple-imessage");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const opened = openTranscriptDatabase(join(dir, "transcripts.db"), key);
      this.closeDb = opened.close;
      return opened.db;
    } finally {
      key?.fill(0);
    }
  }

  /**
   * Look up a cached transcript by attachment guid/path. Returns undefined on
   * a miss or when the stored size/mtime doesn't match the current file.
   */
  get(attachmentGuid: string, size: number, mtimeMs?: number): CachedTranscript | undefined {
    const row = this.getStmt.get(attachmentGuid) as
      | { transcript: string; durationSec: number | null; size: number; mtimeMs: number | null }
      | undefined;
    if (!row) return undefined;
    if (row.size !== size) return undefined;
    if (mtimeMs !== undefined && row.mtimeMs !== mtimeMs) return undefined;
    return {
      transcript: row.transcript,
      durationSec: row.durationSec ?? undefined,
    };
  }

  /** Persist a transcript for an attachment guid. `""` is a valid value. */
  set(
    attachmentGuid: string,
    size: number,
    mtimeMs: number | undefined,
    value: CachedTranscript,
  ): void {
    this.setStmt.run(
      attachmentGuid,
      size,
      mtimeMs ?? null,
      value.transcript,
      value.durationSec ?? null,
    );
  }

  /** Close the underlying database. */
  close(): void {
    try {
      if (this.closeDb) this.closeDb();
      else this.db.close();
    } catch {
      // Best-effort — a double close or already-closed handle is harmless.
    }
  }
}
