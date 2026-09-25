// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Test-only builder for a synthetic ENCRYPTED iOS backup. It mirrors the
 * exact crypto the production decryptor inverts — keybag TLV, double-PBKDF2 KEK,
 * RFC-3394 wrap, AES-CBC, NSKeyedArchiver file BLOB — so a round-trip test
 * (build → decrypt → assert bytes identical) validates the algorithm with zero
 * real-device data. NOT shipped in production paths.
 */

import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CHATSTORAGE_FILEID, CHATSTORAGE_RELPATH, WHATSAPP_DOMAIN, ZERO_IV } from "../constants.js";
import { aesWrap, derivePassphraseKey } from "../keybag.js";

// ─────────────────────────────── bplist writer ────────────────────────────────

interface Uid {
  __uid: number;
}
type PValue = string | number | Buffer | Date | Uid | PValue[] | { [k: string]: PValue };
const uid = (n: number): Uid => ({ __uid: n });
const isUid = (v: unknown): v is Uid =>
  typeof v === "object" && v !== null && typeof (v as Uid).__uid === "number";

/** Serialize a JS value tree (UIDs as `{__uid}`, Buffers as data, Dates as NSDate) to `bplist00`. */
export function writeBplist(root: PValue): Buffer {
  const order: PValue[] = [];
  const idxMap = new Map<PValue, number>();
  const assign = (v: PValue): number => {
    if (idxMap.has(v)) return idxMap.get(v) as number;
    const idx = order.length;
    idxMap.set(v, idx);
    order.push(v);
    if (Array.isArray(v)) v.forEach(assign);
    else if (
      !isUid(v) &&
      !Buffer.isBuffer(v) &&
      !(v instanceof Date) &&
      typeof v === "object" &&
      v !== null
    ) {
      for (const k of Object.keys(v)) {
        assign(k);
        assign((v as Record<string, PValue>)[k]);
      }
    }
    return idx;
  };
  assign(root);

  const refSize = order.length < 256 ? 1 : order.length < 65536 ? 2 : 4;
  const ref = (idx: number): Buffer => {
    const b = Buffer.alloc(refSize);
    b.writeUIntBE(idx, 0, refSize);
    return b;
  };
  const encInt = (n: number): Buffer => {
    const len = n < 0x100 ? 1 : n < 0x10000 ? 2 : n < 0x1_0000_0000 ? 4 : 8;
    const log2 = len === 1 ? 0 : len === 2 ? 1 : len === 4 ? 2 : 3;
    const b = Buffer.alloc(1 + len);
    b[0] = 0x10 | log2;
    if (len <= 6) b.writeUIntBE(n, 1, len);
    else b.writeBigUInt64BE(BigInt(n), 1);
    return b;
  };
  const lenHeader = (marker: number, count: number): Buffer =>
    count < 15
      ? Buffer.from([marker | count])
      : Buffer.concat([Buffer.from([marker | 0x0f]), encInt(count)]);

  const encodeOne = (v: PValue): Buffer => {
    if (typeof v === "string")
      return Buffer.concat([lenHeader(0x50, v.length), Buffer.from(v, "ascii")]);
    if (Buffer.isBuffer(v)) return Buffer.concat([lenHeader(0x40, v.length), v]);
    if (v instanceof Date) {
      // NSDate: marker 0x33 + 8-byte big-endian double of seconds since the
      // Cocoa epoch (2001-01-01 UTC).
      const b = Buffer.alloc(9);
      b[0] = 0x33;
      b.writeDoubleBE(v.getTime() / 1000 - APPLE_OFFSET, 1);
      return b;
    }
    if (isUid(v)) {
      const n = v.__uid;
      const len = n < 0x100 ? 1 : n < 0x10000 ? 2 : 4;
      const b = Buffer.alloc(1 + len);
      b[0] = 0x80 | (len - 1);
      b.writeUIntBE(n, 1, len);
      return b;
    }
    if (typeof v === "number") return encInt(v);
    if (Array.isArray(v))
      return Buffer.concat([
        lenHeader(0xa0, v.length),
        ...v.map((e) => ref(idxMap.get(e) as number)),
      ]);
    const keys = Object.keys(v);
    return Buffer.concat([
      lenHeader(0xd0, keys.length),
      ...keys.map((k) => ref(idxMap.get(k) as number)),
      ...keys.map((k) => ref(idxMap.get((v as Record<string, PValue>)[k]) as number)),
    ]);
  };

  let body = Buffer.from("bplist00", "ascii");
  const offsets: number[] = [];
  for (const v of order) {
    offsets.push(body.length);
    body = Buffer.concat([body, encodeOne(v)]);
  }
  const offsetTableOffset = body.length;
  const offsetSize = offsetTableOffset < 256 ? 1 : offsetTableOffset < 65536 ? 2 : 4;
  for (const o of offsets) {
    const b = Buffer.alloc(offsetSize);
    b.writeUIntBE(o, 0, offsetSize);
    body = Buffer.concat([body, b]);
  }
  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(offsetSize, 6);
  trailer.writeUInt8(refSize, 7);
  trailer.writeBigUInt64BE(BigInt(order.length), 8);
  trailer.writeBigUInt64BE(0n, 16); // top object index
  trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);
  return Buffer.concat([body, trailer]);
}

