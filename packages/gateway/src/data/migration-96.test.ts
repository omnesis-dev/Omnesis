// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

describe("migration 96 — retired temporal-annotation conversation pointer", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as Db;
    runSchemaSetup(db);
  });

  afterEach(() => {
    db.close();
  });

  test("drops the pointer while preserving annotation data and relationships", () => {
    db.exec(`
      ALTER TABLE temporal_annotations ADD COLUMN thread_conversation_id TEXT;
      INSERT INTO temporal_annotations (
        id, interval_start_ms, interval_end_ms, precision, canonical, sentence,
        kind, created_by_run, created_at, updated_at, revision,
        invalidated_at, thread_conversation_id
      ) VALUES (
        'ta_migration', 1000, 1999, 'instant', '1970-01-01T00:00:01.000Z',
        'A fictional scheduled item', 'event', 'run_migration', 2000, 3000, 4,
        NULL, 'conversation_retired'
      );
      INSERT INTO temporal_annotation_people (annotation_id, person_id)
      VALUES ('ta_migration', 'person_fictional');
      PRAGMA user_version = 95;
    `);

    runMigrations(db);

    const columns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('temporal_annotations')")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("thread_conversation_id");
    expect(
      db
        .prepare<
          [],
          {
            id: string;
            sentence: string;
            revision: number;
            invalidated_at: number | null;
          }
        >(
          "SELECT id, sentence, revision, invalidated_at FROM temporal_annotations WHERE id = 'ta_migration'",
        )
        .get(),
    ).toEqual({
      id: "ta_migration",
      sentence: "A fictional scheduled item",
      revision: 4,
      invalidated_at: null,
    });
    expect(
      db
        .prepare<
          [],
          { person_id: string }
        >("SELECT person_id FROM temporal_annotation_people WHERE annotation_id = 'ta_migration'")
        .get(),
    ).toEqual({ person_id: "person_fictional" });
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("is idempotent when live schema setup already omitted the pointer", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 96);
    expect(migration).toBeDefined();
    expect(() => migration!.up(db)).not.toThrow();
    expect(() => migration!.up(db)).not.toThrow();
  });
});
