// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Renders one recorded conversation into the text of its document.
 *
 * Each chunk's transcript becomes one paragraph stamped with its offset from
 * the start of the recording (`[00:12:30]`). What is not speech is said in a
 * line of its own, so a reader can tell a pause from a lost upload: a run of
 * silence, a stretch where recording was paused, the microphone taken by a
 * call, a chunk that could not be transcribed, and chunks that never arrived.
 *
 * Pure: the same session and chunks always render the same text.
 */

// See #858 — planned: one line per transcriber segment instead of per chunk.
import type { RecordingChunk, RecordingSession } from "../../recordings/storage.js";

/** A pause between two chunks shorter than this is the recorder's own seam, not a gap. */
const GAP_THRESHOLD_MS = 5_000;

export interface RenderedRecording {
  title: string;
  body: string;
  /** Audio covered by the recording, start to end, in seconds. */
  durationSec: number;
  /** Whether any chunk carried speech the transcriber understood. */
  hasSpeech: boolean;
}

/** `hh:mm:ss` for an offset in milliseconds. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/** "3 min", "45 s", "1 h 20 min" for a span in milliseconds. */
export function formatSpan(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec} s`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The session's local start as `YYYY-MM-DD HH:MM`, in the offset the device
 * recorded in (UTC when it sent none).
 */
export function localStart(
  session: Pick<RecordingSession, "startedAt" | "startedUtcOffsetSeconds">,
): string {
  const offsetMs = (session.startedUtcOffsetSeconds ?? 0) * 1000;
  const local = new Date(Date.parse(session.startedAt) + offsetMs).toISOString();
  return `${local.slice(0, 10)} ${local.slice(11, 16)}`;
}

export function recordingTitle(session: RecordingSession): string {
  const given = session.title?.trim();
  return given && given.length > 0 ? given : `Conversation, ${localStart(session)}`;
}

/** Render a session from its stored chunks (any order; missing ones are named). */
export function renderRecording(
  session: RecordingSession,
  chunks: readonly RecordingChunk[],
): RenderedRecording {
  const start = Date.parse(session.startedAt);
  const sorted = [...chunks].sort((a, b) => a.seq - b.seq);
  const lines: string[] = [];
  let cursorMs = 0;
  let silentRunMs = 0;
  let silentRunAt = 0;
  let hasSpeech = false;
  let expectedSeq = 0;

  const flushSilence = (): void => {
    if (silentRunMs >= GAP_THRESHOLD_MS) {
      lines.push(`[${formatOffset(silentRunAt)}] — silence, ${formatSpan(silentRunMs)} —`);
    }
    silentRunMs = 0;
  };

  for (const chunk of sorted) {
    const offset = Date.parse(chunk.startedAt) - start;
    if (chunk.seq > expectedSeq) {
      flushSilence();
      const missing = chunk.seq - expectedSeq;
      lines.push(
        `[${formatOffset(cursorMs)}] — ${missing === 1 ? "a part" : `${missing} parts`} of the recording did not arrive —`,
      );
    } else if (offset - cursorMs >= GAP_THRESHOLD_MS) {
      flushSilence();
      lines.push(
        `[${formatOffset(cursorMs)}] — recording paused, ${formatSpan(offset - cursorMs)} —`,
      );
    }
    expectedSeq = chunk.seq + 1;
    cursorMs = Math.max(cursorMs, offset + chunk.durationMs);

    // A call taking the microphone usually leaves silence behind it, so the
    // interruption is said before the chunk joins a silent run.
    if (chunk.interrupted) {
      flushSilence();
      lines.push(`[${formatOffset(offset)}] — the microphone was interrupted —`);
    }
    const text = chunk.status === "transcribed" ? (chunk.text ?? "").trim() : "";
    if (chunk.status === "silent" || (chunk.status === "transcribed" && text.length === 0)) {
      if (silentRunMs === 0) silentRunAt = offset;
      silentRunMs += chunk.durationMs;
      continue;
    }
    flushSilence();
    if (chunk.status === "failed") {
      lines.push(`[${formatOffset(offset)}] — this part could not be transcribed —`);
    } else if (chunk.status === "transcribed") {
      hasSpeech = true;
      lines.push(`[${formatOffset(offset)}] ${text}`);
    }
  }
  flushSilence();
  if (session.chunkCount !== null && session.chunkCount > expectedSeq) {
    const missing = session.chunkCount - expectedSeq;
    lines.push(
      `[${formatOffset(cursorMs)}] — ${missing === 1 ? "a part" : `${missing} parts`} of the recording did not arrive —`,
    );
  }

  const endMs = session.endedAt ? Date.parse(session.endedAt) - start : cursorMs;
  const durationMs = Math.max(cursorMs, Number.isFinite(endMs) ? endMs : 0);
  const title = recordingTitle(session);
  const header = [
    `# ${title}`,
    "",
    `Recorded conversation · ${localStart(session)} · ${formatSpan(durationMs)}`,
  ];
  return {
    title,
    body: [...header, "", ...lines].join("\n").trimEnd(),
    durationSec: Math.round(durationMs / 1000),
    hasSpeech,
  };
}
