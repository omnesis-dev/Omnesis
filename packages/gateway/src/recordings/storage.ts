// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SQLite storage for recorded conversations: sessions a phone records with
 * the screen off and uploads as numbered chunks while it records.
 *
 * `recording_sessions` holds one row per session; `recording_chunks` one row
 * per uploaded chunk, keyed by `(session_id, seq)` so a retried upload is a
 * no-op. `recording_marks` holds the moments the owner marked during a
 * session, each saved as a voice note. A chunk's audio waits here until the transcriber has read it, then is
 * dropped: the transcript is what stays. An operator may keep it for some days
 * after that (`inference.recordings.keepAudioDays`); `settled_at` dates when
 * each chunk was settled, so the kept audio is dropped on time. Audio lives in
 * the main database so it shares the corpus's encryption at rest, as voice
 * notes do.
 *
 * `recording_voice_profile` holds at most one row: the owner's enrolled voice
 * as one mean vector and the embedding model it came from, used to recognise
 * the owner among a session's speakers (`inference.recordings.selfVoice`).
 * Nobody else's voice is ever kept.
 *
 * Pure SQL over a better-sqlite3 handle. Writes go through the WriteGate
 * (`recordings.*` writer ops); reads run on the gateway's read handle.
 */

import { packVectors, unpackVectors, type VoiceWindow } from "./voices/voices.js";
import type Database from "better-sqlite3";
import type { TranscriptSegment } from "@omnesis/core";

type Db = Database.Database;

/** A chunk's lifecycle. Every state but `pending` is settled. */
export type RecordingChunkStatus = "pending" | "transcribed" | "failed" | "silent";

/**
 * How a session began: `explicit` when the owner started it, `ambient` when a
 * wearable capturing all day opened it on its own as one episode of speech.
 */
export type RecordingOrigin = "explicit" | "ambient";

export interface RecordingSession {
  id: string;
  deviceId: string | null;
  title: string | null;
  origin: RecordingOrigin;
  /** ISO-8601 instant recording started. */
  startedAt: string;
  startedTimeZoneId: string | null;
  startedUtcOffsetSeconds: number | null;
  /** ISO 639 language hint, or null to let the transcriber detect it. */
  language: string | null;
  /** How many chunks the device recorded; null until the session is finished. */
  chunkCount: number | null;
  endedAt: string | null;
  finishedAt: string | null;
  /**
   * Who finished the session: the device, or the gateway on the device's
   * behalf after it went quiet. A gateway finish is provisional: a later
   * chunk reopens the session and the device's own finish replaces it.
   */
  finishedBy: RecordingFinisher | null;
  /** Last time the device created, uploaded to or finished the session. */
  lastActivityAt: string;
  /** Bumped by every change that alters the session's document. */
  revision: number;
  /** The revision the session's document was last written from; null before the first. */
  projectedRevision: number | null;
  /** Corpus read access at ingress, used as transcription vocabulary. */
  allowVocabulary: boolean;
  createdAt: string;
}

export type RecordingFinisher = "device" | "gateway";

export type NewRecordingSession = Omit<
  RecordingSession,
  | "chunkCount"
  | "endedAt"
  | "finishedAt"
  | "finishedBy"
  | "lastActivityAt"
  | "revision"
  | "projectedRevision"
>;

/** What storing an uploaded chunk did. */
export type InsertRecordingChunkOutcome =
  | "stored"
  | "duplicate"
  /** The session does not exist. */
  | "missing"
  /** The device finished the session with fewer chunks than this seq. */
  | "beyond";

export type FinishRecordingOutcome = "finished" | "already" | "conflict" | "missing";

/** How a pending chunk settles: its transcript, or that it could not be transcribed. */
export type RecordingChunkSettlement =
  | {
      status: "transcribed";
      text: string;
      segments?: TranscriptSegment[];
      /** Voice windows of the chunk and one vector each, kept until the session's voices are grouped. */
      voices?: { windows: VoiceWindow[]; vectors: Float32Array[] };
    }
  | { status: "failed" };

export interface RecordingChunk {
  sessionId: string;
  seq: number;
  /** ISO-8601 instant this chunk's audio starts. */
  startedAt: string;
  durationMs: number;
  /** The device heard nothing above its silence threshold; no audio was sent. */
  silent: boolean;
  /** The microphone was taken from the recorder (a call, another app) during the chunk. */
  interrupted: boolean;
  mimeType: string | null;
  status: RecordingChunkStatus;
  text: string | null;
  /** The transcript as timed segments, ms from the start of this chunk, when the transcriber gave them. */
  segments: TranscriptSegment[] | null;
  /** Where each voice speaks in the chunk, with its session speaker once grouped. */
  voices: VoiceWindow[] | null;
  attempts: number;
  nextAttemptAt: string;
  receivedAt: string;
  /** When the chunk was settled; null while it is pending. */
  settledAt: string | null;
  /** Whether the gateway still holds the chunk's audio. */
  hasAudio: boolean;
}

/** A moment the owner marked during a session; the marked audio became note `noteId`. */
export interface RecordingMark {
  sessionId: string;
  noteId: string;
  /** ISO-8601 instant of the mark. */
  markedAt: string;
}

export interface NewRecordingChunk {
  sessionId: string;
  seq: number;
  startedAt: string;
  durationMs: number;
  silent: boolean;
  interrupted: boolean;
  /** Absent for a silent chunk. */
  audio: Uint8Array | null;
  mimeType: string | null;
  receivedAt: string;
}

