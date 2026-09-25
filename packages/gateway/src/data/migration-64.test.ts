// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 64: swap the single-column `idx_document_people_person` for a
 * covering `idx_document_people_person_source(person_id, source_id)`, so
 * searchPeople's per-person `source_ids` strip is an index-only scan instead of
 * a random probe into `documents` per doc-row (a page decrypt each, under
 * storage encryption). The read path now reads `dp.source_id` directly, so the
 * migration also backfills any legacy NULL `source_id` from the document.
 *
 * Fresh-install DDL already carries the composite; the upgrade path is the case
 * that matters. All fixture data is invented — never corpus-derived.
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

function dpIndexes(d: Db): string[] {
  return d
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='document_people'",
    )
    .all()
    .map((r) => r.name);
}

/** Revert a fresh-install DB to the pre-64 index shape. */
function makePre64(d: Db): void {
  d.exec("DROP INDEX IF EXISTS idx_document_people_person_source");
  d.exec("CREATE INDEX idx_document_people_person ON document_people(person_id)");
  d.pragma("user_version = 63");
}

function insertDoc(d: Db, id: string, sourceId: string): void {
  d.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'prov', ?, ?, 't', 'c', 'h', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, sourceId, `ext-${id}`);
}

describe("migration 64 — covering (person_id, source_id) index on document_people", () => {
  test("swaps the single-column index for the composite on upgrade", () => {
    runSchemaSetup(db);
    makePre64(db);
    expect(dpIndexes(db)).toContain("idx_document_people_person");
    expect(dpIndexes(db)).not.toContain("idx_document_people_person_source");

    runMigrations(db, { log: createLogger("test") });

    const idx = dpIndexes(db);
    expect(idx).toContain("idx_document_people_person_source");
    expect(idx).not.toContain("idx_document_people_person");
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(64);
  });

  test("backfills a legacy NULL source_id from the document", () => {
    runSchemaSetup(db);
    makePre64(db);
    db.prepare(
      "INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at) VALUES ('p1','P','contacts','2026-01-01','2026-06-01','2026-01-01','2026-06-01')",
    ).run();
    insertDoc(db, "d1", "gmail:x@example.com");
    // A legacy row with a NULL source_id (older insert that omitted the column).
    db.prepare(
      "INSERT INTO document_people (document_id, person_id, role, source_id) VALUES ('d1','p1','sender', NULL)",
    ).run();
    // A row that already has its source_id must be left untouched.
    insertDoc(db, "d2", "whatsapp:+15550100");
    db.prepare(
      "INSERT INTO document_people (document_id, person_id, role, source_id) VALUES ('d2','p1','sender','whatsapp:+15550100')",
    ).run();

    runMigrations(db, { log: createLogger("test") });

    const rows = db
      .prepare<
        [],
        { document_id: string; source_id: string | null }
      >("SELECT document_id, source_id FROM document_people ORDER BY document_id")
      .all();
    expect(rows).toEqual([
      { document_id: "d1", source_id: "gmail:x@example.com" }, // backfilled
      { document_id: "d2", source_id: "whatsapp:+15550100" }, // untouched
    ]);
  });

  test("replaying v64's up is idempotent and a fresh-install DB no-ops", () => {
    runSchemaSetup(db);
    const v64 = MIGRATIONS.find((m) => m.version === 64);
    if (!v64) throw new Error("migration 64 not in MIGRATIONS");
    expect(() => {
      v64.up(db);
      v64.up(db);
    }).not.toThrow();
    expect(dpIndexes(db).filter((n) => n === "idx_document_people_person_source")).toHaveLength(1);
    expect(dpIndexes(db)).not.toContain("idx_document_people_person");
  });
});
