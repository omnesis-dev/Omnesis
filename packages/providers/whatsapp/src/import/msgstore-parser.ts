// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { basename } from "node:path";
import Database from "better-sqlite3";
import { MESSAGE_TYPE_BY_CODE } from "./android-crypt15-constants.js";
import { columnsOf, pick } from "./sqlite-column-introspection.js";
import type { StoredMessage } from "../types.js";

/**
 * Parse a decrypted Android WhatsApp `msgstore.db` into `StoredMessage[]`,
 * streamed in batches so a large history never materializes as one array.
 *
 * WhatsApp Android has shipped two schema generations: a legacy one (table
 * `messages`, chat identity stored directly as a JID string) and a modern one
 * (table `message`, chat/sender identity normalized through a `jid` lookup
 * table). Which one a given backup has is detected once via `sqlite_master`;
 * each generation's query tolerates its own optional-column drift the same
 * way `chatstorage-parser.ts` does for iOS, via `PRAGMA table_info`.
 *
 * Both generations denormalize a reply's quoted content inline in a
 * satellite row — modern `message_quoted.message_row_id` is the replying
 * message's row id, legacy `messages.quoted_row_id` points at the
 * `messages_quotes` row — so, unlike the iOS parser, no first-pass index is
 * needed to resolve quotes, which is what lets this parser stream rather than
 * materialize. Media rows hang off `message_media.message_row_id` in both.
 * Satellite tables number their own `_id`s, so a join on `_id` would attach
 * an unrelated row.
 *
 * Schema reference: cross-checked against two independent community
 * decoders (ElDavoo/wa-crypt-tools, KnugiHK/WhatsApp-Chat-Exporter), not an
 * official WhatsApp schema dump — table/column names are the best-effort
 * understanding documented in the PR, not a guarantee across every Android
 * release. An unrecognized schema (neither `message` nor `messages` present)
 * fails closed with {@link UnsupportedSchemaError} rather than guessing.
 *
 * Reactions (`message_add_on`/`message_add_on_reaction`, modern schema only)
 * are NOT imported in this version: those rows carry no WhatsApp-assigned
 * stanza id verified stable across schema variants, and synthesizing one
 * risks colliding with a real live-synced reaction under the `(chat_jid,
 * id)` merge key. Skipping them is the safe, explicit choice — see issue #29.
 */

export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSchemaError";
  }
}

export interface ParseMsgstoreOptions {
  /** Rows accumulated per `onBatch` call. */
  batchSize: number;
  /** Called with each filled batch (and once more with any remainder). */
  onBatch: (messages: StoredMessage[]) => void;
}

export interface ParseMsgstoreResult {
  /** Rows skipped: missing stable id / chat / valid date, or an intra-import duplicate. */
  skipped: number;
}

function tableNames(db: Database.Database): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

type SchemaGeneration = "legacy" | "modern";

function detectSchemaGeneration(db: Database.Database): SchemaGeneration {
  const tables = tableNames(db);
  if (tables.has("message")) return "modern";
  if (tables.has("messages")) return "legacy";
  throw new UnsupportedSchemaError(
    "Neither the modern `message` table nor the legacy `messages` table was found — " +
      "unrecognized msgstore.db schema.",
  );
}

interface CommonRow {
  pk: number;
  key_id: string | null;
  chat_jid: string | null;
  from_me: number | null;
  ts_ms: number | null;
  msg_type: number | null;
  text: string | null;
  sender_jid: string | null;
  quoted_key_id: string | null;
  quoted_text: string | null;
  quoted_sender_jid: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_size: number | null;
  lat: number | null;
  lon: number | null;
}

function localPart(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? jid;
}

function buildMedia(r: CommonRow): StoredMessage["media"] | undefined {
  const hasSize = r.media_size != null && r.media_size > 0;
  if (!r.media_path && !r.media_mime && !hasSize) return undefined;
  return {
    mimetype: r.media_mime ?? undefined,
    filename: r.media_path ? basename(r.media_path) : undefined,
    fileLength: hasSize ? r.media_size! : undefined,
  };
}

