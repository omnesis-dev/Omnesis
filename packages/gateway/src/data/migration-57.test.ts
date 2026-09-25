// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 55: add `superseded_by` — the id of the annotation that replaced
 * a retired prior — to BOTH `doc_annotations` and `person_annotations`.
 *
 * A DB upgraded from before v55 carries both annotation tables without the
 * column (v54 was their previous shape change). This exercises that exact
 * upgrade path — old-shape tables with rows, pinned at v54 — through
 * `runMigrations`, and asserts the column appears, existing rows stay NULL
 * (never superseded), and the guarded ALTER is idempotent.
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

/**
 * Recreate a genuine pre-55 DB: both annotation tables in their v54 shape
 * (head-shape `runSchemaSetup` creates them with superseded_by, so they are
 * rebuilt without it), one row each, pinned at v54.
 */
function seedPre55(): void {
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
        claim_basis TEXT NOT NULL DEFAULT 'quoted',
        llm_derived INTEGER NOT NULL DEFAULT 1,
        created_by_run TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        invalidated_at INTEGER,
        verification_state TEXT,
        last_verified_at INTEGER
      )
    `);
    db.prepare(
      `INSERT INTO ${table} (id, ${subjectCol}, claim_type, claim_text, evidence_doc_id, evidence_quote, confidence, created_by_run, created_at)
       VALUES (?, ?, 'topic', 'the studio booking moved to Saturday', 'doc-ev-1', 'the studio booking moved to Saturday', 0.8, 'run_seed', 1000)`,
    ).run(`${table}-row-1`, `${table}-subject-1`);
  }
  db.pragma("user_version = 56");
}

describe("migration 57 — annotation superseded_by", () => {
  test("adds the column to both tables; existing rows stay NULL (never superseded)", () => {
    seedPre55();

    expect(() => {
      runSchemaSetup(db);
      runMigrations(db, { log: createLogger("test") });
    }).not.toThrow();

    for (const table of TABLES) {
      expect(columns(db, table)).toContain("superseded_by");
      const row = db
        .prepare<
          [],
          { superseded_by: string | null; claim_text: string }
        >(`SELECT superseded_by, claim_text FROM ${table}`)
        .get();
      expect(row).toEqual({
        superseded_by: null,
        claim_text: "the studio booking moved to Saturday",
      });
    }
  });

  test("replaying v55's up() over an already-migrated DB is a no-op (guarded ALTER)", () => {
    seedPre55();
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });

    const v55 = MIGRATIONS.find((m) => m.version === 57);
    expect(v55).toBeDefined();
    expect(() => v55!.up(db)).not.toThrow();
    for (const table of TABLES) {
      // No duplicate columns from the replay.
      expect(columns(db, table).filter((c) => c === "superseded_by")).toHaveLength(1);
    }
  });

  test("a fresh install gets the column from the idempotent DDL and the migration no-ops", () => {
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    for (const table of TABLES) {
      expect(columns(db, table)).toContain("superseded_by");
    }
  });
});
