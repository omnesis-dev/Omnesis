// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

describe("migration 105 — conversation read state", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as Db;
    runSchemaSetup(db);
  });

  afterEach(() => {
    db.close();
  });

  test("creates the table on an install upgrading from v104", () => {
    db.exec(`
      DROP TABLE conversation_read_state;
      PRAGMA user_version = 104;
    `);

    runMigrations(db);

    const columns = db
      .prepare<[], { name: string }>(
        "SELECT name FROM pragma_table_info('conversation_read_state')",
      )
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(["conversation_id", "unread_since"]));
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("leaves an upgraded install with every existing conversation read", () => {
    db.exec(`
      DROP TABLE conversation_read_state;
      PRAGMA user_version = 104;
    `);

    runMigrations(db);

    // Nothing is backfilled: transcripts that predate the feature must not
    // greet the operator as a wall of unread dots.
    const rows = db
      .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM conversation_read_state")
      .get();
    expect(rows?.count).toBe(0);
  });

  test("exists and is the head of the list", () => {
    expect(MIGRATIONS.find((candidate) => candidate.version === 105)).toBeDefined();
    expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBe(LATEST_SCHEMA_VERSION);
  });

  test("is idempotent when fresh schema setup already created the table", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 105);
    expect(migration).toBeDefined();
    expect(() => migration!.up(db)).not.toThrow();
    expect(() => migration!.up(db)).not.toThrow();
  });
});
