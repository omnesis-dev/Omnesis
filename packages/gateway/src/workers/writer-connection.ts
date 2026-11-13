// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The writer worker's connection to `omnesis.db` — the only writable handle
 * the gateway holds. Kept apart from `writer-worker.ts`, which can only be
 * loaded as a worker thread, so the handle's configuration is testable.
 */

import Database from "better-sqlite3";
type Db = Database.Database;

import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { useImmediateTransactions } from "../sqlite-transactions.js";
import { DEFAULT_WAL_CHECKPOINT_POLICY } from "./wal-checkpoint.js";

export function openWriteConn(
  path: string,
  journalMode: "WAL" | "TRUNCATE",
  gatewayDbKeyHex?: string,
): Db {
  const db = gatewayDbKeyHex
    ? (openEncryptedSqlite(path, {
        key: Buffer.from(gatewayDbKeyHex, "hex"),
        fileMustExist: true,
        migratePlaintext: false,
      }) as unknown as Db)
    : new Database(path, { fileMustExist: true });
  // Default WAL: MVCC-style concurrent reads, writes don't block
  // readers. Only safe with the single-writer architecture
  // (writer worker owns the only writable handle; main + backfill +
  // indexer are all read-only) — otherwise multi-writer races on the
  // `-shm` mmap reintroduce the SIGBUS class.
  // Opt-out path: TRUNCATE (rollback-journal, no `-shm`). Set
  // OMNESIS_JOURNAL_MODE=TRUNCATE or gateway.journalMode in
  // omnesis.json. Use it if a SIGBUS reappears under WAL.
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${DEFAULT_WAL_CHECKPOINT_POLICY.busyTimeoutMs}`);
  // mmap_size=0 belt-and-suspenders against the residual Crash B
  // mmap class (disables DB-file mmap reads). Cheap; keep set in
  // both journal modes. TRUNCATE has no DB-file mmap risk; harmless.
  db.exec("PRAGMA mmap_size = 0");
  if (journalMode === "WAL") {
    // No per-commit autocheckpoint: the writer checkpoints between ops
    // (`wal-checkpoint.ts`), so no commit carries a checkpoint's cost. No
    // mode it uses truncates or resizes `-shm`. NEVER use a TRUNCATE
    // checkpoint here — that's the SIGBUS-prone op.
    db.exec("PRAGMA wal_autocheckpoint = 0");
    // No limit: SQLite would cut a rewound WAL back in the first commit after
    // the rewind, charging that write for freeing every block past the limit.
    // The checkpointer cuts it between ops, a slice at a time.
    db.exec("PRAGMA journal_size_limit = -1");
    // On macOS a plain fsync leaves writes in the drive's cache. A rewind lets
    // new frames overwrite copied ones, so the copy must be on the medium
    // first: F_FULLFSYNC for checkpoint syncs (a no-op elsewhere).
    db.exec("PRAGMA checkpoint_fullfsync = ON");
  }
  // synchronous = FULL narrows the fsync window. Mozilla belt-and-
  // suspenders recipe; useful in both modes.
  db.exec("PRAGMA synchronous = FULL");
  useImmediateTransactions(db);
  return db;
}