/**
 * Fallback type for a `msg_type` not in {@link MESSAGE_TYPE_BY_CODE}. Less
 * signal is available here than on iOS (no media-item row to fall back to),
 * so this stays deliberately conservative: a genuine non-zero coordinate is
 * a location, a present media path is generic media, else `unknown:<code>`.
 */
function inferType(r: CommonRow): string {
  if (r.lat != null && r.lon != null && (r.lat !== 0 || r.lon !== 0)) return "location";
  if (r.media_path) return "media";
  return `unknown:${r.msg_type ?? "?"}`;
}

function resolveType(r: CommonRow): string {
  if (r.msg_type != null && MESSAGE_TYPE_BY_CODE[r.msg_type] != null) {
    return MESSAGE_TYPE_BY_CODE[r.msg_type];
  }
  return inferType(r);
}

/** No contact-name table is read here (unverified across schema variants) — the JID's local part is the display name. */
function resolveSender(
  r: CommonRow,
  own: { jid: string; name: string },
): { jid: string; name: string } {
  if (r.from_me) return { jid: own.jid, name: own.name };
  const jid = r.sender_jid ?? r.chat_jid ?? "";
  return { jid, name: localPart(jid) };
}

function toRow(r: CommonRow, own: { jid: string; name: string }): StoredMessage | null {
  if (!r.key_id || !r.chat_jid || r.ts_ms == null || r.ts_ms <= 0) return null;
  const { jid: senderJid, name: senderName } = resolveSender(r, own);
  const type = resolveType(r);
  const msg: StoredMessage = {
    id: r.key_id,
    chatJid: r.chat_jid,
    senderJid,
    senderName,
    fromMe: !!r.from_me,
    timestamp: Math.floor(r.ts_ms / 1000),
    type,
    text: r.text ?? "",
  };
  const media = buildMedia(r);
  if (media) msg.media = media;
  if (type === "deleted") msg.deleted = true;
  if (r.quoted_key_id) {
    msg.quotedText = r.quoted_text ?? "";
    msg.quotedSender = r.quoted_sender_jid ? localPart(r.quoted_sender_jid) : undefined;
  }
  return msg;
}

function buildLegacyQuery(db: Database.Database): string {
  const m = columnsOf(db, "messages");
  const hasQuotes = tableNames(db).has("messages_quotes") && m.has("quoted_row_id");
  const mq = hasQuotes ? columnsOf(db, "messages_quotes") : new Set<string>();
  const mm = tableNames(db).has("message_media")
    ? columnsOf(db, "message_media")
    : new Set<string>();
  const hasMedia = mm.has("message_row_id");
  // A media row's caption lives in `media_caption`; `data` is empty on it.
  const data = m.has("data") ? "m.data" : "NULL";
  const text = m.has("media_caption")
    ? `COALESCE(NULLIF(${data}, ''), m.media_caption, ${data})`
    : data;

  return `
    SELECT
      m._id             AS pk,
      ${pick(true, m, "m", "key_id", "key_id")},
      ${pick(true, m, "m", "key_remote_jid", "chat_jid")},
      ${pick(true, m, "m", "key_from_me", "from_me")},
      CAST(${m.has("timestamp") ? "m.timestamp" : "NULL"} AS INTEGER) AS ts_ms,
      ${pick(true, m, "m", "media_wa_type", "msg_type")},
      ${text} AS text,
      ${pick(true, m, "m", "remote_resource", "sender_jid")},
      ${pick(hasQuotes, mq, "mq", "key_id", "quoted_key_id")},
      ${pick(hasQuotes, mq, "mq", "data", "quoted_text")},
      ${pick(hasQuotes, mq, "mq", "remote_resource", "quoted_sender_jid")},
      ${pick(hasMedia, mm, "mm", "file_path", "media_path")},
      ${pick(hasMedia, mm, "mm", "mime_type", "media_mime")},
      ${pick(hasMedia, mm, "mm", "file_size", "media_size")},
      ${pick(true, m, "m", "latitude", "lat")},
      ${pick(true, m, "m", "longitude", "lon")}
    FROM messages m
      ${hasQuotes ? "LEFT JOIN messages_quotes mq ON mq._id = m.quoted_row_id" : ""}
      ${hasMedia ? "LEFT JOIN message_media mm ON mm.message_row_id = m._id" : ""}
    ORDER BY m.timestamp ASC
  `;
}

