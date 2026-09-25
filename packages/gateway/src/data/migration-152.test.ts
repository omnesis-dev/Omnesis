// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { MIGRATIONS, runMigrations } from "./migrations.js";

const ACCESS_TABLES = [
  "access_audit_events",
  "access_grant_capabilities",
  "access_grants",
  "access_principals",
  "agent_pairing_redemption_receipts",
  "oauth_access_tokens",
  "oauth_authorization_requests",
  "oauth_clients",
  "oauth_execution_bindings",
  "oauth_refresh_tokens",
  "principal_credentials",
];

const ACCESS_INDEXES = [
  "idx_access_audit_events_occurred",
  "idx_access_audit_events_principal",
  "idx_access_audit_events_retention",
  "idx_access_grants_principal",
  "idx_agent_pairing_redemption_receipts_expiry",
  "idx_oauth_access_tokens_credential",
  "idx_oauth_access_tokens_expiry",
  "idx_oauth_authorization_requests_client",
  "idx_oauth_authorization_requests_code_expiry",
  "idx_oauth_authorization_requests_expiry",
  "idx_oauth_authorization_requests_user_code",
  "idx_oauth_clients_created",
  "idx_oauth_execution_bindings_client",
  "idx_oauth_execution_bindings_expiry",
  "idx_oauth_refresh_tokens_credential",
  "idx_oauth_refresh_tokens_expiry",
  "idx_principal_credentials_grant",
  "idx_principal_credentials_oauth_client",
  "idx_principal_credentials_service_client",
];

