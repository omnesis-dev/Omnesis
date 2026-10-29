// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Audio transcription seam for sources.
 *
 * A source that carries audio (e.g. WhatsApp voice notes) is handed an
 * `AudioTranscribeFn` the same way it's handed an `AttachmentExtractFn` for
 * binary documents. The collector implements it by forwarding the audio
 * bytes to the gateway's `/inference/transcribe` endpoint, which runs the
 * configured transcriber (a local Whisper model or an HTTP transcription
 * backend) and returns the transcript.
 * The model lives on the gateway (where the GPU and the always-on compute
 * are); the source only ever holds the bytes transiently.
 *
 * Returning `null` means "no transcript" — transcription is disabled, no
 * transcriber is assigned, the audio couldn't be fetched/decoded, or no
 * speech was detected. Callers fall back to a plain placeholder.
 */

import { assertNever } from "./utils.js";
import type { TranscriptionResult } from "./models/capabilities.js";
import type { PersonIdentifier, SourceId, SyncIssue } from "@omnesis/types";

/** A known canonical person or source-native identifiers resolved by the gateway. */
export interface TranscriptionPerson {
  personId?: string;
  isSelf?: boolean;
  identifiers?: PersonIdentifier[];
}

/** The situation in which speech was recorded, independent of the recognizer. */
export interface TranscriptionContext {
  purpose: "source-audio" | "dictation" | "agent";
  speaker?: TranscriptionPerson;
  conversation?: { sourceId: SourceId; threadId: string };
  participants?: TranscriptionPerson[];
  languageHints?: string[];
  recordedAt?: string;
}

/** Relevance scores select hints; they are not recognizer boost values. */
export interface TranscriptionVocabularyEntry {
  text: string;
  score: number;
}

export interface TranscriptionVocabulary {
  entries: TranscriptionVocabularyEntry[];
}

export type { TranscriptionResult } from "./models/capabilities.js";

/**
 * The longest the gateway works on one recording, whichever backend runs it.
 * Each chunk has its own, shorter deadline, so a hung backend is given up long
 * before this; it bounds the whole of a long recording on a slow host, and so
 * how long one recording may hold the gateway's single transcription queue.
 * Six hours covers two hours of audio from Whisper on a CPU (three seconds per
 * second of audio), but only about half an hour from an audio language model
 * on a CPU at twelve seconds per second. A client waiting on
 * `/inference/transcribe` must allow at least this long rather than an HTTP
 * library's default response deadline.
 */
export const MAX_TRANSCRIPTION_MS = 6 * 60 * 60_000;

export type AudioTranscribeFn = (
  data: Uint8Array,
  mimeType: string,
  opts?: {
    /** ISO-639-1 hint to skip language auto-detection. */
    language?: string;
    context?: TranscriptionContext;
  },
) => Promise<TranscriptionResult | null>;

/**
 * The error a source records against an audio item when the gateway answered
 * that no transcriber can run. The assigned model may be missing or its backend unavailable,
 * so the sources keep it distinguishable from every other
 * reason a transcript is missing. It is a per-item note in a source's own
 * store, not the HTTP error code the gateway's routes answer with.
 */
export const TRANSCRIBER_UNAVAILABLE = "transcriber-unavailable";

/**
 * Why an audio item renders as a placeholder instead of its spoken text. A
 * source works this out from its own lifecycle before rendering a
 * conversation, so a reader of the document can tell a note that is queued
 * from one that will never be transcribed.
 *
 * - `awaiting`                — queued, or backing off after a failed attempt.
 * - `transcriber-unavailable` — the gateway has no transcriber to run; retried
 *                               once one is assigned.
 * - `no-speech`               — transcribed, and nothing was said.
 * - `audio-unavailable`       — the audio is gone from the source for good.
 * - `audio-missing`           — the audio was never downloaded to this device.
 */
export type TranscriptionPlaceholderState =
  "awaiting" | "transcriber-unavailable" | "no-speech" | "audio-unavailable" | "audio-missing";

/** The words every conversation source puts after its audio placeholder. */
export function transcriptionPlaceholderNote(state: TranscriptionPlaceholderState): string {
  switch (state) {
    case "awaiting":
      return "awaiting transcription";
    case "transcriber-unavailable":
      return "no transcriber available";
    case "no-speech":
      return "no speech detected";
    case "audio-unavailable":
      return "audio unavailable";
    case "audio-missing":
      return "audio not downloaded on this device";
    default:
      return assertNever(state);
  }
}

/** What a source carrying audio reports about the items it has not transcribed. */
export interface TranscriptionBacklog {
  /** Items with no transcript yet, including those waiting for a transcriber. */
  awaiting: number;
  /** Items whose last attempt found no transcriber to run. */
  transcriberUnavailable: number;
  /** Items whose audio is gone for good, so they will never be transcribed. */
  unavailable: number;
}

/**
 * The sync issues a source reports for its transcription backlog, so every
 * client shows the same count next to the source. A backlog a transcriber is
 * working through is information; one that waits for an unavailable transcriber
 * is a warning with troubleshooting steps attached. Audio that is gone is reported
 * once as a warning, since nothing will bring it back.
 */
export function transcriptionSyncIssues(
  backlog: TranscriptionBacklog,
  unit = "voice notes",
): SyncIssue[] {
  const issues: SyncIssue[] = [];
  if (backlog.awaiting > 0) {
    const needsTranscriber = backlog.transcriberUnavailable > 0;
    issues.push({
      code: "transcription-awaiting",
      scope: "item",
      kind: "transient",
      count: backlog.awaiting,
      severity: needsTranscriber ? "warning" : "info",
      message: needsTranscriber
        ? `${countOf(backlog.awaiting, unit)} waiting for a transcriber`
        : `${countOf(backlog.awaiting, unit)} awaiting transcription`,
      ...(needsTranscriber
        ? {
            remediation: {
              summary: "No transcriber is currently available",
              steps: [
                "Check the transcriber under Settings → Models: assign a model if needed, or check that its backend is available.",
                "Already-synced audio is retried on a schedule; resync the source to transcribe it now.",
              ],
              restartRequired: false,
            },
          }
        : {}),
    });
  }
  if (backlog.unavailable > 0) {
    issues.push({
      code: "transcription-audio-unavailable",
      scope: "item",
      kind: "unknown",
      count: backlog.unavailable,
      severity: "warning",
      message: `${countOf(backlog.unavailable, unit)} could not be transcribed: the audio is no longer available from the source`,
    });
  }
  return issues;
}

function countOf(count: number, unit: string): string {
  return count === 1 ? `1 ${unit.replace(/s$/, "")}` : `${count} ${unit}`;
}
