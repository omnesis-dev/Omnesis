// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deterministic, human-readable seed for the migration-idempotency e2e.
 *
 * The seed is a near-head migration sentinel, not a complete historical schema
 * dump. It preserves representative `open_loops` rows and unfiltered access across the production
 * open path while migrations after v160 are recorded and a second open remains
 * a no-op. Focused migration tests own each tail migration's historical shape.
 */

import { createV152AccessTables } from "./migration-152-access-grants.js";
import { migrateV153AccessPolicyFamilies } from "./migration-153-access-policy-families.js";
import { migrateV154ConfidentialOAuthClients } from "./migration-154-confidential-oauth-clients.js";
import type { Db } from "./types.js";

/** Several versions behind the current schema head. */
export const SEEDED_SCHEMA_VERSION = 160;

/** Fixed, fictional timestamps keep the fixture deterministic. */
export const SEED_CREATED_AT = 1_767_322_800_000;
export const SEED_OPEN_LOOP_ID = "seed-loop-open";
export const SEED_DONE_LOOP_ID = "seed-loop-done";
export const SEED_GRANT_ID = "seed-grant";

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
  // Historical OAuth table rebuilds run with the migration runner's pragmas;
  // unrelated parent tables are supplied later by the current base setup.
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  const legacyAlter = db.pragma("legacy_alter_table", { simple: true });
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.exec("BEGIN");
  try {
    // The v160 baseline already has the access spine. Keep it historical so
    // the level and source-filter migrations must actually install their shape.
    createV152AccessTables(db);
    migrateV153AccessPolicyFamilies(db);
    migrateV154ConfidentialOAuthClients(db);
    // The two v160 schema additions; there are no credentials to revoke here.
    db.exec(`ALTER TABLE oauth_refresh_tokens ADD COLUMN replacement_ciphertext TEXT;
      ALTER TABLE oauth_refresh_tokens ADD COLUMN retry_until INTEGER`);
    db.prepare(
      `INSERT INTO access_principals(id,name,kind,created_at,updated_at)
      VALUES('seed-principal','Fictional seed connection','interactive',?,?)`,
    ).run(SEED_CREATED_AT, SEED_CREATED_AT);
    db.prepare(
      `INSERT INTO access_grants(id,principal_id,name,revision,created_at,updated_at)
      VALUES(?,'seed-principal','Fictional seed access',1,?,?)`,
    ).run(SEED_GRANT_ID, SEED_CREATED_AT, SEED_CREATED_AT);
    db.prepare(
      `INSERT INTO access_grant_capabilities(grant_id,capability,source_mode,source_ids,release_mode,policy_family_id)
      VALUES(?,'direct','all','[]',NULL,NULL)`,
    ).run(SEED_GRANT_ID);
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
  } finally {
    db.pragma(`legacy_alter_table = ${legacyAlter ? "ON" : "OFF"}`);
    db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}
