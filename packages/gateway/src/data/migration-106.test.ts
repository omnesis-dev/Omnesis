// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { MIGRATIONS } from "./migrations.js";

const migration = MIGRATIONS.find((item) => item.version === 106)!;

describe("migration 106 — note capture clock context", () => {
  test("adds nullable context columns without inventing values for existing notes", () => {
    const db = new BetterSqlite3(":memory:");
    db.exec(`
      CREATE TABLE note_entries (
        id TEXT PRIMARY KEY, day TEXT NOT NULL, captured_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, text TEXT NOT NULL, surface TEXT, device_id TEXT,
        latitude REAL, longitude REAL, place_name TEXT
      );
      INSERT INTO note_entries
        (id, day, captured_at, updated_at, text)
      VALUES
        ('old', '2026-08-14', '2026-08-14T10:00:00.000Z', '2026-08-14T10:00:00.000Z', 'Legacy note');
    `);

    migration.up(db);
    migration.up(db);

    expect(
      db
        .prepare(
          "SELECT captured_time_zone_id, captured_utc_offset_seconds, received_at FROM note_entries WHERE id = 'old'",
        )
        .get(),
    ).toEqual({
      captured_time_zone_id: null,
      captured_utc_offset_seconds: null,
      received_at: null,
    });
    db.close();
  });
});
