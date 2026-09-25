// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 44: reset `documents.dates_extracted_at` so the date-enrichment
 * pass re-extracts the whole corpus under language routing.
 *
 * A pure data transform (no shape change): every stamped document goes back
 * to NULL and is re-discovered by the extraction drip's
 * `WHERE dates_extracted_at IS NULL` query. Existing extracted rows are
 * replaced as each document is reprocessed.
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

function insertDoc(d: Db, id: string, extractedAt: string | null): void {
  d.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        metadata, source_created_at, source_updated_at, ingested_at, updated_at,
        dates_extracted_at)
     VALUES (?, 'test', 'test:acct', ?, ?, '', ?, '{}', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    `Seed ${id}`,
    `hash-${id}`,
    "2026-01-02T03:04:05Z",
    "2026-01-02T03:04:05Z",
    "2026-01-02T03:04:05Z",
    "2026-01-02T03:04:05Z",
    extractedAt,
  );
}

function stampedCount(d: Db): number {
  return d
    .prepare<
      [],
      { n: number }
    >("SELECT COUNT(*) AS n FROM documents WHERE dates_extracted_at IS NOT NULL")
    .get()!.n;
}

describe("migration 44 — reset dates_extracted_at for language-routed re-extraction", () => {
  test("an upgrading install re-enqueues every document", () => {
    runSchemaSetup(db);
    db.pragma("user_version = 43");
    insertDoc(db, "doc-a", "2026-01-02T03:04:05Z");
    insertDoc(db, "doc-b", "2026-01-02T03:04:05Z");
    insertDoc(db, "doc-c", null);
    expect(stampedCount(db)).toBe(2);

    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });

    expect(stampedCount(db)).toBe(0);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(44);
  });

  test("replaying v44's up is idempotent", () => {
    runSchemaSetup(db);
    insertDoc(db, "doc-a", "2026-01-02T03:04:05Z");
    const v44 = MIGRATIONS.find((m) => m.version === 44);
    if (!v44) throw new Error("migration 44 not in MIGRATIONS");
    expect(() => {
      v44.up(db);
      v44.up(db);
    }).not.toThrow();
    expect(stampedCount(db)).toBe(0);
  });
});
