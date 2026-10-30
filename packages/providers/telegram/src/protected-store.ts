// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Opening the two SQLite files a Telegram account keeps — the message archive
 * and mtcute's connection cache — with the same at-rest protection.
 *
 * The posture is WhatsApp's (`packages/providers/whatsapp/src/message-store.ts`):
 * with a `telegram-store` key the file is SQLCipher-encrypted; a plaintext file
 * written before the key existed is encrypted through a staging copy that is
 * swapped in with one rename; a file that will not open is set aside with its
 * journal and replaced by an empty one.
 *
 * Fail closed. When the install requires storage encryption and the key cannot
 * be read, {@link readTelegramStoreKey} throws before anything touches disk, so
 * neither file is ever created or written in plaintext.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import EncryptedDatabase from "better-sqlite3-multiple-ciphers";
import {
  createLogger,
  readStorageKeySync,
  storageEncryptionRequired,
  storageKeyHex,
  toErrorMessage,
} from "@omnesis/core";
import type { LocalStoreProbeResult } from "@omnesis/source-sdk";

export type Db = Database.Database;

/** The live-storage key both files open with. */
const TELEGRAM_STORE_KEY = "telegram-store";

const log = createLogger("provider:telegram").child("store");
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");

/** The install requires encryption and the key cannot be had. */
export class StoreKeyUnavailableError extends Error {
  constructor(detail?: string) {
    super(
      "Telegram store encryption is required, but the telegram-store key is unavailable" +
        (detail ? ` (${detail})` : "") +
        ". Unlock the Omnesis keyring or run `omnesis keyring storage-init`.",
    );
    this.name = "StoreKeyUnavailableError";
  }
}

/** An encryption migration that failed after the file was read intact. */
class StoreRekeyFailure extends Error {
  constructor(label: string, detail: string) {
    super(`Telegram ${label} encryption failed and the file was left as it was: ${detail}`);
    this.name = "StoreRekeyFailure";
  }
}

/**
 * The `telegram-store` key, or `null` when this install keeps provider stores
 * unencrypted. Throws {@link StoreKeyUnavailableError} when encryption is
 * required and the key is missing or its root key is locked.
 */
export function readTelegramStoreKey(configDir: string): Buffer | null {
  let key: Buffer | null;
  try {
    key = readStorageKeySync(TELEGRAM_STORE_KEY, { configDir });
  } catch (err) {
    // A wrapped key exists but cannot be unwrapped: whatever the marker says,
    // something here was encrypted, so opening in plaintext is never right.
    throw new StoreKeyUnavailableError(toErrorMessage(err));
  }
  if (key) return key;
  if (storageEncryptionRequired(configDir)) throw new StoreKeyUnavailableError();
  return null;
}

/**
 * Open (creating if needed) one protected SQLite file.
 *
 * `key` is read, not retained: the caller owns and zeroes it.
 */
export function openProtectedDatabase(path: string, key: Buffer | null, label: string): Db {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    return configurePragmas(openDatabase(path, key, label));
  } catch (err) {
    // A failed migration leaves the original intact; quarantining it would
    // answer a full disk by discarding the very file that could not be copied.
    if (err instanceof StoreRekeyFailure) throw err;
    log.error(
      `Telegram ${label} open failed (${toErrorMessage(err)}); quarantining and starting fresh`,
    );
    quarantine(path);
    return configurePragmas(openDatabase(path, key, label));
  }
}

/**
 * What is on disk at `path` and whether this host's key opens it, for the
 * doctor. Read-only: never migrates, repairs or writes.
 */
