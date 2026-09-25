// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

const migration = MIGRATIONS.find((candidate) => candidate.version === 113)!;

describe("migration 113", () => {
  test("adds the complete permission-health and reauth reservation shape idempotently", () => {
    const db = new Database(":memory:") as unknown as Db;
    db.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY);
      CREATE TABLE sources (id TEXT PRIMARY KEY, device_id TEXT REFERENCES devices(id));
      CREATE TABLE reauth_reminders (
        principal TEXT PRIMARY KEY,
        last_notified_at INTEGER NOT NULL,
        notify_count INTEGER NOT NULL
      );
    `);

    expect(() => migration.up(db)).not.toThrow();
    expect(() => migration.up(db)).not.toThrow();

    const healthColumns = db
      .prepare<[], { name: string }>(
        "SELECT name FROM pragma_table_info('mobile_permission_health')",
      )
      .all()
      .map((row) => row.name);
    expect(healthColumns).toEqual(
      expect.arrayContaining([
        "checked_at",
        "received_at",
        "valid_until",
        "capabilities_json",
        "episode_id",
        "reservation_token",
        "reserved_until",
      ]),
    );
    const reauthColumns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('reauth_reminders')")
      .all()
      .map((row) => row.name);
    expect(reauthColumns).toEqual(expect.arrayContaining(["reservation_token", "reserved_until"]));
    db.close();
  });
});
