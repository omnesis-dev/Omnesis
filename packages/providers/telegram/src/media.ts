// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The media pass of one `sync()` page (`docs/telegram-source.md` §10).
 *
 * It runs on the days the page drains, never across the archive: voice notes
 * are transcribed into the day's text, photos and documents become attachment
 * documents. Every download is lazy and budgeted — at most
 * `MEDIA_ATTEMPTS_PER_PAGE` per page, one at a time — so a bootstrap enrols
 * its media as `pending` and the retry sweep works through it page after
 * page while text keeps publishing. A failure is recorded in the media
 * lifecycle (`media-retry.ts`) and never fails the page.
 *
 * Results are kept in the archive: a transcript renders on every later render
 * of its day, and an extraction rebuilds its attachment document, so every
 * render emits the day's whole attachment set and the ledger can retire
 * exactly the attachments that are gone.
 *
 * The same rules as WhatsApp's (`packages/providers/whatsapp/src/messages.ts`):
 * the attachment settings are checked before any download, a missing
 * transcriber or extractor is a processing gap retried until one appears, and
 * the placeholder says why a voice note has no text.
 */

import {
  TRANSCRIBER_UNAVAILABLE,
  buildAttachmentDocument,
  computeContentHash,
  createLogger,
  deriveAttachmentStableId,
  formatAttachmentMarkers,
  resolveEffectiveMimeType,
  shouldExtractAttachment,
  toErrorMessage,
} from "@omnesis/core";
import { VOICE_NOTE_MAX_BYTES } from "./limits.js";
import { classifyDownloadFailure, type MediaOutcome } from "./media-retry.js";
import { telegramPersonIdentifiers } from "./normalizer.js";
import type {
  AttachmentExtractFn,
  AttachmentExtractionConfig,
  AttachmentInfo,
  AudioTranscribeFn,
  ExtractionResult,
  TranscriptionPerson,
} from "@omnesis/core";
import type { DocumentInput, SourceId } from "@omnesis/types";
import type { TelegramAdapter, TgDownloaded } from "./client/types.js";
import type { MediaScope, StoredUser, TelegramArchive } from "./message-store.js";
import type { StoredChat, StoredMessage } from "./types.js";

const log = createLogger("source:telegram-messages").child("media");

/** Participants a transcription request names at most. */
const MAX_TRANSCRIPTION_PARTICIPANTS = 32;

export interface MediaPassDeps {
  archive: TelegramArchive;
  adapter: TelegramAdapter;
  sourceId: SourceId;
  selfId: number;
  transcribeAudio?: AudioTranscribeFn;
  extractAttachment?: AttachmentExtractFn;
  attachmentConfig: AttachmentExtractionConfig;
}

/** Which media this page can process, from what the host offers. */
export function mediaScopeOf(deps: MediaPassDeps, minTs?: number): MediaScope {
  return {
    voiceNotes: !!deps.transcribeAudio,
    attachments: deps.attachmentConfig.enabled && !!deps.extractAttachment,
    ...(minTs !== undefined ? { minTs } : {}),
  };
}

/** What one page may still spend, and what it already tried. */
export interface MediaBudget {
  remaining: number;
  /** `chatId:msgId` of every attempt this page made. */
  attempted: Set<string>;
  /** A cancellation, revocation or flood wait stopped every further download. */
  halted: boolean;
}

export function newMediaBudget(attempts: number): MediaBudget {
  return { remaining: attempts, attempted: new Set(), halted: false };
}

interface DayContext {
  chat: StoredChat;
  messages: StoredMessage[];
  users: ReadonlyMap<number, StoredUser>;
  budget: MediaBudget;
  signal?: AbortSignal;
}

type Download = { ok: true; data: Uint8Array } | { ok: false; reason: "terminal" | "retry" };

export class MediaPass {
  constructor(private readonly deps: MediaPassDeps) {}

