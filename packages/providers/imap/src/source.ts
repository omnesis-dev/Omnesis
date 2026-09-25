// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  buildAttachmentDocument,
  cleanPersonName,
  computeContentHash,
  createLogger,
  deriveAttachmentStableId,
  extractEmailsAndPhonesFromText,
  extractSchemaOrgDatesFromHtml,
  formatAttachmentMarkers,
  htmlToMarkdown,
  isAutomatedSenderAddress,
  isAutoSubmittedGenerated,
  mailHeaderRelevancePenalty,
  normalizeEmail,
  resolveAttachmentConfig,
  resolveEffectiveMimeType,
  shouldExtractAttachment,
} from "@omnesis/core";
import { makeCursorValidator, SnapshotEnumeration } from "@omnesis/source-sdk";
import { SourceId, ProviderId, SyncError, isTransientSyncError } from "@omnesis/types";
import type {
  AttachmentExtractionConfig,
  AttachmentExtractFn,
  AttachmentInfo,
  ExtractionResult,
} from "@omnesis/core";
import type { SyncCursor, SyncOptions, SyncProgress, SyncResult } from "@omnesis/source-sdk";
import type {
  DocumentInput,
  PersonMention,
  ProviderId as ProviderIdType,
  SourceId as SourceIdType,
} from "@omnesis/types";

const log = createLogger("source:imap");
const PAGE_SIZE = 50;
const METADATA_PAGE_SIZE = 500;
const MAX_BODY_BYTES = 512 * 1024;
const RETAINED_CLIENT_IDLE_MS = 30_000;
const MAX_MAILBOXES = 500;
const MAX_MAILBOX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_UIDS_PER_MAILBOX = 250_000;
const MAX_SCANNED_UIDS = 500_000;
const MAX_PRESENT_IDS = 500_000;
const MAX_PEOPLE_PER_MESSAGE = 1_000;
const SKIPPED_SPECIAL_USES = new Set(["\\drafts", "\\junk", "\\trash"]);

export interface ImapAddress {
  name?: string;
  address: string;
}

export interface ImapEnvelope {
  subject?: string;
  date?: Date;
  from?: ImapAddress[];
  to?: ImapAddress[];
  cc?: ImapAddress[];
  bcc?: ImapAddress[];
  messageId?: string;
  inReplyTo?: string;
}

/**
 * One attachment part from BODYSTRUCTURE — metadata only, no bytes. `size` is
 * the encoded body size the server declares (null when it declares none);
 * it feeds both the extraction gate and the stable child id, so the paged
 * read and the snapshot enumeration agree without downloading anything.
 */
export interface ImapAttachmentPart {
  part: string;
  filename: string;
  mimeType: string;
  size: number | null;
}

export interface ImapMessage {
  uid: number;
  envelope: ImapEnvelope;
  internalDate?: Date;
  references?: string[];
  /** Raw `List-Unsubscribe` header value, when the message carries one. */
  listUnsubscribe?: string;
  /** Raw RFC 3834 `Auto-Submitted` header value, when the message carries one. */
  autoSubmitted?: string;
  /** Raw `Precedence` header value, when the message carries one. */
  precedence?: string;
  /** Attachment parts discovered in BODYSTRUCTURE, deduplicated by (filename, size). */
  attachments?: ImapAttachmentPart[];
  text?: string;
  html?: string;
  truncated?: boolean;
}

export interface ImapMailbox {
  path: string;
  flags: ReadonlySet<string>;
  specialUse?: string;
}

export interface ImapMailboxState {
  uidValidity: string;
  uidNext: number;
}

export interface ImapMessageMetadata {
  uid: number;
  date?: Date;
  /** Present when metadata was fetched with `attachments: true`. */
  attachments?: ImapAttachmentPart[];
}

