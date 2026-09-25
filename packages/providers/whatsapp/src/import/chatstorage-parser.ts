// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { basename, extname } from "node:path";
import Database from "better-sqlite3";
import { APPLE_EPOCH_OFFSET, MESSAGE_TYPE_BY_CODE } from "./constants.js";
import type { StoredMessage } from "../types.js";

/**
 * Parse a decrypted WhatsApp iOS `ChatStorage.sqlite` into `StoredMessage[]`.
 *Pure: opens the DB read-only and maps each `ZWAMESSAGE` row, joining
 * its chat session, group member, and media item.
 *
 * The ChatStorage schema differs across WhatsApp iOS releases — some columns
 * (`ZFROMJID`, `ZPUSHNAME`, `ZPARENTMESSAGE`) are present only on newer builds.
 * The query is therefore assembled from the table's *actual* columns: a missing
 * optional column is selected as `NULL` rather than failing the whole import.
 *
 * `own` supplies the account's JID + display name for `from_me` rows (the DB
 * stores those without a sender). Schema reference: KnugiHK/WhatsApp-Chat-Exporter
 * (ios_handler.py). Cocoa timestamps are converted to Unix seconds via
 * `+APPLE_EPOCH_OFFSET`.
 */

export interface ParseResult {
  messages: StoredMessage[];
  /** Rows skipped: missing stable id / chat / valid date, or an intra-import duplicate. */
  skipped: number;
}

interface Row {
  pk: number;
  wa_id: string | null;
  chat_jid: string | null;
  from_me: number | null;
  mac_ts: number | null;
  msg_type: number | null;
  text: string | null;
  from_jid: string | null;
  push_name: string | null;
  parent_pk: number | null;
  member_jid: string | null;
  member_name: string | null;
  partner_name: string | null;
  media_pk: number | null;
  media_path: string | null;
  media_title: string | null;
  media_size: number | null;
  media_duration: number | null;
  lat: number | null;
  lon: number | null;
}

