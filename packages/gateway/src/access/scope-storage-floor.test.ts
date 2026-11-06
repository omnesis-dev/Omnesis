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
import {
  withScopePolicyMutation,
  createScopeStorageFloor,
  reconcileLegacyScopeBoundaries,
} from "./scope-storage-floor.js";
import type { ScopePolicy } from "@omnesis/types";
let db: Database.Database;
const source = "fictional:one";
const policy: ScopePolicy = {
  sourceId: source,
  audience: { accessLevel: "level", capability: "direct" },
  rules: [{ action: "share", match: [{ kind: "label", id: "selected" }] }],
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

test.each([undefined, 1, 3, "2", null])(
  "old or invalid protocol %j cannot create a new native-scoped overlay",
  (minimumProtocol) => {
    expect(
      rawPolicies([{ ...policy, ...(minimumProtocol === undefined ? {} : { minimumProtocol }) }]),
    ).toThrow(/storage protocol/);
    expect(db.prepare("SELECT * FROM access_scope_capabilities").all()).toEqual([]);
  },
);
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

for (const owner of ["level", "grant"] as const)
  for (const mode of ["all", "allowlist", "denylist"] as const)
    test(`upgrade repairs preexisting widened ${owner} ${mode} rows without changing canonical authority`, () => {
      const ids =
        mode === "allowlist"
          ? [source, "fictional:two"]
          : mode === "denylist"
            ? ["fictional:blocked"]
            : [];
      write(owner, mode, ids);
      const before = db.prepare("SELECT * FROM access_scope_capabilities").get();
      const table = `access_${owner}_capabilities`;
      db.exec(
        `DROP TRIGGER scope_legacy_${owner}_insert; DROP TRIGGER scope_legacy_${owner}_update;`,
      );
      db.prepare(`INSERT INTO ${table} VALUES(?,'direct','all','[]')`).run(owner);
      createScopeStorageFloor(db);
      reconcileLegacyScopeBoundaries(db);
      const expected = conservativeSources({
        sourceMode: mode,
        sourceIds: ids,
        scopePolicies: [policy],
      });
      expect(db.prepare(`SELECT source_mode,source_ids FROM ${table}`).get()).toEqual({
        source_mode: expected.sourceMode,
        source_ids: JSON.stringify(expected.sourceIds),
      });
      expect(db.prepare("SELECT * FROM access_scope_capabilities").get()).toEqual(before);
      reconcileLegacyScopeBoundaries(db);
      expect(() =>
        db.prepare(`UPDATE ${table} SET source_mode='all',source_ids='[]'`).run(),
      ).toThrow(/conservative legacy/);
    });

test.each(['[{"minimumProtocol":3,"sourceId":"fictional:one"}]', "not-json", "[]"])(
  "unreadable old overlays %s fail narrow during rollback reconciliation",
  (raw) => {
    write();
    db.exec("DROP TRIGGER scope_policy_protocol_update; DROP TRIGGER scope_legacy_level_insert;");
    // Empty canonical policies are valid only if the canonical boundary itself is valid.
    db.prepare("UPDATE access_scope_capabilities SET policies=?,source_ids='corrupt-json'").run(
      raw,
    );
    db.prepare("INSERT INTO access_level_capabilities VALUES('level','direct','all','[]')").run();
    createScopeStorageFloor(db);
    reconcileLegacyScopeBoundaries(db);
    expect(
      db.prepare("SELECT source_mode,source_ids FROM access_level_capabilities").get(),
    ).toEqual({ source_mode: "allowlist", source_ids: "[]" });
    expect(db.prepare("SELECT policies FROM access_scope_capabilities").get()).toEqual({
      policies: raw,
    });
    expect(db.prepare("SELECT count(*) AS n FROM access_scope_legacy_denials").get()).toEqual({
      n: 1,
    });
    expect(() =>
      db.prepare("UPDATE access_level_capabilities SET source_mode='all',source_ids='[]'").run(),
    ).toThrow(/legacy/);
    expect(() => db.prepare("DELETE FROM access_scope_capabilities").run()).toThrow(
      /current editor/,
    );
    expect(() => db.prepare("UPDATE access_scope_capabilities SET policies='[]'").run()).toThrow(
      /current editor/,
    );
    writeScopeState(db, "level", "level", "direct", {
      sourceMode: "all",
      sourceIds: [],
      filterRevision: 2,
      scopePolicies: [],
    });
    expect(db.prepare("SELECT * FROM access_scope_legacy_denials").all()).toEqual([]);
    db.prepare("UPDATE access_level_capabilities SET source_mode='all',source_ids='[]'").run();
  },
);

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
    test(`pre-floor extra narrowing quarantines ${owner} ${mode} without rewriting policies`, () => {
      const ids =
        mode === "allowlist"
          ? [source, "fictional:two"]
          : mode === "denylist"
            ? ["fictional:blocked"]
            : [];
      write(owner, mode, ids);
      const before = db.prepare("SELECT * FROM access_scope_capabilities").get();
      const table = `access_${owner}_capabilities`;
      db.exec(`DROP TRIGGER scope_legacy_${owner}_insert`);
      db.prepare(`INSERT INTO ${table} VALUES(?,'direct',?,?)`).run(
        owner,
        mode === "allowlist" ? "allowlist" : "denylist",
        JSON.stringify(mode === "allowlist" ? [] : [...ids, source, "fictional:revoked"]),
      );
      createScopeStorageFloor(db);
      reconcileLegacyScopeBoundaries(db);
      expect(db.prepare(`SELECT source_mode,source_ids FROM ${table}`).get()).toEqual({
        source_mode: "allowlist",
        source_ids: "[]",
      });
      expect(db.prepare("SELECT * FROM access_scope_capabilities").get()).toEqual(before);
      expect(readScopeState(db, owner, owner, "direct")).toMatchObject({
        sourceMode: "allowlist",
        sourceIds: [],
        scopePolicies: [policy],
      });
      reconcileLegacyScopeBoundaries(db);
      expect(db.prepare("SELECT count(*) AS n FROM access_scope_legacy_denials").get()).toEqual({
        n: 1,
      });
      expect(() =>
        db.prepare(`UPDATE ${table} SET source_mode='all',source_ids='[]'`).run(),
      ).toThrow(/legacy/);
    });
  }
}
