// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The recorded-conversation queue against a real database, with a scripted
 * transcriber and a controllable clock: chunks transcribed as they arrive,
 * one document per finished session, retries, give-ups, sessions abandoned
 * by their device, and deletion racing transcription.
 */

import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createFreshTestDatabase } from "../testing/fresh-database.js";
import { directWriteGate } from "../write-gate.js";
import { buildRecordingDocument } from "../sources/omnesis-recordings/index.js";
import { findOrCreatePerson } from "../people.js";
import {
  ABANDONED_AFTER_MS,
  MAX_ATTEMPTS,
  MIN_ENROLMENT_SPEECH_MS,
  MISSING_GRACE_MS,
  RecordingTranscriptionService,
  type RecordingChunkInput,
} from "./service.js";
import { getRecordingChunk, getRecordingVoiceProfile, readRecordingChunkAudio } from "./storage.js";
import { ReplayVoiceSeparator } from "./voices/replay-voice-separator.js";
import type { VoiceSeparator } from "./voices/voices.js";
import type { CalendarEventCandidate } from "./suggestions.js";
import type {
  TranscriberReadiness,
  TranscribeOptions,
  TranscriptionOutcome,
} from "../transcribe/index.js";
import type { TranscriptionResult } from "@omnesis/core";
import type { DocumentInput } from "@omnesis/types";
import type Database from "better-sqlite3";

let dbPath: string;
let db: Database.Database;
let service: RecordingTranscriptionService;
let now: Date;
let readiness: TranscriberReadiness;
/**
 * Scripted transcriber answers, in call order: a result is a transcript, an
 * outcome is returned as is, an Error is thrown, and null or an empty queue
 * is a failed run.
 */
let transcripts: (TranscriptionResult | TranscriptionOutcome | Error | null)[];
/** Documents whose ingest throws. */
let failingIngest: Set<string>;
let calls: { mimeType: string; opts?: TranscribeOptions }[];
let docs: Map<string, DocumentInput>;
let held: Promise<void> | null;
let separator: VoiceSeparator | null;
let release: () => void;
/** The operator's `inference.recordings.keepAudioDays`. */
let keepDays: number;
/** The operator's `inference.recordings.selfVoice`. */
let selfVoice: "off" | "match";
/** What the owner's calendar holds for any window; a function to see the window asked for. */
let calendar: (from: string, to: string) => CalendarEventCandidate[];
/** While set, storing the owner's voice waits for `until`; `reached` once it does. */
let voiceWrite: { until: Promise<void>; reached: boolean } | null;

const START = "2026-03-02T09:00:00.000Z";
const at = (offsetMs: number) => new Date(Date.parse(START) + offsetMs).toISOString();

function hold(): void {
  held = new Promise((resolve) => {
    release = () => {
      held = null;
      resolve();
    };
  });
}

async function pass(): Promise<void> {
  service.kick();
  await service.idle();
}

function advance(ms: number): void {
  now = new Date(now.getTime() + ms);
}

async function start(
  id = randomUUID(),
  title?: string,
  origin?: "explicit" | "ambient",
): Promise<string> {
  await service.startSession({
    id,
    ...(title ? { title } : {}),
    ...(origin ? { origin } : {}),
    startedAt: START,
    startedUtcOffsetSeconds: 3600,
    language: "en",
    allowVocabulary: true,
  });
  return id;
}

function chunk(sessionId: string, seq: number, overrides: Partial<RecordingChunkInput> = {}) {
  return {
    sessionId,
    seq,
    startedAt: at(seq * 60_000),
    durationMs: 60_000,
    silent: false,
    interrupted: false,
    audio: new TextEncoder().encode(`audio-${seq}`),
    mimeType: "audio/aac",
    ...overrides,
  } satisfies RecordingChunkInput;
}

beforeEach(() => {
  dbPath = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
  db = createFreshTestDatabase(dbPath);
  now = new Date(at(10 * 60_000));
  readiness = { runnable: true };
  transcripts = [];
  calls = [];
  docs = new Map();
  failingIngest = new Set();
  held = null;
  separator = null;
  keepDays = 0;
  selfVoice = "off";
  calendar = () => [];
  voiceWrite = null;
  const writeGate = directWriteGate(db);
  service = new RecordingTranscriptionService({
    writeGate: {
      ...writeGate,
      setRecordingVoiceProfile: async (profile) => {
        if (voiceWrite) {
          voiceWrite.reached = true;
          await voiceWrite.until;
        }
        return writeGate.setRecordingVoiceProfile(profile);
      },
    },
    readDb: db,
    transcribe: async (_audio, mimeType, opts) => {
      calls.push({ mimeType, opts });
      if (held) await held;
      const next = transcripts.length > 0 ? transcripts.shift()! : null;
      if (next instanceof Error) throw next;
      if (next === null) return { kind: "failed" };
      if ("kind" in next) return next;
      return { kind: "transcribed", result: next };
    },
    readiness: async () => readiness,
    ingest: async (input) => {
      for (const doc of input) {
        if (failingIngest.has(doc.externalId)) throw new Error("disk full");
        docs.set(doc.externalId, doc);
      }
    },
    deleteDocument: async (externalId) => {
      docs.delete(externalId);
    },
    buildDocument: buildRecordingDocument,
    voices: () => separator,
    keepAudioDays: () => keepDays,
    selfVoice: () => selfVoice,
    calendarEvents: async (from, to) => calendar(from, to),
    now: () => now,
  });
});

