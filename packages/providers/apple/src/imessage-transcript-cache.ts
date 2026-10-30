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
 *
 * The same store keeps the clips whose transcription has not succeeded yet:
 * one row per clip with its attempt count, the time of its next attempt and
 * what the last attempt reported, keyed to the day-chat it belongs to. The
 * source re-renders a day once a clip in it is due again, so a clip that
 * found no transcriber or a backend that was down is retried on a schedule
 * instead of whenever its day happens to change.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  readStorageKeySync,
  storageEncryptionRequired,
  TRANSCRIBER_UNAVAILABLE,
} from "@omnesis/core";
import { openTranscriptDatabase } from "./imessage-transcript-storage.js";

/** A cached transcript row. */
export interface CachedTranscript {
  transcript: string;
  durationSec?: number;
}

/** A clip still to transcribe: how often it was tried, when it is due, and why it failed. */
export interface PendingTranscription {
  attempts: number;
  nextAttemptMs: number;
  lastError: string;
}

/** The clips with no transcript yet, and how many of them found no transcriber. */
export interface TranscriptionBacklogCounts {
  awaiting: number;
  transcriberUnavailable: number;
}

/**
 * Seconds between attempts, by attempt number; the last step repeats. Short
 * enough that a model assigned a minute later is used within the hour, long
 * enough that a clip nothing can transcribe costs a handful of calls a day.
 */
const RETRY_BACKOFF_SEC = [20, 60, 300, 1800, 7200, 21_600, 43_200];

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
  private pendingStmt: Database.Statement;
  private recordFailureStmt: Database.Statement;
  private settleStmt: Database.Statement;
  private dueDaysStmt: Database.Statement;
  private retainDayStmt: Database.Statement;
  private forgetDayStmt: Database.Statement;
  private backlogStmt: Database.Statement;

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
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_transcriptions (
        attachment_guid TEXT PRIMARY KEY,
        day_key TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_attempt_ms REAL NOT NULL,
        last_error TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_transcriptions_due
        ON pending_transcriptions(next_attempt_ms);
    `);
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
      this.pendingStmt = this.db.prepare(
        `SELECT attempts, next_attempt_ms AS nextAttemptMs, last_error AS lastError
         FROM pending_transcriptions WHERE attachment_guid = ?`,
      );
      this.recordFailureStmt = this.db.prepare(
        `INSERT INTO pending_transcriptions (attachment_guid, day_key, attempts, next_attempt_ms, last_error)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(attachment_guid) DO UPDATE SET
           day_key = excluded.day_key,
           attempts = attempts + 1,
           next_attempt_ms = ?,
           last_error = excluded.last_error`,
      );
      this.settleStmt = this.db.prepare(
        "DELETE FROM pending_transcriptions WHERE attachment_guid = ?",
      );
      this.dueDaysStmt = this.db.prepare(
        "SELECT DISTINCT day_key AS dayKey FROM pending_transcriptions WHERE next_attempt_ms <= ? ORDER BY day_key LIMIT ?",
      );
      this.retainDayStmt = this.db.prepare(
        `DELETE FROM pending_transcriptions
         WHERE day_key = ? AND attachment_guid NOT IN (SELECT value FROM json_each(?))`,
      );
      this.forgetDayStmt = this.db.prepare("DELETE FROM pending_transcriptions WHERE day_key = ?");
      this.backlogStmt = this.db.prepare(
        `SELECT COUNT(*) AS awaiting,
                COALESCE(SUM(last_error = ?), 0) AS transcriberUnavailable
         FROM pending_transcriptions`,
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

  /**
   * Persist a transcript for an attachment guid. `""` is a valid value. A
   * transcript settles the clip, so any pending attempt for it is dropped.
   */
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
    this.settleStmt.run(attachmentGuid);
  }

  /** The pending attempt for a clip, if a previous attempt failed. */
  pending(attachmentGuid: string): PendingTranscription | undefined {
    return this.pendingStmt.get(attachmentGuid) as PendingTranscription | undefined;
  }

  /**
   * Record a failed attempt and schedule the next one on the backoff ladder.
   * `dayKey` names the day-chat to re-render when the clip is due.
   */
  recordFailure(attachmentGuid: string, dayKey: string, error: string, nowMs: number): void {
    const prior = this.pending(attachmentGuid);
    const attempts = (prior?.attempts ?? 0) + 1;
    const delaySec = RETRY_BACKOFF_SEC[Math.min(attempts - 1, RETRY_BACKOFF_SEC.length - 1)];
    const next = nowMs + delaySec * 1000;
    this.recordFailureStmt.run(attachmentGuid, dayKey, next, error, next);
  }

  /** The day-chats holding a clip whose next attempt is due, earliest-named first, at most `limit`. */
  dueDayKeys(nowMs: number, limit = Number.MAX_SAFE_INTEGER): string[] {
    return (this.dueDaysStmt.all(nowMs, limit) as { dayKey: string }[]).map((row) => row.dayKey);
  }

  /**
   * Keep only the named clips pending for a day, so a clip that left the
   * chat, or was transcribed through another key, stops holding the day due.
   */
  retainPendingForDay(dayKey: string, attachmentGuids: readonly string[]): void {
    this.retainDayStmt.run(dayKey, JSON.stringify(attachmentGuids));
  }

  /** Drop every pending attempt of a day-chat that no longer exists. */
  forgetDay(dayKey: string): void {
    this.forgetDayStmt.run(dayKey);
  }

  /** How many clips still await a transcript, and how many of them found no transcriber. */
  backlog(): TranscriptionBacklogCounts {
    return this.backlogStmt.get(TRANSCRIBER_UNAVAILABLE) as TranscriptionBacklogCounts;
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
