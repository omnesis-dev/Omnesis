// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createV152AccessTables } from "./migration-152-access-grants.js";
import { indexPendingCredentials } from "./migration-167-pending-credential-index.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
  createV152AccessTables(db);
});

afterEach(() => db.close());

test("does nothing on a database that has not reached the access tables", () => {
  const bare = new Database(":memory:") as unknown as Db;
  expect(() => indexPendingCredentials(bare)).not.toThrow();
  expect(
    bare.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index'").get(),
  ).toEqual({ count: 0 });
  bare.close();
});

test("indexes pending credentials by age, idempotently", () => {
  indexPendingCredentials(db);
  indexPendingCredentials(db);

  const index = db
    .prepare<
      [],
      { sql: string }
    >("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_principal_credentials_pending_created'")
    .get();
  expect(index?.sql).toContain("WHERE status = 'pending'");
  // The orphan sweep walks pending rows oldest first; the planner must be
  // able to use the index for that walk rather than scan the table.
  const plan = db
    .prepare<[], { detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT id FROM principal_credentials
       WHERE status = 'pending' AND created_at <= 0 ORDER BY created_at, id LIMIT 1`,
    )
    .all()
    .map((row) => row.detail)
    .join(" ");
  expect(plan).toContain("idx_principal_credentials_pending_created");
});
