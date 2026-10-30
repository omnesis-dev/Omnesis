// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Test-only builder for a synthetic ENCRYPTED Android crypt15 backup. It
 * mirrors the exact crypto the production decryptor inverts — key
 * derivation (HMAC-SHA256 twice), a hand-encoded BackupPrefix protobuf
 * header carrying the GCM IV, AES-256-GCM over a zlib-compressed payload,
 * and the trailing plain MD5 checksum — so a round-trip test (build →
 * decrypt → assert bytes identical) validates the algorithm with zero
 * real-device data. NOT shipped in production paths.
 */

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import Database from "better-sqlite3";
import { deriveAesKey } from "../android-backup-decrypt.js";
import { GCM_IV_LEN, ROOT_KEY_LEN } from "../android-crypt15-constants.js";

// ─────────────────────────────── protobuf writer ──────────────────────────────

function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

/** Encodes one length-delimited (wire type 2) protobuf field. */
function encodeLengthDelimited(fieldNumber: number, data: Buffer): Buffer {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  return Buffer.concat([tag, encodeVarint(data.length), data]);
}

/**
 * Builds the `[varint header_len][optional features flag][BackupPrefix protobuf]`
 * header carrying `iv`. `paddingBytes` adds an unrelated length-delimited
 * field, as real headers carry (app version, feature bits), so a test can
 * reach a 128+ byte header.
 */
function buildCrypt15Header(iv: Buffer, featuresFlag: boolean, paddingBytes: number): Buffer {
  const c15iv = encodeLengthDelimited(1, iv); // C15IV.encryption_iv
  const header = Buffer.concat([
    encodeLengthDelimited(3, c15iv), // BackupPrefix.e2ee_key_data
    ...(paddingBytes > 0 ? [encodeLengthDelimited(5, Buffer.alloc(paddingBytes, 0x61))] : []),
  ]);
  return Buffer.concat([
    encodeVarint(header.length),
    ...(featuresFlag ? [Buffer.from([0x01])] : []),
    header,
  ]);
}

// ───────────────────────────── msgstore.db corpus ──────────────────────────────

export interface AndroidFixtureChat {
  id: number;
  jid: string;
}
export interface AndroidFixtureMessage {
  id: number;
  keyId: string;
  chatId: number;
  fromMe: 0 | 1;
  /** Unix milliseconds. */
  tsMs: number;
  type: number;
  text: string | null;
  /** Sender JID for a group message not sent by me. */
  senderJid?: string;
  /** A media message's caption: `text_data` on the modern schema, `media_caption` on the legacy one. */
  caption?: string;
  quoted?: { keyId: string; text: string; senderJid?: string };
  media?: { filePath?: string; mimeType?: string; fileSize?: number };
  lat?: number;
  lon?: number;
}
export interface AndroidFixtureCorpus {
  chats: AndroidFixtureChat[];
  messages: AndroidFixtureMessage[];
}

/**
 * Build an Android WhatsApp `msgstore.db` and return its bytes.
 *
 * `schema` selects which generation to emit:
 * - `"modern"` (default): `message`/`chat`/`jid`/`message_quoted`/`message_media`.
 * - `"legacy"`: `messages`/`messages_quotes`/`message_media`, with the chat JID
 *   stored directly on the message row (no `jid` lookup table). A quote row is
 *   reached through `messages.quoted_row_id` and a media row through
 *   `message_media.message_row_id`; both satellite tables number their own
 *   `_id`s from 1, so they collide with unrelated message ids the way a real
 *   database's do, and a join on `_id` attaches the wrong row.
 */
