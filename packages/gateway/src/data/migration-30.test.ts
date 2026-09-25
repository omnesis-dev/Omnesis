// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 30: per-name occurrence_count + is_primary on person_aliases.
 *
 * The regression this guards: `runSchemaSetup` runs on EVERY boot, BEFORE
 * migrations. An existing pre-v30 `person_aliases` lacks the new columns, so any
 * `runSchemaSetup` statement referencing them (e.g. an index) crashes the boot
 * before migration 30 can add them. This exercises that exact existing-DB path —
 * a table missing the columns, pinned at v29 — through createDatabase's
 * runSchemaSetup + runMigrations, and asserts a clean upgrade.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { runSchemaSetup } from "./schema.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});

afterEach(() => {
  db.close();
});

describe("migration 30 — existing-DB upgrade", () => {
  test("boots cleanly when person_aliases predates the frequency columns", () => {
    // Build the full current schema, then DROP the v30 columns to recreate a
    // genuine pre-v30 `person_aliases`, pinned at v29 — the exact live shape that
    // crashed boot.
    runSchemaSetup(db);
    db.exec("ALTER TABLE person_aliases DROP COLUMN is_primary");
    db.exec("ALTER TABLE person_aliases DROP COLUMN occurrence_count");
    db.exec(`
      INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
        VALUES ('p1', 'Maya', 'test', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
        VALUES ('a1', 'p1', 'Maya', 'name', '2026-01-01');
    `);
    db.pragma("user_version = 29");

    // runSchemaSetup runs first (must not reference the not-yet-added columns),
    // then the migrations add them. This is exactly the live boot order.
    expect(() => {
      runSchemaSetup(db);
      runMigrations(db, { log: createLogger("test") });
    }).not.toThrow();

    const cols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('person_aliases')")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("occurrence_count");
    expect(cols).toContain("is_primary");

    // Existing name rows are born primary (default 1) with a count of 1.
    const row = db
      .prepare<
        [],
        { occurrence_count: number; is_primary: number }
      >("SELECT occurrence_count, is_primary FROM person_aliases WHERE id = 'a1'")
      .get();
    expect(row).toEqual({ occurrence_count: 1, is_primary: 1 });
    // runMigrations always replays through to the latest version; assert
    // against the constant so a later migration doesn't break this test.
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });
});
