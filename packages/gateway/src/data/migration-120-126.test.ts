// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SqliteDatabase from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

const migration121 = MIGRATIONS.find((candidate) => candidate.version === 121)!;
const migration122 = MIGRATIONS.find((candidate) => candidate.version === 122)!;
const migration123 = MIGRATIONS.find((candidate) => candidate.version === 123)!;
const migration124 = MIGRATIONS.find((candidate) => candidate.version === 124)!;
const migration125 = MIGRATIONS.find((candidate) => candidate.version === 125)!;
const migration126 = MIGRATIONS.find((candidate) => candidate.version === 126)!;
const migration120 = MIGRATIONS.find((candidate) => candidate.version === 120)!;

/**
 * The pre-120 shapes these migrations upgrade: a `temporal_annotations`
 * table without `refile_presented_run`, and a `documents` table without
 * `dates_truncated`, both WITH rows in them — the case a fresh-schema replay
 * never exercises.
 */
function buildPre120Db(): Db {
  const db = new SqliteDatabase(":memory:") as unknown as Db;
  db.exec(`
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
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      content TEXT,
      dates_extracted_at TEXT
    );
    INSERT INTO temporal_annotations VALUES
      ('ta-1', 0, 1, 'day', '2027-01-01', 'first', NULL, 'run', 0, 0, 1, 500, 'content_change');
    INSERT INTO documents (id, content, dates_extracted_at) VALUES
      ('doc-a', 'body a', '2026-08-01T00:00:00.000Z'),
      ('doc-b', 'body b', NULL);
  `);
  return db;
}

const columns = (db: Db, table: string): Set<string> =>
  new Set(
    db
      .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
      .all()
      .map((c) => c.name),
  );

describe("migration 120 — re-file presentation marker", () => {
  test("adds the column to a populated pre-upgrade table, idempotently, rows intact", () => {
    const db = buildPre120Db();
    expect(columns(db, "temporal_annotations").has("refile_presented_run")).toBe(false);

    migration120.up(db);
    expect(columns(db, "temporal_annotations").has("refile_presented_run")).toBe(true);
    const row = db
      .prepare(
        "SELECT sentence, invalidation_cause, refile_presented_run FROM temporal_annotations WHERE id = 'ta-1'",
      )
      .get() as { sentence: string; invalidation_cause: string; refile_presented_run: null };
    expect(row).toEqual({
      sentence: "first",
      invalidation_cause: "content_change",
      refile_presented_run: null,
    });

    // Replay is a no-op, not an error.
    migration120.up(db);
    expect(columns(db, "temporal_annotations").has("refile_presented_run")).toBe(true);
  });
});

describe("migration 121 — truncation marker + corpus re-extraction", () => {
  test("adds dates_truncated and clears every extraction stamp, idempotently", () => {
    const db = buildPre120Db();
    migration120.up(db);

    migration121.up(db);
    expect(columns(db, "documents").has("dates_truncated")).toBe(true);
    const stamps = db
      .prepare("SELECT COUNT(*) AS n FROM documents WHERE dates_extracted_at IS NOT NULL")
      .get() as { n: number };
    expect(stamps.n).toBe(0);

    // Replay is a no-op, not an error.
    migration121.up(db);
    expect(columns(db, "documents").has("dates_truncated")).toBe(true);
  });
});

describe("migration 122 — truncated documents re-queued for the budgeted scan", () => {
  test("clears stamps only for dates_truncated rows, idempotently", () => {
    const db = buildPre120Db();
    migration120.up(db);
    migration121.up(db);
    // Simulate the post-121 world: everything re-extracted, some truncated.
    db.exec(`
      UPDATE documents SET dates_extracted_at = '2026-08-22T00:00:00.000Z';
      UPDATE documents SET dates_truncated = 1 WHERE id = 'doc-a';
    `);

    migration122.up(db);
    const rows = db
      .prepare("SELECT id, dates_extracted_at FROM documents ORDER BY id")
      .all() as Array<{ id: string; dates_extracted_at: string | null }>;
    expect(rows).toEqual([
      { id: "doc-a", dates_extracted_at: null },
      { id: "doc-b", dates_extracted_at: "2026-08-22T00:00:00.000Z" },
    ]);

    // Replay is a no-op for the untouched row.
    migration122.up(db);
    expect(
      (
        db.prepare("SELECT dates_extracted_at AS s FROM documents WHERE id = 'doc-b'").get() as {
          s: string | null;
        }
      ).s,
    ).toBe("2026-08-22T00:00:00.000Z");
  });
});

describe("migration 123 — wall-clock-stamped documents re-queued for the cpu-time budget", () => {
  test("clears stamps only for dates_truncated rows, idempotently", () => {
    const db = buildPre120Db();
    migration120.up(db);
    migration121.up(db);
    db.exec(`
      UPDATE documents SET dates_extracted_at = '2026-08-23T00:00:00.000Z';
      UPDATE documents SET dates_truncated = 1 WHERE id = 'doc-a';
    `);

    migration123.up(db);
    const rows = db
      .prepare("SELECT id, dates_extracted_at FROM documents ORDER BY id")
      .all() as Array<{ id: string; dates_extracted_at: string | null }>;
    expect(rows).toEqual([
      { id: "doc-a", dates_extracted_at: null },
      { id: "doc-b", dates_extracted_at: "2026-08-23T00:00:00.000Z" },
    ]);

    migration123.up(db);
    expect(
      (
        db.prepare("SELECT dates_extracted_at AS s FROM documents WHERE id = 'doc-b'").get() as {
          s: string | null;
        }
      ).s,
    ).toBe("2026-08-23T00:00:00.000Z");
  });
});

