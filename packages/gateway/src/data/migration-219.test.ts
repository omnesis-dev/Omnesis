// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 219 — the time an enumeration had read everything its source
 * holds. All fixture data is invented.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { addInventoryFullRead } from "./migration-219-inventory-full-read.js";
import { MIGRATIONS } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});

afterEach(() => db.close());

const columns = (): string[] =>
  (db.pragma("table_info(source_inventories)") as { name: string }[]).map((row) => row.name);

test("is the migration at its slot", () => {
  expect(MIGRATIONS.find((m) => m.version === 219)?.up).toBe(addInventoryFullRead);
});

test("adds the column, leaves existing enumerations without a full read, and runs twice", () => {
  db.exec(`
    CREATE TABLE source_inventories (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, cursor_row TEXT NOT NULL,
      started_at TEXT NOT NULL, completed_at INTEGER,
      min_source_version INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO source_inventories (id, source_id, cursor_row, started_at, completed_at)
      VALUES ('inventory-1', 'fixture-notes:studio', '', '2027-03-01T09:00:00.000Z', 5);
  `);
  addInventoryFullRead(db);
  addInventoryFullRead(db);
  expect(columns()).toContain("full_read_at");
  expect(db.prepare("SELECT full_read_at, completed_at FROM source_inventories").all()).toEqual([
    { full_read_at: null, completed_at: 5 },
  ]);
});

test("an install whose inventory table does not exist yet still upgrades", () => {
  addInventoryFullRead(db);
  expect(columns()).toEqual([]);
});

test("a new install has the column from its schema", () => {
  runSchemaSetup(db);
  expect(columns()).toContain("full_read_at");
});
