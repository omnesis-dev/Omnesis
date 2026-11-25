// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { closeSync, constants, lstatSync, openSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import CipherDatabase from "better-sqlite3-multiple-ciphers";
import { WatchStateStore } from "@omnesis/watch";
import { fsyncFileSync } from "@omnesis/core";
import {
  openEncryptedSqlite,
  sqliteFileLooksPlaintext,
  type EncryptedSqliteDatabase,
} from "../sqlite-encryption.js";
import { WatchJournalStore } from "../watch/store.js";
import { WatchDefinitionStore } from "../watch/definitions.js";
import { WatchTraceStore } from "../watch/traces.js";

export interface AuxiliaryRestoreResult {
  rowsPreserved: number;
  watchesPaused: number;
  pendingWorkDiscarded: number;
}
export type RestoredAuxiliarySource =
  | { sourcePath: string; sourceKey: Buffer; sourceImage?: never }
  | { sourceImage: Buffer; sourcePath?: never; sourceKey?: never };
const discard = new Set(["node_cells", "timers", "pending_nominations", "pending_index"]);
const preserve = new Set([
  "watch_events",
  "materializer_state",
  "analytics_seen",
  "documents_seen",
  "watch_firings",
  "watch_deliveries",
  "consumer_cursor",
  "watch_state",
  "node_looks",
  "delivery_counts",
  "wake_counts",
  "watch_defs",
  "watch_traces",
  "watch_trace_class_counts",
  "watch_judgements",
  "watch_judge_exchanges",
  "watch_judge_spend",
]);