  /**
   * Give every voice note of the day its transcript or the reason it has
   * none, transcribing those that are due while the budget lasts. Mutates
   * `messages` for the render that follows.
   */
  async transcribeVoiceNotes(day: DayContext): Promise<void> {
    const transcribe = this.deps.transcribeAudio;
    if (!transcribe) return;
    let participants: TranscriptionPerson[] | undefined;
    for (const m of day.messages) {
      if (m.media?.kind !== "voice") continue;
      m.transcription = placeholderState(m);
      if (!this.due(m, day.budget)) continue;
      const result = await this.download(m, VOICE_NOTE_MAX_BYTES, day);
      if (!result) continue;
      if (!result.ok) {
        m.transcription = result.reason === "terminal" ? "audio-unavailable" : "awaiting";
        continue;
      }
      participants ??= this.participants(day);
      try {
        const transcript = await transcribe(result.data, m.media.mimeType ?? "audio/ogg", {
          context: {
            purpose: "source-audio",
            speaker:
              m.outgoing || m.senderId === this.deps.selfId
                ? { isSelf: true }
                : { identifiers: telegramPersonIdentifiers(m.senderId ?? 0, day.users) },
            conversation: { sourceId: this.deps.sourceId, threadId: String(m.chatId) },
            participants,
            recordedAt: new Date(m.ts * 1000).toISOString(),
          },
        });
        if (transcript === null) {
          // The audio is fine; there is no transcriber yet. Retried until one appears.
          this.record(m, { kind: "process-failed", error: TRANSCRIBER_UNAVAILABLE });
          m.transcription = "transcriber-unavailable";
          continue;
        }
        const text = transcript.text.trim();
        this.record(m, { kind: "transcribed", text });
        m.transcript = text;
        m.changedAt = this.deps.archive.clock();
        m.transcription = text === "" ? "no-speech" : undefined;
      } catch (err) {
        if (day.signal?.aborted) {
          day.budget.halted = true;
          continue;
        }
        log.warn(
          `Telegram voice note ${m.chatId}/${m.msgId} not transcribed: ${toErrorMessage(err)}`,
        );
        this.record(m, { kind: "process-failed", error: toErrorMessage(err) });
        m.transcription = "awaiting";
      }
    }
  }

  /**
   * The day's attachment documents: every photo and document with a kept
   * extraction, plus the ones extracted now while the budget lasts. Adds the
   * attachment markers and `extra.attachments` to `parent`.
   */
  async extractAttachments(parent: DocumentInput, day: DayContext): Promise<DocumentInput[]> {
    const extract = this.deps.extractAttachment;
    const config = this.deps.attachmentConfig;
    if (!config.enabled || !extract) return [];
    const infos: AttachmentInfo[] = [];
    const docs: DocumentInput[] = [];
    // Seqs depend only on which attachments the day holds, never on how far
    // their processing got, so an id changes only when an earlier twin is deleted.
    const seqByBase = new Map<string, number>();
    for (const m of day.messages) {
      const media = m.media;
      if (!media?.fileId || (media.kind !== "photo" && media.kind !== "document")) continue;
      const filename = media.fileName ?? (media.kind === "photo" ? "photo.jpg" : "document");
      const fallbackMime = media.kind === "photo" ? "image/jpeg" : "application/octet-stream";
      const mimeType = resolveEffectiveMimeType(filename, media.mimeType ?? fallbackMime);
      const size = media.size ?? null;
      const baseId = deriveAttachmentStableId(filename, size, mimeType);
      const seq = seqByBase.get(baseId) ?? 0;
      seqByBase.set(baseId, seq + 1);
      const info = (reason?: AttachmentInfo["reason"]): void => {
        infos.push({ filename, mimeType, size, extracted: !reason, ...(reason ? { reason } : {}) });
      };
      const emit = (extraction: ExtractionResult): void => {
        docs.push(
          buildAttachmentDocument(parent, filename, extraction, {
            mimeType,
            sizeBytes: size,
            seq,
            // The day spans hours; the file was sent with its message.
            occurredAt: new Date(m.ts * 1000).toISOString(),
          }),
        );
      };

      const check = shouldExtractAttachment(mimeType, size, config);
      if (!check.extract) {
        // Never downloaded, and not emitted: the settings exclude it. Terminal
        // until a resync looks at it again.
        info(check.reason);
        if (m.mediaState === "pending") this.record(m, { kind: "skipped", reason: check.reason! });
        continue;
      }
      // What the day shows when nothing new is extracted now: the extraction
      // already kept (a resync that cannot fetch the file again keeps it), or
      // why there is none.
      const fallback = (reason: AttachmentInfo["reason"]): void => {
        if (m.extraction) {
          emit(m.extraction);
          info();
        } else {
          info(reason);
        }
      };
      if (m.mediaState === "empty") {
        info("no-text");
        continue;
      }
      if (m.mediaState !== "pending" && m.mediaState !== "skipped") {
        fallback("unavailable");
        continue;
      }
      // Pending, or skipped under settings that now admit it.
      if (!this.due(m, day.budget, m.mediaState === "skipped")) {
        fallback("extraction-failed");
        continue;
      }
      const result = await this.download(m, config.maxSizeBytes, day);
      if (!result || !result.ok) {
        fallback(result?.reason === "terminal" ? "unavailable" : "download-failed");
        continue;
      }
      try {
        const extraction = await extract(result.data, mimeType, {
          maxTextLength: config.maxTextLength,
        });
        if (!extraction) {
          // No extractor could run (no OCR model yet): retried until one can.
          this.record(m, { kind: "process-failed", error: "extraction-failed" });
          fallback("extraction-failed");
          continue;
        }
        if (extraction.noText) {
          this.record(m, { kind: "empty" });
          info("no-text");
          continue;
        }
        const complete = extraction.extra?.ocrIncomplete !== true;
        this.record(m, { kind: "extracted", extraction: JSON.stringify(extraction), complete });
        emit(extraction);
        info(complete ? undefined : "extraction-failed");
      } catch (err) {
        if (day.signal?.aborted) {
          day.budget.halted = true;
        } else {
          log.warn(
            `Telegram attachment ${m.chatId}/${m.msgId} not extracted: ${toErrorMessage(err)}`,
          );
          this.record(m, { kind: "process-failed", error: toErrorMessage(err) });
        }
        fallback("extraction-failed");
      }
    }
    if (infos.length > 0) {
      parent.content += formatAttachmentMarkers(infos);
      parent.contentHash = computeContentHash(parent.content);
      parent.metadata.extra = { ...parent.metadata.extra, attachments: infos };
    }
    return docs;
  }

