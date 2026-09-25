// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { addOAuthRefreshRetryColumns } from "./migration-160-oauth-refresh-retry.js";

describe("migration 160: retry-safe OAuth refresh", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        revoked_at INTEGER
      );
      CREATE TABLE principal_credentials (
        id TEXT PRIMARY KEY,
        execution_device_id TEXT REFERENCES devices(id),
        revoked_at INTEGER
      );
      CREATE TABLE oauth_refresh_tokens (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL REFERENCES principal_credentials(id),
        token_hash TEXT NOT NULL,
        audience TEXT NOT NULL,
        scope TEXT NOT NULL,
        grant_revision INTEGER NOT NULL,
        family_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        revoked_at INTEGER
      );
      INSERT INTO devices (id, revoked_at) VALUES ('revoked-device', 1234);
      INSERT INTO principal_credentials (id, execution_device_id, revoked_at)
      VALUES ('bound-credential', 'revoked-device', NULL);
    `);
  });

  afterEach(() => db.close());

  test("adds retry state and revokes credentials bound to already-revoked devices", () => {
    addOAuthRefreshRetryColumns(db);

    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('oauth_refresh_tokens')")
        .all()
        .map((row) => row.name),
    ).toEqual(expect.arrayContaining(["replacement_ciphertext", "retry_until"]));
    expect(
      db
        .prepare("SELECT revoked_at FROM principal_credentials WHERE id = ?")
        .get("bound-credential"),
    ).toEqual({ revoked_at: 1234 });
    expect(() => addOAuthRefreshRetryColumns(db)).not.toThrow();
  });
});
