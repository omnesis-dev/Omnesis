// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants, closeSync, lstatSync, openSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import CipherDatabase from "better-sqlite3-multiple-ciphers";
import { isDeviceKind } from "@omnesis/types";
import { fsyncFileSync, assertNever } from "@omnesis/core";
import {
  openEncryptedSqlite,
  sqliteFileLooksPlaintext,
  type EncryptedSqliteDatabase,
} from "../sqlite-encryption.js";
import { runSchemaSetup } from "../data/schema.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "../data/migrations.js";
import { desktopRestoreReviewedTables, desktopRestoreTablePolicy } from "./authority-policy.js";
import type { Db } from "../data/types.js";

type Row = Record<string, unknown>;
interface Column {
  name: string;
  notnull: number;
  dflt_value: string | null;
}
export interface RestoredMainDatabase {
  sourcesPaused: number;
  foreignDevicesRetained: number;
  targetDevicesPreserved: number;
  targetLabs: { brain: boolean; tasks: boolean; watches: boolean };
}

export type RestoredMainSource =
  | { sourcePath: string; sourceKey: Buffer; sourceImage?: never }
  | { sourcePath?: never; sourceKey?: never; sourceImage: Buffer };
export interface RestoredMainInspection {
  schemaVersion: number;
  sources: number;
  documents: number;
  devices: number;
  legacy: boolean;
}
export function inspectRestoredMainDatabase(input: RestoredMainSource): RestoredMainInspection {
  const identity = input.sourcePath ? privateRegularFile(input.sourcePath) : null;
  let source: EncryptedSqliteDatabase | undefined;
  try {
    source = openSource(input);
    validateInput(source);
    if (source.pragma("user_version", { simple: true }) !== LATEST_SCHEMA_VERSION)
      throw new Error("Unsupported backup schema");
    const count = (table: "sources" | "documents" | "devices") =>
      Number(source!.prepare(`SELECT count(*) FROM ${table}`).pluck().get());
    const result = {
      schemaVersion: LATEST_SCHEMA_VERSION,
      sources: count("sources"),
      documents: count("documents"),
      devices: count("devices"),
      legacy: input.sourceImage !== undefined,
    };
    if (input.sourcePath && identity !== privateRegularFile(input.sourcePath))
      throw new Error("Changed backup input");
    return result;
  } finally {
    source?.close();
  }
}

/** Run only in the restore worker. Neither input database is ever mutated. */
export type RestoredMainDatabaseOptions = {
  targetPath: string;
  destinationPath: string;
  targetKey: Buffer;
  destinationKey: Buffer;
} & RestoredMainSource;

