// SPDX-License-Identifier: AGPL-3.0-or-later

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";

describe("migration 147: source member-config contracts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY);
      CREATE TABLE sources (id TEXT PRIMARY KEY);
      INSERT INTO sources (id) VALUES ('notes-synth:fictional')
    `);
  });

  afterEach(() => db.close());

  test("creates an idempotent source-lifetime contract table with cascade cleanup", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 147)!;
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    db.prepare(
      "INSERT INTO source_member_config_contracts (source_id, param_names) VALUES (?, ?)",
    ).run("notes-synth:fictional", '["dataPath"]');
    expect(db.prepare("SELECT param_names FROM source_member_config_contracts").get()).toEqual({
      param_names: '["dataPath"]',
    });

    db.prepare("DELETE FROM sources WHERE id = ?").run("notes-synth:fictional");
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM source_member_config_contracts").get(),
    ).toEqual({ count: 0 });
  });
});
