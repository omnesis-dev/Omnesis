// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createLogger,
  resolveAttachmentConfig,
  shouldExtractAttachment,
  resolveEffectiveMimeType,
  buildAttachmentDocument,
  formatAttachmentMarkers,
  deriveAttachmentStableId,
} from "@omnesis/core";
import { makeCursorValidator } from "@omnesis/source-sdk";
import { SourceId, ProviderId, isTransientSyncError } from "@omnesis/types";
import { normalizeDayChat, buildContactsByLidJid } from "./normalizer.js";
import type {
  AttachmentInfo,
  AttachmentExtractionConfig,
  AttachmentExtractFn,
  AudioTranscribeFn,
} from "@omnesis/core";
import type { HistoryCoverage, SyncCursor, SyncResult, Unsubscribe } from "@omnesis/source-sdk";
import type {
  DocumentInput,
  SourceId as SourceIdType,
  ProviderId as ProviderIdType,
} from "@omnesis/types";
import type { MessageStore } from "./message-store.js";
import type { WhatsAppSyncCursor, StoredMessage, MediaOutcome } from "./types.js";

const log = createLogger("source:whatsapp");

/**
 * Outcome of a media download from the WhatsApp CDN. A companion device often
 * 404/410s on a blob it never fetched while fresh; recovery via media re-upload
 * can fail in two distinct ways the caller must treat differently:
 *
 * - `transient` — retry later (CDN momentarily evicted, phone offline so no
 *   device re-uploaded yet, socket reconnecting, download timed out).
 * - `terminal`  — give up (the phone reports the media is gone / undecryptable;
 *   no amount of retrying will recover it).
 */
export type MediaDownloadResult =
  | { kind: "ok"; data: Uint8Array }
  | { kind: "transient"; error: string }
  | { kind: "terminal"; error: string };

/** Function to download media from the WhatsApp CDN (with re-upload retry). */
export type MediaDownloadFn = (msg: StoredMessage) => Promise<MediaDownloadResult>;

function isWhatsAppSyncCursor(v: unknown): v is WhatsAppSyncCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return c.phase === "bootstrap" || c.phase === "incremental";
}

const validateWhatsAppSyncCursor = makeCursorValidator(isWhatsAppSyncCursor);

/**
 * Bound optional durable-media enrichment per page so primary messages stay
 * fresh even when the retry backlog contains slow OCR or voice-note work.
 */
const DEFAULT_MEDIA_ATTEMPTS_PER_PAGE = 1;

interface MediaAttemptBudget {
  remaining: number;
  deferred: { chatJid: string; id: string }[];
}

export interface WhatsAppMessagesSourceOptions {
  /** ISO 8601 date string. Documents with sourceCreatedAt older than this are filtered out. */
  dataCutoff?: string;
  attachmentConfig?: AttachmentExtractionConfig;
  extractAttachment?: AttachmentExtractFn;
  downloadMedia?: MediaDownloadFn;
  /**
   * Speech-to-text function (forwards bytes to the gateway). When set, voice
   * notes are downloaded and transcribed inline. Wired only when the `stt`
   * experimental feature is enabled on the collector.
   */
  transcribeAudio?: AudioTranscribeFn;
  /** Override the per-page durable-media attempt cap (primarily for tests). */
  mediaAttemptsPerPage?: number;
  /** Register for connection error events from the provider */
  onConnectionError?: (handler: (error: string) => void) => void;
  /** Stop reporting to `handler`, so a torn-down source goes quiet. */
  offConnectionError?: (handler: (error: string) => void) => void;
}

/**
 * WhatsApp Messages source.
 * Drains buffered messages from the MessageStore and produces
 * per-day-per-chat DocumentInputs.
 */
export class WhatsAppMessagesSource {
  readonly id: SourceIdType;
  readonly providerId: ProviderIdType;

  /** Optional ISO 8601 cutoff — documents older than this are skipped */
  private dataCutoff: string | undefined;

  private attachmentConfig: AttachmentExtractionConfig;
  private extractAttachment?: AttachmentExtractFn;
  private downloadMedia?: MediaDownloadFn;
  private transcribeAudio?: AudioTranscribeFn;
  private mediaAttemptsPerPage: number;
  private registerConnectionError?: (handler: (error: string) => void) => void;
  private unregisterConnectionError?: (handler: (error: string) => void) => void;