export function createRecordingTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recording_sessions (
      id TEXT PRIMARY KEY,
      device_id TEXT,
      title TEXT,
      origin TEXT NOT NULL DEFAULT 'explicit',
      started_at TEXT NOT NULL,
      started_time_zone_id TEXT,
      started_utc_offset_seconds INTEGER,
      language TEXT,
      chunk_count INTEGER,
      ended_at TEXT,
      finished_at TEXT,
      finished_by TEXT,
      last_activity_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      projected_revision INTEGER,
      allow_vocabulary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recording_sessions_open
      ON recording_sessions(finished_at, last_activity_at);
    -- Only the sessions whose document is behind, so the projection sweep
    -- costs the dirty sessions rather than every recording ever made.
    CREATE INDEX IF NOT EXISTS idx_recording_sessions_unprojected
      ON recording_sessions(finished_at)
      WHERE finished_at IS NOT NULL
        AND (projected_revision IS NULL OR projected_revision < revision);
    CREATE TABLE IF NOT EXISTS recording_chunks (
      session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      silent INTEGER NOT NULL DEFAULT 0,
      interrupted INTEGER NOT NULL DEFAULT 0,
      audio BLOB,
      mime_type TEXT,
      status TEXT NOT NULL,
      text TEXT,
      segments TEXT,
      voices TEXT,
      -- Voice vectors of the windows in voices, deleted when the session's
      -- voices are grouped into speakers; never kept past that.
      voice_vectors BLOB,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      settled_at TEXT,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_recording_chunks_due
      ON recording_chunks(status, next_attempt_at);
    -- No foreign key: the voice note carrying a mark can reach the gateway
    -- before the phone has opened the session it belongs to.
    CREATE TABLE IF NOT EXISTS recording_marks (
      session_id TEXT NOT NULL,
      note_id TEXT NOT NULL,
      marked_at TEXT NOT NULL,
      PRIMARY KEY (session_id, note_id)
    );

    CREATE TABLE IF NOT EXISTS recording_speakers (
      session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
      speaker INTEGER NOT NULL,
      person_id TEXT,
      is_self INTEGER NOT NULL DEFAULT 0,
      name TEXT,
      -- 'matched' when the gateway recognised the owner's voice; 'rejected'
      -- once the owner changed such a mapping. Null for the owner's own.
      self_match TEXT,
      PRIMARY KEY (session_id, speaker)
    );

    CREATE TABLE IF NOT EXISTS recording_voice_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model TEXT NOT NULL,
      vector BLOB NOT NULL,
      speech_ms INTEGER NOT NULL,
      enrolled_at TEXT NOT NULL
    );
  `);
  // Columns added after the table first shipped: a gateway that already has
  // the table gets them here, since CREATE TABLE IF NOT EXISTS leaves it as is.
  const chunkColumns = new Set(
    (
      db.prepare("SELECT name FROM pragma_table_info('recording_chunks')").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  for (const [name, type] of [
    ["segments", "TEXT"],
    ["voices", "TEXT"],
    ["voice_vectors", "BLOB"],
    ["settled_at", "TEXT"],
  ] as const) {
    if (!chunkColumns.has(name)) db.exec(`ALTER TABLE recording_chunks ADD COLUMN ${name} ${type}`);
  }
  const speakerColumns = db
    .prepare("SELECT name FROM pragma_table_info('recording_speakers')")
    .all() as Array<{ name: string }>;
  if (!speakerColumns.some((column) => column.name === "self_match")) {
    db.exec("ALTER TABLE recording_speakers ADD COLUMN self_match TEXT");
  }
  // Suggestions the owner dismissed for a session (calendar attendees, names
  // heard in the transcript, a calendar title), so they are not offered again.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recording_suggestion_dismissals (
      session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      dismissed_at TEXT NOT NULL,
      PRIMARY KEY (session_id, key)
    );
  `);
  // People the owner says were present without being told apart as a
  // speaker: a person, or a name without one. `key` keeps each one once.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recording_participants (
      session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      person_id TEXT,
      name TEXT,
      added_at TEXT NOT NULL,
      PRIMARY KEY (session_id, key)
    );
  `);
  // Only settled chunks whose audio is kept: what the retention sweep reads.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_recording_chunks_kept_audio
      ON recording_chunks(settled_at)
      WHERE audio IS NOT NULL AND status != 'pending';
  `);
  // The conversations an all-day session was split into (see conversations.ts).
  // A session without any is written as one document, as it always was.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recording_conversations (
      session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
      n INTEGER NOT NULL,
      first_seq INTEGER NOT NULL,
      last_seq INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      title TEXT,
      -- Hash of the document last written for it, so an unchanged
      -- conversation is not written again on every change of its session.
      content_hash TEXT,
      closed_at TEXT NOT NULL,
      PRIMARY KEY (session_id, n)
    );
  `);
}

// ── sessions ──────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  device_id: string | null;
  title: string | null;
  origin: string;
  started_at: string;
  started_time_zone_id: string | null;
  started_utc_offset_seconds: number | null;
  language: string | null;
  chunk_count: number | null;
  ended_at: string | null;
  finished_at: string | null;
  finished_by: string | null;
  last_activity_at: string;
  revision: number;
  projected_revision: number | null;
  allow_vocabulary: number;
  created_at: string;
}

function toSession(row: SessionRow): RecordingSession {
  return {
    id: row.id,
    deviceId: row.device_id,
    title: row.title,
    origin: row.origin === "ambient" ? "ambient" : "explicit",
    startedAt: row.started_at,
    startedTimeZoneId: row.started_time_zone_id,
    startedUtcOffsetSeconds: row.started_utc_offset_seconds,
    language: row.language,
    chunkCount: row.chunk_count,
    endedAt: row.ended_at,
    finishedAt: row.finished_at,
    finishedBy:
      row.finished_by === "device" || row.finished_by === "gateway" ? row.finished_by : null,
    lastActivityAt: row.last_activity_at,
    revision: row.revision,
    projectedRevision: row.projected_revision,
    allowVocabulary: row.allow_vocabulary === 1,
    createdAt: row.created_at,
  };
}

/** Create a session. False when one with that id already exists. */
export function insertRecordingSession(db: Db, s: NewRecordingSession): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO recording_sessions
         (id, device_id, title, origin, started_at, started_time_zone_id,
          started_utc_offset_seconds, language, last_activity_at, allow_vocabulary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.id,
      s.deviceId,
      s.title,
      s.origin,
      s.startedAt,
      s.startedTimeZoneId,
      s.startedUtcOffsetSeconds,
      s.language,
      s.createdAt,
      s.allowVocabulary ? 1 : 0,
      s.createdAt,
    );
  return result.changes > 0;
}

export function getRecordingSession(db: Db, id: string): RecordingSession | null {
  const row = db
    .prepare<[string], SessionRow>(`SELECT * FROM recording_sessions WHERE id = ?`)
    .get(id);
  return row ? toSession(row) : null;
}

/** The highest stored seq of a session, or -1 when it has none. */
export function maxRecordingChunkSeq(db: Db, sessionId: string): number {
  const row = db
    .prepare<[string], { m: number | null }>(
      `SELECT MAX(seq) AS m FROM recording_chunks WHERE session_id = ?`,
    )
    .get(sessionId);
  return row?.m ?? -1;
}

/**
 * The device declares how many chunks it recorded. Idempotent for the same
 * count. A count below a chunk already stored is a conflict, as is a second,
 * different count from the device; a count the gateway declared on the
 * device's behalf is replaced.
 */
export function finishRecordingSession(
  db: Db,
  id: string,
  chunkCount: number,
  endedAt: string,
  now: string,
): FinishRecordingOutcome {
  const session = getRecordingSession(db, id);
  if (!session) return "missing";
  if (session.finishedBy === "device") {
    return session.chunkCount === chunkCount ? "already" : "conflict";
  }
  if (maxRecordingChunkSeq(db, id) >= chunkCount) return "conflict";
  db.prepare(
    `UPDATE recording_sessions
        SET chunk_count = ?, ended_at = ?, finished_at = ?, finished_by = 'device',
            last_activity_at = ?, revision = revision + 1
      WHERE id = ?`,
  ).run(chunkCount, endedAt, now, now, id);
  return "finished";
}

/**
 * Finish a session for a device that went quiet: its count is the chunks
 * that arrived, and it ends where the last of them ends. Provisional — a
 * later chunk reopens it. False when the session is gone or already finished.
 */
export function abandonRecordingSession(db: Db, id: string, now: string): boolean {
  const session = getRecordingSession(db, id);
  if (!session || session.finishedAt !== null) return false;
  const last = db
    .prepare<[string], { seq: number; started_at: string; duration_ms: number }>(
      `SELECT seq, started_at, duration_ms FROM recording_chunks
        WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(id);
  const endedAt = last
    ? new Date(Date.parse(last.started_at) + last.duration_ms).toISOString()
    : session.startedAt;
  db.prepare(
    `UPDATE recording_sessions
        SET chunk_count = ?, ended_at = ?, finished_at = ?, finished_by = 'gateway',
            revision = revision + 1
      WHERE id = ?`,
  ).run(last ? last.seq + 1 : 0, endedAt, now, id);
  return true;
}

