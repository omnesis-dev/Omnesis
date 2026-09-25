// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 175 — a source family declares its own display identity.
 *
 * The table has no data to carry forward: before it, the family entry was
 * assembled at read time from whichever account row a scan reached first, and
 * that value is not something to preserve — it is the defect. So an install
 * arriving here has no family declarations until its collector's next meta
 * push, which happens on every sync and at every boot.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { addSourceFamilyMeta } from "./migration-175-source-family-meta.js";

describe("a source family's own row", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-mig175-"));
    db = new Database(join(dir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates the table with the columns the store writes", () => {
    addSourceFamilyMeta(db);
    const columns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('source_family_meta')")
      .all()
      .map((row) => row.name);
    expect(columns.sort()).toEqual(
      ["accent_color", "bg_color", "icon", "label", "source_type", "updated_at"].sort(),
    );
  });

  test("is keyed by type, so a second declaration replaces rather than duplicates", () => {
    addSourceFamilyMeta(db);
    const insert = db.prepare(
      `INSERT INTO source_family_meta (source_type, label, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(source_type) DO UPDATE SET label = excluded.label`,
    );
    insert.run("example-browser", "First", "2026-01-01T00:00:00.000Z");
    insert.run("example-browser", "Second", "2026-01-02T00:00:00.000Z");
    const rows = db.prepare<[], { label: string }>("SELECT label FROM source_family_meta").all();
    expect(rows).toEqual([{ label: "Second" }]);
  });

  test("is idempotent over an install that already has it", () => {
    addSourceFamilyMeta(db);
    db.prepare(
      "INSERT INTO source_family_meta (source_type, label, updated_at) VALUES (?, ?, ?)",
    ).run("example-browser", "Browsers", "2026-01-01T00:00:00.000Z");
    expect(() => addSourceFamilyMeta(db)).not.toThrow();
    expect(db.prepare<[], { label: string }>("SELECT label FROM source_family_meta").all()).toEqual(
      [{ label: "Browsers" }],
    );
  });

  test("is registered in the chain, at its own version", () => {
    // Not "is the head": that couples every migration's test to being the last
    // one written, so the next migration reddens a suite about something it
    // did not touch. `schema.migration.test.ts` owns the chain's contiguity
    // and its head.
    const entry = MIGRATIONS.find((m) => m.version === 175);
    expect(entry?.up).toBe(addSourceFamilyMeta);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(175);
  });
});
