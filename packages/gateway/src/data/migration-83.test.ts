// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 83 adds `subscription_revisions.grounding_json`, where the compiler
 * records what live data said about a watch at the moment it compiled it.
 *
 * The ordering hazard is the one every additive migration faces here, and it is
 * why calling `up()` in isolation proves nothing: `runSchemaSetup` runs the
 * CURRENT DDL on every boot before migrations, and its
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists. A
 * fresh install therefore gets the column from the DDL whether or not the
 * migration works, while an upgrading install — whose table was created by an
 * older DDL that had no such column — gets it only if this migration adds it.
 * These tests drive the real boot order over a database shaped like each.
 *
 * A revision written before the compiler measured anything keeps NULL here. The
 * approval surface omits the block rather than showing a zero, because a zero
 * reads as "nothing matches" when the truth is "not measured".
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS, runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});
afterEach(() => db.close());

function columns(d: Db, table: string): string[] {
  return d
    .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => row.name);
}

/**
 * Rebuild `subscription_revisions` as an older binary's DDL left it — same
 * shape, minus the column this migration exists to add — so the boot path is
 * exercised against a table `CREATE TABLE IF NOT EXISTS` will decline to touch.
 */
function seedPre83Install(d: Db): void {
  runSchemaSetup(d);
  d.exec("DROP TABLE IF EXISTS subscription_revisions");
  d.exec(`
    CREATE TABLE subscription_revisions (
      subscription_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      workflow_id TEXT NOT NULL,
      condition_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (subscription_id, revision)
    )
  `);
  d.exec(`
    INSERT INTO subscription_revisions
      (subscription_id, revision, workflow_id, condition_json, created_at)
    VALUES ('sub_northstar', 1, 'wf_northstar', '{"kind":"natural-language"}', 1700000000000)
  `);
  d.exec("PRAGMA user_version = 82");
}

describe("migration 83", () => {
  test("is registered and is the reason the column can exist", () => {
    const migration = MIGRATIONS.find((m) => m.version === 83);
    expect(migration).toBeDefined();
    expect(migration!.description).toMatch(/grounding/i);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(83);
  });

  test("adds the column to an upgrading install whose DDL predates it", () => {
    seedPre83Install(db);
    expect(columns(db, "subscription_revisions")).not.toContain("grounding_json");

    runMigrations(db);

    expect(columns(db, "subscription_revisions")).toContain("grounding_json");
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("preserves rows written before the compiler measured anything", () => {
    seedPre83Install(db);
    runMigrations(db);

    const row = db
      .prepare<
        [],
        { subscription_id: string; grounding_json: string | null }
      >("SELECT subscription_id, grounding_json FROM subscription_revisions")
      .get();
    expect(row?.subscription_id).toBe("sub_northstar");
    // NULL, not an empty measurement: the revision was never grounded.
    expect(row?.grounding_json).toBeNull();
  });

  test("is a no-op on a fresh install that already has the column", () => {
    runSchemaSetup(db);
    runMigrations(db);
    expect(columns(db, "subscription_revisions")).toContain("grounding_json");

    const migration = MIGRATIONS.find((m) => m.version === 83);
    expect(() => migration!.up(db)).not.toThrow();
    expect(
      columns(db, "subscription_revisions").filter((c) => c === "grounding_json"),
    ).toHaveLength(1);
  });
});
