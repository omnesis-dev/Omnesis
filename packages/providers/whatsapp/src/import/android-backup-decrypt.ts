// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import {
  BACKUP_ENCRYPTION_LABEL,
  CHECKSUM_LEN,
  FIELD_C15IV_ENCRYPTION_IV,
  FIELD_E2EE_KEY_DATA,
  GCM_IV_LEN,
  GCM_TAG_LEN,
  MAX_DECOMPRESSED_BYTES,
  MAX_HEADER_LEN,
  MSGSTORE_FEATURES_FLAG,
  ROOT_KEY_HEX_LEN,
  ROOT_KEY_LEN,
  ZERO_SEED_32,
} from "./android-crypt15-constants.js";

/**
 * Decrypt an Android WhatsApp crypt15 local backup (`msgstore.db.crypt15`)
 * and recover the plaintext `msgstore.db` bytes. Pure — takes the backup
 * file path + the backup key, returns the decompressed SQLite bytes. Holds
 * ALL crypt15-format assumptions, so a real-device discrepancy is fixable
 * here alone (see the importer's risk notes).
 *
 * Container (single-file local-backup layout only):
 *   [varint header_len][optional 0x01 features flag][header_len bytes: BackupPrefix protobuf, carries the GCM IV]
 *   [ciphertext = AES-256-GCM(zlib(msgstore.db))]
 *   [16-byte GCM auth tag][16-byte MD5(every preceding byte) — plain integrity checksum]
 *
 * Key derivation (encryptionloop): privateKey = HMAC-SHA256(zero32, rootKey);
 * aesKey = HMAC-SHA256(privateKey, "backup encryption" + 0x01).
 */

/** Thrown when the supplied backup key is wrong (GCM tag verification failed). */
export class WrongBackupKeyError extends Error {
  constructor() {
    super("Incorrect backup key — could not authenticate the backup contents.");
    this.name = "WrongBackupKeyError";
  }
}

/** Thrown on a corrupt/unsupported header, unknown key representation, or chunked backup layout. */
export class UnsupportedBackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedBackupFormatError";
  }
}

/** Thrown on a truncated file or a decompressed size exceeding the safety limit. */
export class CorruptBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptBackupError";
  }
}

const JAVA_SERIALIZATION_MAGIC = Buffer.from([0xac, 0xed, 0x00, 0x05]);
const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Accepts either the 64-character hex key WhatsApp shows once when backup
 * encryption is enabled, or the path to a key file holding the raw 32 bytes
 * (or that same hex string as text). A Java-serialized key object is
 * detected and rejected with a clear error rather than misparsed.
 */
export function resolveRootKey(keyInput: string): Buffer {
  const trimmed = keyInput.trim();
  if (HEX_64_RE.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  if (!existsSync(trimmed)) {
    throw new UnsupportedBackupFormatError(
      "The backup key must be a 64-character hex string or the path to a key file.",
    );
  }
  const bytes = readFileSync(trimmed);
  if (bytes.subarray(0, 4).equals(JAVA_SERIALIZATION_MAGIC)) {
    throw new UnsupportedBackupFormatError(
      "This key file is a Java-serialized key object, which isn't supported — supply the " +
        "raw 32-byte key file, or the 64-character hex key, instead.",
    );
  }
  const text = bytes.toString("utf8").trim();
  if (HEX_64_RE.test(text)) {
    return Buffer.from(text, "hex");
  }
  if (bytes.length === ROOT_KEY_LEN) {
    return bytes;
  }
  throw new UnsupportedBackupFormatError(
    `Key file at ${trimmed} is not a recognized ${ROOT_KEY_LEN}-byte raw key or ` +
      `${ROOT_KEY_HEX_LEN}-character hex key.`,
  );
}

/** HMAC-SHA256 twice: zero-seeded, then labeled — WhatsApp's `encryptionloop`. */
export function deriveAesKey(rootKey: Buffer): Buffer {
  if (rootKey.length !== ROOT_KEY_LEN) {
    throw new UnsupportedBackupFormatError(
      `Backup key must be ${ROOT_KEY_LEN} bytes, got ${rootKey.length}.`,
    );
  }
  const privateKey = createHmac("sha256", ZERO_SEED_32).update(rootKey).digest();
  return createHmac("sha256", privateKey).update(BACKUP_ENCRYPTION_LABEL).digest();
}

interface ProtoField {
  fieldNumber: number;
  wireType: number;
  start: number;
  end: number;
}

/** Minimal protobuf varint reader — hand-rolled rather than a full runtime, for one field. */
function readVarint(buf: Buffer, offset: number): [value: number, next: number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) {
      throw new UnsupportedBackupFormatError("Truncated protobuf varint in backup header.");
    }
    const byte = buf[pos];
    result |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) {
      throw new UnsupportedBackupFormatError("Oversized varint in backup header.");
    }
  }
  return [result >>> 0, pos];
}

/** Reads one tag+value field, returning its byte span and the offset just past it. */
function readField(buf: Buffer, offset: number): { field: ProtoField; next: number } {
  const [tag, afterTag] = readVarint(buf, offset);
  const fieldNumber = tag >>> 3;
  const wireType = tag & 0x7;
  switch (wireType) {
    case 0: {
      const [, next] = readVarint(buf, afterTag);
      return { field: { fieldNumber, wireType, start: afterTag, end: next }, next };
    }
    case 1: {
      const next = afterTag + 8;
      if (next > buf.length) throw new UnsupportedBackupFormatError("Truncated backup header.");
      return { field: { fieldNumber, wireType, start: afterTag, end: next }, next };
    }
    case 2: {
      const [len, afterLen] = readVarint(buf, afterTag);
      const next = afterLen + len;
      if (next > buf.length) throw new UnsupportedBackupFormatError("Truncated backup header.");
      return { field: { fieldNumber, wireType, start: afterLen, end: next }, next };
    }
    case 5: {
      const next = afterTag + 4;
      if (next > buf.length) throw new UnsupportedBackupFormatError("Truncated backup header.");
      return { field: { fieldNumber, wireType, start: afterTag, end: next }, next };
    }
    default:
      throw new UnsupportedBackupFormatError(
        `Unsupported protobuf wire type ${wireType} in backup header.`,
      );
  }
}

