// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared macOS database paths for Apple data sources.
 * Used by both the provider (runtime) and descriptors (discovery).
 */

import { join } from "node:path";

const HOME = process.env.HOME ?? "~";

/** NoteStore.sqlite path on macOS */
export const NOTES_DB_PATH = join(
  HOME,
  "Library",
  "Group Containers",
  "group.com.apple.notes",
  "NoteStore.sqlite",
);

/** Reminders stores directory on macOS */
export const REMINDERS_DIR = join(
  HOME,
  "Library",
  "Group Containers",
  "group.com.apple.reminders",
  "Container_v1",
  "Stores",
);

/** iMessage chat.db path on macOS */
export const IMESSAGE_DB_PATH = join(HOME, "Library", "Messages", "chat.db");

/** Calendar.sqlitedb path on macOS */
export const CALENDAR_DB_PATH = join(
  HOME,
  "Library",
  "Group Containers",
  "group.com.apple.calendar",
  "Calendar.sqlitedb",
);

/** AddressBook directory on macOS */
export const CONTACTS_DIR = join(HOME, "Library", "Application Support", "AddressBook");

/** Filename of the main AddressBook SQLite database. */
export const CONTACTS_DB_FILENAME = "AddressBook-v22.abcddb";

/** Resolve the main AddressBook DB path inside an AddressBook directory. */
export function contactsDbFile(dir: string): string {
  return join(dir, CONTACTS_DB_FILENAME);
}

/** Default single-file AddressBook path (under `CONTACTS_DIR`). */
export const CONTACTS_DB_PATH = contactsDbFile(CONTACTS_DIR);

/** CallHistory.storedata path on macOS — live iCloud-synced call log (phone + FaceTime). */
export const CALL_LOG_DB_PATH = join(
  HOME,
  "Library",
  "Application Support",
  "CallHistoryDB",
  "CallHistory.storedata",
);

/** macOS 26 Phone.app's local, iCloud-synced carrier-voicemail store. */
export const VOICEMAIL_DATA_DIR = join(
  HOME,
  "Library",
  "Group Containers",
  "group.com.apple.FaceTime",
  "com.apple.facetimemessagestored",
  "Data Store",
);

export const VOICEMAIL_DB_PATH = join(VOICEMAIL_DATA_DIR, "FaceTimeMessageStore-local.sqlitedb");
