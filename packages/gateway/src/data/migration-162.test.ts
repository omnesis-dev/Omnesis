// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createV152AccessTables } from "./migration-152-access-grants.js";
import { indexPrincipalCredentialsByExecutionDevice } from "./migration-162-principal-credential-device-index.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
  createV152AccessTables(db);
});

afterEach(() => db.close());

test("indexes the execution-device revocation lookup idempotently", () => {
  indexPrincipalCredentialsByExecutionDevice(db);
  indexPrincipalCredentialsByExecutionDevice(db);

  const indexes = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_index_list('principal_credentials')")
    .all()
    .map((row) => row.name);
  expect(indexes).toContain("idx_principal_credentials_execution_device");

  const plan = db
    .prepare<
      [string],
      { detail: string }
    >("EXPLAIN QUERY PLAN SELECT id FROM principal_credentials WHERE execution_device_id = ?")
    .all("fictional-device");
  expect(
    plan.some((row) => row.detail.includes("idx_principal_credentials_execution_device")),
  ).toBe(true);
});

test("is a no-op when the optional access schema is absent", () => {
  db.exec("DROP TABLE principal_credentials");

  expect(() => indexPrincipalCredentialsByExecutionDevice(db)).not.toThrow();
});
