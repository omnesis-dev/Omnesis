// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLogger,
  resolveAttachmentConfig,
  shouldExtractAttachment,
  resolveEffectiveMimeType,
  buildAttachmentDocument,
  formatAttachmentMarkers,
  deriveAttachmentStableId,
  assignAttachmentSeqs,
  computeContentHash,
} from "@omnesis/core";
import { SourceId, ProviderId, isTransientSyncError } from "@omnesis/types";
import { unavailableStorePage } from "./store-unavailable.js";
import { parseAttributedBody } from "./imessage-attributed-body.js";
import { IMessageTranscriptCache } from "./imessage-transcript-cache.js";
import {
  imessageDateToDate,
  isoToImessageNs,
  formatDateKey,
  getTapbackLabel,
  isTapback,
  isTapbackRemoval,
  normalizeDayChat,
} from "./imessage-normalizer.js";
import { validateAppleIMessageSyncCursor } from "./imessage-types.js";
import { throwOnOpenFailure } from "./db-helpers/internal.js";
import type {
  AttachmentInfo,
  AttachmentExtractionConfig,
  AttachmentExtractFn,
  AudioTranscribeFn,
} from "@omnesis/core";
import type { SyncCursor, SyncProgress, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type { AppleProvider } from "./provider.js";
import type {
  AppleIMessageSyncCursor,
  RawIMessage,
  RawIMessageAttachment,
  ParsedIMessage,
  IMessageChatInfo,
} from "./imessage-types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("source:apple-imessage");

const PAGE_SIZE = 500;

// Messages' "Keep Messages" setting (30 Days / 1 Year / Forever, under
// Settings > Messages) prunes chat.db locally and silently once it is set to
// anything but Forever. That preference lives outside chat.db, in a plist
// this source does not read, so it can never tell whether history predating
// this install was already gone before the first sync — or whether more of
// it will vanish between syncs. The honest claim is "unknown", permanently:
// nothing observed at sync time can turn it into "complete".
const IMESSAGE_COVERAGE_DETAIL =
  "Messages can delete old conversations on its own (Settings → Messages → Keep Messages), and Omnesis removes what Messages removes, so older messages may not be here.";

/** Sync progress for a page, carrying the permanent coverage caveat above. */
function imessageProgress(
  phase: SyncProgress["phase"],
  processed: number,
  total?: number,
): SyncProgress {
  return { phase, processed, total, coverage: "unknown", detail: IMESSAGE_COVERAGE_DETAIL };
}

interface IMessageSchemaColumns {
  cacheHasAttachments: boolean;
  associatedMessageEmoji: boolean;
  replyToGuid: boolean;
  threadOriginatorGuid: boolean;
  groupTitle: boolean;
}

interface IMessageDaySnapshot {
  externalIds: string[];
  daySignatures: Record<string, string>;
  signature: string;
}

interface IMessageAttachmentEntry {
  raw: RawIMessageAttachment;
  filename: string;
  mimeType: string;
}

export interface AppleIMessageSourceOptions {
  sourceId: string;
  providerId: string;
  dataCutoff?: string;
  attachmentConfig?: AttachmentExtractionConfig;
  extractAttachment?: AttachmentExtractFn;
  /**
   * Injected speech-to-text fn (forwards to the gateway). Wired only when the
   * `stt` feature is on. When present, audio attachments are transcribed and
   * rendered inline in the conversation; when absent, audio keeps the plain
   * `[Audio: filename]` placeholder and no audio bytes are read.
   */
  transcribeAudio?: AudioTranscribeFn;
  /**
   * Collector config dir — the transcript sidecar (`transcripts.db`) is rooted
   * here so re-syncs reuse transcripts instead of re-transcribing. Undefined
   * falls back to an in-memory cache (de-dupes within a run only).
   */
  configDir?: string;
}

/**
 * Expand ~ in file paths to the user's home directory.
 */
function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return homedir() + path.slice(1);
  }
  return path;
}

function resolveAttachmentPath(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("file://")) {
    try {
      return fileURLToPath(path);
    } catch {
      return path;
    }
  }
  const expanded = expandPath(path);
  if (isAbsolute(expanded)) return expanded;
  if (expanded.startsWith("Library/Messages/Attachments/")) {
    return join(homedir(), expanded);
  }
  return expanded;
}