/** Sessions the device stopped talking to before finishing them. */
export function listAbandonedRecordingSessions(
  db: Db,
  idleBeforeIso: string,
  limit: number,
): RecordingSession[] {
  return db
    .prepare<[string, number], SessionRow>(
      `SELECT * FROM recording_sessions
        WHERE finished_at IS NULL AND last_activity_at <= ?
        ORDER BY last_activity_at
        LIMIT ?`,
    )
    .all(idleBeforeIso, limit)
    .map(toSession);
}

/**
 * Finished sessions ready for their document: it is missing or older than
 * the session's last change, nothing is left to transcribe, and either every
 * declared chunk has arrived or the session finished before
 * `missingCutoffIso` — past which the chunks still missing are given up on.
 */
export function listUnprojectedRecordingSessions(
  db: Db,
  missingCutoffIso: string,
  limit: number,
): RecordingSession[] {
  return db
    .prepare<[string, number], SessionRow>(
      `SELECT s.* FROM recording_sessions s
        WHERE s.finished_at IS NOT NULL
          AND (s.projected_revision IS NULL OR s.projected_revision < s.revision)
          AND NOT EXISTS (
            SELECT 1 FROM recording_chunks c
             WHERE c.session_id = s.id AND c.status = 'pending'
          )
          AND (
            (SELECT COUNT(*) FROM recording_chunks c WHERE c.session_id = s.id) >= s.chunk_count
            OR s.finished_at <= ?
          )
        ORDER BY s.finished_at
        LIMIT ?`,
    )
    .all(missingCutoffIso, limit)
    .map(toSession);
}

