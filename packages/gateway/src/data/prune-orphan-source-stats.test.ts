// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 25 (#895): prune orphaned `source_stats` rows. Seeds a DB where one
 * source still has documents, one is legitimately empty (`doc_count = 0`), and
 * one is a re-homed/removed source whose stale row claims documents the
 * `documents` table no longer has. Asserts only the orphan is removed, then
 * re-runs for idempotency.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "./schema.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";
import { pruneOrphanSourceStats } from "./prune-orphan-source-stats.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
});

afterEach(() => {
  db.close();
});

function seedDoc(id: string, sourceId: string): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  ).run(
    id,
    sourceId,
    sourceId,
    id,
    "t",
    "c",
    "h",
    "2026-01-01",
    "2026-01-01",
    "2026-01-01",
    "2026-01-01",
  );
}

function seedStats(sourceId: string, docCount: number): void {
  db.prepare("INSERT INTO source_stats (source_id, doc_count) VALUES (?, ?)").run(
    sourceId,
    docCount,
  );
}

function statsSourceIds(): string[] {
  return db
    .prepare<[], { source_id: string }>("SELECT source_id FROM source_stats ORDER BY source_id")
    .all()
    .map((r) => r.source_id);
}

describe("pruneOrphanSourceStats", () => {
  test("removes only rows whose source has no documents but claims a non-zero count", () => {
    // Live source with matching docs.
    seedDoc("d1", "gmail:me");
    seedStats("gmail:me", 1);
    // Legitimately empty source — kept (doc_count = 0).
    seedStats("browser-history:safari", 0);
    // Orphan: stale row claiming 678 docs the table no longer has (re-homed).
    seedStats("retired-source", 678);

    const removed = pruneOrphanSourceStats(db);

    expect(removed).toBe(1);
    expect(statsSourceIds()).toEqual(["browser-history:safari", "gmail:me"]);
  });

  test("is idempotent — a second run is a no-op", () => {
    seedStats("retired-source", 678);
    expect(pruneOrphanSourceStats(db)).toBe(1);
    expect(pruneOrphanSourceStats(db)).toBe(0);
    expect(statsSourceIds()).toEqual([]);
  });

  test("keeps a stale-counted row once its documents exist again", () => {
    // doc_count drift in the safe direction (docs present): never an orphan.
    seedDoc("d1", "web");
    seedStats("web", 999);
    expect(pruneOrphanSourceStats(db)).toBe(0);
    expect(statsSourceIds()).toEqual(["web"]);
  });
});

describe("migration 25 — prune orphaned source_stats via runMigrations", () => {
  test("drives the prune through the real migration runner and advances head", () => {
    // An install sitting at the pre-25 head with a re-homed source's stale row.
    seedDoc("d1", "web");
    seedStats("web", 1);
    seedStats("retired-source", 678);
    db.exec("PRAGMA user_version = 24");

    runMigrations(db);

    expect(statsSourceIds()).toEqual(["web"]);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      LATEST_SCHEMA_VERSION,
    );
  });
});