/** Scans a protobuf message's top-level fields for the first match. */
function findField(buf: Buffer, fieldNumber: number, wireType: number): ProtoField | undefined {
  let offset = 0;
  while (offset < buf.length) {
    const { field, next } = readField(buf, offset);
    if (field.fieldNumber === fieldNumber && field.wireType === wireType) return field;
    offset = next;
  }
  return undefined;
}

export interface Crypt15Header {
  /** 16-byte GCM IV, from BackupPrefix.e2ee_key_data.encryption_iv. */
  iv: Buffer;
  /** Total bytes consumed by the size varint, the optional flag and the header body — ciphertext starts here. */
  headerLen: number;
}

/**
 * Parses the leading `[varint len][optional features flag][BackupPrefix protobuf]`
 * header of a crypt15 file. The size is a protobuf varint (real headers
 * exceed 255 bytes); the flag byte is skipped when present.
 */
export function parseCrypt15Header(buf: Buffer): Crypt15Header {
  const [declaredLen, afterLen] = readVarint(buf, 0);
  if (declaredLen <= 0 || declaredLen > MAX_HEADER_LEN) {
    throw new UnsupportedBackupFormatError("Backup header length is missing or implausible.");
  }
  const bodyStart = buf[afterLen] === MSGSTORE_FEATURES_FLAG ? afterLen + 1 : afterLen;
  const bodyEnd = bodyStart + declaredLen;
  if (bodyEnd > buf.length) {
    throw new CorruptBackupError(
      "Backup file is truncated — its header extends past the end of the file.",
    );
  }
  const header = buf.subarray(bodyStart, bodyEnd);

  const keyDataField = findField(header, FIELD_E2EE_KEY_DATA, 2);
  if (!keyDataField) {
    throw new UnsupportedBackupFormatError(
      "Backup header is missing its encryption key data — unrecognized or unsupported crypt15 variant.",
    );
  }
  const keyData = header.subarray(keyDataField.start, keyDataField.end);

  const ivField = findField(keyData, FIELD_C15IV_ENCRYPTION_IV, 2);
  if (!ivField) {
    throw new UnsupportedBackupFormatError("Backup header is missing its GCM IV.");
  }
  const iv = keyData.subarray(ivField.start, ivField.end);
  if (iv.length !== GCM_IV_LEN) {
    throw new UnsupportedBackupFormatError(`Unexpected IV length in backup header: ${iv.length}.`);
  }

  return { iv: Buffer.from(iv), headerLen: bodyEnd };
}

/**
 * Decrypt + decompress an Android crypt15 backup file to `msgstore.db` bytes.
 * @param maxDecompressedBytes Override for tests; defaults to {@link MAX_DECOMPRESSED_BYTES}.
 * @throws {UnsupportedBackupFormatError} corrupt/oversized header, chunked-backup trailer, unknown key representation
 * @throws {WrongBackupKeyError} GCM tag verification failed
 * @throws {CorruptBackupError} truncated file, or decompressed size would exceed the safety limit
 */
export function decryptMsgstore(
  backupFilePath: string,
  keyInput: string,
  maxDecompressedBytes: number = MAX_DECOMPRESSED_BYTES,
): Buffer {
  if (!existsSync(backupFilePath)) {
    throw new UnsupportedBackupFormatError(`Backup file not found: ${backupFilePath}`);
  }
  const buf = readFileSync(backupFilePath);
  if (buf.length < 1 + GCM_TAG_LEN + CHECKSUM_LEN) {
    throw new CorruptBackupError("Backup file is too small to be a valid crypt15 backup.");
  }

  const header = parseCrypt15Header(buf);
  const trailerStart = buf.length - GCM_TAG_LEN - CHECKSUM_LEN;
  if (trailerStart <= header.headerLen) {
    throw new CorruptBackupError("Backup file is truncated — there is no room for its ciphertext.");
  }
  const ciphertext = buf.subarray(header.headerLen, trailerStart);
  const tag = buf.subarray(trailerStart, trailerStart + GCM_TAG_LEN);
  const checksum = buf.subarray(trailerStart + GCM_TAG_LEN);

  // This plain MD5 checksum (not part of the AEAD) covers the whole file before it, header
  // included, and is how the single-file local-backup layout is told apart from WhatsApp's
  // chunked Google-Drive backup variant, which has no such trailer. It does not depend on
  // the key, so this check runs before decryption.
  const expectedChecksum = createHash("md5")
    .update(buf.subarray(0, trailerStart + GCM_TAG_LEN))
    .digest();
  if (!expectedChecksum.equals(checksum)) {
    throw new UnsupportedBackupFormatError(
      "This file doesn't match the single-file crypt15 layout — chunked/incremental " +
        "(Google-Drive multi-file) Android backups are not supported.",
    );
  }

  const aesKey = deriveAesKey(resolveRootKey(keyInput));
  let compressed: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", aesKey, header.iv, {
      authTagLength: GCM_TAG_LEN,
    });
    decipher.setAuthTag(tag);
    compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new WrongBackupKeyError();
  }

  try {
    return inflateSync(compressed, { maxOutputLength: maxDecompressedBytes });
  } catch {
    throw new CorruptBackupError(
      "Could not decompress the backup — it is corrupt or exceeds the safety limit.",
    );
  }
}