/**
 * Open sessions with a closed conversation whose documents may be behind:
 * those are written while the session goes on.
 */
export function listUnprojectedOpenRecordingSessions(db: Db, limit: number): RecordingSession[] {
  return db
    .prepare<[number], SessionRow>(
      `SELECT s.* FROM recording_sessions s
        WHERE s.finished_at IS NULL
          AND (s.projected_revision IS NULL OR s.projected_revision < s.revision)
          AND EXISTS (SELECT 1 FROM recording_conversations k WHERE k.session_id = s.id)
        ORDER BY s.last_activity_at
        LIMIT ?`,
    )
    .all(limit)
    .map(toSession);
}

/** Open all-day sessions: the ones the gateway splits into conversations. */
export function listOpenAmbientRecordingSessions(db: Db, limit: number): RecordingSession[] {
  return db
    .prepare<[number], SessionRow>(
      `SELECT * FROM recording_sessions
        WHERE finished_at IS NULL AND origin = 'ambient'
        ORDER BY last_activity_at
        LIMIT ?`,
    )
    .all(limit)
    .map(toSession);
}

// ── conversations ─────────────────────────────────────────────────────

/** One conversation of a split session (see conversations.ts). */
export interface RecordingConversation {
  sessionId: string;
  n: number;
  firstSeq: number;
  lastSeq: number;
  startedAt: string;
  endedAt: string;
  /** The owner's title; null for the time-based one. */
  title: string | null;
  contentHash: string | null;
  closedAt: string;
}

interface ConversationRow {
  session_id: string;
  n: number;
  first_seq: number;
  last_seq: number;
  started_at: string;
  ended_at: string;
  title: string | null;
  content_hash: string | null;
  closed_at: string;
}

/** A conversation as the gateway closes it. */
export type ClosedRecordingConversation = Pick<
  RecordingConversation,
  "n" | "firstSeq" | "lastSeq" | "startedAt" | "endedAt"
>;

/** A session's conversations, in recording order. */
export function listRecordingConversations(db: Db, sessionId: string): RecordingConversation[] {
  return db
    .prepare<[string], ConversationRow>(
      `SELECT * FROM recording_conversations WHERE session_id = ? ORDER BY n`,
    )
    .all(sessionId)
    .map((row) => ({
      sessionId: row.session_id,
      n: row.n,
      firstSeq: row.first_seq,
      lastSeq: row.last_seq,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      title: row.title,
      contentHash: row.content_hash,
      closedAt: row.closed_at,
    }));
}

/**
 * Record conversations closed in a session. A conversation already recorded
 * only reaches further (the end of a finished session). Marks the session
 * changed when anything was recorded, so the documents are written. The
 * number recorded or extended; 0 when the session does not exist.
 */
export function closeRecordingConversations(
  db: Db,
  sessionId: string,
  spans: readonly ClosedRecordingConversation[],
  closedAt: string,
): number {
  if (spans.length === 0 || !getRecordingSession(db, sessionId)) return 0;
  const insert = db.prepare(
    `INSERT INTO recording_conversations
       (session_id, n, first_seq, last_seq, started_at, ended_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, n) DO UPDATE SET last_seq = excluded.last_seq
       WHERE excluded.last_seq > recording_conversations.last_seq`,
  );
  let changed = 0;
  for (const s of spans) {
    changed += insert.run(
      sessionId,
      s.n,
      s.firstSeq,
      s.lastSeq,
      s.startedAt,
      s.endedAt,
      closedAt,
    ).changes;
  }
  if (changed > 0) {
    db.prepare(`UPDATE recording_sessions SET revision = revision + 1 WHERE id = ?`).run(sessionId);
  }
  return changed;
}

/**
 * Give one conversation the owner's title; null clears it. Marks the session
 * changed. False when there is no such conversation.
 */
export function setRecordingConversationTitle(
  db: Db,
  sessionId: string,
  n: number,
  title: string | null,
): boolean {
  const set =
    db
      .prepare(`UPDATE recording_conversations SET title = ? WHERE session_id = ? AND n = ?`)
      .run(title, sessionId, n).changes > 0;
  if (set) {
    db.prepare(`UPDATE recording_sessions SET revision = revision + 1 WHERE id = ?`).run(sessionId);
  }
  return set;
}

/** Remember the hash of the document written for a conversation. */
export function markRecordingConversationProjected(
  db: Db,
  sessionId: string,
  n: number,
  contentHash: string | null,
): void {
  db.prepare(
    `UPDATE recording_conversations SET content_hash = ? WHERE session_id = ? AND n = ?`,
  ).run(contentHash, sessionId, n);
}

/** Record that the session's document was written from `revision`. */
export function markRecordingSessionProjected(db: Db, id: string, revision: number): void {
  db.prepare(
    `UPDATE recording_sessions SET projected_revision = MAX(COALESCE(projected_revision, -1), ?)
      WHERE id = ?`,
  ).run(revision, id);
}

