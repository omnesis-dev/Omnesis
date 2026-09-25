// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

describe("migration 91", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as Db;
    runSchemaSetup(db);
    db.exec(`
      DROP TRIGGER mutable_list_product_loops_insert;
      DROP TRIGGER mutable_list_product_loops_update;
      DROP TRIGGER mutable_list_product_loops_delete;
      DROP TRIGGER mutable_list_cognition_coverage_insert;
      DROP TRIGGER mutable_list_cognition_coverage_update;
      DROP TRIGGER mutable_list_cognition_coverage_delete;
      DROP TRIGGER mutable_list_cognition_runs_insert;
      DROP TRIGGER mutable_list_cognition_runs_update;
      DROP TRIGGER mutable_list_cognition_runs_delete;
      DROP TABLE mutable_list_revisions;
      DROP INDEX idx_answer_approvals_page;
      DROP INDEX idx_answer_approvals_all_page;
      DROP INDEX idx_answer_approvals_effective_status;
      DROP INDEX idx_subscription_approvals_page;
      DROP INDEX idx_subscription_approvals_all_page;
      DROP INDEX idx_subscription_approvals_effective_status;
      DROP INDEX idx_subscription_revisions_reaction_kind;
      PRAGMA user_version = 90;
    `);
  });

  afterEach(() => db.close());

  test("installs surface-local mutable-list revisions", () => {
    expect(MIGRATIONS.find((migration) => migration.version === 91)?.description).toMatch(
      /mutable list revisions/i,
    );
    runMigrations(db);
    expect(
      db
        .prepare<[], { scope: string }>("SELECT scope FROM mutable_list_revisions ORDER BY scope")
        .all()
        .map((row) => row.scope),
    ).toEqual(["cognition-coverage", "cognition-runs", "link-declarations", "product-loops"]);
    const indexes = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_answer_approvals_page',
              'idx_answer_approvals_all_page',
              'idx_subscription_approvals_page',
              'idx_subscription_approvals_all_page'
            )
          ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual([
      "idx_answer_approvals_all_page",
      "idx_answer_approvals_page",
      "idx_subscription_approvals_all_page",
      "idx_subscription_approvals_page",
    ]);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });
});
