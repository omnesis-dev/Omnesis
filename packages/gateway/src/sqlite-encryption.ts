// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SQLite encryption helpers for Omnesis-owned live stores.
 *
 * External provider/source SQLite databases are still opened with the upstream
 * `better-sqlite3` package. Omnesis-owned databases use the multiple-ciphers
 * fork so we can keep the existing synchronous API while keying pages through
 * SQLCipher-compatible pragmas.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { storageKeyHex } from "@omnesis/core";

export type EncryptedSqliteDatabase = Database.Database;

export interface OpenEncryptedSqliteOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  key?: Buffer | null;
  migratePlaintext?: boolean;
}

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8");

export function openEncryptedSqlite(
  path: string,
  opts: OpenEncryptedSqliteOptions = {},
): EncryptedSqliteDatabase {
  const plaintext = sqliteFileLooksPlaintext(path);
  if (opts.key && plaintext && (opts.readonly || opts.migratePlaintext === false)) {
    throw new Error(
      `SQLite store at ${path} is plaintext and cannot be opened with an encryption key without migration`,
    );
  }
  if (opts.key && opts.migratePlaintext !== false && plaintext) {
    migratePlaintextSqliteFile(path, opts.key);
  }
  const db = new Database(path, {
    readonly: opts.readonly ?? false,
    fileMustExist: opts.fileMustExist ?? false,
  });
  if (opts.key) keySqliteDb(db, opts.key);
  return db;
}

export function keySqliteDb(db: EncryptedSqliteDatabase, key: Buffer): void {
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key='${storageKeyHex(key)}'`);
}

/**
 * Encrypt a plaintext Omnesis-owned SQLite store in place, crash-safely.
 *
 * The live corpus file is never rekeyed in place: an in-place `PRAGMA rekey`
 * that is interrupted leaves a half-encrypted, unrecoverable database. Instead
 * we fold the WAL into the main file, copy it to a temp sibling, rekey
 * (encrypt) the COPY, fsync it, and atomically rename it over the original. A
 * crash before the rename leaves the original plaintext file intact and the
 * migration simply retries on the next boot; the rename is atomic, so the live
 * path is always either the original plaintext or a complete encrypted
 * database — never a partial one.
 */
export function migratePlaintextSqliteFile(path: string, key: Buffer): boolean {
  if (!sqliteFileLooksPlaintext(path)) return false;

  // Fold any WAL back into the main file so the single file is authoritative
  // before it is copied. Refuse to proceed if the checkpoint is blocked by
  // another open connection: copying while commits still live only in the WAL
  // would silently drop them. Migration runs single-writer at boot, so a busy
  // result means that precondition was violated — fail loud rather than lose data.
  const plaintextDb = new Database(path);
  try {
    plaintextDb.pragma("busy_timeout = 30000");
    const checkpoint = plaintextDb.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
    if (checkpoint[0] && checkpoint[0].busy !== 0) {
      throw new Error(
        `Refusing to encrypt ${path}: WAL checkpoint is blocked (database open elsewhere); would risk dropping un-checkpointed commits`,
      );
    }
    plaintextDb.pragma("journal_mode = DELETE");
  } finally {
    plaintextDb.close();
  }

  // Reclaim any temp files orphaned by a prior interrupted attempt, then work
  // from a fresh isolated copy.
  cleanStaleEncryptTemps(path);
  const tmpPath = `${path}.encrypting-${process.pid}-${Date.now()}`;
  clearSqliteSidecars(tmpPath);
  try {
    copyFileSync(path, tmpPath);

    const db = new Database(tmpPath);
    try {
      db.pragma("busy_timeout = 30000");
      db.pragma("cipher='sqlcipher'");
      db.pragma("legacy=4");
      db.pragma(`rekey='${storageKeyHex(key)}'`);
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.pragma("journal_mode = DELETE");
    } finally {
      db.close();
    }
    // The rekeyed copy is a self-contained encrypted database; drop its
    // sidecars so only the single file is renamed into place.
    rmSync(`${tmpPath}-wal`, { force: true });
    rmSync(`${tmpPath}-shm`, { force: true });
    fsyncFile(tmpPath);
    renameSync(tmpPath, path); // atomic on the same filesystem
    fsyncDir(dirname(path));
  } catch (err) {
    clearSqliteSidecars(tmpPath);
    throw err;
  }
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  return true;
}

function clearSqliteSidecars(basePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${basePath}${suffix}`, { force: true });
  }
}

export function cleanStaleEncryptTemps(path: string): void {
  const dir = dirname(path);
  const prefix = `${basename(path)}.encrypting-`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(prefix)) rmSync(join(dir, entry), { force: true });
  }
}

export function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fsyncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return; // best-effort: directory fsync is unsupported on some platforms
  }
  try {
    fsyncSync(fd);
  } catch {
    // best-effort durability of the rename; ignore if the platform rejects it
  } finally {
    closeSync(fd);
  }
}

export function sqliteFileLooksPlaintext(path: string): boolean {
  if (!existsSync(path)) return false;
  const st = statSync(path);
  if (!st.isFile() || st.size < SQLITE_HEADER.length) return false;
  // Read only the header: a plaintext SQLite file starts with the magic
  // string, an encrypted (SQLCipher) one does not. Reading the whole file with
  // readFileSync would throw ERR_FS_FILE_TOO_LARGE on a corpus over 2 GiB.
  const header = Buffer.alloc(SQLITE_HEADER.length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, header, 0, SQLITE_HEADER.length, 0);
  } finally {
    closeSync(fd);
  }
  return header.equals(SQLITE_HEADER);
}

export function quarantineEncryptedSqliteCorruption(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${path}${suffix}`;
    if (!existsSync(target)) continue;
    try {
      renameSync(target, `${target}.corrupt-${Date.now()}`);
    } catch {
      rmSync(target, { force: true });
    }
  }
}
