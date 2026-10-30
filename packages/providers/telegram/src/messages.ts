// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `TelegramMessagesSource`: one `sync()` page (`docs/telegram-source.md` §7.6).
 *
 * A page is: confirm the session; bring the archive in line with the chat
 * exclusions; spend the walk budget upstream (unless a flood wait is active);
 * drain a bounded set of dirty days from the archive; render each as a day
 * document, or tombstone it when nothing in it survives. The cursor is only
 * the drain's acknowledgement (`committedSeq` of the archive `storeId`), so
 * everything the gateway did not accept re-emits.
 *
 * Media is processed only on the days the page drains, a budgeted few
 * downloads per page (`media.ts`); the retry sweep re-arms the days of media
 * whose backoff ended, and a timer wakes a sync when the next one comes due.
 *
 * `hasMore` is true only while there is work this page could not finish and
 * the next one can: more dirty days, a walk that ran out of request budget,
 * or media due beyond this page's budget while the run has time for it. A
 * walk stopped by its deadline, a flood wait or the network waits for the
 * next scheduled sync, so a run always terminates.
 */

import {
  createLogger,
  resolveAttachmentConfig,
  toErrorMessage,
  transcriptionSyncIssues,
  type AttachmentExtractFn,
  type AttachmentExtractionConfig,
  type AudioTranscribeFn,
} from "@omnesis/core";
import {
  HistoryWalker,
  isChatIncluded,
  type ChatPolicy,
  type WalkLimits,
  type WalkerClock,
} from "./history-walker.js";
import {
  DRAIN_DAY_LIMIT,
  FLOOD_ISSUE_THRESHOLD_S,
  MEDIA_ATTEMPTS_PER_PAGE,
  MEDIA_CONTINUATION_MARGIN_MS,
} from "./limits.js";
import { MediaPass, mediaScopeOf, newMediaBudget, type MediaBudget } from "./media.js";
import { dayExternalId, normalizeDayChat } from "./normalizer.js";
import { telegramStateSpec } from "./state.js";
import type { DrainedDay, MediaScope, TelegramArchive } from "./message-store.js";
import type { HistoryCoverage, SyncOptions, SyncResult, Unsubscribe } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId, SyncIssue } from "@omnesis/types";
import type { TelegramProvider } from "./provider.js";
import type { StoredMessage, TelegramSyncCursor } from "./types.js";

const log = createLogger("source:telegram-messages");

export interface TelegramMessagesSourceOptions {
  sourceId: SourceId;
  providerId: ProviderId;
  policy: ChatPolicy;
  /** ISO 8601; nothing older is walked, stored or published. */
  dataCutoff?: string;
  /** For phone numbers written in national form in message text. */
  phoneRegion?: string;
  drainLimit?: number;
  clock?: WalkerClock;
  walkLimits?: Partial<WalkLimits>;
  /** Speech-to-text for voice notes; without it they stay placeholders. */
  transcribeAudio?: AudioTranscribeFn;
  /** Text and OCR for photos and documents; without it no attachment is emitted. */
  extractAttachment?: AttachmentExtractFn;
  attachmentConfig?: AttachmentExtractionConfig;
  /** Media downloads per page; tests raise it. */
  mediaAttemptsPerPage?: number;
  /**
   * Walk the bootstrap through a Telegram data export session
   * (`initTakeoutSession`) when Telegram grants one. The descriptor turns it
   * on; tests that are not about it leave it off.
   */
  takeout?: boolean;
}

/** Floor and ceiling of the media wake timer (a 32-bit `setTimeout` clamps past it). */
const MEDIA_WAKE_MIN_MS = 1000;
const MEDIA_WAKE_MAX_MS = 2_147_483_000;
/**
 * Media already due when a page ends is a backlog the next pages work through;
 * re-check on this cadence instead of waking a sync every second for it.
 */
const MEDIA_WAKE_OVERDUE_MS = 60_000;

/**
 * Telegram holds a new data export back until the owner approves it on
 * another device. The walk goes on without it, so this is information with a
 * remedy, not a failure.
 */
