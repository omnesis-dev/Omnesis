// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";

import { MIGRATIONS, runMigrations } from "./migrations.js";

const REVISION_ONE = "1".repeat(64);
const REVISION_TWO = "2".repeat(64);
const REVISION_THREE = "3".repeat(64);
const DIGEST_ONE = "a".repeat(64);
const DIGEST_TWO = "b".repeat(64);

describe("migration 153: policy families and granular grants", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE tokens (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        scopes TEXT NOT NULL
      );
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        run_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (version, description, run_at, duration_ms)
      VALUES (151, 'existing v151 installation', 1, 1);
      PRAGMA user_version = 151;

      CREATE TABLE privacy_policy_versions (
        generation INTEGER PRIMARY KEY AUTOINCREMENT,
        revision TEXT NOT NULL UNIQUE CHECK(length(revision) = 64),
        digest TEXT NOT NULL CHECK(length(digest) = 64),
        policy TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('bootstrap', 'edit', 'revert')),
        reverted_from_generation INTEGER REFERENCES privacy_policy_versions(generation),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE privacy_policy_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        generation INTEGER NOT NULL UNIQUE REFERENCES privacy_policy_versions(generation),
        revision TEXT NOT NULL UNIQUE,
        digest TEXT NOT NULL,
        previous_digest TEXT,
        mirror_synced INTEGER NOT NULL DEFAULT 0 CHECK(mirror_synced IN (0, 1)),
        updated_at INTEGER NOT NULL
      );
    `);
    runMigrations(db, { migrations: [MIGRATIONS.find((item) => item.version === 152)!] });
    seedV152Rows(db);
  });

  afterEach(() => db.close());

  test("preserves V1 identities, tokens, pending requests, and policy provenance", () => {
    const migration = MIGRATIONS.find((item) => item.version === 153)!;
    runMigrations(db, { migrations: [migration] });

    expect(db.pragma("user_version", { simple: true })).toBe(153);
    expect(db.prepare("SELECT id, name FROM access_principals").all()).toEqual([
      { id: "principal-one", name: "Fictional assistant" },
    ]);
    expect(db.prepare("SELECT id, grant_revision FROM oauth_access_tokens").all()).toEqual([
      { id: "access-one", grant_revision: 1 },
    ]);
    expect(
      db
        .prepare(
          `SELECT family_id, family_version, action, origin_revision
           FROM privacy_policy_versions ORDER BY generation`,
        )
        .all(),
    ).toEqual([
      {
        family_id: DEFAULT_PRIVACY_POLICY_FAMILY_ID,
        family_version: 1,
        action: "bootstrap",
        origin_revision: null,
      },
      {
        family_id: DEFAULT_PRIVACY_POLICY_FAMILY_ID,
        family_version: 2,
        action: "edit",
        origin_revision: null,
      },
      {
        family_id: DEFAULT_PRIVACY_POLICY_FAMILY_ID,
        family_version: 3,
        action: "restore",
        origin_revision: REVISION_ONE,
      },
    ]);
    expect(db.prepare("SELECT * FROM access_grant_capabilities").all()).toEqual([
      {
        grant_id: "grant-one",
        capability: "answer",
        source_mode: "all",
        source_ids: "[]",
        release_mode: "reviewed",
        policy_family_id: DEFAULT_PRIVACY_POLICY_FAMILY_ID,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT id, access_notification_reserved_at, access_notification_sent_at
           FROM oauth_authorization_requests`,
        )
        .all(),
    ).toEqual([
      {
        id: "request-one",
        access_notification_reserved_at: null,
        access_notification_sent_at: null,
      },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    expect(() =>
      db
        .prepare(
          `UPDATE access_grant_capabilities SET policy_family_id = 'missing-policy'
          WHERE grant_id = 'grant-one' AND capability = 'answer'`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint/i);

    const before = db.prepare("SELECT * FROM privacy_policy_versions ORDER BY generation").all();
    runMigrations(db, { migrations: [migration] });
    expect(db.prepare("SELECT * FROM privacy_policy_versions ORDER BY generation").all()).toEqual(
      before,
    );
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

function seedV152Rows(db: Database.Database): void {
  db.prepare(
    `INSERT INTO privacy_policy_versions
       (generation, revision, digest, policy, action, reverted_from_generation, created_at)
     VALUES
       (1, ?, ?, '# Initial', 'bootstrap', NULL, 10),
       (2, ?, ?, '# Changed', 'edit', NULL, 20),
       (3, ?, ?, '# Initial', 'revert', 1, 30)`,
  ).run(REVISION_ONE, DIGEST_ONE, REVISION_TWO, DIGEST_TWO, REVISION_THREE, DIGEST_ONE);
  db.prepare(
    `INSERT INTO privacy_policy_state
       (singleton, generation, revision, digest, previous_digest, mirror_synced, updated_at)
     VALUES (1, 3, ?, ?, ?, 1, 30)`,
  ).run(REVISION_THREE, DIGEST_ONE, DIGEST_TWO);
  db.exec(`
    INSERT INTO oauth_clients
      (client_id, client_name, redirect_uris, grant_types, response_types,
       token_endpoint_auth_method, created_at)
    VALUES ('client-one', 'Fictional client', '["http://127.0.0.1/callback"]',
      '["authorization_code"]', '["code"]', 'none', 1);
    INSERT INTO access_principals (id, name, kind, created_at, updated_at)
    VALUES ('principal-one', 'Fictional assistant', 'interactive', 1, 1);
    INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
    VALUES ('grant-one', 'principal-one', 'Reviewed answers', 1, 1);
    INSERT INTO access_grant_capabilities
      (grant_id, capability, source_mode, source_ids, privacy_policy)
    VALUES ('grant-one', 'answer', 'all', '[]', 'default');
    INSERT INTO principal_credentials
      (id, grant_id, oauth_client_id, kind, status, label, created_at)
    VALUES ('credential-one', 'grant-one', 'client-one', 'interactive', 'active',
      'Fictional workstation', 1);
    INSERT INTO oauth_access_tokens
      (id, credential_id, token_hash, audience, scope, grant_revision, created_at, expires_at)
    VALUES ('access-one', 'credential-one', 'access-hash', 'https://gateway.example/mcp',
      'omnesis:access', 1, 1, 1000);
    INSERT INTO oauth_authorization_requests
      (id, browser_handle_hash, user_code, client_id, client_name, redirect_uri, state,
       code_challenge, resource, scope, created_at, expires_at)
    VALUES ('request-one', 'browser-hash', 'ABCD2345', 'client-one', 'Fictional client',
      'http://127.0.0.1/callback', 'state-one', 'challenge-one',
      'https://gateway.example/mcp', 'omnesis:access', 1, 1000);
  `);
}