function attachmentFileSignature(path: string | null): string {
  const resolved = resolveAttachmentPath(path);
  if (!resolved) return "no-path";
  try {
    const stat = statSync(resolved);
    return `file:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/**
 * Apple iMessage source.
 * Reads from ~/Library/Messages/chat.db and produces per-day-per-chat documents.
 *
 * Incremental pulls are ROWID-based, but iMessage rows are mutable and deletes
 * are physical. The source therefore also builds a full day-key snapshot at
 * the end of each cycle: the gateway prunes missing IDs, and days whose
 * content signature changed without a new ROWID are re-emitted.
 */
export class AppleIMessageSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;

  readonly watchPaths: string[];

  /** Optional ISO 8601 cutoff — messages sent before this date are excluded. */
  readonly dataCutoff?: string;

  private attachmentConfig: AttachmentExtractionConfig;
  private extractAttachment?: AttachmentExtractFn;
  private transcribeAudio?: AudioTranscribeFn;
  private configDir?: string;
  /** Lazily opened on first audio transcription, so a no-audio sync opens no DB. */
  private transcriptCache?: IMessageTranscriptCache;
  private schemaColumns?: IMessageSchemaColumns;
  private schemaColumnsDb?: Db;

  constructor(
    private provider: AppleProvider,
    opts: AppleIMessageSourceOptions,
  ) {
    this.id = SourceId(opts.sourceId);
    this.providerId = ProviderId(opts.providerId);
    const dbPath = provider.imessageDbFilePath;
    this.watchPaths = [dbPath, `${dbPath}-wal`];
    this.dataCutoff = opts.dataCutoff;
    this.attachmentConfig = opts.attachmentConfig ?? resolveAttachmentConfig();
    this.extractAttachment = opts.extractAttachment;
    this.transcribeAudio = opts.transcribeAudio;
    this.configDir = opts.configDir;
  }

  async sync(cursor: SyncCursor | null): Promise<SyncResult> {
    const db = this.provider.getIMessageDb();
    if (!db) {
      throwOnOpenFailure(this.provider.getIMessageOpenFailure());
      return unavailableStorePage(cursor ?? { lastRowId: 0 });
    }

    let state: AppleIMessageSyncCursor | null = validateAppleIMessageSyncCursor(cursor);
    const maxMessageRowId = getMaxMessageRowId(db);
    if (state && state.lastRowId > maxMessageRowId) {
      log.warn(
        `iMessage ROWID watermark ${state.lastRowId} exceeds database max ${maxMessageRowId} — re-bootstrapping`,
      );
      state = null;
    }
    const lastRowId = state?.lastRowId ?? 0;
    const isBootstrap = lastRowId === 0;

    // Convert dataCutoff to iMessage nanosecond timestamp for filtering
    const cutoffNs = this.dataCutoff ? isoToImessageNs(this.dataCutoff) : null;

    // At bootstrap with a cutoff, jump only to the row immediately before the
    // earliest post-cutoff message. This is safe even when ROWID and message
    // date are not monotonic (backup restores can append old messages with
    // high ROWIDs). If no post-cutoff messages exist, jump to the current tail.
    let effectiveLastRowId = lastRowId;
    if (lastRowId === 0 && cutoffNs !== null) {
      const row = db
        .prepare(
          `SELECT MIN(CASE WHEN date >= ? THEN ROWID END) as minRecentRowId,
                  COALESCE(MAX(ROWID), 0) as maxRowId
             FROM message`,
        )
        .get(cutoffNs) as { minRecentRowId: number | null; maxRowId: number };
      effectiveLastRowId =
        row.minRecentRowId === null ? row.maxRowId : Math.max(0, row.minRecentRowId - 1);
      if (effectiveLastRowId > 0) {
        log.debug(`Cutoff bump: safely skipping ROWIDs 1..${effectiveLastRowId}`);
      }
    }

    // Fetch new messages since last sync (no date filter — the bump above
    // handles the bulk skip; the post-fetch affectedDays filter catches
    // any anomalous high-ROWID-old-date rows from a backup restore).
    const rows = this.fetchMessageRows(db, "WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?", [
      effectiveLastRowId,
      PAGE_SIZE + 1,
    ]);

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    if (pageRows.length === 0) {
      const documents: DocumentInput[] = [];
      const emittedDayKeys = new Set<string>();
      const newSnapshot = this.buildIMessageSnapshot(db, cutoffNs);
      let presentExternalIds: string[] | undefined;
      let snapshotSignature = state?.lastSnapshotSignature;
      let daySignatures = state?.lastDaySignatures;
      if (newSnapshot.signature !== state?.lastSnapshotSignature) {
        presentExternalIds = newSnapshot.externalIds;
        snapshotSignature = newSnapshot.signature;
        documents.push(
          ...(await this.rebuildChangedDays(
            db,
            cutoffNs,
            state?.lastDaySignatures,
            newSnapshot.daySignatures,
            emittedDayKeys,
            state !== null && state.lastDaySignatures === undefined,
          )),
        );
        daySignatures = newSnapshot.daySignatures;
      }
      return {
        documents,
        deletedExternalIds: [],
        presentExternalIds,
        issues: [],
        // Persist the cutoff bump so subsequent syncs don't re-scan the
        // pre-cutoff range — once we've jumped past it, we never want
        // to look back.
        cursor: {
          lastRowId: effectiveLastRowId,
          lastSnapshotSignature: snapshotSignature,
          lastDaySignatures: daySignatures,
        } satisfies AppleIMessageSyncCursor,
        hasMore: false,
        progress: imessageProgress(isBootstrap ? "bootstrap" : "incremental", 0),
      };
    }

    const maxRowId = pageRows[pageRows.length - 1].rowId;

    // Fetch attachments from the join table for every page row. The
    // `cache_has_attachments` flag is a cache hint and can lag reality.
    const attachmentMap = this.fetchAttachmentsForMessages(
      db,
      pageRows.map((r) => r.rowId),
    );

    // Parse raw rows into ParsedIMessage
    const parsed: ParsedIMessage[] = [];
    for (const row of pageRows) {
      // Skip messages without a chat (orphaned)
      if (!row.chatIdentifier) continue;

      // Extract text
      let text = row.text ?? "";
      if (!text && row.attributedBody) {
        text = parseAttributedBody(row.attributedBody) ?? "";
      }

      const date = imessageDateToDate(row.date);
      const sender = row.isFromMe ? "You" : (row.contactId ?? "Unknown");

      // Build attachment info
      const attachments = (attachmentMap.get(row.rowId) ?? []).map((a) => ({
        guid: a.guid ?? undefined,
        filename: a.transferName ?? a.filename?.split("/").pop() ?? "attachment",
        mimeType: a.mimeType,
        filePath: a.filename,
        totalBytes: a.totalBytes,
      }));

      // Check if this is a tapback
      let tapback: ParsedIMessage["tapback"];
      if (
        (isTapback(row.associatedMessageType) || isTapbackRemoval(row.associatedMessageType)) &&
        row.associatedMessageGuid
      ) {
        // Extract the target message guid from associated_message_guid
        // Format is "p:0/GUID" or "bp:GUID" — extract the GUID part
        const targetGuid = row.associatedMessageGuid.replace(/^(p:\d+\/|bp:)/, "");
        const label = getTapbackLabel(row.associatedMessageType, row.associatedMessageEmoji);
        if (label) {
          tapback = {
            type: label,
            targetGuid,
            emoji: row.associatedMessageEmoji ?? undefined,
            action: isTapbackRemoval(row.associatedMessageType) ? "remove" : "add",
          };
        }
      }

      parsed.push({
        rowId: row.rowId,
        guid: row.guid,
        text,
        date,
        isFromMe: !!row.isFromMe,
        isSystemMessage: !!row.isSystemMessage,
        sender,
        service: row.service ?? "iMessage",
        attachments,
        tapback,
        replyToGuid: row.replyToGuid ?? undefined,
        threadOriginatorGuid: row.threadOriginatorGuid ?? undefined,
        contactId: row.contactId ?? undefined,
      });
    }

    // Group by affected parent day-doc. Ordinary messages affect their own
    // day; tapback add/remove rows affect the day of their target message,
    // which may be different from the reaction row's timestamp.
    const affectedDays = new Map<
      string,
      { chatIdentifier: string; date: string; chatInfo: IMessageChatInfo }
    >();
    // Group rosters are reused across every day of the same chat in a page;
    // memoise per chat so the roster lookup runs once per chat, not per day.
    const rosterCache = new Map<string, string[]>();

    for (const row of pageRows) {
      if (!row.chatIdentifier) continue;
      const affected = this.resolveAffectedDayForRow(db, row, cutoffNs, rosterCache);
      if (!affected) continue;
      if (!affectedDays.has(affected.key)) {
        affectedDays.set(affected.key, {
          chatIdentifier: affected.chatIdentifier,
          date: affected.date,
          chatInfo: affected.chatInfo,
        });
      }
    }

    // For each affected day+chat, get all renderable messages for that day
    // plus every tapback row targeting those messages, then rebuild the full
    // parent document and attachment child docs.
    const documents: DocumentInput[] = [];
    const emittedDayKeys = new Set<string>();
    for (const [key, { chatIdentifier, date, chatInfo }] of affectedDays) {
      documents.push(
        ...(await this.buildDayDocuments(db, chatIdentifier, date, chatInfo, cutoffNs)),
      );
      emittedDayKeys.add(key);
    }

    // Queue size for this cycle: messages with ROWID > cursor at cycle
    // start. Pinned in cursor across pages so the progress bar's `total`
    // stays stable. Bootstrap counts everything (queue = all messages);
    // incremental counts just the rows added since last cursor.
    let totalMessages: number | undefined = state?.cycleQueueTotal;
    if (totalMessages === undefined) {
      try {
        if (cutoffNs !== null) {
          const countRow = db
            .prepare("SELECT COUNT(*) as count FROM message WHERE ROWID > ? AND date >= ?")
            .get(lastRowId, cutoffNs) as { count: number };
          totalMessages = countRow.count;
        } else {
          const countRow = db
            .prepare("SELECT COUNT(*) as count FROM message WHERE ROWID > ?")
            .get(lastRowId) as { count: number };
          totalMessages = countRow.count;
        }
      } catch {
        // ignore
      }
    }

    // Snapshot reconciliation: when the cursor has caught up to the tail,
    // enumerate the complete current source ID set (parent day docs AND
    // attachment child docs). The same scan computes per-day content
    // signatures; if a day changed without a new ROWID (edit, unsend,
    // tapback removal, local attachment file arrival), re-emit just that day.
    let presentExternalIds: string[] | undefined;
    let snapshotSignature = state?.lastSnapshotSignature;
    let daySignatures = state?.lastDaySignatures;
    if (!hasMore) {
      const newSnapshot = this.buildIMessageSnapshot(db, cutoffNs);
      if (newSnapshot.signature !== state?.lastSnapshotSignature) {
        presentExternalIds = newSnapshot.externalIds;
        snapshotSignature = newSnapshot.signature;
        documents.push(
          ...(await this.rebuildChangedDays(
            db,
            cutoffNs,
            state?.lastDaySignatures,
            newSnapshot.daySignatures,
            emittedDayKeys,
            state !== null && state.lastDaySignatures === undefined,
          )),
        );
        daySignatures = newSnapshot.daySignatures;
      }
    }

    log.info(
      `Sync produced ${documents.length} docs from ${pageRows.length} messages (${isBootstrap ? "bootstrap" : "incremental"}, hasMore: ${hasMore}, snapshot: ${presentExternalIds?.length ?? "unchanged"})`,
    );

    return {
      documents,
      deletedExternalIds: [], // iMessage hard-deletes rows; snapshot path catches them gateway-side
      presentExternalIds,
      issues: hasMore ? undefined : [],
      cursor: {
        lastRowId: maxRowId,
        cycleQueueTotal: hasMore ? totalMessages : undefined,
        lastSnapshotSignature: snapshotSignature,
        lastDaySignatures: daySignatures,
      } satisfies AppleIMessageSyncCursor,
      hasMore,
      progress: imessageProgress(
        isBootstrap ? "bootstrap" : "incremental",
        parsed.length,
        totalMessages !== undefined && totalMessages > 0 ? totalMessages : undefined,
      ),
    };
  }

  /**
   * Fetch the participant roster (handle id strings — phones/emails) for a
   * chat, keyed by `chat.chat_identifier`, memoised per sync run via
   * `cache`. Lists every member of a group chat as a participant, including
   * those who sent nothing that day. Self is naturally excluded — `handle`
   * rows are the other parties; the local account is `message.is_from_me`,
   * never a handle row. Ordered for a deterministic participant list.
   */
  private fetchChatRoster(db: Db, chatIdentifier: string, cache: Map<string, string[]>): string[] {
    const cached = cache.get(chatIdentifier);
    if (cached) return cached;
    const rows = db
      .prepare(
        `SELECT DISTINCT h.id as handle
           FROM chat c
           JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
           JOIN handle h ON h.ROWID = chj.handle_id
          WHERE c.chat_identifier = ? AND h.id IS NOT NULL
          ORDER BY h.id ASC`,
      )
      .all(chatIdentifier) as { handle: string }[];
    const handles = rows.map((r) => r.handle).filter((h) => h.length > 0);
    cache.set(chatIdentifier, handles);
    return handles;
  }

  private getSchemaColumns(db: Db): IMessageSchemaColumns {
    if (this.schemaColumns && this.schemaColumnsDb === db) return this.schemaColumns;
    const rows = db.prepare("PRAGMA table_info(message)").all() as { name: string }[];
    const names = new Set(rows.map((r) => r.name));
    this.schemaColumns = {
      cacheHasAttachments: names.has("cache_has_attachments"),
      associatedMessageEmoji: names.has("associated_message_emoji"),
      replyToGuid: names.has("reply_to_guid"),
      threadOriginatorGuid: names.has("thread_originator_guid"),
      groupTitle: names.has("group_title"),
    };
    this.schemaColumnsDb = db;
    return this.schemaColumns;
  }

  private fetchMessageRows(
    db: Db,
    whereClause: string,
    params: ReadonlyArray<number | string>,
  ): RawIMessage[] {
    const columns = this.getSchemaColumns(db);
    const sql = `SELECT
        m.ROWID as rowId,
        m.guid,
        m.text,
        m.attributedBody,
        m.date,
        m.is_from_me as isFromMe,
        m.is_system_message as isSystemMessage,
        m.handle_id as handleId,
        m.service,
        ${
          columns.cacheHasAttachments
            ? "m.cache_has_attachments"
            : "EXISTS (SELECT 1 FROM message_attachment_join maj2 WHERE maj2.message_id = m.ROWID)"
        } as cacheHasAttachments,
        m.associated_message_guid as associatedMessageGuid,
        m.associated_message_type as associatedMessageType,
        ${
          columns.associatedMessageEmoji ? "m.associated_message_emoji" : "NULL"
        } as associatedMessageEmoji,
        ${columns.replyToGuid ? "m.reply_to_guid" : "NULL"} as replyToGuid,
        ${
          columns.threadOriginatorGuid ? "m.thread_originator_guid" : "NULL"
        } as threadOriginatorGuid,
        ${columns.groupTitle ? "m.group_title" : "NULL"} as groupTitle,
        c.chat_identifier as chatIdentifier,
        c.display_name as chatDisplayName,
        c.style as chatStyle,
        COALESCE(hc.handleCount, 0) as chatHandleCount,
        h.id as contactId
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat c ON cmj.chat_id = c.ROWID
      LEFT JOIN (
        SELECT chat_id, COUNT(DISTINCT handle_id) AS handleCount
        FROM chat_handle_join
        GROUP BY chat_id
      ) hc ON hc.chat_id = c.ROWID
      ${whereClause}`;
    return db.prepare(sql).all(...params) as RawIMessage[];
  }

  /**
   * Fetch attachment rows for a batch of message ROWIDs and group them by
   * `messageRowId`. Returns an empty map when `rowIds` is empty (avoids
   * binding an empty IN list).
   */
  private fetchAttachmentsForMessages(
    db: Db,
    rowIds: ReadonlyArray<number>,
  ): Map<number, RawIMessageAttachment[]> {
    const result = new Map<number, RawIMessageAttachment[]>();
    if (rowIds.length === 0) return result;
    for (let offset = 0; offset < rowIds.length; offset += PAGE_SIZE) {
      const batch = rowIds.slice(offset, offset + PAGE_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      const attRows = db
        .prepare(
          `SELECT
             a.ROWID as attachmentRowId,
             a.guid as guid,
             maj.message_id as messageRowId,
             a.filename,
             a.mime_type as mimeType,
             a.transfer_name as transferName,
             a.total_bytes as totalBytes
           FROM message_attachment_join maj
           JOIN attachment a ON maj.attachment_id = a.ROWID
           WHERE maj.message_id IN (${placeholders})
           ORDER BY maj.message_id ASC, a.ROWID ASC`,
        )
        .all(...batch) as RawIMessageAttachment[];
      for (const att of attRows) {
        if (!result.has(att.messageRowId)) result.set(att.messageRowId, []);
        result.get(att.messageRowId)!.push(att);
      }
    }
    return result;
  }

  private resolveAffectedDayForRow(
    db: Db,
    row: RawIMessage,
    cutoffNs: number | null,
    rosterCache: Map<string, string[]>,
  ): { key: string; chatIdentifier: string; date: string; chatInfo: IMessageChatInfo } | null {
    let docRow = row;
    if (isTapback(row.associatedMessageType) || isTapbackRemoval(row.associatedMessageType)) {
      const targetGuid = normalizeAssociatedMessageGuid(row.associatedMessageGuid);
      if (!targetGuid) return null;
      const targetRows = this.fetchMessageRows(
        db,
        "WHERE m.guid = ? AND c.chat_identifier IS NOT NULL LIMIT 1",
        [targetGuid],
      );
      const target = targetRows[0];
      if (!target || !isRenderableMessageRow(target)) return null;
      docRow = target;
    }

    if (cutoffNs !== null && docRow.date < cutoffNs) return null;

    const date = formatDateKey(imessageDateToDate(docRow.date));
    const key = `${docRow.chatIdentifier}:${date}`;
    return {
      key,
      chatIdentifier: docRow.chatIdentifier,
      date,
      chatInfo: this.chatInfoFromRow(db, docRow, rosterCache),
    };
  }

  private chatInfoFromRow(
    db: Db,
    row: RawIMessage,
    rosterCache: Map<string, string[]>,
  ): IMessageChatInfo {
    // Derive isGroup from `COUNT(DISTINCT handle_id)` rather than chat.style —
    // Apple's style constants flipped meaning across macOS versions.
    const isGroup = row.chatHandleCount > 1;
    return {
      chatIdentifier: row.chatIdentifier,
      displayName: row.chatDisplayName,
      isGroup,
      service: row.service ?? "iMessage",
      participantHandles: isGroup
        ? this.fetchChatRoster(db, row.chatIdentifier, rosterCache)
        : undefined,
    };
  }

  private async buildDayDocuments(
    db: Db,
    chatIdentifier: string,
    date: string,
    chatInfo: IMessageChatInfo | null,
    cutoffNs: number | null,
  ): Promise<DocumentInput[]> {
    const rosterCache = new Map<string, string[]>();
    const { rows, attMap } = this.fetchRenderableRowsForDay(db, chatIdentifier, date, cutoffNs);
    if (rows.length === 0) return [];

    const info = chatInfo ?? this.chatInfoFromRow(db, rows[0], rosterCache);
    const tapbackRows = this.fetchTapbacksForTargets(
      db,
      chatIdentifier,
      rows.map((r) => r.guid),
    );
    const dayParsed = [...rows, ...tapbackRows]
      .map((row) => this.parseMessageRow(row, attMap))
      .filter((msg): msg is ParsedIMessage => msg !== null);

    if (dayParsed.length === 0) return [];

    // Transcribe voice clips inline before rendering, so the spoken text lands
    // in the conversation document and is searchable.
    await this.transcribeDayAudio(dayParsed);

    const doc = normalizeDayChat(date, dayParsed, info, this.providerId, this.id);
    const attachmentDocs = await this.extractAttachments(doc, dayParsed, attMap);
    return [doc, ...attachmentDocs];
  }

  private fetchRenderableRowsForDay(
    db: Db,
    chatIdentifier: string,
    date: string,
    cutoffNs: number | null,
  ): { rows: RawIMessage[]; attMap: Map<number, RawIMessageAttachment[]> } {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const dayStartNs = isoToImessageNs(dayStart.toISOString());
    const dayEndNs = isoToImessageNs(dayEnd.toISOString());
    const lowerBound = cutoffNs === null ? dayStartNs : Math.max(dayStartNs, cutoffNs);

    const rows = this.fetchMessageRows(
      db,
      "WHERE c.chat_identifier = ? AND m.date >= ? AND m.date < ? ORDER BY m.ROWID ASC",
      [chatIdentifier, lowerBound, dayEndNs],
    ).filter(isRenderableMessageRow);
    return {
      rows,
      attMap: this.fetchAttachmentsForMessages(
        db,
        rows.map((r) => r.rowId),
      ),
    };
  }

  private fetchTapbacksForTargets(
    db: Db,
    chatIdentifier: string,
    targetGuids: ReadonlyArray<string>,
  ): RawIMessage[] {
    if (targetGuids.length === 0) return [];
    const targetSet = new Set(targetGuids);
    return this.fetchMessageRows(
      db,
      `WHERE c.chat_identifier = ?
         AND (
           (m.associated_message_type >= 2000 AND m.associated_message_type <= 2006)
           OR (m.associated_message_type >= 3000 AND m.associated_message_type <= 3006)
         )
       ORDER BY m.date ASC, m.ROWID ASC`,
      [chatIdentifier],
    ).filter((row) => {
      const targetGuid = normalizeAssociatedMessageGuid(row.associatedMessageGuid);
      return targetGuid !== null && targetSet.has(targetGuid);
    });
  }

  private parseMessageRow(
    row: RawIMessage,
    attMap: Map<number, RawIMessageAttachment[]>,
  ): ParsedIMessage | null {
    if (!row.chatIdentifier) return null;

    let text = row.text ?? "";
    if (!text && row.attributedBody) {
      text = parseAttributedBody(row.attributedBody) ?? "";
    }

    const attachments = (attMap.get(row.rowId) ?? []).map((a) => ({
      guid: a.guid ?? undefined,
      filename: a.transferName ?? a.filename?.split("/").pop() ?? "attachment",
      mimeType: a.mimeType,
      filePath: a.filename,
      totalBytes: a.totalBytes,
    }));

    let tapback: ParsedIMessage["tapback"];
    if (isTapback(row.associatedMessageType) || isTapbackRemoval(row.associatedMessageType)) {
      const targetGuid = normalizeAssociatedMessageGuid(row.associatedMessageGuid);
      const label = getTapbackLabel(row.associatedMessageType, row.associatedMessageEmoji);
      if (targetGuid && label) {
        tapback = {
          type: label,
          targetGuid,
          emoji: row.associatedMessageEmoji ?? undefined,
          action: isTapbackRemoval(row.associatedMessageType) ? "remove" : "add",
        };
      }
    }

    return {
      rowId: row.rowId,
      guid: row.guid,
      text,
      date: imessageDateToDate(row.date),
      isFromMe: !!row.isFromMe,
      isSystemMessage: !!row.isSystemMessage,
      sender: row.isFromMe ? "You" : (row.contactId ?? "Unknown"),
      service: row.service ?? "iMessage",
      attachments,
      tapback,
      replyToGuid: row.replyToGuid ?? undefined,
      threadOriginatorGuid: row.threadOriginatorGuid ?? undefined,
      contactId: row.contactId ?? undefined,
    };
  }

  private buildIMessageSnapshot(db: Db, cutoffNs: number | null): IMessageDaySnapshot {
    const rows = this.fetchMessageRows(
      db,
      "WHERE c.chat_identifier IS NOT NULL ORDER BY c.chat_identifier ASC, m.date ASC, m.ROWID ASC",
      [],
    );
    const renderableRows = rows.filter(
      (row) => isRenderableMessageRow(row) && (cutoffNs === null || row.date >= cutoffNs),
    );
    const rowsByGuid = new Map(renderableRows.map((row) => [row.guid, row]));
    const dayParts = new Map<string, string[]>();
    const dayRows = new Map<string, RawIMessage[]>();
    const rosterCache = new Map<string, string[]>();

    for (const row of renderableRows) {
      const key = dayKeyForRow(row);
      const parts = dayParts.get(key) ?? [];
      parts.push(messageSignaturePart(row));
      const info = this.chatInfoFromRow(db, row, rosterCache);
      if (info.participantHandles) {
        parts.push(`roster:${info.participantHandles.join("\u0000")}`);
      }
      dayParts.set(key, parts);

      const groupedRows = dayRows.get(key) ?? [];
      groupedRows.push(row);
      dayRows.set(key, groupedRows);
    }

    for (const row of rows) {
      if (!isTapback(row.associatedMessageType) && !isTapbackRemoval(row.associatedMessageType)) {
        continue;
      }
      const targetGuid = normalizeAssociatedMessageGuid(row.associatedMessageGuid);
      if (!targetGuid) continue;
      const target = rowsByGuid.get(targetGuid);
      if (!target) continue;
      const key = dayKeyForRow(target);
      const parts = dayParts.get(key) ?? [];
      parts.push(tapbackSignaturePart(row));
      dayParts.set(key, parts);
    }

    const attMap = this.fetchAttachmentsForMessages(
      db,
      renderableRows.map((row) => row.rowId),
    );
    for (const [key, groupedRows] of dayRows) {
      const parts = dayParts.get(key) ?? [];
      for (const row of groupedRows) {
        for (const att of attMap.get(row.rowId) ?? []) {
          parts.push(attachmentSignaturePart(att));
        }
      }
      dayParts.set(key, parts);
    }

    const daySignatures: Record<string, string> = {};
    const externalIds: string[] = [];
    for (const [key, parts] of Array.from(dayParts.entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      daySignatures[key] = computeContentHash(parts.sort().join("\n"));
      externalIds.push(key);
      if (this.attachmentConfig.enabled && this.extractAttachment) {
        externalIds.push(
          ...this.enumerateAttachmentExternalIdsForDay(key, dayRows.get(key) ?? [], attMap),
        );
      }
    }
    externalIds.sort();
    const signature = computeContentHash(
      Object.entries(daySignatures)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, sig]) => `${key}\u0000${sig}`)
        .join("\n") + `\nids\n${externalIds.join("\n")}`,
    );

    return { externalIds, daySignatures, signature };
  }

  private async rebuildChangedDays(
    db: Db,
    cutoffNs: number | null,
    previous: Record<string, string> | undefined,
    current: Record<string, string>,
    alreadyEmitted: Set<string>,
    rebuildAllWhenPreviousMissing = false,
  ): Promise<DocumentInput[]> {
    if (!previous && !rebuildAllWhenPreviousMissing) return [];
    const documents: DocumentInput[] = [];
    for (const [key, signature] of Object.entries(current)) {
      if (alreadyEmitted.has(key)) continue;
      if (previous?.[key] === signature) continue;
      const parsed = parseDayExternalId(key);
      if (!parsed) continue;
      documents.push(
        ...(await this.buildDayDocuments(db, parsed.chatIdentifier, parsed.date, null, cutoffNs)),
      );
      alreadyEmitted.add(key);
    }
    return documents;
  }

  private enumerateAttachmentExternalIdsForDay(
    parentExternalId: string,
    rows: ReadonlyArray<RawIMessage>,
    attMap: Map<number, RawIMessageAttachment[]>,
  ): string[] {
    const entries = this.collectEligibleAttachmentEntries(rows, attMap);
    return assignAttachmentSeqs(
      entries,
      (entry) => ({
        filename: entry.filename,
        sizeBytes: entry.raw.totalBytes,
        mimeType: entry.mimeType,
      }),
      (entry) => `${entry.raw.guid ?? ""}:${entry.raw.attachmentRowId}`,
    ).map(({ item, seq }) => {
      const stableId = deriveAttachmentStableId(
        item.filename,
        item.raw.totalBytes,
        item.mimeType,
        seq,
      );
      return `${parentExternalId}/att/${stableId}`;
    });
  }

  private collectEligibleAttachmentEntries(
    rows: ReadonlyArray<RawIMessage>,
    attMap: Map<number, RawIMessageAttachment[]>,
  ): IMessageAttachmentEntry[] {
    const entries: IMessageAttachmentEntry[] = [];
    for (const row of rows) {
      const parsed = this.parseMessageRow(row, attMap);
      if (!parsed || parsed.tapback) continue;
      for (const raw of attMap.get(row.rowId) ?? []) {
        const filename = raw.transferName ?? raw.filename?.split("/").pop() ?? "attachment";
        const mimeType = resolveEffectiveMimeType(filename, raw.mimeType);
        if (!mimeType) continue;
        const check = shouldExtractAttachment(mimeType, raw.totalBytes, this.attachmentConfig);
        if (!check.extract) continue;
        entries.push({ raw, filename, mimeType });
      }
    }
    return entries;
  }

  /**
   * Transcribe the audio attachments in a day-chat, setting `transcript` and
   * `durationSec` in place on each `IMessageAttachmentInfo` so the normalizer
   * renders the spoken text inline. A no-op when no transcriber is wired (STT
   * off) — audio then keeps its `[Audio: filename]` placeholder.
   *
   * The transcript sidecar (`transcripts.db` under configDir) is consulted
   * first so a re-sync of the same day reuses prior transcripts rather than
   * re-running Whisper. A `null` from the transcriber (unavailable / failed /
   * no bytes) leaves the attachment untranscribed so a later sync retries.
   */
  private async transcribeDayAudio(dayParsed: ParsedIMessage[]): Promise<void> {
    if (!this.transcribeAudio) return;

    for (const msg of dayParsed) {
      if (msg.tapback) continue;
      for (const att of msg.attachments) {
        const mimeType = att.mimeType;
        if (!mimeType || !mimeType.startsWith("audio/")) continue;
        if (att.transcript !== undefined) continue; // already set this run
        if (!att.filePath) continue;

        const filePath = resolveAttachmentPath(att.filePath);
        if (!filePath || !existsSync(filePath)) {
          if (filePath)
            log.debug(`Audio attachment file not found, skipping transcription: ${filePath}`);
          continue;
        }

        let mtimeMs: number | undefined;
        try {
          mtimeMs = statSync(filePath).mtimeMs;
        } catch {
          // The read below will surface the real failure if the file vanished.
        }

        // Key by Apple attachment GUID when possible, falling back to the
        // historical file-path key so older transcript sidecars still hit.
        const cache = this.getTranscriptCache();
        const cacheKey = att.guid ?? att.filePath;
        const legacyKey = att.guid && att.filePath ? att.filePath : undefined;
        const cached =
          (cacheKey ? cache.get(cacheKey, att.totalBytes, mtimeMs) : undefined) ??
          (legacyKey ? cache.get(legacyKey, att.totalBytes, mtimeMs) : undefined);
        if (cached) {
          att.transcript = cached.transcript;
          att.durationSec = cached.durationSec;
          if (cacheKey && legacyKey) {
            cache.set(cacheKey, att.totalBytes, mtimeMs, cached);
          }
          continue;
        }

        try {
          const data = new Uint8Array(await readFile(filePath));
          const result = await this.transcribeAudio(data, mimeType);
          // `null` = transcription unavailable/failed → leave unset to retry.
          if (result === null) continue;
          const transcript = result.text.trim();
          att.transcript = transcript;
          att.durationSec = result.durationSec;
          // `""` (no speech detected) is a valid cached value and isn't retried.
          if (cacheKey) {
            cache.set(cacheKey, att.totalBytes, mtimeMs, {
              transcript,
              durationSec: result.durationSec,
            });
          }
        } catch (err) {
          // A transient transcription-backend blip (gateway unreachable / 5xx)
          // fails the page so it retries — don't leave it unset as if the note
          // were permanently untranscribable and advance the cursor.
          if (isTransientSyncError(err)) throw err;
          log.debug(
            `Failed to transcribe audio ${att.filename}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  /** Lazily open the transcript sidecar on first use. */
  private getTranscriptCache(): IMessageTranscriptCache {
    if (!this.transcriptCache) {
      this.transcriptCache = new IMessageTranscriptCache(this.configDir);
    }
    return this.transcriptCache;
  }

  /** Close the transcript sidecar. Called by the source instance's dispose. */
  dispose(): void {
    this.transcriptCache?.close();
    this.transcriptCache = undefined;
  }

  /**
   * Extract text from supported attachments in a day-chat's messages.
   * Mutates the parent doc to add attachment markers and metadata.
   * Returns an array of attachment DocumentInputs.
   */
  private async extractAttachments(
    parentDoc: DocumentInput,
    dayParsed: ParsedIMessage[],
    dayAttMap: Map<number, RawIMessageAttachment[]>,
  ): Promise<DocumentInput[]> {
    if (!this.attachmentConfig.enabled || !this.extractAttachment) {
      return [];
    }

    const attachmentInfos: AttachmentInfo[] = [];
    const attachmentDocs: DocumentInput[] = [];
    const eligibleEntries: IMessageAttachmentEntry[] = [];
    for (const msg of dayParsed) {
      if (msg.tapback) continue;
      for (const raw of dayAttMap.get(msg.rowId) ?? []) {
        const filename = raw.transferName ?? raw.filename?.split("/").pop() ?? "attachment";
        const mimeType = resolveEffectiveMimeType(filename, raw.mimeType);
        if (!mimeType) continue;
        const check = shouldExtractAttachment(mimeType, raw.totalBytes, this.attachmentConfig);
        if (!check.extract) continue;
        eligibleEntries.push({ raw, filename, mimeType });
      }
    }
    const seqByAttachmentRowId = new Map<number, number>();
    for (const { item, seq } of assignAttachmentSeqs(
      eligibleEntries,
      (entry) => ({
        filename: entry.filename,
        sizeBytes: entry.raw.totalBytes,
        mimeType: entry.mimeType,
      }),
      (entry) => `${entry.raw.guid ?? ""}:${entry.raw.attachmentRowId}`,
    )) {
      seqByAttachmentRowId.set(item.raw.attachmentRowId, seq);
    }

    for (const msg of dayParsed) {
      if (msg.tapback) continue;
      const rawAtts = dayAttMap.get(msg.rowId) ?? [];

      for (const att of rawAtts) {
        const filename = att.transferName ?? att.filename?.split("/").pop() ?? "attachment";
        // Recover the real type when the DB has a generic/empty MIME for a
        // recognizable extension (e.g. a .pkpass stored as octet-stream).
        const mimeType = resolveEffectiveMimeType(filename, att.mimeType);

        if (!mimeType) {
          attachmentInfos.push({
            filename,
            mimeType: mimeType ?? "unknown",
            size: att.totalBytes,
            extracted: false,
            reason: "type-excluded",
          });
          continue;
        }

        const check = shouldExtractAttachment(mimeType, att.totalBytes, this.attachmentConfig);
        if (!check.extract) {
          attachmentInfos.push({
            filename,
            mimeType,
            size: att.totalBytes,
            extracted: false,
            reason: check.reason,
          });
          continue;
        }

        // Resolve file path
        if (!att.filename) {
          attachmentInfos.push({
            filename,
            mimeType,
            size: att.totalBytes,
            extracted: false,
            reason: "download-failed",
          });
          continue;
        }

        const filePath = resolveAttachmentPath(att.filename);
        if (!filePath) {
          attachmentInfos.push({
            filename,
            mimeType,
            size: att.totalBytes,
            extracted: false,
            reason: "download-failed",
          });
          continue;
        }
        if (!existsSync(filePath)) {
          log.debug(`Attachment file not found: ${filePath}`);
          attachmentInfos.push({
            filename,
            mimeType,
            size: att.totalBytes,
            extracted: false,
            reason: "download-failed",
          });
          continue;
        }

        try {
          const data = new Uint8Array(await readFile(filePath));
          const result = await this.extractAttachment(data, mimeType, {
            maxTextLength: this.attachmentConfig.maxTextLength,
          });
          if (!result) {
            attachmentInfos.push({
              filename,
              mimeType,
              size: att.totalBytes,
              extracted: false,
              reason: "extraction-failed",
            });
            continue;
          }
          if (result.noText) {
            attachmentInfos.push({
              filename,
              mimeType,
              size: att.totalBytes,
              extracted: false,
              reason: "no-text",
            });
            continue;
          }

          const seq = seqByAttachmentRowId.get(att.attachmentRowId) ?? 0;
          const attDoc = buildAttachmentDocument(parentDoc, filename, result, {
            mimeType,
            sizeBytes: att.totalBytes,
            seq,
            // The parent is a whole day of chat, so its timestamps bound the
            // day rather than dating this file. Stamp the message that carried
            // it, or every attachment sent that day sorts as if it arrived
            // with the first message.
            occurredAt: msg.date.toISOString(),
          });
          attachmentDocs.push(attDoc);
          attachmentInfos.push({ filename, mimeType, size: att.totalBytes, extracted: true });
        } catch (err) {
          // Transient extraction-backend blip → fail the page so it retries,
          // rather than recording a permanent extraction failure and advancing
          // the cursor past a file that would extract cleanly later.
          if (isTransientSyncError(err)) throw err;
          log.debug(
            `Failed to extract attachment ${filename}: ${err instanceof Error ? err.message : String(err)}`,
          );
          attachmentInfos.push({
            filename,
            mimeType,
            size: att.totalBytes,
            extracted: false,
            reason: "extraction-failed",
          });
        }
      }
    }

    if (attachmentInfos.length > 0) {
      parentDoc.content += formatAttachmentMarkers(attachmentInfos);
      parentDoc.metadata.extra = { ...parentDoc.metadata.extra, attachments: attachmentInfos };
    }

    return attachmentDocs;
  }
}

function getMaxMessageRowId(db: Db): number {
  try {
    const row = db.prepare("SELECT COALESCE(MAX(ROWID), 0) as maxRowId FROM message").get() as {
      maxRowId: number;
    };
    return row.maxRowId;
  } catch {
    return 0;
  }
}

function normalizeAssociatedMessageGuid(guid: string | null): string | null {
  if (!guid) return null;
  return guid.replace(/^(p:\d+\/|bp:)/, "");
}

function isRenderableMessageRow(row: RawIMessage): boolean {
  return !isTapback(row.associatedMessageType) && !isTapbackRemoval(row.associatedMessageType);
}

function dayKeyForRow(row: RawIMessage): string {
  return `${row.chatIdentifier}:${formatDateKey(imessageDateToDate(row.date))}`;
}

function messageSignaturePart(row: RawIMessage): string {
  const attributed =
    row.attributedBody && row.attributedBody.byteLength > 0
      ? computeContentHash(Buffer.from(row.attributedBody).toString("base64"))
      : "";
  return [
    "msg",
    row.rowId,
    row.guid,
    row.date,
    row.isFromMe,
    row.isSystemMessage,
    row.handleId,
    row.service ?? "",
    row.text ?? "",
    attributed,
    row.replyToGuid ?? "",
    row.threadOriginatorGuid ?? "",
    row.groupTitle ?? "",
    row.chatDisplayName ?? "",
    row.chatHandleCount,
    row.contactId ?? "",
  ].join("\u0000");
}

function tapbackSignaturePart(row: RawIMessage): string {
  return [
    "tapback",
    row.rowId,
    row.guid,
    row.date,
    row.isFromMe,
    row.handleId,
    row.associatedMessageGuid ?? "",
    row.associatedMessageType,
    row.associatedMessageEmoji ?? "",
    row.contactId ?? "",
  ].join("\u0000");
}

function attachmentSignaturePart(att: RawIMessageAttachment): string {
  return [
    "att",
    att.messageRowId,
    att.attachmentRowId,
    att.guid ?? "",
    att.filename ?? "",
    att.mimeType ?? "",
    att.transferName ?? "",
    att.totalBytes,
    attachmentFileSignature(att.filename),
  ].join("\u0000");
}

function parseDayExternalId(externalId: string): { chatIdentifier: string; date: string } | null {
  const date = externalId.slice(-10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const sep = externalId.slice(-11, -10);
  if (sep !== ":") return null;
  return { chatIdentifier: externalId.slice(0, -11), date };
}
