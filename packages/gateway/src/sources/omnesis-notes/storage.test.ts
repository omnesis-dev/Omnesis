// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;

import BetterSqlite3 from "better-sqlite3";

import { createDatabase } from "../../db.js";
import {
  createNoteEntriesTables,
  deleteNoteEntry,
  getNoteEntry,
  insertNoteEntry,
  listNoteEntriesForDay,
  updateNoteEntryText,
  type NoteEntry,
} from "./storage.js";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function makeEntry(overrides: Partial<NoteEntry> = {}): NoteEntry {
  const capturedAt = overrides.capturedAt ?? "2026-06-15T09:30:00.000Z";
  return {
    id: overrides.id ?? randomUUID(),
    day: "2026-06-15",
    capturedAt,
    updatedAt: capturedAt,
    text: "Remember to book the dentist",
    surface: "cli",
    deviceId: null,
    latitude: null,
    longitude: null,
    placeName: null,
    capturedTimeZoneId: null,
    capturedUtcOffsetSeconds: null,
    receivedAt: null,
    ...overrides,
  };
}

describe("note_entries storage", () => {
  let dbPath: string;
  let db: Db;
  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath); // schema setup creates note_entries
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("insert + get round-trips every field", () => {
    const entry = makeEntry({
      deviceId: "dev-1",
      surface: "ios-siri",
      capturedTimeZoneId: "Europe/London",
      capturedUtcOffsetSeconds: 3_600,
      receivedAt: "2026-06-15T09:30:04.000Z",
    });
    insertNoteEntry(db, entry);
    expect(getNoteEntry(db, entry.id)).toEqual(entry);
  });

  test("insert + get round-trips a geotagged capture", () => {
    const entry = makeEntry({
      surface: "ios-siri",
      latitude: 48.8566,
      longitude: 2.3522,
      placeName: "Paris",
    });
    insertNoteEntry(db, entry);
    const stored = getNoteEntry(db, entry.id);
    expect(stored).toEqual(entry);
    expect(stored?.latitude).toBeCloseTo(48.8566, 4);
    expect(stored?.longitude).toBeCloseTo(2.3522, 4);
    expect(stored?.placeName).toBe("Paris");
  });

  test("get returns null for an unknown id", () => {
    expect(getNoteEntry(db, "nope")).toBeNull();
  });

  test("listNoteEntriesForDay returns only that day's entries, in capture order", () => {
    const late = makeEntry({ capturedAt: "2026-06-15T18:00:00.000Z", text: "late" });
    const early = makeEntry({ capturedAt: "2026-06-15T08:00:00.000Z", text: "early" });
    const otherDay = makeEntry({ day: "2026-06-16", capturedAt: "2026-06-16T08:00:00.000Z" });
    insertNoteEntry(db, late);
    insertNoteEntry(db, early);
    insertNoteEntry(db, otherDay);

    const entries = listNoteEntriesForDay(db, "2026-06-15");
    expect(entries.map((e) => e.text)).toEqual(["early", "late"]);
    expect(listNoteEntriesForDay(db, "2026-06-16")).toHaveLength(1);
    expect(listNoteEntriesForDay(db, "2026-06-17")).toEqual([]);
  });

  test("updateNoteEntryText replaces the text and bumps updated_at only", () => {
    const entry = makeEntry();
    insertNoteEntry(db, entry);
    const ok = updateNoteEntryText(
      db,
      entry.id,
      "Dentist booked — cancel reminder",
      "2026-06-15T12:00:00.000Z",
    );
    expect(ok).toBe(true);
    const after = getNoteEntry(db, entry.id);
    expect(after?.text).toBe("Dentist booked — cancel reminder");
    expect(after?.updatedAt).toBe("2026-06-15T12:00:00.000Z");
    expect(after?.capturedAt).toBe(entry.capturedAt);
    expect(after?.day).toBe(entry.day);
  });

  test("updateNoteEntryText returns false for an unknown id", () => {
    expect(updateNoteEntryText(db, "nope", "x", "2026-06-15T12:00:00.000Z")).toBe(false);
  });

  test("deleteNoteEntry hard-deletes and reports the entry's day", () => {
    const entry = makeEntry();
    insertNoteEntry(db, entry);
    expect(deleteNoteEntry(db, entry.id)).toEqual({ deleted: true, day: "2026-06-15" });
    expect(getNoteEntry(db, entry.id)).toBeNull();
  });

  test("deleteNoteEntry on an unknown id reports deleted: false", () => {
    expect(deleteNoteEntry(db, "nope")).toEqual({ deleted: false, day: null });
  });

  test("createNoteEntriesTables self-heals a legacy table missing the location columns", () => {
    const legacy = new BetterSqlite3(":memory:");
    // The pre-location table shape, plus a row captured before columns existed.
    legacy.exec(`
      CREATE TABLE note_entries (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        text TEXT NOT NULL,
        surface TEXT,
        device_id TEXT
      );
      INSERT INTO note_entries (id, day, captured_at, updated_at, text, surface, device_id)
      VALUES ('old', '2026-06-15', '2026-06-15T09:00:00.000Z', '2026-06-15T09:00:00.000Z', 'legacy', 'cli', NULL);
    `);

    createNoteEntriesTables(legacy);

    const cols = new Set(
      (
        legacy.prepare("SELECT name FROM pragma_table_info('note_entries')").all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    expect(cols.has("latitude")).toBe(true);
    expect(cols.has("longitude")).toBe(true);
    expect(cols.has("place_name")).toBe(true);
    // The pre-existing row survives with null location, and a fresh
    // geotagged insert round-trips through the healed table.
    expect(getNoteEntry(legacy, "old")).toMatchObject({ text: "legacy", latitude: null });
    insertNoteEntry(
      legacy,
      makeEntry({ id: "new", latitude: 51.5074, longitude: -0.1278, placeName: "London" }),
    );
    expect(getNoteEntry(legacy, "new")?.placeName).toBe("London");
    legacy.close();
  });
});
