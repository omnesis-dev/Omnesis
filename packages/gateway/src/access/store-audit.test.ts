// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";

import { runSchemaSetup } from "../data/schema.js";
import { listAccessAuditEvents, recordMcpToolInvocationAudit } from "./store.js";
import { appendAudit } from "./store-helpers.js";
import type { Db } from "../data/types.js";

const NOW = 1_800_000_000_000;

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
});

describe("MCP invocation access audit", () => {
  test("records only bounded non-corpus invocation metadata", () => {
    recordMcpToolInvocationAudit(
      db,
      {
        accessTokenId: "55555555-5555-4555-8555-555555555555",
        principalId: "11111111-1111-4111-8111-111111111111",
        grantId: "22222222-2222-4222-8222-222222222222",
        grantRevision: 3,
        credentialId: "33333333-3333-4333-8333-333333333333",
        oauthClientId: "omn_oc_fictional",
        capability: "direct",
        tool: "run_sql",
        outcome: "ok",
        requestId: "44444444-4444-4444-8444-444444444444",
        sourceMode: "all",
        requireActiveAuthority: false,
      },
      NOW,
    );

    const row = db.prepare("SELECT * FROM access_audit_events").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      occurred_at: NOW,
      event_type: "mcp-tool-invoked",
      principal_id: "11111111-1111-4111-8111-111111111111",
      grant_id: "22222222-2222-4222-8222-222222222222",
      grant_revision: 3,
      credential_id: "33333333-3333-4333-8333-333333333333",
      oauth_client_id: "omn_oc_fictional",
      actor_token_id: "55555555-5555-4555-8555-555555555555",
    });
    expect(JSON.parse(row.detail as string)).toEqual({
      capability: "direct",
      tool: "run_sql",
      outcome: "ok",
      requestId: "44444444-4444-4444-8444-444444444444",
      sourceMode: "all",
    });
  });

  test("hashes unsafe or oversized tool and request identifiers", () => {
    const unsafeTool = "tool name with arbitrary text";
    const oversizedRequestId = "r".repeat(500);
    recordMcpToolInvocationAudit(
      db,
      {
        accessTokenId: "55555555-5555-4555-8555-555555555555",
        principalId: "11111111-1111-4111-8111-111111111111",
        grantId: "22222222-2222-4222-8222-222222222222",
        grantRevision: 1,
        credentialId: "33333333-3333-4333-8333-333333333333",
        oauthClientId: "omn_oc_fictional",
        capability: "answer",
        tool: unsafeTool,
        outcome: "refused",
        requestId: oversizedRequestId,
        sourceMode: "all",
        requireActiveAuthority: false,
      },
      NOW,
    );

    const row = db.prepare("SELECT detail FROM access_audit_events").get() as { detail: string };
    const detail = JSON.parse(row.detail) as Record<string, string>;
    expect(detail.tool).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(detail.requestId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(row.detail).not.toContain(unsafeTool);
    expect(row.detail).not.toContain(oversizedRequestId);
  });

  test("atomically fences a successful result against current token authority", () => {
    seedActiveAuthority();
    expect(recordMcpToolInvocationAudit(db, activeAuditInput(), NOW)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_audit_events").get()).toEqual({
      count: 1,
    });
  });

  test.each([
    [
      "access token revoked",
      "UPDATE oauth_access_tokens SET revoked_at = ? WHERE id = 'access-1'",
      NOW,
    ],
    [
      "access token expired",
      "UPDATE oauth_access_tokens SET expires_at = ? WHERE id = 'access-1'",
      NOW,
    ],
    [
      "token revision stale",
      "UPDATE oauth_access_tokens SET grant_revision = 2 WHERE id = 'access-1'",
      null,
    ],
    [
      "credential revoked",
      "UPDATE principal_credentials SET revoked_at = ? WHERE id = 'credential-1'",
      NOW,
    ],
    [
      "credential expired",
      "UPDATE principal_credentials SET expires_at = ? WHERE id = 'credential-1'",
      NOW,
    ],
    ["grant revoked", "UPDATE access_grants SET revoked_at = ? WHERE id = 'grant-1'", NOW],
    ["grant expired", "UPDATE access_grants SET expires_at = ? WHERE id = 'grant-1'", NOW],
    ["grant revision changed", "UPDATE access_grants SET revision = 2 WHERE id = 'grant-1'", null],
    [
      "principal revoked",
      "UPDATE access_principals SET revoked_at = ? WHERE id = 'principal-1'",
      NOW,
    ],
    [
      "capability removed",
      "DELETE FROM access_grant_capabilities WHERE grant_id = 'grant-1'",
      null,
    ],
  ])("rejects egress when the %s", (_label, sql, value) => {
    seedActiveAuthority();
    if (value === null) db.prepare(sql).run();
    else db.prepare(sql).run(value);

    expect(recordMcpToolInvocationAudit(db, activeAuditInput(), NOW)).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_audit_events").get()).toEqual({
      count: 0,
    });
  });
});

