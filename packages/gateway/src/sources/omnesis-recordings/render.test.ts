// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { formatOffset, formatSpan, renderRecording } from "./render.js";
import { buildRecordingDocument, conversationExternalId } from "./index.js";
import type { RecordingChunk, RecordingSession } from "../../recordings/storage.js";

const START = "2026-03-02T09:00:00.000Z";

function session(overrides: Partial<RecordingSession> = {}): RecordingSession {
  return {
    id: "rec-1",
    deviceId: null,
    title: null,
    origin: "explicit",
    startedAt: START,
    startedTimeZoneId: "Europe/Paris",
    startedUtcOffsetSeconds: 3600,
    language: null,
    chunkCount: null,
    endedAt: null,
    finishedAt: null,
    finishedBy: null,
    lastActivityAt: START,
    revision: 0,
    projectedRevision: null,
    allowVocabulary: false,
    createdAt: START,
    ...overrides,
  };
}

function chunk(
  seq: number,
  startSec: number,
  text: string | null,
  extra: Partial<RecordingChunk> = {},
): RecordingChunk {
  return {
    sessionId: "rec-1",
    seq,
    startedAt: new Date(Date.parse(START) + startSec * 1000).toISOString(),
    durationMs: 60_000,
    silent: text === null,
    interrupted: false,
    mimeType: text === null ? null : "audio/aac",
    status: text === null ? "silent" : "transcribed",
    text,
    segments: null,
    voices: null,
    attempts: 0,
    nextAttemptAt: START,
    receivedAt: START,
    settledAt: START,
    hasAudio: false,
    ...extra,
  };
}

