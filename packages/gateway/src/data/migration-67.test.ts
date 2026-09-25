// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";

describe("migration 67 — subscriptions replace runner actions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
  });

  afterEach(() => db.close());

  test("removes legacy runner state and its outbox, and is idempotent", () => {
    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
       VALUES ('dev_runner_legacy', 'Fictional legacy runner', 'runner', '{}', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO tokens
         (id, device_id, token_hash, scopes, name, created_at, expires_at)
       VALUES (
         'tok_runner_legacy', 'dev_runner_legacy', 'fictional-runner-hash',
         '["read"]', 'legacy runner', 1, NULL
       )`,
    ).run();
    const migration = MIGRATIONS.find((candidate) => candidate.version === 67);
    if (!migration) throw new Error("migration 67 not found");
    runMigrations(db, { migrations: [migration] });
    runMigrations(db, { migrations: [migration] });
    migration.up(db);

    expect(
      db.prepare("SELECT id FROM devices WHERE id = 'dev_runner_legacy'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM tokens WHERE id = 'tok_runner_legacy'").get(),
    ).toBeUndefined();
    const tables = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'action_deliveries',
              'action_delivery_circuit',
              'subscription_deliveries',
              'subscription_firing_answer_authorities'
            )
          ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(["subscription_deliveries", "subscription_firing_answer_authorities"]);
    expect(
      db
        .prepare<[], { name: string }>(
          "SELECT name FROM pragma_table_info('subscription_revisions')",
        )
        .all()
        .map((column) => column.name),
    ).toContain("workflow_id");
  });
});
