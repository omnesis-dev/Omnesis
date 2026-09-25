// SPDX-License-Identifier: AGPL-3.0-or-later

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";

describe("migration 148: post-transition publication journal", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE sources (id TEXT PRIMARY KEY);
      INSERT INTO sources (id) VALUES ('notes-synth:fictional')
    `);
  });

  afterEach(() => db.close());

  test("creates an idempotent source-scoped journal with cascade cleanup", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 148)!;
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    db.prepare(
      `INSERT INTO source_mode_transition_publications
         (source_id, completed_at, last_error) VALUES (?, ?, ?)`,
    ).run("notes-synth:fictional", 123, "synthetic outage");
    expect(
      db.prepare("SELECT completed_at, last_error FROM source_mode_transition_publications").get(),
    ).toEqual({
      completed_at: 123,
      last_error: "synthetic outage",
    });

    db.prepare("DELETE FROM sources WHERE id = ?").run("notes-synth:fictional");
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM source_mode_transition_publications").get(),
    ).toEqual({ count: 0 });
  });
});
