// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 86 adds `subscription_revisions.compile_run_id` — the link from a
 * revision to the `subscription_compile` cognition run whose transcript shows
 * what the compiler saw and answered when it produced the revision's plan.
 *
 * Same ordering hazard as every additive migration here: `runSchemaSetup`
 * runs the CURRENT DDL before migrations, and `CREATE TABLE IF NOT EXISTS`
 * declines to touch an existing table. A fresh install gets the column from
 * the DDL; an upgrading install — whose table was created by an older DDL —
 * gets it only from this migration. Both shapes are driven here.
 *
 * A revision written before compilation was recorded keeps NULL: there is no
 * run to point at, and the portal simply omits the link.
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
 * Stand in for a table an older binary's DDL created, without the column this
 * migration adds, so the boot path is exercised against a table
 * `CREATE TABLE IF NOT EXISTS` will decline to touch. A reduced set of columns
 * is enough: the migration tests for one column and adds it, so the rest of
 * the shape is immaterial to what is under test.
 */
function seedPre86Install(d: Db): void {
  runSchemaSetup(d);
  d.exec("DROP TABLE IF EXISTS subscription_revisions");
  d.exec(`
    CREATE TABLE subscription_revisions (
      subscription_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      workflow_id TEXT NOT NULL,
      condition_json TEXT NOT NULL,
      grounding_json TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (subscription_id, revision)
    )
  `);
  d.exec(`
    INSERT INTO subscription_revisions
      (subscription_id, revision, workflow_id, condition_json, created_at)
    VALUES ('sub_northstar', 1, 'wf_northstar', '{"kind":"natural-language"}', 1700000000000)
  `);
  d.exec("PRAGMA user_version = 85");
}

describe("migration 86", () => {
  test("is registered and is the reason the column can exist", () => {
    const migration = MIGRATIONS.find((m) => m.version === 86);
    expect(migration).toBeDefined();
    expect(migration!.description).toMatch(/compile run/i);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(86);
  });

  test("adds the column to an upgrading install whose DDL predates it", () => {
    seedPre86Install(db);
    expect(columns(db, "subscription_revisions")).not.toContain("compile_run_id");

    runMigrations(db);

    expect(columns(db, "subscription_revisions")).toContain("compile_run_id");
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("preserves rows written before compilation was recorded", () => {
    seedPre86Install(db);
    runMigrations(db);

    const row = db
      .prepare<
        [],
        { subscription_id: string; compile_run_id: string | null }
      >("SELECT subscription_id, compile_run_id FROM subscription_revisions")
      .get();
    expect(row?.subscription_id).toBe("sub_northstar");
    // NULL, not an invented id: no run was ever recorded for this revision.
    expect(row?.compile_run_id).toBeNull();
  });

  test("is a no-op on a fresh install that already has the column", () => {
    runSchemaSetup(db);
    runMigrations(db);
    expect(columns(db, "subscription_revisions")).toContain("compile_run_id");

    const migration = MIGRATIONS.find((m) => m.version === 86);
    expect(() => migration!.up(db)).not.toThrow();
    expect(
      columns(db, "subscription_revisions").filter((c) => c === "compile_run_id"),
    ).toHaveLength(1);
  });
});
