// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `TelegramArchive`: the protected local archive of one Telegram account.
 *
 * `<stateDir>/archive.db` holds every archived message, the chats and users
 * they belong to, the per-chat walk checkpoints, the deletion index, the days
 * waiting to be published, and the attachments already emitted
 * (`docs/telegram-source.md` §5.1). The cursor the host persists is only a
 * position in it, so the archive is what makes a lost cursor cheap.
 *
 * Three rules hold every write together:
 *
 * - A write that changes what a day renders marks that day dirty in the same
 *   transaction, and a write that changes nothing marks nothing, so an
 *   unchanged upstream re-read is a no-op.
 * - A history page and the checkpoint it advances commit together ("persist
 *   before advancing"): an interrupted walk resumes from the last page that
 *   landed, never past one that did not.
 * - The publish queue (`dirty_days`) is acknowledged only by the
 *   gateway-confirmed `committedSeq` the next drain is handed, WhatsApp's
 *   `emit_seq` protocol (`packages/providers/whatsapp/src/message-store.ts`).
 *
 * Messages are never garbage-collected; a deleted message keeps its row with
 * `deleted = 1` so a late duplicate cannot resurrect it.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TRANSCRIBER_UNAVAILABLE, createLogger, normalizePhone } from "@omnesis/core";
import { openProtectedDatabase, inspectProtectedStore, type Db } from "./protected-store.js";
import { EXTRACT_REVISION } from "./message-extractor.js";
import { RENDER_REVISION } from "./normalizer.js";
import { PENDING_DELETION_TTL_DAYS } from "./limits.js";
import {
  backoffStep,
  downloadRetryDelaySec,
  isProcessableKind,
  type MediaOutcome,
  type MediaState,
} from "./media-retry.js";
import type { ExtractionResult } from "@omnesis/core";
import type { LocalStoreProbeResult } from "@omnesis/source-sdk";
import type {
  ChatKind,
  MessageBox,
  TakeoutScope,
  TgChat,
  TgDialog,
  TgUser,
} from "./client/types.js";
import type { MediaDescriptor, StoredChat, StoredMessage, WalkState } from "./types.js";

const log = createLogger("source:telegram-messages").child("store");

const ARCHIVE_FILE = "archive.db";
const ARCHIVE_LABEL = "Telegram message archive";

const SCHEMA_VERSION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS chats (
  chat_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  username TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_forum INTEGER NOT NULL DEFAULT 0,
  walk_state TEXT NOT NULL DEFAULT 'pending',
  oldest_fetched_id INTEGER,
  newest_seen_id INTEGER NOT NULL DEFAULT 0,
  top_at_enumeration INTEGER NOT NULL DEFAULT 0,
  reconcile_from_id INTEGER,
  last_presence_check_at INTEGER,
  updated_at INTEGER NOT NULL,
  last_message_ts INTEGER NOT NULL DEFAULT 0,
  reconcile_offset_id INTEGER,
  presence_after_id INTEGER,
  outage_floor_id INTEGER,
  topics_listed_at INTEGER
);

CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  username TEXT,
  phone_e164 TEXT,
  is_bot INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  chat_id INTEGER NOT NULL,
  msg_id INTEGER NOT NULL,
  box TEXT NOT NULL,
  ts INTEGER NOT NULL,
  edit_ts INTEGER,
  sender_id INTEGER,
  sender_name TEXT,
  outgoing INTEGER NOT NULL,
  text TEXT NOT NULL,
  reply_to_id INTEGER,
  topic_id INTEGER,
  forward_from TEXT,
  grouped_id TEXT,
  service TEXT,
  media_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  transcript TEXT,
  media_state TEXT,
  media_attempts INTEGER NOT NULL DEFAULT 0,
  media_next_attempt INTEGER,
  media_last_error TEXT,
  extract_rev INTEGER NOT NULL DEFAULT 0,
  media_extract_json TEXT,
  changed_at INTEGER,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS messages_by_chat_ts ON messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS messages_media_retry ON messages(media_state, media_next_attempt);
CREATE UNIQUE INDEX IF NOT EXISTS messages_by_box_id ON messages(box, msg_id);

CREATE TABLE IF NOT EXISTS pending_deletions (
  box TEXT NOT NULL,
  msg_id INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (box, msg_id)
);

CREATE TABLE IF NOT EXISTS dirty_days (
  chat_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  emit_seq INTEGER,
  render_failures INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  PRIMARY KEY (chat_id, date)
);
CREATE INDEX IF NOT EXISTS dirty_days_emit_seq ON dirty_days(emit_seq);

CREATE TABLE IF NOT EXISTS emitted_attachments (
  chat_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  external_id TEXT NOT NULL,
  emit_seq INTEGER NOT NULL,
  retired_seq INTEGER,
  PRIMARY KEY (chat_id, date, external_id)
);

