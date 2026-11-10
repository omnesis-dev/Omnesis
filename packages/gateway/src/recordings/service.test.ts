// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The recorded-conversation queue against a real database, with a scripted
 * transcriber and a controllable clock: chunks transcribed as they arrive,
 * one document per finished session, retries, give-ups, sessions abandoned
 * by their device, and deletion racing transcription.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDatabase } from "../db.js";
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

async function start(id = randomUUID(), title?: string): Promise<string> {
  await service.startSession({
    id,
    ...(title ? { title } : {}),
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
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  now = new Date(at(10 * 60_000));
  readiness = { runnable: true };
  transcripts = [];
  calls = [];
  docs = new Map();
  failingIngest = new Set();
  held = null;
  separator = null;
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
