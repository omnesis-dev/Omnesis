// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Upgrading a real install that still has the pre-rename steward tables.
 *
 * Migration 72 renamed those tables, and the migrations before it were
 * rewritten to the new names. `runSchemaSetup` runs the current DDL on every
 * boot BEFORE migrations, so an install upgrading from below 72 arrives at
 * those earlier steps with the new-named table freshly created and EMPTY while
 * its rows still sit in the old-named one. Every pre-72 step that touched a
 * renamed table was therefore a silent no-op.
 *
 * Nothing caught it: the migration unit tests seed the NEW names (which no old
 * install has), and `migration-72.test.ts` calls that one migration in
 * isolation, so it never sees the interaction with its predecessors. These
 * tests drive the real boot path — schema setup, then the full chain — over a
 * database that looks like an actual old install.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "./schema.js";
import { runMigrations } from "./migrations.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
});

afterEach(() => db.close());

/**
 * A database as it stood at `version`, carrying the old table names and one
 * row in each — enough to tell "the migration moved my data" from "the
 * migration silently did nothing".
 */
function seedLegacyInstall(version: number): void {
  // Shape the tables as the chain would have left them at `version`: the
  // columns earlier migrations added are already present, because those
  // migrations really did run — against the old names.
  const anchorCol = version >= 35 ? ", cycle_anchor_at INTEGER NOT NULL DEFAULT 0" : "";
  const cacheCols =
    version >= 42
      ? `, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
         cache_creation_tokens INTEGER NOT NULL DEFAULT 0`
      : "";
  db.exec(`
    CREATE TABLE loop_agent_runs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, next_attempt_at INTEGER NOT NULL, enqueued_at INTEGER NOT NULL,
      last_attempt_at INTEGER, completed_at INTEGER, usage_json TEXT${anchorCol}
    );
    CREATE TABLE loop_agent_engine_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE loop_agent_notes (
      id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE loop_agent_spend (
      day TEXT PRIMARY KEY, runs INTEGER NOT NULL DEFAULT 0,
      prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0${cacheCols}
    );
  `);
  db.prepare(
    `INSERT INTO loop_agent_runs (id, kind, next_attempt_at, enqueued_at)
     VALUES ('run_legacy', 'data', 500, 500)`,
  ).run();
  db.prepare(
    "INSERT INTO loop_agent_engine_state (key, value) VALUES ('bootstrap_state','done')",
  ).run();
  db.prepare(
    `INSERT INTO loop_agent_spend (day, runs, prompt_tokens, completion_tokens)
     VALUES ('2026-01-01', 9, 4321, 765)`,
  ).run();
  db.exec(`PRAGMA user_version = ${version}`);
}

/** The real boot order: current DDL first, then the migration chain. */
function boot(): void {
  runSchemaSetup(db);
  runMigrations(db);
}

const count = (table: string): number =>
  db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

describe("upgrading an install that predates the table rename", () => {
  it.each([33, 41, 53, 69, 71])("carries the data forward from user_version %i", (version) => {
    seedLegacyInstall(version);
    boot();

    expect(count("cognition_runs"), "queue rows").toBe(1);
    // The engine-state row survives the rename and reaches migration 75, which
    // converts the retired terminal bootstrap marker to the reopenable one.
    expect(
      db
        .prepare<
          [],
          { value: string }
        >("SELECT value FROM cognition_engine_state WHERE key = 'bootstrap_state'")
        .get()?.value,
    ).toBe("drained");
    expect(count("cognition_spend_daily"), "day totals").toBe(1);
    // The old names are gone, so nothing reads a stranded table by accident.
    const legacy = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'loop_agent_%'")
      .all();
    expect(legacy).toEqual([]);
  });

  it("back-fills cycle_anchor_at on rows that predate the column (migration 35)", () => {
    // Runs the back-fill against whichever table holds the rows. Against the
    // empty new-named table it was a no-op, leaving every pending run's
    // max-defer anchor at 0 — i.e. long elapsed.
    seedLegacyInstall(34);
    boot();
    const row = db
      .prepare<
        [],
        { cycle_anchor_at: number }
      >("SELECT cycle_anchor_at FROM cognition_runs WHERE id = 'run_legacy'")
      .get();
    expect(row?.cycle_anchor_at).toBe(500);
  });

  it("copies the pre-split spend history into the per-mechanism table (migration 54)", () => {
    // `cognition_spend_daily` has no production reader; if migration 54 copies
    // nothing, every recorded token disappears from the spend surfaces.
    seedLegacyInstall(53);
    boot();
    const row = db
      .prepare<
        [],
        { prompt_tokens: number; mechanism: string }
      >("SELECT mechanism, prompt_tokens FROM cognition_spend WHERE day = '2026-01-01'")
      .get();
    expect(row?.prompt_tokens).toBe(4321);
    expect(row?.mechanism).toBe("unattributed");
  });

  it("still runs cleanly on a fresh install with no legacy tables", () => {
    expect(() => boot()).not.toThrow();
    expect(count("cognition_runs")).toBe(0);
  });

  it("is idempotent across a second boot", () => {
    seedLegacyInstall(41);
    boot();
    expect(() => boot()).not.toThrow();
    expect(count("cognition_runs")).toBe(1);
    expect(count("cognition_spend_daily")).toBe(1);
  });
});
