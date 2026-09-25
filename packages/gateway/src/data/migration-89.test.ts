// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 89 adds the read-snapshot marker and complete tuple indexes used
 * by the growing-list keysets. The current DDL supplies them to fresh
 * installs; this suite drives the migration against the physical shape an
 * upgrading install carries.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});
afterEach(() => db.close());

function columns(table: string): string[] {
  return db
    .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => row.name);
}

function seedPre89Install(): void {
  runSchemaSetup(db);
  db.prepare(
    `INSERT INTO briefs (
       id, created_by_run, kind, title, confidence, urgency, state, created_at, updated_at
     ) VALUES ('brf_northstar', 'run_northstar', 'info', 'Quarterly planning', 0.8, 0.4,
               'read', 1000, 1000)`,
  ).run();
  db.exec(`
    DROP INDEX IF EXISTS idx_briefs_read_snapshot;
    DROP INDEX IF EXISTS idx_briefs_created_page;
    DROP INDEX IF EXISTS idx_cognition_runs_enqueued_page;
    DROP INDEX IF EXISTS idx_cognition_runs_scheduled_page;
    DROP INDEX IF EXISTS idx_open_loops_importance_page;
    DROP INDEX IF EXISTS idx_retired_loops_page;
    ALTER TABLE briefs DROP COLUMN read_at;
    PRAGMA user_version = 88;
  `);
}

describe("migration 89", () => {
  test("is registered for brief snapshots and growing-list keysets", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 89);
    expect(migration).toBeDefined();
    expect(migration!.description).toMatch(/snapshot brief reads/i);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(89);
  });

  test("upgrades the old shape without changing an existing brief's state", () => {
    seedPre89Install();
    expect(columns("briefs")).not.toContain("read_at");

    runMigrations(db);

    expect(columns("briefs")).toContain("read_at");
    expect(
      db
        .prepare<
          [],
          { state: string; read_at: number | null }
        >("SELECT state, read_at FROM briefs WHERE id = 'brf_northstar'")
        .get(),
    ).toEqual({ state: "read", read_at: null });
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("creates every complete keyset index and is idempotent", () => {
    seedPre89Install();
    runMigrations(db);

    const expected = [
      "idx_briefs_read_snapshot",
      "idx_briefs_created_page",
      "idx_cognition_runs_enqueued_page",
      "idx_cognition_runs_scheduled_page",
      "idx_open_loops_importance_page",
      "idx_retired_loops_page",
    ];
    const indexes = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(expected));

    const migration = MIGRATIONS.find((candidate) => candidate.version === 89)!;
    expect(() => migration.up(db)).not.toThrow();
    const after = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?, ?, ?, ?, ?)")
      .all(...expected);
    expect(after).toHaveLength(expected.length);
  });
});
