// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Recorded conversations (experimental): a phone records a conversation with
 * the screen off and uploads it as numbered chunks while it records; this
 * service transcribes the chunks as they arrive and writes one document per
 * session once it is finished and every chunk is settled.
 *
 * Transcription runs at background priority, so a note being dictated or a
 * spoken question never waits behind an hour of meeting audio. A long
 * meeting is then mostly transcribed by the time it ends. Each chunk's audio
 * is dropped as soon as the chunk is settled — transcribed, or given up on
 * after `MAX_ATTEMPTS` or `MAX_AGE_MS` — so the transcript is what stays.
 * See #864 — planned: an optional audio retention setting.
 *
 * Sessions converge without the device: one the device stops talking to is
 * finished after `ABANDONED_AFTER_MS` with the chunks it sent (provisionally:
 * a chunk uploaded later reopens it, and the device's own finish replaces
 * the count), and a finished
 * session still missing chunks is written with the gap named after
 * `MISSING_GRACE_MS`. The document is written once per change of the session,
 * never per chunk, so the Brain reads a finished conversation, not a stream.
 */

import { assertNever, createLogger } from "@omnesis/core";
import {
  getRecordingChunk,
  getRecordingSession,
  listAbandonedRecordingSessions,
  listDueRecordingChunks,
  listRecordingChunks,
  listUnprojectedRecordingSessions,
  countRecordingChunks,
  readRecordingChunkAudio,
  type FinishRecordingOutcome,
  type InsertRecordingChunkOutcome,
  type RecordingChunk,
  type RecordingSession,
} from "./storage.js";
import type {
  TranscriberReadiness,
  TranscribeOptions,
  TranscriptionOutcome,
} from "../transcribe/index.js";
import type { DocumentInput } from "@omnesis/types";
import type { WriteGate } from "../write-gate.js";
import type Database from "better-sqlite3";

const log = createLogger("gateway:recordings");

/** Transcription attempts before a chunk is given up on. */
export const MAX_ATTEMPTS = 6;
/** How long a chunk may wait for a transcript at all. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A session the device has not touched for this long is finished for it. */
export const ABANDONED_AFTER_MS = 12 * 60 * 60 * 1000;
/** How long a finished session waits for chunks it declared but never sent. */
export const MISSING_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Delay before each retry after a failed attempt (the last value repeats). */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
/** How often a chunk is re-checked while no transcriber can run. */
const UNAVAILABLE_RECHECK_MS = 30 * 60_000;
/** The least time each attempt may take; nobody waits on a chunk. */
const PATIENCE_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000];
/** How often the loop looks for work when nothing wakes it sooner. */
const POLL_INTERVAL_MS = 60_000;
/** Sessions handled per sweep step, so one pass never walks the whole ledger. */
const SWEEP_BATCH = 20;

export interface RecordingServiceDeps {
  writeGate: Pick<
    WriteGate,
    | "createRecordingSession"
    | "insertRecordingChunk"
    | "deleteRecordingSession"
    | "finishRecordingSession"
    | "abandonRecordingSession"
    | "rescheduleRecordingChunk"
    | "settleRecordingChunk"
    | "markRecordingSessionProjected"
  >;
  readDb: Database.Database;
  transcribe: (
    audio: Uint8Array,
    mimeType: string,
    opts?: TranscribeOptions,
  ) => Promise<TranscriptionOutcome>;
  /** The transcriber's readiness, once anything it is still checking has settled. */
  readiness: () => Promise<TranscriberReadiness>;
  /** Document write path — DocumentService.ingest in production. */
  ingest: (docs: DocumentInput[]) => Promise<unknown>;
  /** Drops the session's document, if any. */
  deleteDocument: (externalId: string) => Promise<unknown>;
  /** Renders a session into its document; null when there is nothing to keep. */
  buildDocument: (
    session: RecordingSession,
    chunks: readonly RecordingChunk[],
  ) => DocumentInput | null;
  now?: () => Date;
}

/** A session as the device opens it. */
export interface StartRecordingInput {
  id: string;
  title?: string;
  startedAt: string;
  startedTimeZoneId?: string;
  startedUtcOffsetSeconds?: number;
  language?: string;
  deviceId?: string;
  /** Set by the authenticated ingress, never by client metadata. */
  allowVocabulary: boolean;
}

/** One uploaded chunk. */
export interface RecordingChunkInput {
  sessionId: string;
  seq: number;
  startedAt: string;
  durationMs: number;
  silent: boolean;
  interrupted: boolean;
  audio: Uint8Array | null;
  mimeType: string | null;
}

export type RecordingState = "recording" | "transcribing" | "done";

/** What a device sees of one of its sessions. */
export interface RecordingStatus {
  id: string;
  title: string | null;
  state: RecordingState;
  chunkCount: number | null;
  chunks: {
    received: number;
    pending: number;
    transcribed: number;
    failed: number;
    silent: number;
  };
  /** Whether the session's document is written and current. */
  projected: boolean;
}

