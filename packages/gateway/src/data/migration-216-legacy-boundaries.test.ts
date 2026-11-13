// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { test, expect } from "vitest";
import { writeScopeState } from "../access/scope-policy-store.js";
import { hasSavedScopePolicySource } from "../access/scope-policy-source-index.js";
import { runSchemaSetup } from "./schema.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";
import type { ScopePolicy } from "@omnesis/types";

const source = "fictional:migration";
const policy: ScopePolicy = {
  sourceId: source,
  audience: { accessLevel: "level", capability: "direct" },
  rules: [{ action: "share", match: [{ kind: "label", id: "stable" }] }],
  otherwise: "hide",
};
test.each([
  [false, false],
  [true, false],
  [false, true],
])(
  "the source-filter migration repairs widened legacy rows and persists fail-narrow guards; unreadable=%s narrowed=%s",
  (unreadable, narrowed) => {
    const db = new Database(":memory:");
    try {
      runSchemaSetup(db);
      db.prepare(
        "INSERT INTO access_levels(id,name,revision,created_at,updated_at) VALUES('level','Fictional migration',1,1,1)",
      ).run();
      writeScopeState(db, "level", "level", "direct", {
        sourceMode: "all",
        sourceIds: [],
        filterRevision: 1,
        scopePolicies: [policy],
      });
      const triggers = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'scope_policy_%' OR name LIKE 'scope_legacy_%')",
        )
        .all();
      for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
      if (unreadable)
        db.prepare("UPDATE access_scope_capabilities SET policies=?").run(
          JSON.stringify([{ ...policy, minimumProtocol: 3 }]),
        );
      const canonical = db.prepare("SELECT * FROM access_scope_capabilities").get();
      db.prepare(
        "INSERT INTO access_level_capabilities(level_id,capability,source_mode,source_ids) VALUES('level','direct','all','[]')",
      ).run();
      if (narrowed)
        db.prepare("UPDATE access_level_capabilities SET source_mode='denylist',source_ids=?").run(
          JSON.stringify([source, "fictional:revoked"]),
        );
      db.exec(
        "DROP TABLE access_scope_policy_sources; DROP TABLE scope_policy_mutation_context; DROP TABLE access_scope_legacy_denials",
      );
      db.pragma("user_version = 215");
      runMigrations(db);
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare("SELECT * FROM access_scope_capabilities").get()).toEqual(canonical);
      expect(
        db.prepare("SELECT source_mode,source_ids FROM access_level_capabilities").get(),
      ).toEqual(
        unreadable || narrowed
          ? { source_mode: "allowlist", source_ids: "[]" }
          : { source_mode: "denylist", source_ids: JSON.stringify([source]) },
      );
      expect(hasSavedScopePolicySource(db, source)).toBe(true);
      expect(() =>
        db.prepare("UPDATE access_level_capabilities SET source_mode='all',source_ids='[]'").run(),
      ).toThrow(/legacy/);
      expect(db.prepare("SELECT revision FROM access_levels").get()).toEqual({
        revision: unreadable || narrowed ? 2 : 1,
      });
      runMigrations(db);
    } finally {
      db.close();
    }
  },
);
