// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Backup worker — runs `VACUUM INTO` snapshots of the SQLite stores
 * plus configuration copies, entirely off the gateway main
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
 * writer worker's concurrent commits. Keyed SQLite snapshots retain their
 * cipher from creation; configuration copies stream into artifact encryption
 * when an installation root key is supplied.
 */

import { mkdirSync, readdirSync, statSync, lstatSync, constants } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
type Db = Database.Database;
import {
  BACKUP_RECOVERY_ENVELOPE_NAME,
  copyPrivate,
  ensurePrivateDirSync,
  produceEncryptedArtifact,
} from "@omnesis/core";

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

async function copyEncrypted(
  from: string,
  to: string,
  scope: string,
  rootKey: string,
): Promise<{ path: string; bytes: number }> {
  const metadata = lstatSync(from);
  if (metadata.isSymbolicLink()) throw new Error("Backup config contains a symbolic link");
  if (metadata.isDirectory()) {
    mkdirSync(to, { mode: 0o700 });
    let bytes = 0;
    for (const child of readdirSync(from)) {
      bytes += (
        await copyEncrypted(join(from, child), join(to, child), `${scope}/${child}`, rootKey)
      ).bytes;
    }
    return { path: to, bytes };
  }
  if (!metadata.isFile() || metadata.nlink !== 1)
    throw new Error("Backup config is not a regular owned file");
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const source = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await source.stat();
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.nlink !== 1
    )
      throw new Error("Backup configuration changed before reading");
    const result = await produceEncryptedArtifact(`${to}.enc`, { rootKey, scope }, async (body) => {
      async function* chunks() {
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
          if (!bytesRead) return;
          yield Buffer.from(buffer.subarray(0, bytesRead));
        }
      }
      await pipeline(Readable.from(chunks()), body);
      const after = await source.stat();
      if (
        opened.size !== after.size ||
        opened.mtimeMs !== after.mtimeMs ||
        opened.ctimeMs !== after.ctimeMs
      )
        throw new Error("Backup configuration changed while reading");
    });
    return { path: result.path, bytes: result.bytes };
  } finally {
    await source.close();
  }
}

async function run(input: BackupWorkerInput): Promise<void> {
  if (process.platform === "win32") {
    const directories = new Set([
      ...input.vacuums.map((job) => dirname(job.destPath)),
      ...input.copies.map((copy) => dirname(copy.to)),
    ]);
    for (const directory of directories) ensurePrivateDirSync(directory);
  }
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
    const encryption =
      copy.name === BACKUP_RECOVERY_ENVELOPE_NAME ? undefined : input.artifactEncryption;
    const encrypted = encryption
      ? await copyEncrypted(
          copy.from,
          copy.to,
          `${encryption.scope}:${copy.name}`,
          encryption.rootKey,
        )
      : undefined;
    if (!encrypted) copyPrivate(copy.from, copy.to);
    post({
      type: "file",
      file: encrypted && encrypted.path !== copy.to ? `${copy.name}.enc` : copy.name,
      bytes: encrypted?.bytes ?? sizeOfPath(copy.to),
      durationMs: Date.now() - start,
      ...(encrypted ? { encrypted: true } : {}),
    });
  }
  post({ type: "done" });
}
run(workerData as BackupWorkerInput).catch((err: unknown) => {
  post({
    type: "error",
    error: err instanceof Error ? (err.stack ?? err.message) : String(err),
  });
});
