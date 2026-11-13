// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { createAccessLevel } from "../access/store-levels.js";
import { writeScopeState } from "../access/scope-policy-store.js";
import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION } from "./schema-version.js";
import { runMigrations } from "./migrations.js";

/** An additive conflict fence must preserve both canonical and rollback permissions. */
test("the source-filter migration adds descriptor conflict state without rewriting saved filtered grants", () => {
  const db = new Database(":memory:");
  try {
    runSchemaSetup(db);
    const level = createAccessLevel(db, {
      name: "Synthetic existing level",
      rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
      actorTokenId: "owner",
    });
    if (!level.ok) throw new Error(level.error);
    writeScopeState(db, "level", level.value.id, "direct", {
      sourceMode: "all",
      sourceIds: [],
      filterRevision: 1,
      scopePolicies: [
        {
          sourceId: "fictional:one",
          audience: { accessLevel: level.value.id, capability: "direct" },
          rules: [{ match: [{ kind: "conversation", id: "chat" }], action: "share" }],
          otherwise: "hide",
        },
      ],
    });
    db.prepare(
      "UPDATE access_level_capabilities SET source_mode='denylist',source_ids=? WHERE level_id=?",
    ).run(JSON.stringify(["fictional:one"]), level.value.id);
    const canonical = db.prepare("SELECT * FROM access_scope_capabilities").all();
    const legacy = db.prepare("SELECT * FROM access_level_capabilities").all();
    db.exec("DROP TABLE source_scope_descriptor_conflicts");
    db.pragma("user_version = 215");
    runMigrations(db);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT * FROM source_scope_descriptor_conflicts").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM access_scope_capabilities").all()).toEqual(canonical);
    expect(db.prepare("SELECT * FROM access_level_capabilities").all()).toEqual(legacy);
    runMigrations(db);
    expect(db.prepare("SELECT * FROM access_scope_capabilities").all()).toEqual(canonical);
  } finally {
    db.close();
  }
});
