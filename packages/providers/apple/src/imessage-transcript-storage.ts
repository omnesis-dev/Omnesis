// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import EncryptedDatabase from "better-sqlite3-multiple-ciphers";
import { storageKeyHex } from "@omnesis/core";

const HEADER = Buffer.from("SQLite format 3\0");

/** Only Omnesis's transcript sidecar passes here, never Apple's source database. */
export function openTranscriptDatabase(
  path: string,
  key: Buffer | null,
): {
  db: Database.Database;
  close(): void;
} {
  // A separate, content-free SQLite file provides a kernel-released lifetime
  // lock across rename. Locking the data inode itself would lose exclusion when
  // migration replaces that inode. Never unlink this guard file.
  const guard = new Database(`${path}.lock`);
  let db: Database.Database | undefined;
  try {
    chmodSync(`${path}.lock`, 0o600);
    guard.pragma("busy_timeout = 0");
    guard.exec("BEGIN EXCLUSIVE");
    if (key && isPlaintext(path)) migrate(path, key);
    db = key ? new EncryptedDatabase(path) : new Database(path);
    if (key) applyKey(db, key);
    // Authenticate before exposing a handle, including when encryption was disabled
    // after this cache was written. Never quarantine or replace an unreadable file.
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    chmodSync(path, 0o600);
    clearStaging(`${path}.encrypting`);
    const opened = db;
    return {
      db: opened,
      close: () => {
        try {
          opened.close();
        } finally {
          guard.close();
        }
      },
    };
  } catch (error) {
    try {
      db?.close();
    } finally {
      guard.close();
    }
    throw error;
  }
}

/**
 * Inspect the transcript cache for the host's health check without opening
 * it for use: what is on disk, and whether `key` opens it. The cache itself
 * is never migrated, repaired or written; SQLite may leave its WAL side
 * files beside a WAL-mode cache, as any reader does. A cache that does not
 * exist yet is absent.
 */
export function inspectTranscriptDatabase(
  path: string,
  key: Buffer | null,
): "encrypted" | "plaintext" | "absent" | "locked" | "unverifiable" {
  if (!existsSync(path) || statSync(path).size === 0) return "absent";
  if (isPlaintext(path)) return "plaintext";
  if (!key) return "locked";
  let db: Database.Database | undefined;
  try {
    db = new EncryptedDatabase(path, { readonly: true });
    applyKey(db, key);
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return "encrypted";
  } catch (err) {
    // SQLite reports a wrong key as "not a database"; anything else is the
    // file being unreadable right now, which is not a verdict on the key.
    return (err as { code?: unknown })?.code === "SQLITE_NOTADB" ? "unverifiable" : "locked";
  } finally {
    db?.close();
  }
}

function applyKey(db: Database.Database, key: Buffer): void {
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.pragma(`key='${storageKeyHex(key)}'`);
}

function isPlaintext(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(HEADER.length);
    return readSync(fd, header, 0, header.length, 0) === header.length && header.equals(HEADER);
  } finally {
    closeSync(fd);
  }
}

function clearStaging(path: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    rmSync(`${path}${suffix}`, { force: true });
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Rekey a disposable copy, validate it, then atomically replace the original.
 * The source is switched out of WAL before copying; a locked checkpoint or
 * journal-mode change fails instead of losing outstanding committed rows.
 * An interrupted staging rekey is discarded and retried from the intact source.
 * The separate lifetime guard excludes other cache instances during migration.
 */
function migrate(path: string, key: Buffer): void {
  const staging = `${path}.encrypting`;
  const plain = new Database(path);
  try {
    const checkpoint = plain.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    if (checkpoint.some((row) => row.busy !== 0))
      throw new Error("Transcript cache WAL checkpoint is busy");
    if (plain.pragma("journal_mode = DELETE", { simple: true }) !== "delete") {
      throw new Error("Transcript cache journal is busy");
    }
  } finally {
    plain.close();
  }
  try {
    clearStaging(staging);
    copyFileSync(path, staging);
    chmodSync(staging, 0o600);
    const copy = new EncryptedDatabase(staging);
    try {
      copy.pragma("cipher='sqlcipher'");
      copy.pragma("legacy=4");
      copy.pragma(`rekey='${storageKeyHex(key)}'`);
    } finally {
      copy.close();
    }
    const verified = new EncryptedDatabase(staging);
    try {
      applyKey(verified, key);
      if (verified.pragma("integrity_check", { simple: true }) !== "ok") {
        throw new Error("Encrypted transcript cache failed integrity check");
      }
    } finally {
      verified.close();
    }
    syncPath(staging);
    renameSync(staging, path);
    syncPath(dirname(path));
  } finally {
    clearStaging(staging);
  }
}
