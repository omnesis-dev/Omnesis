// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Voice notes: Tell Omnesis captures that arrive with their audio, for the
 * gateway's transcriber to transcribe after the fact.
 *
 * `accept` is fire-and-forget for the device: it saves the note at once — with
 * the device's own transcript, or a placeholder when the device had none — and
 * queues the audio. A background loop then transcribes queued notes one at a
 * time and replaces each note's text with the transcript, but only while the
 * note still reads what it was saved with, so an edit made meanwhile wins.
 *
 * A failed transcription is retried with backoff. A note that cannot be
 * transcribed after `MAX_ATTEMPTS`, or within `MAX_AGE_MS`, keeps the device's
 * transcript; a placeholder is replaced with a line saying so. Time spent
 * without a runnable transcriber does not count as an attempt, only toward the
 * age limit.
 */

import { createLogger } from "@omnesis/core";
import {
  getPendingVoiceNote,
  listDuePendingVoiceNotes,
  readPendingVoiceNoteAudio,
  type PendingVoiceNote,
} from "./storage.js";
import type { CaptureNoteInput, OmnesisNotesRuntime } from "../sources/omnesis-notes/index.js";
import type { TranscriberReadiness } from "../transcribe/index.js";
import type { TranscriptionResult } from "@omnesis/core";
import type { WriteGate } from "../write-gate.js";
import type Database from "better-sqlite3";

const log = createLogger("gateway:voice-notes");

/** The note's text while the gateway has no transcript and the device sent none. */
export const TRANSCRIBING_PLACEHOLDER = "Voice note — transcribing…";
/** The note's text when a placeholder note could not be transcribed. */
export const UNTRANSCRIBED_TEXT = "Voice note — it could not be transcribed.";

/** Transcription attempts before a note keeps the text it was saved with. */
export const MAX_ATTEMPTS = 6;
/** How long a note may wait for a transcript at all. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Delay before each retry after a failed attempt (the last value repeats). */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
/** How often a note is re-checked while no transcriber can run. */
const UNAVAILABLE_RECHECK_MS = 30 * 60_000;
/**
 * The least time a transcription may take before it is given up, per attempt.
 * Nobody waits on a voice note, so a slow host gets far more than a backend's
 * own deadline, and more again on each retry.
 */
const PATIENCE_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000];
/** How often the loop looks for due notes when nothing wakes it sooner. */
const POLL_INTERVAL_MS = 60_000;

/** A voice note as it arrives: the capture's metadata, its audio, and the device's transcript. */
export interface VoiceNoteInput extends Omit<CaptureNoteInput, "text" | "id" | "captureContext"> {
  /** The note's id: the capture's idempotency key. */
  id: string;
  /** The device's own transcript; empty when it had none. */
  fallbackText: string;
  audio: Uint8Array;
  mimeType: string;
  /** ISO 639 language hint, when the device knows it. */
  language?: string;
}

export interface VoiceNoteServiceDeps {
  notes: () => OmnesisNotesRuntime;
  writeGate: Pick<WriteGate, "enqueueVoiceNote" | "rescheduleVoiceNote" | "deleteVoiceNote">;
  readDb: Database.Database;
  transcribe: (
    audio: Uint8Array,
    mimeType: string,
    opts?: { language?: string; minTimeoutMs?: number },
  ) => Promise<TranscriptionResult | null>;
  readiness: () => TranscriberReadiness;
  now?: () => Date;
}

export class VoiceNoteService {
  private readonly deps: VoiceNoteServiceDeps;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining: Promise<void> | null = null;
  private rerun = false;
  private disposed = false;

