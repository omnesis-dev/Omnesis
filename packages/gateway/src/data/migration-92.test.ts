// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

describe("migration 92 — cognition run failure codes", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as Db;
    runSchemaSetup(db);
  });

  afterEach(() => {
    db.close();
  });

  test("adds failure_code to an existing v91 cognition_runs table", () => {
    db.exec(`
      ALTER TABLE cognition_runs DROP COLUMN failure_code;
      PRAGMA user_version = 91;
    `);

    runMigrations(db);

    const columns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('cognition_runs')")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("failure_code");
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("is idempotent when fresh schema setup already created the column", () => {
    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('cognition_runs')")
        .all()
        .map((row) => row.name),
    ).toContain("failure_code");

    const migration = MIGRATIONS.find((candidate) => candidate.version === 92);
    expect(migration).toBeDefined();
    expect(() => migration!.up(db)).not.toThrow();
    expect(() => migration!.up(db)).not.toThrow();
  });
});
