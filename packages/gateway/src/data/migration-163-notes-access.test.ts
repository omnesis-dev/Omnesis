// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { addNotesAccessCapability } from "./migration-163-notes-access.js";
import { createV152AccessTables } from "./migration-152-access-grants.js";
import { migrateV153AccessPolicyFamilies } from "./migration-153-access-policy-families.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

test("upgrades existing grant constraints without granting Notes and remains idempotent", () => {
  const db = new Database(":memory:") as unknown as Db;
  try {
    runSchemaSetup(db);
    db.exec("DROP TABLE access_grant_capabilities");
    createV152AccessTables(db);
    migrateV153AccessPolicyFamilies(db);
    db.exec(`
      INSERT INTO access_principals(id, name, kind, created_at, updated_at)
      VALUES ('example-principal', 'Example principal', 'service', 1, 1);
      INSERT INTO access_grants(id, principal_id, name, created_at, updated_at)
      VALUES ('example-grant', 'example-principal', 'Example grant', 1, 1);
      INSERT INTO access_grant_capabilities(grant_id, capability, source_mode, source_ids)
      VALUES ('example-grant', 'direct', 'all', '[]');
    `);
    addNotesAccessCapability(db);
    addNotesAccessCapability(db);
    expect(db.prepare("SELECT capability FROM access_grant_capabilities").all()).toEqual([
      { capability: "direct" },
    ]);
    db.prepare(
      "INSERT INTO access_grant_capabilities(grant_id, capability, source_mode, source_ids) VALUES (?, 'notes', 'all', '[]')",
    ).run("example-grant");
    expect(() =>
      db
        .prepare(
          "UPDATE access_grant_capabilities SET source_mode = 'allowlist', source_ids = '[\"example:source\"]' WHERE capability = 'notes'",
        )
        .run(),
    ).toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'idx_access_grant_capabilities_policy'",
        )
        .get(),
    ).toEqual({ name: "idx_access_grant_capabilities_policy" });
  } finally {
    db.close();
  }
});
