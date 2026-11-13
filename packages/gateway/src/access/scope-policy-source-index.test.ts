// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, test, expect } from "vitest";
import { createScopePolicyStore, writeScopeState } from "./scope-policy-store.js";
import {
  backfillScopePolicySourceIndex,
  hasSavedScopePolicySource,
} from "./scope-policy-source-index.js";
import type { ScopePolicy } from "@omnesis/types";
let db: Database.Database;
const policy = (sourceId: string): ScopePolicy => ({
  sourceId,
  audience: { accessLevel: "level", capability: "answer" },
  rules: [{ action: "share", match: [{ kind: "label", id: "stable" }] }],
  otherwise: "hide",
});
function write(sourceId: string) {
  writeScopeState(db, "level", "level", "answer", {
    sourceMode: "all",
    sourceIds: [],
    filterRevision: 1,
    scopePolicies: [policy(sourceId)],
  });
}
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE access_grants(id TEXT PRIMARY KEY); CREATE TABLE access_levels(id TEXT PRIMARY KEY,revoked_at INTEGER); INSERT INTO access_levels VALUES('level',NULL)",
  );
  createScopePolicyStore(db);
});
afterEach(() => db.close());

test("configuration-only upgrade indexes existing overlays and is idempotent", () => {
  write("fictional:one");
  db.prepare("DELETE FROM access_scope_policy_sources").run();
  expect(hasSavedScopePolicySource(db, "fictional:one")).toBe(false);
  backfillScopePolicySourceIndex(db);
  backfillScopePolicySourceIndex(db);
  expect(hasSavedScopePolicySource(db, "fictional:one")).toBe(true);
  expect(db.prepare("SELECT count(*) AS n FROM access_scope_policy_sources").get()).toEqual({
    n: 1,
  });
});
test("raw older writers update and clear source entries through persistent overlay triggers", () => {
  write("fictional:one");
  db.prepare("UPDATE access_scope_capabilities SET policies=? WHERE owner_id='level'").run(
    JSON.stringify([{ ...policy("fictional:two"), minimumProtocol: 2 }]),
  );
  expect(hasSavedScopePolicySource(db, "fictional:one")).toBe(false);
  expect(hasSavedScopePolicySource(db, "fictional:two")).toBe(true);
  expect(() =>
    db.prepare("UPDATE access_scope_capabilities SET policies='[]' WHERE owner_id='level'").run(),
  ).toThrow(/current editor/);
  writeScopeState(db, "level", "level", "answer", {
    sourceMode: "all",
    sourceIds: [],
    filterRevision: 2,
    scopePolicies: [],
  });
  expect(hasSavedScopePolicySource(db, "fictional:two")).toBe(false);
  write("fictional:one");
  expect(() =>
    db.prepare("DELETE FROM access_scope_capabilities WHERE owner_id='level'").run(),
  ).toThrow(/current editor/);
  writeScopeState(db, "level", "level", "answer", null);
  expect(db.prepare("SELECT * FROM access_scope_policy_sources").all()).toEqual([]);
});
test("revoked levels and grant-only overlays do not offer gate-off source inspection", () => {
  write("fictional:one");
  db.prepare("UPDATE access_levels SET revoked_at=1 WHERE id='level'").run();
  expect(hasSavedScopePolicySource(db, "fictional:one")).toBe(false);
  writeScopeState(db, "grant", "grant", "answer", {
    sourceMode: "all",
    sourceIds: [],
    filterRevision: 1,
    scopePolicies: [policy("fictional:two")],
  });
  expect(hasSavedScopePolicySource(db, "fictional:two")).toBe(false);
});
test("malformed policy writes fail without losing the indexed restriction", () => {
  write("fictional:one");
  for (const raw of ["not-json", '["text",null,1]', "{}"]) {
    expect(() => db.prepare("UPDATE access_scope_capabilities SET policies=?").run(raw)).toThrow(
      /protocol/,
    );
    expect(hasSavedScopePolicySource(db, "fictional:one")).toBe(true);
  }
});
test("source lookup uses its source-keyed index rather than expanding JSON", () => {
  write("fictional:one");
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM access_scope_policy_sources s WHERE s.source_id=? AND s.owner_kind='level' AND EXISTS(SELECT 1 FROM access_levels l WHERE l.id=s.owner_id AND l.revoked_at IS NULL) LIMIT 1",
    )
    .all("fictional:one") as Array<{ detail: string }>;
  expect(plan.some((row) => /SEARCH s USING PRIMARY KEY.*source_id/.test(row.detail))).toBe(true);
});
