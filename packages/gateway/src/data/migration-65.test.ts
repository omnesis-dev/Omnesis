// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { createLegacyTimeIndexTables } from "../enrichment/temporal-annotations/storage.js";
import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
});

afterEach(() => {
  db.close();
});

function tableExists(name: string): boolean {
  return (
    db
      .prepare<
        [string],
        { one: number }
      >("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

describe("migration 65 — time index becomes LLM-owned temporal annotations", () => {
  test("preserves legacy ids, content, backlinks, and developer notes", () => {
    runSchemaSetup(db);
    createLegacyTimeIndexTables(db);

    db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash,
          source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES
         ('doc_example', 'provider', 'source:example', 'external', 'Example',
          'Invented source text', 'hash', '2026-01-01', '2026-01-01',
          '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO open_loops
         (id, created_by_run, state, confidence, importance, title, created_at, last_update)
       VALUES ('olp_example', 'run_example', 'open', 0.8, 0.7, 'Invented loop', 10, 10)`,
    ).run();
    db.prepare(
      `INSERT INTO time_index_entries
         (id, interval_start_ms, interval_end_ms, granularity, canonical, sentence,
          kind, created_by_run, created_at, updated_at, invalidated_at,
          thread_conversation_id)
       VALUES
         ('tix_legacy', 100, 200, 'range', 'invented range',
          'Invented temporal meaning', 'event', 'run_example', 10, 20, NULL,
          'session_example')`,
    ).run();
    db.prepare(
      "INSERT INTO time_index_entry_docs (entry_id, document_id) VALUES ('tix_legacy', 'doc_example')",
    ).run();
    db.prepare(
      "INSERT INTO time_index_entry_loops (entry_id, loop_id) VALUES ('tix_legacy', 'olp_example')",
    ).run();
    db.prepare(
      "INSERT INTO time_index_entry_people (entry_id, person_id) VALUES ('tix_legacy', 'person_example')",
    ).run();
    db.prepare(
      `INSERT INTO dev_annotations
         (id, target_type, target_id, note, status, created_at)
       VALUES
         ('dev_example', 'time_index_entry', 'tix_legacy', 'Invented quality note', 'open', 10)`,
    ).run();
    db.pragma("user_version = 64");

    runMigrations(db, { log: createLogger("test:migration-65") });

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(65);
    expect(
      db.prepare("SELECT * FROM temporal_annotations WHERE id = 'tix_legacy'").get(),
    ).toMatchObject({
      id: "tix_legacy",
      sentence: "Invented temporal meaning",
      kind: "event",
      revision: 1,
    });
    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('temporal_annotations')")
        .all()
        .map((row) => row.name),
    ).not.toContain("thread_conversation_id");
    expect(
      db
        .prepare(
          "SELECT document_id FROM temporal_annotation_documents WHERE annotation_id = 'tix_legacy'",
        )
        .pluck()
        .all(),
    ).toEqual(["doc_example"]);
    expect(
      db
        .prepare("SELECT loop_id FROM temporal_annotation_loops WHERE annotation_id = 'tix_legacy'")
        .pluck()
        .all(),
    ).toEqual(["olp_example"]);
    expect(
      db
        .prepare(
          "SELECT person_id FROM temporal_annotation_people WHERE annotation_id = 'tix_legacy'",
        )
        .pluck()
        .all(),
    ).toEqual(["person_example"]);
    expect(
      db
        .prepare("SELECT target_type, target_id FROM dev_annotations WHERE id = 'dev_example'")
        .get(),
    ).toEqual({ target_type: "temporal_annotation", target_id: "tix_legacy" });
    expect(tableExists("time_index_entries")).toBe(false);
    expect(tableExists("time_index_entry_docs")).toBe(false);
    expect(tableExists("time_index_entry_loops")).toBe(false);
    expect(tableExists("time_index_entry_people")).toBe(false);
    expect(tableExists("temporal_annotation_projections")).toBe(true);
  });

  test("v65 is idempotent on a fresh-install schema", () => {
    runSchemaSetup(db);
    const migration = MIGRATIONS.find((candidate) => candidate.version === 65);
    if (!migration) throw new Error("migration 65 not found");

    expect(() => {
      migration.up(db);
      migration.up(db);
    }).not.toThrow();
    expect(tableExists("temporal_annotations")).toBe(true);
    expect(tableExists("temporal_annotation_projections")).toBe(true);
  });
});
