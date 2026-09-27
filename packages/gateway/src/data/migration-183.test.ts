// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { addCredentialApprovedAudience } from "./migration-183-credential-approved-audience.js";

const RESOURCE = "https://gateway.example.org/mcp";

describe("migration 183: credentials keep their approved audience and scope", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE principal_credentials (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL
      );
      CREATE TABLE oauth_authorization_requests (
        id TEXT PRIMARY KEY,
        resource TEXT NOT NULL,
        scope TEXT NOT NULL,
        credential_id TEXT UNIQUE
      );
      CREATE TABLE oauth_refresh_tokens (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        audience TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE oauth_access_tokens (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        audience TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO principal_credentials (id, kind) VALUES
        ('with-request', 'interactive'),
        ('refresh-only', 'interactive'),
        ('access-only', 'interactive'),
        ('no-evidence', 'interactive'),
        ('service', 'service');
      INSERT INTO oauth_authorization_requests (id, resource, scope, credential_id)
        VALUES ('request-1', '${RESOURCE}', 'answer:read', 'with-request');
      -- Token rows for the same credential never outrank its request.
      INSERT INTO oauth_refresh_tokens (id, credential_id, audience, scope, created_at) VALUES
        ('r-0', 'with-request', 'https://other.example.org/mcp', 'other', 5),
        ('r-1', 'refresh-only', '${RESOURCE}', 'older', 1),
        ('r-2', 'refresh-only', '${RESOURCE}', 'answer:read notes:write', 2);
      INSERT INTO oauth_access_tokens (id, credential_id, audience, scope, created_at) VALUES
        ('a-1', 'access-only', '${RESOURCE}', 'answer:read', 3),
        ('a-2', 'service', '${RESOURCE}', 'answer:read', 3);
    `);
  });

  afterEach(() => db.close());

  function approved() {
    return db
      .prepare<
        [],
        { id: string; approved_audience: string | null; approved_scope: string | null }
      >("SELECT id, approved_audience, approved_scope FROM principal_credentials ORDER BY id")
      .all();
  }

  test("fills each interactive credential from its best surviving evidence", () => {
    addCredentialApprovedAudience(db);

    expect(approved()).toEqual([
      { id: "access-only", approved_audience: RESOURCE, approved_scope: "answer:read" },
      // Nothing left to prove what was approved: stays empty, so re-issue declines it.
      { id: "no-evidence", approved_audience: null, approved_scope: null },
      {
        id: "refresh-only",
        approved_audience: RESOURCE,
        approved_scope: "answer:read notes:write",
      },
      { id: "service", approved_audience: null, approved_scope: null },
      { id: "with-request", approved_audience: RESOURCE, approved_scope: "answer:read" },
    ]);
  });

  test("is idempotent and never overwrites a recorded approval", () => {
    addCredentialApprovedAudience(db);
    db.prepare("DELETE FROM oauth_authorization_requests").run();
    expect(() => addCredentialApprovedAudience(db)).not.toThrow();
    expect(approved().find((row) => row.id === "with-request")).toEqual({
      id: "with-request",
      approved_audience: RESOURCE,
      approved_scope: "answer:read",
    });
  });

  test("does nothing on a database without the access tables", () => {
    const empty = new Database(":memory:");
    try {
      expect(() => addCredentialApprovedAudience(empty)).not.toThrow();
    } finally {
      empty.close();
    }
  });
});
