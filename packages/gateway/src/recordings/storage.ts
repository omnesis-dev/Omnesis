// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SQLite storage for recorded conversations: sessions a phone records with
 * the screen off and uploads as numbered chunks while it records.
 *
 * `recording_sessions` holds one row per session; `recording_chunks` one row
 * per uploaded chunk, keyed by `(session_id, seq)` so a retried upload is a
 * no-op. A chunk's audio waits here until the transcriber has read it, then is
 * dropped: the transcript is what stays. Audio lives in the main database so
 * it shares the corpus's encryption at rest, as voice notes do.
 *
 * Pure SQL over a better-sqlite3 handle. Writes go through the WriteGate
 * (`recordings.*` writer ops); reads run on the gateway's read handle.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

/** A chunk's lifecycle. Every state but `pending` is settled. */
export type RecordingChunkStatus = "pending" | "transcribed" | "failed" | "silent";

export interface RecordingSession {
  id: string;
  deviceId: string | null;
  title: string | null;
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
  attempts: number;
  nextAttemptAt: string;
  receivedAt: string;
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
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_recording_chunks_due
      ON recording_chunks(status, next_attempt_at);
  `);
}

// ── sessions ──────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  device_id: string | null;
  title: string | null;
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
         (id, device_id, title, started_at, started_time_zone_id, started_utc_offset_seconds,
          language, last_activity_at, allow_vocabulary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.id,
      s.deviceId,
      s.title,
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

/** Record that the session's document was written from `revision`. */
export function markRecordingSessionProjected(db: Db, id: string, revision: number): void {
  db.prepare(
    `UPDATE recording_sessions SET projected_revision = MAX(COALESCE(projected_revision, -1), ?)
      WHERE id = ?`,
  ).run(revision, id);
}

/** Delete a session and, through the foreign key, its chunks. */
export function deleteRecordingSession(db: Db, id: string): boolean {
  return db.prepare(`DELETE FROM recording_sessions WHERE id = ?`).run(id).changes > 0;
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
  attempts: number;
  next_attempt_at: string;
  received_at: string;
}

const CHUNK_COLUMNS = `session_id, seq, started_at, duration_ms, silent, interrupted, mime_type,
  status, text, attempts, next_attempt_at, received_at`;

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
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    receivedAt: row.received_at,
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
          status, attempts, next_attempt_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
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

/** Every stored chunk of a session, in recording order. */
export function listRecordingChunks(db: Db, sessionId: string): RecordingChunk[] {
  return db
    .prepare<[string], ChunkRow>(
      `SELECT ${CHUNK_COLUMNS} FROM recording_chunks WHERE session_id = ? ORDER BY seq`,
    )
    .all(sessionId)
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

/**
 * Settle a pending chunk: keep its transcript (or record that it could not
 * be transcribed) and drop its audio. Marks the session changed so its
 * document is written again; the device's activity clock is left alone.
 */
export function settleRecordingChunk(
  db: Db,
  sessionId: string,
  seq: number,
  outcome: { status: "transcribed"; text: string } | { status: "failed" },
): boolean {
  const result = db
    .prepare(
      `UPDATE recording_chunks SET status = ?, text = ?, audio = NULL
        WHERE session_id = ? AND seq = ? AND status = 'pending'`,
    )
    .run(outcome.status, outcome.status === "transcribed" ? outcome.text : null, sessionId, seq);
  if (result.changes === 0) return false;
  db.prepare(`UPDATE recording_sessions SET revision = revision + 1 WHERE id = ?`).run(sessionId);
  return true;
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