describe("renderRecording", () => {
  test("stamps each chunk with its offset and titles by local start time", () => {
    const r = renderRecording(session({ endedAt: "2026-03-02T09:02:00.000Z" }), [
      chunk(1, 60, "Second minute."),
      chunk(0, 0, "First minute."),
    ]);
    expect(r.title).toBe("Conversation, 2026-03-02 10:00");
    expect(r.body).toBe(
      [
        "# Conversation, 2026-03-02 10:00",
        "",
        "Recorded conversation · 2026-03-02 10:00 · 2 min",
        "",
        "[00:00:00] First minute.",
        "[00:01:00] Second minute.",
      ].join("\n"),
    );
    expect(r.durationSec).toBe(120);
    expect(r.hasSpeech).toBe(true);
  });

  test("names pauses, interruptions, failures and parts that never arrived", () => {
    const r = renderRecording(session({ chunkCount: 6 }), [
      chunk(0, 0, "Hello."),
      // Paused for four minutes between chunk 0 and 1.
      chunk(1, 300, "Back again.", { interrupted: true }),
      chunk(2, 360, null, { status: "failed", silent: false }),
      // Chunk 3 never arrived; 4 did.
      chunk(4, 480, "Wrapping up."),
    ]);
    const lines = r.body.split("\n").slice(4);
    expect(lines).toEqual([
      "[00:00:00] Hello.",
      "[00:01:00] — recording paused, 4 min —",
      "[00:05:00] — the microphone was interrupted —",
      "[00:05:00] Back again.",
      "[00:06:00] — this part could not be transcribed —",
      "[00:07:00] — a part of the recording did not arrive —",
      "[00:08:00] Wrapping up.",
      "[00:09:00] — a part of the recording did not arrive —",
    ]);
  });

  test("a recording of silence has no speech", () => {
    const r = renderRecording(session(), [chunk(0, 0, null), chunk(1, 60, "  ")]);
    expect(r.hasSpeech).toBe(false);
    expect(r.body).toContain("[00:00:00] — silence, 2 min —");
  });

  test("a call that leaves silence behind is still named", () => {
    const r = renderRecording(session(), [
      chunk(0, 0, "Before the call."),
      chunk(1, 60, null, { interrupted: true }),
      chunk(2, 120, null),
      chunk(3, 180, "After the call."),
    ]);
    expect(r.body.split("\n").slice(4)).toEqual([
      "[00:00:00] Before the call.",
      "[00:01:00] — the microphone was interrupted —",
      "[00:01:00] — silence, 2 min —",
      "[00:03:00] After the call.",
    ]);
  });

  test("places each marked moment after the transcript it falls in", () => {
    const mark = (noteId: string, sec: number) => ({
      sessionId: "rec-1",
      noteId,
      markedAt: new Date(Date.parse(START) + sec * 1000).toISOString(),
    });
    const r = renderRecording(
      session({ origin: "ambient" }),
      [chunk(0, 0, "Opening remarks."), chunk(1, 60, null), chunk(2, 120, "The deadline moves.")],
      // Out of order; one lands in the silence, one before the session started.
      [mark("n2", 150), mark("n1", 70), mark("n0", -5)],
    );
    expect(r.body.split("\n").slice(2)).toEqual([
      "Conversation captured by a wearable · 2026-03-02 10:00 · 3 min",
      "",
      "[00:00:00] Opening remarks.",
      "[00:00:00] ★ Marked moment, saved as a note",
      "[00:01:00] — silence, 1 min —",
      "[00:01:10] ★ Marked moment, saved as a note",
      "[00:02:00] The deadline moves.",
      "[00:02:30] ★ Marked moment, saved as a note",
    ]);
  });

  test("stamps each transcriber segment with its own offset", () => {
    const r = renderRecording(session(), [
      chunk(0, 0, "Good morning. Shall we start?", {
        segments: [
          { startMs: 400, endMs: 1_900, text: "Good morning." },
          { startMs: 12_300, endMs: 14_000, text: "Shall we start?" },
        ],
      }),
      chunk(1, 60, "No timings here."),
    ]);
    expect(r.body.split("\n").slice(4)).toEqual([
      "[00:00:00] Good morning.",
      "[00:00:12] Shall we start?",
      "[00:01:00] No timings here.",
    ]);
  });

  test("names who else was present under the header", () => {
    const r = renderRecording(
      session({ endedAt: "2026-03-02T09:01:00.000Z" }),
      [chunk(0, 0, "First minute.")],
      [],
      new Map(),
      ["David Lin", "Sarah Mendez"],
    );
    expect(r.body.split("\n").slice(2, 5)).toEqual([
      "Recorded conversation · 2026-03-02 10:00 · 1 min",
      "Also present: David Lin, Sarah Mendez",
      "",
    ]);
  });

  test("formats offsets and spans", () => {
    expect(formatOffset(3_725_000)).toBe("01:02:05");
    expect(formatSpan(45_000)).toBe("45 s");
    expect(formatSpan(80 * 60_000)).toBe("1 h 20 min");
    expect(formatSpan(120 * 60_000)).toBe("2 h");
  });
});

