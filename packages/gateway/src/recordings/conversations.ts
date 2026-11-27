// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Splitting an all-day (`ambient`) recording into conversations.
 *
 * A session captured all day can stay open for hours. Rather than wait for its
 * end, the gateway closes a conversation once the recording has gone
 * `gapMs` without speech after it, so the conversation gets its document and
 * its speakers while the session goes on. A conversation runs from its first
 * chunk holding speech to its last; the silent chunks between two
 * conversations belong to neither.
 *
 * The rule reads settled chunks only, in order, and stops at the first chunk
 * that is missing or still waiting for the transcriber: what it has not heard
 * neither closes a conversation nor extends one. Chunk granularity: a chunk
 * belongs to one conversation whole.
 *
 * Pure: the service computes spans on a reader and hands the writer finished
 * rows.
 */

import type { RecordingChunk } from "./storage.js";

/** One conversation of a session: a run of its chunks. */
export interface ConversationSpan {
  /** 1-based, in recording order. */
  n: number;
  firstSeq: number;
  lastSeq: number;
  /** Start of the first chunk. */
  startedAt: string;
  /** End of the last chunk holding speech. */
  endedAt: string;
}

type Chunk = Pick<
  RecordingChunk,
  "seq" | "startedAt" | "durationMs" | "status" | "text" | "segments"
>;

interface Interval {
  startMs: number;
  endMs: number;
}

/**
 * Where a chunk holds speech, as absolute ms. A transcript without timings
 * counts as speech for the whole chunk; a chunk that could not be transcribed
 * might hold speech, so it counts too and never opens a gap. Null while the
 * chunk is pending.
 */
export function chunkSpeech(chunk: Chunk): Interval[] | null {
  const start = Date.parse(chunk.startedAt);
  const whole = [{ startMs: start, endMs: start + chunk.durationMs }];
  switch (chunk.status) {
    case "pending":
      return null;
    case "silent":
      return [];
    case "failed":
      return whole;
    case "transcribed": {
      const spoken = (chunk.segments ?? []).filter((s) => s.text.trim() !== "");
      if (spoken.length > 0) {
        return spoken.map((s) => ({ startMs: start + s.startMs, endMs: start + s.endMs }));
      }
      return (chunk.segments ?? []).length === 0 && chunk.text?.trim() ? whole : [];
    }
  }
}

interface Open {
  firstSeq: number;
  lastSeq: number;
  startedAt: string;
  lastSpeechEndMs: number;
  endedAt: string;
}

/**
 * Walk `chunks` (one session's, any order) from the chunk after the last
 * closed conversation, and return the conversations that are now closed:
 * followed by `gapMs` of heard time without speech, or by later speech that
 * starts at least `gapMs` after them. With `final`, the session has ended:
 * missing chunks are passed over and the conversation still open closes
 * too, reaching to `lastSeq` so the parts that never arrived stay with it.
 */
export function closeConversations(
  chunks: readonly Chunk[],
  closed: readonly Pick<ConversationSpan, "n" | "lastSeq">[],
  gapMs: number,
  final?: { lastSeq: number },
): ConversationSpan[] {
  if (gapMs <= 0) return [];
  const last = closed.at(-1);
  const from = last ? last.lastSeq + 1 : 0;
  const ordered = [...chunks].filter((c) => c.seq >= from).sort((a, b) => a.seq - b.seq);
  const out: ConversationSpan[] = [];
  let n = (last?.n ?? 0) + 1;
  let open: Open | null = null;
  let expected = from;

  const close = (span: Open, lastSeq = span.lastSeq) => {
    out.push({
      n: n++,
      firstSeq: span.firstSeq,
      lastSeq,
      startedAt: span.startedAt,
      endedAt: span.endedAt,
    });
  };

  for (const chunk of ordered) {
    if (chunk.seq !== expected && !final) break;
    expected = chunk.seq + 1;
    const speech = chunkSpeech(chunk);
    if (speech === null) {
      if (final) continue;
      break;
    }
    if (speech.length > 0) {
      const first = Math.min(...speech.map((s) => s.startMs));
      const end = Math.max(...speech.map((s) => s.endMs));
      if (open && first - open.lastSpeechEndMs >= gapMs) {
        close(open);
        open = null;
      }
      if (open) {
        open.lastSeq = chunk.seq;
        open.lastSpeechEndMs = Math.max(open.lastSpeechEndMs, end);
        open.endedAt = new Date(open.lastSpeechEndMs).toISOString();
      } else {
        open = {
          firstSeq: chunk.seq,
          lastSeq: chunk.seq,
          startedAt: chunk.startedAt,
          lastSpeechEndMs: end,
          endedAt: new Date(end).toISOString(),
        };
      }
    }
    const heardUntil = Date.parse(chunk.startedAt) + chunk.durationMs;
    if (open && heardUntil - open.lastSpeechEndMs >= gapMs) {
      close(open);
      open = null;
    }
  }
  if (final && open) close(open, Math.max(open.lastSeq, final.lastSeq));
  else if (final && out.length > 0) {
    const tail = out[out.length - 1]!;
    tail.lastSeq = Math.max(tail.lastSeq, final.lastSeq);
  }
  return out;
}
