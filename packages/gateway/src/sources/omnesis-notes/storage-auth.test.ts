// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, test } from "vitest";
import { MIGRATIONS } from "../../data/migrations.js";
import { runSchemaSetup } from "../../data/schema.js";
import { scopedNoteId } from "../../mcp/notes-server.js";
import { getNoteEntry, insertNoteEntry, type NoteEntry } from "./storage.js";

const NOW = Date.now();
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  seedActiveAuthority();
});
afterEach(() => db.close());
const entry: NoteEntry = {
  id: "note-1",
  day: "2026-07-14",
  text: "Fictional garden plan",
  capturedAt: "2026-07-14T12:00:00Z",
  updatedAt: "2026-07-14T12:00:00Z",
  receivedAt: "2026-07-14T12:00:01Z",
  capturedTimeZoneId: null,
  capturedUtcOffsetSeconds: null,
  surface: "mcp",
  deviceId: null,
  latitude: null,
  longitude: null,
  placeName: null,
  captureContext: {
    principalId: "principal-1",
    principalName: "Fictional principal",
    grantId: "grant-1",
    grantRevision: 1,
    credentialId: "credential-1",
    oauthClientId: "client-1",
    requestId: "request-1",
  },
};

test("commits note provenance and invocation audit together; retries preserve the first entry", () => {
  expect(insertNoteEntry(db, entry, activeAuditInput())).toBe(true);
  expect(getNoteEntry(db, entry.id)).toEqual(entry);
  expect(insertNoteEntry(db, { ...entry, text: "Changed retry" }, activeAuditInput())).toBe(false);
  expect(getNoteEntry(db, entry.id)).toEqual(entry);
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM access_audit_events WHERE event_type = 'mcp-tool-invoked'",
      )
      .get(),
  ).toEqual({ n: 2 });
});

test.each([
  "UPDATE access_grants SET revision = 2",
  "UPDATE oauth_access_tokens SET revoked_at = 1",
  "UPDATE access_principals SET revoked_at = 1",
  "DELETE FROM access_grant_capabilities",
])("rejects authority changed after request authentication: %s", (sql) => {
  db.exec(sql);
  expect(() => insertNoteEntry(db, entry, activeAuditInput())).toThrow("authorization");
  expect(getNoteEntry(db, entry.id)).toBeNull();
  expect(db.prepare("SELECT count(*) AS n FROM access_audit_events").get()).toEqual({ n: 0 });
});

test("rolls back a successful authorization audit when note insertion fails", () => {
  db.exec(
    "CREATE TRIGGER reject_note BEFORE INSERT ON note_entries BEGIN SELECT RAISE(ABORT, 'fictional storage failure'); END",
  );
  expect(() => insertNoteEntry(db, entry, activeAuditInput())).toThrow("fictional storage failure");
  expect(db.prepare("SELECT count(*) AS n FROM access_audit_events").get()).toEqual({ n: 0 });
});

test("isolates client retry IDs from other principals, credentials and native captures", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const scoped = scopedNoteId("principal-1", "credential-1", id);
  expect(scopedNoteId("principal-1", "credential-1", id)).toBe(scoped);
  expect(
    new Set([
      id,
      scoped,
      scopedNoteId("principal-2", "credential-1", id),
      scopedNoteId("principal-1", "credential-2", id),
    ]).size,
  ).toBe(4);
});

function seedActiveAuthority(): void {
  db.exec(`
    INSERT INTO access_principals (id, name, kind, created_at, updated_at)
    VALUES ('principal-1', 'Fictional principal', 'interactive', ${NOW - 10_000}, ${NOW - 10_000});
    INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
    VALUES ('grant-1', 'principal-1', 'Fictional grant', ${NOW - 10_000}, ${NOW - 10_000});
    INSERT INTO access_grant_capabilities
      (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
    VALUES ('grant-1', 'notes', 'all', '[]', NULL, NULL);
    INSERT INTO principal_credentials
      (id, grant_id, oauth_client_id, kind, status, label, created_at)
    VALUES ('credential-1', 'grant-1', 'client-1', 'interactive', 'active', 'Fictional client', ${NOW - 10_000});
    INSERT INTO oauth_access_tokens
      (id, credential_id, token_hash, audience, scope, grant_revision, created_at, expires_at)
    VALUES ('access-1', 'credential-1', 'fictional-hash', 'https://gateway.example/mcp',
      'omnesis:access', 1, ${NOW - 5_000}, ${NOW + 60_000});
  `);
}

function activeAuditInput() {
  return {
    accessTokenId: "access-1",
    principalId: "principal-1",
    grantId: "grant-1",
    grantRevision: 1,
    credentialId: "credential-1",
    oauthClientId: "client-1",
    capability: "notes" as const,
    tool: "add_note",
    outcome: "ok" as const,
    requestId: "request-1",
    sourceMode: "all" as const,
    requireActiveAuthority: true,
  };
}

test("migration 164 preserves legacy notes and can run repeatedly", () => {
  const legacy = new Database(":memory:");
  try {
    legacy.exec(
      "CREATE TABLE note_entries (id TEXT PRIMARY KEY, text TEXT NOT NULL); INSERT INTO note_entries VALUES ('old-note', 'Fictional legacy capture')",
    );
    const migration = MIGRATIONS.find((candidate) => candidate.version === 164)!;
    migration.up(legacy);
    migration.up(legacy);
    expect(legacy.prepare("SELECT * FROM note_entries").get()).toEqual({
      id: "old-note",
      text: "Fictional legacy capture",
      capture_context: null,
    });
  } finally {
    legacy.close();
  }
});
