// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";

describe("migration 69 — exact agent repair targets", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    runSchemaSetup(db);
  });

  afterEach(() => db.close());

  test("adds the repair target column idempotently", () => {
    db.exec(`
      ALTER TABLE device_pairings DROP COLUMN repair_device_id;
      PRAGMA user_version = 68;
    `);
    const migration = MIGRATIONS.find((candidate) => candidate.version === 69);
    if (!migration) throw new Error("migration 69 not found");

    runMigrations(db, { migrations: [migration] });
    migration.up(db);

    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('device_pairings')")
        .all()
        .map((row) => row.name),
    ).toContain("repair_device_id");
  });
});