export function buildMsgstoreDb(
  corpus: AndroidFixtureCorpus,
  opts: { schema?: "modern" | "legacy" } = {},
): Buffer {
  const modern = (opts.schema ?? "modern") === "modern";
  const dir = mkdtempSync(join(tmpdir(), "omnesis-wa-android-fixdb-"));
  const path = join(dir, "msgstore.db");
  const db = new Database(path);
  try {
    const chatById = new Map(corpus.chats.map((c) => [c.id, c]));

    if (modern) {
      db.exec(`
        CREATE TABLE jid (_id INTEGER PRIMARY KEY, raw_string TEXT, type INTEGER);
        CREATE TABLE chat (_id INTEGER PRIMARY KEY, jid_row_id INTEGER, subject TEXT);
        CREATE TABLE message (
          _id INTEGER PRIMARY KEY, key_id TEXT, chat_row_id INTEGER, sender_jid_row_id INTEGER,
          from_me INTEGER, timestamp INTEGER, message_type INTEGER, text_data TEXT
        );
        CREATE TABLE message_quoted (
          message_row_id INTEGER, key_id TEXT, text_data TEXT, sender_jid_row_id INTEGER
        );
        CREATE TABLE message_media (
          message_row_id INTEGER, file_path TEXT, mime_type TEXT, file_size INTEGER
        );
      `);

      const jidRowByString = new Map<string, number>();
      let nextJidPk = 1;
      const jidIns = db.prepare(`INSERT INTO jid (_id, raw_string, type) VALUES (?,?,?)`);
      const internJid = (jidStr: string): number => {
        const existing = jidRowByString.get(jidStr);
        if (existing != null) return existing;
        const pk = nextJidPk++;
        jidIns.run(pk, jidStr, jidStr.endsWith("@g.us") ? 1 : 0);
        jidRowByString.set(jidStr, pk);
        return pk;
      };

      const chatIns = db.prepare(`INSERT INTO chat (_id, jid_row_id, subject) VALUES (?,?,?)`);
      for (const c of corpus.chats) chatIns.run(c.id, internJid(c.jid), null);

      const msgIns = db.prepare(`
        INSERT INTO message (_id, key_id, chat_row_id, sender_jid_row_id, from_me, timestamp, message_type, text_data)
        VALUES (?,?,?,?,?,?,?,?)
      `);
      const quoteIns = db.prepare(`
        INSERT INTO message_quoted (message_row_id, key_id, text_data, sender_jid_row_id) VALUES (?,?,?,?)
      `);
      const mediaIns = db.prepare(`
        INSERT INTO message_media (message_row_id, file_path, mime_type, file_size) VALUES (?,?,?,?)
      `);

      for (const m of corpus.messages) {
        const senderRowId = m.senderJid != null ? internJid(m.senderJid) : null;
        msgIns.run(
          m.id,
          m.keyId,
          m.chatId,
          senderRowId,
          m.fromMe,
          m.tsMs,
          m.type,
          m.caption ?? m.text,
        );
        if (m.quoted) {
          quoteIns.run(
            m.id,
            m.quoted.keyId,
            m.quoted.text,
            m.quoted.senderJid != null ? internJid(m.quoted.senderJid) : null,
          );
        }
        if (m.media) {
          mediaIns.run(
            m.id,
            m.media.filePath ?? null,
            m.media.mimeType ?? null,
            m.media.fileSize ?? 0,
          );
        }
      }
    } else {
      db.exec(`
        CREATE TABLE messages (
          _id INTEGER PRIMARY KEY, key_id TEXT, key_remote_jid TEXT, key_from_me INTEGER,
          timestamp INTEGER, media_wa_type INTEGER, data TEXT, media_caption TEXT,
          remote_resource TEXT, quoted_row_id INTEGER, latitude REAL, longitude REAL
        );
        CREATE TABLE messages_quotes (
          _id INTEGER PRIMARY KEY, key_id TEXT, data TEXT, remote_resource TEXT
        );
        CREATE TABLE message_media (
          _id INTEGER PRIMARY KEY, message_row_id INTEGER, file_path TEXT, mime_type TEXT,
          file_size INTEGER
        );
      `);
      const msgIns = db.prepare(`
        INSERT INTO messages (_id, key_id, key_remote_jid, key_from_me, timestamp, media_wa_type, data, media_caption, remote_resource, quoted_row_id, latitude, longitude)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const quoteIns = db.prepare(
        `INSERT INTO messages_quotes (key_id, data, remote_resource) VALUES (?,?,?)`,
      );
      const mediaIns = db.prepare(
        `INSERT INTO message_media (message_row_id, file_path, mime_type, file_size) VALUES (?,?,?,?)`,
      );
      for (const m of corpus.messages) {
        const chat = chatById.get(m.chatId);
        const quotedRowId = m.quoted
          ? quoteIns.run(m.quoted.keyId, m.quoted.text, m.quoted.senderJid ?? null).lastInsertRowid
          : null;
        msgIns.run(
          m.id,
          m.keyId,
          chat?.jid ?? null,
          m.fromMe,
          m.tsMs,
          m.type,
          m.text,
          m.caption ?? null,
          m.senderJid ?? null,
          quotedRowId,
          m.lat ?? 0,
          m.lon ?? 0,
        );
        if (m.media) {
          mediaIns.run(
            m.id,
            m.media.filePath ?? null,
            m.media.mimeType ?? null,
            m.media.fileSize ?? 0,
          );
        }
      }
    }
    db.close();
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────── encrypted backup builder ─────────────────────────

/**
 * Build a crypt15-encrypted Android backup file whose decrypted contents are
 * `msgstoreBytes`. Returns the file path and the 64-hex root key that
 * decrypts it (what `resolveRootKey`/`deriveAesKey` expect). By default the
 * header carries the features flag, as `msgstore.db.crypt15` does.
 */
export function makeEncryptedAndroidBackup(opts: {
  msgstoreBytes: Buffer;
  featuresFlag?: boolean;
  headerPaddingBytes?: number;
}): {
  filePath: string;
  keyHex: string;
} {
  const rootKey = randomBytes(ROOT_KEY_LEN);
  const aesKey = deriveAesKey(rootKey);
  const iv = randomBytes(GCM_IV_LEN);

  const compressed = deflateSync(opts.msgstoreBytes);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  const header = buildCrypt15Header(iv, opts.featuresFlag ?? true, opts.headerPaddingBytes ?? 0);
  const body = Buffer.concat([header, ciphertext, tag]);
  const checksum = createHash("md5").update(body).digest();
  const fileBytes = Buffer.concat([body, checksum]);

  const dir = mkdtempSync(join(tmpdir(), "omnesis-wa-android-backup-"));
  const filePath = join(dir, "msgstore.db.crypt15");
  writeFileSync(filePath, fileBytes);

  return { filePath, keyHex: rootKey.toString("hex") };
}