function takeoutApprovalIssue(unwalkedChats: number, retryAt: number | undefined): SyncIssue {
  const when = retryAt !== undefined ? new Date(retryAt * 1000).toISOString() : undefined;
  return {
    scope: "partition",
    kind: "permission",
    severity: "info",
    count: unwalkedChats,
    subject: "history export",
    message: `Telegram is waiting for you to approve the history export; history is read more slowly until then${when ? ` (Omnesis asks again at ${when})` : ""}.`,
    remediation: {
      summary: "Telegram asks you to approve the history export",
      steps: [
        "Open Telegram on your phone and allow the data export request in the notification from Telegram.",
        "Then resync the Telegram source so the export starts now; otherwise Omnesis asks again later on its own.",
      ],
      restartRequired: false,
    },
  };
}

export class TelegramMessagesSource {
  private readonly walker: HistoryWalker;
  private readonly cutoffTs: number | undefined;
  private readonly drainLimit: number;
  private readonly media: MediaPass;
  private readonly mediaScope: MediaScope;
  private readonly mediaAttempts: number;
  private mediaWake: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly provider: TelegramProvider,
    private readonly options: TelegramMessagesSourceOptions,
  ) {
    const cutoff = options.dataCutoff ? Date.parse(options.dataCutoff) : Number.NaN;
    this.cutoffTs = Number.isFinite(cutoff) ? Math.ceil(cutoff / 1000) : undefined;
    this.drainLimit = options.drainLimit ?? DRAIN_DAY_LIMIT;
    provider.setChatPolicy(options.policy, this.cutoffTs);
    this.mediaAttempts = options.mediaAttemptsPerPage ?? MEDIA_ATTEMPTS_PER_PAGE;
    const mediaDeps = {
      archive: provider.getArchive(),
      adapter: provider.getAdapter(),
      sourceId: options.sourceId,
      selfId: provider.selfId,
      attachmentConfig:
        options.attachmentConfig ?? resolveAttachmentConfig(undefined, { defaultEnabled: true }),
      ...(options.transcribeAudio ? { transcribeAudio: options.transcribeAudio } : {}),
      ...(options.extractAttachment ? { extractAttachment: options.extractAttachment } : {}),
    };
    this.media = new MediaPass(mediaDeps);
    this.mediaScope = mediaScopeOf(mediaDeps, this.cutoffTs);
    this.walker = new HistoryWalker({
      adapter: provider.getAdapter(),
      archive: provider.getArchive(),
      policy: options.policy,
      ...(this.cutoffTs !== undefined ? { cutoffTs: this.cutoffTs } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.walkLimits ? { limits: options.walkLimits } : {}),
      ...(options.takeout ? { takeout: provider.takeout } : {}),
    });
  }

  /** Wake the host whenever a live update changed the archive. */
  onPushEvent(callback: () => void): Unsubscribe {
    const off = this.provider.onArchiveChange(callback);
    // Media that came due while nobody listened can wake a sync now.
    this.scheduleMediaWake();
    return off;
  }

  /** Re-publish the whole archive, process its media again, and list the dialogs again. */
  onResync(): void {
    const archive = this.provider.getArchive();
    archive.resetMediaForResync();
    archive.markAllDirty();
    archive.requestFullReconcile();
    // An operator who approved a held-back export resyncs to use it now.
    archive.clearTakeoutDelay();
  }

  /** Stop the media wake timer. */
  dispose(): void {
    this.disposed = true;
    if (this.mediaWake) clearTimeout(this.mediaWake);
    this.mediaWake = undefined;
  }

  /**
   * Wake a sync when the earliest pending media's backoff ends, so a retry
   * runs on its own clock rather than at the next scheduled sync.
   */
  private scheduleMediaWake(): void {
    if (this.mediaWake) clearTimeout(this.mediaWake);
    this.mediaWake = undefined;
    if (this.disposed) return;
    const due = this.provider.getArchive().nextMediaDue(this.mediaScope);
    if (due === undefined) return;
    const untilDue = due * 1000 - Date.now();
    const delay =
      untilDue <= 0
        ? MEDIA_WAKE_OVERDUE_MS
        : Math.min(Math.max(untilDue, MEDIA_WAKE_MIN_MS), MEDIA_WAKE_MAX_MS);
    this.mediaWake = setTimeout(() => {
      this.mediaWake = undefined;
      this.provider.wake();
    }, delay);
    this.mediaWake.unref?.();
  }

  /** One day's document and its attachments; the ids its attachment ledger retired. */
  private async renderDay(
    chat: NonNullable<ReturnType<TelegramArchive["getChat"]>>,
    day: DrainedDay,
    messages: StoredMessage[],
    budget: MediaBudget,
    emitSeq: number,
    signal: AbortSignal | undefined,
  ): Promise<{ documents: DocumentInput[]; retired: string[] }> {
    const archive = this.provider.getArchive();
    const self = this.provider.selfUser();
    const userIds = messages.flatMap((m) => (m.senderId !== undefined ? [m.senderId] : []));
    if (chat.kind === "private") userIds.push(chat.chatId);
    const users = archive.getUsers(userIds);
    const inDay = new Map(messages.map((m) => [m.msgId, m]));
    const replyIds = messages.flatMap((m) =>
      m.replyToId !== undefined && !inDay.has(m.replyToId) ? [m.replyToId] : [],
    );
    const replies = new Map([...inDay, ...archive.getMessages(day.chatId, replyIds)]);
    const topics = chat.isForum ? archive.getTopics(day.chatId) : undefined;
    const context = { chat, messages, users, budget, ...(signal ? { signal } : {}) };
    await this.media.transcribeVoiceNotes(context);
    const doc = normalizeDayChat({
      chat,
      date: day.date,
      messages,
      users,
      replies,
      ...(topics ? { topics } : {}),
      self: {
        id: this.provider.selfId,
        ...(self?.phoneE164 ? { phoneE164: self.phoneE164 } : {}),
      },
      providerId: this.options.providerId,
      sourceId: this.options.sourceId,
      ...(this.options.phoneRegion ? { phoneRegion: this.options.phoneRegion } : {}),
      ...(day.changedAt !== undefined ? { changedAt: day.changedAt } : {}),
    });
    const attachments = await this.media.extractAttachments(doc, context);
    // Every attachment the day still holds is in this render; the ledger
    // retires the rest (a deleted message's file) for tombstoning.
    const retired = archive.settleAttachments(
      day.chatId,
      day.date,
      attachments.map((a) => a.externalId),
      emitSeq,
    );
    return { documents: [doc, ...attachments], retired };
  }

  async sync(
    cursor: TelegramSyncCursor | null,
    opts?: SyncOptions,
  ): Promise<SyncResult<TelegramSyncCursor>> {
    await this.provider.ensureUsable(opts?.signal, (opts?.run?.page ?? 0) > 0);
    const archive = this.provider.getArchive();
    const prior = cursor ? telegramStateSpec.decode(cursor) : null;
    const committedSeq = prior?.storeId === archive.storeId ? prior.committedSeq : 0;

    const { purged, restored } = archive.applyExclusions((chat) =>
      isChatIncluded(chat, this.options.policy),
    );
    if (purged > 0 || restored > 0) {
      log.info(`Telegram chat exclusions changed: ${purged} purged, ${restored} restored`);
    }

    let walk: Awaited<ReturnType<HistoryWalker["run"]>>;
    try {
      walk = await this.walker.run({
        ...(opts?.run?.deadline !== undefined ? { deadline: opts.run.deadline } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      // Only a revoked session escapes the walk: reported as the auth
      // failure, with its remedy, every other request path reports.
      throw this.provider.syncErrorFrom(err);
    }

    // The retry sweep: re-arm the days of media whose backoff ended, only as
    // many as this page can attempt.
    archive.markDueMediaDirty(this.mediaScope, this.mediaAttempts);

    const { days, emitSeq, morePending } = archive.drain({
      committedSeq,
      limit: this.drainLimit,
    });
    const documents: DocumentInput[] = [];
    const deletedExternalIds: string[] = [];
    const budget = newMediaBudget(this.mediaAttempts);
    let processed = 0;
    for (const day of days) {
      const id = dayExternalId(day.chatId, day.date);
      const chat = archive.getChat(day.chatId);
      const messages =
        this.cutoffTs === undefined
          ? day.messages
          : day.messages.filter((m) => m.ts >= this.cutoffTs!);
      // Nothing left to show: no chat, every message deleted, or (after the
      // cutoff moved later) only messages before it. Tombstoned in each case,
      // which is a no-op for a day never published.
      if (!chat || messages.length === 0) {
        deletedExternalIds.push(
          id,
          ...archive.settleAttachments(day.chatId, day.date, [], emitSeq),
        );
        continue;
      }
      // One day that cannot render must not hold back the rest of the page.
      try {
        const rendered = await this.renderDay(chat, day, messages, budget, emitSeq, opts?.signal);
        documents.push(...rendered.documents);
        deletedExternalIds.push(...rendered.retired);
        processed += messages.length;
      } catch (err) {
        const failures = archive.quarantineDay(day.chatId, day.date);
        if (failures === 1) {
          log.warn(
            `Telegram day ${id} failed to render; retrying it on a backoff: ${toErrorMessage(err)}`,
          );
        } else {
          log.debug(`Telegram day ${id} failed to render again (${failures} times)`);
        }
      }
    }

    const summary = archive.walkSummary();
    const unwalked = summary.pending + summary.walking;
    const floodUntil = archive.floodUntil();
    // Until the dialogs have been listed once, nothing is known to be walked.
    const listed = archive.hasEnumerated();
    const phase = unwalked > 0 || !listed ? "bootstrap" : "incremental";
    const coverage: HistoryCoverage =
      listed && unwalked === 0 && summary.failed === 0
        ? "complete"
        : floodUntil !== undefined || summary.failed > 0
          ? "partial"
          : "unknown";
    const deadline = opts?.run?.deadline;
    // A media backlog keeps the run going while this page spent its budget,
    // other media is due, and the run has time for it; otherwise the wake
    // timer or the next scheduled sync picks it up.
    const mediaContinues =
      budget.remaining === 0 &&
      !budget.halted &&
      (deadline === undefined || deadline - Date.now() > MEDIA_CONTINUATION_MARGIN_MS) &&
      archive.hasDueMedia(this.mediaScope, budget.attempted);
    const hasMore = morePending || walk.stop === "budget" || mediaContinues;

    const issues: SyncIssue[] = [];
    const floodSeconds = archive.floodSeconds();
    if (floodUntil !== undefined && floodSeconds > FLOOD_ISSUE_THRESHOLD_S) {
      issues.push({
        scope: "partition",
        kind: "rate-limit",
        severity: "info",
        count: Math.max(1, unwalked + (summary.reconcilePending ? 1 : 0)),
        message: `Telegram asked Omnesis to slow down; history resumes at ${new Date(floodUntil * 1000).toISOString()}.`,
      });
    }
    const takeout = archive.takeoutState();
    if (this.options.takeout && takeout.state === "delayed" && unwalked > 0) {
      issues.push(takeoutApprovalIssue(unwalked, takeout.retryAt));
    }
    // Days that failed to render stay queued; say so rather than drop them.
    const quarantined = archive.quarantinedDayCount();
    if (quarantined > 0) {
      issues.push({
        scope: "item",
        kind: "unknown",
        severity: "warning",
        count: quarantined,
        message: `${quarantined} Telegram chat ${quarantined === 1 ? "day" : "days"} could not be rendered; Omnesis keeps retrying.`,
      });
    }
    // The media backlog, stated once, on the page that ends the run (the host
    // sums issues across a run's pages).
    if (!hasMore && (this.mediaScope.voiceNotes || this.mediaScope.attachments)) {
      const media = archive.mediaHealthStats(this.mediaScope);
      const pending = media.voiceNotes.pending + media.attachments.pending;
      const unavailable = media.voiceNotes.unavailable + media.attachments.unavailable;
      if (pending > 0 || unavailable > 0) {
        log.info(
          `Telegram media: ${pending} awaiting download or retry, ${unavailable} unavailable`,
        );
      }
      if (this.mediaScope.voiceNotes) {
        issues.push(
          ...transcriptionSyncIssues({
            awaiting: media.voiceNotes.pending,
            transcriberUnavailable: media.voiceNotes.transcriberUnavailable,
            unavailable: media.voiceNotes.unavailable,
          }),
        );
      }
    }
    this.scheduleMediaWake();

    log.info(
      `Telegram sync page: ${documents.length} docs, ${deletedExternalIds.length} removed, walk ${walk.stop} after ${walk.requests} requests (${phase}, coverage ${coverage}, hasMore ${hasMore})`,
    );

    return {
      documents,
      deletedExternalIds,
      ...(issues.length > 0 ? { issues } : {}),
      cursor: { phase, committedSeq: emitSeq, storeId: archive.storeId },
      hasMore,
      progress: { phase, processed, coverage, coverageSubject: "history" },
    };
  }
}