afterEach(async () => {
  service.dispose();
  await service.idle();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("RecordingTranscriptionService", () => {
  test("transcribes chunks as they arrive and writes one document once the session is finished", async () => {
    const id = await start(undefined, "Q4 budget review");

    transcripts.push({ text: " Let's start with the travel budget. " });
    await service.addChunk(chunk(id, 0));
    await service.idle();
    // Transcribed at background priority, with the session's language.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts).toMatchObject({
      priority: "background",
      language: "en",
      allowVocabulary: true,
      segments: true,
      context: { purpose: "source-audio" },
    });
    // The audio is gone once the chunk is settled; the transcript stays.
    expect(readRecordingChunkAudio(db, id, 0)).toBeNull();
    expect(getRecordingChunk(db, id, 0)).toMatchObject({ status: "transcribed" });
    // Nothing is written while the device is still recording.
    expect(docs.size).toBe(0);
    expect(service.status(id)?.state).toBe("recording");

    transcripts.push({ text: "Agreed, we cut it by ten percent." });
    await service.addChunk(chunk(id, 1));
    expect(await service.finish(id, 2, at(120_000))).toBe("finished");
    await service.idle();

    const doc = docs.get(id)!;
    expect(doc.title).toBe("Q4 budget review");
    expect(doc.content).toContain("[00:00:00] Let's start with the travel budget.");
    expect(doc.content).toContain("[00:01:00] Agreed, we cut it by ten percent.");
    expect(doc.metadata.documentType).toBe("conversation");
    expect(doc.metadata.people).toEqual([{ name: "You", role: "participant", isSelf: true }]);
    expect(service.status(id)).toMatchObject({
      state: "done",
      chunkCount: 2,
      chunks: { received: 2, transcribed: 2, pending: 0 },
    });
  });

  test("a marked moment is written into the episode, also after it was written", async () => {
    const id = await start(undefined, undefined, "ambient");
    transcripts.push({ text: "We should book the venue by Friday." });
    await service.addChunk(chunk(id, 0));
    await service.finish(id, 1, at(60_000));
    await service.idle();
    expect(docs.get(id)!.content).toContain("Conversation captured by a wearable");
    expect(docs.get(id)!.metadata.extra).toEqual({ recordingOrigin: "ambient" });
    expect(docs.get(id)!.content).not.toContain("★");

    // The note's upload can land after the session's document was written.
    const noteId = randomUUID();
    await service.mark(id, noteId, at(45_000));
    await service.mark(id, noteId, at(45_000));
    await service.idle();
    const doc = docs.get(id)!;
    expect(doc.content.split("\n").slice(-2)).toEqual([
      "[00:00:00] We should book the venue by Friday.",
      "[00:00:45] ★ Marked moment, saved as a note",
    ]);
    expect(doc.metadata.extra).toEqual({ recordingOrigin: "ambient", markedMoments: 1 });
  });

  test("keeps the transcriber's segment timings in the document", async () => {
    const id = await start();
    transcripts.push({
      text: "Morning. Coffee first?",
      segments: [
        { startMs: 1_000, endMs: 2_000, text: "Morning." },
        { startMs: 31_000, endMs: 32_500, text: "Coffee first?" },
      ],
    });
    await service.addChunk(chunk(id, 0));
    await service.finish(id, 1, at(60_000));
    await service.idle();
    expect(docs.get(id)!.content).toContain("[00:00:01] Morning.\n[00:00:31] Coffee first?");
  });

  test("a retried start, chunk or finish changes nothing", async () => {
    const id = await start();
    expect(await service.startSession({ id, startedAt: START, allowVocabulary: false })).toEqual({
      created: false,
    });
    transcripts.push({ text: "hello" });
    expect(await service.addChunk(chunk(id, 0))).toBe("stored");
    expect(await service.addChunk(chunk(id, 0))).toBe("duplicate");
    expect(await service.finish(id, 1, at(60_000))).toBe("finished");
    expect(await service.finish(id, 1, at(60_000))).toBe("already");
    expect(await service.finish(id, 3, at(60_000))).toBe("conflict");
    await service.idle();
    expect(calls).toHaveLength(1);
  });

  test("refuses a chunk for an unknown session or past the declared count", async () => {
    expect(await service.addChunk(chunk(randomUUID(), 0))).toBe("missing");
    const id = await start();
    await service.finish(id, 1, at(60_000));
    expect(await service.addChunk(chunk(id, 1))).toBe("beyond");
  });

  test("a finish declaring fewer chunks than already arrived is a conflict", async () => {
    const id = await start();
    transcripts.push({ text: "a" }, { text: "b" }, { text: "c" });
    await service.addChunk(chunk(id, 0));
    await service.addChunk(chunk(id, 2));
    expect(await service.finish(id, 2, at(180_000))).toBe("conflict");
  });

  test("silent chunks are never transcribed and render as one silence line", async () => {
    const id = await start();
    transcripts.push({ text: "Before the break." }, { text: "After the break." });
    await service.addChunk(chunk(id, 0));
    for (const seq of [1, 2, 3]) {
      await service.addChunk(chunk(id, seq, { silent: true, audio: null, mimeType: null }));
    }
    await service.addChunk(chunk(id, 4));
    await service.finish(id, 5, at(300_000));
    await service.idle();
    expect(calls).toHaveLength(2);
    const content = docs.get(id)!.content;
    expect(content).toContain("[00:01:00] — silence, 3 min —");
    expect(content).toContain("[00:04:00] After the break.");
  });

  test("chunks arriving out of order are written in recording order, after the last one", async () => {
    const id = await start();
    transcripts.push({ text: "second" }, { text: "first" });
    await service.addChunk(chunk(id, 1));
    await service.finish(id, 2, at(120_000));
    await service.idle();
    // Chunk 0 has not arrived: nothing is written yet.
    expect(docs.size).toBe(0);
    expect(service.status(id)?.state).toBe("transcribing");

    await service.addChunk(chunk(id, 0));
    await service.idle();
    const content = docs.get(id)!.content;
    expect(content.indexOf("first")).toBeLessThan(content.indexOf("second"));
  });

  test("a failed transcription is retried with backoff, then given up on", async () => {
    const id = await start();
    await service.addChunk(chunk(id, 0));
    await service.finish(id, 1, at(60_000));
    await service.idle();
    expect(calls).toHaveLength(1);
    expect(getRecordingChunk(db, id, 0)).toMatchObject({ status: "pending", attempts: 1 });

    // Not due again before its backoff.
    await pass();
    expect(calls).toHaveLength(1);

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      advance(13 * 60 * 60 * 1000);
      await pass();
    }
    expect(calls).toHaveLength(MAX_ATTEMPTS);
    expect(getRecordingChunk(db, id, 0)).toMatchObject({ status: "failed" });
    expect(readRecordingChunkAudio(db, id, 0)).toBeNull();
    // A session with no understood speech is not worth a document.
    expect(docs.size).toBe(0);
    expect(service.status(id)?.state).toBe("done");
  });

  test("a failed chunk is named in the document beside the ones that worked", async () => {
    const id = await start();
    transcripts.push({ text: "This part was heard." });
    await service.addChunk(chunk(id, 0));
    await service.idle();
    await service.addChunk(chunk(id, 1));
    await service.finish(id, 2, at(120_000));
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      advance(13 * 60 * 60 * 1000);
      await pass();
    }
    expect(docs.get(id)!.content).toContain("[00:01:00] — this part could not be transcribed —");
  });

  test("while no transcriber can run, chunks wait without spending attempts", async () => {
    readiness = { runnable: false, reason: "no model" };
    const id = await start();
    await service.addChunk(chunk(id, 0));
    await service.idle();
    expect(calls).toHaveLength(0);
    expect(getRecordingChunk(db, id, 0)).toMatchObject({ status: "pending", attempts: 0 });

    readiness = { runnable: true };
    transcripts.push({ text: "finally" });
    advance(31 * 60_000);
    await pass();
    expect(getRecordingChunk(db, id, 0)).toMatchObject({ status: "transcribed" });
  });

  test("a session its device stopped talking to is finished with the chunks it sent", async () => {
    const id = await start();
    transcripts.push({ text: "only part" });
    await service.addChunk(chunk(id, 0));
    await service.idle();
    expect(docs.size).toBe(0);

    advance(ABANDONED_AFTER_MS + 60_000);
    await pass();
    expect(service.status(id)).toMatchObject({ state: "done", chunkCount: 1 });
    expect(docs.get(id)!.content).toContain("only part");
  });

  test("a device back after the gateway finished its session for it loses nothing", async () => {
    const id = await start();
    transcripts.push({ text: "before the drive home" });
    await service.addChunk(chunk(id, 0, { durationMs: 45_000 }));
    advance(ABANDONED_AFTER_MS + 60_000);
    await pass();
    // Finished for the device, ending where its last chunk ends.
    expect(service.status(id)).toMatchObject({ state: "done", chunkCount: 1 });
    const db0 = db
      .prepare<[string], { ended_at: string }>(
        `SELECT ended_at FROM recording_sessions WHERE id = ?`,
      )
      .get(id)!;
    expect(db0.ended_at).toBe(at(45_000));

    // The phone reaches Wi-Fi a day later with the rest of the recording.
    transcripts.push({ text: "after the break" });
    expect(await service.addChunk(chunk(id, 1))).toBe("stored");
    await service.idle();
    expect(service.status(id)).toMatchObject({ state: "recording", chunkCount: null });
    expect(await service.finish(id, 2, at(120_000))).toBe("finished");
    await service.idle();
    expect(service.status(id)).toMatchObject({ state: "done", chunkCount: 2 });
    expect(docs.get(id)!.content).toContain("after the break");
  });

  test("the device's own finish replaces the count the gateway declared for it", async () => {
    const id = await start();
    transcripts.push({ text: "one" });
    await service.addChunk(chunk(id, 0));
    advance(ABANDONED_AFTER_MS + 60_000);
    await pass();
    expect(service.status(id)?.chunkCount).toBe(1);
    // The phone never uploaded its second chunk but knows it recorded it.
    expect(await service.finish(id, 2, at(120_000))).toBe("finished");
    expect(await service.finish(id, 3, at(180_000))).toBe("conflict");
    expect(service.status(id)?.chunkCount).toBe(2);
  });

  test("audio that decodes to nothing is given up on at once", async () => {
    const id = await start();
    transcripts.push({ kind: "unreadable" });
    await service.addChunk(chunk(id, 0));
    await service.idle();
    expect(calls).toHaveLength(1);
    expect(getRecordingChunk(db, id, 0)).toMatchObject({ status: "failed", attempts: 0 });
  });

  test("a transcriber gone mid-run spends no attempt", async () => {
    const id = await start();
    transcripts.push({ kind: "unavailable" });
    await service.addChunk(chunk(id, 0));
    await service.idle();
    expect(getRecordingChunk(db, id, 0)).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("a transcriber that throws backs the chunk off instead of holding the queue", async () => {
    const id = await start();
    transcripts.push(new Error("boom"), { text: "second" });
    await service.addChunk(chunk(id, 0));
    await service.addChunk(chunk(id, 1));
    await service.idle();
    // The throwing chunk counted an attempt and waits; the next one went on.
    expect(getRecordingChunk(db, id, 0)).toMatchObject({ status: "pending", attempts: 1 });
    expect(getRecordingChunk(db, id, 1)).toMatchObject({ status: "transcribed" });
  });

  test("a document that cannot be written does not hold the other sessions", async () => {
    const stuck = await start();
    const fine = await start();
    failingIngest.add(stuck);
    transcripts.push({ text: "stuck" }, { text: "fine" });
    await service.addChunk(chunk(stuck, 0));
    await service.finish(stuck, 1, at(60_000));
    await service.idle();
    await service.addChunk(chunk(fine, 0));
    await service.finish(fine, 1, at(60_000));
    await service.idle();
    expect(docs.has(fine)).toBe(true);
    expect(service.status(stuck)?.state).toBe("transcribing");

    failingIngest.clear();
    await pass();
    expect(service.status(stuck)?.state).toBe("done");
  });

  test("a finished session still missing chunks is written with the gap after the grace period", async () => {
    const id = await start();
    transcripts.push({ text: "opening" }, { text: "closing" });
    await service.addChunk(chunk(id, 0));
    await service.addChunk(chunk(id, 2));
    await service.finish(id, 3, at(180_000));
    await service.idle();
    expect(docs.size).toBe(0);

    advance(MISSING_GRACE_MS + 60_000);
    await pass();
    const content = docs.get(id)!.content;
    expect(content).toContain("— a part of the recording did not arrive —");

    // The late chunk still lands, and the document is written again.
    transcripts.push({ text: "middle" });
    await service.addChunk(chunk(id, 1));
    await service.idle();
    expect(docs.get(id)!.content).not.toContain("did not arrive");
    expect(docs.get(id)!.content).toContain("middle");
  });

  test("deleting a session mid-transcription leaves no chunk and no document", async () => {
    const id = await start();
    await service.addChunk(chunk(id, 0, {}));
    hold();
    transcripts.push({ text: "secret" });
    service.kick();
    // The transcription is in flight; delete underneath it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await service.delete(id)).toBe(true);
    release();
    await service.idle();
    expect(getRecordingChunk(db, id, 0)).toBeNull();
    expect(docs.size).toBe(0);
    expect(service.status(id)).toBeNull();
    expect(await service.delete(id)).toBe(false);
  });
});

