// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 51: deterministic backfill of the time-index backlink join tables
 * (added empty in v49) from already-present links —
 *   time_index_entry_people <- each entry's linked docs' `document_people`,
 *   time_index_entry_loops  <- where a loop and an entry share >=1 document
 *   (`open_loop_docs` INTERSECT `time_index_entry_docs`).
 *
 * A DB upgraded from before v51 carries populated entry/loop/doc-link rows but
 * empty backlink tables. This exercises that exact upgrade path — sources
 * seeded, pinned at v50 — through migration 51 itself, and asserts the
 * projection is correct and idempotent (`INSERT OR IGNORE` over the composite
 * PKs).
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createLegacyTimeIndexTables } from "../enrichment/temporal-annotations/storage.js";
import { runSchemaSetup } from "./schema.js";
import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});
afterEach(() => {
  db.close();
});

function pairs(d: Db, table: string, cols: string): Array<Record<string, string>> {
  return d
    .prepare<[], Record<string, string>>(`SELECT ${cols} FROM ${table} ORDER BY ${cols}`)
    .all();
}

/**
 * Recreate a genuine pre-51 DB: entries, a loop, and their doc links present,
 * document_people populated, but the two backlink tables empty. Seeded with FKs
 * off so the *_docs source rows can reference invented document ids without
 * needing full documents/people rows; the backfill only reads them.
 */
function seedPre51(): void {
  runSchemaSetup(db);
  createLegacyTimeIndexTables(db);
  db.pragma("foreign_keys = OFF");
  db.exec("DELETE FROM time_index_entry_people");
  db.exec("DELETE FROM time_index_entry_loops");
  db.exec(`
    INSERT INTO time_index_entries
      (id, interval_start_ms, interval_end_ms, granularity, sentence, created_by_run, created_at, updated_at)
    VALUES
      ('tix_1', 1000, 2000, 'day', 'a deadline', 'run_1', 1000, 1000),
      ('tix_2', 1000, 2000, 'day', 'an event',   'run_1', 1000, 1000)
  `);
  db.exec(`
    INSERT INTO open_loops
      (id, created_by_run, confidence, importance, title, created_at, last_update)
    VALUES ('olp_1', 'run_1', 0.9, 0.5, 'Confirm the studio booking', 1000, 1000)
  `);
  // tix_1 cites doc_1; tix_2 cites doc_2.
  db.exec(`
    INSERT INTO time_index_entry_docs (entry_id, document_id)
    VALUES ('tix_1', 'doc_1'), ('tix_2', 'doc_2')
  `);
  // doc_1 has two people; doc_2 has none.
  db.exec(`
    INSERT INTO document_people (document_id, person_id, role)
    VALUES ('doc_1', 'per_a', 'sender'), ('doc_1', 'per_b', 'recipient')
  `);
  // The loop is grounded in doc_1 — shared with tix_1, not tix_2.
  db.exec(`
    INSERT INTO open_loop_docs (loop_id, doc_id)
    VALUES ('olp_1', 'doc_1')
  `);
  db.pragma("foreign_keys = ON");
  db.pragma("user_version = 50");
}

describe("migration 51 — time-index backlink backfill", () => {
  test("projects entry↔people (via docs) and entry↔loops (shared docs)", () => {
    seedPre51();
    expect(pairs(db, "time_index_entry_people", "entry_id, person_id")).toEqual([]);
    expect(pairs(db, "time_index_entry_loops", "entry_id, loop_id")).toEqual([]);

    const v51 = MIGRATIONS.find((m) => m.version === 51);
    expect(v51).toBeDefined();
    expect(() => v51!.up(db)).not.toThrow();

    // tix_1's doc (doc_1) has per_a + per_b → two people rows; tix_2's doc
    // (doc_2) has no people → none.
    expect(pairs(db, "time_index_entry_people", "entry_id, person_id")).toEqual([
      { entry_id: "tix_1", person_id: "per_a" },
      { entry_id: "tix_1", person_id: "per_b" },
    ]);
    // olp_1 and tix_1 share doc_1 → one loop row; tix_2 shares no loop doc.
    expect(pairs(db, "time_index_entry_loops", "entry_id, loop_id")).toEqual([
      { entry_id: "tix_1", loop_id: "olp_1" },
    ]);
  });

  test("backfill is idempotent — replaying v51's up() over populated tables adds no duplicates", () => {
    seedPre51();
    const v51 = MIGRATIONS.find((m) => m.version === 51);
    expect(v51).toBeDefined();
    v51!.up(db);
    const peopleAfterFirst = pairs(db, "time_index_entry_people", "entry_id, person_id");
    const loopsAfterFirst = pairs(db, "time_index_entry_loops", "entry_id, loop_id");
    expect(peopleAfterFirst.length).toBeGreaterThan(0); // guard: the seed actually populated

    // Replay ONLY v51's up() over the already-populated tables (a second
    // runMigrations would no-op via the schema_migrations ledger and prove
    // nothing). The INSERT OR IGNORE on the composite PKs must be a no-op.
    v51!.up(db);
    expect(pairs(db, "time_index_entry_people", "entry_id, person_id")).toEqual(peopleAfterFirst);
    expect(pairs(db, "time_index_entry_loops", "entry_id, loop_id")).toEqual(loopsAfterFirst);
  });
});