describe("migration 152: external MCP access identity plane", () => {
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
      INSERT INTO devices (id, name, kind, capabilities)
      VALUES ('device-existing', 'Existing device', 'collector', '{}');
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
    `);
  });

  afterEach(() => db.close());

  test("upgrades v151, creates the complete schema, and preserves existing rows", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 152)!;
    runMigrations(db, { migrations: [migration] });

    expect(db.pragma("user_version", { simple: true })).toBe(152);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (" +
            ACCESS_TABLES.map(() => "?").join(", ") +
            ") ORDER BY name",
        )
        .all(...ACCESS_TABLES)
        .map((row) => (row as { name: string }).name),
    ).toEqual(ACCESS_TABLES);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (" +
            ACCESS_INDEXES.map(() => "?").join(", ") +
            ") ORDER BY name",
        )
        .all(...ACCESS_INDEXES)
        .map((row) => (row as { name: string }).name),
    ).toEqual(ACCESS_INDEXES);
    expect(db.prepare("SELECT id, name FROM devices").all()).toEqual([
      { id: "device-existing", name: "Existing device" },
    ]);
    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 151 },
      { version: 152 },
    ]);
  });

  test("preserves an integration pairing while removing its legacy Answer device authority", () => {
    db.exec(`
      INSERT INTO devices (id, name, kind, capabilities)
      VALUES (
        'device-agent', 'Fictional OpenClaw host', 'agent',
        '{"agentIntegration":{"harness":"openclaw"}}'
      );
      INSERT INTO tokens (id, device_id, scopes)
      VALUES
        ('legacy-agent', 'device-agent', '["answer","subscriptions:manage"]'),
        ('delivery', 'device-agent', '["subscriptions:receive"]');
    `);
    const migration = MIGRATIONS.find((candidate) => candidate.version === 152)!;
    runMigrations(db, { migrations: [migration] });

    expect(db.prepare("SELECT id, scopes FROM tokens ORDER BY id").all()).toEqual([
      { id: "delivery", scopes: '["subscriptions:receive"]' },
      { id: "legacy-agent", scopes: '["subscriptions:manage"]' },
    ]);
  });

  test("removes the retired answer-completion authority plane", () => {
    db.exec(`
      INSERT INTO devices (id, name, kind, capabilities)
      VALUES ('device-completion', 'Fictional completion host', 'agent', '{}');
      INSERT INTO tokens (id, device_id, scopes)
      VALUES ('completion-token', 'device-completion', '["answer:completion"]');
      CREATE TABLE answer_completion_authorities (
        id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE
      );
      INSERT INTO answer_completion_authorities (id, token_id)
      VALUES ('completion-authority', 'completion-token');
    `);
    const migration = MIGRATIONS.find((candidate) => candidate.version === 152)!;
    runMigrations(db, { migrations: [migration] });

    expect(db.prepare("SELECT id FROM tokens WHERE id = 'completion-token'").get()).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'answer_completion_authorities'",
        )
        .get(),
    ).toBeUndefined();
  });

  test("installs and enforces every access-schema foreign key", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 152)!;
    runMigrations(db, { migrations: [migration] });

    const foreignKeys = ACCESS_TABLES.flatMap((table) =>
      db
        .prepare(`PRAGMA foreign_key_list(${table})`)
        .all()
        .map((row) => {
          const fk = row as { table: string; from: string; to: string; on_delete: string };
          return `${table}.${fk.from}->${fk.table}.${fk.to}:${fk.on_delete}`;
        }),
    ).sort();
    expect(foreignKeys).toEqual([
      "access_grant_capabilities.grant_id->access_grants.id:CASCADE",
      "access_grants.principal_id->access_principals.id:CASCADE",
      "oauth_access_tokens.credential_id->principal_credentials.id:CASCADE",
      "oauth_authorization_requests.client_id->oauth_clients.client_id:CASCADE",
      "oauth_authorization_requests.created_grant_id->access_grants.id:SET NULL",
      "oauth_authorization_requests.created_principal_id->access_principals.id:SET NULL",
      "oauth_authorization_requests.credential_id->principal_credentials.id:SET NULL",
      "oauth_authorization_requests.execution_device_id->devices.id:CASCADE",
      "oauth_execution_bindings.device_id->devices.id:CASCADE",
      "oauth_execution_bindings.oauth_client_id->oauth_clients.client_id:CASCADE",
      "oauth_refresh_tokens.credential_id->principal_credentials.id:CASCADE",
      "principal_credentials.execution_device_id->devices.id:CASCADE",
      "principal_credentials.grant_id->access_grants.id:CASCADE",
    ]);

    expect(() =>
      db
        .prepare(
          `INSERT INTO access_grants
             (id, principal_id, name, created_at, updated_at)
           VALUES ('grant-orphan', 'principal-missing', 'Orphan', 1, 1)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint/i);

    db.exec(`
      INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris, grant_types, response_types,
         token_endpoint_auth_method, created_at)
      VALUES (
        'client-one', 'Fictional client', '["http://127.0.0.1/callback"]',
        '["authorization_code"]', '["code"]', 'none', 1
      );
      INSERT INTO access_principals (id, name, kind, created_at, updated_at)
      VALUES ('principal-one', 'Fictional assistant', 'interactive', 1, 1);
      INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
      VALUES ('grant-one', 'principal-one', 'Direct access', 1, 1);
      INSERT INTO access_grant_capabilities
        (grant_id, capability, source_mode, source_ids, privacy_policy)
      VALUES ('grant-one', 'direct', 'all', '[]', NULL);
      INSERT INTO principal_credentials
        (id, grant_id, oauth_client_id, kind, label, execution_device_id, created_at)
      VALUES (
        'credential-one', 'grant-one', 'client-one', 'interactive',
        'Fictional workstation', 'device-existing', 1
      );
      INSERT INTO oauth_access_tokens
        (id, credential_id, token_hash, audience, scope, grant_revision, created_at, expires_at)
      VALUES (
        'access-token-one', 'credential-one', 'access-hash-one',
        'https://gateway.example.org/mcp', 'omnesis:access', 1, 1, 100
      );
      INSERT INTO oauth_refresh_tokens
        (id, credential_id, family_id, generation, token_hash, audience, scope, created_at, expires_at)
      VALUES (
        'refresh-token-one', 'credential-one', 'family-one', 0, 'refresh-hash-one',
        'https://gateway.example.org/mcp', 'omnesis:access offline_access', 1, 100
      );
      INSERT INTO oauth_authorization_requests
        (id, browser_handle_hash, user_code, client_id, client_name, redirect_uri,
         state, code_challenge, resource, scope, created_at, expires_at, execution_device_id)
      VALUES (
        'request-one', 'browser-hash-one', 'ABCD2345', 'client-one', 'Fictional client',
        'http://127.0.0.1/callback', 'state-one', 'challenge-one',
        'https://gateway.example.org/mcp', 'omnesis:access', 1, 100, 'device-existing'
      );
    `);

    db.prepare("DELETE FROM devices WHERE id = ?").run("device-existing");
    for (const table of [
      "principal_credentials",
      "oauth_access_tokens",
      "oauth_refresh_tokens",
      "oauth_authorization_requests",
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }

    db.prepare("DELETE FROM access_principals WHERE id = ?").run("principal-one");
    for (const table of ["access_grants", "access_grant_capabilities"]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  test("is a no-op when the upgraded database opens again", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 152)!;
    runMigrations(db, { migrations: [migration] });
    db.prepare(
      `INSERT INTO access_principals (id, name, kind, created_at, updated_at)
       VALUES ('principal-existing', 'Existing fictional principal', 'interactive', 1, 1)`,
    ).run();
    const migrationCount = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
      count: number;
    };

    // Replay the migration body directly to prove its DDL/transform is idempotent.
    migration.up(db);

    expect(db.pragma("user_version", { simple: true })).toBe(152);
    expect(db.prepare("SELECT id, name FROM access_principals").all()).toEqual([
      { id: "principal-existing", name: "Existing fictional principal" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual(
      migrationCount,
    );
  });
});