CREATE TABLE IF NOT EXISTS topics (
  chat_id INTEGER NOT NULL,
  topic_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  PRIMARY KEY (chat_id, topic_id)
);
`;

/** Columns later schemas added, for an archive an earlier one created. */
const ADDED_COLUMNS: ReadonlyArray<[table: string, column: string, decl: string]> = [
  ["chats", "last_message_ts", "INTEGER NOT NULL DEFAULT 0"],
  ["chats", "reconcile_offset_id", "INTEGER"],
  ["chats", "presence_after_id", "INTEGER"],
  ["chats", "outage_floor_id", "INTEGER"],
  ["users", "is_deleted", "INTEGER NOT NULL DEFAULT 0"],
  ["messages", "extract_rev", "INTEGER NOT NULL DEFAULT 0"],
  ["emitted_attachments", "retired_seq", "INTEGER"],
  ["messages", "media_extract_json", "TEXT"],
  ["chats", "topics_listed_at", "INTEGER"],
  ["messages", "changed_at", "INTEGER"],
  ["dirty_days", "render_failures", "INTEGER NOT NULL DEFAULT 0"],
  ["dirty_days", "retry_at", "INTEGER"],
];

/** The longest a day whose render keeps failing waits before it is tried again. */
const RENDER_RETRY_MAX_S = 6 * 3600;

/** The media kinds a message is enrolled in the media lifecycle for (`media-retry.ts`). */
const PROCESSABLE_KINDS_SQL = "'voice', 'photo', 'document'";

/** `media_json`'s kind, tolerating a row whose JSON does not parse. */
const MEDIA_KIND_SQL =
  "json_extract(CASE WHEN json_valid(media_json) THEN media_json ELSE '{}' END, '$.kind')";

/**
 * Media a page may attempt: pending, scheduled, surviving, inside the cutoff,
 * and of a kind this source can process right now. Shared by the sweep, the
 * due check, the wake time and the health counts.
 */
const MEDIA_RETRY_ELIGIBILITY = `
  media_state = 'pending' AND media_next_attempt IS NOT NULL AND deleted = 0
  AND (@minTs IS NULL OR ts >= @minTs)
  AND ((@voiceNotes = 1 AND ${MEDIA_KIND_SQL} = 'voice')
    OR (@attachments = 1 AND ${MEDIA_KIND_SQL} IN ('photo', 'document')))`;

/** Which media this source processes; set from what its host offers. */
export interface MediaScope {
  voiceNotes: boolean;
  attachments: boolean;
  /** Unix seconds; older media is never attempted or counted. */
  minTs?: number;
}

/** Media still to process, or gone for good, voice notes apart from attachments. */
export interface MediaHealthStats {
  voiceNotes: { pending: number; transcriberUnavailable: number; unavailable: number };
  attachments: { pending: number; unavailable: number };
}

export interface ArchiveOptions {
  /** Clock, in unix seconds. */
  now?: () => number;
}

/** A user as the archive keeps it. */
export interface StoredUser {
  userId: number;
  displayName: string;
  username?: string;
  phoneE164?: string;
  isBot: boolean;
  isDeleted: boolean;
}

/** A chat with the walk bookkeeping the history walker reads. */
export interface ChatProgress extends StoredChat {
  oldestFetchedId?: number;
  newestSeenId: number;
  reconcileFromId?: number;
  reconcileOffsetId?: number;
  /** Unix seconds; absent means a presence check is due. */
  lastPresenceCheckAt?: number;
  presenceAfterId?: number;
  lastMessageTs: number;
  /** Unix seconds a forum's topics were last listed; absent: never, or due again. */
  topicsListedAt?: number;
}

/** One history page, ready to commit with the checkpoint it advances. */
export interface HistoryPageWrite {
  /** What the extractor kept of the page; may be fewer than the page held. */
  messages: readonly StoredMessage[];
  users: readonly TgUser[];
  /** Every id the page held, kept or not: the checkpoint moves past all of them. */
  rawIds: readonly number[];
  /** No older page remains (short page, or the data cutoff was reached). */
  done: boolean;
}

/** One dirty day, as the drain hands it to the normalizer. */
export interface DrainedDay {
  chatId: number;
  date: string;
  /** Surviving (not deleted) messages, oldest first. */
  messages: StoredMessage[];
  /** Attachment ids emitted for this day earlier and not yet retired. */
  ledger: string[];
  /**
   * Unix seconds the day's archived content last changed after it was first
   * archived (an edit, a deletion, a transcript, a topic renamed), counting
   * deleted messages too; absent when it never did.
   */
  changedAt?: number;
}

export interface DrainResult {
  days: DrainedDay[];
  emitSeq: number;
  morePending: boolean;
}

export type TakeoutState = "active" | "delayed" | "done" | "unavailable";

/** Counts the sync reports progress and `hasMore` from. */
export interface WalkSummary {
  pending: number;
  walking: number;
  done: number;
  failed: number;
  excluded: number;
  reconcilePending: boolean;
}

interface ChatRow {
  chat_id: number;
  kind: string;
  title: string;
  username: string | null;
  is_archived: number;
  is_forum: number;
  walk_state: string;
  oldest_fetched_id: number | null;
  newest_seen_id: number;
  reconcile_from_id: number | null;
  reconcile_offset_id: number | null;
  last_presence_check_at: number | null;
  presence_after_id: number | null;
  last_message_ts: number;
  topics_listed_at: number | null;
}

interface MessageRow {
  chat_id: number;
  msg_id: number;
  box: string;
  ts: number;
  edit_ts: number | null;
  sender_id: number | null;
  sender_name: string | null;
  outgoing: number;
  text: string;
  reply_to_id: number | null;
  topic_id: number | null;
  forward_from: string | null;
  grouped_id: string | null;
  service: string | null;
  media_json: string | null;
  media_state: string | null;
  media_next_attempt: number | null;
  media_last_error: string | null;
  transcript: string | null;
  media_extract_json: string | null;
  changed_at: number | null;
}

/** The UTC calendar day a unix-seconds timestamp falls on, `YYYY-MM-DD`. */
function messageDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export class TelegramArchive {
  readonly storeId: string;
  private closed = false;
  private readonly now: () => number;

  private constructor(
    private readonly db: Db,
    options: ArchiveOptions,
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    db.exec(SCHEMA);
    this.addMissingColumns();
    const priorVersion = Number(this.getMeta("schema_version") ?? SCHEMA_VERSION);
    if (priorVersion < 3) this.enrollArchivedMedia();
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('store_id', ?)").run(randomUUID());
    this.setMeta("schema_version", String(SCHEMA_VERSION));
    // Days an older build rendered differently are published again once.
    if (Number(this.getMeta("render_revision") ?? 1) < RENDER_REVISION) this.markAllDirty();
    this.setMeta("render_revision", String(RENDER_REVISION));
    this.storeId = this.getMeta("store_id")!;
  }

  /**
   * The last `emitSeq` issued, read inside the drain's transaction: two
   * handles can be open on one archive while a rebuilt context replaces the
   * old one, so a counter cached per handle could issue a value twice.
   */
  private emitSeqCounter(): number {
    const fromMeta = Number.parseInt(this.getMeta("emit_seq_counter") ?? "0", 10) || 0;
    const fromRows = (
      this.db.prepare("SELECT COALESCE(MAX(emit_seq), 0) AS m FROM dirty_days").get() as {
        m: number;
      }
    ).m;
    return Math.max(fromMeta, fromRows);
  }

  /**
   * Open the archive in an account directory. `key` is the `telegram-store`
   * key from `readTelegramStoreKey`, already fail-closed: `null` here means the
   * install keeps provider stores unencrypted. The caller zeroes the key.
   */
  static open(stateDir: string, key: Buffer | null, options: ArchiveOptions = {}): TelegramArchive {
    return new TelegramArchive(
      openProtectedDatabase(join(stateDir, ARCHIVE_FILE), key, "message archive"),
      options,
    );
  }

  /** Idempotent: schema 2's columns on an archive schema 1 created. */
  private addMissingColumns(): void {
    for (const [table, column, decl] of ADDED_COLUMNS) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!columns.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    }
  }

  /**
   * Schema 3: media an earlier build archived as a placeholder joins the
   * lifecycle, waiting for the retry sweep like media a bootstrap enrols.
   */
  private enrollArchivedMedia(): void {
    this.db
      .prepare(
        `UPDATE messages SET media_state = 'pending', media_next_attempt = 0
         WHERE media_state IS NULL AND deleted = 0 AND ${MEDIA_KIND_SQL} IN (${PROCESSABLE_KINDS_SQL})
           AND json_extract(media_json, '$.fileId') IS NOT NULL`,
      )
      .run();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  private deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  private metaNumber(key: string): number | undefined {
    const raw = this.getMeta(key);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  // ── Users ─────────────────────────────────────────────────────────────

  upsertUsers(users: readonly TgUser[]): void {
    this.db.transaction(() => this.writeUsers(users))();
  }

  private writeUsers(users: readonly TgUser[]): void {
    if (users.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO users (user_id, display_name, username, phone_e164, is_bot, is_deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = excluded.display_name,
         username = excluded.username,
         phone_e164 = COALESCE(excluded.phone_e164, users.phone_e164),
         is_bot = excluded.is_bot,
         is_deleted = excluded.is_deleted,
         updated_at = excluded.updated_at`,
    );
    const now = this.now();
    for (const u of users) {
      stmt.run(
        u.id,
        displayName(u),
        u.username ?? null,
        this.e164(u.phone),
        u.isBot ? 1 : 0,
        u.isDeleted ? 1 : 0,
        now,
      );
    }
  }

  getUser(userId: number): StoredUser | undefined {
    return this.getUsers([userId]).get(userId);
  }

  getUsers(userIds: Iterable<number>): Map<number, StoredUser> {
    const stmt = this.db.prepare(
      "SELECT user_id, display_name, username, phone_e164, is_bot, is_deleted FROM users WHERE user_id = ?",
    );
    const out = new Map<number, StoredUser>();
    for (const id of new Set(userIds)) {
      const row = stmt.get(id) as
        | {
            user_id: number;
            display_name: string;
            username: string | null;
            phone_e164: string | null;
            is_bot: number;
            is_deleted: number;
          }
        | undefined;
      if (!row) continue;
      out.set(row.user_id, {
        userId: row.user_id,
        displayName: row.display_name,
        ...(row.username ? { username: row.username } : {}),
        ...(row.phone_e164 ? { phoneE164: row.phone_e164 } : {}),
        isBot: row.is_bot === 1,
        isDeleted: row.is_deleted === 1,
      });
    }
    return out;
  }

  // ── Chats ─────────────────────────────────────────────────────────────

  /**
   * Record the dialog list. Every dialog's chat is created or refreshed,
   * including its archived flag, which only the dialog list knows. A chat
   * whose walk has started and whose top message is past what the archive
   * holds is queued for a forward re-page; a chat holding a gap floor with
   * nothing newer than it has the floor cleared without a request. A chat
   * Telegram refused earlier is offered again.
   */
  recordDialogs(dialogs: readonly TgDialog[], isIncluded: (chat: TgChat) => boolean): void {
    const now = this.now();
    const insert = this.db.prepare(
      `INSERT INTO chats (chat_id, kind, title, username, is_archived, is_forum, walk_state,
         top_at_enumeration, last_message_ts, last_presence_check_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         kind = excluded.kind, title = excluded.title, username = excluded.username,
         is_archived = excluded.is_archived, is_forum = excluded.is_forum,
         top_at_enumeration = excluded.top_at_enumeration,
         last_message_ts = MAX(chats.last_message_ts, excluded.last_message_ts),
         walk_state = CASE WHEN chats.walk_state = 'failed' THEN 'pending' ELSE chats.walk_state END,
         topics_listed_at = NULL,
         updated_at = excluded.updated_at`,
    );
    const markForward = this.db.prepare(
      `UPDATE chats SET reconcile_from_id = COALESCE(reconcile_from_id, newest_seen_id)
       WHERE chat_id = ? AND oldest_fetched_id IS NOT NULL AND walk_state != 'excluded'
         AND ? > newest_seen_id`,
    );
    const clearFloor = this.db.prepare(
      `UPDATE chats SET reconcile_from_id = NULL
       WHERE chat_id = ? AND reconcile_from_id IS NOT NULL AND reconcile_offset_id IS NULL
         AND ? <= reconcile_from_id`,
    );
    this.db.transaction(() => {
      for (const d of dialogs) {
        insert.run(
          d.chat.id,
          d.chat.kind,
          d.chat.title,
          d.chat.username ?? null,
          d.chat.isArchived ? 1 : 0,
          d.chat.isForum ? 1 : 0,
          isIncluded(d.chat) ? "pending" : "excluded",
          d.lastMessageId,
          d.lastMessageDate,
          now,
          now,
        );
        clearFloor.run(d.chat.id, d.lastMessageId);
        markForward.run(d.chat.id, d.lastMessageId);
      }
      this.setMeta("last_full_reconcile_at", String(now));
      this.setMeta("dialogs_listed_at", String(now));
      this.deleteMeta("reconcile_requested");
    })();
  }

  /**
   * Record a chat a live update named. A chat seen for the first time waits
   * for its walk. The archived flag is never taken from an update, which does
   * not carry it.
   */
  private writeLiveChat(chat: TgChat, ts: number, included: boolean): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, kind, title, username, is_archived, is_forum, walk_state,
           last_message_ts, last_presence_check_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           kind = excluded.kind, title = excluded.title, username = excluded.username,
           is_forum = excluded.is_forum,
           last_message_ts = MAX(chats.last_message_ts, excluded.last_message_ts),
           updated_at = excluded.updated_at`,
      )
      .run(
        chat.id,
        chat.kind,
        chat.title,
        chat.username ?? null,
        chat.isForum ? 1 : 0,
        included ? "pending" : "excluded",
        ts,
        now,
        now,
      );
  }

  getChat(chatId: number): ChatProgress | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE chat_id = ?").get(chatId) as
      ChatRow | undefined;
    return row ? toChatProgress(row) : undefined;
  }

  /** Every chat, most recently active first: the order the walk takes them in. */
  listChats(): ChatProgress[] {
    return (
      this.db
        .prepare("SELECT * FROM chats ORDER BY last_message_ts DESC, chat_id ASC")
        .all() as ChatRow[]
    ).map(toChatProgress);
  }

  /**
   * Bring every chat in line with the exclusion policy. A chat newly excluded
   * has every day it touched marked dirty and its messages purged in one
   * transaction, so the next drain tombstones those days; a chat no longer
   * excluded starts its walk again from the top.
   */
  applyExclusions(isIncluded: (chat: StoredChat) => boolean): { purged: number; restored: number } {
    let purged = 0;
    let restored = 0;
    const markDays = this.db.prepare(
      `INSERT INTO dirty_days (chat_id, date, emit_seq)
       SELECT DISTINCT chat_id, date(ts, 'unixepoch'), NULL FROM messages WHERE chat_id = ?
       ON CONFLICT(chat_id, date) DO UPDATE SET emit_seq = NULL`,
    );
    const markLedgerDays = this.db.prepare(
      `INSERT INTO dirty_days (chat_id, date, emit_seq)
       SELECT DISTINCT chat_id, date, NULL FROM emitted_attachments WHERE chat_id = ?
       ON CONFLICT(chat_id, date) DO UPDATE SET emit_seq = NULL`,
    );
    const purge = this.db.prepare("DELETE FROM messages WHERE chat_id = ?");
    const purgeTopics = this.db.prepare("DELETE FROM topics WHERE chat_id = ?");
    const exclude = this.db.prepare(
      `UPDATE chats SET walk_state = 'excluded', oldest_fetched_id = NULL, newest_seen_id = 0,
         reconcile_from_id = NULL, reconcile_offset_id = NULL, presence_after_id = NULL,
         topics_listed_at = NULL
       WHERE chat_id = ?`,
    );
    const restore = this.db.prepare(
      `UPDATE chats SET walk_state = 'pending', oldest_fetched_id = NULL, newest_seen_id = 0,
         reconcile_from_id = NULL, reconcile_offset_id = NULL, presence_after_id = NULL,
         last_presence_check_at = ?
       WHERE chat_id = ?`,
    );
    this.db.transaction(() => {
      for (const chat of this.listChats()) {
        const included = isIncluded(chat);
        if (!included && chat.walkState !== "excluded") {
          markDays.run(chat.chatId);
          markLedgerDays.run(chat.chatId);
          purge.run(chat.chatId);
          purgeTopics.run(chat.chatId);
          exclude.run(chat.chatId);
          purged++;
        } else if (included && chat.walkState === "excluded") {
          restore.run(this.now(), chat.chatId);
          restored++;
        }
      }
    })();
    return { purged, restored };
  }

  // ── History pages ─────────────────────────────────────────────────────

  /**
   * Commit one page of the backward walk with its checkpoint: the next page
   * asks for ids older than the oldest this page held.
   */
  commitWalkPage(chatId: number, page: HistoryPageWrite): void {
    this.db.transaction(() => {
      this.writeUsers(page.users);
      for (const m of page.messages) this.writeMessage(m);
      const oldest = page.rawIds.length > 0 ? Math.min(...page.rawIds) : null;
      const newest = page.rawIds.length > 0 ? Math.max(...page.rawIds) : 0;
      const walkState: WalkState = page.done ? "done" : "walking";
      this.db
        .prepare(
          `UPDATE chats SET
             walk_state = CASE WHEN walk_state = 'excluded' THEN walk_state ELSE ? END,
             oldest_fetched_id = COALESCE(?, oldest_fetched_id, 0),
             newest_seen_id = MAX(newest_seen_id, ?),
             updated_at = ?
           WHERE chat_id = ?`,
        )
        .run(walkState, oldest, newest, this.now(), chatId);
    })();
  }

  /**
   * Commit one page of a forward re-page (ids above the gap floor). A short
   * page closes the gap; a full one records where the next page continues.
   */
  commitForwardPage(chatId: number, page: HistoryPageWrite): void {
    this.db.transaction(() => {
      this.writeUsers(page.users);
      for (const m of page.messages) this.writeMessage(m);
      const oldest = page.rawIds.length > 0 ? Math.min(...page.rawIds) : null;
      const newest = page.rawIds.length > 0 ? Math.max(...page.rawIds) : 0;
      this.db
        .prepare(
          `UPDATE chats SET
             newest_seen_id = MAX(newest_seen_id, ?),
             reconcile_from_id = CASE WHEN ? THEN NULL ELSE reconcile_from_id END,
             reconcile_offset_id = CASE WHEN ? THEN NULL ELSE ? END,
             updated_at = ?
           WHERE chat_id = ?`,
        )
        .run(newest, page.done ? 1 : 0, page.done ? 1 : 0, oldest, this.now(), chatId);
    })();
  }

  /**
   * The next batch of a presence check: ids of recent, surviving messages
   * past `afterId`, in id order.
   */
  presenceBatch(chatId: number, sinceTs: number, afterId: number, limit: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT msg_id FROM messages
           WHERE chat_id = ? AND deleted = 0 AND ts > ? AND msg_id > ?
           ORDER BY msg_id ASC LIMIT ?`,
        )
        .all(chatId, sinceTs, afterId, limit) as { msg_id: number }[]
    ).map((r) => r.msg_id);
  }

  /**
   * Commit one presence-check batch: ids Telegram no longer has are deleted,
   * newer edits are applied, and the check advances (or finishes) in the
   * same transaction.
   */
  commitPresence(
    chatId: number,
    result: {
      missingIds: readonly number[];
      current: readonly StoredMessage[];
      users: readonly TgUser[];
      nextAfterId: number | null;
    },
  ): void {
    const chat = this.getChat(chatId);
    const box = chat ? boxOf(chat) : undefined;
    this.db.transaction(() => {
      this.writeUsers(result.users);
      if (box) for (const id of result.missingIds) this.deleteOne(box, id, chatId);
      for (const m of result.current) this.writeMessage(m);
      this.db
        .prepare(
          `UPDATE chats SET presence_after_id = ?,
             last_presence_check_at = CASE WHEN ? IS NULL THEN ? ELSE last_presence_check_at END
           WHERE chat_id = ?`,
        )
        .run(result.nextAfterId, result.nextAfterId, this.now(), chatId);
    })();
  }

  /** Mark a chat Telegram refused; it is offered again at the next full reconcile. */
  markChatFailed(chatId: number): void {
    this.db
      .prepare(
        // Gap floors and a pending presence check are kept: the chat is offered
        // again at the next full reconcile and picks them up where they were.
        `UPDATE chats SET walk_state = 'failed' WHERE chat_id = ? AND walk_state != 'excluded'`,
      )
      .run(chatId);
  }

  // ── Live updates ──────────────────────────────────────────────────────

  /**
   * Archive a message a live update delivered. `message` is `null` when the
   * extractor kept nothing of it; the chat still learns the id exists.
   * Returns whether a day changed.
   */
  storeLive(
    chat: TgChat,
    users: readonly TgUser[],
    message: StoredMessage | null,
    raw: { id: number; date: number },
    included: boolean,
  ): boolean {
    let changed = false;
    this.db.transaction(() => {
      this.writeUsers(users);
      this.writeLiveChat(chat, raw.date, included);
      const state = this.getChat(chat.id)?.walkState;
      if (state === "excluded") return;
      this.db
        .prepare("UPDATE chats SET newest_seen_id = MAX(newest_seen_id, ?) WHERE chat_id = ?")
        .run(raw.id, chat.id);
      if (message) changed = this.writeMessage(message);
    })();
    return changed;
  }

  /**
   * Apply a deletion. A common-box id is found through the account-wide id
   * index, since Telegram names no chat for it; an id not archived yet is
   * remembered, and applied when the message arrives. Returns how many
   * archived messages it deleted.
   */
  deleteMessages(box: MessageBox, ids: readonly number[]): number {
    let deleted = 0;
    this.db.transaction(() => {
      this.prunePendingDeletions();
      for (const id of ids) {
        const row = this.db
          .prepare("SELECT chat_id FROM messages WHERE box = ? AND msg_id = ?")
          .get(box, id) as { chat_id: number } | undefined;
        if (!row) {
          this.db
            .prepare(
              "INSERT OR IGNORE INTO pending_deletions (box, msg_id, observed_at) VALUES (?, ?, ?)",
            )
            .run(box, id, this.now());
          continue;
        }
        if (this.deleteOne(box, id, row.chat_id)) deleted++;
      }
    })();
    return deleted;
  }

  pendingDeletionCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM pending_deletions").get() as { c: number })
      .c;
  }

  private prunePendingDeletions(): void {
    this.db
      .prepare("DELETE FROM pending_deletions WHERE observed_at < ?")
      .run(this.now() - PENDING_DELETION_TTL_DAYS * 86_400);
  }

  private deleteOne(box: string, msgId: number, chatId: number): boolean {
    const row = this.db
      .prepare("SELECT ts FROM messages WHERE chat_id = ? AND msg_id = ? AND deleted = 0")
      .get(chatId, msgId) as { ts: number } | undefined;
    if (!row) return false;
    this.db
      .prepare(
        "UPDATE messages SET deleted = 1, deleted_at = ?, changed_at = ? WHERE chat_id = ? AND msg_id = ? AND box = ?",
      )
      .run(this.now(), this.now(), chatId, msgId, box);
    this.markDirty(chatId, messageDate(row.ts));
    return true;
  }

  /**
   * Insert or update one message, marking its day dirty only when what it
   * renders changed. An existing row is rewritten only by a newer edit or a
   * newer extractor revision, so the walk and a live update delivering the
   * same message do not churn; `deleted` and the media lifecycle are never
   * reset. A message whose deletion arrived first is stored deleted.
   */
  private writeMessage(m: StoredMessage): boolean {
    const exists = this.db
      .prepare("SELECT media_json FROM messages WHERE chat_id = ? AND msg_id = ?")
      .get(m.chatId, m.msgId) as { media_json: string | null } | undefined;
    let deletedAt: number | null = null;
    if (!exists && this.collides(m)) return false;
    if (!exists) {
      const pending = this.db
        .prepare("SELECT observed_at FROM pending_deletions WHERE box = ? AND msg_id = ?")
        .get(m.box, m.msgId) as { observed_at: number } | undefined;
      if (pending) {
        deletedAt = pending.observed_at;
        this.db
          .prepare("DELETE FROM pending_deletions WHERE box = ? AND msg_id = ?")
          .run(m.box, m.msgId);
      }
    }
    const info = this.db
      .prepare(
        `INSERT INTO messages (chat_id, msg_id, box, ts, edit_ts, sender_id, sender_name, outgoing,
           text, reply_to_id, topic_id, forward_from, grouped_id, service, media_json,
           deleted, deleted_at, extract_rev, media_state, media_next_attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, msg_id) DO UPDATE SET
           edit_ts = excluded.edit_ts, sender_id = excluded.sender_id,
           sender_name = excluded.sender_name, text = excluded.text,
           reply_to_id = excluded.reply_to_id, topic_id = excluded.topic_id,
           forward_from = excluded.forward_from, grouped_id = excluded.grouped_id,
           service = excluded.service, media_json = excluded.media_json,
           extract_rev = excluded.extract_rev
         WHERE COALESCE(excluded.edit_ts, 0) > COALESCE(messages.edit_ts, 0)
            OR excluded.extract_rev > messages.extract_rev
            OR (excluded.edit_ts IS NOT NULL AND excluded.edit_ts = messages.edit_ts
                AND (excluded.text IS NOT messages.text
                     OR excluded.media_json IS NOT messages.media_json))`,
      )
      .run(
        m.chatId,
        m.msgId,
        m.box,
        m.ts,
        m.editTs ?? null,
        m.senderId ?? null,
        m.senderName ?? null,
        m.outgoing ? 1 : 0,
        m.text,
        m.replyToId ?? null,
        m.topicId ?? null,
        m.forwardFrom ?? null,
        m.groupedId ?? null,
        m.service ?? null,
        m.media ? JSON.stringify(m.media) : null,
        deletedAt === null ? 0 : 1,
        deletedAt,
        EXTRACT_REVISION,
        enrols(m.media) ? "pending" : null,
        enrols(m.media) ? 0 : null,
      );
    if (info.changes === 0 || deletedAt !== null) return false;
    // An edit that replaced the media starts its lifecycle again; a fresh
    // file reference for the same file does not.
    if (exists && mediaIdentity(exists.media_json) !== mediaIdentity(m.media)) {
      this.restartMediaLifecycle(m.chatId, m.msgId, enrols(m.media));
    }
    const deleted = this.db
      .prepare("SELECT deleted FROM messages WHERE chat_id = ? AND msg_id = ?")
      .get(m.chatId, m.msgId) as { deleted: number };
    if (deleted.deleted === 1) return false;
    if (exists) this.touch("chat_id = ? AND msg_id = ?", m.chatId, m.msgId);
    this.markDirty(m.chatId, messageDate(m.ts));
    return true;
  }

  /**
   * Whether another chat already holds this message's id in its box. Ids in
   * the common box are account-wide, so Telegram never repeats one; if it
   * ever did (or a client reported a message under the wrong chat), the
   * deletion index would refuse the row and fail the whole page, on every
   * sync, for good. The archived message stays; the newcomer is skipped and
   * counted, and the page moves on.
   */
  private collides(m: StoredMessage): boolean {
    const holder = this.db
      .prepare("SELECT chat_id FROM messages WHERE box = ? AND msg_id = ? AND chat_id != ?")
      .get(m.box, m.msgId, m.chatId) as { chat_id: number } | undefined;
    if (!holder) return false;
    log.warn(
      `Telegram message ${m.msgId} in ${m.chatId} reuses an id ${holder.chat_id} holds in its box; skipped`,
    );
    this.setMeta("id_collisions", String((this.metaNumber("id_collisions") ?? 0) + 1));
    return true;
  }

  /** Messages skipped because another chat held their id (see `collides`). */
  idCollisionCount(): number {
    return this.metaNumber("id_collisions") ?? 0;
  }

  /** Record that archived content changed now (`sourceUpdatedAt` moves with it). */
  private touch(where: string, ...params: unknown[]): void {
    this.db.prepare(`UPDATE messages SET changed_at = ? WHERE ${where}`).run(this.now(), ...params);
  }

  /** Unix seconds, on the archive's clock. */
  clock(): number {
    return this.now();
  }

  private markDirty(chatId: number, date: string): void {
    this.db
      .prepare(
        `INSERT INTO dirty_days (chat_id, date, emit_seq) VALUES (?, ?, NULL)
         ON CONFLICT(chat_id, date) DO UPDATE SET emit_seq = NULL`,
      )
      .run(chatId, date);
  }

  /** Surviving messages of one chat by id, for reply quotes. */
  getMessages(chatId: number, ids: Iterable<number>): Map<number, StoredMessage> {
    const stmt = this.db.prepare(
      "SELECT * FROM messages WHERE chat_id = ? AND msg_id = ? AND deleted = 0",
    );
    const out = new Map<number, StoredMessage>();
    for (const id of new Set(ids)) {
      const row = stmt.get(chatId, id) as MessageRow | undefined;
      if (row) out.set(id, toStoredMessage(row));
    }
    return out;
  }

  /** Whether a message is archived and not deleted (tests and reconcile). */
  hasMessage(chatId: number, msgId: number): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM messages WHERE chat_id = ? AND msg_id = ? AND deleted = 0")
      .get(chatId, msgId);
  }

  messageCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS c FROM messages WHERE deleted = 0").get() as {
        c: number;
      }
    ).c;
  }

  // ── Gaps ──────────────────────────────────────────────────────────────

  /**
   * Updates may have been lost account-wide. Every chat whose walk has
   * started remembers where the archive stood (the gap floor), the next walk
   * lists the dialogs again, and every such chat gets a presence check.
   */
  requestAccountReconcile(): void {
    this.db.transaction(() => {
      this.setMeta("reconcile_requested", "1");
      this.db
        .prepare(
          `UPDATE chats SET
             reconcile_from_id = COALESCE(reconcile_from_id, outage_floor_id, newest_seen_id),
             outage_floor_id = NULL, last_presence_check_at = NULL, presence_after_id = NULL
           WHERE oldest_fetched_id IS NOT NULL AND walk_state IN ('walking', 'done', 'failed')`,
        )
        .run();
    })();
  }

  /**
   * The connection dropped: remember where every chat stood, so a reconnect
   * that turns out to follow a long outage floors the re-page here, below
   * whatever the catch-up delivered first. Kept only until it is settled.
   */
  markOutageFloors(): void {
    this.db
      .prepare(
        "UPDATE chats SET outage_floor_id = COALESCE(outage_floor_id, newest_seen_id) WHERE oldest_fetched_id IS NOT NULL",
      )
      .run();
  }

  /** A short outage: nothing to reconcile. */
  clearOutageFloors(): void {
    this.db
      .prepare("UPDATE chats SET outage_floor_id = NULL WHERE outage_floor_id IS NOT NULL")
      .run();
  }

  /** One channel's updates were lost: re-page it above the floor and check it. */
  requestChannelReconcile(chatId: number): void {
    this.db
      .prepare(
        `UPDATE chats SET reconcile_from_id = COALESCE(reconcile_from_id, newest_seen_id),
           last_presence_check_at = NULL, presence_after_id = NULL
         WHERE chat_id = ? AND oldest_fetched_id IS NOT NULL
           AND walk_state IN ('walking', 'done', 'failed')`,
      )
      .run(chatId);
  }

  /** Whether the dialog list should be read again on the next walk. */
  enumerationDue(intervalS: number): boolean {
    if (this.getMeta("reconcile_requested") === "1") return true;
    const last = this.metaNumber("last_full_reconcile_at");
    return last === undefined || this.now() - last >= intervalS;
  }

  /** Whether the dialog list has ever been read: before that, nothing is known to be walked. */
  hasEnumerated(): boolean {
    return this.getMeta("dialogs_listed_at") !== undefined;
  }

  /** Ask for a full reconcile (a resync): the dialogs are listed again. */
  requestFullReconcile(): void {
    this.deleteMeta("last_full_reconcile_at");
  }

  /** Unix seconds a flood wait lasts until, when one is active. */
  floodUntil(): number | undefined {
    const until = this.metaNumber("flood_until");
    return until !== undefined && until > this.now() ? until : undefined;
  }

  /** The length of the flood wait last recorded, in seconds. */
  floodSeconds(): number {
    return this.metaNumber("flood_seconds") ?? 0;
  }

  recordFloodWait(seconds: number): void {
    this.db.transaction(() => {
      this.setMeta("flood_until", String(this.now() + seconds));
      this.setMeta("flood_seconds", String(seconds));
    })();
  }

  walkSummary(): WalkSummary {
    const counts: Record<string, number> = {};
    for (const row of this.db
      .prepare("SELECT walk_state, COUNT(*) AS c FROM chats GROUP BY walk_state")
      .all() as { walk_state: string; c: number }[]) {
      counts[row.walk_state] = row.c;
    }
    const reconcile = this.db
      .prepare(
        `SELECT 1 FROM chats WHERE walk_state IN ('walking', 'done')
           AND (reconcile_from_id IS NOT NULL OR
                (oldest_fetched_id IS NOT NULL AND last_presence_check_at IS NULL))
         LIMIT 1`,
      )
      .get();
    return {
      pending: counts.pending ?? 0,
      walking: counts.walking ?? 0,
      done: counts.done ?? 0,
      failed: counts.failed ?? 0,
      excluded: counts.excluded ?? 0,
      reconcilePending: !!reconcile || this.getMeta("reconcile_requested") === "1",
    };
  }

  // ── Forum topics ──────────────────────────────────────────────────────

  /**
   * Forum chats whose topics should be listed: never listed since the last
   * dialog listing, or holding a message newer than the listing in a topic
   * the archive has no title for (a topic created since).
   */
  forumsDueForTopics(): number[] {
    return (
      this.db
        .prepare(
          `SELECT chat_id FROM chats c
           WHERE is_forum = 1 AND walk_state NOT IN ('excluded', 'failed')
             AND (topics_listed_at IS NULL OR EXISTS (
               SELECT 1 FROM messages m
               WHERE m.chat_id = c.chat_id AND m.topic_id IS NOT NULL AND m.deleted = 0
                 AND m.ts >= c.topics_listed_at
                 AND NOT EXISTS (SELECT 1 FROM topics t
                                 WHERE t.chat_id = m.chat_id AND t.topic_id = m.topic_id)))
           ORDER BY last_message_ts DESC, chat_id ASC`,
        )
        .all() as { chat_id: number }[]
    ).map((r) => r.chat_id);
  }

  /**
   * Record a forum's topics. Only the days holding a message in a topic whose
   * title is new or changed are marked dirty, so listing an unchanged forum
   * again re-renders nothing.
   */
  recordTopics(chatId: number, topics: readonly { id: number; title: string }[]): number {
    let changed = 0;
    const current = this.getTopics(chatId);
    const upsert = this.db.prepare(
      `INSERT INTO topics (chat_id, topic_id, title) VALUES (?, ?, ?)
       ON CONFLICT(chat_id, topic_id) DO UPDATE SET title = excluded.title`,
    );
    const markDays = this.db.prepare(
      `INSERT INTO dirty_days (chat_id, date, emit_seq)
       SELECT DISTINCT chat_id, date(ts, 'unixepoch'), NULL FROM messages
       WHERE chat_id = ? AND topic_id = ? AND deleted = 0
       ON CONFLICT(chat_id, date) DO UPDATE SET emit_seq = NULL`,
    );
    this.db.transaction(() => {
      for (const topic of topics) {
        if (current.get(topic.id) === topic.title) continue;
        upsert.run(chatId, topic.id, topic.title);
        // A rename changes days already published; a first title only fills them in.
        if (current.has(topic.id)) {
          this.touch("chat_id = ? AND topic_id = ? AND deleted = 0", chatId, topic.id);
        }
        changed += markDays.run(chatId, topic.id).changes > 0 ? 1 : 0;
      }
      this.db
        .prepare("UPDATE chats SET topics_listed_at = ? WHERE chat_id = ?")
        .run(this.now(), chatId);
    })();
    return changed;
  }

  /** A forum's topic titles by topic id. */
  getTopics(chatId: number): Map<number, string> {
    return new Map(
      (
        this.db.prepare("SELECT topic_id, title FROM topics WHERE chat_id = ?").all(chatId) as {
          topic_id: number;
          title: string;
        }[]
      ).map((r) => [r.topic_id, r.title]),
    );
  }

  // ── Takeout (`docs/telegram-source.md` §7.2, phase 4) ──────────────────

  /**
   * Where the bootstrap's data export stands. `delayed`: Telegram holds it
   * until the owner approves it, retried at `retryAt`; `done`: the walk it
   * served finished; `unavailable`: refused or lost, the walk reads history
   * the normal way. Absent: not tried yet.
   */
  takeoutState(): { state?: TakeoutState; retryAt?: number } {
    const state = this.getMeta("takeout_state") as TakeoutState | undefined;
    const retryAt = this.metaNumber("takeout_retry_at");
    return {
      ...(state ? { state } : {}),
      ...(retryAt !== undefined ? { retryAt } : {}),
    };
  }

  setTakeoutState(state: TakeoutState, retryAfterS?: number): void {
    this.db.transaction(() => {
      this.setMeta("takeout_state", state);
      // Only an active export has a session to resume.
      if (state !== "active") this.deleteMeta("takeout_session");
      if (retryAfterS !== undefined) {
        this.setMeta("takeout_retry_at", String(this.now() + retryAfterS));
      } else {
        this.deleteMeta("takeout_retry_at");
      }
    })();
  }

  /**
   * An export session is open: kept with its id and scope, so a rebuilt
   * context or a restart resumes it rather than asking Telegram for another.
   */
  setTakeoutActive(id: string, scope: TakeoutScope): void {
    this.db.transaction(() => {
      this.setTakeoutState("active");
      this.setMeta("takeout_session", JSON.stringify({ id, scope }));
    })();
  }

  /** The open export session to resume, while the export is active. */
  takeoutSession(): { id: string; scope: TakeoutScope } | undefined {
    const raw = this.getMeta("takeout_session");
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { id?: unknown; scope?: TakeoutScope };
      return typeof parsed.id === "string" && parsed.scope
        ? { id: parsed.id, scope: parsed.scope }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** A resync: a held-back export is asked for again on the next walk. */
  clearTakeoutDelay(): void {
    if (this.getMeta("takeout_state") !== "delayed") return;
    this.db.transaction(() => {
      this.deleteMeta("takeout_state");
      this.deleteMeta("takeout_retry_at");
    })();
  }

  // ── Publishing ────────────────────────────────────────────────────────

  /**
   * Drain up to `limit` dirty days, most recent first. Non-destructive: the
   * days are stamped with a fresh `emitSeq` for the caller to put in the
   * cursor, and only a later drain handed that value back as `committedSeq`
   * (the gateway accepted the page) clears them. A `committedSeq` this
   * archive never issued — another archive's, or a corrupt one — counts as
   * nothing acknowledged.
   */
  drain(opts: { committedSeq: number; limit: number }): DrainResult {
    const days: DrainedDay[] = [];
    let morePending = false;
    let emitSeq = 0;
    this.db.transaction(() => {
      const issued = this.emitSeqCounter();
      const committedSeq =
        Number.isSafeInteger(opts.committedSeq) &&
        opts.committedSeq >= 0 &&
        opts.committedSeq <= issued
          ? opts.committedSeq
          : 0;
      emitSeq = issued + 1;
      this.db
        .prepare("DELETE FROM dirty_days WHERE emit_seq IS NOT NULL AND emit_seq <= ?")
        .run(committedSeq);
      this.db
        .prepare(
          "DELETE FROM emitted_attachments WHERE retired_seq IS NOT NULL AND retired_seq <= ?",
        )
        .run(committedSeq);
      this.prunePendingDeletions();
      // A day whose render failed waits out its backoff (see `quarantineDay`).
      const rows = this.db
        .prepare(
          `SELECT chat_id, date FROM dirty_days
           WHERE (emit_seq IS NULL OR emit_seq > ?) AND (retry_at IS NULL OR retry_at <= ?)
           ORDER BY date DESC, chat_id ASC LIMIT ?`,
        )
        .all(committedSeq, this.now(), opts.limit + 1) as { chat_id: number; date: string }[];
      morePending = rows.length > opts.limit;
      const stamp = this.db.prepare(
        "UPDATE dirty_days SET emit_seq = ? WHERE chat_id = ? AND date = ?",
      );
      const selectDay = this.db.prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND ts >= ? AND ts < ? AND deleted = 0
         ORDER BY ts ASC, msg_id ASC`,
      );
      const selectChanged = this.db.prepare(
        "SELECT MAX(changed_at) AS c FROM messages WHERE chat_id = ? AND ts >= ? AND ts < ?",
      );
      const selectLedger = this.db.prepare(
        "SELECT external_id FROM emitted_attachments WHERE chat_id = ? AND date = ? ORDER BY external_id",
      );
      for (const { chat_id, date } of rows.slice(0, opts.limit)) {
        stamp.run(emitSeq, chat_id, date);
        const start = Date.parse(`${date}T00:00:00.000Z`) / 1000;
        const changed = (selectChanged.get(chat_id, start, start + 86_400) as { c: number | null })
          .c;
        days.push({
          ...(changed !== null ? { changedAt: changed } : {}),
          chatId: chat_id,
          date,
          messages: (selectDay.all(chat_id, start, start + 86_400) as MessageRow[]).map(
            toStoredMessage,
          ),
          ledger: (selectLedger.all(chat_id, date) as { external_id: string }[]).map(
            (r) => r.external_id,
          ),
        });
      }
      this.setMeta("emit_seq_counter", String(emitSeq));
    })();
    return { days, emitSeq, morePending };
  }

  /**
   * A drained day whose render failed: kept dirty, unstamped so this page's
   * acknowledgement cannot clear it, and held back on a doubling backoff so
   * the other days keep publishing. Returns how many times it has failed.
   */
  quarantineDay(chatId: number, date: string): number {
    const row = this.db
      .prepare(
        `UPDATE dirty_days SET emit_seq = NULL, render_failures = render_failures + 1
         WHERE chat_id = ? AND date = ? RETURNING render_failures AS f`,
      )
      .get(chatId, date) as { f: number } | undefined;
    const failures = row?.f ?? 1;
    const delay = Math.min(60 * 2 ** (failures - 1), RENDER_RETRY_MAX_S);
    this.db
      .prepare("UPDATE dirty_days SET retry_at = ? WHERE chat_id = ? AND date = ?")
      .run(this.now() + delay, chatId, date);
    return failures;
  }

  /** Days whose last render failed and that wait to be tried again (a stamped one rendered). */
  quarantinedDayCount(): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS c FROM dirty_days WHERE render_failures > 0 AND emit_seq IS NULL",
        )
        .get() as {
        c: number;
      }
    ).c;
  }

  /**
   * Settle a drained day's attachment ledger against what this render
   * emitted. Ledger entries the render no longer produced are retired with
   * `emitSeq` and returned for tombstoning; they leave the ledger once that
   * page is committed, and are tombstoned again if it is not.
   */
  settleAttachments(
    chatId: number,
    date: string,
    emitted: readonly string[],
    emitSeq: number,
  ): string[] {
    const keep = new Set(emitted);
    const retired: string[] = [];
    this.db.transaction(() => {
      const ledger = this.db
        .prepare("SELECT external_id FROM emitted_attachments WHERE chat_id = ? AND date = ?")
        .all(chatId, date) as { external_id: string }[];
      const retire = this.db.prepare(
        "UPDATE emitted_attachments SET retired_seq = ? WHERE chat_id = ? AND date = ? AND external_id = ?",
      );
      for (const { external_id } of ledger) {
        if (keep.has(external_id)) continue;
        retire.run(emitSeq, chatId, date, external_id);
        retired.push(external_id);
      }
      const upsert = this.db.prepare(
        `INSERT INTO emitted_attachments (chat_id, date, external_id, emit_seq, retired_seq)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(chat_id, date, external_id) DO UPDATE SET emit_seq = excluded.emit_seq,
           retired_seq = NULL`,
      );
      for (const id of keep) upsert.run(chatId, date, id, emitSeq);
    })();
    return retired;
  }

  // ── Media lifecycle (`docs/telegram-source.md` §10) ──────────────────

  private restartMediaLifecycle(chatId: number, msgId: number, enrol: boolean): void {
    this.db
      .prepare(
        `UPDATE messages SET media_state = ?, media_next_attempt = ?, media_attempts = 0,
           media_last_error = NULL, transcript = NULL, media_extract_json = NULL
         WHERE chat_id = ? AND msg_id = ?`,
      )
      .run(enrol ? "pending" : null, enrol ? 0 : null, chatId, msgId);
  }

  /**
   * Record one media attempt's outcome. Nothing is marked dirty: the outcome
   * is recorded while its day renders, so the page being built already shows
   * it, and a pending retry is re-armed by the sweep when its backoff ends.
   */
  recordMediaOutcome(chatId: number, msgId: number, outcome: MediaOutcome): void {
    const now = this.now();
    const prior = this.db
      .prepare("SELECT media_attempts AS a FROM messages WHERE chat_id = ? AND msg_id = ?")
      .get(chatId, msgId) as { a: number } | undefined;
    if (!prior) return;
    const settle = (state: MediaState, sets = "", ...values: unknown[]): void => {
      this.db
        .prepare(
          `UPDATE messages SET media_state = ?, media_next_attempt = NULL, media_last_error = NULL
             ${sets} WHERE chat_id = ? AND msg_id = ?`,
        )
        .run(state, ...values, chatId, msgId);
    };
    switch (outcome.kind) {
      case "transcribed":
        settle(
          outcome.text === "" ? "empty" : "done",
          ", transcript = ?, changed_at = ?",
          outcome.text,
          now,
        );
        return;
      case "extracted":
        if (outcome.complete) {
          settle("done", ", media_extract_json = ?", outcome.extraction);
        } else {
          // Useful text now, scanned pages later: keep it and stay enrolled.
          const attempts = prior.a + 1;
          this.db
            .prepare(
              `UPDATE messages SET media_state = 'pending', media_extract_json = ?,
                 media_attempts = ?, media_next_attempt = ?, media_last_error = 'ocr-incomplete'
               WHERE chat_id = ? AND msg_id = ?`,
            )
            .run(outcome.extraction, attempts, now + backoffStep(attempts), chatId, msgId);
        }
        return;
      case "empty":
        // An extraction kept from an earlier pass no longer says anything true.
        settle("empty", ", media_extract_json = NULL");
        return;
      case "skipped":
        settle("skipped", ", media_last_error = ?", outcome.reason);
        return;
      case "terminal":
        settle("unavailable", ", media_last_error = ?", outcome.error);
        return;
      case "transient":
      case "process-failed": {
        const attempts = prior.a + 1;
        const step =
          outcome.kind === "transient" ? downloadRetryDelaySec(attempts) : backoffStep(attempts);
        if (step === null) {
          log.warn(`Telegram media ${chatId}/${msgId} unavailable after ${attempts} attempts`);
          settle(
            "unavailable",
            ", media_attempts = ?, media_last_error = ?",
            attempts,
            outcome.error,
          );
          return;
        }
        const delay =
          outcome.kind === "transient" ? Math.max(step, outcome.retryAfterSec ?? 0) : step;
        this.db
          .prepare(
            `UPDATE messages SET media_state = 'pending', media_attempts = ?,
               media_next_attempt = ?, media_last_error = ?
             WHERE chat_id = ? AND msg_id = ?`,
          )
          .run(attempts, now + delay, outcome.error, chatId, msgId);
        return;
      }
    }
  }

  /** Keep the fresh descriptor a download refreshed, without re-rendering anything. */
  updateMediaDescriptor(chatId: number, msgId: number, media: MediaDescriptor): void {
    this.db
      .prepare("UPDATE messages SET media_json = ? WHERE chat_id = ? AND msg_id = ?")
      .run(JSON.stringify(media), chatId, msgId);
  }

  /**
   * The retry sweep: mark dirty the days of media whose backoff has ended, the
   * most recent first and at most `limit` of them, so a backlog is worked
   * through a few days per page instead of crowding out new messages.
   */
  markDueMediaDirty(scope: MediaScope, limit: number): number {
    if (this.mediaFloodUntil() !== undefined) return 0;
    const due = this.db
      .prepare(
        `SELECT chat_id, date(ts, 'unixepoch') AS date FROM messages
         WHERE ${MEDIA_RETRY_ELIGIBILITY} AND media_next_attempt <= @now
         GROUP BY chat_id, date ORDER BY MAX(ts) DESC LIMIT @limit`,
      )
      .all({ ...scopeParams(scope), now: this.now(), limit }) as {
      chat_id: number;
      date: string;
    }[];
    this.db.transaction(() => {
      for (const { chat_id, date } of due) this.markDirty(chat_id, date);
    })();
    return due.length;
  }

  /** Whether media other than `excluding` (`chatId:msgId`) is due now. */
  hasDueMedia(scope: MediaScope, excluding: ReadonlySet<string>): boolean {
    if (this.mediaFloodUntil() !== undefined) return false;
    const rows = this.db
      .prepare(
        `SELECT chat_id, msg_id FROM messages
         WHERE ${MEDIA_RETRY_ELIGIBILITY} AND media_next_attempt <= @now LIMIT @limit`,
      )
      .all({ ...scopeParams(scope), now: this.now(), limit: excluding.size + 1 }) as {
      chat_id: number;
      msg_id: number;
    }[];
    return rows.some((r) => !excluding.has(`${r.chat_id}:${r.msg_id}`));
  }

  /** Unix seconds the earliest in-scope media comes due, if any does. */
  nextMediaDue(scope: MediaScope): number | undefined {
    const row = this.db
      .prepare(`SELECT MIN(media_next_attempt) AS m FROM messages WHERE ${MEDIA_RETRY_ELIGIBILITY}`)
      .get(scopeParams(scope)) as { m: number | null };
    if (row.m === null) return undefined;
    return Math.max(row.m, this.mediaFloodUntil() ?? 0);
  }

  /** Telegram asked to wait before the next download. */
  recordMediaFlood(seconds: number): void {
    this.setMeta("media_flood_until", String(this.now() + seconds));
  }

  /** Unix seconds downloads wait until, while a download flood wait lasts. */
  mediaFloodUntil(): number | undefined {
    const until = this.metaNumber("media_flood_until");
    return until !== undefined && until > this.now() ? until : undefined;
  }

  /**
   * Media still to process and media gone for good, inside `scope`. A pending
   * voice note whose last attempt found no transcriber is also counted under
   * `transcriberUnavailable`.
   */
  mediaHealthStats(scope: MediaScope): MediaHealthStats {
    const rows = this.db
      .prepare(
        `SELECT media_state AS s, (${MEDIA_KIND_SQL} = 'voice') AS voice,
                (media_last_error = @noTranscriber) AS noTranscriber, COUNT(*) AS n
         FROM messages
         WHERE media_state IN ('pending', 'unavailable') AND deleted = 0
           AND (@minTs IS NULL OR ts >= @minTs)
           AND ((@voiceNotes = 1 AND ${MEDIA_KIND_SQL} = 'voice')
             OR (@attachments = 1 AND ${MEDIA_KIND_SQL} IN ('photo', 'document')))
         GROUP BY s, voice, noTranscriber`,
      )
      .all({ ...scopeParams(scope), noTranscriber: TRANSCRIBER_UNAVAILABLE }) as {
      s: "pending" | "unavailable";
      voice: 0 | 1;
      noTranscriber: 0 | 1 | null;
      n: number;
    }[];
    const stats: MediaHealthStats = {
      voiceNotes: { pending: 0, transcriberUnavailable: 0, unavailable: 0 },
      attachments: { pending: 0, unavailable: 0 },
    };
    for (const row of rows) {
      const bucket = row.voice ? stats.voiceNotes : stats.attachments;
      bucket[row.s] += row.n;
      if (row.voice && row.s === "pending" && row.noTranscriber) {
        stats.voiceNotes.transcriberUnavailable += row.n;
      }
    }
    return stats;
  }

  /**
   * A resync processes every downloadable media again, due now: voice notes
   * with the current transcriber, attachments with the current settings. The
   * results already held stay until a new one replaces them.
   */
  resetMediaForResync(): void {
    this.db
      .prepare(
        `UPDATE messages SET media_state = 'pending', media_attempts = 0, media_next_attempt = 0,
           media_last_error = NULL
         WHERE deleted = 0 AND ${MEDIA_KIND_SQL} IN (${PROCESSABLE_KINDS_SQL})
           AND json_extract(media_json, '$.fileId') IS NOT NULL`,
      )
      .run();
    this.deleteMeta("media_flood_until");
  }

  /** Re-publish every day the archive holds (a resync). */
  markAllDirty(): void {
    this.db
      .prepare(
        `INSERT INTO dirty_days (chat_id, date, emit_seq)
         SELECT DISTINCT chat_id, date(ts, 'unixepoch'), NULL FROM messages WHERE deleted = 0
         ON CONFLICT(chat_id, date) DO UPDATE SET emit_seq = NULL`,
      )
      .run();
  }

  /** Days waiting to be published or acknowledged. */
  dirtyDayCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM dirty_days").get() as { c: number }).c;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Telegram reports international digits without the `+`, so no region is needed. */
  private e164(digits: string | undefined): string | null {
    if (!digits) return null;
    return normalizePhone(`+${digits.replace(/^\+/u, "")}`);
  }
}

/** Where a chat's message ids are unique: its own box for a channel or supergroup. */
export function boxOf(chat: Pick<StoredChat, "chatId" | "kind">): MessageBox {
  return chat.kind === "supergroup" || chat.kind === "forum" || chat.kind === "channel"
    ? `channel:${chat.chatId}`
    : "common";
}

function toChatProgress(row: ChatRow): ChatProgress {
  return {
    chatId: row.chat_id,
    kind: row.kind as ChatKind,
    title: row.title,
    ...(row.username ? { username: row.username } : {}),
    isArchived: row.is_archived === 1,
    isForum: row.is_forum === 1,
    walkState: row.walk_state as WalkState,
    ...(row.oldest_fetched_id !== null ? { oldestFetchedId: row.oldest_fetched_id } : {}),
    newestSeenId: row.newest_seen_id,
    ...(row.reconcile_from_id !== null ? { reconcileFromId: row.reconcile_from_id } : {}),
    ...(row.reconcile_offset_id !== null ? { reconcileOffsetId: row.reconcile_offset_id } : {}),
    ...(row.last_presence_check_at !== null
      ? { lastPresenceCheckAt: row.last_presence_check_at }
      : {}),
    ...(row.presence_after_id !== null ? { presenceAfterId: row.presence_after_id } : {}),
    lastMessageTs: row.last_message_ts,
    ...(row.topics_listed_at !== null ? { topicsListedAt: row.topics_listed_at } : {}),
  };
}

function toStoredMessage(r: MessageRow): StoredMessage {
  return {
    chatId: r.chat_id,
    msgId: r.msg_id,
    box: r.box as MessageBox,
    ts: r.ts,
    ...(r.edit_ts !== null ? { editTs: r.edit_ts } : {}),
    ...(r.sender_id !== null ? { senderId: r.sender_id } : {}),
    ...(r.sender_name !== null ? { senderName: r.sender_name } : {}),
    outgoing: r.outgoing === 1,
    text: r.text,
    ...(r.reply_to_id !== null ? { replyToId: r.reply_to_id } : {}),
    ...(r.topic_id !== null ? { topicId: r.topic_id } : {}),
    ...(r.forward_from !== null ? { forwardFrom: r.forward_from } : {}),
    ...(r.grouped_id !== null ? { groupedId: r.grouped_id } : {}),
    ...(r.service !== null ? { service: r.service } : {}),
    ...(r.media_json !== null ? { media: JSON.parse(r.media_json) as MediaDescriptor } : {}),
    ...(r.media_state !== null ? { mediaState: r.media_state as MediaState } : {}),
    ...(r.media_next_attempt !== null ? { mediaNextAttempt: r.media_next_attempt } : {}),
    ...(r.media_last_error !== null ? { mediaLastError: r.media_last_error } : {}),
    ...(r.transcript !== null ? { transcript: r.transcript } : {}),
    ...(r.media_extract_json !== null
      ? { extraction: JSON.parse(r.media_extract_json) as ExtractionResult }
      : {}),
    ...(r.changed_at !== null && r.changed_at !== undefined ? { changedAt: r.changed_at } : {}),
  };
}

/** Whether media joins the lifecycle when its message is archived. */
function enrols(media: MediaDescriptor | undefined): boolean {
  return !!media?.fileId && isProcessableKind(media.kind);
}

/**
 * What makes media the same file across re-reads: everything but the file id,
 * whose embedded file reference changes when Telegram refreshes it.
 */
function mediaIdentity(media: MediaDescriptor | string | null | undefined): string {
  if (!media) return "";
  const parsed: MediaDescriptor =
    typeof media === "string" ? (JSON.parse(media) as MediaDescriptor) : media;
  const { fileId: _fileId, ...rest } = parsed;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

function scopeParams(scope: MediaScope): {
  voiceNotes: number;
  attachments: number;
  minTs: number | null;
} {
  return {
    voiceNotes: scope.voiceNotes ? 1 : 0,
    attachments: scope.attachments ? 1 : 0,
    minTs: scope.minTs ?? null,
  };
}

/**
 * The name a user goes by: first and last name, else the username, else
 * nothing (an id is not a name; the render falls back to the message's own).
 */
function displayName(u: Pick<TgUser, "firstName" | "lastName" | "username">): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return name || (u.username ? `@${u.username}` : "");
}

/** The doctor's view of both of an account's local stores. */
export function inspectTelegramStores(
  stateDir: string,
  configDir: string,
): LocalStoreProbeResult[] {
  return [
    inspectProtectedStore(join(stateDir, ARCHIVE_FILE), ARCHIVE_LABEL, configDir),
    inspectProtectedStore(join(stateDir, "mtcute.db"), "Telegram connection cache", configDir),
  ];
}