  constructor(deps: VoiceNoteServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Save the note and queue its audio. Idempotent per note id: a retried
   * capture returns without queueing the audio twice, and a note whose text has
   * already moved on (transcribed or edited) is not queued again.
   */
  async accept(input: VoiceNoteInput): Promise<{ id: string }> {
    const fallback = input.fallbackText.trim();
    const savedText = fallback.length > 0 ? fallback : TRANSCRIBING_PLACEHOLDER;
    const entry = await this.deps.notes().capture({
      id: input.id,
      text: savedText,
      capturedAt: input.capturedAt,
      capturedTimeZoneId: input.capturedTimeZoneId,
      capturedUtcOffsetSeconds: input.capturedUtcOffsetSeconds,
      surface: input.surface,
      deviceId: input.deviceId,
      latitude: input.latitude,
      longitude: input.longitude,
      placeName: input.placeName,
    });
    if (entry.text !== savedText) return { id: entry.id };
    const queued = await this.deps.writeGate.enqueueVoiceNote({
      noteId: entry.id,
      audio: input.audio,
      mimeType: input.mimeType,
      language: input.language ?? null,
      savedText,
      placeholder: fallback.length === 0,
      nextAttemptAt: this.now().toISOString(),
      createdAt: this.now().toISOString(),
    });
    if (queued) {
      log.info(
        `Queued voice note ${entry.id} (${input.audio.byteLength} bytes, ${input.mimeType})`,
      );
      this.kick();
    }
    return { id: entry.id };
  }

  /** Start the background loop; it also picks up notes queued before a restart. */
  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => this.kick(), POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.kick();
  }

  /** Run a pass now, or right after the one in progress. */
  kick(): void {
    if (this.disposed) return;
    if (this.draining) {
      this.rerun = true;
      return;
    }
    this.draining = this.drain()
      .catch((err) => {
        log.warn(`Voice note pass failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.draining = null;
        if (this.rerun && !this.disposed) {
          this.rerun = false;
          this.kick();
        }
      });
  }

  /** Resolves once no pass is running (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.disposed) return;
      const [next] = listDuePendingVoiceNotes(this.deps.readDb, this.now().toISOString(), 1);
      if (!next) return;
      await this.process(next);
    }
  }

  private async process(note: PendingVoiceNote): Promise<void> {
    const age = this.now().getTime() - Date.parse(note.createdAt);
    const readiness = this.deps.readiness();
    if (!readiness.runnable) {
      if (age >= MAX_AGE_MS) return this.giveUp(note, "no transcriber could run");
      return this.deps.writeGate.rescheduleVoiceNote(
        note.noteId,
        note.attempts,
        this.later(UNAVAILABLE_RECHECK_MS),
      );
    }

    const audio = readPendingVoiceNoteAudio(this.deps.readDb, note.noteId);
    if (!audio) return;
    const result = await this.deps.transcribe(audio, note.mimeType, {
      ...(note.language ? { language: note.language } : {}),
      minTimeoutMs: PATIENCE_MS[Math.min(note.attempts, PATIENCE_MS.length - 1)],
    });
    // The note may have been deleted while it was being transcribed; its row
    // went with it, and there is nothing left to update.
    if (!getPendingVoiceNote(this.deps.readDb, note.noteId)) return;

    if (result === null) {
      const attempts = note.attempts + 1;
      if (attempts >= MAX_ATTEMPTS || age >= MAX_AGE_MS) {
        return this.giveUp(note, `${attempts} attempts failed`);
      }
      const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
      return this.deps.writeGate.rescheduleVoiceNote(note.noteId, attempts, this.later(delay));
    }

    const text = result.text.trim();
    if (text.length === 0) return this.giveUp(note, "no speech was recognised");
    const outcome = await this.deps.notes().replaceTextIf(note.noteId, note.savedText, text);
    await this.deps.writeGate.deleteVoiceNote(note.noteId);
    log.info(`Transcribed voice note ${note.noteId}: ${outcome} (${text.length} chars)`);
  }

  /** Stop trying: a placeholder says so, the device's transcript stays. */
  private async giveUp(note: PendingVoiceNote, why: string): Promise<void> {
    if (note.placeholder) {
      await this.deps.notes().replaceTextIf(note.noteId, note.savedText, UNTRANSCRIBED_TEXT);
    }
    await this.deps.writeGate.deleteVoiceNote(note.noteId);
    log.warn(`Voice note ${note.noteId} not transcribed (${why}); kept its saved text`);
  }

  private later(ms: number): string {
    return new Date(this.now().getTime() + ms).toISOString();
  }
}