describe("one conversation of a split session", () => {
  const split = session({ origin: "ambient", chunkCount: 6, endedAt: "2026-03-02T09:06:00.000Z" });
  const chunks = [
    chunk(0, 0, "Morning, all."),
    chunk(1, 60, null),
    chunk(2, 120, null),
    chunk(3, 180, "Is the projector free?"),
    // 4 never arrived; 5 is silence.
    chunk(5, 300, null),
  ];

  test("the first keeps the session's id; the others are numbered after it", () => {
    expect(conversationExternalId("rec-1", 1)).toBe("rec-1");
    expect(conversationExternalId("rec-1", 2)).toBe("rec-1:2");
  });

  test("holds only its chunks, timed from its own start, under its own title", () => {
    const doc = buildRecordingDocument(split, chunks, [], [], [], {
      n: 2,
      firstSeq: 3,
      lastSeq: 5,
      startedAt: chunks[3]!.startedAt,
      title: null,
      last: true,
    })!;
    expect(doc.externalId).toBe("rec-1:2");
    expect(doc.title).toBe("Conversation, 2026-03-02 10:03");
    expect(doc.sourceCreatedAt).toBe(chunks[3]!.startedAt);
    expect(doc.metadata.extra).toMatchObject({ recordingOrigin: "ambient", conversation: 2 });
    expect(doc.content.split("\n").slice(4)).toEqual([
      "[00:00:00] Is the projector free?",
      "[00:01:00] — a part of the recording did not arrive —",
      "[00:02:00] — silence, 1 min —",
    ]);
  });

  test("only the last conversation names the parts that never arrived at the end", () => {
    const doc = buildRecordingDocument(split, chunks, [], [], [], {
      n: 1,
      firstSeq: 0,
      lastSeq: 0,
      startedAt: START,
      title: "Stand-up",
      last: false,
    })!;
    expect(doc.externalId).toBe("rec-1");
    expect(doc.title).toBe("Stand-up");
    expect(doc.content.split("\n").slice(4)).toEqual(["[00:00:00] Morning, all."]);
  });

  describe("participants", () => {
    // Speaker 1 talks only in the first conversation, speaker 2 only in the second.
    const voiced = [
      chunk(0, 0, "Morning, all.", {
        segments: [{ startMs: 0, endMs: 3_000, text: "Morning, all." }],
        voices: [{ startMs: 0, endMs: 3_000, speaker: 1 }],
      }),
      chunk(1, 60, null),
      chunk(2, 120, null),
      chunk(3, 180, "Is the projector free?", {
        segments: [{ startMs: 0, endMs: 3_000, text: "Is the projector free?" }],
        voices: [{ startMs: 0, endMs: 3_000, speaker: 2 }],
      }),
    ];
    const speakers = [
      { speaker: 1, isSelf: false, personId: "p-maya", name: "Maya" },
      { speaker: 2, isSelf: false, personId: "p-jamie", name: "Jamie" },
    ];
    const first = {
      n: 1,
      firstSeq: 0,
      lastSeq: 2,
      startedAt: START,
      title: null,
      last: false,
    };
    const second = {
      n: 2,
      firstSeq: 3,
      lastSeq: 3,
      startedAt: voiced[3]!.startedAt,
      title: null,
      last: true,
    };
    const linked = (doc: ReturnType<typeof buildRecordingDocument>) =>
      doc!.metadata.people!.flatMap((p) => (p.personId ? [p.personId] : []));

    test("each conversation links only the speakers heard in it", () => {
      expect(linked(buildRecordingDocument(split, voiced, [], speakers, [], first))).toEqual([
        "p-maya",
      ]);
      expect(linked(buildRecordingDocument(split, voiced, [], speakers, [], second))).toEqual([
        "p-jamie",
      ]);
      // The session as one document links both.
      expect(linked(buildRecordingDocument(split, voiced, [], speakers))).toEqual([
        "p-maya",
        "p-jamie",
      ]);
    });

    test("someone present without a turn is a participant of every conversation", () => {
      const present = [{ key: "person:p-david", personId: "p-david", name: "David" }];
      for (const part of [first, second]) {
        const doc = buildRecordingDocument(split, voiced, [], speakers, present, part);
        expect(linked(doc)).toContain("p-david");
        expect(doc!.content).toContain("Also present: David");
      }
    });

    test("a speaker remapped to someone else of the same name changes the fingerprint", () => {
      const before = buildRecordingDocument(split, voiced, [], speakers, [], first)!;
      const after = buildRecordingDocument(
        split,
        voiced,
        [],
        [{ speaker: 1, isSelf: false, personId: "p-maya-2", name: "Maya" }, speakers[1]!],
        [],
        first,
      )!;
      expect(after.content).toBe(before.content);
      expect(linked(after)).toEqual(["p-maya-2"]);
      expect(after.contentHash).not.toBe(before.contentHash);
    });
  });
});
