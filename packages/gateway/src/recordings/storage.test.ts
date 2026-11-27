// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import Sqlite from "better-sqlite3";
import { createDatabase } from "../db.js";
import { createFreshTestDatabase } from "../testing/fresh-database.js";
import {
  addRecordingParticipant,
  assignRecordingVoices,
  createRecordingTables,
  deleteRecordingVoiceProfile,
  getRecordingVoiceProfile,
  listRecordingSpeakers,
  setRecordingSpeaker,
  setRecordingVoiceProfile,
  deleteRecordingSession,
  finishRecordingSession,
  getRecordingSession,
  insertRecordingChunk,
  insertRecordingMark,
  insertRecordingSession,
  listRecordingChunks,
  listRecordingMarks,
  listRecordingParticipants,
  purgeRecordingAudio,
  removeRecordingParticipant,
  readRecordingChunkAudio,
  settleRecordingChunk,
} from "./storage.js";
import type Database from "better-sqlite3";

let dbPath: string;
let db: Database.Database;
const NOW = "2026-03-02T09:00:00.000Z";
const LATER = "2026-03-02T09:05:00.000Z";
const dropAudio = { settledAt: LATER, keepAudio: false };

beforeEach(() => {
  dbPath = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
  db = createFreshTestDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function session(id: string, origin: "explicit" | "ambient" = "explicit"): boolean {
  return insertRecordingSession(db, {
    id,
    deviceId: null,
    title: null,
    origin,
    startedAt: NOW,
    startedTimeZoneId: null,
    startedUtcOffsetSeconds: null,
    language: null,
    allowVocabulary: false,
    createdAt: NOW,
  });
}

function chunk(sessionId: string, seq: number, audio: Uint8Array | null) {
  return insertRecordingChunk(db, {
    sessionId,
    seq,
    startedAt: NOW,
    durationMs: 60_000,
    silent: audio === null,
    interrupted: false,
    audio,
    mimeType: audio ? "audio/aac" : null,
    receivedAt: NOW,
  });
}

describe("recording storage", () => {
  test("sessions and chunks are idempotent, and a chunk needs its session", () => {
    expect(session("s1")).toBe(true);
    expect(session("s1")).toBe(false);
    expect(chunk("s1", 0, new Uint8Array([1, 2]))).toBe("stored");
    expect(chunk("s1", 0, new Uint8Array([1, 2]))).toBe("duplicate");
    expect(chunk("nope", 0, new Uint8Array([1]))).toBe("missing");
    expect(getRecordingSession(db, "s1")?.revision).toBe(1);
  });

  test("a silent chunk is settled on arrival; settling drops a chunk's audio", () => {
    session("s1");
    chunk("s1", 0, null);
    chunk("s1", 1, new Uint8Array([7]));
    expect(listRecordingChunks(db, "s1").map((c) => c.status)).toEqual(["silent", "pending"]);
    expect(readRecordingChunkAudio(db, "s1", 1)).toEqual(new Uint8Array([7]));
    expect(listRecordingChunks(db, "s1")[0]).toMatchObject({ settledAt: NOW, hasAudio: false });
    expect(listRecordingChunks(db, "s1")[1]).toMatchObject({ settledAt: null, hasAudio: true });
    expect(
      settleRecordingChunk(db, "s1", 1, { status: "transcribed", text: "hi" }, dropAudio),
    ).toBe(true);
    expect(settleRecordingChunk(db, "s1", 1, { status: "failed" }, dropAudio)).toBe(false);
    expect(readRecordingChunkAudio(db, "s1", 1)).toBeNull();
    expect(listRecordingChunks(db, "s1")[1]).toMatchObject({
      status: "transcribed",
      text: "hi",
      segments: null,
      settledAt: LATER,
      hasAudio: false,
    });
  });

  test("kept audio outlives settling until the retention sweep passes its date", () => {
    session("s1");
    chunk("s1", 0, new Uint8Array([7]));
    chunk("s1", 1, new Uint8Array([8]));
    settleRecordingChunk(db, "s1", 0, { status: "failed" }, { settledAt: LATER, keepAudio: true });
    expect(listRecordingChunks(db, "s1")[0]).toMatchObject({
      status: "failed",
      settledAt: LATER,
      hasAudio: true,
    });
    // Before the chunk settled: nothing to drop. A pending chunk is never touched.
    expect(purgeRecordingAudio(db, NOW)).toBe(0);
    expect(purgeRecordingAudio(db, LATER)).toBe(1);
    expect(readRecordingChunkAudio(db, "s1", 0)).toBeNull();
    expect(readRecordingChunkAudio(db, "s1", 1)).toEqual(new Uint8Array([8]));
  });

  test("the retention sweep reads only the chunks whose audio is kept", () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN UPDATE recording_chunks SET audio = NULL
          WHERE audio IS NOT NULL AND status != 'pending' AND settled_at <= ?`,
      )
      .all(LATER) as { detail: string }[];
    expect(plan.map((row) => row.detail).join(" ")).toContain("idx_recording_chunks_kept_audio");
  });

  test("a transcript's timed segments are kept with it", () => {
    session("s1");
    chunk("s1", 0, new Uint8Array([7]));
    const segments = [{ startMs: 250, endMs: 1_000, text: "hi" }];
    settleRecordingChunk(db, "s1", 0, { status: "transcribed", text: "hi", segments }, dropAudio);
    expect(listRecordingChunks(db, "s1")[0]!.segments).toEqual(segments);
  });

  test("a chunk table from before timed segments and voices gains their columns at startup", () => {
    session("s1");
    // The table as it first shipped, holding a chunk a phone already sent.
    db.exec(`
      DROP TABLE recording_chunks;
      CREATE TABLE recording_chunks (
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
      INSERT INTO recording_chunks
        (session_id, seq, started_at, duration_ms, audio, mime_type, status, next_attempt_at, received_at)
        VALUES ('s1', 0, '${NOW}', 60000, x'07', 'audio/aac', 'pending', '${NOW}', '${NOW}');
    `);
    db.close();
    db = createDatabase(dbPath);

    expect(listRecordingChunks(db, "s1").map((c) => [c.seq, c.segments, c.voices])).toEqual([
      [0, null, null],
    ]);
    const segments = [{ startMs: 0, endMs: 500, text: "hi" }];
    settleRecordingChunk(db, "s1", 0, { status: "transcribed", text: "hi", segments }, dropAudio);
    expect(listRecordingChunks(db, "s1")[0]!.segments).toEqual(segments);
  });

  test("the device's count is checked against stored chunks inside the write", () => {
    session("s1");
    chunk("s1", 0, new Uint8Array([1]));
    chunk("s1", 1, new Uint8Array([1]));
    expect(finishRecordingSession(db, "s1", 1, NOW, NOW)).toBe("conflict");
    expect(finishRecordingSession(db, "s1", 2, NOW, NOW)).toBe("finished");
    expect(chunk("s1", 2, new Uint8Array([1]))).toBe("beyond");
  });

  test("the projection sweep reads only the sessions whose document is behind", () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT s.* FROM recording_sessions s
          WHERE s.finished_at IS NOT NULL
            AND (s.projected_revision IS NULL OR s.projected_revision < s.revision)
          ORDER BY s.finished_at`,
      )
      .all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join(" ")).toContain("idx_recording_sessions_unprojected");
  });

  test("deleting a session deletes its chunks and marks", () => {
    session("s1");
    chunk("s1", 0, new Uint8Array([1]));
    insertRecordingMark(db, { sessionId: "s1", noteId: "n1", markedAt: NOW });
    expect(deleteRecordingSession(db, "s1")).toBe(true);
    expect(listRecordingChunks(db, "s1")).toEqual([]);
    expect(listRecordingMarks(db, "s1")).toEqual([]);
    expect(deleteRecordingSession(db, "s1")).toBe(false);
  });

  test("a session keeps how it began", () => {
    session("s1");
    session("s2", "ambient");
    expect(getRecordingSession(db, "s1")?.origin).toBe("explicit");
    expect(getRecordingSession(db, "s2")?.origin).toBe("ambient");
  });

  test("a mark is idempotent, may come before its session, and changes the session", () => {
    const mark = { sessionId: "s1", noteId: "n1", markedAt: "2026-03-02T09:05:00.000Z" };
    // The note can reach the gateway before the phone opens the session.
    expect(insertRecordingMark(db, mark)).toBe(true);
    session("s1");
    const before = getRecordingSession(db, "s1")!.revision;
    expect(insertRecordingMark(db, mark)).toBe(false);
    expect(insertRecordingMark(db, { ...mark, noteId: "n0", markedAt: NOW })).toBe(true);
    expect(getRecordingSession(db, "s1")!.revision).toBe(before + 1);
    expect(listRecordingMarks(db, "s1").map((m) => m.noteId)).toEqual(["n0", "n1"]);
  });

  test("a participant is kept once, changes the session only when added or removed, and goes with it", () => {
    expect(addRecordingParticipant(db, "s1", { name: "Maya" }, NOW)).toBe(false);
    session("s1");
    const revision = () => getRecordingSession(db, "s1")!.revision;
    const before = revision();
    expect(addRecordingParticipant(db, "s1", { personId: "p-1" }, NOW)).toBe(true);
    expect(addRecordingParticipant(db, "s1", { name: " Maya Reeves " }, LATER)).toBe(true);
    expect(revision()).toBe(before + 2);
    // The same person, or the same name in another case, is not added again.
    expect(addRecordingParticipant(db, "s1", { personId: "p-1" }, LATER)).toBe(true);
    expect(addRecordingParticipant(db, "s1", { name: "maya reeves" }, LATER)).toBe(true);
    expect(revision()).toBe(before + 2);
    expect(listRecordingParticipants(db, "s1")).toEqual([
      { key: "person:p-1", personId: "p-1", name: null, addedAt: NOW },
      { key: "name:maya reeves", personId: null, name: "Maya Reeves", addedAt: LATER },
    ]);

    expect(removeRecordingParticipant(db, "s1", "person:p-1")).toBe(true);
    expect(removeRecordingParticipant(db, "s1", "person:p-1")).toBe(false);
    expect(revision()).toBe(before + 3);

    expect(deleteRecordingSession(db, "s1")).toBe(true);
    expect(listRecordingParticipants(db, "s1")).toEqual([]);
  });
});

