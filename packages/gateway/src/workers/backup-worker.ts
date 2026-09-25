// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Backup worker (#57) — runs `VACUUM INTO` snapshots of the SQLite stores
 * plus plain copies of the config files, entirely off the gateway main
 * thread. `VACUUM INTO` in better-sqlite3 is synchronous and takes minutes
 * on multi-GB databases; hosting it here keeps the HTTP path responsive
 * while a backup runs.
 *
 * One-shot: the full work list arrives via `workerData`
 * (`BackupWorkerInput`), progress streams back as `begin`/`file` messages,
 * and the worker exits after posting `done` (or `error`). Protocol types
 * live in `backup-protocol.ts`.
 *
 * The source databases are opened read-only — `VACUUM INTO` never mutates
 * the original, and a read-only WAL handle is consistent against the
 * writer worker's concurrent commits.
 */

import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
type Db = Database.Database;

import { openEncryptedSqlite } from "../sqlite-encryption.js";
import type { BackupWorkerInput, BackupWorkerMessage } from "./backup-protocol.js";

if (!parentPort) {
  throw new Error("backup-worker must be run as a Node worker_thread");
}

function post(msg: BackupWorkerMessage): void {
  parentPort!.postMessage(msg);
}

/** Quote a path as a SQL string literal (single quotes doubled). */
function quoteSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Total on-disk bytes of a file, or of every file under a directory. */
function sizeOfPath(path: string): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += sizeOfPath(join(path, entry.name));
  }
  return total;
}

function vacuumInto(sourcePath: string, destPath: string, keyHex?: string): void {
  const db: Db = keyHex
    ? (openEncryptedSqlite(sourcePath, {
        key: Buffer.from(keyHex, "hex"),
        readonly: true,
        fileMustExist: true,
        migratePlaintext: false,
      }) as unknown as Db)
    : new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    // Generous busy timeout: the writer worker may be mid-checkpoint when
    // the vacuum's initial read transaction opens.
    db.exec("PRAGMA busy_timeout = 30000");
    db.exec(`VACUUM INTO ${quoteSqlString(destPath)}`);
  } finally {
    db.close();
  }
}

const input = workerData as BackupWorkerInput;

try {
  for (const job of input.vacuums) {
    post({ type: "begin", file: job.name });
    const start = Date.now();
    vacuumInto(job.sourcePath, job.destPath, job.keyHex);
    post({
      type: "file",
      file: job.name,
      bytes: statSync(job.destPath).size,
      durationMs: Date.now() - start,
    });
  }
  for (const copy of input.copies) {
    post({ type: "begin", file: copy.name });
    const start = Date.now();
    // Owner-only: these can hold copies of per-account credential files, which
    // are 0600 in the config tree.
    mkdirSync(dirname(copy.to), { recursive: true, mode: 0o700 });
    cpSync(copy.from, copy.to, { recursive: true });
    post({
      type: "file",
      file: copy.name,
      bytes: sizeOfPath(copy.to),
      durationMs: Date.now() - start,
    });
  }
  post({ type: "done" });
} catch (err) {
  post({
    type: "error",
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
}
