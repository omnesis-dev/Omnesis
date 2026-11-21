// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, test, expect } from "vitest";
import {
  createScopePolicyStore,
  readScopeState,
  writeScopeState,
  conservativeSources,
} from "./scope-policy-store.js";
import { withScopePolicyMutation, createScopeStorageFloor } from "./scope-storage-floor.js";
import { isScopeQuarantined } from "./scope-quarantine.js";
import { SCOPE_POLICY_STORAGE_PROTOCOL } from "./scope-policy-encoding.js";
import type { SourceFilter } from "@omnesis/types";
let db: Database.Database;
const source = "fictional:one";
const policy: SourceFilter = {
  sourceId: source,
  audience: { accessLevel: "level", capability: "direct" },
  rules: [
    {
      action: "share",
      match: [{ capability: "membership", field: "extra.labelIds", id: "selected" }],
    },
  ],
  otherwise: "hide",
};
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE access_grants(id TEXT PRIMARY KEY); INSERT INTO access_grants VALUES('grant');
 CREATE TABLE access_levels(id TEXT PRIMARY KEY); INSERT INTO access_levels VALUES('level');
 CREATE TABLE access_level_capabilities(level_id TEXT,capability TEXT,source_mode TEXT,source_ids TEXT,PRIMARY KEY(level_id,capability));
 CREATE TABLE access_grant_capabilities(grant_id TEXT,capability TEXT,source_mode TEXT,source_ids TEXT,PRIMARY KEY(grant_id,capability));`);
  createScopePolicyStore(db);
});
afterEach(() => db.close());
function write(
  owner: "level" | "grant" = "level",
  mode: "all" | "allowlist" | "denylist" = "all",
  ids: string[] = [],
) {
  writeScopeState(db, owner, owner, "direct", {
    sourceMode: mode,
    sourceIds: ids,
    filterRevision: 1,
    scopePolicies: [policy],
  });
}
function rawPolicies(value: unknown) {
  return () =>
    db
      .prepare(
        "INSERT INTO access_scope_capabilities VALUES('level','level','direct','all','[]',1,?)",
      )
      .run(JSON.stringify(value));
}

test.each([
  undefined,
  0,
  SCOPE_POLICY_STORAGE_PROTOCOL + 1,
  String(SCOPE_POLICY_STORAGE_PROTOCOL),
  null,
])("old or invalid protocol %j cannot create a new native-scoped overlay", (minimumProtocol) => {
  expect(
    rawPolicies([{ ...policy, ...(minimumProtocol === undefined ? {} : { minimumProtocol }) }]),
  ).toThrow(/storage protocol/);
  expect(db.prepare("SELECT * FROM access_scope_capabilities").all()).toEqual([]);
});
test("current protocol is accepted, while an old writer cannot strip it or clear/delete a protected overlay", () => {
  write();
  expect(() =>
    db.prepare("UPDATE access_scope_capabilities SET policies=?").run(JSON.stringify([policy])),
  ).toThrow(/storage protocol/);
  expect(() =>
    db.prepare("UPDATE access_scope_capabilities SET policies='[]',filter_revision=2").run(),
  ).toThrow(/current editor/);
  expect(() => db.prepare("DELETE FROM access_scope_capabilities").run()).toThrow(/current editor/);
  writeScopeState(db, "level", "level", "direct", {
    sourceMode: "all",
    sourceIds: [],
    filterRevision: 2,
    scopePolicies: [],
  });
  expect(db.prepare("SELECT policies FROM access_scope_capabilities").get()).toEqual({
    policies: "[]",
  });
  expect(db.prepare("SELECT * FROM scope_policy_mutation_context").all()).toEqual([]);
});
test("unfiltered empty overlays remain writable by legacy code", () => {
  rawPolicies([])();
  db.prepare("UPDATE access_scope_capabilities SET policies='[]'").run();
  db.prepare("DELETE FROM access_scope_capabilities").run();
  expect(db.prepare("SELECT * FROM access_scope_capabilities").all()).toEqual([]);
});
for (const owner of ["level", "grant"] as const)
  for (const mode of ["all", "allowlist", "denylist"] as const)
    test(`legacy ${owner} ${mode} saves cannot widen the conservative source rows`, () => {
      const ids =
        mode === "allowlist"
          ? [source, "fictional:two"]
          : mode === "denylist"
            ? ["fictional:blocked"]
            : [];
      write(owner, mode, ids);
      const legacy = conservativeSources({
        sourceMode: mode,
        sourceIds: ids,
        scopePolicies: [policy],
      });
      const table = `access_${owner}_capabilities`,
        key = `${owner}_id`;
      db.prepare(`INSERT INTO ${table} VALUES(?,'direct',?,?)`).run(
        owner,
        legacy.sourceMode,
        JSON.stringify(legacy.sourceIds),
      );
      db.prepare(
        `UPDATE ${table} SET source_mode=source_mode,source_ids=source_ids WHERE ${key}=?`,
      ).run(owner);
      expect(() =>
        db
          .prepare(`UPDATE ${table} SET source_mode='all',source_ids='[]' WHERE ${key}=?`)
          .run(owner),
      ).toThrow(/conservative legacy/);
      db.prepare(`DELETE FROM ${table} WHERE ${key}=?`).run(owner);
      expect(() =>
        db.prepare(`INSERT INTO ${table} VALUES(?,'direct','all','[]')`).run(owner),
      ).toThrow(/conservative legacy/);
      expect(db.prepare("SELECT count(*) AS n FROM access_scope_policy_sources").get()).toEqual({
        n: 1,
      });
    });
test("failed new-editor mutation rolls back the exemption and cannot authorize an old writer later", () => {
  write();
  expect(() =>
    withScopePolicyMutation(db, "level", "level", () => {
      db.prepare("DELETE FROM access_scope_capabilities").run();
      throw new Error("Fictional failure");
    }),
  ).toThrow("Fictional failure");
  expect(db.prepare("SELECT * FROM scope_policy_mutation_context").all()).toEqual([]);
  expect(() => db.prepare("DELETE FROM access_scope_capabilities").run()).toThrow(/current editor/);
});
test("owner deletion still cleans its overlay instead of retaining an orphan", () => {
  write();
  db.prepare("DELETE FROM access_levels WHERE id='level'").run();
  expect(db.prepare("SELECT * FROM access_scope_capabilities").all()).toEqual([]);
});

for (const owner of ["level", "grant"] as const) {
  for (const mode of ["all", "allowlist", "denylist"] as const) {
    test(`protected ${owner} ${mode} rejects additional legacy revocations and permits set-equivalent order`, () => {
      const ids =
        mode === "allowlist"
          ? [source, "fictional:two", "fictional:three"]
          : mode === "denylist"
            ? ["fictional:blocked"]
            : [];
      write(owner, mode, ids);
      const legacy = conservativeSources({
        sourceMode: mode,
        sourceIds: ids,
        scopePolicies: [policy],
      });
      const table = `access_${owner}_capabilities`;
      db.prepare(`INSERT INTO ${table} VALUES(?,'direct',?,?)`).run(
        owner,
        legacy.sourceMode,
        JSON.stringify(legacy.sourceIds),
      );
      db.prepare(`UPDATE ${table} SET source_ids=?`).run(
        JSON.stringify([...legacy.sourceIds].reverse()),
      );
      const narrowed =
        mode === "allowlist"
          ? legacy.sourceIds.slice(1)
          : [...legacy.sourceIds, "fictional:revoked"];
      expect(() =>
        db.prepare(`UPDATE ${table} SET source_ids=?`).run(JSON.stringify(narrowed)),
      ).toThrow(/conservative legacy/);
      db.prepare(`DELETE FROM ${table}`).run();
      expect(() =>
        db
          .prepare(`INSERT INTO ${table} VALUES(?,'direct',?,?)`)
          .run(owner, legacy.sourceMode, JSON.stringify(narrowed)),
      ).toThrow(/conservative legacy/);
    });
  }
}

test("a denial left on a level reads as deny-all, holds the legacy rows at deny-all, and the next owner save lifts it", () => {
  write("level", "allowlist", [source, "fictional:two"]);
  const legacy = conservativeSources({
    sourceMode: "allowlist",
    sourceIds: [source, "fictional:two"],
    scopePolicies: [policy],
  });
  db.prepare("INSERT INTO access_level_capabilities VALUES('level','direct',?,?)").run(
    legacy.sourceMode,
    JSON.stringify(legacy.sourceIds),
  );
  db.prepare("INSERT INTO access_scope_legacy_denials VALUES('level','level','direct')").run();
  expect(isScopeQuarantined(db, "level", "level", "direct")).toBe(true);
  expect(isScopeQuarantined(db, "level", "level", "answer")).toBe(false);
  expect(readScopeState(db, "level", "level", "direct")).toMatchObject({
    sourceMode: "allowlist",
    sourceIds: [],
    scopePolicies: [policy],
  });
  expect(() =>
    db.prepare("UPDATE access_level_capabilities SET source_ids=?").run(JSON.stringify([source])),
  ).toThrow(/deny-all/);
  db.prepare("UPDATE access_level_capabilities SET source_mode='allowlist',source_ids='[]'").run();
  expect(() => db.prepare("DELETE FROM access_scope_capabilities").run()).toThrow(/current editor/);
  writeScopeState(db, "level", "level", "direct", {
    sourceMode: "allowlist",
    sourceIds: [source, "fictional:two"],
    filterRevision: 2,
    scopePolicies: [policy],
  });
  expect(isScopeQuarantined(db, "level", "level", "direct")).toBe(false);
  expect(readScopeState(db, "level", "level", "direct")?.sourceIds).toEqual([
    source,
    "fictional:two",
  ]);
});

test("a grant inherits the denial of the level it belongs to", () => {
  db.exec("ALTER TABLE access_grants ADD COLUMN level_id TEXT");
  db.prepare("UPDATE access_grants SET level_id='level' WHERE id='grant'").run();
  write("grant");
  expect(isScopeQuarantined(db, "grant", "grant", "direct")).toBe(false);
  db.prepare("INSERT INTO access_scope_legacy_denials VALUES('level','level','direct')").run();
  expect(isScopeQuarantined(db, "grant", "grant", "direct")).toBe(true);
  expect(readScopeState(db, "grant", "grant", "direct")).toMatchObject({
    sourceMode: "allowlist",
    sourceIds: [],
  });
  db.prepare("DELETE FROM access_levels WHERE id='level'").run();
  expect(db.prepare("SELECT * FROM access_scope_legacy_denials").all()).toEqual([]);
});

test("creating the floor again keeps every trigger in force", () => {
  write();
  createScopeStorageFloor(db);
  createScopeStorageFloor(db);
  expect(() => db.prepare("DELETE FROM access_scope_capabilities").run()).toThrow(/current editor/);
});
