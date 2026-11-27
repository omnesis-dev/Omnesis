// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ProviderId, SourceId } from "@omnesis/types";

/** The layout of omatel's `messages.db` at schema 1, as the files on a phone hold it. */
const MESSAGES_DDL = `
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY, address TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
    muted INTEGER NOT NULL DEFAULT 0, draft TEXT NOT NULL DEFAULT '', draft_at INTEGER,
    last_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE participants (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    number TEXT NOT NULL, raw_number TEXT NOT NULL);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    transport TEXT NOT NULL DEFAULT 'sms', sender TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, sent_at INTEGER, delivered_at INTEGER,
    state TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, mm_path TEXT, mm_reference INTEGER,
    mms_path TEXT, dedupe_key TEXT UNIQUE, error TEXT);
  CREATE TABLE parts (
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    mime TEXT NOT NULL, file TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0);
  PRAGMA user_version = 1;
`;

/** The layout of omatel's `calls.db` at schema 2. */
const CALLS_DDL = `
  CREATE TABLE calls (
    id INTEGER PRIMARY KEY, number TEXT NOT NULL, raw_number TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')), outcome TEXT NOT NULL,
    started_at INTEGER NOT NULL, answered_at INTEGER, ended_at INTEGER,
    duration INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE favorites (uid TEXT PRIMARY KEY, position INTEGER NOT NULL);
  PRAGMA user_version = 2;
`;

export const sourceId = SourceId("omatel-messages:local");
export const callsSourceId = SourceId("omatel-calls:local");
export const providerId = ProviderId("omatel");

/** Epoch milliseconds of a UTC instant, e.g. `at("2026-03-04T09:15")`. */
export function at(iso: string): number {
  return Date.parse(`${iso}:00.000Z`);
}

export interface OmatelFixture {
  dir: string;
  messages(): Database.Database;
  calls(): Database.Database;
  /**
   * Take one store, or the whole data folder, off disk the way a replace or
   * a move would; the answer puts it back where it was.
   */
  hide(file?: "messages.db" | "calls.db"): () => void;
  cleanup(): void;
}

/** A temporary omatel data folder; each store is created on first use. */
export function omatelFixture(): OmatelFixture {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-omatel-"));
  const open = (file: string, ddl: string) => {
    const db = new Database(join(dir, file));
    if ((db.pragma("user_version", { simple: true }) as number) === 0) {
      db.pragma("journal_mode = WAL");
      db.exec(ddl);
    }
    return db;
  };
  let messages: Database.Database | undefined;
  let calls: Database.Database | undefined;
  return {
    dir,
    messages: () => (messages ??= open("messages.db", MESSAGES_DDL)),
    calls: () => (calls ??= open("calls.db", CALLS_DDL)),
    hide(file) {
      // Everything committed is in the main file, so the store that comes
      // back is the one that went.
      for (const db of [messages, calls]) db?.pragma("wal_checkpoint(TRUNCATE)");
      const from = file ? join(dir, file) : dir;
      const away = `${from}.away`;
      renameSync(from, away);
      return () => renameSync(away, from);
    },
    cleanup() {
      messages?.close();
      calls?.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}.away`, { recursive: true, force: true });
    },
  };
}

export function addConversation(
  db: Database.Database,
  address: string,
  title = "",
  members: string[] = [address],
): number {
  const id = Number(
    db
      .prepare("INSERT INTO conversations (address, title, created_at) VALUES (?, ?, 0)")
      .run(address, title).lastInsertRowid,
  );
  for (const number of members) {
    db.prepare(
      "INSERT INTO participants (conversation_id, number, raw_number) VALUES (?, ?, ?)",
    ).run(id, number, number);
  }
  return id;
}

export function addMessage(
  db: Database.Database,
  conversation: number,
  message: {
    direction: "in" | "out";
    body: string;
    at: number;
    state?: string;
    sender?: string;
    transport?: string;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO messages (conversation_id, direction, transport, sender, body, at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversation,
        message.direction,
        message.transport ?? "sms",
        message.sender ?? "",
        message.body,
        message.at,
        message.state ?? (message.direction === "in" ? "received" : "sent"),
      ).lastInsertRowid,
  );
}

export function addCall(
  db: Database.Database,
  call: {
    number: string;
    direction: "in" | "out";
    outcome: string;
    startedAt: number;
    duration?: number;
    rawNumber?: string;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calls (number, raw_number, direction, outcome, started_at, duration)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.number,
        call.rawNumber ?? call.number,
        call.direction,
        call.outcome,
        call.startedAt,
        call.duration ?? 0,
      ).lastInsertRowid,
  );
}
