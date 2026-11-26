// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import Database from "better-sqlite3";
import { ConfigStore } from "../config-store.js";
import { createRecordingTables } from "./storage.js";
import {
  recordingRestoreReview,
  resumeRecordingRestoreReview,
  hasPendingRecordingChunks,
} from "./restore-review.js";

test("review reports actual deletion/model choices and rejects stale confirmation under config mutex", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-recording-review-"));
  const store = new ConfigStore({ filePath: join(directory, "omnesis.json") });
  try {
    await store.load();
    await store.patch({
      inference: {
        assignments: { transcriber: null },
        recordings: { restoreReviewRequired: true, speakers: "local", keepAudioDays: 0 },
      },
    });
    const before = recordingRestoreReview(store.get(), false);
    expect(before).toMatchObject({
      reviewRequired: true,
      keepAudioDays: 0,
      transcriberAssignment: null,
      speakers: "local",
    });
    await store.patch({ inference: { recordings: { keepAudioDays: 14 } } });
    await expect(resumeRecordingRestoreReview(store, before.version, () => false)).rejects.toThrow(
      "choices changed",
    );
    expect(recordingRestoreReview(store.get(), false).reviewRequired).toBe(true);
    await resumeRecordingRestoreReview(
      store,
      recordingRestoreReview(store.get(), false).version,
      () => false,
    );
    expect(recordingRestoreReview(store.get(), false)).toMatchObject({
      reviewRequired: false,
      keepAudioDays: 14,
    });
  } finally {
    store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unassigned transcription stays disabled and cannot resume pending audio", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-recording-unassigned-"));
  const store = new ConfigStore({ filePath: join(directory, "omnesis.json") });
  try {
    await store.load();
    await store.patch({ inference: { recordings: { restoreReviewRequired: true } } });
    const review = recordingRestoreReview(store.get(), true);
    expect(review.transcriberAssignment).toBeNull();
    await expect(resumeRecordingRestoreReview(store, review.version, () => true)).rejects.toThrow(
      "Choose a transcription model",
    );
  } finally {
    store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pending audio cannot resume with disabled transcription, and newly pending work invalidates review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-recording-pending-"));
  const store = new ConfigStore({ filePath: join(directory, "omnesis.json") });
  try {
    await store.load();
    await store.patch({
      inference: {
        assignments: { transcriber: null },
        recordings: { restoreReviewRequired: true },
      },
    });
    const complete = recordingRestoreReview(store.get(), false);
    await expect(resumeRecordingRestoreReview(store, complete.version, () => true)).rejects.toThrow(
      "choices changed",
    );
    const pending = recordingRestoreReview(store.get(), true);
    await expect(resumeRecordingRestoreReview(store, pending.version, () => true)).rejects.toThrow(
      "Choose a transcription model",
    );
    expect(store.get().inference?.recordings?.restoreReviewRequired).toBe(true);
    await resumeRecordingRestoreReview(store, complete.version, () => false);
    expect(store.get().inference?.recordings?.restoreReviewRequired).toBe(false);
  } finally {
    store.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pending metadata uses the existing status index without reading media", () => {
  const db = new Database(":memory:");
  try {
    createRecordingTables(db);
    expect(hasPendingRecordingChunks(db)).toBe(false);
    db.prepare(
      "INSERT INTO recording_sessions(id,started_at,last_activity_at,created_at) VALUES('invented-session','2026-01-01','2026-01-01','2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO recording_chunks(session_id,seq,started_at,duration_ms,status,next_attempt_at,received_at) VALUES('invented-session',0,'2026-01-01',1000,'pending','2026-01-01','2026-01-01')",
    ).run();
    expect(hasPendingRecordingChunks(db)).toBe(true);
    expect(
      db
        .prepare("EXPLAIN QUERY PLAN SELECT 1 FROM recording_chunks WHERE status='pending' LIMIT 1")
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining("idx_recording_chunks_due") }),
      ]),
    );
  } finally {
    db.close();
  }
});
