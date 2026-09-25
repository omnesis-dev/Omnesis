// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for `withDocIdRestriction` — the helper that keeps a possibly-huge
 * `document_id IN (…)` restriction under SQLite's 32766 bound-variable cap by
 * staging large sets into a TEMP table instead of an inline list (#581).
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
type Db = Database.Database;
import { INLINE_DOCID_LIMIT, withDocIdRestriction } from "./docid-filter.js";

let db: Db;
let dbPath: string;

beforeEach(() => {
  dbPath = `/tmp/omnesis-docid-filter-${randomUUID()}.db`;
  db = new Database(dbPath);
  db.exec("CREATE TABLE c (document_id TEXT)");
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
});

function query(documentIds: readonly string[] | undefined): string[] {
  return withDocIdRestriction(db, "c.document_id", documentIds, ({ clause, params }) =>
    db
      .prepare<(string | number)[], { document_id: string }>(
        `SELECT document_id FROM c WHERE 1=1${clause} ORDER BY document_id`,
      )
      .all(...params)
      .map((r) => r.document_id),
  );
}

describe("withDocIdRestriction", () => {
  beforeEach(() => {
    const insert = db.prepare<[string]>("INSERT INTO c (document_id) VALUES (?)");
    for (const id of ["a", "b", "c", "d"]) insert.run(id);
  });

  test("undefined → no restriction (returns every row)", () => {
    expect(query(undefined)).toEqual(["a", "b", "c", "d"]);
  });

  test("small set → inline IN-list restricts correctly", () => {
    expect(query(["a", "c"])).toEqual(["a", "c"]);
  });

  test("empty set → matches nothing (not an invalid `IN ()`, not 'all rows')", () => {
    // An empty allowed set means the filter resolved to zero documents, so the
    // result must be empty — NOT every row (which an undefined set would give).
    expect(query([])).toEqual([]);
  });

  test("a set above SQLite's variable cap is restricted via the temp-table path", () => {
    const ids = ["b", "d"];
    for (let i = 0; i < 40000; i++) ids.push(`absent-${i}`);
    expect(ids.length).toBeGreaterThan(INLINE_DOCID_LIMIT);
    expect(query(ids)).toEqual(["b", "d"]);
  });

  test("duplicate ids in a large set don't break the temp table (PRIMARY KEY + OR IGNORE)", () => {
    const ids = ["a", "a", "c", "c"];
    for (let i = 0; i < 40000; i++) ids.push(`absent-${i % 100}`);
    expect(query(ids)).toEqual(["a", "c"]);
  });

  test("the temp table is dropped after the call, leaving no per-connection residue", () => {
    const ids: string[] = [];
    for (let i = 0; i < INLINE_DOCID_LIMIT + 1; i++) ids.push(`x-${i}`);
    query(ids);
    const leftover = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_temp_master WHERE type='table' AND name='docid_filter'")
      .get();
    expect(leftover).toBeUndefined();
  });

  test("the body's return value is propagated", () => {
    const n = withDocIdRestriction(db, "c.document_id", ["a"], () => 42);
    expect(n).toBe(42);
  });
});
