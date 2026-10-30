// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Constants for decrypting an Android WhatsApp crypt15 local backup
 * (`msgstore.db.crypt15`) and mapping its message types.
 *
 * Container + key-derivation layout sourced from the crypt15 format described
 * by the ElDavoo/wa-crypt-tools reference decryptor. Only the single-file
 * local-backup layout is supported — WhatsApp's chunked/incremental
 * Google-Drive backup variant has a different trailer and is rejected, not
 * parsed (see android-backup-decrypt.ts).
 */

/** GCM IV length, as carried in the BackupPrefix header's `encryption_iv` field. */
export const GCM_IV_LEN = 16;

/** GCM authentication tag length, immediately following the ciphertext. */
export const GCM_TAG_LEN = 16;

/**
 * Trailing plain (non-AEAD) integrity checksum: MD5 of every byte before it
 * (header, ciphertext and tag). Present only on the single-file local-backup
 * layout; its absence/mismatch is how we detect (and reject) the chunked
 * Google-Drive backup variant.
 */
export const CHECKSUM_LEN = 16;

/**
 * Upper bound on the BackupPrefix protobuf header. Real headers are a few
 * hundred bytes at most; anything past this is a corrupt or hostile file,
 * not a legitimate crypt15 variant — reject before allocating.
 */
export const MAX_HEADER_LEN = 4096;

/**
 * Optional byte some backups carry between the varint header size and the
 * BackupPrefix protobuf. A protobuf can never start with it (it would be
 * field 0), so its presence is unambiguous.
 */
export const MSGSTORE_FEATURES_FLAG = 0x01;

/**
 * Upper bound on the decompressed msgstore.db size — guards a zlib
 * decompression bomb. A full-history Android chat DB is tens to a few
 * hundred MB; 4 GiB is a generous ceiling no legitimate backup approaches.
 */
export const MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024;

/** BackupPrefix protobuf field number carrying the nested C15IV message. */
export const FIELD_E2EE_KEY_DATA = 3;

/** C15IV protobuf field number carrying the 16-byte GCM IV. */
export const FIELD_C15IV_ENCRYPTION_IV = 1;

/** HMAC message label for the second key-derivation step (encryptionloop). */
export const BACKUP_ENCRYPTION_LABEL = Buffer.from("backup encryption\x01", "latin1");

/** 32 zero bytes — the HMAC key for the first key-derivation step. */
export const ZERO_SEED_32 = Buffer.alloc(32, 0x00);

/** A raw root key is exactly 32 bytes; its hex-string form is 64 characters. */
export const ROOT_KEY_LEN = 32;
export const ROOT_KEY_HEX_LEN = 64;

/**
 * WhatsApp Android `message.message_type` (modern schema) /
 * `messages.media_wa_type` (legacy schema) → our generic message `type`.
 *
 * Cross-referenced against community decoders (KnugiHK/WhatsApp-Chat-Exporter,
 * ALEAPP's WhatsApp parser) but NOT verified against every WhatsApp Android
 * release — treat as best-effort, like the iOS table's own documented gaps. Unknown codes fall back to media-shape
 * inference, then `unknown:<n>` (see msgstore-parser.ts's `inferType`).
 */
export const MESSAGE_TYPE_BY_CODE: Record<number, string> = {
  0: "text",
  1: "image",
  2: "audio",
  3: "video",
  4: "contact",
  5: "location",
  7: "system",
  9: "document",
  13: "gif",
  15: "deleted",
  20: "sticker",
};