function buildModernQuery(db: Database.Database): string {
  const msg = columnsOf(db, "message");
  const hasQuoted = tableNames(db).has("message_quoted");
  const mq = hasQuoted ? columnsOf(db, "message_quoted") : new Set<string>();
  const hasMedia = tableNames(db).has("message_media");
  const mm = hasMedia ? columnsOf(db, "message_media") : new Set<string>();

  return `
    SELECT
      msg._id                AS pk,
      ${pick(true, msg, "msg", "key_id", "key_id")},
      cjid.raw_string         AS chat_jid,
      ${pick(true, msg, "msg", "from_me", "from_me")},
      CAST(${msg.has("timestamp") ? "msg.timestamp" : "NULL"} AS INTEGER) AS ts_ms,
      ${pick(true, msg, "msg", "message_type", "msg_type")},
      ${pick(true, msg, "msg", "text_data", "text")},
      sjid.raw_string         AS sender_jid,
      ${pick(hasQuoted, mq, "mq", "key_id", "quoted_key_id")},
      ${pick(hasQuoted, mq, "mq", "text_data", "quoted_text")},
      ${hasQuoted ? "qjid.raw_string" : "NULL"} AS quoted_sender_jid,
      ${pick(hasMedia, mm, "mm", "file_path", "media_path")},
      ${pick(hasMedia, mm, "mm", "mime_type", "media_mime")},
      ${pick(hasMedia, mm, "mm", "file_size", "media_size")},
      NULL AS lat,
      NULL AS lon
    FROM message msg
      INNER JOIN chat ON chat._id = msg.chat_row_id
      INNER JOIN jid cjid ON cjid._id = chat.jid_row_id
      LEFT JOIN jid sjid ON sjid._id = msg.sender_jid_row_id
      ${hasQuoted ? "LEFT JOIN message_quoted mq ON mq.message_row_id = msg._id" : ""}
      ${hasQuoted ? "LEFT JOIN jid qjid ON qjid._id = mq.sender_jid_row_id" : ""}
      ${hasMedia ? "LEFT JOIN message_media mm ON mm.message_row_id = msg._id" : ""}
    ORDER BY msg.timestamp ASC
  `;
}

/**
 * Parse `dbPath` (a decrypted Android `msgstore.db`), invoking `onBatch` with
 * each full batch of `StoredMessage`s as rows stream past, rather than
 * materializing the whole history as one array.
 * @throws {UnsupportedSchemaError} neither known schema generation is present
 */
export function parseMsgstore(
  dbPath: string,
  own: { jid: string; name: string },
  opts: ParseMsgstoreOptions,
): ParseMsgstoreResult {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const generation = detectSchemaGeneration(db);
    const query = generation === "legacy" ? buildLegacyQuery(db) : buildModernQuery(db);
    const iterator = db.prepare(query).iterate() as IterableIterator<CommonRow>;

    const seen = new Set<string>();
    let skipped = 0;
    let batch: StoredMessage[] = [];

    for (const r of iterator) {
      const msg = toRow(r, own);
      if (!msg) {
        skipped++;
        continue;
      }
      const key = `${msg.chatJid} ${msg.id}`;
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      batch.push(msg);
      if (batch.length >= opts.batchSize) {
        opts.onBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) opts.onBatch(batch);

    return { skipped };
  } finally {
    db.close();
  }
}