describe("RecordingTranscriptionService kept audio", () => {
  const DAY = 24 * 60 * 60 * 1000;

  test("by default the audio is gone once a chunk is settled, and nothing can be played", async () => {
    const id = await start();
    transcripts.push({ text: "hello" });
    await service.addChunk(chunk(id, 0));
    await service.idle();
    expect(service.chunks(id)).toEqual([
      {
        seq: 0,
        startedAt: at(0),
        durationMs: 60_000,
        status: "transcribed",
        interrupted: false,
        audio: false,
        audioDeletedAt: null,
      },
    ]);
    expect(service.chunkAudio(id, 0)).toBeNull();
  });

  test("kept audio can be played until its retention ends, then is deleted", async () => {
    keepDays = 2;
    const id = await start();
    transcripts.push({ text: "hello" }, null);
    await service.addChunk(chunk(id, 0));
    await service.addChunk(chunk(id, 1, { silent: true, audio: null, mimeType: null }));
    await service.idle();
    const settledAt = now.toISOString();

    // Kept with its type, and dated for deletion two days after it settled.
    expect(service.chunkAudio(id, 0)).toEqual({
      audio: new TextEncoder().encode("audio-0"),
      mimeType: "audio/aac",
    });
    expect(service.chunks(id)?.[0]).toMatchObject({
      audio: true,
      audioDeletedAt: new Date(Date.parse(settledAt) + 2 * DAY).toISOString(),
    });
    // A silent chunk never had audio to keep.
    expect(service.chunks(id)?.[1]).toMatchObject({ status: "silent", audio: false });

    advance(2 * DAY - 1);
    await pass();
    expect(service.chunkAudio(id, 0)).not.toBeNull();
    advance(1);
    await pass();
    expect(service.chunkAudio(id, 0)).toBeNull();
    expect(service.chunks(id)?.[0]).toMatchObject({ audio: false, audioDeletedAt: null });
    // The transcript stays.
    expect(getRecordingChunk(db, id, 0)).toMatchObject({ status: "transcribed", text: "hello" });
  });

  test("a chunk given up on keeps its audio too", async () => {
    keepDays = 1;
    const id = await start();
    transcripts.push({ kind: "unreadable" });
    await service.addChunk(chunk(id, 0));
    await service.idle();
    expect(getRecordingChunk(db, id, 0)).toMatchObject({ status: "failed" });
    expect(service.chunkAudio(id, 0)?.mimeType).toBe("audio/aac");
  });

  test("a pending chunk's audio is never played nor deleted by the retention sweep", async () => {
    keepDays = 1;
    readiness = { runnable: false, reason: "no model" };
    const id = await start();
    await service.addChunk(chunk(id, 0));
    await service.idle();
    advance(3 * DAY);
    await pass();
    expect(service.chunks(id)?.[0]).toMatchObject({
      status: "pending",
      audio: true,
      audioDeletedAt: null,
    });
    expect(service.chunkAudio(id, 0)).toBeNull();
    expect(readRecordingChunkAudio(db, id, 0)).not.toBeNull();
  });

  test("lowering the retention to nothing deletes the kept audio at the next pass", async () => {
    keepDays = 30;
    const id = await start();
    transcripts.push({ text: "hello" });
    await service.addChunk(chunk(id, 0));
    await service.idle();
    expect(service.chunkAudio(id, 0)).not.toBeNull();
    keepDays = 0;
    await pass();
    expect(service.chunkAudio(id, 0)).toBeNull();
  });

  test("a retention past a year is held to a year", async () => {
    keepDays = 10_000;
    const id = await start();
    transcripts.push({ text: "hello" });
    await service.addChunk(chunk(id, 0));
    await service.idle();
    expect(service.chunks(id)?.[0]?.audioDeletedAt).toBe(
      new Date(now.getTime() + 365 * DAY).toISOString(),
    );
  });

  test("deleting a recording deletes its kept audio", async () => {
    keepDays = 7;
    const id = await start();
    transcripts.push({ text: "hello" });
    await service.addChunk(chunk(id, 0));
    await service.idle();
    expect(await service.delete(id)).toBe(true);
    expect(readRecordingChunkAudio(db, id, 0)).toBeNull();
    expect(service.chunks(id)).toBeNull();
  });

  test("the list of recordings carries chunk counts and the recorded time", async () => {
    const id = await start(undefined, "Standup");
    transcripts.push({ text: "hello" }, null, null, null, null, null, null);
    await service.addChunk(chunk(id, 0));
    await service.addChunk(
      chunk(id, 1, { silent: true, audio: null, mimeType: null, durationMs: 30_000 }),
    );
    await service.idle();
    expect(service.recent(10)).toEqual([
      {
        id,
        title: "Standup",
        startedAt: START,
        state: "recording",
        chunkCount: null,
        chunks: { received: 2, pending: 0, transcribed: 1, failed: 0, silent: 1 },
        durationMs: 90_000,
        speakers: 0,
        namedSpeakers: 0,
        documentId: null,
      },
    ]);
  });
});

