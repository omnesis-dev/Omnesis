// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

describe("migration 66 — document temporal projections", () => {
  test("installs both projection and coverage tables without backfilling", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL
      );
      CREATE TABLE sync_state (
        source_id TEXT PRIMARY KEY
      );
      INSERT INTO documents (id, source_id) VALUES ('doc_existing', 'example-source:account');
      INSERT INTO sync_state (source_id) VALUES ('example-source:account');
    `);

    const migration = MIGRATIONS.find((candidate) => candidate.version === 66);
    expect(migration).toBeDefined();
    migration!.up(db);

    const tables = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'document_temporal_projection%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      "document_temporal_projection_sources",
      "document_temporal_projections",
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM document_temporal_projections").get()).toEqual(
      { count: 0 },
    );
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(66);
    db.close();
  });
});
