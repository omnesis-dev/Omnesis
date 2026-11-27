// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { chunkSpeech, closeConversations } from "./conversations.js";
import type { RecordingChunk } from "./storage.js";

const START = Date.parse("2026-03-02T09:00:00.000Z");
const GAP = 90_000;

type Chunk = Parameters<typeof chunkSpeech>[0];

/** A 30-second chunk at `seq`, back to back with the others. */
function chunk(
  seq: number,
  kind: "speech" | "silent" | "pending" | "failed" | "untimed" | "blank",
  segment: { startMs: number; endMs: number } = { startMs: 1_000, endMs: 5_000 },
): Chunk {
  const status: RecordingChunk["status"] =
    kind === "speech" || kind === "untimed" || kind === "blank" ? "transcribed" : kind;
  return {
    seq,
    startedAt: new Date(START + seq * 30_000).toISOString(),
    durationMs: 30_000,
    status,
    text: kind === "speech" || kind === "untimed" ? "hello there" : kind === "blank" ? " " : null,
    segments: kind === "speech" ? [{ ...segment, text: "hello there" }] : null,
  };
}

const spans = (out: ReturnType<typeof closeConversations>) =>
  out.map(({ n, firstSeq, lastSeq }) => [n, firstSeq, lastSeq]);

describe("speech in a chunk", () => {
  test("timed segments are where it is; a silent or blank chunk has none", () => {
    expect(chunkSpeech(chunk(0, "speech"))).toEqual([
      { startMs: START + 1_000, endMs: START + 5_000 },
    ]);
    expect(chunkSpeech(chunk(0, "silent"))).toEqual([]);
    expect(chunkSpeech(chunk(0, "blank"))).toEqual([]);
  });

  test("a transcript without timings, and a chunk that failed, count for the whole chunk", () => {
    const whole = [{ startMs: START, endMs: START + 30_000 }];
    expect(chunkSpeech(chunk(0, "untimed"))).toEqual(whole);
    expect(chunkSpeech(chunk(0, "failed"))).toEqual(whole);
  });

  test("a pending chunk is not known yet", () => {
    expect(chunkSpeech(chunk(0, "pending"))).toBeNull();
  });
});

describe("closing conversations", () => {
  test("a conversation closes once the silence after its last speech reaches the gap", () => {
    // Speech ends 5 s into chunk 1; chunks 2-4 heard until 150 s: 115 s of silence.
    const chunks = [chunk(0, "speech"), chunk(1, "speech"), chunk(2, "silent"), chunk(3, "silent")];
    expect(closeConversations(chunks, [], GAP)).toEqual([]);
    const closed = closeConversations([...chunks, chunk(4, "silent")], [], GAP);
    expect(spans(closed)).toEqual([[1, 0, 1]]);
    expect(closed[0]!.startedAt).toBe(new Date(START).toISOString());
    expect(closed[0]!.endedAt).toBe(new Date(START + 35_000).toISOString());
  });

  test("silence of exactly the gap closes it", () => {
    // Speech ends at 5 s; chunks 1-3 are heard until 120 s: 115 s. Speech ending at 30 s leaves exactly 90 s.
    const chunks = [
      chunk(0, "speech", { startMs: 20_000, endMs: 30_000 }),
      ...[1, 2, 3].map((s) => chunk(s, "silent")),
    ];
    expect(spans(closeConversations(chunks, [], GAP))).toEqual([[1, 0, 0]]);
  });

  test("silent chunks between two conversations belong to neither, and several close in one walk", () => {
    const chunks = [
      chunk(0, "speech"),
      ...[1, 2, 3, 4].map((s) => chunk(s, "silent")),
      chunk(5, "speech"),
      ...[6, 7, 8, 9].map((s) => chunk(s, "silent")),
      chunk(10, "speech"),
    ];
    expect(spans(closeConversations(chunks, [], GAP))).toEqual([
      [1, 0, 0],
      [2, 5, 5],
    ]);
  });

  test("the walk starts after the last closed conversation and numbers on from it", () => {
    const chunks = [
      chunk(0, "speech"),
      ...[1, 2, 3, 4].map((s) => chunk(s, "silent")),
      chunk(5, "speech"),
      ...[6, 7, 8, 9].map((s) => chunk(s, "silent")),
    ];
    expect(spans(closeConversations(chunks, [{ n: 1, lastSeq: 0 }], GAP))).toEqual([[2, 5, 5]]);
  });

  test("a pending or missing chunk stops the walk: what is not heard closes nothing", () => {
    const silence = (seqs: number[]) => seqs.map((s) => chunk(s, "silent"));
    expect(
      closeConversations(
        [chunk(0, "speech"), chunk(1, "pending"), ...silence([2, 3, 4, 5])],
        [],
        GAP,
      ),
    ).toEqual([]);
    expect(closeConversations([chunk(0, "speech"), ...silence([2, 3, 4, 5])], [], GAP)).toEqual([]);
  });

  test("a chunk that failed is never a gap", () => {
    const chunks = [chunk(0, "speech"), ...[1, 2, 3, 4].map((s) => chunk(s, "failed"))];
    expect(closeConversations(chunks, [], GAP)).toEqual([]);
  });

  test("speech after an unheard stretch that long starts a new conversation", () => {
    // The device sent nothing for ten minutes between chunk 0 and chunk 1.
    const later = { ...chunk(1, "speech"), startedAt: new Date(START + 600_000).toISOString() };
    expect(spans(closeConversations([chunk(0, "speech"), later], [], GAP))).toEqual([[1, 0, 0]]);
  });

  test("a gap of zero turns splitting off", () => {
    const chunks = [chunk(0, "speech"), ...[1, 2, 3, 4].map((s) => chunk(s, "silent"))];
    expect(closeConversations(chunks, [], 0)).toEqual([]);
  });

  test("at the end the open conversation closes too, reaching the session's last part", () => {
    const chunks = [
      chunk(0, "speech"),
      ...[1, 2, 3, 4].map((s) => chunk(s, "silent")),
      chunk(5, "speech"),
      // 6 never arrived; 7 is silence.
      chunk(7, "silent"),
    ];
    expect(spans(closeConversations(chunks, [], GAP, { lastSeq: 7 }))).toEqual([
      [1, 0, 0],
      [2, 5, 7],
    ]);
  });

  test("at the end, trailing silence goes to the last conversation closed in the walk", () => {
    const chunks = [chunk(0, "speech"), ...[1, 2, 3, 4, 5].map((s) => chunk(s, "silent"))];
    expect(spans(closeConversations(chunks, [], GAP, { lastSeq: 5 }))).toEqual([[1, 0, 5]]);
  });
});