  constructor(
    private store: MessageStore,
    accountId?: string,
    options?: WhatsAppMessagesSourceOptions,
  ) {
    this.id = SourceId(accountId ? `whatsapp-messages:${accountId}` : "whatsapp-messages");
    this.providerId = ProviderId(accountId ? `whatsapp:${accountId}` : "whatsapp");
    // Normalize to full ISO 8601 with milliseconds for consistent string comparison
    this.dataCutoff = options?.dataCutoff ? new Date(options.dataCutoff).toISOString() : undefined;
    this.attachmentConfig = options?.attachmentConfig ?? resolveAttachmentConfig();
    this.extractAttachment = options?.extractAttachment;
    this.downloadMedia = options?.downloadMedia;
    this.transcribeAudio = options?.transcribeAudio;
    this.mediaAttemptsPerPage = options?.mediaAttemptsPerPage ?? DEFAULT_MEDIA_ATTEMPTS_PER_PAGE;
    if (!Number.isSafeInteger(this.mediaAttemptsPerPage) || this.mediaAttemptsPerPage <= 0) {
      throw new Error("mediaAttemptsPerPage must be a positive safe integer");
    }
    this.registerConnectionError = options?.onConnectionError;
    this.store.setMediaRetryScope({
      voiceNotes: !!this.downloadMedia && !!this.transcribeAudio,
      attachments:
        !!this.downloadMedia && this.attachmentConfig.enabled && !!this.extractAttachment,
      minTimestamp: this.dataCutoff ? Math.ceil(Date.parse(this.dataCutoff) / 1000) : null,
    });
    this.unregisterConnectionError = options?.offConnectionError;
    if (this.dataCutoff) {
      log.info(`Data age cutoff: ${this.dataCutoff}`);
    }
  }

  /**
   * Register a callback for push-based sync.
   * Fires when new messages arrive in the store.
   */
  onPushEvent(handler: () => void): Unsubscribe {
    this.store.onChange(handler);
    return () => this.store.offChange(handler);
  }

  /**
   * Register a callback for connection errors.
   * Fires when the WhatsApp device is unlinked or connection is permanently lost.
   */
  onSourceError(handler: (error: string) => void): Unsubscribe {
    this.registerConnectionError?.(handler);
    return () => this.unregisterConnectionError?.(handler);
  }

