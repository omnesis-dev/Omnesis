// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDatabase } from "../db.js";
import { insertNoteEntry } from "../sources/omnesis-notes/storage.js";
import {
  OMNESIS_NOTES_PROVIDER_ID,
  OMNESIS_NOTES_SOURCE_ID,
} from "../sources/omnesis-notes/index.js";
import { documentsAwaitingTranscription, insertPendingVoiceNote } from "./storage.js";
import type Database from "better-sqlite3";

const DAY = "2026-09-30";
const AT = "2026-09-30T10:00:00.000Z";

let dbPath: string;
let db: Database.Database;

function seedDayDocument(id: string, day: string): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', ?, '{}', ?, ?, ?, ?)`,
  ).run(
    id,
    OMNESIS_NOTES_PROVIDER_ID,
    OMNESIS_NOTES_SOURCE_ID,
    day,
    day,
    `h-${id}`,
    AT,
    AT,
    AT,
    AT,
  );
}

function seedVoiceNote(day: string, queuedAt: string): void {
  const id = randomUUID();
  insertNoteEntry(db, {
    id,
    day,
    capturedAt: AT,
    updatedAt: AT,
    capturedTimeZoneId: null,
    capturedUtcOffsetSeconds: null,
    receivedAt: AT,
    text: "pick up the dry cleaning",
    surface: "ios-app",
    deviceId: null,
    latitude: null,
    longitude: null,
    placeName: null,
  });
  insertPendingVoiceNote(db, {
    noteId: id,
    audio: new Uint8Array([1, 2, 3]),
    mimeType: "audio/mp4",
    language: "en",
    savedText: "pick up the dry cleaning",
    placeholder: false,
    nextAttemptAt: queuedAt,
    createdAt: queuedAt,
  });
}

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

describe("documentsAwaitingTranscription", () => {
  test("names the notes days that hold a voice note still being transcribed", () => {
    seedDayDocument("doc-pending", DAY);
    seedDayDocument("doc-quiet", "2026-09-29");
    seedVoiceNote(DAY, AT);
    expect(documentsAwaitingTranscription(db, ["doc-pending", "doc-quiet"])).toEqual(
      new Set(["doc-pending"]),
    );
  });

  test("a bounded reader counts only recordings queued since its cutoff", () => {
    seedDayDocument("doc-pending", DAY);
    seedVoiceNote(DAY, "2026-09-30T08:00:00.000Z");
    expect(
      documentsAwaitingTranscription(db, ["doc-pending"], {
        queuedAfter: "2026-09-30T09:00:00.000Z",
      }),
    ).toEqual(new Set());
    expect(
      documentsAwaitingTranscription(db, ["doc-pending"], {
        queuedAfter: "2026-09-30T07:00:00.000Z",
      }),
    ).toEqual(new Set(["doc-pending"]));
  });
});
