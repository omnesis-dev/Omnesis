// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deterministic, human-readable seed for the migration-idempotency e2e.
 *
 * The seed is a near-head migration sentinel, not a complete historical schema
 * dump. It preserves representative `briefs` rows across the production open
 * path while migrations after v160 are recorded and a second open remains a
 * no-op. Focused migration tests own each tail migration's historical shape.
 */

import type { Db } from "./types.js";

/** Several versions behind the current schema head. */
export const SEEDED_SCHEMA_VERSION = 160;

/** Fixed, fictional timestamps keep the fixture deterministic. */
export const SEED_CREATED_AT = 1_767_322_800_000;
export const SEED_READ_BRIEF_ID = "seed-brief-read";
export const SEED_UNREAD_BRIEF_ID = "seed-brief-unread";

/**
 * Materialise the representative v160 seed in an open, empty database. The
 * standing tail begins with migration 161; none changes `briefs`, so these
 * rows exercise preservation and open-path idempotency without pretending to
 * reproduce every table from that release.
 *
 * `runSchemaSetup` uses `CREATE TABLE IF NOT EXISTS`, so this historical
 * table remains intact while the current migration tail runs.
 */
export function buildSeedDatabase(db: Db): void {
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE briefs (
        id TEXT PRIMARY KEY,
        created_by_run TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        body TEXT,
        confidence REAL NOT NULL,
        urgency REAL NOT NULL,
        relevant_until INTEGER,
        next_show INTEGER,
        event_at INTEGER,
        user_feedback TEXT,
        state TEXT NOT NULL DEFAULT 'unread',
        read_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        thread_conversation_id TEXT
      )
    `);

    const insertBrief = db.prepare(`
      INSERT INTO briefs (
        id, created_by_run, kind, title, confidence, urgency,
        state, created_at, updated_at
      ) VALUES (?, 'seed-run', 'update', ?, 0.8, 0.4, ?, ?, ?)
    `);
    insertBrief.run(
      SEED_READ_BRIEF_ID,
      "Seed read brief",
      "read",
      SEED_CREATED_AT,
      SEED_CREATED_AT,
    );
    insertBrief.run(
      SEED_UNREAD_BRIEF_ID,
      "Seed unread brief",
      "unread",
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