export function inspectProtectedStore(
  path: string,
  label: string,
  configDir: string,
): LocalStoreProbeResult {
  const keyName = TELEGRAM_STORE_KEY;
  if (!fileExists(path)) return { keyName, label, state: "absent" };
  if (sqliteFileLooksPlaintext(path)) return { keyName, label, state: "plaintext" };
  let key: Buffer | null;
  try {
    key = readStorageKeySync(keyName, { configDir });
  } catch {
    return { keyName, label, state: "locked", detail: "Its key could not be read." };
  }
  if (!key) return { keyName, label, state: "locked", detail: "No wrapped key exists for it." };
  try {
    const db = new EncryptedDatabase(path, { readonly: true }) as unknown as Db;
    try {
      keyDatabase(db, key);
      db.prepare("SELECT count(*) FROM sqlite_master").get();
    } finally {
      db.close();
    }
    return { keyName, label, state: "encrypted" };
  } catch (err) {
    // SQLite reports a wrong key as "not a database"; anything else is the
    // file being unreadable right now, which is not a verdict on the key.
    return sqliteNotADatabase(err)
      ? { keyName, label, state: "unverifiable", detail: "It did not open with this host's key." }
      : { keyName, label, state: "locked", detail: "It could not be opened for inspection." };
  } finally {
    key.fill(0);
  }
}

function openDatabase(path: string, key: Buffer | null, label: string): Db {
  if (!key) return new Database(path);
  if (sqliteFileLooksPlaintext(path)) migratePlaintext(path, key, label);
  const db = new EncryptedDatabase(path) as unknown as Db;
  try {
    keyDatabase(db, key);
    // Keying is lazy: touch the schema so a wrong key fails here, inside the
    // caller's quarantine path, rather than on the first real statement.
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function keyDatabase(db: Db, key: Buffer): void {
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key='${storageKeyHex(key)}'`);
}

function configurePragmas(db: Db): Db {
  db.pragma("journal_mode = WAL");
  // Both files are rebuildable (the archive from Telegram, the cache from the
  // session string): NORMAL is durable enough and far cheaper than FULL.
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  // pread() over mmap — the SIGBUS-avoidance rationale the gateway documents.
  db.pragma("mmap_size = 0");
  return db;
}

/**
 * Encrypt a plaintext file by rekeying a staging copy and renaming it over the
 * original, so an interruption leaves either the whole plaintext file or the
 * whole encrypted one. See WhatsApp's `migratePlaintextStore` for the failure
 * an in-place `PRAGMA rekey` has at its commit.
 */
function migratePlaintext(path: string, key: Buffer, label: string): void {
  const plain = new Database(path);
  try {
    plain.pragma("busy_timeout = 30000");
    plain.pragma("wal_checkpoint(TRUNCATE)");
    plain.pragma("journal_mode = DELETE");
  } finally {
    plain.close();
  }
  const staging = `${path}.rekey`;
  try {
    clearStaging(staging);
    copyFileSync(path, staging);
    const db = new EncryptedDatabase(staging);
    try {
      db.pragma("cipher='sqlcipher'");
      db.pragma("legacy=4");
      db.pragma(`rekey='${storageKeyHex(key)}'`);
    } finally {
      db.close();
    }
  } catch (err) {
    try {
      clearStaging(staging);
    } catch {
      // The next attempt clears the staging path before using it anyway.
    }
    throw new StoreRekeyFailure(label, toErrorMessage(err));
  }
  renameSync(staging, path);
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function clearStaging(staging: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    rmSync(`${staging}${suffix}`, { force: true });
}

/** Move a file that will not open aside, with the journal that belongs to it. */
function quarantine(path: string): void {
  try {
    const quarantined = `${path}.corrupt-${Date.now()}`;
    if (existsSync(path)) renameSync(path, quarantined);
    for (const sfx of ["-wal", "-journal"]) {
      if (existsSync(path + sfx)) renameSync(path + sfx, quarantined + sfx);
    }
    rmSync(path + "-shm", { force: true });
  } catch (err) {
    log.warn(`Failed to quarantine a Telegram store file: ${toErrorMessage(err)}`);
  }
}

function fileExists(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

function sqliteFileLooksPlaintext(path: string): boolean {
  if (!existsSync(path)) return false;
  const st = statSync(path);
  if (!st.isFile() || st.size < SQLITE_HEADER.length) return false;
  const header = Buffer.alloc(SQLITE_HEADER.length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  return header.equals(SQLITE_HEADER);
}

function sqliteNotADatabase(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_NOTADB"
  );
}
