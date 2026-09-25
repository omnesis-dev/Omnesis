// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 37: create the `retired_loops` consolidation store (the Briefs /
 * Cognition Steward append-only trace of resolved/removed loops that reconcile scans
 * for recurrences).
 *
 * A brand-new `IF NOT EXISTS` table via the idempotent
 * `createBriefsStorageTables` — no ALTER, no backfill. This exercises the
 * upgrade path (a DB pinned before v37 with the table dropped) and a fresh
 * install, asserting both reach head with the table + index present.
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

function hasTable(d: Db, name: string): boolean {
  return (
    d
      .prepare<
        [string],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name) !== undefined
  );
}

function hasIndex(d: Db, name: string): boolean {
  return (
    d
      .prepare<
        [string],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
      .get(name) !== undefined
  );
}

describe("migration 37 — retired_loops consolidation store", () => {
  test("creates the table + title-norm index on an upgrading install", () => {
    // Recreate a genuine pre-37 DB: full schema, then drop the table and pin
    // below head so the migration has work to do.
    runSchemaSetup(db);
    db.exec("DROP TABLE retired_loops");
    db.pragma("user_version = 36");
    expect(hasTable(db, "retired_loops")).toBe(false);

    expect(() => {
      runSchemaSetup(db);
      runMigrations(db, { log: createLogger("test") });
    }).not.toThrow();

    expect(hasTable(db, "retired_loops")).toBe(true);
    expect(hasIndex(db, "idx_retired_loops_title_norm")).toBe(true);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    // v37 is present as an append-only step; a later migration may advance the
    // head past it (the contiguity guard in schema.migration.test.ts pins it).
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(37);
  });

  test("a fresh DB reaches v37 with an empty consolidation store", () => {
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    expect(hasTable(db, "retired_loops")).toBe(true);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const count = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM retired_loops").get()!.n;
    expect(count).toBe(0);
  });

  test("replaying v37's up is idempotent — the table already existing is a no-op", () => {
    runSchemaSetup(db);
    const v37 = MIGRATIONS.find((m) => m.version === 37);
    if (!v37) throw new Error("migration 37 not in MIGRATIONS");
    expect(() => {
      v37.up(db);
      v37.up(db);
    }).not.toThrow();
    expect(hasTable(db, "retired_loops")).toBe(true);
  });
});
