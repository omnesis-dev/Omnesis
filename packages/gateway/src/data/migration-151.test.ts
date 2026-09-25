// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Migration 151 remembers which device's snapshot observed each pending
 * absence. An upgraded install must end up with the same column a fresh
 * install gets from `runSchemaSetup`, existing rows must read as observed by
 * nobody, and replaying the step must be a no-op.
 */

import SqliteDatabase from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

const migration = MIGRATIONS.find((candidate) => candidate.version === 151)!;

function columnsOf(db: Db): string[] {
  return db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('document_absences')")
    .all()
    .map((row) => row.name);
}

describe("migration 151", () => {
  test("an install with the absence ledger gains the observer column, idempotently", () => {
    const db = new SqliteDatabase(":memory:") as unknown as Db;
    db.exec(`
      CREATE TABLE document_absences (
        document_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        stream_id TEXT NOT NULL DEFAULT '',
        external_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        first_absent_at INTEGER NOT NULL,
        last_absent_at INTEGER NOT NULL,
        observations INTEGER NOT NULL
      );
      INSERT INTO document_absences
        (document_id, provider_id, source_id, external_id, first_absent_at, last_absent_at, observations)
      VALUES ('doc-1', 'apple', 'apple-notes:local', 'note-1', 1, 1, 1)
    `);

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    expect(columnsOf(db)).toContain("observed_by");
    expect(
      db.prepare<[], { observed_by: string }>("SELECT observed_by FROM document_absences").get(),
    ).toEqual({ observed_by: "" });
  });

  test("the migrated column set equals the shape a fresh install is created with", () => {
    const migrated = new SqliteDatabase(":memory:") as unknown as Db;
    migrated.exec(`
      CREATE TABLE document_absences (
        document_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        stream_id TEXT NOT NULL DEFAULT '',
        external_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        first_absent_at INTEGER NOT NULL,
        last_absent_at INTEGER NOT NULL,
        observations INTEGER NOT NULL
      )
    `);
    migration.up(migrated);

    const fresh = new SqliteDatabase(":memory:") as unknown as Db;
    runSchemaSetup(fresh);

    expect(columnsOf(migrated)).toEqual(columnsOf(fresh));
  });

  test("a database without the ledger yet is left for schema setup to create", () => {
    const db = new SqliteDatabase(":memory:") as unknown as Db;
    expect(() => migration.up(db)).not.toThrow();
    expect(columnsOf(db)).toEqual([]);
  });
});
