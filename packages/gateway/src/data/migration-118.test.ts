// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SqliteDatabase from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

const migration = MIGRATIONS.find((candidate) => candidate.version === 118)!;

/**
 * The pre-118 shape: `document_id` carries the FK whose cascade erased the
 * rows the privacy purge keys on. A live install upgrades a table like this
 * WITH rows in it, which is exactly the case a fresh-schema replay never
 * exercises — the modern DDL is already FK-free, so the migration's only
 * interesting input is this one.
 */
function buildPre118Db(): Db {
  const db = new SqliteDatabase(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY);
    -- The rebuild recreates the temporal tables via the shared DDL, whose
    -- sibling link tables reference open_loops — present on every real
    -- install, stubbed here.
    CREATE TABLE open_loops (id TEXT PRIMARY KEY);
    CREATE TABLE temporal_annotations (
      id                     TEXT PRIMARY KEY,
      interval_start_ms      INTEGER NOT NULL,
      interval_end_ms        INTEGER NOT NULL,
      precision              TEXT NOT NULL,
      canonical              TEXT,
      sentence               TEXT NOT NULL,
      kind                   TEXT,
      created_by_run         TEXT NOT NULL,
      created_at             INTEGER NOT NULL,
      updated_at             INTEGER NOT NULL,
      revision               INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      invalidated_at         INTEGER,
      invalidation_cause     TEXT
    );
    CREATE TABLE temporal_annotation_documents (
      annotation_id TEXT NOT NULL REFERENCES temporal_annotations(id) ON DELETE CASCADE,
      document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      PRIMARY KEY (annotation_id, document_id)
    );
    CREATE INDEX idx_temporal_annotation_documents_doc
      ON temporal_annotation_documents(document_id);

    INSERT INTO documents (id) VALUES ('doc-a'), ('doc-b');
    INSERT INTO temporal_annotations VALUES
      ('ta-1', 0, 1, 'day', '2027-01-01', 'first', NULL, 'run', 0, 0, 1, NULL, NULL),
      ('ta-2', 0, 1, 'day', '2027-01-02', 'second', NULL, 'run', 0, 0, 1, NULL, NULL);
    INSERT INTO temporal_annotation_documents VALUES
      ('ta-1', 'doc-a'),
      ('ta-1', 'doc-b'),
      ('ta-2', 'doc-b');
  `);
  return db;
}

describe("migration 118", () => {
  test("rebuilds the link table without the document FK, preserving rows, PK and index", () => {
    const db = buildPre118Db();
    migration.up(db);

    // Every row survived the rebuild.
    expect(
      db
        .prepare(
          "SELECT annotation_id, document_id FROM temporal_annotation_documents ORDER BY annotation_id, document_id",
        )
        .all(),
    ).toEqual([
      { annotation_id: "ta-1", document_id: "doc-a" },
      { annotation_id: "ta-1", document_id: "doc-b" },
      { annotation_id: "ta-2", document_id: "doc-b" },
    ]);

    // The document-side FK is gone; the annotation-side FK stays.
    const fks = db
      .prepare<
        [],
        { table: string; from: string }
      >('SELECT "table", "from" FROM pragma_foreign_key_list(\'temporal_annotation_documents\')')
      .all();
    expect(fks).toEqual([{ table: "temporal_annotations", from: "annotation_id" }]);

    // The rename carried the old index away with the old table; the rebuild
    // must have recreated it, or every reverse (doc → entries) lookup — the
    // purge included — degrades to a full scan.
    const indexes = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'temporal_annotation_documents' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toContain("idx_temporal_annotation_documents_doc");

    // The PK still deduplicates.
    expect(() =>
      db.prepare("INSERT INTO temporal_annotation_documents VALUES ('ta-1', 'doc-a')").run(),
    ).toThrow(/UNIQUE|PRIMARY/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  test("after the rebuild, links outlive their document and die with their annotation", () => {
    const db = buildPre118Db();
    migration.up(db);

    // The whole point: a raw document delete no longer erases the link rows
    // the privacy purge selects its victims from.
    db.prepare("DELETE FROM documents WHERE id = 'doc-b'").run();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM temporal_annotation_documents WHERE document_id = 'doc-b'",
        )
        .get(),
    ).toEqual({ n: 2 });

    // The annotation-side cascade still cleans up.
    db.prepare("DELETE FROM temporal_annotations WHERE id = 'ta-1'").run();
    expect(
      db
        .prepare(
          "SELECT annotation_id, document_id FROM temporal_annotation_documents ORDER BY annotation_id",
        )
        .all(),
    ).toEqual([{ annotation_id: "ta-2", document_id: "doc-b" }]);
  });

  test("is idempotent over an already-rebuilt table", () => {
    const db = buildPre118Db();
    migration.up(db);
    migration.up(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM temporal_annotation_documents").get()).toEqual({
      n: 3,
    });
    expect(
      db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'temporal_annotation_documents%' ORDER BY name",
        )
        .all()
        .map((r) => r.name),
    ).toEqual(["temporal_annotation_documents"]);
  });
});
