// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 35: back-fill `cognition_runs.cycle_anchor_at` (the Briefs / Loop
 * Agent debounce-ceiling anchor).
 *
 * The column anchors the max-defer ceiling that keeps a continuously-folded
 * `data` run claimable within a bounded time. A DB created before v35 carries a
 * `cognition_runs` table without it; this exercises that exact upgrade path — a
 * pre-35 row pinned at v34 — through `runSchemaSetup` + `runMigrations`, and
 * asserts the column is added AND existing rows back-fill to their real cycle
 * start (`enqueued_at`), not the `DEFAULT 0` the ALTER lands with.
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

describe("migration 35 — cycle_anchor_at back-fill", () => {
  test("adds the column and back-fills existing rows to their enqueued_at", () => {
    // Build the full current schema, then DROP the column to recreate a genuine
    // pre-35 `cognition_runs`, pinned at v34.
    runSchemaSetup(db);
    db.exec("ALTER TABLE cognition_runs DROP COLUMN cycle_anchor_at");
    db.exec(
      `INSERT INTO cognition_runs (id, kind, status, next_attempt_at, enqueued_at)
         VALUES ('run_pre35', 'data', 'pending', 1700000000000, 1699999999000)`,
    );
    db.pragma("user_version = 34");

    // The pre-migration shape lacks the column entirely.
    const before = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('cognition_runs')")
      .all()
      .map((r) => r.name);
    expect(before).not.toContain("cycle_anchor_at");

    // Live boot order: runSchemaSetup (its CREATE IF NOT EXISTS is a no-op on
    // the existing table — it must NOT be what adds the column), then migrations.
    expect(() => {
      runSchemaSetup(db);
      runMigrations(db, { log: createLogger("test") });
    }).not.toThrow();

    const after = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('cognition_runs')")
      .all()
      .map((r) => r.name);
    expect(after).toContain("cycle_anchor_at");
    // Exactly one — the pragma guard prevented a duplicate ALTER.
    expect(after.filter((c) => c === "cycle_anchor_at")).toHaveLength(1);

    // The back-fill sets the anchor to the row's real cycle start, not DEFAULT 0.
    const row = db
      .prepare<
        [],
        { enqueued_at: number; cycle_anchor_at: number }
      >("SELECT enqueued_at, cycle_anchor_at FROM cognition_runs WHERE id = 'run_pre35'")
      .get();
    expect(row?.cycle_anchor_at).toBe(1699999999000);
    expect(row?.cycle_anchor_at).toBe(row?.enqueued_at);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("is a no-op on a fresh DB whose cognition_runs already has the column", () => {
    runSchemaSetup(db);
    db.pragma("user_version = 34");
    expect(() => runMigrations(db, { log: createLogger("test") })).not.toThrow();
    const cols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('cognition_runs')")
      .all()
      .map((r) => r.name);
    expect(cols.filter((c) => c === "cycle_anchor_at")).toHaveLength(1);
  });
});