export interface ImapClient {
  connect(): Promise<void>;
  list(maxEntries: number, maxBytes: number): Promise<ImapMailbox[]>;
  open(path: string): Promise<ImapMailboxState>;
  search(query: { since?: Date; uid?: string }): Promise<number[]>;
  fetch(uids: number[], maxBytes: number): Promise<ImapMessage[]>;
  fetchMetadata(uids: number[], opts?: { attachments?: boolean }): Promise<ImapMessageMetadata[]>;
  /** Download one attachment part's decoded bytes, failing on truncation. */
  fetchAttachment(uid: number, part: string, maxBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export type ImapClientFactory = () => ImapClient;

export interface ImapEmailSourceOptions {
  attachmentConfig?: AttachmentExtractionConfig;
  extractAttachment?: AttachmentExtractFn;
  /**
   * The most ids one account's enumeration may name, across every mailbox.
   *
   * A runaway guard on the single `presentExternalIds` array this source
   * emits, not a capacity estimate — the default sits well above what any real
   * account produces. Overridable so the guard itself can be exercised: a
   * ceiling that no test can afford to reach is a guard nobody has watched
   * fire.
   */
  maxPresentIds?: number;
}

export interface ImapEmailCursor extends SyncCursor {
  phase: "bootstrap" | "incremental";
  mailboxes: Record<string, { uidValidity: string; lastUid: number }>;
  pendingMailboxPaths?: string[];
  activeMailbox?: {
    path: string;
    uidValidity: string;
    highWaterUid: number;
    afterUid: number;
  };
}

export const validateImapEmailCursor = makeCursorValidator(isImapEmailCursor);

export class ImapEmailSource {
  readonly id: SourceIdType;
  readonly providerId: ProviderIdType;
  private readonly cutoff?: Date;
  private client?: ImapClient;
  private readonly closingClients = new WeakMap<ImapClient, Promise<void>>();
  private readonly pendingCloses = new Set<Promise<void>>();
  private pendingClient?: Promise<ImapClient>;
  private retainedCloseTimer?: ReturnType<typeof setTimeout>;
  private lifecycleGeneration = 0;
  private syncInFlight = false;

  private readonly attachmentConfig: AttachmentExtractionConfig;
  private readonly extractAttachment?: AttachmentExtractFn;
  private readonly maxPresentIds: number;

  constructor(
    sourceId: string,
    providerId: string,
    private readonly createClient: ImapClientFactory,
    dataCutoff?: string,
    options?: ImapEmailSourceOptions,
  ) {
    this.id = SourceId(sourceId);
    this.providerId = ProviderId(providerId);
    this.cutoff = dataCutoff ? new Date(dataCutoff) : undefined;
    this.attachmentConfig = options?.attachmentConfig ?? resolveAttachmentConfig();
    this.extractAttachment = options?.extractAttachment;
    this.maxPresentIds = options?.maxPresentIds ?? MAX_PRESENT_IDS;
  }

  private attachmentsEnabled(): boolean {
    return this.attachmentConfig.enabled && this.extractAttachment !== undefined;
  }

  /**
   * A mail provider can prune messages under its own retention or mailbox-
   * expiry policy at any time, including before this account was ever
   * connected. IMAP gives no signal that this happened — a purged message
   * looks identical to one that never existed — so this source can never
   * vouch for holding a mailbox's full history back to its true beginning,
   * in bootstrap or in steady-state incremental sync alike.
   */
  private historyCoverage(phase: ImapEmailCursor["phase"], processed: number): SyncProgress {
    return {
      phase,
      processed,
      coverage: "unknown",
      detail:
        "Mail providers can delete old mail under their own retention rules, and the mail " +
        "protocol does not say whether they have. Omnesis removes what the mailbox removes, so older mail may not be here.",
    };
  }

  async sync(
    cursor: ImapEmailCursor | null,
    opts?: SyncOptions,
  ): Promise<SyncResult<ImapEmailCursor>> {
    opts?.signal?.throwIfAborted();
    if (this.syncInFlight) throw new Error("IMAP sync is already in progress");
    this.syncInFlight = true;
    try {
      const result = await this.syncOnce(cursor);
      opts?.signal?.throwIfAborted();
      return result;
    } finally {
      this.syncInFlight = false;
    }
  }

  private async syncOnce(cursor: ImapEmailCursor | null): Promise<SyncResult<ImapEmailCursor>> {
    const client = await this.connectedClient();
    let keepOpen = false;

    try {
      const listed = (await client.list(MAX_MAILBOXES, MAX_MAILBOX_LIST_BYTES)).filter(
        isSelectableMailbox,
      );
      if (listed.length > MAX_MAILBOXES) {
        throw new Error(`IMAP account exceeds safe mailbox limit (${MAX_MAILBOXES})`);
      }
      const listedByPath = new Map(listed.map((mailbox) => [mailbox.path, mailbox]));
      const mailboxes = Object.fromEntries(
        Object.entries(cursor?.mailboxes ?? {}).filter(([path]) => listedByPath.has(path)),
      );
      let pendingMailboxPaths = cursor?.pendingMailboxPaths
        ? cursor.pendingMailboxPaths.filter((path) => listedByPath.has(path))
        : listed.map((mailbox) => mailbox.path);
      let activeMailbox =
        cursor?.activeMailbox && listedByPath.has(cursor.activeMailbox.path)
          ? cursor.activeMailbox
          : undefined;
      if (cursor?.pendingMailboxPaths) {
        const represented = new Set([
          ...Object.keys(mailboxes),
          ...pendingMailboxPaths,
          ...(activeMailbox ? [activeMailbox.path] : []),
        ]);
        for (const mailbox of listed) {
          if (!represented.has(mailbox.path)) pendingMailboxPaths.push(mailbox.path);
        }
      }
      const documents: DocumentInput[] = [];
      const path = activeMailbox?.path ?? pendingMailboxPaths[0];

      if (path) {
        const state = await client.open(path);
        const currentHighWaterUid = mailboxHighWaterUid(state);
        if (!activeMailbox || activeMailbox.uidValidity !== state.uidValidity) {
          const previous = mailboxes[path];
          const afterUid = previous?.uidValidity === state.uidValidity ? previous.lastUid : 0;
          if (afterUid > currentHighWaterUid) {
            throw new Error("IMAP cursor exceeds mailbox high-water UID");
          }
          activeMailbox = {
            path,
            uidValidity: state.uidValidity,
            highWaterUid: currentHighWaterUid,
            afterUid,
          };
        } else if (activeMailbox.highWaterUid > currentHighWaterUid) {
          throw new Error("IMAP active cursor exceeds mailbox high-water UID");
        }

        const { uidValidity, highWaterUid, afterUid } = activeMailbox;
        const uids =
          highWaterUid > afterUid
            ? await client.search(
                afterUid > 0
                  ? { uid: `${afterUid + 1}:${highWaterUid}` }
                  : {
                      ...(this.cutoff ? { since: serverSearchSince(this.cutoff) } : {}),
                      uid: `1:${highWaterUid}`,
                    },
              )
            : [];
        const remainingUids = sortedBoundedUids(uids, afterUid, highWaterUid);
        const pageUids = remainingUids.slice(0, PAGE_SIZE);
        const rows = pageUids.length > 0 ? await client.fetch(pageUids, MAX_BODY_BYTES) : [];
        const rowsByUid = new Map<number, ImapMessage>();
        for (const row of rows) {
          if (rowsByUid.has(row.uid)) throw new Error("IMAP server returned duplicate fetched UID");
          rowsByUid.set(row.uid, row);
        }

        const sentMailbox = isSentMailbox(listedByPath.get(path));
        for (const uid of pageUids) {
          const row = rowsByUid.get(uid);
          if (!row) throw new Error(`IMAP server omitted requested UID ${uid} from ${path}`);
          const date = messageDate(row);
          if (!date) throw new Error("IMAP message has no valid date");
          if (this.cutoff && date.getTime() < this.cutoff.getTime()) continue;
          documents.push(
            ...(await this.normalize(client, path, uidValidity, row, date, sentMailbox)),
          );
        }

        if (remainingUids.length > pageUids.length) {
          keepOpen = true;
          return {
            documents,
            deletedExternalIds: [],
            cursor: {
              phase: cursor?.phase ?? "bootstrap",
              mailboxes,
              pendingMailboxPaths,
              activeMailbox: {
                ...activeMailbox,
                afterUid: pageUids.at(-1) ?? afterUid,
              },
            },
            hasMore: true,
            progress: this.historyCoverage(cursor?.phase ?? "bootstrap", documents.length),
          };
        }

        mailboxes[path] = { uidValidity, lastUid: highWaterUid };
        pendingMailboxPaths = pendingMailboxPaths.filter((pending) => pending !== path);
        activeMailbox = undefined;
        if (pendingMailboxPaths.length > 0) {
          keepOpen = true;
          return {
            documents,
            deletedExternalIds: [],
            cursor: {
              phase: cursor?.phase ?? "bootstrap",
              mailboxes,
              pendingMailboxPaths,
            },
            hasMore: true,
            progress: this.historyCoverage(cursor?.phase ?? "bootstrap", documents.length),
          };
        }
      }

      const snapshot = await this.listPresentExternalIds(client, listed, mailboxes);
      const renumbered = snapshot.gaps.map((gap) => gap.partition);
      if (renumbered.length > 0) {
        // Every mailbox that moved has to be walked again from UID 1, so this
        // cycle is not over and nothing it found may be asserted: a claim, like
        // a snapshot, is only valid when the enumeration it describes is
        // complete, and the host refuses one on a page that says there is more.
        // The gain over aborting on the first mismatch is that every moved
        // mailbox is found in one pass and re-queued together, instead of one
        // per cycle.
        for (const path of renumbered) delete mailboxes[path];
        keepOpen = true;
        log.warn(snapshot.withheldReason() ?? "Snapshot withheld");
        return {
          documents,
          deletedExternalIds: [],
          cursor: {
            phase: "bootstrap",
            mailboxes,
            pendingMailboxPaths: renumbered,
          },
          hasMore: true,
          progress: this.historyCoverage("bootstrap", documents.length),
        };
      }
      const issue = snapshot.withheldIssue();
      return {
        documents,
        deletedExternalIds: [],
        presentExternalIds: snapshot.result(),
        issues: issue ? [issue] : [],
        cursor: { phase: "incremental", mailboxes },
        hasMore: false,
        progress: this.historyCoverage("incremental", documents.length),
      };
    } finally {
      if (keepOpen) this.armRetainedClose(client);
      else await this.closeClient(client);
    }
  }

  async suspend(): Promise<void> {
    await this.dispose();
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  async dispose(): Promise<void> {
    this.lifecycleGeneration += 1;
    this.clearRetainedCloseTimer();
    const pending = this.pendingClient;
    await this.closeClient();
    if (pending) await pending.catch(() => undefined);
    await Promise.all(this.pendingCloses);
  }

  private async connectedClient(): Promise<ImapClient> {
    this.clearRetainedCloseTimer();
    if (this.client) return this.client;
    const generation = this.lifecycleGeneration;
    const client = this.createClient();
    const pending = (async () => {
      await client.connect();
      if (generation !== this.lifecycleGeneration) {
        throw new Error("IMAP source lifecycle changed during connect");
      }
      this.client = client;
      return client;
    })();
    this.pendingClient = pending;
    try {
      return await pending;
    } catch (error) {
      await this.closeClient(client);
      throw error;
    } finally {
      if (this.pendingClient === pending) this.pendingClient = undefined;
    }
  }

  private armRetainedClose(client: ImapClient): void {
    this.clearRetainedCloseTimer();
    this.retainedCloseTimer = setTimeout(() => {
      void this.closeClient(client);
    }, RETAINED_CLIENT_IDLE_MS);
    this.retainedCloseTimer.unref?.();
  }

  private clearRetainedCloseTimer(): void {
    if (this.retainedCloseTimer) clearTimeout(this.retainedCloseTimer);
    this.retainedCloseTimer = undefined;
  }

  private async closeClient(client = this.client): Promise<void> {
    if (!client) return;
    const existing = this.closingClients.get(client);
    if (existing) return existing;
    if (this.client === client) {
      this.client = undefined;
      this.clearRetainedCloseTimer();
    }
    const closing = (async () => {
      try {
        await client.close();
      } catch {
        log.warn("Failed to close IMAP connection");
      }
    })();
    this.closingClients.set(client, closing);
    this.pendingCloses.add(closing);
    try {
      await closing;
    } finally {
      this.pendingCloses.delete(closing);
    }
  }

  /**
   * Enumerate every selectable mailbox, one partition each.
   *
   * A mailbox whose UIDVALIDITY has moved since the paged read renumbered
   * every message in it, so the ids this cycle holds for it name nothing that
   * still exists. It is a declared gap, which withholds the account-wide
   * snapshot and tells the caller to walk it again from UID 1.
   *
   * The enumeration is what decides that, rather than an early return on the
   * first mismatch: a partition is vouched for only by being covered, so a
   * mailbox that returns early cannot be claimed by forgetting to exclude it,
   * and every mailbox that moved is found in one pass and re-queued together.
   *
   * There is no claim to make here. A moved mailbox has to be re-read before
   * this cycle can say anything, so the page that reports it is not the last
   * one — and an assertion about what exists is only valid on a page that ends
   * the enumeration it describes.
   */
  private async listPresentExternalIds(
    client: ImapClient,
    mailboxes: ImapMailbox[],
    expected: ImapEmailCursor["mailboxes"],
  ): Promise<SnapshotEnumeration> {
    const snapshot = new SnapshotEnumeration(mailboxes.map((mailbox) => mailbox.path));
    let scannedUids = 0;
    for (const mailbox of mailboxes) {
      const ids: string[] = [];
      // Read once per mailbox, not once per id: `size` rebuilds a set over every
      // id already covered, so consulting it inside the id loop is quadratic in
      // the account's message count — hours of blocked event loop on an account
      // anywhere near the caps below.
      const alreadyCovered = snapshot.size;
      const state = await client.open(mailbox.path);
      if (expected[mailbox.path]?.uidValidity !== state.uidValidity) {
        snapshot.gap(
          mailbox.path,
          expected[mailbox.path] === undefined
            ? "not in the cursor, so this cycle never read it"
            : "UIDVALIDITY moved since the paged read, so its messages are renumbered",
        );
        continue;
      }
      const highWaterUid = mailboxHighWaterUid(state);
      const uids =
        highWaterUid === 0
          ? []
          : await client.search({
              ...(this.cutoff ? { since: serverSearchSince(this.cutoff) } : {}),
              uid: `1:${highWaterUid}`,
            });
      const bounded = sortedBoundedUids(uids, 0, highWaterUid);
      scannedUids += bounded.length;
      if (scannedUids > MAX_SCANNED_UIDS) {
        throw new Error(`IMAP account exceeds safe scanned-UID limit (${MAX_SCANNED_UIDS})`);
      }
      // The snapshot must name every attachment child document or the
      // gateway sweeps it: the metadata pass reconstructs child ids from
      // BODYSTRUCTURE alone, through the same eligibility predicate the
      // paged read extracts with, without downloading any bytes. Two costs
      // are accepted deliberately: the pass re-fetches BODYSTRUCTURE for
      // every message each full cycle (the price of the deletion contract —
      // metadata only, no bodies), and child ids share the MAX_PRESENT_IDS
      // budget with message ids (they consume the same memory). Disabling
      // extraction stops naming children, so the sweep removes them; a later
      // re-enable needs a resync to rebuild them, since the UID cursor never
      // revisits synced messages.
      const wantAttachments = this.attachmentsEnabled();
      if (!this.cutoff && !wantAttachments) {
        for (const uid of bounded) {
          ids.push(externalId(mailbox.path, state.uidValidity, uid));
          assertPresentIdLimit(alreadyCovered + ids.length, this.maxPresentIds);
        }
        snapshot.cover(mailbox.path, ids);
        continue;
      }
      for (let offset = 0; offset < bounded.length; offset += METADATA_PAGE_SIZE) {
        const page = bounded.slice(offset, offset + METADATA_PAGE_SIZE);
        const metadata = await client.fetchMetadata(page, { attachments: wantAttachments });
        const byUid = uniqueMetadataByUid(metadata);
        for (const uid of page) {
          const row = byUid.get(uid);
          if (!row) throw new Error("IMAP server omitted requested metadata");
          if (this.cutoff) {
            if (!row.date || !Number.isFinite(row.date.getTime())) {
              throw new Error("IMAP message metadata has no valid date");
            }
            if (row.date.getTime() < this.cutoff.getTime()) continue;
          }
          const messageId = externalId(mailbox.path, state.uidValidity, uid);
          ids.push(messageId);
          assertPresentIdLimit(alreadyCovered + ids.length, this.maxPresentIds);
          for (const childId of this.attachmentChildIds(messageId, row.attachments)) {
            ids.push(childId);
            assertPresentIdLimit(alreadyCovered + ids.length, this.maxPresentIds);
          }
        }
      }
      // Covered only here, after the last page of this mailbox. Every earlier
      // exit — a renumbered mailbox, a server that omitted metadata, a cap —
      // leaves before it, so it cannot be claimed on a partial read.
      snapshot.cover(mailbox.path, ids);
    }
    return snapshot;
  }

  /**
   * Split the message's attachment parts into the ones the config extracts
   * and marker-only skips. The same predicate runs in the snapshot
   * enumeration, so a child document can never exist that the snapshot
   * would fail to name. Parts arrive deduplicated by (filename, size), so
   * `deriveAttachmentStableId`'s tie-group `seq` is always 0 here.
   */
  private classifyAttachments(parts: ImapAttachmentPart[] | undefined): {
    eligible: Array<{ part: ImapAttachmentPart; mimeType: string }>;
    skipped: AttachmentInfo[];
  } {
    const eligible: Array<{ part: ImapAttachmentPart; mimeType: string }> = [];
    const skipped: AttachmentInfo[] = [];
    if (!this.attachmentsEnabled() || !parts?.length) return { eligible, skipped };
    for (const part of parts) {
      // Recover the real type when the server sent a generic Content-Type.
      const mimeType = resolveEffectiveMimeType(part.filename, part.mimeType);
      const check = shouldExtractAttachment(mimeType, part.size, this.attachmentConfig);
      if (check.extract) {
        eligible.push({ part, mimeType });
      } else {
        skipped.push({
          filename: part.filename,
          mimeType,
          size: part.size,
          extracted: false,
          reason: check.reason,
        });
      }
    }
    return { eligible, skipped };
  }

  private attachmentChildIds(
    messageExternalId: string,
    parts: ImapAttachmentPart[] | undefined,
  ): string[] {
    return this.classifyAttachments(parts).eligible.map(
      ({ part, mimeType }) =>
        `${messageExternalId}/att/${deriveAttachmentStableId(part.filename, part.size, mimeType)}`,
    );
  }

  private async normalize(
    client: ImapClient,
    mailbox: string,
    uidValidity: string,
    message: ImapMessage,
    date: Date,
    sentMailbox: boolean,
  ): Promise<DocumentInput[]> {
    const title = message.envelope.subject || "(no subject)";
    const body = message.text || (message.html ? htmlToMarkdown(message.html) : "");
    // Generic mail markers (see DocumentMetadata.bulkMail / .automatedSender):
    // shared consumers read these instead of re-deriving mail headers.
    const automatedSender =
      isAutoSubmittedGenerated(message.autoSubmitted) ||
      isAutomatedSenderAddress(message.envelope.from?.[0]?.address ?? "");
    // Typed scheduled/due promotion (#1168), shared with Gmail. The client
    // downloads the HTML sibling of a preferred plain part exactly so this
    // scan sees the markup transactional multipart/alternative mail carries.
    const schemaDates = message.html ? extractSchemaOrgDatesFromHtml(message.html) : {};
    const createdAt = date.toISOString();
    const stableId = externalId(mailbox, uidValidity, message.uid);
    const threadId =
      message.references?.[0] ??
      message.envelope.inReplyTo ??
      message.envelope.messageId ??
      stableId;
    const people = collectPeople(message.envelope, body);
    const format = (addresses: ImapAddress[] | undefined) =>
      addresses?.map((address) =>
        address.name ? `${address.name} <${address.address}>` : address.address,
      );
    const from = format(message.envelope.from);
    const to = format(message.envelope.to);
    const cc = format(message.envelope.cc);

    const { eligible, skipped } = this.classifyAttachments(message.attachments);
    const attachmentInfos: AttachmentInfo[] = [...skipped];
    interface PendingAttachment {
      filename: string;
      extractionResult: ExtractionResult;
      mimeType: string;
      sizeBytes: number | null;
    }
    const pendingAttachments: PendingAttachment[] = [];
    for (const { part, mimeType } of eligible) {
      try {
        const data = await client.fetchAttachment(
          message.uid,
          part.part,
          this.attachmentConfig.maxSizeBytes,
        );
        const result = await this.extractAttachment!(data, mimeType, {
          maxTextLength: this.attachmentConfig.maxTextLength,
        });
        if (result?.noText) {
          // A successful extraction that found no text (a photo with nothing
          // to OCR) — a marker, never an empty child document.
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
          pendingAttachments.push({
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
      } catch (error) {
        // A typed SyncError from the client is infrastructure — auth, network,
        // rate limit — and must fail the page so it retries, not get recorded
        // as a permanent per-attachment failure that advances the cursor past
        // the message forever (the Gmail #680 lesson).
        if (error instanceof SyncError || isTransientSyncError(error)) throw error;
        log.warn(
          `Failed to extract attachment ${part.filename} from UID ${message.uid}: ${error instanceof Error ? error.message : String(error)}`,
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

    let content = [
      `# ${title}`,
      "",
      from?.length ? `**From:** ${from.join(", ")}` : "",
      to?.length ? `**To:** ${to.join(", ")}` : "",
      cc?.length ? `**Cc:** ${cc.join(", ")}` : "",
      `**Date:** ${createdAt}`,
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
    const emailDoc: DocumentInput = {
      providerId: this.providerId,
      sourceId: this.id,
      externalId: stableId,
      // The mailbox this message lives in. The path alone, without the
      // UIDVALIDITY the external id also carries: a renumbered mailbox is still
      // the same mailbox, and the next full read of it is what removes the
      // messages under the old numbering.
      //
      // Nothing narrows a snapshot to one mailbox today — this source's
      // enumeration runs only when every mailbox has drained, so a cycle that
      // cannot vouch for one of them has more work to do and may assert
      // nothing. The key is here because the day that changes, a claim can only
      // reach documents that already say which mailbox they are in, and a key
      // that appears on the day it is first needed reaches none of them.
      partitionKey: mailbox,
      title,
      content,
      contentHash: computeContentHash(content),
      metadata: {
        tags: [mailbox],
        documentType: "email",
        relevanceScore: computeRelevanceScore(message, sentMailbox),
        ...(message.listUnsubscribe ? { bulkMail: true } : {}),
        ...(automatedSender ? { automatedSender: true } : {}),
        ...(schemaDates.scheduledAt ? { scheduledAt: schemaDates.scheduledAt } : {}),
        ...(schemaDates.dueAt ? { dueAt: schemaDates.dueAt } : {}),
        people,
        extra: {
          mailbox,
          uid: message.uid,
          uidValidity,
          internetMessageId: message.envelope.messageId,
          inReplyTo: message.envelope.inReplyTo,
          references: message.references,
          threadId,
          truncated: message.truncated ?? false,
          ...(attachmentInfos.length > 0 ? { attachments: attachmentInfos } : {}),
        },
      },
      sourceCreatedAt: createdAt,
      sourceUpdatedAt: createdAt,
    };
    return [
      emailDoc,
      ...pendingAttachments.map((pending) =>
        buildAttachmentDocument(emailDoc, pending.filename, pending.extractionResult, {
          mimeType: pending.mimeType,
          sizeBytes: pending.sizeBytes,
        }),
      ),
    ];
  }
}

export function isImapEmailCursor(value: unknown): value is ImapEmailCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  if (cursor.phase !== "bootstrap" && cursor.phase !== "incremental") return false;
  if (
    !cursor.mailboxes ||
    typeof cursor.mailboxes !== "object" ||
    Array.isArray(cursor.mailboxes)
  ) {
    return false;
  }
  for (const entry of Object.values(cursor.mailboxes)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const mailbox = entry as Record<string, unknown>;
    if (typeof mailbox.uidValidity !== "string" || mailbox.uidValidity.length === 0) return false;
    if (!isUid(mailbox.lastUid)) return false;
  }
  if (cursor.pendingMailboxPaths !== undefined) {
    if (
      !Array.isArray(cursor.pendingMailboxPaths) ||
      cursor.pendingMailboxPaths.some((path) => typeof path !== "string" || path.length === 0)
    ) {
      return false;
    }
  }
  if (cursor.activeMailbox !== undefined) {
    if (!cursor.activeMailbox || typeof cursor.activeMailbox !== "object") return false;
    const active = cursor.activeMailbox as Record<string, unknown>;
    if (typeof active.path !== "string" || active.path.length === 0) return false;
    if (typeof active.uidValidity !== "string" || active.uidValidity.length === 0) return false;
    if (!isUid(active.highWaterUid) || !isUid(active.afterUid)) return false;
    if (active.afterUid > active.highWaterUid) return false;
  }
  return true;
}

function mailboxHighWaterUid(state: ImapMailboxState): number {
  if (
    typeof state.uidValidity !== "string" ||
    state.uidValidity.length > 128 ||
    !/^(?:[a-f0-9]{16}:)?[1-9]\d*$/.test(state.uidValidity)
  ) {
    throw new Error("IMAP server returned invalid UIDVALIDITY");
  }
  if (!Number.isSafeInteger(state.uidNext) || state.uidNext < 1) {
    throw new Error("IMAP server returned invalid UIDNEXT");
  }
  return state.uidNext - 1;
}

function isUid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSelectableMailbox(mailbox: ImapMailbox): boolean {
  if ([...mailbox.flags].some((flag) => flag.toLowerCase() === "\\noselect")) return false;
  return !mailbox.specialUse || !SKIPPED_SPECIAL_USES.has(mailbox.specialUse.toLowerCase());
}

/**
 * Widen a cutoff into the SINCE a server search may safely prefilter with.
 *
 * RFC 3501 SINCE compares only the INTERNALDATE's calendar day — in the
 * server's own timezone, ignoring time — so passing the cutoff instant
 * verbatim can NARROW the search: a message stored at 23:00 the previous
 * server-local day whose instant is past the cutoff would be excluded, and
 * on the snapshot path an exclusion is a deletion order for a message the
 * page loop ingested. Two days of slack covers every timezone plus the day
 * truncation in both directions; the exact instant filter always runs
 * client-side against the fetched date.
 */
function serverSearchSince(cutoff: Date): Date {
  return new Date(cutoff.getTime() - 48 * 60 * 60 * 1000);
}

function isSentMailbox(mailbox: ImapMailbox | undefined): boolean {
  return mailbox?.specialUse?.toLowerCase() === "\\sent";
}

/**
 * Mirror of the Gmail header-signal weights. IMAP has no label taxonomy; the
 * sent mailbox is the one positive signal taken. `\Flagged` (Gmail's STARRED,
 * +0.15) is deliberately skipped, not unavailable: the UID cursor never
 * revisits a synced message, so a flag set after sync would go stale anyway.
 */
function computeRelevanceScore(message: ImapMessage, sentMailbox: boolean): number {
  let score = 0.5;
  if (sentMailbox) score += 0.4;
  score += mailHeaderRelevancePenalty(message);
  return Math.max(0, Math.min(1, score));
}

function uniqueMetadataByUid(rows: ImapMessageMetadata[]): Map<number, ImapMessageMetadata> {
  const byUid = new Map<number, ImapMessageMetadata>();
  for (const row of rows) {
    if (byUid.has(row.uid)) throw new Error("IMAP server returned duplicate metadata UID");
    byUid.set(row.uid, row);
  }
  return byUid;
}

function sortedBoundedUids(uids: number[], afterUid: number, highWaterUid: number): number[] {
  if (uids.length > MAX_UIDS_PER_MAILBOX) {
    throw new Error(`IMAP mailbox exceeds safe UID limit (${MAX_UIDS_PER_MAILBOX})`);
  }
  const seen = new Set<number>();
  for (const uid of uids) {
    if (!Number.isSafeInteger(uid) || uid <= 0) {
      throw new Error("IMAP server returned invalid UID");
    }
    if (seen.has(uid)) throw new Error("IMAP server returned duplicate UID");
    if (uid <= afterUid || uid > highWaterUid) {
      throw new Error("IMAP server returned UID outside requested range");
    }
    seen.add(uid);
  }
  return [...seen].sort((a, b) => a - b);
}

function assertPresentIdLimit(count: number, limit: number): void {
  if (count > limit) {
    throw new Error(`IMAP account exceeds safe snapshot limit (${limit})`);
  }
}

// Known bug: #2700 — a message moved between folders gets a new id, so a move reads as a create plus a delete.
function externalId(mailbox: string, uidValidity: string, uid: number): string {
  return `${Buffer.from(mailbox).toString("base64url")}:${uidValidity}:${uid}`;
}

function messageDate(message: ImapMessage): Date | undefined {
  const date = message.internalDate ?? message.envelope.date;
  return date && Number.isFinite(date.getTime()) ? date : undefined;
}

function collectPeople(envelope: ImapEnvelope, body: string): PersonMention[] {
  const people: PersonMention[] = [];
  const seenEmails = new Set<string>();
  const append = (role: "sender" | "recipient", addresses: ImapAddress[] | undefined) => {
    for (const address of addresses ?? []) {
      if (people.length >= MAX_PEOPLE_PER_MESSAGE) return;
      // Core's canonical form (Gmail dot/+ folding included), so the same
      // correspondent synced over IMAP and Gmail lands on one person.
      const email = normalizeEmail(address.address);
      if (!email || seenEmails.has(email)) continue;
      seenEmails.add(email);
      people.push({ role, name: cleanPersonName(address.name), emails: [email] });
    }
  };
  append("sender", envelope.from);
  append("recipient", [...(envelope.to ?? []), ...(envelope.cc ?? []), ...(envelope.bcc ?? [])]);

  const mentioned = extractEmailsAndPhonesFromText(body);
  for (const email of mentioned.emails) {
    if (people.length >= MAX_PEOPLE_PER_MESSAGE) break;
    if (seenEmails.has(email)) continue;
    seenEmails.add(email);
    people.push({ role: "mentioned", emails: [email] });
  }
  for (const phone of mentioned.phones) {
    if (people.length >= MAX_PEOPLE_PER_MESSAGE) break;
    people.push({ role: "mentioned", phones: [phone], allowPersonCreation: false });
  }
  return people;
}
