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
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createFreshTestDatabase } from "../testing/fresh-database.js";
import { directWriteGate } from "../write-gate.js";
import { buildRecordingDocument } from "../sources/omnesis-recordings/index.js";
import { findOrCreatePerson } from "../people.js";
import {
  ABANDONED_AFTER_MS,
  MAX_ATTEMPTS,
  MISSING_GRACE_MS,
  RecordingTranscriptionService,
  type RecordingChunkInput,
} from "./service.js";
import { getRecordingChunk, readRecordingChunkAudio } from "./storage.js";
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
/** The operator's `inference.recordings.conversationGapSeconds`, in ms; 0 never splits. */
let gapMs: number;
/** What the owner's calendar holds for any window; a function to see the window asked for. */
let calendar: (from: string, to: string) => CalendarEventCandidate[];

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
  gapMs = 0;
  calendar = () => [];
  service = new RecordingTranscriptionService({
    writeGate: directWriteGate(db),
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
    conversationGapMs: () => gapMs,
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
        conversations: [],
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

describe("RecordingTranscriptionService conversations of an all-day session", () => {
  type Line = { startMs: number; endMs: number; text: string; voice: string };
  function spoken(sessionId: string, seq: number, lines: Line[]) {
    transcripts.push({
      text: lines.map((l) => l.text).join(" "),
      segments: lines.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    });
    const script = { segments: lines };
    return chunk(sessionId, seq, { audio: new TextEncoder().encode(JSON.stringify(script)) });
  }
  const silence = (sessionId: string, seq: number) =>
    chunk(sessionId, seq, { silent: true, audio: null, mimeType: null });
  const vectorsOf = (id: string) =>
    db
      .prepare<[string], { seq: number }>(
        "SELECT seq FROM recording_chunks WHERE session_id = ? AND voice_vectors IS NOT NULL ORDER BY seq",
      )
      .all(id)
      .map((r) => r.seq);

  /**
   * Two minutes of talk, two minutes of silence, then more talk, all in
   * minute-long chunks; the session is left open.
   */
  async function morning(origin: "explicit" | "ambient" = "ambient"): Promise<string> {
    const id = await start(undefined, undefined, origin);
    await service.addChunk(
      spoken(id, 0, [
        { startMs: 0, endMs: 3_000, text: "Shall we look at the budget?", voice: "maya" },
        { startMs: 4_000, endMs: 7_000, text: "Yes, travel first.", voice: "owner" },
      ]),
    );
    await service.addChunk(silence(id, 1));
    await service.addChunk(silence(id, 2));
    await service.addChunk(
      spoken(id, 3, [
        { startMs: 10_000, endMs: 14_000, text: "Is the projector free?", voice: "jamie" },
      ]),
    );
    await service.idle();
    return id;
  }

  beforeEach(() => {
    separator = new ReplayVoiceSeparator();
    gapMs = 90_000;
  });

  test("a conversation a long silence ended is written, with its speakers, while the session goes on", async () => {
    const id = await morning();

    expect(service.status(id)!.state).toBe("recording");
    const doc = docs.get(id)!;
    expect(doc.title).toBe("Conversation, 2026-03-02 10:00");
    expect(doc.content.split("\n").slice(4)).toEqual([
      "[00:00:00] Speaker 1: Shall we look at the budget?",
      "[00:00:04] Speaker 2: Yes, travel first.",
    ]);
    expect(doc.metadata.extra).toMatchObject({ recordingOrigin: "ambient", conversation: 1 });
    expect(docs.size).toBe(1);
    expect(service.speakers(id)!.map((s) => [s.speaker, s.conversation])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    // Only the closed conversation's vectors are gone; the talk still going on keeps its own.
    expect(vectorsOf(id)).toEqual([3]);
    expect(service.summary(id)!.conversations).toEqual([
      expect.objectContaining({ n: 1, title: "Conversation, 2026-03-02 10:00", titled: false }),
    ]);
    // The session itself reads as the day's recording.
    expect(service.summary(id)!.title).toBe("All-day recording, 2026-03-02 10:00");
  });

  test("finishing the session writes its last conversation, timed from its own start", async () => {
    const id = await morning();
    await service.finish(id, 4, at(4 * 60_000));
    await service.idle();

    const second = docs.get(`${id}:2`)!;
    expect(second.title).toBe("Conversation, 2026-03-02 10:03");
    // Speakers are numbered on across the session: voices of one conversation
    // are never compared with another's.
    expect(second.content.split("\n").slice(4)).toEqual([
      "[00:00:10] Speaker 3: Is the projector free?",
    ]);
    expect(docs.get(id)!.content).not.toContain("projector");
    expect(vectorsOf(id)).toEqual([]);
    expect(service.status(id)!.state).toBe("done");
  });

  test("a recording the owner started stays one document, however long its silences", async () => {
    const id = await morning("explicit");
    expect(docs.size).toBe(0);
    await service.finish(id, 4, at(4 * 60_000));
    await service.idle();

    expect([...docs.keys()]).toEqual([id]);
    expect(docs.get(id)!.content).toContain("projector");
    expect(service.summary(id)!.conversations).toEqual([]);
  });

  test("with no gap set, an all-day session is one document as before", async () => {
    gapMs = 0;
    const id = await morning();
    expect(docs.size).toBe(0);
    await service.finish(id, 4, at(4 * 60_000));
    await service.idle();

    expect([...docs.keys()]).toEqual([id]);
  });

  test("an all-day session that was one conversation stays one document under its own id", async () => {
    const id = await start(undefined, undefined, "ambient");
    await service.addChunk(
      spoken(id, 0, [{ startMs: 0, endMs: 3_000, text: "Morning, all.", voice: "maya" }]),
    );
    await service.finish(id, 1, at(60_000));
    await service.idle();

    expect([...docs.keys()]).toEqual([id]);
    expect(service.summary(id)!.conversations).toEqual([]);
  });

  test("naming a speaker writes again only the conversation they spoke in", async () => {
    const id = await morning();
    await service.finish(id, 4, at(4 * 60_000));
    await service.idle();
    const second = docs.get(`${id}:2`);

    expect(await service.setSpeaker(id, 2, { kind: "self" })).toBe("set");
    await service.idle();

    expect(docs.get(id)!.content).toContain("[00:00:04] You: Yes, travel first.");
    expect(docs.get(`${id}:2`)).toBe(second);
  });

  const someone = (name: string, email: string) =>
    findOrCreatePerson(db, { role: "sender", name, emails: [email] }, "gmail:test", "2026-01-01")!;
  const linked = (externalId: string) =>
    docs.get(externalId)!.metadata.people!.flatMap((p) => (p.personId ? [p.personId] : []));

  test("each conversation links only the people who spoke in it", async () => {
    const maya = someone("Maya", "maya@example.com");
    const jamie = someone("Jamie", "jamie@example.com");
    const id = await morning();
    await service.finish(id, 4, at(4 * 60_000));
    await service.idle();

    expect(await service.setSpeaker(id, 1, { kind: "person", personId: maya })).toBe("set");
    expect(await service.setSpeaker(id, 3, { kind: "person", personId: jamie })).toBe("set");
    await service.idle();

    expect(linked(id)).toEqual([maya]);
    expect(linked(`${id}:2`)).toEqual([jamie]);
  });

  test("someone present without a turn is a participant of every conversation", async () => {
    const david = someone("David", "david@example.com");
    const id = await morning();
    await service.finish(id, 4, at(4 * 60_000));
    await service.idle();

    expect(await service.addParticipant(id, { personId: david })).toBe("added");
    await service.idle();

    expect(linked(id)).toEqual([david]);
    expect(linked(`${id}:2`)).toEqual([david]);
  });

  test("a speaker remapped to someone else of the same name moves the conversation's link", async () => {
    const first = someone("Maya", "maya@example.com");
    const second = someone("Maya", "maya@example.org");
    expect(second).not.toBe(first);
    const id = await morning();
    await service.finish(id, 4, at(4 * 60_000));
    await service.idle();

    await service.setSpeaker(id, 1, { kind: "person", personId: first });
    await service.idle();
    const content = docs.get(id)!.content;
    expect(linked(id)).toEqual([first]);

    await service.setSpeaker(id, 1, { kind: "person", personId: second });
    await service.idle();
    // Not a word of the text changed, but the link did.
    expect(docs.get(id)!.content).toBe(content);
    expect(linked(id)).toEqual([second]);
  });

  test("someone mapped in one conversation is still suggested for the next they attend", async () => {
    const maya = someone("Maya", "maya@example.com");
    calendar = () => [
      {
        documentId: "doc-facilities",
        title: "Facilities sync",
        start: at(3 * 60_000),
        end: at(4 * 60_000),
        attendees: [{ personId: maya, name: "Maya" }],
      },
    ];
    const id = await morning();
    await service.finish(id, 4, at(4 * 60_000));
    await service.idle();
    await service.setSpeaker(id, 1, { kind: "person", personId: maya });
    await service.idle();

    expect((await service.suggestions(id, 2))!.suggestions).toContainEqual(
      expect.objectContaining({ kind: "person", personId: maya, key: `c2:person:${maya}` }),
    );
  });

  test("a conversation takes the owner's title", async () => {
    const id = await morning();
    expect(await service.setConversationTitle(id, 1, " Budget chat ")).toBe(true);
    expect(await service.setConversationTitle(id, 7, "Nope")).toBe(false);
    await service.idle();

    expect(docs.get(id)!.title).toBe("Budget chat");
    expect(service.summary(id)!.conversations[0]).toMatchObject({
      title: "Budget chat",
      titled: true,
    });
  });

  test("a marked moment goes to its conversation, and waits while its conversation goes on", async () => {
    const id = await morning();
    await service.mark(id, "note-1", at(5_000));
    await service.mark(id, "note-2", at(3 * 60_000 + 12_000));
    await service.idle();

    expect(docs.get(id)!.content).toContain("★ Marked moment");
    expect(docs.get(id)!.content.match(/★/g)).toHaveLength(1);

    await service.finish(id, 4, at(4 * 60_000));
    await service.idle();
    expect(docs.get(`${id}:2`)!.content).toContain("[00:00:12] ★ Marked moment");
  });

  test("deleting the session deletes every conversation's document", async () => {
    const id = await morning();
    await service.finish(id, 4, at(4 * 60_000));
    await service.idle();
    expect(docs.size).toBe(2);

    expect(await service.delete(id)).toBe(true);
    expect(docs.size).toBe(0);
  });

  test("suggestions are made per conversation, and dismissed per conversation", async () => {
    calendar = () => [
      {
        documentId: "doc-standup",
        title: "Facilities sync",
        start: at(3 * 60_000),
        end: at(4 * 60_000),
        attendees: [],
      },
    ];
    const id = await morning();
    await service.finish(id, 4, at(4 * 60_000));
    await service.idle();

    expect((await service.suggestions(id, 1))!.suggestions).toEqual([]);
    const [title] = (await service.suggestions(id, 2))!.suggestions;
    expect(title).toMatchObject({
      kind: "title",
      title: "Facilities sync",
      key: "c2:title:doc-standup",
    });
    expect(await service.suggestions(id, 9)).toBeNull();

    await service.dismissSuggestion(id, title!.key);
    expect((await service.suggestions(id, 2))!.suggestions).toEqual([]);
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