  /**
   * Called before a resync — re-mark all buffered messages as dirty so they get
   * drained again, and re-enroll every media message into the retry lifecycle
   * so the resync reprocesses voice notes (e.g. with a newly-switched Whisper
   * model) and re-extracts attachments. Reprocessing is in-place: a failed
   * re-download keeps the existing transcript rather than losing it.
   */
  onResync(): void {
    this.store.resetMediaForResync();
    this.store.markAllDirty();
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    const state: WhatsAppSyncCursor = validateWhatsAppSyncCursor(cursor) ?? {
      phase: "bootstrap",
      lastTimestamp: 0,
      committedSeq: 0,
    };

    // Media retry sweep (before draining): re-dirty eligible media days whose
    // backoff window has elapsed, so they re-render and the download is retried.
    // This decouples retries from chat activity — a voice note that failed to
    // download on a now-past day still gets retried on schedule, rather than
    // only if someone happens to message that day again.
    if (this.downloadMedia) {
      const rearmed = this.store.markDueMediaDirty();
      if (rearmed > 0) log.debug(`Re-armed ${rearmed} day(s) with media due for retry`);
    }

    // Drain one bounded page. `committedSeq` proves which days the gateway
    // accepted on the prior page (the engine persists the cursor atomically
    // with the docs), so the store clears those dirty rows; a failed POST
    // leaves the cursor un-advanced and the days re-emit. The store never
    // GCs messages — re-emission is always recoverable.
    const { dirtyKeys, messagesByKey, chats, contacts, lidPhoneMap, emitSeq, morePending } =
      this.store.drain({
        committedSeq: state.storeId === this.store.storeId ? (state.committedSeq ?? 0) : 0,
      });

    log.debug("Draining message store", {
      dirtyKeys: dirtyKeys.size,
      historySyncState: this.store.historySyncState,
      phase: state.phase,
    });

    // If a cutoff is configured, compute the cutoff timestamp (seconds)
    // so we can skip old messages before normalization.
    const cutoffTimestamp = this.dataCutoff
      ? Math.ceil(new Date(this.dataCutoff).getTime() / 1000)
      : null;

    const documents: DocumentInput[] = [];
    let maxTimestamp = state.lastTimestamp;
    let skippedKeys = 0;
    let messagesProcessed = 0;

    // Build the LID→contact index once for this whole page — it depends only on
    // `contacts` (invariant across the page), so rebuilding it per day-chat is
    // wasted O(totalContacts) work, especially on resync / backfill re-renders.
    const contactsByLidJid = buildContactsByLidJid(contacts);
    // Only durable `pending` rows consume this page-wide budget. Legacy media
    // has no independent retry wakeup, so it retains its uncapped opportunistic
    // behavior until a resync enrolls it in the lifecycle.
    const mediaBudget: MediaAttemptBudget = {
      remaining: this.mediaAttemptsPerPage,
      deferred: [],
    };

    for (const [key, messages] of messagesByKey) {
      if (messages.length === 0) continue;

      // Pre-filter: skip messages older than the cutoff before normalization
      const filtered = cutoffTimestamp
        ? messages.filter((m) => m.timestamp >= cutoffTimestamp)
        : messages;

      if (filtered.length === 0) {
        skippedKeys++;
        continue;
      }

      messagesProcessed += filtered.length;

      const chatJid = key.slice(0, -11); // remove ":YYYY-MM-DD"
      const date = key.slice(-10);

      // Transcribe voice notes before rendering, so the transcript lands inline
      // in the day-chat document (and thus in the indexed/searchable content).
      await this.transcribeVoiceNotes(filtered, mediaBudget);

      const chat = chats.get(chatJid);
      const doc = normalizeDayChat(
        chatJid,
        date,
        filtered,
        chat,
        contacts,
        this.providerId,
        this.id,
        lidPhoneMap,
        contactsByLidJid,
      );

      // Post-filter safety: skip documents whose sourceCreatedAt is before the cutoff
      if (this.dataCutoff && doc.sourceCreatedAt < this.dataCutoff) {
        skippedKeys++;
        continue;
      }

      // Extract text from document and image attachments if enabled
      const attachmentDocs = await this.extractMediaAttachments(doc, filtered, mediaBudget);

      documents.push(doc);
      documents.push(...attachmentDocs);

      // Track latest timestamp
      const lastMsg = filtered[filtered.length - 1];
      if (lastMsg.timestamp > maxTimestamp) {
        maxTimestamp = lastMsg.timestamp;
      }
    }

    if (skippedKeys > 0) {
      log.debug("Skipped day-chat keys older than cutoff", {
        skipped: skippedKeys,
        cutoff: this.dataCutoff,
      });
    }

    if (mediaBudget.deferred.length > 0) {
      this.store.deferMediaAttempts(mediaBudget.deferred);
      log.debug(
        `Deferred ${mediaBudget.deferred.length} durable media item(s) after ${this.mediaAttemptsPerPage} attempt(s)`,
      );
    }

    // No GC: the durable store keeps every message. Dirty rows for this page
    // were stamped with `emitSeq` and are cleared only once a later sync()
    // observes the gateway-confirmed `committedSeq` (see store.drain()).

    // A dirty day that rendered to zero surviving messages (every message in it
    // was deleted) produces no document — tombstone its day-doc so a previously
    // emitted version is removed rather than left orphaned in the gateway.
    // Cutoff-skipped days still have rows in messagesByKey, so they are excluded.
    const deletedExternalIds = [...dirtyKeys].filter((k) => !messagesByKey.has(k));

    // `streaming` keeps the sync alive so the engine re-polls as history
    // batches land; `complete`/`interrupted` only continue while pages remain.
    // An interrupted bootstrap drains what it has and exits — recovery is
    // re-pair / a one-time backup import, not an endless sync loop.
    const historyState = this.store.historySyncState;
    const historyComplete = historyState === "complete";
    const hasMore = morePending || historyState === "streaming";

    const phase = historyComplete ? "incremental" : "bootstrap";
    // Coverage reports whether the synced corpus is whole. WhatsApp only serves
    // a companion the recent (~90-day) window; "complete" means that window is
    // fully synced, "partial" means the bootstrap stalled, and
    // "unknown" is a bootstrap still in flight — the phone may yet finish the
    // window or stall partway through, and until the quiet-gap resolves the
    // sync neither claim is honest. The full archive beyond the window is
    // recovered via the backup import, which this signal does not track.
    const coverage: HistoryCoverage = historyComplete
      ? "complete"
      : historyState === "interrupted"
        ? "partial"
        : "unknown";
    const detail =
      historyState === "interrupted"
        ? "history sync interrupted — re-pair to refresh, or import full history from a phone backup"
        : undefined;

    log.info(
      `Sync produced ${documents.length} docs (${phase}, coverage: ${coverage}, processed: ${messagesProcessed}, hasMore: ${hasMore})`,
    );

    // Surface media that isn't downloading so a silent blank doesn't hide it.
    if (this.downloadMedia) {
      const { pending, unavailable } = this.store.mediaHealthStats();
      if (pending > 0 || unavailable > 0) {
        log.info(
          `Media health: ${pending} awaiting download/retry, ${unavailable} unavailable (gone from CDN/phone)`,
        );
      }
    }

    return {
      documents,
      deletedExternalIds,
      cursor: {
        phase,
        lastTimestamp: maxTimestamp,
        committedSeq: emitSeq,
        storeId: this.store.storeId,
      } satisfies WhatsAppSyncCursor,
      hasMore,
      // Every page states the coverage, including the page that has nothing to
      // report. The seal that settles history fires on a quiet timer — no
      // batches for two minutes, or a settle window for an account that
      // received none at all — so by construction the page that first knows
      // the history is complete is a page that drained nothing. Gating the
      // claim on having processed something withholds exactly the all-clear,
      // and leaves a sealed account describing itself as unable to tell.
      progress: {
        phase,
        processed: messagesProcessed,
        coverage,
        // One subject, whose claims are a time series over it: "still
        // arriving" on every page until the page that says "finished". Naming
        // it is what tells the host these are one claim revised rather than
        // several held, so the seal is believed instead of being outranked by
        // the pages that preceded it.
        coverageSubject: "history",
        ...(detail ? { detail } : {}),
      },
    };
  }