/** Delete a session, its marks and, through the foreign key, its chunks. */
export function deleteRecordingSession(db: Db, id: string): boolean {
  db.prepare(`DELETE FROM recording_marks WHERE session_id = ?`).run(id);
  return db.prepare(`DELETE FROM recording_sessions WHERE id = ?`).run(id).changes > 0;
}

// ── marks ─────────────────────────────────────────────────────────────

/**
 * Record a marked moment. Idempotent per `(session, note)`. Marks the session
 * changed, when it exists yet, so its document is written again with the mark.
 */
export function insertRecordingMark(db: Db, mark: RecordingMark): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO recording_marks (session_id, note_id, marked_at) VALUES (?, ?, ?)`,
    )
    .run(mark.sessionId, mark.noteId, mark.markedAt);
  if (result.changes === 0) return false;
  db.prepare(`UPDATE recording_sessions SET revision = revision + 1 WHERE id = ?`).run(
    mark.sessionId,
  );
  return true;
}

/** A session's marks, earliest first. */
export function listRecordingMarks(db: Db, sessionId: string): RecordingMark[] {
  return db
    .prepare<[string], { session_id: string; note_id: string; marked_at: string }>(
      `SELECT session_id, note_id, marked_at FROM recording_marks
        WHERE session_id = ? ORDER BY marked_at, note_id`,
    )
    .all(sessionId)
    .map((row) => ({ sessionId: row.session_id, noteId: row.note_id, markedAt: row.marked_at }));
}

// ── chunks ────────────────────────────────────────────────────────────

interface ChunkRow {
  session_id: string;
  seq: number;
  started_at: string;
  duration_ms: number;
  silent: number;
  interrupted: number;
  mime_type: string | null;
  status: string;
  text: string | null;
  segments: string | null;
  voices: string | null;
  attempts: number;
  next_attempt_at: string;
  received_at: string;
  settled_at: string | null;
  has_audio: number;
}

const CHUNK_COLUMNS = `session_id, seq, started_at, duration_ms, silent, interrupted, mime_type,
  status, text, segments, voices, attempts, next_attempt_at, received_at, settled_at,
  audio IS NOT NULL AS has_audio`;

function toChunk(row: ChunkRow): RecordingChunk {
  return {
    sessionId: row.session_id,
    seq: row.seq,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    silent: row.silent === 1,
    interrupted: row.interrupted === 1,
    mimeType: row.mime_type,
    status: row.status as RecordingChunkStatus,
    text: row.text,
    segments: row.segments ? (JSON.parse(row.segments) as TranscriptSegment[]) : null,
    voices: row.voices ? (JSON.parse(row.voices) as VoiceWindow[]) : null,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    receivedAt: row.received_at,
    settledAt: row.settled_at,
    hasAudio: row.has_audio === 1,
  };
}

/**
 * Store one uploaded chunk and mark the session active. A silent chunk (or
 * one with no audio) is settled on arrival. A chunk past the count the
 * gateway declared for a quiet device reopens the session: the device is
 * back, and will finish it itself.
 */
export function insertRecordingChunk(db: Db, c: NewRecordingChunk): InsertRecordingChunkOutcome {
  const session = getRecordingSession(db, c.sessionId);
  if (!session) return "missing";
  if (session.chunkCount !== null && c.seq >= session.chunkCount) {
    if (session.finishedBy === "device") return "beyond";
    db.prepare(
      `UPDATE recording_sessions
          SET chunk_count = NULL, ended_at = NULL, finished_at = NULL, finished_by = NULL
        WHERE id = ?`,
    ).run(c.sessionId);
  }
  const pending = !c.silent && c.audio !== null && c.audio.byteLength > 0;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO recording_chunks
         (session_id, seq, started_at, duration_ms, silent, interrupted, audio, mime_type,
          status, attempts, next_attempt_at, received_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      c.sessionId,
      c.seq,
      c.startedAt,
      c.durationMs,
      c.silent ? 1 : 0,
      c.interrupted ? 1 : 0,
      pending && c.audio
        ? Buffer.from(c.audio.buffer, c.audio.byteOffset, c.audio.byteLength)
        : null,
      pending ? c.mimeType : null,
      pending ? "pending" : "silent",
      c.receivedAt,
      c.receivedAt,
      pending ? null : c.receivedAt,
    );
  if (result.changes === 0) return "duplicate";
  db.prepare(
    `UPDATE recording_sessions SET last_activity_at = ?, revision = revision + 1 WHERE id = ?`,
  ).run(c.receivedAt, c.sessionId);
  return "stored";
}

/** The earliest-due chunks waiting on the transcriber, without their audio. */
export function listDueRecordingChunks(db: Db, nowIso: string, limit: number): RecordingChunk[] {
  return db
    .prepare<[string, number], ChunkRow>(
      `SELECT ${CHUNK_COLUMNS} FROM recording_chunks
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at, session_id, seq
        LIMIT ?`,
    )
    .all(nowIso, limit)
    .map(toChunk);
}

export function getRecordingChunk(db: Db, sessionId: string, seq: number): RecordingChunk | null {
  const row = db
    .prepare<[string, number], ChunkRow>(
      `SELECT ${CHUNK_COLUMNS} FROM recording_chunks WHERE session_id = ? AND seq = ?`,
    )
    .get(sessionId, seq);
  return row ? toChunk(row) : null;
}

/** Every stored chunk of a session from `fromSeq` on, in recording order. */
export function listRecordingChunks(db: Db, sessionId: string, fromSeq = 0): RecordingChunk[] {
  return db
    .prepare<[string, number], ChunkRow>(
      `SELECT ${CHUNK_COLUMNS} FROM recording_chunks
        WHERE session_id = ? AND seq >= ? ORDER BY seq`,
    )
    .all(sessionId, fromSeq)
    .map(toChunk);
}

export function readRecordingChunkAudio(db: Db, sessionId: string, seq: number): Uint8Array | null {
  const row = db
    .prepare<[string, number], { audio: Buffer | null }>(
      `SELECT audio FROM recording_chunks WHERE session_id = ? AND seq = ?`,
    )
    .get(sessionId, seq);
  return row?.audio ? new Uint8Array(row.audio) : null;
}

export function rescheduleRecordingChunk(
  db: Db,
  sessionId: string,
  seq: number,
  attempts: number,
  nextAttemptAt: string,
): void {
  db.prepare(
    `UPDATE recording_chunks SET attempts = ?, next_attempt_at = ?
      WHERE session_id = ? AND seq = ? AND status = 'pending'`,
  ).run(attempts, nextAttemptAt, sessionId, seq);
}

/** When a chunk is settled, and whether its audio is kept past that. */
export interface RecordingChunkSettling {
  /** ISO-8601 instant of the settling. */
  settledAt: string;
  /** Keep the audio; the retention sweep drops it later. */
  keepAudio: boolean;
}

/**
 * Settle a pending chunk: keep its transcript (or record that it could not
 * be transcribed) and drop its audio, unless the operator keeps it for a
 * while. Marks the session changed so its document is written again; the
 * device's activity clock is left alone.
 */
export function settleRecordingChunk(
  db: Db,
  sessionId: string,
  seq: number,
  outcome: RecordingChunkSettlement,
  settling: RecordingChunkSettling,
): boolean {
  const transcribed = outcome.status === "transcribed" ? outcome : null;
  const segments = transcribed?.segments?.length ? JSON.stringify(transcribed.segments) : null;
  const voices = transcribed?.voices?.windows.length ? transcribed.voices : null;
  const result = db
    .prepare(
      `UPDATE recording_chunks
          SET status = ?, text = ?, segments = ?, voices = ?, voice_vectors = ?, settled_at = ?,
              audio = CASE WHEN ? = 1 THEN audio ELSE NULL END
        WHERE session_id = ? AND seq = ? AND status = 'pending'`,
    )
    .run(
      outcome.status,
      transcribed?.text ?? null,
      segments,
      voices ? JSON.stringify(voices.windows) : null,
      voices ? packVectors(voices.vectors) : null,
      settling.settledAt,
      settling.keepAudio ? 1 : 0,
      sessionId,
      seq,
    );
  if (result.changes === 0) return false;
  db.prepare(`UPDATE recording_sessions SET revision = revision + 1 WHERE id = ?`).run(sessionId);
  return true;
}

/**
 * Drop the kept audio of every chunk settled at or before `settledBefore`.
 * Returns how many chunks lost their audio. A pending chunk keeps its audio
 * whatever its age: the transcriber has not read it yet.
 */
export function purgeRecordingAudio(db: Db, settledBefore: string): number {
  return db
    .prepare(
      `UPDATE recording_chunks SET audio = NULL
        WHERE audio IS NOT NULL AND status != 'pending' AND settled_at <= ?`,
    )
    .run(settledBefore).changes;
}

/** The recorded time of a session's chunks, ms. */
export function sumRecordingChunkDurations(db: Db, sessionId: string): number {
  const row = db
    .prepare<[string], { ms: number | null }>(
      `SELECT SUM(duration_ms) AS ms FROM recording_chunks WHERE session_id = ?`,
    )
    .get(sessionId);
  return row?.ms ?? 0;
}

/** Per-status chunk counts for one session. */
export function countRecordingChunks(
  db: Db,
  sessionId: string,
): Record<RecordingChunkStatus, number> {
  const counts: Record<RecordingChunkStatus, number> = {
    pending: 0,
    transcribed: 0,
    failed: 0,
    silent: 0,
  };
  const rows = db
    .prepare<[string], { status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM recording_chunks WHERE session_id = ? GROUP BY status`,
    )
    .all(sessionId);
  for (const row of rows) {
    if (row.status in counts) counts[row.status as RecordingChunkStatus] = row.n;
  }
  return counts;
}

