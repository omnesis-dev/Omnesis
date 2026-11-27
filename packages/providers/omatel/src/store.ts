// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SyncError } from "@omnesis/types";

export type Db = Database.Database;

/**
 * Where omatel keeps its stores: `$XDG_DATA_HOME/omatel`, or
 * `~/.local/share/omatel`. Omamobile's Phone and Messages apps share it.
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  return join(xdg ? xdg : join(env.HOME ?? homedir(), ".local", "share"), "omatel");
}

/** One omatel store and the most recent schema this source knows how to read. */
export interface StoreSpec {
  file: "messages.db" | "calls.db";
  /** The newest `user_version` whose layout this source has been checked against. */
  maxSchema: number;
  /** Columns each read table must have. A missing one is a layout this source cannot read. */
  columns: Record<string, readonly string[]>;
}

export const MESSAGES_STORE: StoreSpec = {
  file: "messages.db",
  maxSchema: 1,
  columns: {
    conversations: ["id", "address", "title"],
    participants: ["conversation_id", "number"],
    messages: ["id", "conversation_id", "direction", "transport", "sender", "body", "at", "state"],
    parts: ["message_id", "mime", "file"],
  },
};

export const CALLS_STORE: StoreSpec = {
  file: "calls.db",
  maxSchema: 2,
  columns: {
    calls: ["id", "number", "raw_number", "direction", "outcome", "started_at", "duration"],
  },
};

function permissionError(path: string, code: string): SyncError {
  return new SyncError(
    "permission",
    `Cannot open ${path} for reading (${code}). Check that the collector runs as the phone's user.`,
  );
}

/**
 * Whether the store's file is on disk. A file or folder that is not there
 * answers false; a folder this process may not look into is a permission
 * failure, not an absence — reading it as an empty store would delete what
 * was indexed from it.
 */
function storeExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    if (code === "EACCES" || code === "EPERM") throw permissionError(path, code);
    throw err;
  }
}

/**
 * Open one store read-only, or answer `null` when it is not on disk — omatel
 * creates each file the first time its app needs it, so a phone that never
 * placed a call has no `calls.db`. What a missing store means for the index
 * is the caller's to decide (`storeUnavailablePage`).
 *
 * A store written by a newer omatel than this source has been checked against
 * is refused rather than guessed at: omatel migrates forward in place, and a
 * renamed or repurposed column read with the old meaning would index wrong
 * data without any error.
 */
export function openStore(dataDir: string, spec: StoreSpec): Db | null {
  const path = join(dataDir, spec.file);
  if (!storeExists(path)) return null;
  let db: Db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EACCES" || code === "SQLITE_CANTOPEN" || code === "SQLITE_PERM") {
      throw permissionError(path, code);
    }
    throw err;
  }
  try {
    // omatel writes with WAL and synchronous=FULL; a reader only has to wait
    // out the agent's short write transactions.
    db.pragma("busy_timeout = 5000");
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version > spec.maxSchema) {
      throw new SyncError(
        "unknown",
        `omatel's ${spec.file} is at schema ${version}, newer than the ${spec.maxSchema} this version of Omnesis reads. Update Omnesis to read it.`,
      );
    }
    for (const [table, required] of Object.entries(spec.columns)) {
      const present = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
      );
      const missing = required.filter((c) => !present.has(c));
      if (missing.length > 0) {
        throw new SyncError(
          "unknown",
          `omatel's ${spec.file} has no ${table}.${missing.join(`, ${table}.`)}; this layout is not one Omnesis reads.`,
        );
      }
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