function seedActiveAuthority(): void {
  db.exec(`
    INSERT INTO access_principals (id, name, kind, created_at, updated_at)
    VALUES ('principal-1', 'Fictional principal', 'interactive', ${NOW - 10_000}, ${NOW - 10_000});
    INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
    VALUES ('grant-1', 'principal-1', 'Fictional grant', ${NOW - 10_000}, ${NOW - 10_000});
    INSERT INTO access_grant_capabilities
      (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
    VALUES ('grant-1', 'direct', 'all', '[]', NULL, NULL);
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
    capability: "direct" as const,
    tool: "run_sql",
    outcome: "ok" as const,
    requestId: "request-1",
    sourceMode: "all" as const,
    requireActiveAuthority: true,
  };
}

describe("listAccessAuditEvents", () => {
  test("pages newest first over (occurred_at, id) with one probe row past the limit", () => {
    for (let index = 0; index < 4; index += 1) {
      appendAudit(db, { eventType: "grant-updated", principalId: "p", now: NOW + index });
    }
    // Two events in the same millisecond order by id within it.
    appendAudit(db, { eventType: "grant-updated", principalId: "p", now: NOW + 1 });
    const first = listAccessAuditEvents(db, { limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.items.map((event) => event.occurredAt)).toEqual([NOW + 3, NOW + 2]);
    const boundary = first.items[1]!;
    const second = listAccessAuditEvents(db, {
      limit: 2,
      after: { occurredAt: boundary.occurredAt, id: boundary.id },
    });
    expect(second.items.map((event) => event.occurredAt)).toEqual([NOW + 1, NOW + 1]);
    expect(second.items[0]!.id > second.items[1]!.id).toBe(true);
    const last = second.items[1]!;
    const third = listAccessAuditEvents(db, {
      limit: 2,
      after: { occurredAt: last.occurredAt, id: last.id },
    });
    expect(third).toMatchObject({ hasMore: false });
    expect(third.items.map((event) => event.occurredAt)).toEqual([NOW]);
  });

  test("filters by principal and grant and parses detail as an object", () => {
    appendAudit(db, {
      eventType: "a",
      principalId: "p1",
      grantId: "g1",
      detail: { k: 1 },
      now: NOW,
    });
    appendAudit(db, { eventType: "b", principalId: "p2", grantId: "g1", now: NOW + 1 });
    expect(listAccessAuditEvents(db, { limit: 10, principalId: "p1" }).items).toEqual([
      expect.objectContaining({ eventType: "a", detail: { k: 1 } }),
    ]);
    expect(
      listAccessAuditEvents(db, { limit: 10, grantId: "g1" }).items.map((e) => e.eventType),
    ).toEqual(["b", "a"]);
    expect(
      listAccessAuditEvents(db, { limit: 10, principalId: "p2", grantId: "g2" }).items,
    ).toEqual([]);
  });
});
