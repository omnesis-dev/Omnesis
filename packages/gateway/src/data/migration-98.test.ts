// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

describe("migration 98 — temporal-annotation evidence atoms and invalidation cause", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as Db;
    runSchemaSetup(db);
  });

  afterEach(() => {
    db.close();
  });

  test("creates the evidence table and cause column on a pre-98 install, preserving annotation data", () => {
    // Model a v97 install: neither the evidence table nor the cause column
    // exists yet, but a live annotation with its doc link does.
    db.exec(`
      DROP TABLE temporal_annotation_evidence;
      ALTER TABLE temporal_annotations DROP COLUMN invalidation_cause;
      INSERT INTO documents (
        id, provider_id, source_id, external_id, title, content, content_hash,
        source_created_at, source_updated_at, ingested_at, updated_at
      ) VALUES (
        'doc_fictional', 'test-provider', 'test-source', 'ext-1', 'Marathon entry form',
        'Race day is 2026-09-20', 'hash-1',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO temporal_annotations (
        id, interval_start_ms, interval_end_ms, precision, canonical, sentence,
        kind, created_by_run, created_at, updated_at, revision, invalidated_at
      ) VALUES (
        'ta_migration', 1000, 1999, 'instant', '1970-01-01T00:00:01.000Z',
        'A fictional race day', 'event', 'run_migration', 2000, 3000, 1, NULL
      );
      INSERT INTO temporal_annotation_documents (annotation_id, document_id)
      VALUES ('ta_migration', 'doc_fictional');
      PRAGMA user_version = 97;
    `);

    runMigrations(db);

    expect(
      db
        .prepare<[], { name: string }>(
          "SELECT name FROM pragma_table_info('temporal_annotation_evidence')",
        )
        .all()
        .map((row) => row.name),
    ).toEqual(["annotation_id", "position", "document_id", "quote", "broken_at"]);
    expect(
      db
        .prepare<
          [],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_temporal_annotation_evidence_doc'")
        .get()?.name,
    ).toBe("idx_temporal_annotation_evidence_doc");
    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('temporal_annotations')")
        .all()
        .map((row) => row.name),
    ).toContain("invalidation_cause");
    // Standing rows and links are untouched (a pre-98 install has no atoms
    // and no recorded cause).
    expect(
      db
        .prepare<
          [],
          { id: string; sentence: string; invalidation_cause: string | null }
        >("SELECT id, sentence, invalidation_cause FROM temporal_annotations WHERE id = 'ta_migration'")
        .get(),
    ).toEqual({ id: "ta_migration", sentence: "A fictional race day", invalidation_cause: null });
    expect(
      db
        .prepare<
          [],
          { document_id: string }
        >("SELECT document_id FROM temporal_annotation_documents WHERE annotation_id = 'ta_migration'")
        .get(),
    ).toEqual({ document_id: "doc_fictional" });
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("is idempotent when live schema setup already created the table and column", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 98);
    expect(migration).toBeDefined();
    expect(() => migration!.up(db)).not.toThrow();
    expect(() => migration!.up(db)).not.toThrow();
    // The guarded ALTER never duplicates the column.
    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('temporal_annotations')")
        .all()
        .filter((row) => row.name === "invalidation_cause"),
    ).toHaveLength(1);
  });
});
