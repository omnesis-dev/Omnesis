// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fixtures for the tests that stage an Apple database the collector cannot
 * read.
 *
 * The denial is staged with a file mode of `000`. That is the same condition
 * macOS's privacy layer produces for a database behind a grant the process
 * does not hold: SQLite reports both as `SQLITE_CANTOPEN: unable to open
 * database file`, which is the string `classifyOpenError` reads. Root ignores
 * the mode, so a test that stages one must skip there.
 */

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { APPLE_EPOCH_OFFSET_SECONDS } from "../epoch.js";
import { AppleProvider } from "../provider.js";

/** Root reads through a 000 file mode, so the denial cannot be staged there. */
export const canDenyReads = (process.getuid?.() ?? 0) !== 0;

export interface AppleDbFixture {
  dir: string;
  notesPath: string;
  imessagePath: string;
  calendarPath: string;
  callLogPath: string;
  provider: AppleProvider;
}

/**
 * A Mac holding the notes, imessage, calendar and call-log databases and
 * nothing else, each seeded with the tables its source reads.
 */
export function makeAppleDbFixture(): AppleDbFixture {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-apple-db-test-"));
  const notesPath = join(dir, "NoteStore.sqlite");
  const imessagePath = join(dir, "chat.db");
  const calendarPath = join(dir, "Calendar.sqlitedb");
  const callLogPath = join(dir, "CallHistory.storedata");

  seedNotesDb(notesPath);
  seedIMessageDb(imessagePath);
  seedCalendarDb(calendarPath);
  seedCallLogDb(callLogPath);

  const provider = new AppleProvider({
    accountId: "tester@example.com",
    notesDbPath: notesPath,
    imessageDbPath: imessagePath,
    calendarDbPath: calendarPath,
    callLogDbPath: callLogPath,
    // The remaining databases point at paths that do not exist, so this host
    // holds exactly the four seeded above.
    remindersDirPath: join(dir, "no-reminders"),
    contactsDirPath: join(dir, "no-contacts"),
    voicemailDbPath: join(dir, "no-voicemail.sqlitedb"),
  });

  return { dir, notesPath, imessagePath, calendarPath, callLogPath, provider };
}

export function seedNotesDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZICCLOUDSYNCINGOBJECT (
      Z_PK INTEGER PRIMARY KEY,
      ZTITLE1 TEXT,
      ZIDENTIFIER TEXT,
      ZCREATIONDATE3 REAL,
      ZMODIFICATIONDATE1 REAL,
      ZNOTEDATA INTEGER,
      ZMARKEDFORDELETION INTEGER DEFAULT 0
    );
    CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB);
  `);
  db.close();
}

/** One inbound message in one one-to-one chat, dated now. */
export function seedIMessageDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, country TEXT, service TEXT);
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      style INTEGER,
      chat_identifier TEXT,
      service_name TEXT,
      display_name TEXT
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      attributedBody BLOB,
      handle_id INTEGER DEFAULT 0,
      date INTEGER DEFAULT 0,
      is_from_me INTEGER DEFAULT 0,
      is_system_message INTEGER DEFAULT 0,
      service TEXT DEFAULT 'iMessage',
      cache_has_attachments INTEGER DEFAULT 0,
      associated_message_guid TEXT,
      associated_message_type INTEGER DEFAULT 0,
      associated_message_emoji TEXT,
      reply_to_guid TEXT,
      thread_originator_guid TEXT,
      group_title TEXT
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      filename TEXT,
      mime_type TEXT,
      transfer_name TEXT,
      total_bytes INTEGER DEFAULT 0
    );
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  db.prepare(
    "INSERT INTO handle (ROWID, id, service) VALUES (1, '+15550100001', 'iMessage')",
  ).run();
  db.prepare(
    "INSERT INTO chat (ROWID, guid, style, chat_identifier, service_name) VALUES (1, 'chat-1', 45, '+15550100001', 'iMessage')",
  ).run();
  const dateNs = (Math.floor(Date.now() / 1000) - APPLE_EPOCH_OFFSET_SECONDS) * 1_000_000_000;
  db.prepare(
    "INSERT INTO message (ROWID, guid, text, handle_id, date, is_from_me) VALUES (1, 'msg-1', 'Are we still on for Thursday?', 1, ?, 0)",
  ).run(dateNs);
  db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1)").run();
  db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1)").run();
  db.close();
}

/** Enough of Calendar.sqlitedb for the source's first query to run. */
export function seedCalendarDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE Store (ROWID INTEGER PRIMARY KEY, type INTEGER, name TEXT);
    CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY, store_id INTEGER, title TEXT);
    CREATE TABLE CalendarItem (
      ROWID INTEGER PRIMARY KEY,
      calendar_id INTEGER,
      entity_type INTEGER,
      hidden INTEGER DEFAULT 0,
      UUID TEXT
    );
  `);
  db.close();
}

/** Enough of CallHistory.storedata for the source's first query to run. */
export function seedCallLogDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZCALLRECORD (
      Z_PK INTEGER PRIMARY KEY,
      ZUNIQUE_ID TEXT,
      ZDATE REAL,
      ZDURATION REAL,
      ZADDRESS BLOB,
      ZORIGINATED INTEGER,
      ZANSWERED INTEGER,
      ZDISCONNECTED_CAUSE INTEGER,
      ZCALLTYPE INTEGER,
      ZSERVICE_PROVIDER TEXT
    );
  `);
  db.close();
}
