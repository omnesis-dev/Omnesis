// SPDX-License-Identifier: AGPL-3.0-or-later

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";

describe("migration 146: member-local source config", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE source_devices (
        source_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, device_id)
      );
      INSERT INTO source_devices (source_id, device_id, added_at)
      VALUES ('claude-code:local', 'device-fictional', 100)
    `);
  });

  afterEach(() => db.close());

  test("adds an idempotent non-null empty override without changing existing membership", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 146)!;
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    expect(
      db
        .prepare("SELECT source_id, device_id, added_at, config_override FROM source_devices")
        .get(),
    ).toEqual({
      source_id: "claude-code:local",
      device_id: "device-fictional",
      added_at: 100,
      config_override: "{}",
    });
    expect(
      db
        .prepare(
          `SELECT "notnull" AS required, dflt_value
             FROM pragma_table_info('source_devices') WHERE name = 'config_override'`,
        )
        .get(),
    ).toEqual({ required: 1, dflt_value: "'{}'" });
  });
});
