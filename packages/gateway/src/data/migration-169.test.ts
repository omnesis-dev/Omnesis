// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createV152AccessTables } from "./migration-152-access-grants.js";
import { retireServiceCredentials } from "./migration-169-retire-service-credentials.js";
import type { Db } from "./types.js";

const NOW = 1_800_000_000_000;
const EARLIER = NOW - 60_000;
let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
  createV152AccessTables(db);
  db.exec(`
    INSERT INTO access_principals (id, name, kind, created_at, updated_at, revoked_at) VALUES
      ('interactive-principal', 'Fictional assistant', 'interactive', 1, 1, NULL),
      ('service-principal', 'Fictional automation', 'service', 1, 1, NULL),
      ('retired-principal', 'Fictional retired automation', 'service', 1, 1, ${EARLIER});
    INSERT INTO access_grants (id, principal_id, name, created_at, updated_at, revoked_at) VALUES
      ('interactive-grant', 'interactive-principal', 'Reviewed answer', 1, 1, NULL),
      ('service-grant', 'service-principal', 'Whole-corpus access', 1, 1, NULL),
      ('retired-grant', 'retired-principal', 'Whole-corpus access', 1, 1, ${EARLIER});
    INSERT INTO principal_credentials
      (id, grant_id, oauth_client_id, kind, label, client_secret_hash, created_at, revoked_at) VALUES
      ('interactive-credential', 'interactive-grant', 'client-1', 'interactive', 'Workstation', NULL, 1, NULL),
      ('service-credential', 'service-grant', 'omn_svc_fictional', 'service', 'Worker', 'hash', 1, NULL),
      ('retired-credential', 'retired-grant', 'omn_svc_retired', 'service', 'Worker', 'hash', 1, ${EARLIER});
  `);
});

afterEach(() => db.close());

test("does nothing on a database that has not reached the access tables", () => {
  const bare = new Database(":memory:") as unknown as Db;
  expect(() => retireServiceCredentials(bare, NOW)).not.toThrow();
  bare.close();
});

test("revokes service principals, grants and credentials once and leaves interactive rows alone", () => {
  retireServiceCredentials(db, NOW);
  retireServiceCredentials(db, NOW + 1);

  const revokedAt = (table: string) =>
    db
      .prepare<
        [],
        { id: string; revoked_at: number | null }
      >(`SELECT id, revoked_at FROM ${table} ORDER BY id`)
      .all();
  expect(revokedAt("access_principals")).toEqual([
    { id: "interactive-principal", revoked_at: null },
    { id: "retired-principal", revoked_at: EARLIER },
    { id: "service-principal", revoked_at: NOW },
  ]);
  expect(revokedAt("access_grants")).toEqual([
    { id: "interactive-grant", revoked_at: null },
    { id: "retired-grant", revoked_at: EARLIER },
    { id: "service-grant", revoked_at: NOW },
  ]);
  expect(revokedAt("principal_credentials")).toEqual([
    { id: "interactive-credential", revoked_at: null },
    { id: "retired-credential", revoked_at: EARLIER },
    { id: "service-credential", revoked_at: NOW },
  ]);
  const updatedAt = (table: string) =>
    db
      .prepare<
        [],
        { id: string; updated_at: number }
      >(`SELECT id, updated_at FROM ${table} ORDER BY id`)
      .all();
  expect(updatedAt("access_principals")).toEqual([
    { id: "interactive-principal", updated_at: 1 },
    { id: "retired-principal", updated_at: 1 },
    { id: "service-principal", updated_at: NOW },
  ]);
  expect(updatedAt("access_grants")).toEqual([
    { id: "interactive-grant", updated_at: 1 },
    { id: "retired-grant", updated_at: 1 },
    { id: "service-grant", updated_at: NOW },
  ]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM access_audit_events").get()).toEqual({
    count: 0,
  });
});
