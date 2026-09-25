// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Dropping the last of the triggers feature: four tables and the column a
 * subscription used to point at one with.
 *
 * The fixture builds the shape an install carried before the drop — which
 * `runSchemaSetup` no longer creates — so this is the only place the old DDL
 * still exists. That is the point: the migration has to work against a
 * database this build cannot otherwise produce.
 *
 * All fixture data is invented.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";

const MIGRATION = MIGRATIONS.find((candidate) => candidate.version === 102);

function tableNames(db: Database.Database): string[] {
  return db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('triggers', 'trigger_firings', 'trigger_state', 'trigger_meta')
        ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return db
    .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => row.name);
}

/** The tables and the column as an install carried them before this migration. */
function seedLegacyTriggerStorage(db: Database.Database): void {
  db.exec(`
    CREATE TABLE triggers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      spec_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE trigger_firings (
      id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
      fired_at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      stdout_tail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE trigger_state (
      trigger_id TEXT PRIMARY KEY REFERENCES triggers(id) ON DELETE CASCADE,
      fire_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE trigger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    ALTER TABLE subscriptions ADD COLUMN managed_trigger_id TEXT REFERENCES triggers(id);
  `);
  db.prepare(
    `INSERT INTO triggers (id, name, kind, enabled, spec_json, created_at, updated_at)
     VALUES ('trg_invented', 'A parcel is out for delivery', 'poll', 1, '{}', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO trigger_firings (id, trigger_id, fired_at, kind, status, stdout_tail)
     VALUES ('tf_invented', 'trg_invented', 2, 'poll', 'ok', 'a captured stdout tail')`,
  ).run();
  db.prepare(
    "INSERT INTO trigger_state (trigger_id, fire_count, updated_at) VALUES ('trg_invented', 3, 2)",
  ).run();
  db.prepare(
    "INSERT INTO trigger_meta (key, value, updated_at) VALUES ('semantic_watermark', '17', 2)",
  ).run();
}

describe("migration 102 — the triggers storage goes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
  });
  afterEach(() => db.close());

  test("takes the tables and the column with it", () => {
    if (!MIGRATION) throw new Error("migration 102 not found");
    seedLegacyTriggerStorage(db);
    expect(tableNames(db)).toHaveLength(4);

    runMigrations(db, { migrations: [MIGRATION] });

    expect(tableNames(db), "a retired table survived").toEqual([]);
    expect(columnNames(db, "subscriptions")).not.toContain("managed_trigger_id");
  });

  test("takes a subscription that still points at one, and keeps the subscription", () => {
    // The column is only ever NULL on an install written by a recent build,
    // but one upgrading from far enough back can have a real id in it. The
    // agreement is not the trigger, so dropping one may not drop the other.
    if (!MIGRATION) throw new Error("migration 102 not found");
    seedLegacyTriggerStorage(db);
    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
       VALUES ('dev_invented', 'An invented harness', 'agent', '{}', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO answer_workflows (id, owner_id, name, purpose, status, created_at, expires_at)
       VALUES ('wf_invented', 'owner_invented', 'Parcel updates', 'tell me', 'active', 1, 2)`,
    ).run();
    db.prepare(
      `INSERT INTO subscriptions
         (id, integration_device_id, owner_id, workflow_id, managed_trigger_id,
          client_request_id, request_fingerprint, current_revision, status,
          created_at, updated_at)
       VALUES ('sub_invented', 'dev_invented', 'owner_invented', 'wf_invented', 'trg_invented',
               'req_invented', 'fp_invented', 1, 'active', 1, 1)`,
    ).run();

    runMigrations(db, { migrations: [MIGRATION] });

    expect(
      db.prepare("SELECT status FROM subscriptions WHERE id = 'sub_invented'").get(),
      "an agreement was dropped with the trigger it named",
    ).toEqual({ status: "active" });
  });

  test("is a no-op on an install that never had them, and on a re-run", () => {
    // A fresh install reaches this migration with none of the four tables and
    // no column, because `runSchemaSetup` stopped creating them. It must not
    // be the step that fails a first boot.
    if (!MIGRATION) throw new Error("migration 102 not found");
    expect(tableNames(db)).toEqual([]);

    expect(() => runMigrations(db, { migrations: [MIGRATION] })).not.toThrow();
    expect(() => MIGRATION.up(db)).not.toThrow();
    expect(columnNames(db, "subscriptions")).not.toContain("managed_trigger_id");
  });
});
