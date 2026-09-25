// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPrivateScratch } from "@omnesis/core";
import { CHATSTORAGE_FILEID, CHATSTORAGE_RELPATH, WHATSAPP_DOMAIN, ZERO_IV } from "./constants.js";
import { readManifestPlist } from "./bplist.js";
import { aesUnwrap, derivePassphraseKey, parseKeybag, unwrapClassKeys } from "./keybag.js";
import { lookupFile } from "./manifest-db.js";

/**
 * Decrypt an encrypted iOS device backup and recover WhatsApp's
 * `ChatStorage.sqlite` bytes (#588). Pure — takes a backup directory + the
 * backup password, returns the decrypted SQLite file as a Buffer. Holds ALL
 * iOS-backup-format assumptions, so a real-device discrepancy is fixable here
 * alone (see the importer's #588 risk notes).
 *
 * Algorithm (per jsharkey13/iphone_backup_decrypt): read Manifest.plist keybag,
 * derive the passphrase KEK via double PBKDF2, RFC-3394-unwrap the class keys,
 * AES-CBC-decrypt Manifest.db, find the ChatStorage Files row, unwrap its
 * per-file key, AES-CBC-decrypt the on-disk blob, truncate to its plist Size.
 */

/** Thrown when the supplied backup password is wrong (an unwrap integrity check fails). */
export class WrongBackupPasswordError extends Error {
  constructor() {
    super("Incorrect backup password — could not unwrap the backup keys.");
    this.name = "WrongBackupPasswordError";
  }
}

function aesCbcDecryptNoPad(key: Buffer, ciphertext: Buffer): Buffer {
  const d = createDecipheriv("aes-256-cbc", key, ZERO_IV);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

/**
 * Decrypt the backup and return the raw `ChatStorage.sqlite` bytes.
 * @throws {WrongBackupPasswordError} on a wrong password
 * @throws {Error} when the folder isn't an encrypted backup, or ChatStorage is absent
 */
export function decryptChatStorage(
  backupDir: string,
  password: string,
  scratchPath?: string,
): Buffer {
  const manifestPlistPath = join(backupDir, "Manifest.plist");
  if (!existsSync(manifestPlistPath)) {
    throw new Error(`No Manifest.plist in ${backupDir} — not an iPhone backup folder.`);
  }
  const { backupKeyBag, manifestKey } = readManifestPlist(readFileSync(manifestPlistPath));
  if (!manifestKey) {
    throw new Error("This backup is not encrypted. Enable backup encryption and back up again.");
  }

  const keybag = parseKeybag(backupKeyBag);
  const kek = derivePassphraseKey(password, keybag.attrs);
  try {
    unwrapClassKeys(keybag, kek);
  } catch {
    throw new WrongBackupPasswordError();
  }

  // Decrypt Manifest.db with the ManifestKey's class key.
  const manifestClass = manifestKey.readInt32LE(0);
  const manifestWrapped = manifestKey.subarray(4);
  const manifestClassKey = keybag.classKeys.get(manifestClass)?.key;
  if (!manifestClassKey) {
    throw new Error(`Manifest protection class ${manifestClass} is not passphrase-recoverable.`);
  }
  let manifestFileKey: Buffer;
  try {
    manifestFileKey = aesUnwrap(manifestClassKey, manifestWrapped);
  } catch {
    throw new WrongBackupPasswordError();
  }
  const encManifestDb = readFileSync(join(backupDir, "Manifest.db"));
  const manifestDbBytes = aesCbcDecryptNoPad(manifestFileKey, encManifestDb);

  // Worker callers pass parent-owned scratch so termination cannot strand plaintext.
  const scratch = scratchPath ? undefined : createPrivateScratch("wa-manifest");
  const manifestDbPath = join(scratchPath ?? scratch!.path, "Manifest.db");
  try {
    writeFileSync(manifestDbPath, manifestDbBytes, { mode: 0o600 });

    const ref =
      lookupFile(manifestDbPath, {
        domainLike: `${WHATSAPP_DOMAIN}%`,
        relativePath: CHATSTORAGE_RELPATH,
      }) ?? lookupFile(manifestDbPath, { fileID: CHATSTORAGE_FILEID });
    if (!ref) {
      throw new Error(
        "ChatStorage.sqlite not found in this backup — make sure WhatsApp is installed and the backup is recent.",
      );
    }

    // The fileID comes from the (semi-trusted) decrypted Manifest.db; iOS
    // fileIDs are always lowercase 40-char SHA-1 hex. Validate before joining it
    // into a path so a tampered backup can't escape backupDir (traversal).
    if (!/^[0-9a-f]{40}$/.test(ref.fileID)) {
      throw new Error("Malformed backup file id in Manifest.db.");
    }
    const onDisk = join(backupDir, ref.fileID.slice(0, 2), ref.fileID);
    if (!existsSync(onDisk)) {
      throw new Error(
        `Backed-up file ${ref.fileID} is missing from ${backupDir} (incomplete backup?).`,
      );
    }
    const fileClassKey = keybag.classKeys.get(ref.protectionClass)?.key;
    if (!fileClassKey) {
      throw new Error(
        `ChatStorage protection class ${ref.protectionClass} is not passphrase-recoverable.`,
      );
    }
    let fileKey: Buffer;
    try {
      fileKey = aesUnwrap(fileClassKey, ref.wrappedKey);
    } catch {
      throw new WrongBackupPasswordError();
    }

    const plain = aesCbcDecryptNoPad(fileKey, readFileSync(onDisk));
    // The plist Size is the authoritative plaintext length (drops CBC padding).
    return ref.size > 0 ? plain.subarray(0, ref.size) : plain;
  } finally {
    if (scratch) scratch.cleanup();
    else rmSync(manifestDbPath, { force: true });
  }
}