// ── speakers ──────────────────────────────────────────────────────────

/** Who one of a session's speakers is, as the owner said. */
export interface RecordingSpeaker {
  sessionId: string;
  /** 1-based, in order of first appearance. */
  speaker: number;
  personId: string | null;
  isSelf: boolean;
  /** A name given without linking a person. */
  name: string | null;
  /** Whether the gateway mapped the owner by voice, or the owner undid such a mapping. */
  selfMatch: RecordingSelfMatch | null;
}

export type RecordingSelfMatch = "matched" | "rejected";

/** How the owner maps one speaker. */
export type RecordingSpeakerMapping =
  | { kind: "self" }
  | { kind: "person"; personId: string }
  | { kind: "name"; name: string }
  | { kind: "clear" };

/**
 * The voice windows of a session's chunks whose vectors are not grouped yet,
 * of the chunks `fromSeq`..`toSeq` when given (one conversation's).
 */
export function listUngroupedRecordingVoices(
  db: Db,
  sessionId: string,
  range: { fromSeq: number; toSeq: number } = { fromSeq: 0, toSeq: Number.MAX_SAFE_INTEGER },
): Array<{ seq: number; windows: VoiceWindow[]; vectors: Float32Array[] }> {
  return db
    .prepare<[string, number, number], { seq: number; voices: string; voice_vectors: Buffer }>(
      `SELECT seq, voices, voice_vectors FROM recording_chunks
        WHERE session_id = ? AND seq BETWEEN ? AND ?
          AND voice_vectors IS NOT NULL AND voices IS NOT NULL
        ORDER BY seq`,
    )
    .all(sessionId, range.fromSeq, range.toSeq)
    .map((row) => {
      const windows = JSON.parse(row.voices) as VoiceWindow[];
      return { seq: row.seq, windows, vectors: unpackVectors(row.voice_vectors, windows.length) };
    });
}

