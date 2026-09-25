// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 54: add `claim_basis` — how far a claim reasons from its
 * evidence ('quoted' | 'inferred' | 'synthesized') — to BOTH
 * `doc_annotations` and `person_annotations`.
 *
 * A DB upgraded from before v54 carries both annotation tables without the
 * column (v53 was their previous shape change). This exercises that exact
 * upgrade path — old-shape tables with rows, pinned at v53 — through
 * `runMigrations`, and asserts the column appears, existing rows backfill to
 * 'quoted' (they all passed the verbatim-quote firewall), and the guarded
 * ALTER is idempotent.
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
 * Recreate a genuine pre-54 DB: both annotation tables in their v53 shape
 * (head-shape `runSchemaSetup` creates them with claim_basis, so they are
 * rebuilt without it), one row each, pinned at v53.
 */
function seedPre54(): void {
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
        invalidated_at INTEGER,
        verification_state TEXT,
        last_verified_at INTEGER
      )
    `);
    db.prepare(
      `INSERT INTO ${table} (id, ${subjectCol}, claim_type, claim_text, evidence_doc_id, evidence_quote, confidence, created_by_run, created_at)
       VALUES (?, ?, 'topic', 'the rehearsal slot moved to Thursday', 'doc-ev-1', 'the rehearsal slot moved to Thursday', 0.8, 'run_seed', 1000)`,
    ).run(`${table}-row-1`, `${table}-subject-1`);
  }
  db.pragma("user_version = 55");
}

describe("migration 56 — annotation claim_basis", () => {
  test("adds the column to both tables, backfilling existing rows to 'quoted'", () => {
    seedPre54();

    expect(() => {
      runSchemaSetup(db);
      runMigrations(db, { log: createLogger("test") });
    }).not.toThrow();

    for (const table of TABLES) {
      expect(columns(db, table)).toContain("claim_basis");
      const row = db
        .prepare<
          [],
          { claim_basis: string; claim_text: string }
        >(`SELECT claim_basis, claim_text FROM ${table}`)
        .get();
      expect(row).toEqual({
        claim_basis: "quoted",
        claim_text: "the rehearsal slot moved to Thursday",
      });
    }
  });

  test("replaying v54's up() over an already-migrated DB is a no-op (guarded ALTER)", () => {
    seedPre54();
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });

    const v54 = MIGRATIONS.find((m) => m.version === 56);
    expect(v54).toBeDefined();
    expect(() => v54!.up(db)).not.toThrow();
    for (const table of TABLES) {
      // No duplicate columns from the replay.
      expect(columns(db, table).filter((c) => c === "claim_basis")).toHaveLength(1);
    }
  });

  test("a fresh install gets the column from the idempotent DDL and the migration no-ops", () => {
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    for (const table of TABLES) {
      expect(columns(db, table)).toContain("claim_basis");
    }
  });
});
