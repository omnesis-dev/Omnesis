// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createV152AccessTables } from "./migration-152-access-grants.js";
import { migrateV154ConfidentialOAuthClients } from "./migration-154-confidential-oauth-clients.js";
import { MIGRATIONS, runMigrations } from "./migrations.js";

describe("migration 182: private_key_jwt OAuth clients", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY);
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        run_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (version, description, run_at, duration_ms)
      VALUES (181, 'existing v181 installation', 1, 1);
    `);
    createV152AccessTables(db);
    db.pragma("foreign_keys = OFF");
    migrateV154ConfidentialOAuthClients(db);
    db.pragma("foreign_keys = ON");
    db.pragma("user_version = 181");
    const insert = db.prepare(
      `INSERT INTO oauth_clients (
         client_id, client_name, redirect_uris, grant_types, response_types,
         token_endpoint_auth_method, client_secret_hash, client_uri, created_at
       ) VALUES (?, ?, '["https://client.example.com/callback"]',
                 '["authorization_code","refresh_token"]', '["code"]', ?, ?, NULL, 1)`,
    );
    insert.run("public-client", "Fictional public client", "none", null);
    insert.run("confidential-client", "Fictional confidential client", "client_secret_basic", "h");
    db.exec(`
      INSERT INTO devices (id) VALUES ('device-migration');
      INSERT INTO oauth_execution_bindings
        (id, binding_hash, device_id, oauth_client_id, harness, created_at, expires_at)
      VALUES ('binding-migration', 'binding-hash', 'device-migration', 'public-client',
              'openclaw', 1, 1000);
      INSERT INTO oauth_authorization_requests
        (id, browser_handle_hash, user_code, client_id, client_name, redirect_uri, state,
         code_challenge, resource, scope, created_at, expires_at)
      VALUES ('request-migration', 'browser-hash', 'ABCD2345', 'confidential-client',
              'Fictional confidential client', 'https://client.example.com/callback', '',
              'challenge', 'https://gateway.example.org/mcp', 'omnesis:access', 1, 1000);
    `);
  });

  afterEach(() => db.close());

  test("keeps every client and its dependants, and ties jwks_uri to private_key_jwt", () => {
    const migration = MIGRATIONS.find((item) => item.version === 182)!;
    runMigrations(db, { migrations: [migration] });

    expect(db.pragma("user_version", { simple: true })).toBe(182);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      db
        .prepare(
          `SELECT client_id, token_endpoint_auth_method, client_secret_hash, jwks_uri
           FROM oauth_clients ORDER BY client_id`,
        )
        .all(),
    ).toEqual([
      {
        client_id: "confidential-client",
        token_endpoint_auth_method: "client_secret_basic",
        client_secret_hash: "h",
        jwks_uri: null,
      },
      {
        client_id: "public-client",
        token_endpoint_auth_method: "none",
        client_secret_hash: null,
        jwks_uri: null,
      },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM oauth_execution_bindings").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM oauth_authorization_requests").get()).toEqual({
      count: 1,
    });

    const insert = db.prepare(
      `INSERT INTO oauth_clients (
         client_id, client_name, redirect_uris, grant_types, response_types,
         token_endpoint_auth_method, client_secret_hash, jwks_uri, client_uri, created_at
       ) VALUES (?, 'Fictional client', '[]', '[]', '[]', ?, ?, ?, NULL, 2)`,
    );
    const jwks = "https://client.example.com/jwks.json";
    expect(() => insert.run("key-client", "private_key_jwt", null, jwks)).not.toThrow();
    expect(() => insert.run("key-without-jwks", "private_key_jwt", null, null)).toThrow();
    expect(() => insert.run("key-with-secret", "private_key_jwt", "h", jwks)).toThrow();
    expect(() => insert.run("public-with-jwks", "none", null, jwks)).toThrow();
    expect(() => insert.run("secret-with-jwks", "client_secret_basic", "h", jwks)).toThrow();
    expect(() => insert.run("unknown-method", "client_secret_post", "h", null)).toThrow();

    const insertWithAlg = db.prepare(
      `INSERT INTO oauth_clients (
         client_id, client_name, redirect_uris, grant_types, response_types,
         token_endpoint_auth_method, client_secret_hash, jwks_uri,
         token_endpoint_auth_signing_alg, client_uri, created_at
       ) VALUES (?, 'Fictional client', '[]', '[]', '[]', ?, NULL, ?, ?, NULL, 2)`,
    );
    expect(() => insertWithAlg.run("pinned-key", "private_key_jwt", jwks, "ES256")).not.toThrow();
    expect(() => insertWithAlg.run("hmac-key", "private_key_jwt", jwks, "HS256")).toThrow();
    expect(() => insertWithAlg.run("public-with-alg", "none", null, "RS256")).toThrow();

    // Deleting a client still cascades to what references it.
    db.prepare("DELETE FROM oauth_clients WHERE client_id = 'public-client'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM oauth_execution_bindings").get()).toEqual({
      count: 0,
    });

    expect(() => migration.up(db)).not.toThrow();
  });
});