describe("the owner's voice in recording storage", () => {
  const windows = (speakers: number[]) =>
    speakers.map((speaker, i) => ({ startMs: i * 1_000, endMs: i * 1_000 + 900, speaker }));

  test("keeps one profile, replaced by the next and deleted on request", () => {
    expect(getRecordingVoiceProfile(db)).toBeNull();
    setRecordingVoiceProfile(db, {
      model: "m1",
      vector: Float32Array.from([0.6, 0.8]),
      speechMs: 25_000,
      enrolledAt: NOW,
    });
    setRecordingVoiceProfile(db, {
      model: "m2",
      vector: Float32Array.from([1, 0]),
      speechMs: 30_000,
      enrolledAt: LATER,
    });
    expect(getRecordingVoiceProfile(db)).toEqual({
      model: "m2",
      vector: Float32Array.from([1, 0]),
      speechMs: 30_000,
      enrolledAt: LATER,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM recording_voice_profile").get()).toEqual({ n: 1 });
    expect(deleteRecordingVoiceProfile(db)).toBe(true);
    expect(deleteRecordingVoiceProfile(db)).toBe(false);
    expect(getRecordingVoiceProfile(db)).toBeNull();
  });

  test("a recognised speaker is the owner until the owner says otherwise, then never again", () => {
    const id = randomUUID();
    session(id);
    assignRecordingVoices(db, id, [{ seq: 0, windows: windows([1, 2]) }], [2]);
    expect(listRecordingSpeakers(db, id).map((s) => [s.speaker, s.isSelf, s.selfMatch])).toEqual([
      [1, false, null],
      [2, true, "matched"],
    ]);

    // Confirming it as the owner makes it the owner's own mapping.
    expect(setRecordingSpeaker(db, id, 2, { kind: "self" })).toBe(true);
    expect(listRecordingSpeakers(db, id)[1]).toMatchObject({ isSelf: true, selfMatch: null });

    // A later grouping recognises a new speaker; the owner clears it.
    assignRecordingVoices(db, id, [{ seq: 1, windows: windows([3]) }], [3]);
    expect(listRecordingSpeakers(db, id)[2]).toMatchObject({ isSelf: true, selfMatch: "matched" });
    expect(setRecordingSpeaker(db, id, 3, { kind: "clear" })).toBe(true);
    expect(listRecordingSpeakers(db, id)[2]).toMatchObject({
      isSelf: false,
      selfMatch: "rejected",
    });

    // Nothing in this session is recognised again, nor is an existing speaker remapped.
    assignRecordingVoices(db, id, [{ seq: 2, windows: windows([1, 4]) }], [1, 4]);
    expect(listRecordingSpeakers(db, id).map((s) => [s.speaker, s.isSelf, s.selfMatch])).toEqual([
      [1, false, null],
      [2, true, null],
      [3, false, "rejected"],
      [4, false, null],
    ]);
  });

  test("an existing speaker table gains the recognition column on upgrade", () => {
    // The tables as a gateway from before the column left them.
    const old = new Sqlite(":memory:");
    createRecordingTables(old);
    old.exec(`
      ALTER TABLE recording_speakers DROP COLUMN self_match;
      DROP TABLE recording_voice_profile;
      INSERT INTO recording_sessions (id, started_at, last_activity_at, created_at)
        VALUES ('s', '${NOW}', '${NOW}', '${NOW}');
      INSERT INTO recording_speakers (session_id, speaker, is_self) VALUES ('s', 1, 1);
    `);
    try {
      createRecordingTables(old);
      createRecordingTables(old);
      expect(listRecordingSpeakers(old, "s")).toEqual([
        { sessionId: "s", speaker: 1, personId: null, isSelf: true, name: null, selfMatch: null },
      ]);
      expect(getRecordingVoiceProfile(old)).toBeNull();
    } finally {
      old.close();
    }
  });
});
