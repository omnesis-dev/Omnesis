// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createAccessLevel } from "../access/store-levels.js";
import { getLevelCapabilities } from "../access/store-rules.js";
import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
});
afterEach(() => db.close());

test("upgrading legacy whole-source access adds empty scope state without changing permissions", () => {
  const result = createAccessLevel(db, {
    name: "Synthetic access",
    rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
    actorTokenId: "owner",
  });
  if (!result.ok) throw new Error(result.error);
  const before = getLevelCapabilities(db, result.value.id);
  for (const table of [
    "access_scope_capabilities",
    "source_scope_descriptors",
    "scope_fact_backfill",
    "source_scope_kind_readiness",
    "scope_entities",
    "document_scope_facts",
    "document_scope_completeness",
  ])
    db.exec(`DROP TABLE ${table}`);
  db.pragma("user_version = 215");
  runMigrations(db);
  expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  expect(getLevelCapabilities(db, result.value.id)).toEqual(before);
  expect(db.prepare("SELECT COUNT(*) AS n FROM access_scope_capabilities").get()).toEqual({ n: 0 });
  const schema = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY name",
    )
    .all();
  runMigrations(db);
  expect(
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY name",
      )
      .all(),
  ).toEqual(schema);
});