describe("migration 124 — truncated documents re-queued under the current bounds", () => {
  test("clears stamps only for dates_truncated rows, idempotently", () => {
    const db = buildPre120Db();
    migration120.up(db);
    migration121.up(db);
    db.exec(`
      UPDATE documents SET dates_extracted_at = '2026-08-23T08:00:00.000Z';
      UPDATE documents SET dates_truncated = 1 WHERE id = 'doc-a';
    `);

    migration124.up(db);
    const rows = db
      .prepare("SELECT id, dates_extracted_at FROM documents ORDER BY id")
      .all() as Array<{ id: string; dates_extracted_at: string | null }>;
    expect(rows).toEqual([
      { id: "doc-a", dates_extracted_at: null },
      { id: "doc-b", dates_extracted_at: "2026-08-23T08:00:00.000Z" },
    ]);

    migration124.up(db);
    expect(
      (
        db.prepare("SELECT dates_extracted_at AS s FROM documents WHERE id = 'doc-b'").get() as {
          s: string | null;
        }
      ).s,
    ).toBe("2026-08-23T08:00:00.000Z");
  });
});

describe("migration 125 — truncated documents re-queued for the smaller-chunk scan", () => {
  test("clears stamps only for dates_truncated rows, idempotently", () => {
    const db = buildPre120Db();
    migration120.up(db);
    migration121.up(db);
    db.exec(`
      UPDATE documents SET dates_extracted_at = '2026-08-24T00:00:00.000Z';
      UPDATE documents SET dates_truncated = 1 WHERE id = 'doc-a';
    `);

    migration125.up(db);
    const rows = db
      .prepare("SELECT id, dates_extracted_at FROM documents ORDER BY id")
      .all() as Array<{ id: string; dates_extracted_at: string | null }>;
    expect(rows).toEqual([
      { id: "doc-a", dates_extracted_at: null },
      { id: "doc-b", dates_extracted_at: "2026-08-24T00:00:00.000Z" },
    ]);

    migration125.up(db);
    expect(
      (
        db.prepare("SELECT dates_extracted_at AS s FROM documents WHERE id = 'doc-b'").get() as {
          s: string | null;
        }
      ).s,
    ).toBe("2026-08-24T00:00:00.000Z");
  });
});

describe("migration 126 — failed-only bootstrap documents re-admitted", () => {
  const seed = (db: Db) => {
    db.exec(`
      ALTER TABLE documents ADD COLUMN bootstrap_processed_at TEXT;
      CREATE TABLE cognition_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT
      );
      INSERT INTO documents (id, content, dates_extracted_at) VALUES
        ('doc-failed', 'x', NULL),
        ('doc-completed', 'x', NULL),
        ('doc-both', 'x', NULL),
        ('doc-marked-no-runs', 'x', NULL);
      UPDATE documents SET bootstrap_processed_at = '2026-08-24T04:00:00.000Z'
        WHERE id IN ('doc-failed', 'doc-completed', 'doc-both', 'doc-marked-no-runs');
      INSERT INTO cognition_runs VALUES
        ('r1', 'bootstrap', 'failed',    '{"docId":"doc-failed"}'),
        ('r2', 'bootstrap', 'completed', '{"docId":"doc-completed"}'),
        ('r3', 'bootstrap', 'failed',    '{"docId":"doc-both"}'),
        ('r4', 'bootstrap', 'completed', '{"docId":"doc-both"}'),
        ('r5', 'data',      'failed',    '{"docId":"doc-marked-no-runs"}');
    `);
  };

  test("clears only markers whose bootstrap runs all failed, idempotently", () => {
    const db = buildPre120Db();
    seed(db);

    migration126.up(db);
    const markers = () =>
      db
        .prepare("SELECT id, bootstrap_processed_at AS m FROM documents ORDER BY id")
        .all() as Array<{ id: string; m: string | null }>;
    expect(markers()).toEqual([
      { id: "doc-a", m: null },
      { id: "doc-b", m: null },
      { id: "doc-both", m: "2026-08-24T04:00:00.000Z" },
      { id: "doc-completed", m: "2026-08-24T04:00:00.000Z" },
      { id: "doc-failed", m: null },
      { id: "doc-marked-no-runs", m: "2026-08-24T04:00:00.000Z" },
    ]);

    migration126.up(db);
    expect(
      markers()
        .filter((r) => r.m === null)
        .map((r) => r.id),
    ).toEqual(["doc-a", "doc-b", "doc-failed"]);
  });

  test("no-ops when the marker column or runs table is absent", () => {
    const db = buildPre120Db();
    expect(() => migration126.up(db)).not.toThrow();
  });
});
