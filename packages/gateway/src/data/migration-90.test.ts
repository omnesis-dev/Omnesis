// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

describe("migration 90", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as Db;
    runSchemaSetup(db);
    db.exec(`
      ALTER TABLE removed_documents DROP COLUMN original_document_id;
      PRAGMA user_version = 89;
    `);
  });

  afterEach(() => db.close());

  test("adds the restart-safe original document id to privacy tombstones", () => {
    expect(MIGRATIONS.find((migration) => migration.version === 90)?.description).toMatch(
      /original document ids/i,
    );
    runMigrations(db);
    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('removed_documents')")
        .all()
        .map((column) => column.name),
    ).toContain("original_document_id");
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });
});