// ───────────────────────────── ChatStorage corpus ─────────────────────────────

export interface FixtureMessage {
  pk: number;
  stanzaId: string;
  chatPk: number;
  fromMe: 0 | 1;
  /** Unix seconds (converted to Cocoa time on write). */
  ts: number;
  type: number;
  text: string | null;
  groupMemberPk?: number;
  /** ZFROMJID — the message-level sender JID (newer schemas). */
  fromJid?: string;
  /** ZPUSHNAME — the message-level sender push name (newer schemas). */
  pushName?: string;
  /** ZPARENTMESSAGE — reply FK to the quoted message's `pk` (newer schemas). */
  parentPk?: number;
  /** ZGROUPEVENTTYPE — non-zero on many ordinary messages; must NOT drive typing. */
  groupEvent?: number;
  media?: {
    localPath?: string;
    title?: string;
    size?: number;
    duration?: number;
    lat?: number;
    lon?: number;
    vcard?: string;
  };
}
export interface FixtureChat {
  pk: number;
  contactJid: string;
  partnerName: string;
}
export interface FixtureGroupMember {
  pk: number;
  memberJid: string;
  contactName: string;
}
export interface FixtureCorpus {
  chats: FixtureChat[];
  members: FixtureGroupMember[];
  messages: FixtureMessage[];
}

const APPLE_OFFSET = 978_307_200;

/**
 * Build a WhatsApp iOS `ChatStorage.sqlite` and return its bytes.
 *
 * `schema` selects which `ZWAMESSAGE` shape to emit:
 * - `"modern"` (default) mirrors a recent build — `ZFROMJID`, `ZPUSHNAME`,
 *   `ZPARENTMESSAGE`, `ZGROUPEVENTTYPE` present.
 * - `"legacy"` omits those optional columns, so the parser's column
 *   introspection (NULL-filling absent columns) is exercised.
 *
 * Media columns are written with zero defaults (not NULL), matching real
 * ChatStorage where `ZFILESIZE`/`ZMOVIEDURATION`/`ZLATITUDE`/`ZLONGITUDE` are
 * `0` on non-file/non-location items.
 */
