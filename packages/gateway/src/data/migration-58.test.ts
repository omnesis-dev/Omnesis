// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 58: create the `brief_claims` sidecar table — per-brief atomic
 * asserted claims, each bound to its evidence document + verbatim quote.
 *
 * A DB upgraded from before v58 carries the briefs tables without the
 * sidecar. This exercises that exact upgrade path — pinned at v57 with a
 * brief row present — through the migration chain up to v196 (migration 197
 * retires every brief table), and asserts the table appears with its
 * brief_id and evidence_doc_id indexes, that a fresh replay and the upgraded
 * shape match column-for-column, that replaying the migration is a no-op,
 * and that the full chain leaves no brief table behind.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { runSchemaSetup } from "./schema.js";
import { MIGRATIONS, runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";
import { createLegacyBriefTables } from "./legacy-brief-tables.js";
import type { Db } from "./types.js";

/** The chain as it stood before migration 197 retired the brief tables. */
const BEFORE_OBSERVATIONS = MIGRATIONS.filter((m) => m.version < 197);

function migrateToBeforeObservations(d: Db): void {
  runMigrations(d, { log: createLogger("test"), migrations: BEFORE_OBSERVATIONS });
}

/** A fresh install replayed through the chain up to v196. */
function freshBeforeObservations(d: Db): void {
  runSchemaSetup(d);
  d.pragma("user_version = 0");
  migrateToBeforeObservations(d);
}

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});
afterEach(() => {
  db.close();
});

function columns(d: Db, table: string): string[] {
  return d
    .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((r) => r.name);
}

function tableExists(d: Db, table: string): boolean {
  return (
    d
      .prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      )
      .get(table) !== undefined
  );
}

/**
 * Recreate a genuine pre-58 DB: the head schema plus the brief tables as
 * migration 33 created them, without the sidecar; one brief row seeded;
 * pinned at v57.
 */
function seedPre58(): void {
  runSchemaSetup(db);
  createLegacyBriefTables(db);
  db.prepare(
    `INSERT INTO briefs (id, created_by_run, kind, title, confidence, urgency, created_at, updated_at)
     VALUES ('brf_pre', 'run_seed', 'info', 'Studio booking moved to Saturday', 0.7, 0.4, 1000, 1000)`,
  ).run();
  db.pragma("user_version = 57");
}

describe("migration 58 — brief_claims sidecar", () => {
  test("the migration slot exists below head", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThan(58);
    expect(MIGRATIONS.find((m) => m.version === 58)).toBeDefined();
  });

  test("upgrading a pre-58 DB creates the table + indexes; existing briefs untouched", () => {
    seedPre58();
    expect(tableExists(db, "brief_claims")).toBe(false);

    expect(() => {
      runSchemaSetup(db);
      migrateToBeforeObservations(db);
    }).not.toThrow();

    expect(tableExists(db, "brief_claims")).toBe(true);
    const indexes = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='brief_claims' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    // brief_id serves the detail read; evidence_doc_id serves the
    // content-change invalidation + the privacy cascade.
    expect(indexes).toContain("idx_brief_claims_brief");
    expect(indexes).toContain("idx_brief_claims_evidence");
    const brief = db.prepare<[], { title: string }>("SELECT title FROM briefs").get();
    expect(brief?.title).toBe("Studio booking moved to Saturday");
    expect(db.pragma("user_version", { simple: true })).toBe(196);

    runMigrations(db, { log: createLogger("test") });
    expect(tableExists(db, "brief_claims")).toBe(false);
    expect(tableExists(db, "briefs")).toBe(false);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("verification_state is nullable (null = written with no verifier configured)", () => {
    freshBeforeObservations(db);
    db.prepare(
      `INSERT INTO briefs (id, created_by_run, kind, title, confidence, urgency, created_at, updated_at)
       VALUES ('brf_1', 'run_seed', 'info', 'Studio booking moved to Saturday', 0.7, 0.4, 1000, 1000)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO brief_claims (id, brief_id, claim_text, evidence_doc_id, evidence_quote, claim_basis, confidence, verification_state, created_at)
           VALUES ('bclaim_null', 'brf_1', 'the booking moved to Saturday', 'doc_ev', 'moved our session to Saturday morning', 'quoted', 0.8, NULL, 2000)`,
        )
        .run(),
    ).not.toThrow();
    const row = db
      .prepare<[], { verification_state: string | null }>(
        "SELECT verification_state FROM brief_claims",
      )
      .get();
    expect(row?.verification_state).toBeNull();
  });

  test("the upgraded table matches the fresh-install shape column-for-column", () => {
    // Fresh install: the whole chain replayed over an empty DB up to v196.
    freshBeforeObservations(db);
    const freshColumns = columns(db, "brief_claims");
    expect(freshColumns).toEqual([
      "id",
      "brief_id",
      "claim_text",
      "evidence_doc_id",
      "evidence_quote",
      "claim_basis",
      "confidence",
      "verification_state",
      "created_at",
      "invalidated_at",
    ]);

    // Upgrade path in a second DB.
    const upgraded = new Database(":memory:") as unknown as Db;
    try {
      runSchemaSetup(upgraded);
      createLegacyBriefTables(upgraded);
      upgraded.pragma("user_version = 57");
      runSchemaSetup(upgraded);
      migrateToBeforeObservations(upgraded);
      expect(columns(upgraded, "brief_claims")).toEqual(freshColumns);
    } finally {
      upgraded.close();
    }
  });

  test("replaying v58's up() over an already-migrated DB with rows is a no-op", () => {
    seedPre58();
    runSchemaSetup(db);
    migrateToBeforeObservations(db);
    db.prepare(
      `INSERT INTO brief_claims (id, brief_id, claim_text, evidence_doc_id, evidence_quote, claim_basis, confidence, verification_state, created_at)
       VALUES ('bclaim_1', 'brf_pre', 'the booking moved to Saturday', 'doc_ev', 'moved our session to Saturday morning', 'quoted', 0.8, 'verified', 2000)`,
    ).run();

    const v58 = MIGRATIONS.find((m) => m.version === 58);
    expect(v58).toBeDefined();
    expect(() => v58!.up(db)).not.toThrow();
    const row = db
      .prepare<[], { claim_text: string; invalidated_at: number | null }>(
        "SELECT claim_text, invalidated_at FROM brief_claims",
      )
      .get();
    expect(row).toEqual({ claim_text: "the booking moved to Saturday", invalidated_at: null });
  });
});
