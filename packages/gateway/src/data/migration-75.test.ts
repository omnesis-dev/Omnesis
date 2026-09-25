// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 75 brings the temporal annotation store onto the one name the
 * vocabulary gives the concept: how precisely an interval is known is a
 * `precision`, the same column name and the same five values the source-owned
 * projection store already uses.
 *
 * Two shapes arrive at this step and both must come out with exactly one
 * spelling of the column. An upgrading install still carries the original
 * column and needs the rename; a fresh install had the current column created
 * by `runSchemaSetup` before any migration ran, so there is nothing to rename
 * and the step must not fail on that. A re-run of either is a no-op.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";

const migration75 = MIGRATIONS.find((candidate) => candidate.version === 75)!;

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  runSchemaSetup(db);
});

afterEach(() => db.close());

const columns = (): string[] =>
  db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('temporal_annotations')")
    .all()
    .map((row) => row.name);

/** Put the table back into its pre-migration shape. */
function revertToLegacyColumn(): void {
  db.exec("ALTER TABLE temporal_annotations RENAME COLUMN precision TO granularity");
  db.exec("PRAGMA user_version = 74");
}

describe("migration 75 — the annotation interval precision is named `precision`", () => {
  test("renames the column on an upgrading install, preserving stored values", () => {
    revertToLegacyColumn();
    db.prepare(
      `INSERT INTO temporal_annotations
         (id, interval_start_ms, interval_end_ms, granularity, canonical, sentence, kind,
          created_by_run, created_at, updated_at, invalidated_at)
       VALUES ('ta_upgrade', 100, 199, 'month', '2026-08',
               'The lease renewal decision is due sometime in August.', 'deadline',
               'run_seed', 10, 10, NULL)`,
    ).run();

    runMigrations(db, { migrations: [migration75] });

    expect(columns()).toContain("precision");
    expect(columns()).not.toContain("granularity");
    expect(
      db
        .prepare<
          [],
          { id: string; precision: string; sentence: string }
        >("SELECT id, precision, sentence FROM temporal_annotations")
        .all(),
    ).toEqual([
      {
        id: "ta_upgrade",
        precision: "month",
        sentence: "The lease renewal decision is due sometime in August.",
      },
    ]);
  });

  test("is a no-op on a fresh install whose schema setup already created the column", () => {
    expect(columns()).toContain("precision");

    expect(() => migration75.up(db)).not.toThrow();

    expect(columns()).toContain("precision");
    expect(columns()).not.toContain("granularity");
  });

  test("re-running after the rename changes nothing", () => {
    revertToLegacyColumn();
    runMigrations(db, { migrations: [migration75] });
    const after = columns();

    migration75.up(db);
    migration75.up(db);

    expect(columns()).toEqual(after);
  });
});
