// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The voice-note queue against a real database and notes runtime, with a
 * scripted transcriber and a controllable clock: saved at once, transcribed
 * later, retried, abandoned, and never overwriting a user's edit.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import { bootOmnesisNotes, type OmnesisNotesRuntime } from "../sources/omnesis-notes/index.js";
import { getPendingVoiceNote, listDuePendingVoiceNotes } from "./storage.js";
import {
  MAX_AGE_MS,
  MAX_ATTEMPTS,
  TRANSCRIBING_PLACEHOLDER,
  UNTRANSCRIBED_TEXT,
  VoiceNoteService,
  type VoiceNoteInput,
} from "./service.js";
import type { TranscriberReadiness } from "../transcribe/index.js";
import type { TranscriptionResult } from "@omnesis/core";
import type Database from "better-sqlite3";

let dbPath: string;
let db: Database.Database;
let notes: OmnesisNotesRuntime;
let service: VoiceNoteService;
let now: Date;
let readiness: TranscriberReadiness;
let transcripts: (TranscriptionResult | null)[];
let calls: { mimeType: string; language?: string; bytes: number }[];
/** While set, a transcription waits until `release` is called. */
let held: Promise<void> | null;
let release: () => void;

function hold(): void {
  held = new Promise((resolve) => {
    release = () => {
      held = null;
      resolve();
    };
  });
}

const audio = () => new TextEncoder().encode("fake-audio");

function voiceNote(overrides: Partial<VoiceNoteInput> = {}): VoiceNoteInput {
  return {
    id: randomUUID(),
    fallbackText: "pick up the dry cleaning",
    audio: audio(),
    mimeType: "audio/mp4",
    language: "en",
    surface: "ios-app",
    ...overrides,
  };
}

function noteText(id: string): string | undefined {
  return notes.listDay().find((entry) => entry.id === id)?.text;
}

async function pass(): Promise<void> {
  service.kick();
  await service.idle();
}

function advance(ms: number): void {
  now = new Date(now.getTime() + ms);
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  const gate = directWriteGate(db);
  notes = bootOmnesisNotes({
    writeGate: gate,
    readDb: db,
    ingest: async () => {},
    deleteByIds: async () => {},
    debounceMs: 0,
  });
  now = new Date();
  readiness = { runnable: true };
  transcripts = [];
  calls = [];
  held = null;
  service = new VoiceNoteService({
    notes: () => notes,
    writeGate: gate,
    readDb: db,
    transcribe: async (bytes, mimeType, opts) => {
      calls.push({ mimeType, language: opts?.language, bytes: bytes.byteLength });
      if (held) await held;
      return transcripts.length > 0 ? transcripts.shift()! : null;
    },
    readiness: () => readiness,
    now: () => now,
  });
});

