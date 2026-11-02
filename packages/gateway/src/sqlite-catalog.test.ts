// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "./db.js";
import {
  SQLITE_CATALOG_TABLES,
  computeSqliteTableStats,
  getSqliteCatalog,
  upsertSqliteTableStats,
  type SqliteTableStatsRow,
} from "./sqlite-catalog.js";
import { writerHandlers } from "./scheduler/writer-handlers.js";

type Db = Database.Database;

let dbPath: string;
let db: Db;

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
});

function seedCorpus(target: Db): void {
  const insertDoc = target.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
       source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'synthetic:example', 'synthetic:notes', ?, ?, 'Q4 budget review', ?, ?, ?, ?, ?)`,
  );
  const updated = [
    "2024-03-02T10:00:00.000Z",
    "2021-07-15T08:30:00.000Z",
    "2025-01-09T17:45:00.000Z",
  ];
  updated.forEach((ts, i) => {
    insertDoc.run(`doc-${i}`, `ext-${i}`, `Note ${i}`, `hash-${i}`, ts, ts, ts, ts);
  });
  const insertPerson = target.prepare(
    `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'synthetic:notes', ?, ?, ?, ?)`,
  );
  insertPerson.run(
    "p-1",
    "fixture person a",
    "2022-05-01T00:00:00.000Z",
    "2025-01-01T00:00:00.000Z",
    "2022-05-01T00:00:00.000Z",
    "2022-05-01T00:00:00.000Z",
  );
  insertPerson.run(
    "p-2",
    "fixture person b",
    "2019-11-20T00:00:00.000Z",
    "2024-01-01T00:00:00.000Z",
    "2019-11-20T00:00:00.000Z",
    "2019-11-20T00:00:00.000Z",
  );
  target
    .prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at)
       VALUES ('a-1', 'p-1', 'person-a@example.com', 'email', 'synthetic:notes', '2023-02-02T00:00:00.000Z')`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO document_people (document_id, person_id, role, source_id)
       VALUES ('doc-0', 'p-1', 'author', 'synthetic:notes'), ('doc-1', 'p-2', 'mentioned', 'synthetic:notes')`,
    )
    .run();
  target
    .prepare(
      `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, created_at)
       VALUES ('doc-0', 'url', 'https://example.com/a', 'https://example.com/a', '2024-04-04T00:00:00.000Z'),
              ('doc-2', 'url', 'https://example.com/b', 'https://example.com/b', '2020-06-06T00:00:00.000Z')`,
    )
    .run();
}

function computeAll(target: Db): SqliteTableStatsRow[] {
  return SQLITE_CATALOG_TABLES.map((name) => computeSqliteTableStats(target, name)).filter(
    (row): row is SqliteTableStatsRow => row !== null,
  );
}

describe("catalog table statistics", () => {
  test("the read-worker computation produces each table's count and timestamp range", () => {
    seedCorpus(db);
    const byName = new Map(computeAll(db).map((row) => [row.tableName, row]));

    expect(byName.get("documents")).toMatchObject({
      recordCount: 3,
      earliestDate: "2021-07-15T08:30:00.000Z",
      latestDate: "2025-01-09T17:45:00.000Z",
    });
    expect(byName.get("people")).toMatchObject({
      recordCount: 2,
      earliestDate: "2019-11-20T00:00:00.000Z",
      latestDate: "2022-05-01T00:00:00.000Z",
    });
    expect(byName.get("document_links")).toMatchObject({
      recordCount: 2,
      earliestDate: "2020-06-06T00:00:00.000Z",
      latestDate: "2024-04-04T00:00:00.000Z",
    });
    expect(byName.get("person_aliases")).toMatchObject({ recordCount: 1 });
    // No timestamp column: a count and no range.
    expect(byName.get("document_people")).toMatchObject({
      recordCount: 2,
      earliestDate: null,
      latestDate: null,
    });
    // An empty table with a timestamp column has no range.
    expect(byName.get("sync_state")).toMatchObject({
      recordCount: 0,
      earliestDate: null,
      latestDate: null,
    });
    for (const row of byName.values()) {
      expect(Number.isNaN(Date.parse(row.computedAt))).toBe(false);
    }
  });

  test("the catalog serves stored statistics identical to a live read", () => {
    seedCorpus(db);
    // Nothing stored yet: every table is read live.
    expect(db.prepare("SELECT COUNT(*) AS n FROM catalog_table_stats").get()).toEqual({ n: 0 });
    const live = getSqliteCatalog(db);

    upsertSqliteTableStats(db, computeAll(db));
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM catalog_table_stats").get() as { n: number }).n,
    ).toBe(live.length);
    // Now every table is served from catalog_table_stats.
    db.exec("DELETE FROM documents WHERE id = 'doc-2'");
    const stored = getSqliteCatalog(db);

    expect(stored.find((t) => t.tableName === "documents")).toMatchObject({ recordCount: 3 });
    expect(stored).toEqual(live);
  });

  test("a refresh replaces the stored row", () => {
    seedCorpus(db);
    upsertSqliteTableStats(db, computeAll(db));
    db.exec("DELETE FROM document_links WHERE created_at < '2021-01-01'");
    upsertSqliteTableStats(db, computeAll(db));

    const links = getSqliteCatalog(db).find((t) => t.tableName === "document_links");
    expect(links).toMatchObject({
      recordCount: 1,
      earliestDate: "2024-04-04T00:00:00.000Z",
      latestDate: "2024-04-04T00:00:00.000Z",
    });
  });

  test("a table outside the catalog, or one not created yet, has no statistics", () => {
    expect(computeSqliteTableStats(db, "catalog_table_stats")).toBeNull();
    expect(computeSqliteTableStats(db, "no_such_table")).toBeNull();

    const bare = new Database(":memory:");
    try {
      expect(computeSqliteTableStats(bare, "documents")).toBeNull();
    } finally {
      bare.close();
    }
  });
});

describe("the writer's share of a catalog refresh", () => {
  /**
   * A store holding nothing but `catalog_table_stats`, whose statements are
   * recorded as they are prepared. A writer op that applied here touched no
   * table it describes, so its cost cannot grow with the corpus.
   */
  function statsOnlyStore(): { store: Db; prepared: string[] } {
    const store = new Database(":memory:");
    store.exec(`CREATE TABLE catalog_table_stats (
      table_name TEXT PRIMARY KEY,
      row_count INTEGER NOT NULL DEFAULT 0,
      earliest_date TEXT,
      latest_date TEXT,
      last_computed_at TEXT
    )`);
    const prepared: string[] = [];
    const prepare = store.prepare.bind(store);
    store.prepare = ((sql: string) => {
      prepared.push(sql);
      return prepare(sql);
    }) as typeof store.prepare;
    return { store, prepared };
  }

  test("applies finished rows without reading the tables they describe", () => {
    seedCorpus(db);
    const rows = computeAll(db);
    const { store, prepared } = statsOnlyStore();
    try {
      writerHandlers["catalog.upsertSqliteTableStats"](store, rows);

      const stored = store
        .prepare(
          "SELECT table_name, row_count, earliest_date, latest_date FROM catalog_table_stats",
        )
        .all() as Array<{ table_name: string; row_count: number }>;
      expect(stored.map((r) => r.table_name).sort()).toEqual(rows.map((r) => r.tableName).sort());

      const writerStatements = prepared.slice(0, -1);
      expect(writerStatements.length).toBeGreaterThan(0);
      for (const sql of writerStatements) {
        for (const name of SQLITE_CATALOG_TABLES) {
          expect(sql).not.toMatch(new RegExp(`\\b${name}\\b`));
        }
        // Each statement is a primary-key upsert: its plan scans nothing.
        const plan = (
          store
            .prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...Array.from(sql.match(/\?/g) ?? [], () => null)) as Array<{ detail: string }>
        ).map((r) => r.detail);
        expect(plan.some((detail) => detail.startsWith("SCAN"))).toBe(false);
      }
    } finally {
      store.close();
    }
  });

  test("ignores a row naming a table outside the catalog", () => {
    const { store } = statsOnlyStore();
    try {
      upsertSqliteTableStats(store, [
        {
          tableName: "tasks",
          recordCount: 4,
          earliestDate: null,
          latestDate: null,
          computedAt: new Date().toISOString(),
        },
      ]);
      expect(store.prepare("SELECT COUNT(*) AS n FROM catalog_table_stats").get()).toEqual({
        n: 0,
      });
    } finally {
      store.close();
    }
  });

  test("the writer has no op that computes catalog statistics itself", () => {
    const catalogOps = Object.keys(writerHandlers).filter((name) => name.startsWith("catalog."));
    expect(catalogOps).toEqual(["catalog.upsertSqliteTableStats"]);
  });
});
