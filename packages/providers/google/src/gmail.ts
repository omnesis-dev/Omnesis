// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { google, type gmail_v1 } from "googleapis";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
import {
  createLogger,
  computeContentHash,
  parseEmailHeader,
  extractSchemaOrgDatesFromHtml,
  isAutomatedSenderAddress,
  isAutoSubmittedGenerated,
  mailHeaderRelevancePenalty,
  splitEmailList,
  extractEmailsFromText,
  extractPhonesFromText,
  cleanPersonName,
  htmlToMarkdown,
  pMap,
  resolveAttachmentConfig,
  shouldExtractAttachment,
  resolveEffectiveMimeType,
  buildAttachmentDocument,
  formatAttachmentMarkers,
  deriveAttachmentStableId,
} from "@omnesis/core";
import { makeCursorValidator, applyDataCutoff } from "@omnesis/source-sdk";
import { SourceId, ProviderId, isTransientSyncError } from "@omnesis/types";
import {
  GOOGLE_PAGE_SIZE,
  GMAIL_LABEL_CACHE_TTL_MS,
  GOOGLE_FETCH_CONCURRENCY,
  GMAIL_HISTORY_RECOVERY_OVERLAP_MS,
  GMAIL_HISTORY_RECOVERY_FALLBACK_MS,
} from "./constants.js";
import { mapGoogleApiError } from "./api-error.js";
import type {
  AttachmentInfo,
  AttachmentExtractionConfig,
  AttachmentExtractFn,
} from "@omnesis/core";
import type { SyncCursor, SyncResult, HistoryCoverage } from "@omnesis/source-sdk";
import type { DocumentInput, PersonMention } from "@omnesis/types";

const log = createLogger("source:gmail");

export interface GmailSyncCursor extends SyncCursor {
  historyId?: string;
  pageToken?: string;
  totalMessages?: number;
  phase: "bootstrap" | "incremental";
  /** historyId captured at bootstrap start. Used as the incremental starting point
   *  when bootstrap transitions early (processed >= total) so we never get stuck
   *  re-walking pagination forever. */
  bootstrapHistoryId?: string;
  /** Cumulative docs ingested across bootstrap pages. Compared with totalMessages
   *  to detect "we have enough, transition to incremental even if pagination keeps
   *  serving more". Reset to undefined post-transition. */
  processedDocs?: number;
  /** nextPageToken from a multi-page history.list response. Persists between
   *  syncs so we can resume pagination without losing pages 2+. Cleared once
   *  the final page lands and historyId advances. */
  historyPageToken?: string;
  /** Set only on a *recovery* bootstrap — the one we fall back to when an
   *  incremental historyId 404s. Narrows `messages.list` to `after:<date>` so
   *  we backfill just the missed window instead of re-walking the whole
   *  mailbox. Carried across bootstrap pages, cleared on the transition to
   *  incremental. See #111. */
  recoverAfter?: string;
  /** ISO timestamp of the last sync that left us in the incremental phase.
   *  The watermark a 404 recovery backfills from (minus a safety overlap).
   *  Absent on cursors written before this field existed → recovery uses a
   *  bounded fallback look-back instead. */
  lastSyncAt?: string;
  /**
   * What the completed walk reached, settled when bootstrap ends.
   *
   * Coverage describes the corpus, and only the walk that built it knows how
   * far back it got. Incremental pages have no way to re-derive that — they
   * see one history delta — so the answer is carried here and restated rather
   * than recomputed. Absent on cursors written before this field existed,
   * which reads as a source that has not said.
   */
  coverage?: HistoryCoverage;
  /**
   * Set on a recovery bootstrap whose floor was anchored on a watermark, so
   * the walk it starts knows the gap it is backfilling was already covered
   * below that point and the result still reaches everything.
   */
  recoveryVouched?: boolean;
}

/**
 * How far back a walk bounded by `afterFloor` can claim to reach.
 *
 * An unbounded walk of the mailbox reaches everything Gmail still holds, and
 * is the one case that can vouch. A walk stopped by the operator's own cutoff
 * is missing history by request, and knows exactly what. A walk stopped by a
 * recovery floor is the honest "cannot tell": the gap it skipped may have held
 * mail that no longer exists to re-list.
 */
function reachOf(dataCutoff?: Date, recoverAfter?: Date, recoveryVouched = false): HistoryCoverage {
  // A recovery anchored on a watermark is not a gap. Everything before the
  // watermark was indexed by an earlier successful sync, so the backfilled
  // window closes the whole hole and the walk still reaches everything —
  // which is why the page that starts such a recovery makes no claim. Without
  // this the next page claims "unknown" anyway and settles it into the cursor,
  // so one expired history id would permanently downgrade a mailbox that had
  // legitimately settled complete.
  if (recoverAfter && !recoveryVouched) return "unknown";
  if (dataCutoff) return "partial";
  return "complete";
}

