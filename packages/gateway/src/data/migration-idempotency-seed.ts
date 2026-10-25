// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deterministic, human-readable seed for the migration-idempotency e2e.
 *
 * The seed is a near-head migration sentinel, not a complete historical schema
 * dump. It preserves representative `open_loops` rows across the production
 * open path while migrations after v160 are recorded and a second open remains
 * a no-op. Focused migration tests own each tail migration's historical shape.
 */

import type { Db } from "./types.js";

/** Several versions behind the current schema head. */
export const SEEDED_SCHEMA_VERSION = 160;

/** Fixed, fictional timestamps keep the fixture deterministic. */
export const SEED_CREATED_AT = 1_767_322_800_000;
export const SEED_OPEN_LOOP_ID = "seed-loop-open";
export const SEED_DONE_LOOP_ID = "seed-loop-done";

/**
 * Materialise the representative v160 seed in an open, empty database. The
 * standing tail begins with migration 161; `open_loops` is created in its
 * v160 shape, so the tail's task-field migration widens rows that predate it
 * while the rows themselves are preserved.
 *
 * `runSchemaSetup` uses `CREATE TABLE IF NOT EXISTS`, so this historical
 * table remains intact while the current migration tail runs.
 */
export function buildSeedDatabase(db: Db): void {
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE open_loops (
        id TEXT PRIMARY KEY,
        created_by_run TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        deadline_json TEXT,
        actors_json TEXT NOT NULL DEFAULT '[]',
        involved_json TEXT NOT NULL DEFAULT '[]',
        blocked_by_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_update INTEGER NOT NULL,
        last_decay_check INTEGER,
        decay_check_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    const insertLoop = db.prepare(`
      INSERT INTO open_loops (
        id, created_by_run, state, confidence, importance, title,
        created_at, last_update
      ) VALUES (?, 'seed-run', ?, 0.8, 0.4, ?, ?, ?)
    `);
    insertLoop.run(
      SEED_OPEN_LOOP_ID,
      "open",
      "Renew the seed library card",
      SEED_CREATED_AT,
      SEED_CREATED_AT,
    );
    insertLoop.run(
      SEED_DONE_LOOP_ID,
      "done",
      "Return the seed toolbox",
      SEED_CREATED_AT + 1,
      SEED_CREATED_AT + 1,
    );

    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        run_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      )
    `);
    db.prepare(
      "INSERT INTO schema_migrations (version, description, run_at, duration_ms) VALUES (?, ?, ?, ?)",
    ).run(SEEDED_SCHEMA_VERSION, "seed baseline", 0, 0);

    db.exec(`PRAGMA user_version = ${SEEDED_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