  /**
   * Extract text from document and image attachments in a day-chat, via the
   * shared attachment extractor: documents are parsed (PDF/DOCX/…) and images
   * are OCR'd into a child attachment doc. Mutates the parent doc to add
   * attachment markers and metadata.
   *
   * Audio is handled separately by `transcribeVoiceNotes` (rendered inline as
   * the message transcript, not as a child doc); video has no extractor — so
   * both are excluded here. Whether an `image/*` is admitted, and whether OCR
   * actually runs, is governed by the resolved attachment config and the
   * gateway's OCR backend availability — the same path Gmail/Outlook/Drive use.
   */
  private async extractMediaAttachments(
    parentDoc: DocumentInput,
    messages: StoredMessage[],
    mediaBudget: MediaAttemptBudget,
  ): Promise<DocumentInput[]> {
    if (!this.attachmentConfig.enabled || !this.extractAttachment || !this.downloadMedia) {
      return [];
    }

    const attachmentInfos: AttachmentInfo[] = [];
    const attachmentDocs: DocumentInput[] = [];
    const now = Math.floor(Date.now() / 1000);
    // Track seq per (filename, size, mimeType) within this day-doc
    const seqByBase = new Map<string, number>();

    const mediaMessages = messages.filter(
      (m) => (m.type === "document" || m.type === "image") && m.media?.mimetype,
    );

    for (const msg of mediaMessages) {
      const fileLength = msg.media!.fileLength ?? 0;
      // Images rarely carry a filename; default to "photo" to match the inline
      // placeholder the normalizer renders (`[Image: photo]`).
      const filename = msg.media!.filename ?? (msg.type === "image" ? "photo" : "document");
      // Recover the real type when the media carries a generic MIME for a
      // recognizable extension (e.g. a .pkpass sent as octet-stream).
      const mimeType = resolveEffectiveMimeType(filename, msg.media!.mimetype!);
      const info = (reason?: AttachmentInfo["reason"]): void => {
        attachmentInfos.push({ filename, mimeType, size: fileLength, extracted: !reason, reason });
      };

      // Terminal: the media is gone / never extractable. Render the placeholder
      // without re-downloading on every re-render of the day.
      if (msg.mediaState === "unavailable") {
        info("unavailable");
        continue;
      }
      if (msg.mediaState === "empty") {
        info("no-text");
        continue;
      }

      const check = shouldExtractAttachment(mimeType, fileLength, this.attachmentConfig);
      if (!check.extract) {
        // We will never extract this type/size → terminal so the retry sweep
        // stops re-arming it; the specific reason is still surfaced.
        info(check.reason);
        this.advanceMediaLifecycle(msg, {
          kind: "terminal",
          error: check.reason ?? "not-extractable",
        });
        continue;
      }

      // No decryption descriptors → unfetchable; terminal.
      if (!msg.media!.mediaKey || (!msg.media!.url && !msg.media!.directPath)) {
        info("download-failed");
        this.advanceMediaLifecycle(msg, { kind: "terminal", error: "no-decryption-keys" });
        continue;
      }

      if (!this.shouldAttemptAttachment(msg, now)) {
        info(msg.mediaState === "pending" ? "extraction-failed" : undefined);
        continue;
      }

      if (!this.acquireMediaAttempt(msg, mediaBudget)) {
        info("extraction-failed");
        continue;
      }

      try {
        const dl = await this.downloadMedia(msg);
        if (dl.kind !== "ok") {
          // Terminal CDN/phone failure renders an explicit `unavailable`; a
          // transient one keeps the retriable `download-failed` and backs off.
          info(dl.kind === "terminal" ? "unavailable" : "download-failed");
          this.advanceMediaLifecycle(msg, { kind: dl.kind, error: dl.error });
          continue;
        }

        const result = await this.extractAttachment(dl.data, mimeType, {
          maxTextLength: this.attachmentConfig.maxTextLength,
        });
        if (!result) {
          // Downloaded but the extractor produced nothing (e.g. no OCR model
          // assigned yet, or the backend was down) — processing gap, not a lost
          // blob: retry indefinitely until the capability is present.
          info("extraction-failed");
          this.advanceMediaLifecycle(msg, { kind: "process-failed", error: "extraction-failed" });
          continue;
        }
        if (result.noText) {
          info("no-text");
          this.advanceMediaLifecycle(msg, { kind: "empty" });
          continue;
        }

        const baseId = deriveAttachmentStableId(filename, fileLength, mimeType);
        const seq = seqByBase.get(baseId) ?? 0;
        seqByBase.set(baseId, seq + 1);
        const attDoc = buildAttachmentDocument(parentDoc, filename, result, {
          mimeType,
          sizeBytes: fileLength,
          seq,
          // The parent is a whole day of chat, so its timestamps bound the day
          // rather than dating this file. Stamp the message that carried it,
          // or every attachment sent that day sorts as if it arrived with the
          // first message — and evidence shared in the evening reads as older
          // than a document from that afternoon.
          occurredAt: new Date(msg.timestamp * 1000).toISOString(),
        });
        attachmentDocs.push(attDoc);
        if (result.extra?.ocrIncomplete === true) {
          // Keep the useful native PDF text, but leave the media enrolled for
          // retry so its scanned pages can be filled in after OCR recovers.
          info("extraction-failed");
          this.advanceMediaLifecycle(msg, {
            kind: "process-failed",
            error: "ocr-incomplete",
          });
        } else {
          info();
          this.advanceMediaLifecycle(msg, { kind: "extracted" });
        }
      } catch (err) {
        // Durable media retries independently of the page cursor, so a
        // transient processor outage must not hold primary messages hostage.
        // Legacy rows lack that lifecycle and retain the old page retry.
        if (isTransientSyncError(err)) {
          if (msg.mediaState === undefined) throw err;
          info("extraction-failed");
          this.advanceMediaLifecycle(msg, {
            kind: "process-failed",
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        log.warn(
          `Failed to extract WhatsApp attachment ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        );
        info("extraction-failed");
        this.advanceMediaLifecycle(msg, {
          kind: "process-failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (attachmentInfos.length > 0) {
      parentDoc.content += formatAttachmentMarkers(attachmentInfos);
      parentDoc.metadata.extra = { ...parentDoc.metadata.extra, attachments: attachmentInfos };
    }

    return attachmentDocs;
  }

  /**
   * Transcribe the voice notes in a day-chat, mutating each message's
   * `transcript` in place (so the normalizer can render it inline) and
   * persisting the outcome via the media lifecycle (so re-emits don't
   * re-transcribe and failures retry on a backoff — see {@link MediaState}).
   *
   * - `pending` notes are transcribed once their backoff window has elapsed.
   * - `done`/`empty`/`unavailable` notes are skipped (the cached transcript, or
   *   the `unavailable` placeholder, renders without re-downloading).
   * - Legacy notes (no `mediaState`) keep the prior opportunistic behavior:
   *   transcribed when their day is drained if never transcribed, and not
   *   enrolled into active retry by a single drained failure.
   * - A failed re-download keeps any existing transcript rather than losing it.
   */
  private async transcribeVoiceNotes(
    messages: StoredMessage[],
    mediaBudget: MediaAttemptBudget,
  ): Promise<void> {
    if (!this.transcribeAudio || !this.downloadMedia) return;
    const now = Math.floor(Date.now() / 1000);

    for (const msg of messages) {
      if (msg.type !== "audio" || !msg.media?.isVoiceNote) continue;
      if (!this.shouldAttemptVoiceNote(msg, now)) continue;
      // Can't fetch without decryption descriptors (e.g. an imported message
      // that only carries metadata) — terminal for enrolled notes.
      if (!msg.media.mediaKey || (!msg.media.url && !msg.media.directPath)) {
        this.advanceMediaLifecycle(msg, { kind: "terminal", error: "no-decryption-keys" });
        continue;
      }

      if (!this.acquireMediaAttempt(msg, mediaBudget)) continue;

      try {
        const dl = await this.downloadMedia(msg);
        if (dl.kind !== "ok") {
          // Keep any existing transcript; back off (transient) or give up
          // (terminal) per the CDN/phone signal.
          this.advanceMediaLifecycle(msg, { kind: dl.kind, error: dl.error });
          continue;
        }
        const result = await this.transcribeAudio(dl.data, msg.media.mimetype ?? "audio/ogg");
        // `null` = no transcriber assigned yet, or the gateway model was down.
        // The audio downloaded fine, so this is a processing gap, not a lost
        // blob — retry indefinitely (it'll transcribe once a model is present),
        // never give up; don't clobber an existing transcript.
        if (result === null) {
          this.advanceMediaLifecycle(msg, {
            kind: "process-failed",
            error: "transcriber-unavailable",
          });
          continue;
        }
        const text = result.text.trim();
        msg.transcript = text;
        msg.mediaState = text === "" ? "empty" : "done";
        this.advanceMediaLifecycle(msg, { kind: "transcribed", text });
      } catch (err) {
        // Durable media retries independently of the page cursor, so a
        // transient processor outage must not hold primary messages hostage.
        // Legacy rows lack that lifecycle and retain the old page retry.
        if (isTransientSyncError(err)) {
          if (msg.mediaState === undefined) throw err;
          this.advanceMediaLifecycle(msg, {
            kind: "process-failed",
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        log.warn(
          `Failed to transcribe voice note ${msg.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.advanceMediaLifecycle(msg, {
          kind: "process-failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Whether to attempt a voice note this drain. `pending` notes are gated by the
   * backoff clock so an unrelated re-render of the day doesn't bypass it; legacy
   * notes (no `mediaState`) are attempted only if never transcribed.
   */
  private shouldAttemptVoiceNote(msg: StoredMessage, now: number): boolean {
    switch (msg.mediaState) {
      case "done":
      case "empty":
      case "unavailable":
        return false;
      case "pending":
        return (msg.mediaNextAttempt ?? 0) <= now;
      default: // legacy row, no lifecycle yet
        return msg.transcript === undefined;
    }
  }

  /** Honor attachment retry backoff while still allowing legacy one-shot work. */
  private shouldAttemptAttachment(msg: StoredMessage, now: number): boolean {
    switch (msg.mediaState) {
      case "done":
      case "empty":
      case "unavailable":
        return false;
      case "pending":
        return (msg.mediaNextAttempt ?? 0) <= now;
      default:
        return true;
    }
  }

  /**
   * Admit one expensive download+processing pipeline. Deferral postpones only
   * the due time; lifecycle state, attempt count, and error remain untouched.
   * The store's retry timer re-dirties the day on a later source run.
   */
  private acquireMediaAttempt(msg: StoredMessage, budget: MediaAttemptBudget): boolean {
    if (msg.mediaState !== "pending") return true;
    if (budget.remaining > 0) {
      budget.remaining -= 1;
      return true;
    }
    budget.deferred.push({ chatJid: msg.chatJid, id: msg.id });
    return false;
  }

  /**
   * Persist a media attempt's outcome. Successes always persist (they cache the
   * result); failures advance the lifecycle only for media already enrolled in
   * it (`mediaState` set), so legacy rows keep their pre-existing behavior and a
   * single drained failure doesn't enroll the whole archive after an upgrade.
   */
  private advanceMediaLifecycle(msg: StoredMessage, outcome: MediaOutcome): void {
    const isFailure =
      outcome.kind === "transient" ||
      outcome.kind === "process-failed" ||
      outcome.kind === "terminal";
    if (isFailure && msg.mediaState === undefined) return;
    this.store.recordMediaOutcome(msg.chatJid, msg.id, outcome);
  }
}
