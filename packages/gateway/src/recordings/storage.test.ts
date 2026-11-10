// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDatabase } from "../db.js";
import {
  deleteRecordingSession,
  finishRecordingSession,
  getRecordingSession,
  insertRecordingChunk,
  insertRecordingSession,
  listRecordingChunks,
  readRecordingChunkAudio,
  settleRecordingChunk,
} from "./storage.js";
import type Database from "better-sqlite3";

let dbPath: string;
let db: Database.Database;
const NOW = "2026-03-02T09:00:00.000Z";

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function session(id: string): boolean {
  return insertRecordingSession(db, {
    id,
    deviceId: null,
    title: null,
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
    expect(settleRecordingChunk(db, "s1", 1, { status: "transcribed", text: "hi" })).toBe(true);
    expect(settleRecordingChunk(db, "s1", 1, { status: "failed" })).toBe(false);
    expect(readRecordingChunkAudio(db, "s1", 1)).toBeNull();
    expect(listRecordingChunks(db, "s1")[1]).toMatchObject({ status: "transcribed", text: "hi" });
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

  test("deleting a session deletes its chunks", () => {
    session("s1");
    chunk("s1", 0, new Uint8Array([1]));
    expect(deleteRecordingSession(db, "s1")).toBe(true);
    expect(listRecordingChunks(db, "s1")).toEqual([]);
    expect(deleteRecordingSession(db, "s1")).toBe(false);
  });
});
