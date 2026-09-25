// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createAccessTables } from "../access/store-schema.js";
import { createV152AccessTables } from "./migration-152-access-grants.js";
import { MIGRATIONS, runMigrations } from "./migrations.js";

describe("migration 154: confidential OAuth clients", () => {
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
      VALUES (153, 'existing v153 installation', 1, 1);
      PRAGMA user_version = 153;
    `);
    createV152AccessTables(db);
    db.prepare(
      `INSERT INTO oauth_clients (
         client_id, client_name, redirect_uris, grant_types, response_types,
         token_endpoint_auth_method, client_uri, created_at
       ) VALUES (?, ?, ?, ?, ?, 'none', ?, ?)`,
    ).run(
      "public-client",
      "Fictional public client",
      '["http://127.0.0.1:48123/callback"]',
      '["authorization_code","refresh_token"]',
      '["code"]',
      "https://example.com/client",
      1,
    );
  });

  afterEach(() => db.close());

  test("preserves public clients and enforces confidential-client secret storage", () => {
    db.exec(`
      INSERT INTO devices (id) VALUES ('device-migration');
      INSERT INTO oauth_execution_bindings
        (id, binding_hash, device_id, oauth_client_id, harness, created_at, expires_at)
      VALUES ('binding-migration', 'binding-hash', 'device-migration', 'public-client',
              'openclaw', 1, 1000);
      INSERT INTO oauth_authorization_requests
        (id, browser_handle_hash, user_code, client_id, client_name, redirect_uri, state,
         code_challenge, resource, scope, created_at, expires_at)
      VALUES ('request-migration', 'browser-hash', 'ABCD2345', 'public-client',
              'Fictional public client', 'http://127.0.0.1:48123/callback', '',
              'challenge', 'https://gateway.example.org/mcp', 'omnesis:access', 1, 1000);
    `);

    // The live-schema setup runs before numbered migrations. It must not run
    // the v154 table rebuild while foreign keys are enabled.
    createAccessTables(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM oauth_execution_bindings").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM oauth_authorization_requests").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('oauth_clients')")
        .all()
        .some((column) => column.name === "client_secret_hash"),
    ).toBe(false);

    const migration = MIGRATIONS.find((item) => item.version === 154)!;
    runMigrations(db, { migrations: [migration] });

    expect(db.pragma("user_version", { simple: true })).toBe(154);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      db
        .prepare(
          `SELECT client_id, token_endpoint_auth_method, client_secret_hash
           FROM oauth_clients WHERE client_id = 'public-client'`,
        )
        .get(),
    ).toEqual({
      client_id: "public-client",
      token_endpoint_auth_method: "none",
      client_secret_hash: null,
    });

    const insert = db.prepare(
      `INSERT INTO oauth_clients (
         client_id, client_name, redirect_uris, grant_types, response_types,
         token_endpoint_auth_method, client_secret_hash, client_uri, created_at
       ) VALUES (?, 'Fictional client', '[]', '[]', '[]', ?, ?, NULL, 2)`,
    );
    expect(() =>
      insert.run("confidential-client", "client_secret_basic", "scrypt:hash"),
    ).not.toThrow();
    expect(() => insert.run("missing-secret", "client_secret_basic", null)).toThrow();
    expect(() => insert.run("public-with-secret", "none", "scrypt:hash")).toThrow();

    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM oauth_execution_bindings").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM oauth_authorization_requests").get()).toEqual({
      count: 1,
    });
    expect(() => migration.up(db)).not.toThrow();
  });
});
