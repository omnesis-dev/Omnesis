// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SQLite storage for voice notes waiting on the gateway's transcriber.
 *
 * A Tell Omnesis capture recorded on a phone or watch arrives with its audio;
 * the note is saved at once (with the device's own transcript, or a
 * placeholder) and one row here holds the audio until the transcriber has
 * replaced that text. The audio lives in the main database, so it shares the
 * corpus's encryption at rest, and the row is deleted as soon as it is done
 * with — transcribed or abandoned — or with its note, through the foreign key.
 *
 * Pure SQL over a better-sqlite3 handle. Writes go through the WriteGate
 * (`voiceNotes.*` writer ops); reads run on the gateway's read handle.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

/** One pending transcription, without its audio. */
export interface PendingVoiceNote {
  /** The note's id in `note_entries`. */
  noteId: string;
  mimeType: string;
  /** ISO 639 language hint, or null to let the transcriber detect it. */
  language: string | null;
  /**
   * The note's text when it was saved. The transcript replaces the note's
   * text only while it still reads this, so an edit made meanwhile wins.
   */
  savedText: string;
  /** The note was saved with a placeholder because the device had no transcript. */
  placeholder: boolean;
  attempts: number;
  /** ISO-8601 instant the next attempt is due. */
  nextAttemptAt: string;
  /** ISO-8601 instant the note was received. */
  createdAt: string;
}

export interface NewPendingVoiceNote extends Omit<PendingVoiceNote, "attempts"> {
  audio: Uint8Array;
}

export function createVoiceNoteTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_note_transcriptions (
      note_id TEXT PRIMARY KEY REFERENCES note_entries(id) ON DELETE CASCADE,
      audio BLOB NOT NULL,
      mime_type TEXT NOT NULL,
      language TEXT,
      saved_text TEXT NOT NULL,
      placeholder INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_voice_note_transcriptions_due
      ON voice_note_transcriptions(next_attempt_at);
  `);
}

/** Queue a note's audio. False when that note is already queued. */
export function insertPendingVoiceNote(db: Db, row: NewPendingVoiceNote): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO voice_note_transcriptions
         (note_id, audio, mime_type, language, saved_text, placeholder, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      row.noteId,
      Buffer.from(row.audio.buffer, row.audio.byteOffset, row.audio.byteLength),
      row.mimeType,
      row.language,
      row.savedText,
      row.placeholder ? 1 : 0,
      row.nextAttemptAt,
      row.createdAt,
    );
  return result.changes > 0;
}

interface PendingRow {
  note_id: string;
  mime_type: string;
  language: string | null;
  saved_text: string;
  placeholder: number;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
}

function toPending(row: PendingRow): PendingVoiceNote {
  return {
    noteId: row.note_id,
    mimeType: row.mime_type,
    language: row.language,
    savedText: row.saved_text,
    placeholder: row.placeholder === 1,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
  };
}

/** The earliest-due pending notes at `nowIso`, oldest first, without their audio. */
export function listDuePendingVoiceNotes(
  db: Db,
  nowIso: string,
  limit: number,
): PendingVoiceNote[] {
  return db
    .prepare<[string, number], PendingRow>(
      `SELECT note_id, mime_type, language, saved_text, placeholder, attempts, next_attempt_at, created_at
         FROM voice_note_transcriptions
        WHERE next_attempt_at <= ?
        ORDER BY next_attempt_at, created_at
        LIMIT ?`,
    )
    .all(nowIso, limit)
    .map(toPending);
}

/** One pending note, without its audio; null when not queued. */
export function getPendingVoiceNote(db: Db, noteId: string): PendingVoiceNote | null {
  const row = db
    .prepare<[string], PendingRow>(
      `SELECT note_id, mime_type, language, saved_text, placeholder, attempts, next_attempt_at, created_at
         FROM voice_note_transcriptions WHERE note_id = ?`,
    )
    .get(noteId);
  return row ? toPending(row) : null;
}

/** Which of `noteIds` are still waiting on the transcriber. */
export function pendingVoiceNoteIds(db: Db, noteIds: readonly string[]): Set<string> {
  if (noteIds.length === 0) return new Set();
  const rows = db
    .prepare<string[], { note_id: string }>(
      `SELECT note_id FROM voice_note_transcriptions
        WHERE note_id IN (${noteIds.map(() => "?").join(", ")})`,
    )
    .all(...noteIds);
  return new Set(rows.map((row) => row.note_id));
}

/** A pending note's audio; null when not queued. */
export function readPendingVoiceNoteAudio(db: Db, noteId: string): Uint8Array | null {
  const row = db
    .prepare<
      [string],
      { audio: Buffer }
    >(`SELECT audio FROM voice_note_transcriptions WHERE note_id = ?`)
    .get(noteId);
  return row ? new Uint8Array(row.audio) : null;
}

/** Record an attempt and when to try next. */
export function reschedulePendingVoiceNote(
  db: Db,
  noteId: string,
  attempts: number,
  nextAttemptAt: string,
): void {
  db.prepare(
    `UPDATE voice_note_transcriptions SET attempts = ?, next_attempt_at = ? WHERE note_id = ?`,
  ).run(attempts, nextAttemptAt, noteId);
}

export function deletePendingVoiceNote(db: Db, noteId: string): void {
  db.prepare(`DELETE FROM voice_note_transcriptions WHERE note_id = ?`).run(noteId);
}
