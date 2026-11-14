// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 217 — the tables of published filter lists. They are new, so the
 * migration only has to create them, and creating them twice must be harmless.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { addSourceFilterLists } from "./migration-217-source-filter-lists.js";
import { runSchemaSetup } from "./schema.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
});

afterEach(() => db.close());

const TABLES = ["source_filter_item_members", "source_filter_items", "source_filter_lists"];

function shape(handle: Database.Database): unknown {
  return handle
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE tbl_name IN (${TABLES.map(() => "?").join(", ")}) ORDER BY type, name`,
    )
    .all(...TABLES);
}

test("is registered as migration 217", () => {
  expect(MIGRATIONS.find((migration) => migration.version === 217)?.up).toBe(addSourceFilterLists);
});

test("creates the three tables and the parent index, and running it again changes nothing", () => {
  addSourceFilterLists(db);
  const once = shape(db);
  expect(
    (once as Array<{ type: string; name: string }>)
      .filter((row) => !row.name.startsWith("sqlite_autoindex"))
      .map((row) => `${row.type}:${row.name}`),
  ).toEqual([
    "index:idx_source_filter_items_parent",
    "table:source_filter_item_members",
    "table:source_filter_items",
    "table:source_filter_lists",
  ]);
  db.prepare(
    `INSERT INTO source_filter_lists
       (source_id, field, device_id, generation, digest, item_count, published_at)
     VALUES ('filing:northstar', 'extra.folderIds', '', 1, 'abc', 0, 1000)`,
  ).run();
  addSourceFilterLists(db);
  expect(shape(db)).toEqual(once);
  expect(db.prepare("SELECT COUNT(*) AS n FROM source_filter_lists").get()).toEqual({ n: 1 });
});

test("an upgraded install ends with the same tables a fresh one starts with", () => {
  addSourceFilterLists(db);
  const fresh = new Database(":memory:");
  try {
    runSchemaSetup(fresh);
    expect(shape(db)).toEqual(shape(fresh));
  } finally {
    fresh.close();
  }
});
