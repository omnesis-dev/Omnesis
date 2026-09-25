// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 57: the annotation evidence child tables
 * (`doc_annotation_evidence` / `person_annotation_evidence`) backfilled from
 * each annotation's scalar evidence columns, plus the brand-new
 * `cognition_consumption_edges` table.
 *
 * A DB upgraded from before v57 carries annotation rows with scalar evidence
 * only. This exercises that exact path — pinned at v56 with one annotation
 * per store — through `runMigrations`, and asserts the child tables appear
 * with each row's scalar pair backfilled as its evidence[0], that the
 * fresh-install and upgraded shapes match column-for-column, and that
 * replaying the migration is a no-op.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { runSchemaSetup } from "./schema.js";
import { MIGRATIONS, runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";
import type { Db } from "./types.js";

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
      .prepare<
        [string],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) !== undefined
  );
}

const NEW_TABLES = [
  "doc_annotation_evidence",
  "person_annotation_evidence",
  "cognition_consumption_edges",
] as const;

/**
 * Recreate a genuine pre-57 DB: head-shape `runSchemaSetup` creates the new
 * tables, so they are dropped again; one scalar-evidence annotation seeded
 * per store; pinned at v56.
 */
function seedPre57(): void {
  runSchemaSetup(db);
  for (const t of NEW_TABLES) db.exec(`DROP TABLE ${t}`);
  db.prepare(
    `INSERT INTO doc_annotations (id, doc_id, claim_type, claim_text, evidence_doc_id, evidence_quote, confidence, created_by_run, created_at)
     VALUES ('anno_pre', 'doc_subject', 'topic', 'about the studio booking', 'doc_ev', 'the session moved to Saturday', 0.7, 'run_seed', 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO person_annotations (id, person_id, claim_type, claim_text, evidence_doc_id, evidence_quote, confidence, created_by_run, created_at)
     VALUES ('panno_pre', 'per_1', 'role', 'runs the weekly sync', 'doc_ev', 'she runs the weekly sync', 0.7, 'run_seed', 1000)`,
  ).run();
  db.pragma("user_version = 58");
}

describe("migration 59 — evidence child tables + consumption edges", () => {
  test("head version is 59 and the migration slot exists", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(57);
    expect(MIGRATIONS.find((m) => m.version === 59)).toBeDefined();
  });

  test("upgrading a pre-57 DB creates the tables and backfills scalar evidence as evidence[0]", () => {
    seedPre57();
    for (const t of NEW_TABLES) expect(tableExists(db, t)).toBe(false);

    expect(() => {
      runSchemaSetup(db);
      runMigrations(db, { log: createLogger("test") });
    }).not.toThrow();

    for (const t of NEW_TABLES) expect(tableExists(db, t)).toBe(true);
    expect(
      db
        .prepare<
          [],
          Record<string, unknown>
        >("SELECT * FROM doc_annotation_evidence WHERE annotation_id = 'anno_pre'")
        .all(),
    ).toEqual([
      {
        annotation_id: "anno_pre",
        position: 0,
        evidence_doc_id: "doc_ev",
        evidence_quote: "the session moved to Saturday",
        broken_at: null,
      },
    ]);
    expect(
      db
        .prepare<
          [],
          Record<string, unknown>
        >("SELECT * FROM person_annotation_evidence WHERE annotation_id = 'panno_pre'")
        .all(),
    ).toEqual([
      {
        annotation_id: "panno_pre",
        position: 0,
        evidence_doc_id: "doc_ev",
        evidence_quote: "she runs the weekly sync",
        broken_at: null,
      },
    ]);
    // The edges table starts empty — provenance is recorded going forward.
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_consumption_edges").get()!
        .n,
    ).toBe(0);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("the upgraded tables match the fresh-install shape column-for-column", () => {
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    const fresh = Object.fromEntries(NEW_TABLES.map((t) => [t, columns(db, t)]));
    expect(fresh["doc_annotation_evidence"]).toEqual([
      "annotation_id",
      "position",
      "evidence_doc_id",
      "evidence_quote",
      "broken_at",
    ]);
    expect(fresh["cognition_consumption_edges"]).toEqual([
      "prior_store",
      "prior_annotation_id",
      "dependent_kind",
      "dependent_id",
      "run_id",
      "created_at",
    ]);

    const upgraded = new Database(":memory:") as unknown as Db;
    try {
      runSchemaSetup(upgraded);
      for (const t of NEW_TABLES) upgraded.exec(`DROP TABLE ${t}`);
      upgraded.pragma("user_version = 58");
      runSchemaSetup(upgraded);
      runMigrations(upgraded, { log: createLogger("test") });
      for (const t of NEW_TABLES) expect(columns(upgraded, t)).toEqual(fresh[t]);
    } finally {
      upgraded.close();
    }
  });

  test("replaying v57's up() over an already-migrated DB is a no-op (backfill folds)", () => {
    seedPre57();
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    // A post-upgrade multi-evidence row and an edge must survive the replay.
    db.prepare(
      `INSERT INTO doc_annotation_evidence (annotation_id, position, evidence_doc_id, evidence_quote)
       VALUES ('anno_pre', 1, 'doc_ev2', 'confirmed for Saturday morning')`,
    ).run();
    db.prepare(
      `INSERT INTO cognition_consumption_edges (prior_store, prior_annotation_id, dependent_kind, dependent_id, run_id, created_at)
       VALUES ('doc', 'anno_pre', 'brief', 'brief_1', 'run_x', 2000)`,
    ).run();

    const v57 = MIGRATIONS.find((m) => m.version === 59);
    expect(v57).toBeDefined();
    expect(() => v57!.up(db)).not.toThrow();
    expect(
      db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM doc_annotation_evidence WHERE annotation_id = 'anno_pre'")
        .get()!.n,
    ).toBe(2);
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cognition_consumption_edges").get()!
        .n,
    ).toBe(1);
  });
});
