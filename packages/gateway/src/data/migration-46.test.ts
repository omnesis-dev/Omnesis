// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 46: replace the /people browse sort index. The old
 * `idx_people_interaction_score` (on the non-decayed `interaction_score`)
 * could not satisfy the default browse ORDER BY
 * `is_self DESC, interaction_score_recent DESC, doc_count DESC`, so every
 * /people call fell back to a full-table TEMP B-TREE sort. This migration
 * drops it and creates `idx_people_interaction_recent` matching the sort tuple.
 *
 * Fresh-install DDL already carries the new index; the case that matters is
 * the upgrade path where a DB carries the OLD index and must have it swapped.
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

function peopleIndexes(d: Db): string[] {
  return d
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='people'",
    )
    .all()
    .map((r) => r.name);
}

describe("migration 46 — replace idx_people_interaction_score", () => {
  test("swaps the old wrong-column index for the sort-tuple index on upgrade", () => {
    runSchemaSetup(db);
    // Simulate a pre-46 DB: drop the new index, recreate the old one.
    db.exec("DROP INDEX IF EXISTS idx_people_interaction_recent");
    db.exec(
      "CREATE INDEX idx_people_interaction_score ON people(interaction_score DESC) WHERE merged_into IS NULL",
    );
    expect(peopleIndexes(db)).toContain("idx_people_interaction_score");
    expect(peopleIndexes(db)).not.toContain("idx_people_interaction_recent");
    db.pragma("user_version = 45");

    runMigrations(db, { log: createLogger("test") });

    const idx = peopleIndexes(db);
    expect(idx).not.toContain("idx_people_interaction_score");
    expect(idx).toContain("idx_people_interaction_recent");
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(46);
  });

  test("replaying v46's up is idempotent and a fresh-install DB no-ops", () => {
    runSchemaSetup(db);
    const v46 = MIGRATIONS.find((m) => m.version === 46);
    if (!v46) throw new Error("migration 46 not in MIGRATIONS");
    // Fresh install already carries idx_people_interaction_recent; both no-op.
    expect(() => {
      v46.up(db);
      v46.up(db);
    }).not.toThrow();
    expect(peopleIndexes(db).filter((n) => n === "idx_people_interaction_recent")).toHaveLength(1);
    expect(peopleIndexes(db)).not.toContain("idx_people_interaction_score");
  });
});
