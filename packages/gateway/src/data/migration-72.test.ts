// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 72 renames the steward's tables into the cognition vocabulary.
 *
 * The hazard is ordering, not naming: `runSchemaSetup` runs the current DDL on
 * every boot BEFORE migrations, so an upgrading install reaches this migration
 * with the new-named tables already created and empty, sitting beside the old
 * ones that hold the data. A plain RENAME fails there, and skipping on
 * "target exists" silently strands every row — the gateway would come up
 * healthy, reading an empty queue and an empty spend history.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

let db: Database.Database;

const migration72 = MIGRATIONS.find((m) => m.version === 72)!;

beforeEach(() => {
  db = new Database(":memory:");
});

afterEach(() => db.close());

/** The old-named tables as they stood before the rename. */
function seedLegacyTables(): void {
  db.exec(`
    CREATE TABLE loop_agent_runs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, next_attempt_at INTEGER NOT NULL, enqueued_at INTEGER NOT NULL,
      cycle_anchor_at INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
      completed_at INTEGER, usage_json TEXT
    );
    CREATE TABLE loop_agent_engine_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE loop_agent_notes (id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '');
    CREATE TABLE loop_agent_spend (
      day TEXT PRIMARY KEY, runs INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(
    "INSERT INTO loop_agent_runs (id, kind, next_attempt_at, enqueued_at) VALUES ('run_1','data',1,1)",
  ).run();
  db.prepare(
    "INSERT INTO loop_agent_engine_state (key, value) VALUES ('cutoff','2026-01-01')",
  ).run();
  db.prepare("INSERT INTO loop_agent_spend (day, runs) VALUES ('2026-01-01', 7)").run();
}

const tableExists = (name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;

describe("migration 72", () => {
  it("renames in place when the new tables do not exist yet", () => {
    seedLegacyTables();
    migration72.up(db);

    expect(tableExists("loop_agent_runs")).toBe(false);
    expect(tableExists("cognition_runs")).toBe(true);
    expect(db.prepare<[], { id: string }>("SELECT id FROM cognition_runs").get()?.id).toBe("run_1");
    expect(
      db.prepare<[], { value: string }>("SELECT value FROM cognition_engine_state").get()?.value,
    ).toBe("2026-01-01");
  });

  it("carries the rows across when the DDL already created the new tables", () => {
    // The real upgrade path: schema setup ran first, so both names exist.
    seedLegacyTables();
    db.exec(`
      CREATE TABLE cognition_runs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
        dedupe_key TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, next_attempt_at INTEGER NOT NULL, enqueued_at INTEGER NOT NULL,
        cycle_anchor_at INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
        completed_at INTEGER, usage_json TEXT
      );
      CREATE TABLE cognition_engine_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE cognition_notes (id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '');
      CREATE TABLE cognition_spend_daily (
        day TEXT PRIMARY KEY, runs INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0
      );
    `);

    migration72.up(db);

    // Nothing stranded, nothing duplicated, old tables gone.
    expect(tableExists("loop_agent_runs")).toBe(false);
    expect(tableExists("loop_agent_spend")).toBe(false);
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_runs").get()?.n).toBe(
      1,
    );
    expect(
      db.prepare<[], { value: string }>("SELECT value FROM cognition_engine_state").get()?.value,
    ).toBe("2026-01-01");
    // The target had a column the source lacked; the copy uses shared columns
    // and the extra one keeps its default.
    const spend = db
      .prepare<
        [],
        { runs: number; cache_read_tokens: number }
      >("SELECT runs, cache_read_tokens FROM cognition_spend_daily WHERE day = '2026-01-01'")
      .get();
    expect(spend?.runs).toBe(7);
    expect(spend?.cache_read_tokens).toBe(0);
  });

  it("is a no-op on a fresh install that never had the old tables", () => {
    db.exec(`
      CREATE TABLE cognition_runs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        dedupe_key TEXT, next_attempt_at INTEGER NOT NULL
      );
    `);
    expect(() => migration72.up(db)).not.toThrow();
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_runs").get()?.n).toBe(
      0,
    );
  });

  it("is safe to run twice", () => {
    seedLegacyTables();
    migration72.up(db);
    expect(() => migration72.up(db)).not.toThrow();
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_runs").get()?.n).toBe(
      1,
    );
  });
});