describe("RecordingTranscriptionService speakers", () => {
  /** A chunk whose "audio" scripts who says what, for the replay transcriber and separator. */
  type Line = { startMs: number; endMs: number; text: string; voice: string };
  function spoken(sessionId: string, seq: number, lines: Line[]) {
    const script = { segments: lines };
    transcripts.push({
      text: lines.map((l) => l.text).join(" "),
      segments: lines.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    });
    return chunk(sessionId, seq, { audio: new TextEncoder().encode(JSON.stringify(script)) });
  }

  async function twoSpeakerSession(): Promise<string> {
    const id = await start();
    await service.addChunk(
      spoken(id, 0, [
        { startMs: 0, endMs: 3_000, text: "Shall we look at the budget?", voice: "maya" },
        { startMs: 4_000, endMs: 7_000, text: "Yes, travel first.", voice: "owner" },
      ]),
    );
    await service.addChunk(
      spoken(id, 1, [
        { startMs: 0, endMs: 2_000, text: "Travel is up ten percent.", voice: "maya" },
        { startMs: 2_000, endMs: 5_000, text: "Then we cut it.", voice: "maya" },
      ]),
    );
    await service.finish(id, 2, at(120_000));
    await service.idle();
    return id;
  }

  test("tells voices apart across chunks and deletes the vectors once grouped", async () => {
    separator = new ReplayVoiceSeparator();
    const id = await twoSpeakerSession();

    const lines = docs.get(id)!.content.split("\n").slice(4);
    expect(lines).toEqual([
      "[00:00:00] Speaker 1: Shall we look at the budget?",
      "[00:00:04] Speaker 2: Yes, travel first.",
      "[00:01:00] Speaker 1: Travel is up ten percent. Then we cut it.",
    ]);
    const vectors = db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM recording_chunks WHERE session_id = ? AND voice_vectors IS NOT NULL",
      )
      .get(id)!.n;
    expect(vectors).toBe(0);
    expect(service.speakers(id)).toEqual([
      expect.objectContaining({
        speaker: 1,
        talkMs: 8_000,
        samples: ["Shall we look at the budget?", "Travel is up ten percent. Then we cut it."],
      }),
      expect.objectContaining({ speaker: 2, talkMs: 3_000, samples: ["Yes, travel first."] }),
    ]);
  });

  test("the owner's mapping names the lines and makes the person a participant", async () => {
    separator = new ReplayVoiceSeparator();
    const maya = findOrCreatePerson(
      db,
      { role: "sender", name: "Maya", emails: ["maya@example.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const id = await twoSpeakerSession();

    expect(await service.setSpeaker(id, 1, { kind: "person", personId: maya })).toBe("set");
    expect(await service.setSpeaker(id, 2, { kind: "self" })).toBe("set");
    await service.idle();

    const doc = docs.get(id)!;
    expect(doc.content).toContain("[00:00:00] Maya: Shall we look at the budget?");
    expect(doc.content).toContain("[00:00:04] You: Yes, travel first.");
    expect(doc.metadata.people).toEqual([
      { name: "You", role: "participant", isSelf: true },
      { role: "participant", personId: maya, name: "Maya" },
    ]);

    expect(await service.setSpeaker(id, 1, { kind: "name", name: "Guest" })).toBe("set");
    await service.idle();
    expect(docs.get(id)!.content).toContain("Guest: Shall we look at the budget?");
    expect(docs.get(id)!.metadata.people).toEqual([
      { name: "You", role: "participant", isSelf: true },
    ]);
  });

  test("suggests the overlapping event's title and attendees, and who was addressed", async () => {
    separator = new ReplayVoiceSeparator();
    const jamie = findOrCreatePerson(
      db,
      { role: "sender", name: "Jamie R.", emails: ["jamie@example.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const asked: string[][] = [];
    calendar = (from, to) => {
      asked.push([from, to]);
      return [
        // Overlaps half a minute; the sync below overlaps the whole recording.
        {
          documentId: "doc-coffee",
          title: "Coffee",
          start: at(-30 * 60_000),
          end: at(30_000),
          attendees: [],
        },
        {
          documentId: "doc-sync",
          title: "Weekly sync",
          start: at(-5 * 60_000),
          end: at(55 * 60_000),
          attendees: [{ personId: "p-priya", name: "Priya S." }],
        },
        // Ends before the recording starts: not taken, whatever the reader says.
        {
          documentId: "doc-early",
          title: "Standup",
          start: at(-60 * 60_000),
          end: at(-30 * 60_000),
          attendees: [],
        },
      ];
    };
    const id = await start();
    await service.addChunk(
      spoken(id, 0, [
        { startMs: 0, endMs: 3_000, text: "Thanks, Jamie. Where are we?", voice: "owner" },
        { startMs: 4_000, endMs: 7_000, text: "Nearly done.", voice: "jamie" },
      ]),
    );
    await service.finish(id, 1, at(60_000));
    await service.idle();

    const result = await service.suggestions(id);
    expect(asked).toEqual([[START, at(60_000)]]);
    expect(result?.suggestions).toEqual([
      {
        key: "title:doc-sync",
        kind: "title",
        source: "calendar",
        title: "Weekly sync",
        documentId: "doc-sync",
      },
      {
        key: `mention:2:${jamie}`,
        kind: "person",
        source: "mention",
        speaker: 2,
        personId: jamie,
        name: "Jamie R.",
        evidence: "Thanks, Jamie.",
      },
      {
        key: "person:p-priya",
        kind: "person",
        source: "calendar",
        speaker: null,
        personId: "p-priya",
        name: "Priya S.",
        evidence: "Weekly sync",
      },
      // The coffee overlaps too, with nobody invited.
    ]);

    // Accepting is the mapping and title routes; each suggestion then goes.
    expect(await service.setSpeaker(id, 2, { kind: "person", personId: jamie })).toBe("set");
    expect(await service.setTitle(id, "  Weekly sync ")).toBe(true);
    expect(await service.dismissSuggestion(id, "person:p-priya")).toBe(true);
    expect((await service.suggestions(id))?.suggestions).toEqual([]);
    await service.idle();
    expect(docs.get(id)!.title).toBe("Weekly sync");

    // Clearing the title goes back to the date-based one and brings the suggestion back.
    expect(await service.setTitle(id, null)).toBe(true);
    expect((await service.suggestions(id))?.suggestions.map((s) => s.key)).toEqual([
      "title:doc-sync",
    ]);
  });

  test("a calendar that cannot be read leaves the mentions; an unknown recording has none", async () => {
    separator = new ReplayVoiceSeparator();
    calendar = () => {
      throw new Error("analytics offline");
    };
    const id = await start();
    await service.addChunk(
      spoken(id, 0, [
        { startMs: 0, endMs: 3_000, text: "Alex, your turn.", voice: "owner" },
        { startMs: 4_000, endMs: 7_000, text: "Right.", voice: "alex" },
      ]),
    );
    await service.finish(id, 1, at(60_000));
    await service.idle();
    expect((await service.suggestions(id))?.suggestions).toMatchObject([
      { key: "mention:2:alex", speaker: 2, personId: null, name: "Alex" },
    ]);
    expect(await service.suggestions(randomUUID())).toBeNull();
    expect(await service.dismissSuggestion(randomUUID(), "x")).toBe(false);
    expect(await service.setTitle(randomUUID(), "x")).toBe(false);
  });

  test("refuses a speaker the session does not have and a person nobody is", async () => {
    separator = new ReplayVoiceSeparator();
    const id = await twoSpeakerSession();
    expect(await service.setSpeaker(id, 3, { kind: "self" })).toBe("missing");
    expect(await service.setSpeaker(id, 1, { kind: "person", personId: "nobody" })).toBe(
      "no-such-person",
    );
    expect(service.speakers(randomUUID())).toBeNull();
  });

  test("without a separator, or when it fails, the transcript is written unattributed", async () => {
    const id = await twoSpeakerSession();
    expect(docs.get(id)!.content).toContain("[00:00:00] Shall we look at the budget?");
    expect(service.speakers(id)).toEqual([]);

    separator = {
      name: "broken",
      model: "broken",
      separate: () => Promise.reject(new Error("model crashed")),
      group: () => Promise.reject(new Error("model crashed")),
      dispose: async () => {},
    };
    const other = await twoSpeakerSession();
    expect(docs.get(other)!.content).toContain("[00:00:04] Yes, travel first.");
  });

  test("voices are deleted even when grouping fails", async () => {
    const replay = new ReplayVoiceSeparator();
    separator = {
      name: "flaky",
      model: "flaky",
      separate: (audio) => replay.separate(audio),
      group: () => Promise.reject(new Error("worker died")),
      dispose: async () => {},
    };
    const id = await twoSpeakerSession();
    expect(docs.get(id)!.content).toContain("[00:00:00] Shall we look at the budget?");
    const vectors = db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM recording_chunks WHERE session_id = ? AND voice_vectors IS NOT NULL",
      )
      .get(id)!.n;
    expect(vectors).toBe(0);
  });
});

describe("RecordingTranscriptionService participants without a turn", () => {
  async function finishedSession(): Promise<string> {
    const id = await start(undefined, "Q4 budget review");
    transcripts.push({ text: "Let's start with the travel budget." });
    await service.addChunk(chunk(id, 0));
    await service.finish(id, 1, at(60_000));
    await service.idle();
    return id;
  }

  function person(name: string, email: string): string {
    return findOrCreatePerson(
      db,
      { role: "sender", name, emails: [email] },
      "gmail:test",
      "2026-01-01",
    )!;
  }

  test("a person added as present becomes a participant and is named under the header", async () => {
    const david = person("David Lin", "david@example.com");
    const id = await finishedSession();

    expect(await service.addParticipant(id, { personId: david })).toBe("added");
    expect(await service.addParticipant(id, { name: "Sarah Mendez" })).toBe("added");
    await service.idle();

    const doc = docs.get(id)!;
    expect(doc.content.split("\n").slice(0, 4)).toEqual([
      "# Q4 budget review",
      "",
      "Recorded conversation · 2026-03-02 10:00 · 1 min",
      "Also present: David Lin, Sarah Mendez",
    ]);
    // A name without a person is text only, as for a speaker.
    expect(doc.metadata.people).toEqual([
      { name: "You", role: "participant", isSelf: true },
      { role: "participant", personId: david, name: "David Lin" },
    ]);
    expect(service.participants(id)).toEqual([
      { key: `person:${david}`, personId: david, name: "David Lin" },
      { key: "name:sarah mendez", personId: null, name: "Sarah Mendez" },
    ]);
  });

  test("adding someone twice changes nothing, and removing them writes the document again", async () => {
    const david = person("David Lin", "david@example.com");
    const id = await finishedSession();
    await service.addParticipant(id, { personId: david });
    await service.idle();
    const revision = () =>
      db
        .prepare<[string], { revision: number }>(
          "SELECT revision FROM recording_sessions WHERE id = ?",
        )
        .get(id)!.revision;
    const before = revision();

    expect(await service.addParticipant(id, { personId: david })).toBe("added");
    expect(revision()).toBe(before);
    expect(service.participants(id)).toHaveLength(1);

    expect(await service.removeParticipant(id, `person:${david}`)).toBe(true);
    await service.idle();
    expect(docs.get(id)!.content).not.toContain("Also present");
    expect(docs.get(id)!.metadata.people).toEqual([
      { name: "You", role: "participant", isSelf: true },
    ]);
    expect(await service.removeParticipant(id, `person:${david}`)).toBe(false);
  });

  test("refuses an unknown person and an unknown recording", async () => {
    const id = await finishedSession();
    expect(await service.addParticipant(id, { personId: "nobody" })).toBe("no-such-person");
    expect(await service.addParticipant("missing", { name: "Maya Reeves" })).toBe("missing");
    expect(service.participants("missing")).toBeNull();
  });

  test("someone who is also a speaker is linked once and not named again", async () => {
    separator = new ReplayVoiceSeparator();
    const maya = person("Maya Reeves", "maya@example.com");
    const id = await start();
    const lines = [
      { startMs: 0, endMs: 3_000, text: "Shall we look at the budget?", voice: "maya" },
    ];
    transcripts.push({
      text: lines[0]!.text,
      segments: [{ startMs: 0, endMs: 3_000, text: lines[0]!.text }],
    });
    await service.addChunk(
      chunk(id, 0, { audio: new TextEncoder().encode(JSON.stringify({ segments: lines })) }),
    );
    await service.finish(id, 1, at(60_000));
    await service.idle();

    await service.setSpeaker(id, 1, { kind: "person", personId: maya });
    await service.addParticipant(id, { personId: maya });
    await service.idle();

    const doc = docs.get(id)!;
    expect(doc.content).not.toContain("Also present");
    expect(doc.metadata.people).toEqual([
      { name: "You", role: "participant", isSelf: true },
      { role: "participant", personId: maya, name: "Maya Reeves" },
    ]);
  });

  test("a calendar attendee already present is not suggested again", async () => {
    const jamie = person("Jamie Lopez", "jamie@example.com");
    const id = await finishedSession();
    calendar = () => [
      {
        documentId: "doc-sync",
        title: "Q4 budget review",
        start: at(-5 * 60_000),
        end: at(55 * 60_000),
        attendees: [{ personId: jamie, name: "Jamie Lopez" }],
      },
    ];
    expect((await service.suggestions(id))!.suggestions).toEqual([
      expect.objectContaining({
        kind: "person",
        source: "calendar",
        personId: jamie,
        speaker: null,
      }),
    ]);

    await service.addParticipant(id, { personId: jamie });
    expect((await service.suggestions(id))!.suggestions).toEqual([]);
  });

  test("deleting the recording deletes its participants", async () => {
    const id = await finishedSession();
    await service.addParticipant(id, { name: "Sarah Mendez" });
    await service.delete(id);
    const left = db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM recording_participants WHERE session_id = ?",
      )
      .get(id)!.n;
    expect(left).toBe(0);
  });
});

describe("RecordingTranscriptionService recognising the owner's voice", () => {
  type Line = { startMs: number; endMs: number; text: string; voice: string };
  const encode = (lines: Line[]) => new TextEncoder().encode(JSON.stringify({ segments: lines }));
  function spoken(sessionId: string, seq: number, lines: Line[]) {
    transcripts.push({
      text: lines.map((l) => l.text).join(" "),
      segments: lines.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    });
    return chunk(sessionId, seq, { audio: encode(lines) });
  }
  /** A read-aloud clip: `seconds` of one voice, in eight-second windows. */
  function clip(voice: string, seconds: number, other?: { voice: string; seconds: number }) {
    const lines: Line[] = [];
    let t = 0;
    const add = (v: string, s: number) => {
      for (let left = s * 1000; left > 0; left -= 8_000) {
        const len = Math.min(8_000, left);
        lines.push({ startMs: t, endMs: t + len, text: "", voice: v });
        t += len;
      }
    };
    add(voice, seconds);
    if (other) add(other.voice, other.seconds);
    return encode(lines);
  }
  const conversation: Line[] = [
    { startMs: 0, endMs: 3_000, text: "Shall we look at the budget?", voice: "maya" },
    { startMs: 4_000, endMs: 7_000, text: "Yes, travel first.", voice: "owner" },
  ];

  async function recorded(lines: Line[] = conversation): Promise<string> {
    const id = await start();
    await service.addChunk(spoken(id, 0, lines));
    await service.finish(id, 1, at(60_000));
    await service.idle();
    return id;
  }

  beforeEach(() => {
    separator = new ReplayVoiceSeparator();
    selfVoice = "match";
  });

  test("enrols the owner from a read-aloud clip, keeping one mean vector and no audio", async () => {
    const outcome = await service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    expect(outcome).toEqual({
      kind: "enrolled",
      status: {
        setting: "match",
        ready: true,
        minSpeechMs: MIN_ENROLMENT_SPEECH_MS,
        profile: { enrolledAt: now.toISOString(), speechMs: 24_000, current: true },
      },
    });
    const profile = getRecordingVoiceProfile(db)!;
    expect(profile.model).toBe("replay");
    expect(Math.hypot(...profile.vector)).toBeCloseTo(1, 6);
    // Nothing of the clip is stored as a recording.
    expect(service.recent(10)).toEqual([]);
  });

  test("refuses a clip it cannot enrol, and enrols nothing while it cannot", async () => {
    expect(await service.enrollSelfVoice(clip("owner", 12), "audio/webm")).toEqual({
      kind: "too-short",
      speechMs: 12_000,
    });
    expect(await service.enrollSelfVoice(new Uint8Array([1, 2]), "audio/webm")).toEqual({
      kind: "too-short",
      speechMs: 0,
    });
    expect(
      await service.enrollSelfVoice(
        clip("owner", 16, { voice: "maya", seconds: 16 }),
        "audio/webm",
      ),
    ).toEqual({ kind: "several-voices" });

    separator = null;
    expect(await service.enrollSelfVoice(clip("owner", 24), "audio/webm")).toEqual({
      kind: "unavailable",
    });
    separator = {
      name: "broken",
      model: "broken",
      separate: () => Promise.reject(new Error("ffmpeg could not decode")),
      group: () => Promise.reject(new Error("unused")),
      dispose: async () => {},
    };
    expect(await service.enrollSelfVoice(clip("owner", 24), "audio/webm")).toEqual({
      kind: "unreadable",
    });
    const replay = new ReplayVoiceSeparator();
    separator = {
      name: "flaky",
      model: "flaky",
      separate: (audio) => replay.separate(audio),
      group: () => Promise.reject(new Error("worker died")),
      dispose: async () => {},
    };
    expect(await service.enrollSelfVoice(clip("owner", 24), "audio/webm")).toEqual({
      kind: "unavailable",
    });
    selfVoice = "off";
    separator = new ReplayVoiceSeparator();
    expect(await service.enrollSelfVoice(clip("owner", 24), "audio/webm")).toEqual({ kind: "off" });
    expect(getRecordingVoiceProfile(db)).toBeNull();
  });

  test("a stray voice in the clip is left out of the enrolled voice", async () => {
    const outcome = await service.enrollSelfVoice(
      clip("owner", 40, { voice: "maya", seconds: 8 }),
      "audio/webm",
    );
    expect(outcome).toMatchObject({ kind: "enrolled", status: { profile: { speechMs: 40_000 } } });
    // Enrolled from the owner alone: Maya is never taken for the owner.
    const id = await recorded();
    expect(service.speakers(id)!.map((s) => [s.speaker, s.isSelf])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  test("names the owner in a new recording with no tap, marked as recognised", async () => {
    await service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    const id = await recorded();

    expect(service.speakers(id)!.map((s) => [s.speaker, s.isSelf, s.selfMatched])).toEqual([
      [1, false, false],
      [2, true, true],
    ]);
    expect(docs.get(id)!.content).toContain("[00:00:04] You: Yes, travel first.");
    expect(docs.get(id)!.metadata.people).toEqual([
      { name: "You", role: "participant", isSelf: true },
    ]);
    expect(service.recent(1)[0]).toMatchObject({ speakers: 2, namedSpeakers: 1 });

    // Confirming it makes it the owner's own mapping.
    expect(await service.setSpeaker(id, 2, { kind: "self" })).toBe("set");
    expect(service.speakers(id)![1]).toMatchObject({ isSelf: true, selfMatched: false });
  });

  test("a recording without the owner's voice names nobody", async () => {
    await service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    const id = await recorded([
      { startMs: 0, endMs: 3_000, text: "Shall we look at the budget?", voice: "maya" },
      { startMs: 4_000, endMs: 7_000, text: "Yes, travel first.", voice: "guest" },
    ]);
    expect(service.speakers(id)!.every((s) => !s.isSelf)).toBe(true);
  });

  /** A recording the gateway finished, then a chunk from its device after it. */
  async function withLateChunk(undo: boolean): Promise<string> {
    const id = await start();
    await service.addChunk(spoken(id, 0, conversation));
    advance(ABANDONED_AFTER_MS);
    await pass();
    expect(service.speakers(id)![1]).toMatchObject({ speaker: 2, isSelf: true });
    if (undo) expect(await service.setSpeaker(id, 2, { kind: "clear" })).toBe("set");
    await service.addChunk(
      spoken(id, 1, [{ startMs: 0, endMs: 4_000, text: "Agreed, then.", voice: "owner" }]),
    );
    await service.finish(id, 2, at(120_000));
    await service.idle();
    return id;
  }

  test("a late chunk's owner is recognised, unless the owner undid it in that session", async () => {
    await service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    const kept = await withLateChunk(false);
    // The late voice cannot be compared with deleted vectors, but it is the owner's.
    expect(service.speakers(kept)!.map((s) => [s.speaker, s.isSelf])).toEqual([
      [1, false],
      [2, true],
      [3, true],
    ]);

    const undone = await withLateChunk(true);
    expect(service.speakers(undone)!.map((s) => [s.speaker, s.isSelf])).toEqual([
      [1, false],
      [2, false],
      [3, false],
    ]);
    expect(docs.get(undone)!.content).not.toContain("You:");
  });

  test("a voice enrolled with another model is not used, and says so", async () => {
    await service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    const other = new ReplayVoiceSeparator();
    Object.defineProperty(other, "model", { value: "replay-v2" });
    separator = other;
    expect(service.selfVoiceStatus().profile).toMatchObject({ current: false });
    const id = await recorded();
    expect(service.speakers(id)!.some((s) => s.isSelf)).toBe(false);
  });

  test("with the setting off nobody is recognised and the enrolled voice is deleted", async () => {
    await service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    selfVoice = "off";
    const id = await recorded();
    expect(service.speakers(id)!.some((s) => s.isSelf)).toBe(false);
    expect(getRecordingVoiceProfile(db)).toBeNull();
    expect(service.selfVoiceStatus()).toMatchObject({ setting: "off", profile: null });
  });

  test("the owner can delete the enrolled voice", async () => {
    await service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    expect(await service.deleteSelfVoice()).toBe(true);
    expect(await service.deleteSelfVoice()).toBe(false);
    const id = await recorded();
    expect(service.speakers(id)!.some((s) => s.isSelf)).toBe(false);
  });

  /**
   * A separator that reads each clip only when the test lets it: `read(n)`
   * lets the n-th clip it was given (from 0) be read, and resolves once
   * `started` clips are waiting.
   */
  function deferredSeparator() {
    const replay = new ReplayVoiceSeparator();
    const waiting: (() => void)[] = [];
    separator = {
      name: replay.name,
      model: replay.model,
      separate: async (audio) => {
        await new Promise<void>((resolve) => waiting.push(resolve));
        return replay.separate(audio);
      },
      group: (vectors, durations) => replay.group(vectors, durations),
      dispose: async () => {},
    };
    return {
      started: (n: number) => vi.waitFor(() => expect(waiting).toHaveLength(n)),
      read: (n: number) => waiting[n]!(),
    };
  }

  test("an enrolment under way when the owner deletes the voice stores nothing", async () => {
    await service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    const clips = deferredSeparator();
    const again = service.enrollSelfVoice(clip("owner", 32), "audio/webm");
    await clips.started(1);

    expect(await service.deleteSelfVoice()).toBe(true);
    expect(getRecordingVoiceProfile(db)).toBeNull();
    clips.read(0);
    expect(await again).toEqual({ kind: "superseded" });
    expect(getRecordingVoiceProfile(db)).toBeNull();

    // Enrolling again after the deletion works.
    const next = service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    await clips.started(2);
    clips.read(1);
    expect(await next).toMatchObject({ kind: "enrolled" });
    expect(getRecordingVoiceProfile(db)).toMatchObject({ speechMs: 24_000 });
  });

  test("a deletion asked for while the voice is being stored lands after it", async () => {
    let store!: () => void;
    voiceWrite = { until: new Promise((resolve) => (store = resolve)), reached: false };
    const enrolment = service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    // Past its last check, at the writer.
    await vi.waitFor(() => expect(voiceWrite!.reached).toBe(true));
    const deletion = service.deleteSelfVoice();
    store();
    expect(await enrolment).toMatchObject({ kind: "enrolled" });
    expect(await deletion).toBe(true);
    expect(getRecordingVoiceProfile(db)).toBeNull();
  });

  test("switching recognition off refuses an enrolment under way, even once on again", async () => {
    const clips = deferredSeparator();
    const whileOff = service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    await clips.started(1);
    selfVoice = "off";
    await service.selfVoiceSettingChanged();
    clips.read(0);
    expect(await whileOff).toEqual({ kind: "off" });
    expect(getRecordingVoiceProfile(db)).toBeNull();

    selfVoice = "match";
    await service.selfVoiceSettingChanged();
    const offAndOn = service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    await clips.started(2);
    selfVoice = "off";
    await service.selfVoiceSettingChanged();
    selfVoice = "match";
    await service.selfVoiceSettingChanged();
    clips.read(1);
    expect(await offAndOn).toEqual({ kind: "superseded" });
    expect(getRecordingVoiceProfile(db)).toBeNull();

    // Off with no change heard yet: the write reads the setting itself.
    const unheard = service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    await clips.started(3);
    selfVoice = "off";
    clips.read(2);
    expect(await unheard).toEqual({ kind: "off" });
    expect(getRecordingVoiceProfile(db)).toBeNull();
  });

  test("of two enrolments under way, the one started later is the voice kept", async () => {
    const clips = deferredSeparator();
    // The later one is read first: the earlier, finishing after it, stores nothing.
    const older = service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    await clips.started(1);
    const newer = service.enrollSelfVoice(clip("owner", 32), "audio/webm");
    await clips.started(2);
    clips.read(1);
    expect(await newer).toMatchObject({ kind: "enrolled" });
    clips.read(0);
    expect(await older).toEqual({ kind: "superseded" });
    expect(getRecordingVoiceProfile(db)).toMatchObject({ speechMs: 32_000 });

    // Read in the order they started, the later one replaces the earlier.
    const first = service.enrollSelfVoice(clip("owner", 40), "audio/webm");
    await clips.started(3);
    const last = service.enrollSelfVoice(clip("owner", 24), "audio/webm");
    await clips.started(4);
    clips.read(2);
    expect(await first).toMatchObject({ kind: "enrolled" });
    clips.read(3);
    expect(await last).toMatchObject({ kind: "enrolled" });
    expect(getRecordingVoiceProfile(db)).toMatchObject({ speechMs: 24_000 });
  });
});