/**
 * Record each chunk's windows with their session speakers, add the speakers
 * not seen before, and delete those chunks' voice vectors. A speaker in
 * `selfSpeakers` is mapped as the owner, recognised by voice, when it is new
 * and the owner has not undone such a mapping in this session. Does not mark
 * the session changed: the caller writes its document next.
 */
export function assignRecordingVoices(
  db: Db,
  sessionId: string,
  chunks: ReadonlyArray<{ seq: number; windows: VoiceWindow[] }>,
  selfSpeakers: readonly number[] = [],
): void {
  const update = db.prepare(
    `UPDATE recording_chunks SET voices = ?, voice_vectors = NULL WHERE session_id = ? AND seq = ?`,
  );
  const speakers = new Set<number>();
  for (const chunk of chunks) {
    update.run(JSON.stringify(chunk.windows), sessionId, chunk.seq);
    for (const w of chunk.windows) if (w.speaker !== undefined) speakers.add(w.speaker);
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO recording_speakers (session_id, speaker) VALUES (?, ?)`,
  );
  const added = new Set<number>();
  for (const speaker of speakers) {
    if (insert.run(sessionId, speaker).changes > 0) added.add(speaker);
  }
  const fresh = selfSpeakers.filter((s) => added.has(s));
  if (fresh.length > 0 && !hasRejectedSelfMatch(db, sessionId)) {
    const mark = db.prepare(
      `UPDATE recording_speakers SET is_self = 1, self_match = 'matched'
        WHERE session_id = ? AND speaker = ?`,
    );
    for (const speaker of fresh) mark.run(sessionId, speaker);
  }
}

/** Whether the owner undid a voice-recognised mapping in this session. */
export function hasRejectedSelfMatch(db: Db, sessionId: string): boolean {
  return (
    db
      .prepare<[string], { n: number }>(
        `SELECT 1 AS n FROM recording_speakers
          WHERE session_id = ? AND self_match = 'rejected' LIMIT 1`,
      )
      .get(sessionId) !== undefined
  );
}

interface SpeakerRow {
  session_id: string;
  speaker: number;
  person_id: string | null;
  is_self: number;
  name: string | null;
  self_match: string | null;
}

export function listRecordingSpeakers(db: Db, sessionId: string): RecordingSpeaker[] {
  return db
    .prepare<[string], SpeakerRow>(
      `SELECT * FROM recording_speakers WHERE session_id = ? ORDER BY speaker`,
    )
    .all(sessionId)
    .map((row) => ({
      sessionId: row.session_id,
      speaker: row.speaker,
      personId: row.person_id,
      isSelf: row.is_self === 1,
      name: row.name,
      selfMatch:
        row.self_match === "matched" || row.self_match === "rejected" ? row.self_match : null,
    }));
}

/**
 * Map one speaker of a session and mark the session changed so its document
 * is written again. False when the session has no such speaker. The owner
 * mapping a speaker the gateway recognised by voice settles it: as the owner,
 * it becomes the owner's own mapping; as anything else, the recognition is
 * rejected and no speaker of this session is recognised again.
 */
export function setRecordingSpeaker(
  db: Db,
  sessionId: string,
  speaker: number,
  mapping: RecordingSpeakerMapping,
): boolean {
  const personId = mapping.kind === "person" ? mapping.personId : null;
  const name = mapping.kind === "name" ? mapping.name : null;
  const changed = db
    .prepare(
      `UPDATE recording_speakers
          SET person_id = ?, is_self = ?, name = ?,
              self_match = CASE WHEN self_match = 'matched'
                                THEN CASE WHEN ? = 1 THEN NULL ELSE 'rejected' END
                                ELSE self_match END
        WHERE session_id = ? AND speaker = ?`,
    )
    .run(
      personId,
      mapping.kind === "self" ? 1 : 0,
      name,
      mapping.kind === "self" ? 1 : 0,
      sessionId,
      speaker,
    ).changes;
  if (changed === 0) return false;
  db.prepare(`UPDATE recording_sessions SET revision = revision + 1 WHERE id = ?`).run(sessionId);
  return true;
}

/**
 * Give a session the title the owner chose; null clears it, back to the
 * date-based one. Marks the session changed so its document is written again.
 * False when the session does not exist.
 */
export function setRecordingTitle(db: Db, id: string, title: string | null): boolean {
  return (
    db
      .prepare(`UPDATE recording_sessions SET title = ?, revision = revision + 1 WHERE id = ?`)
      .run(title, id).changes > 0
  );
}

/** Remember that the owner dismissed a suggestion. False when the session does not exist. */
export function dismissRecordingSuggestion(
  db: Db,
  sessionId: string,
  key: string,
  dismissedAt: string,
): boolean {
  if (!getRecordingSession(db, sessionId)) return false;
  db.prepare(
    `INSERT OR IGNORE INTO recording_suggestion_dismissals (session_id, key, dismissed_at)
     VALUES (?, ?, ?)`,
  ).run(sessionId, key, dismissedAt);
  return true;
}

/** The keys of the suggestions the owner dismissed for a session. */
export function listDismissedRecordingSuggestions(db: Db, sessionId: string): Set<string> {
  return new Set(
    db
      .prepare<[string], { key: string }>(
        `SELECT key FROM recording_suggestion_dismissals WHERE session_id = ?`,
      )
      .all(sessionId)
      .map((row) => row.key),
  );
}

// ── participants without a speaking turn ────────────────────────────────

/** Someone the owner says was present, though no speaker is theirs. */
export interface RecordingParticipant {
  /** `person:<id>` or `name:<lowercased name>`: what removes it. */
  key: string;
  personId: string | null;
  /** The name given without a person; null for a person. */
  name: string | null;
  addedAt: string;
}

/** Who the owner adds: a person, or a name without one. */
export type NewRecordingParticipant = { personId: string } | { name: string };

export function recordingParticipantKey(participant: NewRecordingParticipant): string {
  return "personId" in participant
    ? `person:${participant.personId}`
    : `name:${participant.name.trim().toLowerCase()}`;
}

interface ParticipantRow {
  key: string;
  person_id: string | null;
  name: string | null;
  added_at: string;
}

/** A session's participants without a speaking turn, in the order they were added. */
export function listRecordingParticipants(db: Db, sessionId: string): RecordingParticipant[] {
  return db
    .prepare<[string], ParticipantRow>(
      `SELECT key, person_id, name, added_at FROM recording_participants
        WHERE session_id = ? ORDER BY added_at, rowid`,
    )
    .all(sessionId)
    .map((row) => ({
      key: row.key,
      personId: row.person_id,
      name: row.name,
      addedAt: row.added_at,
    }));
}

/**
 * Add someone who was present and mark the session changed so its document
 * is written again. Adding someone already there changes nothing. False when
 * the session does not exist.
 */
export function addRecordingParticipant(
  db: Db,
  sessionId: string,
  participant: NewRecordingParticipant,
  addedAt: string,
): boolean {
  if (!getRecordingSession(db, sessionId)) return false;
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO recording_participants (session_id, key, person_id, name, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      recordingParticipantKey(participant),
      "personId" in participant ? participant.personId : null,
      "name" in participant ? participant.name.trim() : null,
      addedAt,
    ).changes;
  if (inserted > 0) {
    db.prepare(`UPDATE recording_sessions SET revision = revision + 1 WHERE id = ?`).run(sessionId);
  }
  return true;
}

/**
 * Remove a participant and mark the session changed so its document is
 * written again. False when the session has no such participant.
 */
export function removeRecordingParticipant(db: Db, sessionId: string, key: string): boolean {
  const removed = db
    .prepare(`DELETE FROM recording_participants WHERE session_id = ? AND key = ?`)
    .run(sessionId, key).changes;
  if (removed === 0) return false;
  db.prepare(`UPDATE recording_sessions SET revision = revision + 1 WHERE id = ?`).run(sessionId);
  return true;
}

/** The most recently started sessions, newest first. */
export function listRecentRecordingSessions(db: Db, limit: number): RecordingSession[] {
  return db
    .prepare<[number], SessionRow>(
      `SELECT * FROM recording_sessions ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit)
    .map(toSession);
}