  /**
   * Whether `m` may be attempted now, taking one unit of the budget if so.
   * `force` attempts media whose state is not `pending` (a skipped
   * attachment the settings now admit).
   */
  private due(m: StoredMessage, budget: MediaBudget, force = false): boolean {
    if (budget.halted || budget.remaining <= 0) return false;
    if (m.mediaState !== "pending" && !force) return false;
    if (!m.media?.fileId) return false;
    const now = Math.floor(Date.now() / 1000);
    if (!force && (m.mediaNextAttempt ?? 0) > now) return false;
    if (this.deps.archive.mediaFloodUntil() !== undefined) return false;
    budget.remaining -= 1;
    budget.attempted.add(`${m.chatId}:${m.msgId}`);
    return true;
  }

  /**
   * Download `m`'s media, recording a failure in its lifecycle. `null` means
   * nothing was recorded: the sync was cancelled or the session is gone, and
   * no further download is started this page.
   */
  private async download(
    m: StoredMessage,
    maxBytes: number,
    day: DayContext,
  ): Promise<Download | null> {
    let downloaded: TgDownloaded;
    try {
      downloaded = await this.deps.adapter.downloadMedia(
        { chatId: m.chatId, msgId: m.msgId, fileId: m.media!.fileId!, ...sizeOf(m) },
        { maxBytes, ...(day.signal ? { signal: day.signal } : {}) },
      );
    } catch (err) {
      const failure = classifyDownloadFailure(err, day.signal);
      switch (failure.kind) {
        case "cancelled":
        case "halt":
          day.budget.halted = true;
          return null;
        case "flood":
          // Telegram's wait covers every download, not only this one.
          day.budget.halted = true;
          this.deps.archive.recordMediaFlood(failure.seconds);
          this.record(m, {
            kind: "transient",
            error: failure.error,
            retryAfterSec: failure.seconds,
          });
          log.info(`Telegram asked to wait ${failure.seconds}s before the next media download`);
          return { ok: false, reason: "retry" };
        case "terminal":
          this.record(m, { kind: "terminal", error: failure.error });
          return { ok: false, reason: "terminal" };
        case "transient":
          this.record(m, { kind: "transient", error: failure.error });
          return { ok: false, reason: "retry" };
      }
    }
    if (downloaded.refreshed) {
      const { isViewOnce: _viewOnce, ...media } = downloaded.refreshed;
      this.deps.archive.updateMediaDescriptor(m.chatId, m.msgId, media);
      m.media = media;
    }
    return { ok: true, data: downloaded.data };
  }

  private record(m: StoredMessage, outcome: MediaOutcome): void {
    this.deps.archive.recordMediaOutcome(m.chatId, m.msgId, outcome);
  }

  /** The day's people, for a transcriber that knows names. */
  private participants(day: DayContext): TranscriptionPerson[] {
    const ids = new Set<number>();
    if (day.chat.kind === "private") ids.add(day.chat.chatId);
    for (const m of day.messages) {
      if (m.senderId !== undefined && m.senderId > 0 && !m.outgoing && !m.service) {
        ids.add(m.senderId);
      }
    }
    ids.delete(this.deps.selfId);
    return [
      { isSelf: true },
      ...[...ids]
        .slice(0, MAX_TRANSCRIPTION_PARTICIPANTS - 1)
        .map((id) => ({ identifiers: telegramPersonIdentifiers(id, day.users) })),
    ];
  }
}

function sizeOf(m: StoredMessage): { size?: number } {
  return m.media?.size !== undefined ? { size: m.media.size } : {};
}

/**
 * Why a voice note shows no transcript, from what the archive holds before
 * this render attempts it.
 */
function placeholderState(m: StoredMessage): StoredMessage["transcription"] {
  if (m.transcript !== undefined) return m.transcript === "" ? "no-speech" : undefined;
  if (m.mediaState === "unavailable" || m.mediaState === undefined) return "audio-unavailable";
  return m.mediaLastError === TRANSCRIBER_UNAVAILABLE ? "transcriber-unavailable" : "awaiting";
}
