// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  copyFileSync,
  chmodSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
} from "node:fs";
import { basename, join } from "node:path";
import { createPrivateScratch } from "./private-scratch.js";

/**
 * Snapshot of a SQLite DB plus its sidecars in a temp directory. The caller
 * opens `path` with their own SQLite driver (better-sqlite3, etc.) and MUST
 * close that handle before calling `cleanup()`, which removes the temp
 * directory and every file inside it.
 */
export interface SqliteSnapshot {
  path: string;
  cleanup(): void;
}

/**
 * Snapshot a SQLite DB into a temp directory via filesystem copy.
 *
 * Used for SQLite databases held under an exclusive lock by another process
 * (Chromium History while Chrome is running, macOS Knowledge Store while
 * the Knowledge service is up, etc.) where opening read-only still fails
 * with `database is locked`. Filesystem copy bypasses the lock entirely —
 * the kernel just reads the bytes and writes a new file; the source DB
 * never notices.
 *
 * Present `-wal`, `-shm`, and `-journal` sidecars are mandatory. File identities,
 * sizes and modification/change times must remain stable across the copy.
 * This detects ordinary concurrent changes, not an atomic filesystem snapshot;
 * a continuously changing source is refused after three attempts. SQLite may
 * still need to recover the private copy before a read-only connection can read.
 *
 * @param sourcePath  absolute path to the SQLite DB to snapshot
 * @param namespace   short slug used in the temp dir name. Useful for
 *                    debugging within the owner-only temporary scratch root.
 */
export function openSqliteSnapshot(
  sourcePath: string,
  namespace = "omnesis-sqlite-",
): SqliteSnapshot {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return copyStableSnapshot(sourcePath, namespace);
    } catch (error) {
      if (!(error instanceof SqliteSnapshotChangedError) || attempt === 2) throw error;
    }
  }
  throw new SqliteSnapshotChangedError();
}

/**
 * The source kept changing while it was being copied.
 *
 * Its own condition rather than a generic failure, because what a caller owes
 * it is different: nothing is wrong with the database, the copy simply raced a
 * writer, and the next cycle is likely to win. A source that treats this as an
 * ordinary error reports itself broken for as long as its database stays busy.
 */
export class SqliteSnapshotChangedError extends Error {
  constructor() {
    super("SQLite input changed while copying; retry the source");
  }
}

function fingerprint(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    if (!stat.isFile()) throw new Error("SQLite input must be a regular file");
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function copyStableSnapshot(sourcePath: string, namespace: string): SqliteSnapshot {
  const scratch = createPrivateScratch(namespace);
  const tmpDir = scratch.path;
  try {
    const snapshotPath = join(tmpDir, basename(sourcePath));
    const suffixes = ["", "-wal", "-shm", "-journal"];
    const before = suffixes.map((suffix) => fingerprint(sourcePath + suffix));
    if (before[0] === null) throw new Error("SQLite source database is missing");
    for (const [index, suffix] of suffixes.entries()) {
      if (before[index] !== null) {
        try {
          copyFileSync(sourcePath + suffix, snapshotPath + suffix);
          chmodSync(snapshotPath + suffix, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            throw new SqliteSnapshotChangedError();
          throw error;
        }
      }
    }
    if (suffixes.some((suffix, index) => fingerprint(sourcePath + suffix) !== before[index]))
      throw new SqliteSnapshotChangedError();
    return {
      path: snapshotPath,
      cleanup: scratch.cleanup,
    };
  } catch (error) {
    scratch.cleanup();
    throw error;
  }
}

/** SQLite's rollback-journal footer can name a super-journal outside the copy. */
function assertLocalRecovery(snapshotPath: string): void {
  let fd: number;
  try {
    fd = openSync(snapshotPath + "-journal", "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    if (size < 16) return;
    const footer = Buffer.alloc(16);
    if (readSync(fd, footer, 0, 16, size - 16) !== 16)
      throw new Error("SQLite rollback journal footer is unreadable");
    if (
      footer.subarray(8).equals(Buffer.from("d9d505f920a163d7", "hex")) &&
      footer.readUInt32BE(0) > 0
    )
      throw new Error("SQLite snapshot cannot recover a journal referencing another database");
  } finally {
    closeSync(fd);
  }
}

interface SnapshotDatabase {
  prepare(sql: string): { get(): unknown };
  close(): void;
}

/**
 * Recover only an owned copy, then return a genuinely read-only connection.
 * The driver stays with the caller's package. cleanup() owns both the returned
 * handle and scratch directory; callers must not close the handle separately.
 */
export function openReadonlySqliteSnapshot<T extends SnapshotDatabase>(
  sourcePath: string,
  openDatabase: (path: string, options: { readonly: boolean; fileMustExist: true }) => T,
  namespace = "omnesis-sqlite-",
): SqliteSnapshot & { db: T } {
  const snapshot = openSqliteSnapshot(sourcePath, namespace);
  let db: T | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      db?.close();
    } finally {
      snapshot.cleanup();
    }
  };
  try {
    assertLocalRecovery(snapshot.path);
    db = openDatabase(snapshot.path, { readonly: false, fileMustExist: true });
    // Opening alone can defer recovery until the first real database read.
    db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    db.close();
    db = undefined;
    db = openDatabase(snapshot.path, { readonly: true, fileMustExist: true });
    db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    return { path: snapshot.path, db, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