export function buildChatStorageDb(
  corpus: FixtureCorpus,
  opts: { schema?: "modern" | "legacy" } = {},
): Buffer {
  const modern = (opts.schema ?? "modern") === "modern";
  const dir = mkdtempSync(join(tmpdir(), "omnesis-wa-fixdb-"));
  const path = join(dir, "ChatStorage.sqlite");
  const db = new Database(path);
  try {
    const optionalCols = modern
      ? ", ZFROMJID TEXT, ZPUSHNAME TEXT, ZPARENTMESSAGE INTEGER, ZGROUPEVENTTYPE INTEGER"
      : "";
    db.exec(`
      CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
      CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT);
      CREATE TABLE ZWAMESSAGE (
        Z_PK INTEGER PRIMARY KEY, ZSTANZAID TEXT, ZISFROMME INTEGER, ZMESSAGEDATE REAL,
        ZMESSAGETYPE INTEGER, ZTEXT TEXT, ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER${optionalCols}
      );
      CREATE TABLE ZWAMEDIAITEM (
        Z_PK INTEGER PRIMARY KEY, ZMESSAGE INTEGER, ZMEDIALOCALPATH TEXT, ZVCARDSTRING TEXT,
        ZTITLE TEXT, ZFILESIZE INTEGER, ZMOVIEDURATION REAL, ZLATITUDE REAL, ZLONGITUDE REAL
      );
    `);
    const cs = db.prepare(
      `INSERT INTO ZWACHATSESSION (Z_PK, ZCONTACTJID, ZPARTNERNAME) VALUES (?,?,?)`,
    );
    for (const c of corpus.chats) cs.run(c.pk, c.contactJid, c.partnerName);
    const gm = db.prepare(
      `INSERT INTO ZWAGROUPMEMBER (Z_PK, ZMEMBERJID, ZCONTACTNAME) VALUES (?,?,?)`,
    );
    for (const m of corpus.members) gm.run(m.pk, m.memberJid, m.contactName);

    const baseCols = [
      "Z_PK",
      "ZSTANZAID",
      "ZISFROMME",
      "ZMESSAGEDATE",
      "ZMESSAGETYPE",
      "ZTEXT",
      "ZCHATSESSION",
      "ZGROUPMEMBER",
    ];
    const msgCols = modern
      ? [...baseCols, "ZFROMJID", "ZPUSHNAME", "ZPARENTMESSAGE", "ZGROUPEVENTTYPE"]
      : baseCols;
    const msg = db.prepare(
      `INSERT INTO ZWAMESSAGE (${msgCols.join(", ")}) VALUES (${msgCols.map(() => "?").join(",")})`,
    );
    const mi = db.prepare(
      `INSERT INTO ZWAMEDIAITEM (Z_PK, ZMESSAGE, ZMEDIALOCALPATH, ZTITLE, ZFILESIZE, ZMOVIEDURATION, ZLATITUDE, ZLONGITUDE, ZVCARDSTRING)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    let mediaPk = 1;
    for (const m of corpus.messages) {
      const base = [
        m.pk,
        m.stanzaId,
        m.fromMe,
        m.ts - APPLE_OFFSET,
        m.type,
        m.text,
        m.chatPk,
        m.groupMemberPk ?? null,
      ];
      msg.run(
        modern
          ? [...base, m.fromJid ?? null, m.pushName ?? null, m.parentPk ?? null, m.groupEvent ?? 0]
          : base,
      );
      if (m.media) {
        // Zero (not NULL) defaults mirror real ChatStorage media rows.
        mi.run(
          mediaPk++,
          m.pk,
          m.media.localPath ?? null,
          m.media.title ?? null,
          m.media.size ?? 0,
          m.media.duration ?? 0,
          m.media.lat ?? 0,
          m.media.lon ?? 0,
          m.media.vcard ?? null,
        );
      }
    }
    db.close();
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────── encrypted backup builder ─────────────────────────

function aesCbcEncrypt(key: Buffer, plain: Buffer): Buffer {
  const c = createCipheriv("aes-256-cbc", key, ZERO_IV); // PKCS#7 auto-pad
  return Buffer.concat([c.update(plain), c.final()]);
}
function tlv(tag: string, data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(tag, 0, "ascii");
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}
function le32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n, 0);
  return b;
}

const PROTECTION_CLASS = 3;

/**
 * Build an encrypted-backup folder under a temp dir whose ChatStorage.sqlite is
 * `chatStorageBytes`, decryptable with `password`. Returns the backup dir.
 */
export function makeEncryptedBackup(opts: {
  chatStorageBytes: Buffer;
  password: string;
  fileID?: string;
  /** Manifest.plist serialization. Real iOS backups are binary; default mirrors that. */
  manifestFormat?: "binary" | "xml";
}): string {
  const { chatStorageBytes, password } = opts;
  const fileID = opts.fileID ?? CHATSTORAGE_FILEID;
  const manifestFormat = opts.manifestFormat ?? "binary";

  // Keybag: one passphrase-wrapped class key.
  const salt = randomBytes(20);
  const dpsl = randomBytes(32);
  const iter = 1000;
  const dpic = 1000;
  const classKey = randomBytes(32);
  const kek = derivePassphraseKey(password, {
    DPSL: dpsl,
    DPIC: u32(dpic),
    SALT: salt,
    ITER: u32(iter),
  });
  const wpky = aesWrap(kek, classKey);
  const keybag = Buffer.concat([
    tlv("VERS", u32(4)),
    tlv("TYPE", u32(1)),
    tlv("UUID", randomBytes(16)),
    tlv("HMCK", randomBytes(32)),
    tlv("WRAP", u32(0)),
    tlv("SALT", salt),
    tlv("ITER", u32(iter)),
    tlv("DPSL", dpsl),
    tlv("DPIC", u32(dpic)),
    tlv("UUID", randomBytes(16)), // starts the class-key entry
    tlv("CLAS", u32(PROTECTION_CLASS)),
    tlv("WRAP", u32(2)),
    tlv("KTYP", u32(0)),
    tlv("WPKY", wpky),
  ]);

  // Per-file key for ChatStorage, wrapped under the class key.
  const fileKey = randomBytes(32);
  const wrappedFileKey = aesWrap(classKey, fileKey);
  const fileBlob = writeBplist({
    $version: 100000,
    $archiver: "NSKeyedArchiver",
    $top: { root: uid(1) },
    $objects: [
      "$null",
      {
        Size: chatStorageBytes.length,
        ProtectionClass: PROTECTION_CLASS,
        EncryptionKey: uid(2),
        // Real file blobs carry NSDate fields (LastModified/Birth); include one
        // so the eager-graph parse exercises the date marker.
        LastModified: uid(3),
      },
      { "NS.data": Buffer.concat([le32(PROTECTION_CLASS), wrappedFileKey]) },
      new Date("2024-01-01T00:00:00.000Z"),
    ],
  });

  // Manifest.db: a SQLite Files table with the ChatStorage row.
  const dir = mkdtempSync(join(tmpdir(), "omnesis-wa-backup-"));
  const manifestDbPath = join(dir, "Manifest.db.plain");
  const mdb = new Database(manifestDbPath);
  mdb.exec(
    `CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB);`,
  );
  mdb
    .prepare(`INSERT INTO Files (fileID, domain, relativePath, flags, file) VALUES (?,?,?,?,?)`)
    .run(fileID, WHATSAPP_DOMAIN, CHATSTORAGE_RELPATH, 1, fileBlob);
  mdb.close();
  const manifestDbBytes = readFileSync(manifestDbPath);
  rmSync(manifestDbPath, { force: true });

  // Manifest.db is encrypted under its own file key, wrapped in ManifestKey.
  const manifestFileKey = randomBytes(32);
  const manifestKey = Buffer.concat([le32(PROTECTION_CLASS), aesWrap(classKey, manifestFileKey)]);
  writeFileSync(join(dir, "Manifest.db"), aesCbcEncrypt(manifestFileKey, manifestDbBytes));

  // The ChatStorage payload itself, at <dir>/<fileID[:2]>/<fileID>.
  const sub = join(dir, fileID.slice(0, 2));
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, fileID), aesCbcEncrypt(fileKey, chatStorageBytes));

  // Manifest.plist carrying the keybag + ManifestKey. Real iOS backups are
  // binary bplist00 — emit that by default so the production binary-plist read
  // path is exercised; XML is available for covering the fallback branch.
  if (manifestFormat === "binary") {
    writeFileSync(
      join(dir, "Manifest.plist"),
      // Real Manifest.plist carries a top-level `Date` (NSDate); include it so
      // the production read path parses the date marker, not just data/strings.
      writeBplist({
        BackupKeyBag: keybag,
        ManifestKey: manifestKey,
        Date: new Date("2024-01-01T00:00:00.000Z"),
      }),
    );
  } else {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>BackupKeyBag</key><data>${keybag.toString("base64")}</data>
<key>ManifestKey</key><data>${manifestKey.toString("base64")}</data>
<key>IsEncrypted</key><true/>
</dict></plist>`;
    writeFileSync(join(dir, "Manifest.plist"), plist, "utf8");
  }

  return dir;
}
