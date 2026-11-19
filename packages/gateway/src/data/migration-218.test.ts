// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  PERSON_NAME_ALIAS_INDEX,
  indexPersonNameAliases,
} from "./migration-218-person-name-alias-index.js";
import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.exec(`CREATE TABLE person_aliases (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    alias_type TEXT NOT NULL,
    UNIQUE(alias_type, alias, person_id)
  )`);
  const insert = db.prepare(
    "INSERT INTO person_aliases (id, person_id, alias, alias_type) VALUES (?, ?, ?, ?)",
  );
  insert.run("a1", "p1", "Maya reeves", "name");
  insert.run("a2", "p2", "MAYA REEVES", "name");
  insert.run("a3", "p3", "maya reeves", "email");
});

afterEach(() => db.close());

test("indexes name aliases by their lowercased text on an existing table, idempotently", () => {
  indexPersonNameAliases(db);
  indexPersonNameAliases(db);

  // Without statistics the planner prefers the covering `(alias_type, alias)`
  // index and walks every name, so readers name this one.
  const sql = `SELECT person_id FROM person_aliases INDEXED BY ${PERSON_NAME_ALIAS_INDEX}
     WHERE alias_type = 'name' AND LOWER(alias) = ? ORDER BY person_id`;
  expect(
    db
      .prepare<[string], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all("maya reeves")
      .map((row) => row.detail),
  ).toEqual([
    `SEARCH person_aliases USING INDEX ${PERSON_NAME_ALIAS_INDEX} (<expr>=?)`,
    "USE TEMP B-TREE FOR ORDER BY",
  ]);
  // Names only, whatever their case; the email with the same text is not one.
  expect(db.prepare<[string], { person_id: string }>(sql).all("maya reeves")).toEqual([
    { person_id: "p1" },
    { person_id: "p2" },
  ]);
});

test("is registered as migration 218", () => {
  const step = MIGRATIONS.find((m) => m.version === 218);
  expect(step?.up).toBe(indexPersonNameAliases);
});
