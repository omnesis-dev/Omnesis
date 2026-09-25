// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Constants for decrypting an encrypted iOS device backup and locating
 * WhatsApp's on-device message database within it.
 *
 * Sourced from the iOS backup format and the reference decryptor
 * jsharkey13/iphone_backup_decrypt. All multi-byte integers in the keybag TLV
 * and the RFC-3394 key wrap are BIG-endian; the only LITTLE-endian fields are
 * the 4-byte protection-class prefixes on `ManifestKey` and on a file BLOB's
 * `EncryptionKey`.
 */

/** RFC 3394 default initial value (0xA6 repeated 8 times) for AES key (un)wrap. */
export const RFC3394_IV = Buffer.alloc(8, 0xa6);

/** Zero IV used for the AES-256-CBC file/Manifest payload decryption. */
export const ZERO_IV = Buffer.alloc(16, 0x00);

/** A class key is unwrappable off-device only when `(WRAP & 2)` (passphrase-wrapped). */
export const WRAP_PASSPHRASE = 2;

/** WhatsApp's shared App Group container domain in an iOS backup. */
export const WHATSAPP_DOMAIN = "AppDomainGroup-group.net.whatsapp.WhatsApp.shared";

/** Relative path of the message DB within the WhatsApp App Group container. */
export const CHATSTORAGE_RELPATH = "ChatStorage.sqlite";

/**
 * Deterministic backup fileID for ChatStorage.sqlite = SHA1("<domain>-<relativePath>").
 * Fast-path fallback when the authoritative Manifest.db lookup misses.
 */
export const CHATSTORAGE_FILEID = "7c7fba66680ef796b916b067077cc246adacf01d";

/** Seconds between the Unix epoch (1970-01-01) and the Cocoa epoch (2001-01-01 UTC). */
export const APPLE_EPOCH_OFFSET = 978_307_200;

/**
 * WhatsApp iOS `ZWAMESSAGE.ZMESSAGETYPE` → our generic message `type`.
 * Unknown codes fall back to media-shape inference, then `unknown:<n>`.
 */
export const MESSAGE_TYPE_BY_CODE: Record<number, string> = {
  0: "text",
  1: "image",
  2: "video",
  3: "audio",
  4: "contact",
  5: "location",
  6: "system",
  7: "url",
  8: "document",
  10: "system",
  11: "gif",
  13: "video",
  14: "deleted",
  15: "sticker",
};