export function reconcileRestoredMainDatabase(
  options: RestoredMainDatabaseOptions,
): RestoredMainDatabase {
  if (
    options.targetKey.length !== 32 ||
    options.destinationKey.length !== 32 ||
    (options.sourceKey !== undefined && options.sourceKey.length !== 32)
  )
    throw new Error("The restore storage keys are unavailable");
  if (
    options.sourceImage &&
    (options.sourceImage.length > 64 * 1024 * 1024 ||
      !options.sourceImage.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")))
  )
    throw new Error("This legacy database is not supported for an encrypted memory-only restore");
  const sourceIdentity = options.sourcePath ? privateRegularFile(options.sourcePath) : null;
  const targetIdentity = privateRegularFile(options.targetPath);
  let source: EncryptedSqliteDatabase | undefined;
  let target: EncryptedSqliteDatabase | undefined;
  let output: EncryptedSqliteDatabase | undefined;
  let created = false;
  let completed = false;
  try {
    source = openSource(options);
    target = openEncryptedSqlite(options.targetPath, {
      key: options.targetKey,
      readonly: true,
      fileMustExist: true,
      migratePlaintext: false,
    });
    target.pragma("trusted_schema = OFF");
    validateInput(source);
    validateInput(target);
    // This first adapter refuses older schemas before mutation. Migrations must
    // be added explicitly; opening the backup never invokes its SQL triggers.
    if (
      source.pragma("user_version", { simple: true }) !== LATEST_SCHEMA_VERSION ||
      target.pragma("user_version", { simple: true }) !== LATEST_SCHEMA_VERSION
    )
      throw new Error("Restore requires a backup compatible with this gateway database schema");
    const fd = openSync(
      options.destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    created = true;
    output = openEncryptedSqlite(options.destinationPath, {
      key: options.destinationKey,
      migratePlaintext: false,
    });
    const db = output as unknown as Db;
    runSchemaSetup(db);
    runMigrations(db);
    output.pragma("foreign_keys = OFF");
    output.pragma("journal_mode = DELETE");
    // Copy rows into our schema, never the foreign sqlite_master program.
    // Suppress even trusted write producers while replaying historical records.
    const triggers = output
      .prepare<[], { name: string; sql: string }>(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger'",
      )
      .all();
    for (const trigger of triggers) output.exec(`DROP TRIGGER ${identifier(trigger.name)}`);
    const tables = desktopRestoreReviewedTables();
    for (const name of tables) output.exec(`DELETE FROM ${identifier(name)}`);
    for (const name of tables) {
      const policy = desktopRestoreTablePolicy(name);
      switch (policy) {
        case "keep-target":
          copyRows(target, output, name);
          break;
        case "import-data":
        case "pause-data":
        case "pause-sources":
        case "review-memberships":
          copyRows(source, output, name);
          break;
        case "discard-work":
        case "rebuild-derived":
        case "reconcile-devices":
          break;
        default:
          assertNever(policy);
      }
    }
    const devices = reconcileDevices(source, target, output);
    const sourcesPaused = output.prepare("UPDATE sources SET enabled=0").run().changes;
    output.exec("UPDATE knowledge_candidates SET decision_pending=0, reconsider_at=NULL");
    output.exec(
      "UPDATE note_agent_runs SET state='skipped',baseline=1,pending_mutations=0 WHERE state IN ('pending','running')",
    );
    const reviewTime = Date.now();
    output
      .prepare(
        `INSERT INTO note_agent_runs(entry_id,input_text,state,run_after,created_at,updated_at,baseline)
      SELECT n.id,n.text,'skipped',?,?,?,1 FROM note_entries n
      WHERE n.from_owner=1 AND NOT EXISTS(SELECT 1 FROM note_agent_runs r WHERE r.entry_id=n.id)`,
      )
      .run(reviewTime, reviewTime, reviewTime);
    output
      .prepare(
        "INSERT INTO note_agent_meta(key,value) VALUES('scanned',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(new Date(reviewTime).toISOString());
    output.exec("UPDATE voice_note_transcriptions SET next_attempt_at='9999-12-31T23:59:59.999Z'");
    output.exec("UPDATE subscriptions SET status='paused' WHERE status='active'");
    output.exec(
      "UPDATE cognition_runs SET status='failed',failure_code='restored_history',last_error=NULL WHERE status IN ('pending','running')",
    );
    const targetLabs = { brain: false, tasks: false, watches: false };
    for (const row of target
      .prepare<[], { id: string; enabled: number }>("SELECT id,enabled FROM lab_features")
      .all()) {
      if (row.id === "brain" || row.id === "tasks" || row.id === "watches")
        targetLabs[row.id] = row.enabled === 1;
    }
    // Restored records are reviewed before any autonomous processing. The
    // caller retains prior target opt-ins in the confirmation/recovery journal.
    output.exec("UPDATE lab_features SET enabled=0");
    for (const trigger of triggers) output.exec(trigger.sql);
    // Reinstall safe singleton/cache seeds without replaying any foreign DDL.
    runSchemaSetup(db);
    const foreignKeys = output.pragma("foreign_key_check");
    if (
      !Array.isArray(foreignKeys) ||
      foreignKeys.length !== 0 ||
      output.pragma("integrity_check", { simple: true }) !== "ok"
    )
      throw new Error("The restored database does not satisfy its storage constraints");
    if (
      (options.sourcePath !== undefined &&
        sourceIdentity !== privateRegularFile(options.sourcePath)) ||
      targetIdentity !== privateRegularFile(options.targetPath)
    )
      throw new Error("The library changed while its restore was being prepared");
    output.close();
    output = undefined;
    fsyncFileSync(options.destinationPath);
    if (sqliteFileLooksPlaintext(options.destinationPath))
      throw new Error("The restored database was not protected");
    completed = true;
    return { sourcesPaused, ...devices, targetLabs };
  } catch {
    throw new Error("The backup data could not be reconciled with this Mac's library authority");
  } finally {
    output?.close();
    target?.close();
    source?.close();
    // A caller publishes only an explicitly returned result. On failure this
    // incomplete destination is private staging, never a replacement library.
    if (created && !completed) {
      for (const suffix of ["", "-wal", "-shm", "-journal"])
        rmSync(`${options.destinationPath}${suffix}`, { force: true });
    }
  }
}

function validateInput(db: EncryptedSqliteDatabase): void {
  const tables = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
  for (const name of tables) desktopRestoreTablePolicy(name);
  if (JSON.stringify(tables) !== JSON.stringify(desktopRestoreReviewedTables()))
    throw new Error("The backup database schema is incomplete");
  if (db.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error("The backup database is damaged");
}
function copyRows(
  source: EncryptedSqliteDatabase,
  output: EncryptedSqliteDatabase,
  table: string,
): void {
  const expected = columns(output, table);
  const actual = columns(source, table);
  if (
    JSON.stringify(expected.map(({ name }) => name).sort()) !==
    JSON.stringify(actual.map(({ name }) => name).sort())
  )
    throw new Error("The backup database columns need a reviewed migration");
  const names = expected.map(({ name }) => identifier(name)).join(",");
  const insert = output.prepare(
    `INSERT INTO ${identifier(table)} (${names}) VALUES (${expected.map(() => "?").join(",")})`,
  );
  const copy = output.transaction(() => {
    for (const row of source
      .prepare(`SELECT ${names} FROM ${identifier(table)}`)
      .iterate() as Iterable<Row>)
      insert.run(...expected.map(({ name }) => row[name]));
  });
  copy();
}
function reconcileDevices(
  source: EncryptedSqliteDatabase,
  target: EncryptedSqliteDatabase,
  output: EncryptedSqliteDatabase,
): { foreignDevicesRetained: number; targetDevicesPreserved: number } {
  copyRows(target, output, "devices");
  const existing = new Set(
    output
      .prepare<[], { id: string }>("SELECT id FROM devices")
      .all()
      .map(({ id }) => id),
  );
  const names = new Set(
    output
      .prepare<[], { name: string }>("SELECT name FROM devices")
      .all()
      .map(({ name }) => name),
  );
  const fields = columns(output, "devices");
  const insert = output.prepare(
    `INSERT INTO devices (${fields.map(({ name }) => identifier(name)).join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
  );
  let foreignDevicesRetained = 0;
  let nextLabel = 1;
  for (const row of source
    .prepare("SELECT id,name,kind,paired_at,self_emails,self_phones FROM devices")
    .iterate() as Iterable<Row>) {
    if (typeof row.id !== "string" || existing.has(row.id)) continue;
    if (typeof row.kind !== "string" || !isDeviceKind(row.kind))
      throw new Error("The backup device kind is unsupported");
    const original = typeof row.name === "string" ? row.name.slice(0, 96) : "device";
    let name: string;
    do {
      name = `Restored device ${nextLabel++}: ${original}`;
    } while (names.has(name));
    names.add(name);
    const safe: Row = {
      id: row.id,
      name,
      kind: row.kind,
      paired_at: row.paired_at,
      self_emails: row.self_emails,
      self_phones: row.self_phones,
      capabilities: "{}",
      revoked_at: Date.now(),
    };
    insert.run(...fields.map((field) => safe[field.name] ?? null));
    foreignDevicesRetained++;
  }
  return { foreignDevicesRetained, targetDevicesPreserved: existing.size };
}
function columns(db: EncryptedSqliteDatabase, name: string): Column[] {
  return db.prepare<[], Column>(`PRAGMA table_info(${identifier(name)})`).all();
}
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
function privateRegularFile(path: string): string {
  const file = lstatSync(path, { bigint: true });
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1n ||
    (file.mode & 0o077n) !== 0n ||
    (process.getuid && file.uid !== BigInt(process.getuid())) ||
    realpathSync(path) !== resolve(path)
  )
    throw new Error("The restore input must be a private owned regular file");
  return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
}

function openSource(input: RestoredMainSource): EncryptedSqliteDatabase {
  if (
    input.sourceImage &&
    (input.sourceImage.length > 64 * 1024 * 1024 ||
      !input.sourceImage.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")))
  )
    throw new Error("Unsupported legacy restore image");
  const db = input.sourcePath
    ? openEncryptedSqlite(input.sourcePath, {
        key: input.sourceKey,
        readonly: true,
        fileMustExist: true,
        migratePlaintext: false,
      })
    : new CipherDatabase(input.sourceImage, { readonly: true });
  try {
    db.pragma("trusted_schema = OFF");
    db.pragma("temp_store = MEMORY");
    db.pragma("query_only = ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
