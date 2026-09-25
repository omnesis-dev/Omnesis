// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 53: add the entailment-firewall stamps — `verification_state` +
 * `last_verified_at` — to BOTH `doc_annotations` and `person_annotations`,
 * plus the partial re-verification indexes.
 *
 * A DB upgraded from before v53 carries both annotation tables in their
 * pre-stamp shape (migrations 38/50 created them without the columns). This
 * exercises that exact upgrade path — old-shape tables with rows, pinned at
 * v52 — through `runMigrations`, and asserts the columns appear, existing
 * rows read back with NULL stamps, and the guarded ALTER is idempotent.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { runSchemaSetup } from "./schema.js";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});
afterEach(() => {
  db.close();
});

const TABLES = ["doc_annotations", "person_annotations"] as const;

function columns(d: Db, table: string): string[] {
  return d
    .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((r) => r.name);
}

function indexNames(d: Db, table: string): string[] {
  return d
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?",
    )
    .all(table)
    .map((r) => r.name);
}

/**
 * Recreate a genuine pre-53 DB: both annotation tables in their old shape
 * (head-shape `runSchemaSetup` creates them with the stamps, so they are
 * rebuilt without the two columns), one row each, pinned at v52.
 */
function seedPre53(): void {
  runSchemaSetup(db);
  for (const table of TABLES) {
    db.exec(`DROP TABLE ${table}`);
    const subjectCol = table === "doc_annotations" ? "doc_id" : "person_id";
    db.exec(`
      CREATE TABLE ${table} (
        id TEXT PRIMARY KEY,
        ${subjectCol} TEXT NOT NULL,
        claim_type TEXT NOT NULL,
        claim_text TEXT NOT NULL,
        evidence_doc_id TEXT NOT NULL,
        evidence_quote TEXT NOT NULL,
        confidence REAL NOT NULL,
        llm_derived INTEGER NOT NULL DEFAULT 1,
        created_by_run TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        invalidated_at INTEGER
      )
    `);
    db.prepare(
      `INSERT INTO ${table} (id, ${subjectCol}, claim_type, claim_text, evidence_doc_id, evidence_quote, confidence, created_by_run, created_at)
       VALUES (?, ?, 'topic', 'the venue booking is confirmed', 'doc-ev-1', 'we confirmed the venue booking', 0.8, 'run_seed', 1000)`,
    ).run(`${table}-row-1`, `${table}-subject-1`);
  }
  db.pragma("user_version = 54");
}

describe("migration 55 — annotation verification stamps", () => {
  test("adds both columns + the partial indexes to both tables, keeping existing rows NULL-stamped", () => {
    seedPre53();

    expect(() => {
      runSchemaSetup(db);
      runMigrations(db, { log: createLogger("test") });
    }).not.toThrow();

    for (const table of TABLES) {
      const cols = columns(db, table);
      expect(cols).toContain("verification_state");
      expect(cols).toContain("last_verified_at");
      const row = db
        .prepare<
          [],
          { verification_state: string | null; last_verified_at: number | null; claim_text: string }
        >(`SELECT verification_state, last_verified_at, claim_text FROM ${table}`)
        .get();
      expect(row).toEqual({
        verification_state: null,
        last_verified_at: null,
        claim_text: "the venue booking is confirmed",
      });
    }
    expect(indexNames(db, "doc_annotations")).toContain("idx_doc_annotations_verified");
    expect(indexNames(db, "person_annotations")).toContain("idx_person_annotations_verified");
  });

  test("replaying v53's up() over an already-migrated DB is a no-op (guarded ALTER)", () => {
    seedPre53();
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });

    const v53 = MIGRATIONS.find((m) => m.version === 55);
    expect(v53).toBeDefined();
    expect(() => v53!.up(db)).not.toThrow();
    for (const table of TABLES) {
      // No duplicate columns from the replay.
      expect(columns(db, table).filter((c) => c === "verification_state")).toHaveLength(1);
    }
  });

  test("a fresh install gets the columns from the idempotent DDL and the migration no-ops", () => {
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    for (const table of TABLES) {
      const cols = columns(db, table);
      expect(cols).toContain("verification_state");
      expect(cols).toContain("last_verified_at");
    }
    // The sweep-discovery indexes live in the migration only (the boot DDL
    // runs before migrations on upgrades) — a fresh install must still get
    // them via the migration replaying over the head-shape DDL.
    expect(indexNames(db, "doc_annotations")).toContain("idx_doc_annotations_verified");
    expect(indexNames(db, "person_annotations")).toContain("idx_person_annotations_verified");
  });
});