afterEach(async () => {
  service.dispose();
  await service.idle();
  await notes.flushAll();
  notes.dispose();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("VoiceNoteService", () => {
  test("saves the note at once with the device's transcript, then replaces it with the gateway's", async () => {
    const input = voiceNote();
    transcripts.push({ text: " Pick up the dry cleaning at five. " });
    hold();
    await service.accept(input);
    expect(noteText(input.id)).toBe("pick up the dry cleaning");

    release();
    await service.idle();
    expect(noteText(input.id)).toBe("Pick up the dry cleaning at five.");
    expect(calls).toEqual([{ mimeType: "audio/mp4", language: "en", bytes: audio().byteLength }]);
    expect(getPendingVoiceNote(db, input.id)).toBeNull();
  });

  test("a note without a device transcript shows a placeholder until transcribed", async () => {
    const input = voiceNote({ fallbackText: "  " });
    transcripts.push({ text: "Call the plumber" });
    hold();
    await service.accept(input);
    expect(noteText(input.id)).toBe(TRANSCRIBING_PLACEHOLDER);
    release();
    await service.idle();
    expect(noteText(input.id)).toBe("Call the plumber");
  });

  test("an edit made before the transcript lands wins", async () => {
    const input = voiceNote();
    transcripts.push({ text: "Pick up the dry cleaning" });
    hold();
    await service.accept(input);
    await notes.edit(input.id, "pick up the dry cleaning tomorrow");

    release();
    await service.idle();
    expect(noteText(input.id)).toBe("pick up the dry cleaning tomorrow");
    expect(getPendingVoiceNote(db, input.id)).toBeNull();
  });

  test("a retried capture neither duplicates the note nor queues the audio twice", async () => {
    const input = voiceNote();
    transcripts.push({ text: "Pick up the dry cleaning" });
    hold();
    await service.accept(input);
    await service.accept(input);
    expect(notes.listDay().filter((entry) => entry.id === input.id)).toHaveLength(1);
    expect(listDuePendingVoiceNotes(db, now.toISOString(), 10)).toHaveLength(1);

    release();
    await service.idle();
    expect(calls).toHaveLength(1);
    // Once transcribed, a late retry of the same capture queues nothing.
    await service.accept(input);
    expect(getPendingVoiceNote(db, input.id)).toBeNull();
    expect(noteText(input.id)).toBe("Pick up the dry cleaning");
  });

  test("a failed transcription is retried with backoff, then the device's transcript is kept", async () => {
    const input = voiceNote();
    await service.accept(input);
    await service.idle();
    expect(getPendingVoiceNote(db, input.id)?.attempts).toBe(1);
    // Not due again until the backoff has passed.
    await pass();
    expect(calls).toHaveLength(1);

    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      advance(24 * 60 * 60 * 1000);
      await pass();
    }
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    expect(getPendingVoiceNote(db, input.id)).toBeNull();
    expect(noteText(input.id)).toBe("pick up the dry cleaning");
  });

  test("a placeholder note that cannot be transcribed says so", async () => {
    const input = voiceNote({ fallbackText: "" });
    await service.accept(input);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await pass();
      advance(24 * 60 * 60 * 1000);
    }
    expect(noteText(input.id)).toBe(UNTRANSCRIBED_TEXT);
  });

  test("silence is final: a placeholder note says it could not be transcribed", async () => {
    const input = voiceNote({ fallbackText: "" });
    transcripts.push({ text: "   " });
    await service.accept(input);
    await pass();
    expect(noteText(input.id)).toBe(UNTRANSCRIBED_TEXT);
    expect(getPendingVoiceNote(db, input.id)).toBeNull();
  });

  test("time without a runnable transcriber costs no attempts, only age", async () => {
    const input = voiceNote();
    readiness = { runnable: false, reason: "No transcriber model is assigned." };
    await service.accept(input);
    await pass();
    expect(calls).toHaveLength(0);
    expect(getPendingVoiceNote(db, input.id)?.attempts).toBe(0);

    readiness = { runnable: true };
    advance(60 * 60 * 1000);
    transcripts.push({ text: "Pick up the dry cleaning" });
    await pass();
    expect(noteText(input.id)).toBe("Pick up the dry cleaning");
  });

  test("a note that waited past the age limit keeps its saved text", async () => {
    const input = voiceNote();
    readiness = { runnable: false };
    await service.accept(input);
    advance(MAX_AGE_MS + 1);
    await pass();
    expect(getPendingVoiceNote(db, input.id)).toBeNull();
    expect(noteText(input.id)).toBe("pick up the dry cleaning");
  });

  test("deleting the note deletes its audio, even mid-transcription", async () => {
    const input = voiceNote();
    transcripts.push({ text: "Pick up the dry cleaning" });
    hold();
    await service.accept(input);
    expect(getPendingVoiceNote(db, input.id)).not.toBeNull();
    await notes.remove(input.id);
    expect(getPendingVoiceNote(db, input.id)).toBeNull();

    release();
    await service.idle();
    expect(noteText(input.id)).toBeUndefined();
    expect(getPendingVoiceNote(db, input.id)).toBeNull();
  });

  test("notes queued before a restart are picked up when the queue starts", async () => {
    const input = voiceNote();
    service.dispose();
    await service.accept(input);
    const restarted = new VoiceNoteService({
      notes: () => notes,
      writeGate: directWriteGate(db),
      readDb: db,
      transcribe: async () => ({ text: "Pick up the dry cleaning" }),
      readiness: () => ({ runnable: true }),
      now: () => now,
    });
    restarted.start();
    await restarted.idle();
    restarted.dispose();
    expect(noteText(input.id)).toBe("Pick up the dry cleaning");
  });
});