export class RecordingTranscriptionService {
  private readonly deps: RecordingServiceDeps;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining: Promise<void> | null = null;
  private rerun = false;
  private disposed = false;

  constructor(deps: RecordingServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Open a session. Idempotent per id: a retried start changes nothing. */
  async startSession(input: StartRecordingInput): Promise<{ created: boolean }> {
    const created = await this.deps.writeGate.createRecordingSession({
      id: input.id,
      deviceId: input.deviceId ?? null,
      title: input.title?.trim() || null,
      startedAt: input.startedAt,
      startedTimeZoneId: input.startedTimeZoneId ?? null,
      startedUtcOffsetSeconds: input.startedUtcOffsetSeconds ?? null,
      language: input.language ?? null,
      allowVocabulary: input.allowVocabulary,
      createdAt: this.now().toISOString(),
    });
    if (created) log.info(`Opened recording ${input.id} (started ${input.startedAt})`);
    return { created };
  }

  /**
   * Store one chunk and queue it for the transcriber. Idempotent per
   * `(session, seq)`. `missing` when the session does not exist; `beyond`
   * when the device finished the session with fewer chunks than this seq.
   */
  async addChunk(input: RecordingChunkInput): Promise<InsertRecordingChunkOutcome> {
    const outcome = await this.deps.writeGate.insertRecordingChunk({
      ...input,
      receivedAt: this.now().toISOString(),
    });
    if (outcome === "stored") this.kick();
    return outcome;
  }

  /**
   * The device declares the session's chunk count. A repeat of the same
   * count is `already`; a different one, or one below a chunk already
   * stored, is `conflict`.
   */
  async finish(id: string, chunkCount: number, endedAt: string): Promise<FinishRecordingOutcome> {
    const outcome = await this.deps.writeGate.finishRecordingSession(
      id,
      chunkCount,
      endedAt,
      this.now().toISOString(),
    );
    if (outcome === "finished") {
      log.info(`Recording ${id} finished with ${chunkCount} chunks`);
      this.kick();
    }
    return outcome;
  }

  status(id: string): RecordingStatus | null {
    const session = getRecordingSession(this.deps.readDb, id);
    if (!session) return null;
    const counts = countRecordingChunks(this.deps.readDb, id);
    const received = counts.pending + counts.transcribed + counts.failed + counts.silent;
    const projected =
      session.projectedRevision !== null && session.projectedRevision >= session.revision;
    const state: RecordingState =
      session.finishedAt === null ? "recording" : projected ? "done" : "transcribing";
    return {
      id,
      title: session.title,
      state,
      chunkCount: session.chunkCount,
      chunks: { received, ...counts },
      projected,
    };
  }

  /** Delete a session, its chunks and its document. False when it did not exist. */
  async delete(id: string): Promise<boolean> {
    const deleted = await this.deps.writeGate.deleteRecordingSession(id);
    await this.deps.deleteDocument(id);
    if (deleted) log.info(`Deleted recording ${id}`);
    return deleted;
  }

  /** Start the background loop; it also picks up work left before a restart. */
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
    this.draining = this.pass()
      .catch((err) => {
        log.warn(`Recording pass failed: ${err instanceof Error ? err.message : String(err)}`);
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

  private async pass(): Promise<void> {
    await this.finishAbandoned();
    for (;;) {
      if (this.disposed) return;
      const [next] = listDueRecordingChunks(this.deps.readDb, this.now().toISOString(), 1);
      if (!next) break;
      try {
        await this.process(next);
      } catch (err) {
        // A throw must not leave the chunk at the head of the queue: count
        // it as a failed attempt so it backs off and is eventually given up.
        log.warn(
          `Recording ${next.sessionId} chunk ${next.seq} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.retryLater(next);
      }
      // Write a session out as soon as its last chunk settles, not after the
      // whole backlog of every other session.
      await this.projectReady();
    }
    await this.projectReady();
  }

  private async finishAbandoned(): Promise<void> {
    const idleBefore = this.later(-ABANDONED_AFTER_MS);
    for (const session of listAbandonedRecordingSessions(
      this.deps.readDb,
      idleBefore,
      SWEEP_BATCH,
    )) {
      const finished = await this.deps.writeGate.abandonRecordingSession(
        session.id,
        this.now().toISOString(),
      );
      if (finished) {
        log.info(
          `Finished recording ${session.id} for its device: idle since ${session.lastActivityAt}`,
        );
      }
    }
  }

  private async projectReady(): Promise<void> {
    const missingCutoff = this.later(-MISSING_GRACE_MS);
    // Each session at most once per call: one changed again meanwhile comes
    // round on the next pass rather than holding this one.
    const done = new Set<string>();
    for (;;) {
      if (this.disposed) return;
      const ready = listUnprojectedRecordingSessions(
        this.deps.readDb,
        missingCutoff,
        SWEEP_BATCH,
      ).filter((session) => !done.has(session.id));
      if (ready.length === 0) return;
      for (const session of ready) {
        done.add(session.id);
        try {
          await this.project(session.id);
        } catch (err) {
          // Left unprojected: the next pass tries it again, and the other
          // sessions are not held behind it.
          log.warn(
            `Recording ${session.id} not written: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  private async project(sessionId: string): Promise<void> {
    // The revision is read with the session, before the chunks: a change
    // landing after this read bumps it past the one recorded below, and the
    // session comes round again.
    const session = getRecordingSession(this.deps.readDb, sessionId);
    if (!session) return;
    const chunks = listRecordingChunks(this.deps.readDb, sessionId);
    const doc = this.deps.buildDocument(session, chunks);
    if (doc) await this.deps.ingest([doc]);
    else await this.deps.deleteDocument(sessionId);
    // A delete that landed while the document was written must not leave
    // the document behind.
    if (!getRecordingSession(this.deps.readDb, sessionId)) {
      await this.deps.deleteDocument(sessionId);
      return;
    }
    await this.deps.writeGate.markRecordingSessionProjected(sessionId, session.revision);
    log.info(
      doc
        ? `Wrote recording ${sessionId}: ${chunks.length} chunks, ${doc.content.length} chars`
        : `Recording ${sessionId} has no speech; no document`,
    );
  }

  private async process(chunk: RecordingChunk): Promise<void> {
    const age = this.now().getTime() - Date.parse(chunk.receivedAt);
    const readiness = await this.deps.readiness();
    if (!readiness.runnable) {
      if (age >= MAX_AGE_MS) return this.giveUp(chunk, "no transcriber could run");
      return this.deps.writeGate.rescheduleRecordingChunk(
        chunk.sessionId,
        chunk.seq,
        chunk.attempts,
        this.later(UNAVAILABLE_RECHECK_MS),
      );
    }

    const audio = readRecordingChunkAudio(this.deps.readDb, chunk.sessionId, chunk.seq);
    const session = getRecordingSession(this.deps.readDb, chunk.sessionId);
    if (!audio || !session) return this.giveUp(chunk, "its audio is gone");
    const outcome = await this.deps.transcribe(
      audio,
      chunk.mimeType ?? "application/octet-stream",
      {
        priority: "background",
        ...(session.language ? { language: session.language } : {}),
        minTimeoutMs: PATIENCE_MS[Math.min(chunk.attempts, PATIENCE_MS.length - 1)],
        allowVocabulary: session.allowVocabulary,
        context: {
          purpose: "source-audio",
          recordedAt: chunk.startedAt,
          ...(session.language ? { languageHints: [session.language] } : {}),
        },
      },
    );
    // The session may have been deleted while this chunk was transcribed.
    if (!getRecordingChunk(this.deps.readDb, chunk.sessionId, chunk.seq)) return;

    switch (outcome.kind) {
      case "transcribed":
        await this.deps.writeGate.settleRecordingChunk(chunk.sessionId, chunk.seq, {
          status: "transcribed",
          text: outcome.result.text.trim(),
        });
        return;
      case "unreadable":
        // No retry turns bytes that decode to no audio into speech.
        return this.giveUp(chunk, "its audio could not be decoded");
      case "unavailable":
      case "cancelled":
        // Not the chunk's fault: try again later without spending an attempt.
        if (age >= MAX_AGE_MS) return this.giveUp(chunk, "no transcriber could run");
        return this.deps.writeGate.rescheduleRecordingChunk(
          chunk.sessionId,
          chunk.seq,
          chunk.attempts,
          this.later(UNAVAILABLE_RECHECK_MS),
        );
      case "failed":
        return this.retryLater(chunk);
      default:
        assertNever(outcome);
    }
  }

  /** Count a failed attempt: back off, or give up once out of attempts or time. */
  private async retryLater(chunk: RecordingChunk): Promise<void> {
    const attempts = chunk.attempts + 1;
    const age = this.now().getTime() - Date.parse(chunk.receivedAt);
    if (attempts >= MAX_ATTEMPTS || age >= MAX_AGE_MS) {
      return this.giveUp(chunk, `${attempts} attempts failed`);
    }
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
    await this.deps.writeGate.rescheduleRecordingChunk(
      chunk.sessionId,
      chunk.seq,
      attempts,
      this.later(delay),
    );
  }

  private async giveUp(chunk: RecordingChunk, why: string): Promise<void> {
    await this.deps.writeGate.settleRecordingChunk(chunk.sessionId, chunk.seq, {
      status: "failed",
    });
    log.warn(`Recording ${chunk.sessionId} chunk ${chunk.seq} not transcribed (${why})`);
  }

  private later(ms: number): string {
    return new Date(this.now().getTime() + ms).toISOString();
  }
}