/** The wording for a claim, phrased about the corpus rather than the moment. */
function reachDetail(coverage: HistoryCoverage): string | undefined {
  if (coverage === "unknown") {
    return "Gmail's change history expired before this account could be resynced, so mail from the gap that has since been deleted cannot be re-listed.";
  }
  if (coverage === "partial") {
    return "Only mail after the configured cutoff was fetched.";
  }
  return undefined;
}

/** Later (more recent) of two optional dates, or whichever one is defined. */
function laterDate(a?: Date, b?: Date): Date | undefined {
  if (a && b) return a.getTime() >= b.getTime() ? a : b;
  return a ?? b;
}

/** Format a Date as Gmail's `after:` operand — UTC `YYYY/MM/DD`. */
function gmailAfterDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}

export function isGmailSyncCursor(v: unknown): v is GmailSyncCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return c.phase === "bootstrap" || c.phase === "incremental";
}

const validateGmailSyncCursor = makeCursorValidator(isGmailSyncCursor);

/** Info about an attachment part found in a MIME tree.
 *
 * `size` is `null` when the Gmail API response did not populate `body.size`
 * for this part. Callers must NOT default this to 0 — that would silently
 * bypass the max-size guard. See `shouldExtractAttachment`. */
interface AttachmentPartInfo {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number | null;
}

export interface GmailSourceOptions {
  attachmentConfig?: AttachmentExtractionConfig;
  extractAttachment?: AttachmentExtractFn;
}

// Build the user-facing "open in Gmail" URL for a message.
// `#all/<id>` opens the message regardless of which folder/label it lives
// under (inbox, archive, sent, …). `/u/0/` is the account-index slot
// Gmail's own URLs use; `/u/<email>/` is NOT a recognized form (Gmail
// returns "Temporary Error (404)").
//
// `?authuser=<email>` pins the message to the account that received it (#463),
// so multi-account users land in the right inbox instead of whichever account
// happens to sit at index 0 in the browser. The query goes before the `#`
// fragment. Omitted (single-account / legacy `accountId`-less sources) → the
// previous `/u/0/` behaviour, unchanged. The URL canonicalizer tolerates the
// query string, so the dedup key is unaffected.
export function gmailMessageUrl(messageId: string, accountEmail?: string): string {
  const authuser = accountEmail ? `?authuser=${encodeURIComponent(accountEmail)}` : "";
  return `https://mail.google.com/mail/u/0/${authuser}#all/${messageId}`;
}

// Gmail has no working "open this message" deep link on iOS, so we emit no
// `appUrl` — the iOS app falls back to the web `sourceUrl`. The only
// `googlegmail://` action is `/co` (compose), and mobile Gmail web drops the
// `#all/<id>` fragment that the desktop web app uses to route to a message.
// Don't reintroduce a `googlegmail://` appUrl without device-testing that it
// actually opens the specific message rather than the inbox or composer.

/**
 * Gmail source.
 * Fetches emails and normalizes them into Documents.
 */
