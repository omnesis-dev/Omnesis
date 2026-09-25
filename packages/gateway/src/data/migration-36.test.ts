// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 36: create the `open_loop_people` join table (the Briefs / Loop
 * Agent identity-reconcile index) and back-fill it from existing loops'
 * `actors_json` / `involved_json`.
 *
 * A DB created before v36 carries populated `open_loops` rows but no
 * `open_loop_people` table. This exercises that exact upgrade path — pre-36
 * loops pinned at v35 — through `runSchemaSetup` + `runMigrations`, and
 * asserts the table + index appear AND every actor/involved person is
 * projected into a role-tagged join row. The back-fill is idempotent
 * (`INSERT OR IGNORE` over the composite PK).
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { runSchemaSetup } from "./schema.js";
import { MIGRATIONS, runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});

afterEach(() => {
  db.close();
});

interface PeopleRow {
  loop_id: string;
  person_id: string;
  role: string;
}

function peopleRows(d: Db): PeopleRow[] {
  return d
    .prepare<
      [],
      PeopleRow
    >("SELECT loop_id, person_id, role FROM open_loop_people ORDER BY loop_id, role, person_id")
    .all();
}

/** Recreate a genuine pre-36 DB: loops present, no join table, pinned at v35. */
function seedPre36(): void {
  runSchemaSetup(db);
  db.exec("DROP TABLE open_loop_people");
  db.exec(`
    INSERT INTO open_loops
      (id, created_by_run, confidence, importance, title, actors_json, involved_json, created_at, last_update)
    VALUES
      ('olp_1', 'run_1', 0.9, 0.5, 'Confirm the studio booking',
       '["per_a","per_b"]', '["per_c"]', 1000, 1000),
      ('olp_2', 'run_1', 0.8, 0.4, 'Review the Q4 budget summary', '[]', '[]', 1000, 1000)
  `);
  db.pragma("user_version = 35");
}

describe("migration 36 — open_loop_people backfill", () => {
  test("creates the table + index and back-fills existing loops' actors/involved", () => {
    seedPre36();

    // The pre-migration DB has no join table at all.
    const before = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' AND name='open_loop_people'")
      .get();
    expect(before).toBeUndefined();

    // Live boot order: runSchemaSetup (recreates the empty table via CREATE IF
    // NOT EXISTS), then migrations (the v36 back-fill populates it).
    expect(() => {
      runSchemaSetup(db);
      runMigrations(db, { log: createLogger("test") });
    }).not.toThrow();

    // Table + person index both exist.
    const table = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' AND name='open_loop_people'")
      .get();
    expect(table?.name).toBe("open_loop_people");
    const index = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_open_loop_people_person'")
      .get();
    expect(index?.name).toBe("idx_open_loop_people_person");

    // Each actor + involved person becomes a role-tagged row; the no-people
    // loop contributes nothing.
    expect(peopleRows(db)).toEqual([
      { loop_id: "olp_1", person_id: "per_a", role: "actor" },
      { loop_id: "olp_1", person_id: "per_b", role: "actor" },
      { loop_id: "olp_1", person_id: "per_c", role: "involved" },
    ]);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    // v36 is present as an append-only step; later migrations advance the head
    // past it (the contiguity guard in schema.migration.test.ts pins the head).
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(36);
  });

  test("the back-fill is idempotent — replaying v36's up adds no duplicate rows", () => {
    // The migration framework records each version once, so genuine replay is
    // exercised by invoking the v36 `up` twice directly: its INSERT OR IGNORE
    // over the composite PK must not double-insert.
    seedPre36();
    const v36 = MIGRATIONS.find((m) => m.version === 36);
    if (!v36) throw new Error("migration 36 not in MIGRATIONS");
    v36.up(db);
    const first = peopleRows(db);
    expect(first.length).toBeGreaterThan(0);
    v36.up(db);
    expect(peopleRows(db)).toEqual(first);
  });

  test("a fresh DB reaches v36 with an empty join table", () => {
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(peopleRows(db)).toEqual([]);
  });
});