/** Initializes only the product's reviewed schema, never a backup's sqlite_master program. */
export function initializeRestoredWatchSchema(path: string, key: Buffer): EncryptedSqliteDatabase {
  const journal = WatchJournalStore.open(path, key);
  journal.close();
  const db = openEncryptedSqlite(path, { key, migratePlaintext: false });
  try {
    db.pragma("journal_mode = DELETE");
    db.pragma("temp_store = MEMORY");
    db.pragma("trusted_schema = OFF");
    WatchStateStore.on(db, path);
    new WatchDefinitionStore(db);
    new WatchTraceStore(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Worker-only, fresh encrypted destination. Imported Watch programs remain paused for owner review. */
export function rebuildRestoredWatchDatabase(
  options: RestoredAuxiliarySource & {
    destinationPath: string;
    destinationKey: Buffer;
    signal: AbortSignal;
  },
): AuxiliaryRestoreResult {
  if (
    options.destinationKey.length !== 32 ||
    (options.sourceKey && options.sourceKey.length !== 32)
  )
    throw new Error("The Watch restore storage keys are unavailable");
  const identity = options.sourcePath ? privateFile(options.sourcePath) : null;
  let source: EncryptedSqliteDatabase | undefined, output: EncryptedSqliteDatabase | undefined;
  let created = false,
    completed = false;
  try {
    options.signal.throwIfAborted();
    if (options.sourceImage) {
      if (
        options.sourceImage.length > 64 * 1024 ** 2 ||
        !options.sourceImage.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))
      )
        throw new Error("Unsupported legacy Watch database");
      source = new CipherDatabase(options.sourceImage);
    } else
      source = openEncryptedSqlite(options.sourcePath, {
        key: options.sourceKey,
        readonly: true,
        fileMustExist: true,
        migratePlaintext: false,
      });
    source.pragma("trusted_schema = OFF");
    source.pragma("temp_store = MEMORY");
    source.pragma("query_only = ON");
    const objects = source
      .prepare<[], { name: string; type: string; sql: string | null }>(
        "SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
      )
      .all();
    for (const object of objects) {
      if (
        object.type === "view" ||
        object.type === "trigger" ||
        (object.type === "table" &&
          ((!preserve.has(object.name) && !discard.has(object.name)) ||
            /CREATE\s+VIRTUAL|\bCHECK\s*\(|\bCOLLATE\b/i.test(object.sql ?? "")))
      )
        throw new Error("The Watch backup contains an unreviewed database object");
    }
    const descriptor = openSync(
      options.destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(descriptor);
    created = true;
    output = initializeRestoredWatchSchema(options.destinationPath, options.destinationKey);
    const tables = output
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);
    const incoming = objects
      .filter(({ type }) => type === "table")
      .map(({ name }) => name)
      .sort();
    if (JSON.stringify(tables) !== JSON.stringify(incoming))
      throw new Error("The Watch backup needs a reviewed schema migration");
    for (const table of tables) {
      const columns = source.prepare(`PRAGMA table_xinfo(${identifier(table)})`).all() as {
        name: string;
        hidden: number;
      }[];
      const expected = output.prepare(`PRAGMA table_xinfo(${identifier(table)})`).all() as {
        name: string;
      }[];
      if (
        columns.some(({ hidden }) => hidden !== 0) ||
        JSON.stringify(columns.map(({ name }) => name)) !==
          JSON.stringify(expected.map(({ name }) => name))
      )
        throw new Error("The Watch backup columns need a reviewed migration");
    }
    if (source.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("The Watch backup is damaged");
    let rowsPreserved = 0,
      pendingWorkDiscarded = 0;
    const destination = output;
    output.transaction(() => {
      for (const table of tables) {
        options.signal.throwIfAborted();
        const count = Number(
          source!
            .prepare(`SELECT count(*) FROM ${identifier(table)}`)
            .pluck()
            .get(),
        );
        if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid Watch row count");
        if (discard.has(table)) {
          pendingWorkDiscarded += count;
          continue;
        }
        const names = (
          destination.prepare(`PRAGMA table_info(${identifier(table)})`).all() as { name: string }[]
        ).map(({ name }) => name);
        const insert = destination.prepare(
          `INSERT INTO ${identifier(table)} (${names.map(identifier).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
        );
        let copied = 0;
        const where =
          table === "watch_deliveries" ? " WHERE COALESCE(retry_delivered,delivered)>0" : "";
        for (const row of source!
          .prepare(`SELECT ${names.map(identifier).join(",")} FROM ${identifier(table)}${where}`)
          .iterate() as Iterable<Record<string, unknown>>) {
          options.signal.throwIfAborted();
          insert.run(...names.map((name) => row[name]));
          copied++;
        }
        rowsPreserved += copied;
        pendingWorkDiscarded += count - copied;
      }
      destination.exec(
        "UPDATE watch_defs SET status=CASE WHEN status='retired' THEN 'retired' ELSE 'paused' END, note=CASE WHEN note IS NULL OR note='' THEN 'Restored history: review before enabling' ELSE note || char(10) || 'Restored history: review before enabling' END, compile_run_id=NULL, request_key=NULL, reference_digest=NULL",
      );
      destination.exec("UPDATE watch_state SET active=0");
    })();
    const watchesPaused = Number(
      output.prepare("SELECT count(*) FROM watch_defs WHERE status='paused'").pluck().get(),
    );
    if (
      output.pragma("integrity_check", { simple: true }) !== "ok" ||
      (options.sourcePath && identity !== privateFile(options.sourcePath))
    )
      throw new Error("The Watch restore could not verify its data");
    output.close();
    output = undefined;
    fsyncFileSync(options.destinationPath);
    if (sqliteFileLooksPlaintext(options.destinationPath))
      throw new Error("The restored Watch store was not encrypted");
    completed = true;
    return { rowsPreserved, watchesPaused, pendingWorkDiscarded };
  } finally {
    output?.close();
    source?.close();
    if (created && !completed)
      for (const suffix of ["", "-wal", "-shm", "-journal"])
        rmSync(options.destinationPath + suffix, { force: true });
  }
}
function identifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
function privateFile(path: string): string {
  const info = lstatSync(path, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    (info.mode & 0o077n) !== 0n ||
    (process.getuid && info.uid !== BigInt(process.getuid())) ||
    realpathSync(path) !== resolve(path)
  )
    throw new Error("The Watch restore input must be a private regular file");
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
}
