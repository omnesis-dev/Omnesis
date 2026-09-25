// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 45: add `time_index_entries.thread_conversation_id` (the
 * per-entry follow-up thread pointer).
 *
 * The fresh-install DDL already carries the column, so on new databases
 * the guarded ALTER must no-op; the case that matters is the real
 * upgrade path — a table created by an older build WITHOUT the column —
 * where the ALTER must fire exactly once and preserve existing rows.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "./schema.js";
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});

afterEach(() => {
  db.close();
});

function entryColumns(d: Db): string[] {
  return d
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('time_index_entries')")
    .all()
    .map((r) => r.name);
}

/** Recreate the v44-era table shape (no thread pointer). */
function dropToV44Shape(d: Db): void {
  d.exec("DROP TABLE IF EXISTS time_index_entry_docs");
  d.exec("DROP TABLE IF EXISTS time_index_entries");
  d.exec(`
    CREATE TABLE time_index_entries (
      id                TEXT PRIMARY KEY,
      interval_start_ms INTEGER NOT NULL,
      interval_end_ms   INTEGER NOT NULL,
      granularity       TEXT NOT NULL,
      canonical         TEXT,
      sentence          TEXT NOT NULL,
      kind              TEXT,
      created_by_run    TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      invalidated_at    INTEGER
    )
  `);
  d.exec(`
    CREATE TABLE time_index_entry_docs (
      entry_id    TEXT NOT NULL REFERENCES time_index_entries(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      PRIMARY KEY (entry_id, document_id)
    )
  `);
}

describe("migration 45 — time_index_entries.thread_conversation_id", () => {
  test("the guarded ALTER fires on a v44-shaped table and preserves rows", () => {
    runSchemaSetup(db);
    dropToV44Shape(db);
    expect(entryColumns(db)).not.toContain("thread_conversation_id");
    db.prepare(
      `INSERT INTO time_index_entries
         (id, interval_start_ms, interval_end_ms, granularity, canonical, sentence, kind,
          created_by_run, created_at, updated_at, invalidated_at)
       VALUES ('tix_m45', 1000, 2000, 'day', '2026-07-08', 'Library card renewal window.',
               'reminder', 'run_m45', 1, 1, NULL)`,
    ).run();
    db.pragma("user_version = 44");

    const v45 = MIGRATIONS.find((m) => m.version === 45);
    if (!v45) throw new Error("migration 45 not in MIGRATIONS");
    v45.up(db);
    v45.up(db);

    expect(entryColumns(db)).toContain("thread_conversation_id");
    const row = db
      .prepare<
        [],
        { sentence: string; thread_conversation_id: string | null }
      >("SELECT sentence, thread_conversation_id FROM time_index_entries WHERE id = 'tix_m45'")
      .get();
    expect(row).toEqual({
      sentence: "Library card renewal window.",
      thread_conversation_id: null,
    });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(45);
  });

  test("replaying v45 is a no-op when the retired table is absent", () => {
    runSchemaSetup(db);
    const v45 = MIGRATIONS.find((m) => m.version === 45);
    if (!v45) throw new Error("migration 45 not in MIGRATIONS");
    expect(() => {
      v45.up(db);
      v45.up(db);
    }).not.toThrow();
    expect(entryColumns(db)).toEqual([]);
  });
});