export class GmailSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;

  private gmail: gmail_v1.Gmail;
  private dataCutoff?: Date;
  private attachmentConfig: AttachmentExtractionConfig;
  private extractAttachment?: AttachmentExtractFn;
  private labelMap: Map<string, string> | null = null;
  private labelMapFetchedAt = 0;
  // The account email (== accountId for multi-account sources). Used to pin
  // "open in Gmail" links to the right account via `?authuser=` (#463).
  private accountEmail?: string;
  constructor(
    auth: OAuth2Client,
    accountId?: string,
    dataCutoff?: string,
    opts?: GmailSourceOptions,
  ) {
    this.gmail = google.gmail({ version: "v1", auth });
    this.id = SourceId(accountId ? `gmail:${accountId}` : "gmail");
    this.providerId = ProviderId(accountId ? `google:${accountId}` : "google");
    this.accountEmail = accountId;
    this.attachmentConfig = opts?.attachmentConfig ?? resolveAttachmentConfig();
    this.extractAttachment = opts?.extractAttachment;
    if (dataCutoff) {
      this.dataCutoff = new Date(dataCutoff);
      log.info(`Data cutoff: ${dataCutoff}`);
    }
  }

  /**
   * Map of opaque label IDs (e.g. "Label_1234567890") to their human-readable
   * names. System labels (INBOX, STARRED, …) are their own names so they fall
   * through unchanged. Cached with a 1h TTL; refreshed on demand when an
   * unknown ID is seen in case the user just created a new label.
   */
  private async getLabelMap(forceRefresh = false): Promise<Map<string, string>> {
    if (
      !forceRefresh &&
      this.labelMap &&
      Date.now() - this.labelMapFetchedAt < GMAIL_LABEL_CACHE_TTL_MS
    ) {
      return this.labelMap;
    }
    try {
      const res = await this.gmail.users.labels.list({ userId: "me" });
      const map = new Map<string, string>();
      for (const label of res.data.labels ?? []) {
        if (label.id && label.name) map.set(label.id, label.name);
      }
      this.labelMap = map;
      this.labelMapFetchedAt = Date.now();
      return map;
    } catch (err) {
      log.warn(`Failed to fetch Gmail labels: ${err instanceof Error ? err.message : String(err)}`);
      return this.labelMap ?? new Map();
    }
  }

  private async resolveLabels(labelIds: string[]): Promise<string[]> {
    if (labelIds.length === 0) return [];
    let map = await this.getLabelMap();
    let needsRefresh = false;
    for (const id of labelIds) {
      if (id.startsWith("Label_") && !map.has(id)) {
        needsRefresh = true;
        break;
      }
    }
    if (needsRefresh) {
      map = await this.getLabelMap(true);
    }
    return labelIds.map((id) => map.get(id) ?? id);
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    const state = validateGmailSyncCursor(cursor) ?? { phase: "bootstrap" };

    // One typed boundary for both phases. `incrementalSync` maps the errors
    // it handles itself, and the mapper returns an existing `SyncError`
    // unchanged, so wrapping here adds nothing to that path — but it is the
    // only thing that classifies a failure from the bootstrap walk, from the
    // per-message fetch it fans out, or from an attachment download. Without
    // it those reach the collector as raw SDK throws: kind `unknown`, and a
    // transport failure reading `fetch failed` with nothing to say which
    // request died.
    try {
      if (state.phase === "bootstrap" || !state.historyId) {
        log.debug("Running bootstrap sync", { pageToken: state.pageToken });
        return await this.bootstrapSync(state);
      }

      log.debug("Running incremental sync", { historyId: state.historyId });
      return await this.incrementalSync(state);
    } catch (error: unknown) {
      throw mapGoogleApiError(error);
    }
  }

  private async bootstrapSync(state: GmailSyncCursor): Promise<SyncResult> {
    // Fetch totalMessages + pin a starting historyId on the first bootstrap page.
    // The pinned historyId is what we transition to "incremental" with — even if
    // a long bootstrap is interrupted and the cursor walks past Gmail's reported
    // messagesTotal, we still have a stable point to switch from.
    let totalMessages = state.totalMessages;
    let bootstrapHistoryId = state.bootstrapHistoryId;
    // Use mailbox-wide messagesTotal as the progress denominator. When a
    // cutoff is in effect the bar will plateau short of 100% (we only walk
    // the post-cutoff slice), but it's a true upper bound and stable across
    // pages — beats Gmail's per-query `resultSizeEstimate`, which jitters
    // wildly between calls.
    if (!state.pageToken || bootstrapHistoryId === undefined || totalMessages === undefined) {
      const profile = await this.gmail.users.getProfile({ userId: "me" });
      bootstrapHistoryId = bootstrapHistoryId ?? profile.data.historyId ?? undefined;
      totalMessages = profile.data.messagesTotal ?? totalMessages;
    }

    // Effective `after:` floor for `messages.list` — the more recent of the
    // configured dataCutoff and a recovery floor. `recoverAfter` is set only
    // on a recovery bootstrap (the fallback for an expired incremental
    // historyId): it bounds the walk to the missed window so a single 404
    // doesn't re-page the entire mailbox. dataCutoff pushes the same `after:`
    // so a 146K mailbox with maxAge=1y doesn't list all 146K only to drop 80%
    // gateway-side. Gmail's `after:` takes a YYYY/MM/DD date inclusive of that
    // day; we round down to UTC date to avoid timezone-edge slip.
    const recoverAfter = state.recoverAfter ? new Date(state.recoverAfter) : undefined;
    const afterFloor = laterDate(this.dataCutoff, recoverAfter);
    // What this walk can claim to have reached, restated on every page of it.
    const reach = reachOf(this.dataCutoff, recoverAfter, state.recoveryVouched === true);
    let q = "-in:spam -in:trash";
    if (afterFloor) {
      q += ` after:${gmailAfterDate(afterFloor)}`;
    }

    const res = await this.gmail.users.messages.list({
      userId: "me",
      maxResults: GOOGLE_PAGE_SIZE,
      pageToken: state.pageToken ?? undefined,
      q,
    });

    const messageIds = (res.data.messages ?? []).filter(
      (m): m is { id: string } => typeof m.id === "string",
    );
    // RTT-bound: each per-message `messages.get` is a separate round-trip,
    // serial loops over a 100-message page were the dominant bootstrap
    // wall-clock cost. Bounded concurrency stays inside Gmail's quota.
    const fetched = await pMap(messageIds, (msg) => this.fetchAndNormalize(msg.id), {
      concurrency: GOOGLE_FETCH_CONCURRENCY,
    });
    const documents: DocumentInput[] = fetched.flat();

    // Apply data cutoff as a safety net: Gmail's `after:YYYY/MM/DD` pushdown
    // is granular to the day in the user's account timezone, so a 1y cutoff
    // resolved to UTC midnight can leak a few hours of pre-cutoff messages
    // through. We drop them here. We do NOT halt the bootstrap on a drop —
    // those leaks are timezone slop or odd-internalDate edge cases, not a
    // signal that we've crossed the cutoff. With pushdown, Gmail's pagination
    // naturally exhausts at the `after:` boundary and `exhausted` is the
    // only correct stopper.
    const filteredDocuments = applyDataCutoff(
      documents,
      this.dataCutoff,
      log,
      "pre-cutoff messages",
    );

    // Counted in messages, because that is what it is compared against.
    // `messagesTotal` is a message count while a fetch returns a parent
    // document plus one child per extracted attachment, so counting documents
    // made the guard trip early — on an attachment-heavy mailbox, before
    // pagination had exhausted, ending the walk with mail still unread. The
    // guard only runs on an unbounded walk, where every listed message is
    // fetched, so the page's message count is the right increment.
    const processedDocs = (state.processedDocs ?? 0) + messageIds.length;

    // Bootstrap is "done" when any of:
    //   - Gmail's listMessages returns no more pages;
    //   - we've ingested at least messagesTotal docs (Gmail's listMessages can
    //     keep serving past messagesTotal due to in-flight churn — without this
    //     guard the cursor stays stuck in bootstrap forever).
    //
    // The `reachedTotal` guard only applies to an *unbounded* bootstrap, where
    // the denominator is the mailbox-wide `messagesTotal` (a hard upper bound).
    // Any `after:`-bounded walk (a dataCutoff or a recovery backfill) fetches
    // far fewer than `messagesTotal`, so a count-based escape would never fire
    // and, worse, the count isn't the right denominator anyway. For bounded
    // walks Gmail's pagination naturally exhausts at the `after:` boundary, so
    // `exhausted` is the only correct stopper.
    const reachedTotal =
      !afterFloor && totalMessages !== undefined && processedDocs >= totalMessages;
    const exhausted = !res.data.nextPageToken;
    const hasMore = !reachedTotal && !exhausted;

    // Only a walk that ran out of pages can claim to have reached everything.
    // Ending on the count guard means Gmail was still serving, and "complete"
    // is the one value a client may present as fact. The page that ends the
    // walk reports this too, so what it says and what it settles agree.
    const settledReach: HistoryCoverage =
      hasMore || exhausted || reach !== "complete" ? reach : "unknown";

    // On natural exhaustion we capture a fresh historyId (cheaper first
    // incremental). On early transition (reachedTotal / cutoff) we use the
    // historyId we pinned at bootstrap start — the first incremental run will
    // paginate via history.list to catch up.
    let historyId = state.historyId;
    if (!hasMore) {
      if (exhausted) {
        const profile = await this.gmail.users.getProfile({ userId: "me" });
        historyId = profile.data.historyId ?? bootstrapHistoryId ?? historyId;
        log.info(`Bootstrap complete (exhausted), captured fresh historyId: ${historyId}`);
      } else {
        historyId = bootstrapHistoryId ?? historyId;
        log.info(
          `Bootstrap complete (processed ${processedDocs}/${totalMessages ?? "?"}), using pinned historyId: ${historyId}`,
        );
      }
    }

    return {
      documents: filteredDocuments,
      deletedExternalIds: [],
      cursor: {
        historyId,
        pageToken: hasMore ? (res.data.nextPageToken ?? undefined) : undefined,
        totalMessages: hasMore ? totalMessages : undefined,
        phase: hasMore ? "bootstrap" : "incremental",
        bootstrapHistoryId: hasMore ? bootstrapHistoryId : undefined,
        processedDocs: hasMore ? processedDocs : undefined,
        recoverAfter: hasMore ? state.recoverAfter : undefined,
        // Carried for as long as the floor it qualifies. Dropping it left page
        // two of a recovery re-deriving "unknown" from the floor alone and
        // settling that — so the fix held only for a recovery small enough to
        // finish in one page, which is not the case it exists for.
        recoveryVouched: hasMore ? state.recoveryVouched : undefined,
        lastSyncAt: hasMore ? state.lastSyncAt : new Date().toISOString(),
        // Settled when the walk ends: from here on the incremental pages
        // restate it, because a history delta cannot re-derive how far back
        // the mailbox was read.
        // Only a walk that ran out of pages can claim to have reached
        // everything. Ending on the count guard means Gmail was still serving,
        // and "complete" is the one value a client may present as fact.
        coverage: hasMore ? state.coverage : settledReach,
      } satisfies GmailSyncCursor,
      hasMore,
      progress: {
        phase: "bootstrap",
        total: totalMessages,
        processed: processedDocs,
        coverage: settledReach,
        ...(reachDetail(settledReach) ? { detail: reachDetail(settledReach)! } : {}),
      },
    };
  }

  private async incrementalSync(state: GmailSyncCursor): Promise<SyncResult> {
    const documents: DocumentInput[] = [];
    const deletedExternalIds: string[] = [];

    try {
      const res = await this.gmail.users.history.list({
        userId: "me",
        startHistoryId: state.historyId,
        pageToken: state.historyPageToken ?? undefined,
        historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
      });

      const histories = res.data.history ?? [];

      const addedIds = new Set<string>();
      const trashedIds = new Set<string>();
      for (const history of histories) {
        for (const added of history.messagesAdded ?? []) {
          if (added.message?.id) addedIds.add(added.message.id);
        }
        for (const deleted of history.messagesDeleted ?? []) {
          if (deleted.message?.id) deletedExternalIds.push(deleted.message.id);
        }
        // TRASH/SPAM are soft-deletes; everything else (STARRED, IMPORTANT,
        // user labels, UNREAD, categories) is just a tag mutation that needs
        // a re-fetch so metadata.tags reflects the current state.
        for (const labelAdded of history.labelsAdded ?? []) {
          const id = labelAdded.message?.id;
          if (!id) continue;
          const labels = labelAdded.labelIds ?? [];
          if (labels.includes("TRASH") || labels.includes("SPAM")) {
            trashedIds.add(id);
          } else {
            addedIds.add(id);
          }
        }
        for (const labelRemoved of history.labelsRemoved ?? []) {
          const id = labelRemoved.message?.id;
          if (!id) continue;
          const labels = labelRemoved.labelIds ?? [];
          if (labels.includes("TRASH") || labels.includes("SPAM")) {
            trashedIds.delete(id);
            addedIds.add(id);
          } else {
            addedIds.add(id);
          }
        }
      }

      // Merge trashed into deleted
      for (const id of trashedIds) {
        deletedExternalIds.push(id);
      }

      // Don't fetch messages that were both added and deleted
      for (const id of deletedExternalIds) {
        addedIds.delete(id);
      }

      for (const id of addedIds) {
        const docs = await this.fetchAndNormalize(id);
        documents.push(...docs);
      }

      // Only advance historyId when we've drained every page. Otherwise keep
      // the same startHistoryId and persist nextPageToken so the next sync
      // resumes pagination — advancing prematurely loses every event past
      // page 1 of a multi-page history response.
      const nextHistoryPageToken = res.data.nextPageToken ?? undefined;
      const advancedHistoryId = nextHistoryPageToken
        ? state.historyId
        : (res.data.historyId ?? state.historyId);

      return {
        documents,
        deletedExternalIds,
        cursor: {
          historyId: advancedHistoryId,
          phase: "incremental",
          historyPageToken: nextHistoryPageToken,
          lastSyncAt: new Date().toISOString(),
          coverage: state.coverage,
        } satisfies GmailSyncCursor,
        hasMore: !!nextHistoryPageToken,
        // Restated, not recomputed. An incremental page sees one history delta
        // and cannot tell how far back the mailbox was walked; going silent
        // instead would leave whatever was last said standing forever, which
        // is how a recovery's "cannot tell" outlived the recovery.
        ...(state.coverage
          ? {
              progress: {
                phase: "incremental",
                processed: documents.length,
                coverage: state.coverage,
                ...(reachDetail(state.coverage) ? { detail: reachDetail(state.coverage)! } : {}),
              },
            }
          : {}),
      };
    } catch (error: unknown) {
      // historyId expired — the change-gap is unrecoverable via history.list.
      // Recover by re-bootstrapping, but bound the walk to the *recent* window
      // (`recoverAfter`) instead of re-paging the entire mailbox: everything
      // older is already indexed, and re-fetching 100k+ messages to recover a
      // few days' gap is a quota/time sink. The bounded bootstrap fetches the
      // missed window, then transitions to incremental from a fresh historyId.
      // Re-ingest is idempotent (upsert keys on provider/source/external_id).
      // See #111.
      if ((error as { code?: number } | undefined)?.code === 404) {
        const recoverAfter = this.recoveryFloor(state);
        log.warn(
          `Gmail historyId ${state.historyId} expired; backfilling messages after ${recoverAfter} instead of re-walking the full mailbox`,
        );
        // `recoveryFloor` anchors the backfill window on `lastSyncAt` when the
        // cursor carries one: everything before that watermark was already
        // indexed by an earlier successful sync, so the window is provably
        // complete. A cursor written before `lastSyncAt` existed has no
        // watermark to anchor on, so the floor falls back to a fixed
        // look-back — a guess that can undershoot a gap wider than the
        // fallback window, so the recovered range cannot be vouched for.
        const watermarked =
          state.lastSyncAt !== undefined && !Number.isNaN(Date.parse(state.lastSyncAt));
        return {
          documents: [],
          deletedExternalIds: [],
          cursor: {
            phase: "bootstrap",
            recoverAfter,
            lastSyncAt: state.lastSyncAt,
            // Carried so the bootstrap this hands off to reaches the same
            // conclusion the page above just did, rather than re-deriving a
            // weaker one from the floor alone.
            recoveryVouched: watermarked,
            coverage: state.coverage,
          } satisfies GmailSyncCursor,
          hasMore: true,
          ...(watermarked
            ? {}
            : {
                progress: {
                  phase: "bootstrap",
                  processed: 0,
                  coverage: "unknown",
                  // Phrased about the corpus, not about this page. The claim
                  // outlives the recovery that raised it, so a sentence in the
                  // present progressive would still be on screen describing a
                  // recovery that finished months earlier.
                  detail: reachDetail("unknown")!,
                },
              }),
        };
      }
      throw mapGoogleApiError(error);
    }
  }

  /**
   * The `after:` floor for a 404 recovery backfill: the last-sync watermark
   * minus a safety overlap, or a bounded fallback look-back when the cursor
   * predates the watermark. Returned as an ISO string for the cursor.
   */
  private recoveryFloor(state: GmailSyncCursor): string {
    if (state.lastSyncAt) {
      const t = new Date(state.lastSyncAt).getTime();
      if (!Number.isNaN(t)) {
        return new Date(t - GMAIL_HISTORY_RECOVERY_OVERLAP_MS).toISOString();
      }
    }
    return new Date(Date.now() - GMAIL_HISTORY_RECOVERY_FALLBACK_MS).toISOString();
  }

  private async fetchAndNormalize(messageId: string): Promise<DocumentInput[]> {
    const res = await this.gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const msg = res.data;
    if (!msg.id || !msg.payload) return [];

    // Skip messages in Spam or Trash
    const labels = msg.labelIds ?? [];
    if (labels.includes("SPAM") || labels.includes("TRASH")) return [];

    const headers = msg.payload.headers ?? [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

    const subject = getHeader("subject") || "(no subject)";
    const from = getHeader("from");
    const to = getHeader("to");
    const cc = getHeader("cc");
    const date = getHeader("date");
    const listUnsubscribe = getHeader("List-Unsubscribe");
    const precedence = getHeader("Precedence");
    const autoSubmitted = getHeader("Auto-Submitted");

    const body = this.extractBody(msg.payload);
    const schemaDates = this.schemaOrgDates(msg.payload);

    const sourceDate = msg.internalDate
      ? new Date(parseInt(msg.internalDate, 10)).toISOString()
      : new Date().toISOString();

    // Build structured people mentions.
    //
    // SECURITY CAVEAT: every identity below comes from a
    // sender-controlled `From`/`To`/`Cc` header or attacker-controlled body
    // text. None is authentication-verified — we don't consult
    // `Authentication-Results` for an aligned DKIM/DMARC pass, so a spoofed
    // sender (common on domains without enforced DMARC) is ingested as a
    // normal mention. Treat these as UNVERIFIED: fine for search/graph
    // completeness, but a retrieval-trust gate must not score a person as
    // credible off them without verifying first.
    const people: PersonMention[] = [];
    const seenEmails = new Set<string>();

    // Sender
    const fromParsed = from ? parseEmailHeader(from) : {};
    if (fromParsed.email) seenEmails.add(fromParsed.email);
    // Skip entirely if we got neither a name nor an email — an empty
    // From header is junk we don't want a person row for.
    if (fromParsed.name || fromParsed.email) {
      people.push({
        role: "sender",
        name: cleanPersonName(fromParsed.name),
        emails: fromParsed.email ? [fromParsed.email] : undefined,
      });
    }

    // Generic automated-notification marker: a no-reply / notifications sender
    // local part, or an RFC 3834 `Auto-Submitted: auto-generated` header.
    // Distinct from bulkMail (List-Unsubscribe) — it catches transactional
    // machine mail that carries no unsubscribe signal (CI/build notifications
    // are the canonical case). Shared consumers read this generically.
    const automatedSender =
      isAutoSubmittedGenerated(autoSubmitted) ||
      (fromParsed.email !== undefined && isAutomatedSenderAddress(fromParsed.email));

    // Recipients from To and Cc
    for (const header of [to, cc]) {
      if (!header) continue;
      for (const entry of splitEmailList(header)) {
        const parsed = parseEmailHeader(entry);
        if (parsed.email) seenEmails.add(parsed.email);
        if (parsed.name || parsed.email) {
          people.push({
            role: "recipient",
            name: cleanPersonName(parsed.name),
            emails: parsed.email ? [parsed.email] : undefined,
          });
        }
      }
    }

    // Mentioned emails/phones from body text (skip already-seen emails)
    const bodyEmails = extractEmailsFromText(body).filter((e) => !seenEmails.has(e));
    const bodyPhones = extractPhonesFromText(body);

    for (const email of bodyEmails) {
      people.push({ role: "mentioned", emails: [email] });
    }
    for (const phone of bodyPhones) {
      people.push({ role: "mentioned", phones: [phone], allowPersonCreation: false });
    }

    // Process attachments if enabled
    const attachmentInfos: AttachmentInfo[] = [];
    /**
     * Per-attachment pending bag — holds the extraction output until
     * the parent email's `DocumentInput` is built, at which point we
     * call `buildAttachmentDocument(emailDoc, ...)` to derive each
     * child. Pre-fix this was typed as `DocumentInput[]` and pushed
     * `{_pendingAttachment: true, ...}` markers cast through `as any`
     * (twice) because the marker shape is NOT a `DocumentInput`. The
     * typed `PendingAttachment` interface makes the array honest.
     */
    interface PendingAttachment {
      filename: string;
      extractionResult: ReturnType<
        NonNullable<GmailSourceOptions["extractAttachment"]>
      > extends Promise<infer R>
        ? NonNullable<R>
        : never;
      mimeType: string;
      /** AttachmentPartInfo.size is `number | null` when Gmail's API didn't
       *  populate body.size — preserved here so the downstream
       *  `deriveAttachmentStableId` can fall back to its "unknown" hash. */
      sizeBytes: number | null;
    }
    const attachmentDocs: PendingAttachment[] = [];

    if (this.attachmentConfig.enabled && this.extractAttachment) {
      const parts = this.findAttachmentParts(msg.payload);
      for (const part of parts) {
        // Recover the real type when the client sent a generic Content-Type
        // (a .pkpass mislabeled application/octet-stream is the common case).
        const mimeType = resolveEffectiveMimeType(part.filename, part.mimeType);
        const check = shouldExtractAttachment(mimeType, part.size, this.attachmentConfig);
        if (!check.extract) {
          attachmentInfos.push({
            filename: part.filename,
            mimeType,
            size: part.size,
            extracted: false,
            reason: check.reason,
          });
          continue;
        }

        try {
          const data = await this.downloadAttachment(msg.id, part.attachmentId);
          const result = await this.extractAttachment(data, mimeType, {
            maxTextLength: this.attachmentConfig.maxTextLength,
          });

          if (result?.noText) {
            attachmentInfos.push({
              filename: part.filename,
              mimeType,
              size: part.size,
              extracted: false,
              reason: "no-text",
            });
          } else if (result) {
            attachmentInfos.push({
              filename: part.filename,
              mimeType,
              size: part.size,
              extracted: true,
            });
            // We'll build the attachment doc after the parent doc is created
            // below. Note: we no longer carry `attachmentId` here — the
            // child's externalId derives from (filename, size, mimeType, seq)
            // via deriveAttachmentStableId, which is stable across re-syncs
            // (#268). Gmail's attachmentId is only used for the download
            // call above.
            attachmentDocs.push({
              filename: part.filename,
              extractionResult: result,
              mimeType,
              sizeBytes: part.size,
            });
          } else {
            attachmentInfos.push({
              filename: part.filename,
              mimeType,
              size: part.size,
              extracted: false,
              reason: "extraction-failed",
            });
          }
        } catch (err) {
          // A transient non-OCR extraction failure must fail the page so it
          // retries, not get recorded as a permanent download/extraction
          // failure that advances the cursor past the message forever (#680).
          // Optional OCR failures are normalized to null before this boundary.
          if (isTransientSyncError(err)) throw err;
          log.warn(
            `Failed to download attachment ${part.filename} from ${msg.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          attachmentInfos.push({
            filename: part.filename,
            mimeType,
            size: part.size,
            extracted: false,
            reason: "download-failed",
          });
        }
      }
    }

    // Build email content — append attachment markers if any
    let content = [
      `# ${subject}`,
      "",
      `**From:** ${from}`,
      `**To:** ${to}`,
      cc ? `**Cc:** ${cc}` : "",
      `**Date:** ${date}`,
      "",
      "---",
      "",
      body,
    ]
      .filter(Boolean)
      .join("\n");

    if (attachmentInfos.length > 0) {
      content += formatAttachmentMarkers(attachmentInfos);
    }

    const contentHash = computeContentHash(content);

    const emailDoc: DocumentInput = {
      providerId: this.providerId,
      sourceId: this.id,
      externalId: msg.id,
      title: subject,
      content,
      contentHash,
      metadata: {
        sourceUrl: gmailMessageUrl(msg.id, this.accountEmail),
        tags: await this.resolveLabels(msg.labelIds ?? []),
        documentType: "email",
        relevanceScore: this.computeRelevanceScore(labels, {
          listUnsubscribe,
          precedence,
          autoSubmitted,
        }),
        // Generic bulk-distribution marker (see DocumentMetadata.bulkMail):
        // shared consumers read this instead of re-deriving mail headers.
        ...(listUnsubscribe ? { bulkMail: true } : {}),
        // Generic automated-notification marker (see DocumentMetadata.automatedSender).
        ...(automatedSender ? { automatedSender: true } : {}),
        // Typed scheduled/due date promotion (#1168) — parsed from schema.org
        // JSON-LD markup that transactional mail (flights, hotels, orders,
        // reservations, invoices) embeds. Lets downstream consumers key off the
        // date without re-parsing prose, and lets the steward waker treat a
        // machine-sent confirmation as the actionable obligation it is.
        ...(schemaDates.scheduledAt ? { scheduledAt: schemaDates.scheduledAt } : {}),
        ...(schemaDates.dueAt ? { dueAt: schemaDates.dueAt } : {}),
        people,
        extra: {
          threadId: msg.threadId,
          ...(attachmentInfos.length > 0 ? { attachments: attachmentInfos } : {}),
        },
      },
      sourceCreatedAt: sourceDate,
      sourceUpdatedAt: sourceDate,
    };

    // Build actual attachment DocumentInput[] from pending data. Track seq
    // per stable-base-id so two attachments with identical (filename, size,
    // mimeType) within the same email get distinct externalIds.
    const result: DocumentInput[] = [emailDoc];
    const seqByBase = new Map<string, number>();
    for (const pending of attachmentDocs) {
      const baseId = deriveAttachmentStableId(
        pending.filename,
        pending.sizeBytes,
        pending.mimeType,
      );
      const seq = seqByBase.get(baseId) ?? 0;
      seqByBase.set(baseId, seq + 1);
      result.push(
        buildAttachmentDocument(emailDoc, pending.filename, pending.extractionResult, {
          mimeType: pending.mimeType,
          sizeBytes: pending.sizeBytes,
          seq,
        }),
      );
    }

    return result;
  }

  /**
   * Walk the MIME tree and find attachment parts with attachmentIds.
   *
   * Dedupe by (filename, size) within the same message — Gmail commonly
   * exposes the same byte payload twice for calendar invites (once as
   * `text/calendar`, once as `application/ics`) with distinct attachmentIds
   * but identical filename + size. Both parts have separate attachmentIds
   * but point at byte-identical content, and the user sees the result as
   * two duplicate rows in the portal Attachments panel (#267).
   *
   * The dedup keeps the *first* occurrence in tree-walk order — for the
   * calendar-invite case Gmail puts the `text/calendar` part first, which
   * matches our extractable-types whitelist, so the kept part is the one
   * we'd actually want to extract.
   */
  findAttachmentParts(payload: gmail_v1.Schema$MessagePart): AttachmentPartInfo[] {
    const parts: AttachmentPartInfo[] = [];
    this.walkAttachmentParts(payload, parts);

    const seen = new Set<string>();
    const deduped: AttachmentPartInfo[] = [];
    for (const p of parts) {
      // Use \0 as separator since filenames can technically contain anything
      // except null bytes on most filesystems and the MIME spec doesn't
      // allow it in `filename=` values.
      const key = `${p.filename}\0${p.size ?? "null"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(p);
    }
    return deduped;
  }

  private walkAttachmentParts(
    part: gmail_v1.Schema$MessagePart,
    result: AttachmentPartInfo[],
  ): void {
    if (part.filename && part.body?.attachmentId) {
      result.push({
        filename: part.filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        attachmentId: part.body.attachmentId,
        size: part.body.size ?? null,
      });
    }
    for (const child of part.parts ?? []) {
      this.walkAttachmentParts(child, result);
    }
  }

  /**
   * Download an attachment via the Gmail API.
   */
  private async downloadAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
    const res = await this.gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });
    const data = res.data.data;
    if (!data) throw new Error("Attachment data is empty");
    return new Uint8Array(Buffer.from(data, "base64url"));
  }

  private computeRelevanceScore(
    labels: string[],
    headers: { listUnsubscribe: string; precedence: string; autoSubmitted: string },
  ): number {
    let score = 0.5;
    // Label signals
    if (labels.includes("SENT")) score += 0.4;
    if (labels.includes("IMPORTANT")) score += 0.15;
    if (labels.includes("STARRED")) score += 0.15;
    if (labels.includes("CATEGORY_PERSONAL")) score += 0.1;
    if (labels.includes("CATEGORY_PROMOTIONS")) score -= 0.3;
    if (labels.includes("CATEGORY_SOCIAL")) score -= 0.2;
    if (labels.includes("CATEGORY_FORUMS")) score -= 0.1;
    if (labels.includes("CATEGORY_UPDATES")) score -= 0.05;
    if (labels.includes("DRAFT")) score -= 0.2;
    // Header signals — the shared weight table, so IMAP and Gmail can't drift.
    score += mailHeaderRelevancePenalty(headers);
    return Math.max(0, Math.min(1, score));
  }

  private extractBody(payload: gmail_v1.Schema$MessagePart): string {
    const textPart = this.findPart(payload, "text/plain");
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, "base64url").toString("utf-8");
    }

    const htmlPart = this.findPart(payload, "text/html");
    if (htmlPart?.body?.data) {
      const html = Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
      return htmlToMarkdown(html).trim();
    }

    return "";
  }

  /**
   * Promote schema.org JSON-LD dates from the email's HTML part to the typed
   * `scheduledAt` (earliest planned start) / `dueAt` (earliest deadline) fields
   * (#1168). Cheap + robust: regex the `<script type="application/ld+json">`
   * blocks, JSON.parse each, walk for the known date keys. Returns {} when the
   * mail carries no such markup (the common case).
   */
  private schemaOrgDates(payload: gmail_v1.Schema$MessagePart): {
    scheduledAt?: string;
    dueAt?: string;
  } {
    const htmlPart = this.findPart(payload, "text/html");
    if (!htmlPart?.body?.data) return {};
    const html = Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
    return extractSchemaOrgDatesFromHtml(html);
  }

  private findPart(
    part: gmail_v1.Schema$MessagePart,
    mimeType: string,
  ): gmail_v1.Schema$MessagePart | null {
    if (part.mimeType === mimeType) return part;
    for (const child of part.parts ?? []) {
      const found = this.findPart(child, mimeType);
      if (found) return found;
    }
    return null;
  }
}
