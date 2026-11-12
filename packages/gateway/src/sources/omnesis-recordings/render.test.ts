// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { formatOffset, formatSpan, renderRecording } from "./render.js";
import type { RecordingChunk, RecordingSession } from "../../recordings/storage.js";

const START = "2026-03-02T09:00:00.000Z";

function session(overrides: Partial<RecordingSession> = {}): RecordingSession {
  return {
    id: "rec-1",
    deviceId: null,
    title: null,
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

  test("formats offsets and spans", () => {
    expect(formatOffset(3_725_000)).toBe("01:02:05");
    expect(formatSpan(45_000)).toBe("45 s");
    expect(formatSpan(80 * 60_000)).toBe("1 h 20 min");
    expect(formatSpan(120 * 60_000)).toBe("2 h");
  });
});