// ── the owner's voice ─────────────────────────────────────────────────

/** The owner's enrolled voice: one mean vector of the model it came from. */
export interface RecordingVoiceProfile {
  model: string;
  vector: Float32Array;
  /** How much speech the enrolment clip held, ms. */
  speechMs: number;
  enrolledAt: string;
}

export function getRecordingVoiceProfile(db: Db): RecordingVoiceProfile | null {
  const row = db
    .prepare<[], { model: string; vector: Buffer; speech_ms: number; enrolled_at: string }>(
      `SELECT model, vector, speech_ms, enrolled_at FROM recording_voice_profile WHERE id = 1`,
    )
    .get();
  if (!row) return null;
  return {
    model: row.model,
    vector: unpackVectors(row.vector, 1)[0]!,
    speechMs: row.speech_ms,
    enrolledAt: row.enrolled_at,
  };
}

/** Keep the owner's voice, replacing any enrolled before. */
export function setRecordingVoiceProfile(db: Db, profile: RecordingVoiceProfile): void {
  db.prepare(
    `INSERT INTO recording_voice_profile (id, model, vector, speech_ms, enrolled_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET model = excluded.model, vector = excluded.vector,
       speech_ms = excluded.speech_ms, enrolled_at = excluded.enrolled_at`,
  ).run(profile.model, packVectors([profile.vector]), profile.speechMs, profile.enrolledAt);
}

/** Delete the owner's voice. False when none was enrolled. */
export function deleteRecordingVoiceProfile(db: Db): boolean {
  return db.prepare(`DELETE FROM recording_voice_profile`).run().changes > 0;
}