function columnsOf(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Build the message-extraction query against the columns this DB actually has.
 * `m.<col>` is emitted when present, else `NULL`, so an older/newer ChatStorage
 * missing an optional column still parses. Joins to optional tables/columns are
 * guarded the same way.
 */
function buildQuery(db: Database.Database): string {
  const m = columnsOf(db, "ZWAMESSAGE");
  const cs = columnsOf(db, "ZWACHATSESSION");
  const gm = columnsOf(db, "ZWAGROUPMEMBER");
  const mi = columnsOf(db, "ZWAMEDIAITEM");

  const hasGroupMember = m.has("ZGROUPMEMBER") && gm.size > 0;
  const hasMedia = mi.size > 0;

  // Emit `alias.col` when the join is present AND the column exists, else `NULL`.
  // `joined` guards against referencing an alias that isn't in the FROM clause.
  const pick = (
    joined: boolean,
    cols: Set<string>,
    alias: string,
    col: string,
    out: string,
  ): string => `${joined && cols.has(col) ? `${alias}.${col}` : "NULL"} AS ${out}`;

  return `
    SELECT
      m.Z_PK            AS pk,
      ${pick(true, m, "m", "ZSTANZAID", "wa_id")},
      ${pick(true, cs, "cs", "ZCONTACTJID", "chat_jid")},
      ${pick(true, m, "m", "ZISFROMME", "from_me")},
      CAST(m.ZMESSAGEDATE AS INTEGER) AS mac_ts,
      ${pick(true, m, "m", "ZMESSAGETYPE", "msg_type")},
      ${pick(true, m, "m", "ZTEXT", "text")},
      ${pick(true, m, "m", "ZFROMJID", "from_jid")},
      ${pick(true, m, "m", "ZPUSHNAME", "push_name")},
      ${pick(true, m, "m", "ZPARENTMESSAGE", "parent_pk")},
      ${pick(hasGroupMember, gm, "gm", "ZMEMBERJID", "member_jid")},
      ${pick(hasGroupMember, gm, "gm", "ZCONTACTNAME", "member_name")},
      ${pick(true, cs, "cs", "ZPARTNERNAME", "partner_name")},
      ${pick(hasMedia, mi, "mi", "Z_PK", "media_pk")},
      ${pick(hasMedia, mi, "mi", "ZMEDIALOCALPATH", "media_path")},
      ${pick(hasMedia, mi, "mi", "ZTITLE", "media_title")},
      ${pick(hasMedia, mi, "mi", "ZFILESIZE", "media_size")},
      ${pick(hasMedia, mi, "mi", "ZMOVIEDURATION", "media_duration")},
      ${pick(hasMedia, mi, "mi", "ZLATITUDE", "lat")},
      ${pick(hasMedia, mi, "mi", "ZLONGITUDE", "lon")}
    FROM ZWAMESSAGE m
      INNER JOIN ZWACHATSESSION cs ON m.ZCHATSESSION = cs.Z_PK
      ${hasGroupMember ? "LEFT JOIN ZWAGROUPMEMBER gm ON m.ZGROUPMEMBER = gm.Z_PK" : ""}
      ${hasMedia ? "LEFT JOIN ZWAMEDIAITEM mi ON mi.ZMESSAGE = m.Z_PK" : ""}
    ORDER BY m.ZMESSAGEDATE ASC
  `;
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".pdf": "application/pdf",
};

function localPart(jid: string): string {
  return jid.split("@")[0].split(":")[0];
}

/**
 * Fallback type for a `ZMESSAGETYPE` not in {@link MESSAGE_TYPE_BY_CODE}.
 *
 * Inference is deliberately conservative because ChatStorage stores defaulted
 * zeros, not NULLs: `ZLATITUDE`/`ZLONGITUDE` are `0.0` on *every* media item and
 * `ZVCARDSTRING` is populated far beyond actual contact cards, so neither is a
 * reliable type signal on its own. Only a genuine non-zero coordinate counts as
 * a location; a local file path counts as a document; a message that still has a
 * media item (newer media kinds, or media whose file is no longer downloaded) is
 * a generic `"media"`; everything else stays `unknown:<code>`.
 */
function inferType(r: Row): string {
  if (r.lat != null && r.lon != null && (r.lat !== 0 || r.lon !== 0)) return "location";
  if (r.media_path) return "document";
  if (r.media_pk != null) return "media";
  return `unknown:${r.msg_type ?? "?"}`;
}

/** Resolve a row's generic message type: map the known code, else infer. */
function resolveType(r: Row): string {
  if (r.msg_type != null && MESSAGE_TYPE_BY_CODE[r.msg_type] != null) {
    return MESSAGE_TYPE_BY_CODE[r.msg_type];
  }
  return inferType(r);
}

function buildMedia(r: Row): StoredMessage["media"] | undefined {
  // ZFILESIZE / ZMOVIEDURATION default to 0 (not NULL) on link-preview and other
  // non-file media items, so treat 0 as "absent" — otherwise nearly every text
  // message would carry an empty media block.
  const hasSize = r.media_size != null && r.media_size > 0;
  const hasDuration = r.media_duration != null && r.media_duration > 0;
  if (!r.media_path && !hasSize && !hasDuration) return undefined;
  // Prefer ZTITLE (the original, user-facing name — e.g. "report.pdf") over the
  // hashed local cache path basename for the displayed filename.
  const filename =
    r.media_title ?? (r.media_path ? basename(r.media_path) : undefined) ?? undefined;
  const ext = filename ? extname(filename).toLowerCase() : "";
  return {
    mimetype: MIME_BY_EXT[ext] || undefined,
    filename,
    fileLength: hasSize ? r.media_size! : undefined,
    seconds: hasDuration ? r.media_duration! : undefined,
  };
}

/** Resolve a row's sender JID + display name (own account for `from_me`). */
function resolveSender(r: Row, own: { jid: string; name: string }): { jid: string; name: string } {
  if (r.from_me) return { jid: own.jid, name: own.name };
  if (r.chat_jid?.endsWith("@g.us")) {
    const jid = r.member_jid ?? r.from_jid ?? r.chat_jid ?? "";
    return { jid, name: r.member_name ?? r.push_name ?? localPart(jid) };
  }
  const jid = r.chat_jid ?? r.from_jid ?? "";
  return { jid, name: r.partner_name ?? r.push_name ?? localPart(jid) };
}

export function parseChatStorage(dbPath: string, own: { jid: string; name: string }): ParseResult {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(buildQuery(db)).all() as Row[];

    // First pass: index every row by its primary key so a reply (ZPARENTMESSAGE
    // -> Z_PK) can resolve the quoted message's text + sender. Indexed over all
    // rows (even ones later skipped) so a reply to a skip-eligible parent still
    // resolves.
    const byPk = new Map<number, { text: string; sender: string }>();
    for (const r of rows) {
      byPk.set(r.pk, { text: r.text ?? "", sender: resolveSender(r, own).name });
    }

    const messages: StoredMessage[] = [];
    const seen = new Set<string>();
    let skipped = 0;

    for (const r of rows) {
      // Skip rows we can't safely store: no stable id (can't dedup/merge), no
      // chat, or no valid date (a NULL/0 ZMESSAGEDATE would land on 2001-01-01).
      if (!r.wa_id || !r.chat_jid || r.mac_ts == null || r.mac_ts <= 0) {
        skipped++;
        continue;
      }
      // Drop intra-import duplicate (chat_jid, id) so the merge tally is exact.
      const key = `${r.chat_jid} ${r.wa_id}`;
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);

      const { jid: senderJid, name: senderName } = resolveSender(r, own);
      const type = resolveType(r);

      const msg: StoredMessage = {
        id: r.wa_id,
        chatJid: r.chat_jid,
        senderJid,
        senderName,
        fromMe: !!r.from_me,
        timestamp: r.mac_ts + APPLE_EPOCH_OFFSET,
        type,
        text: r.text ?? "",
      };

      const media = buildMedia(r);
      if (media) msg.media = media;
      if (type === "deleted") msg.deleted = true;

      // Reply pointer: ZPARENTMESSAGE is a foreign key to the quoted row's Z_PK.
      if (r.parent_pk != null) {
        const quoted = byPk.get(r.parent_pk);
        if (quoted) {
          msg.quotedText = quoted.text;
          msg.quotedSender = quoted.sender;
        }
      }

      messages.push(msg);
    }

    return { messages, skipped };
  } finally {
    db.close();
  }
}
