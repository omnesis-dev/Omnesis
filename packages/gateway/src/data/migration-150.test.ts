// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Migration 150 introduces the replica deletion claims ledger. The migrated
 * shape must equal the head shape a fresh install gets from `runSchemaSetup`,
 * or an upgraded install would behave differently from a new one, and
 * replaying the step must be a no-op.
 */

import SqliteDatabase from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

const migration = MIGRATIONS.find((candidate) => candidate.version === 150)!;

const MIGRATION_OBJECTS = new Set([
  "replica_deletion_claims",
  "idx_replica_deletion_claims_source_role_at",
  "idx_replica_deletion_claims_role_source",
]);

function definitionsOf(db: Db): Record<string, string> {
  const rows = db
    .prepare<
      [],
      { name: string; sql: string }
    >("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'replica_deletion_claims' AND sql IS NOT NULL ORDER BY name")
    .all();
  return Object.fromEntries(
    rows
      .filter((row) => MIGRATION_OBJECTS.has(row.name))
      .map((row) => [row.name, row.sql.replace(/\s+/g, " ").trim()]),
  );
}

describe("migration 150", () => {
  test("an install that predates the claims ledger gains it, idempotently", () => {
    const db = new SqliteDatabase(":memory:") as unknown as Db;
    migration.up(db);
    expect(Object.keys(definitionsOf(db)).sort()).toEqual([...MIGRATION_OBJECTS].sort());

    const before = definitionsOf(db);
    migration.up(db);
    expect(definitionsOf(db)).toEqual(before);
  });

  test("the migrated shape equals the shape a fresh install is created with", () => {
    const migrated = new SqliteDatabase(":memory:") as unknown as Db;
    migration.up(migrated);

    const fresh = new SqliteDatabase(":memory:") as unknown as Db;
    runSchemaSetup(fresh);

    expect(definitionsOf(migrated)).toEqual(definitionsOf(fresh));
  });

  test("a verdict is either deleted or restored", () => {
    const db = new SqliteDatabase(":memory:") as unknown as Db;
    migration.up(db);
    const insert = (role: string) =>
      db
        .prepare(
          "INSERT INTO replica_deletion_claims (namespace, source_id, external_id, device_id, role, at) VALUES ('apple', 'apple-notes:local', 'note-1', ?, ?, 1)",
        )
        .run(role, role);
    expect(() => insert("deleted")).not.toThrow();
    expect(() => insert("restored")).not.toThrow();
    expect(() => insert("maybe")).toThrow(/CHECK constraint/i);
  });
});
