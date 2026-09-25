// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";

import { DeviceId } from "@omnesis/types";
import { revokeDevice } from "../data/repositories/DeviceRepository.js";
import { runSchemaSetup } from "../data/schema.js";
import {
  createAuthorizationRequest,
  decideAuthorizationRequest,
  lookupPrincipalAccessToken,
  registerOAuthClient,
  renameAccessPrincipal,
  revokeAccessGrant,
  revokeAccessPrincipal,
  revokeOAuthToken,
  revokePrincipalCredential,
  touchPrincipalCredentialUsageBatch,
} from "./store.js";
import {
  authorizeInteractiveAccess,
  TEST_OAUTH_REDIRECT,
  TEST_OAUTH_VERIFIER,
} from "./test-utils.js";
import { MCP_ACCESS_SCOPE } from "./types.js";
import type { Db } from "../data/types.js";

const NOW = 1_800_000_000_000;
const RESOURCE = "https://gateway.example.org/mcp";
let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
});

describe("access identity lifecycle", () => {
  test.each(["credential", "grant", "principal"] as const)(
    "%s revocation fences authority without rewriting descendant token rows",
    (kind) => {
      seedIdentity();
      const before = rawTokenState();
      const revoked =
        kind === "credential"
          ? revokePrincipalCredential(db, "credential-1", "portal-token", NOW)
          : kind === "grant"
            ? revokeAccessGrant(db, "grant-1", "portal-token", NOW)
            : revokeAccessPrincipal(db, "principal-1", "portal-token", NOW);

      expect(revoked).toBe(true);
      expect(rawTokenState()).toEqual(before);
      expect(lookupPrincipalAccessToken(db, "raw-access-token", RESOURCE, NOW + 1)).toBeNull();
    },
  );

  test("device revocation fences a device-bound credential's tokens the same way", () => {
    const DEVICE = "00000000-0000-4000-8000-00000000d001";
    const client = publicClient();
    const authorized = authorizeInteractiveAccess(db, {
      clientId: client.clientId,
      clientSecret: client.clientSecret ?? undefined,
      selection: {
        kind: "new-principal",
        principalName: "Fictional runtime agent",
        grantName: "Direct access",
        rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
        credentialLabel: "Fictional runtime",
        expiresAt: null,
      },
      resource: RESOURCE,
      scope: MCP_ACCESS_SCOPE,
      now: NOW,
    });
    const token = authorized.tokens.accessToken;
    // The credential executes on a paired device, as an agent integration's does.
    db.exec(`
      INSERT INTO devices (id, name, kind, paired_at)
      VALUES ('${DEVICE}', 'Fictional runtime', 'agent', ${NOW - 10_000});
    `);
    db.prepare(
      `UPDATE principal_credentials SET execution_device_id = '${DEVICE}'
        WHERE id = (SELECT credential_id FROM oauth_access_tokens WHERE token_hash = ?)`,
    ).run(createHash("sha256").update(token).digest("hex"));
    expect(lookupPrincipalAccessToken(db, token, RESOURCE, NOW + 1)).not.toBeNull();
    const before = rawTokenState();

    expect(revokeDevice(db, DeviceId(DEVICE))).toBe(true);
    // The token rows are untouched; the join no longer admits them.
    expect(rawTokenState()).toEqual(before);
    expect(lookupPrincipalAccessToken(db, token, RESOURCE, NOW + 1)).toBeNull();
  });

  test("a revoked device alone, with its credential left untouched, still refuses the token", () => {
    // The device clause of the shared predicate is what decides here: no
    // cascade has marked the credential.
    const DEVICE = "00000000-0000-4000-8000-00000000d002";
    const client = publicClient();
    const token = authorizeInteractiveAccess(db, {
      clientId: client.clientId,
      clientSecret: client.clientSecret ?? undefined,
      selection: {
        kind: "new-principal",
        principalName: "Fictional laptop agent",
        grantName: "Direct access",
        rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
        credentialLabel: "Fictional laptop",
        expiresAt: null,
      },
      resource: RESOURCE,
      scope: MCP_ACCESS_SCOPE,
      now: NOW,
    }).tokens.accessToken;
    db.exec(`
      INSERT INTO devices (id, name, kind, paired_at)
      VALUES ('${DEVICE}', 'Fictional laptop', 'agent', ${NOW - 10_000});
    `);
    db.prepare(
      `UPDATE principal_credentials SET execution_device_id = ?
        WHERE id = (SELECT credential_id FROM oauth_access_tokens WHERE token_hash = ?)`,
    ).run(DEVICE, createHash("sha256").update(token).digest("hex"));
    expect(lookupPrincipalAccessToken(db, token, RESOURCE, NOW + 1)).not.toBeNull();

    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(NOW, DEVICE);
    expect(
      db
        .prepare<[string], { revoked_at: number | null }>(
          `SELECT revoked_at FROM principal_credentials
            WHERE id = (SELECT credential_id FROM oauth_access_tokens WHERE token_hash = ?)`,
        )
        .get(createHash("sha256").update(token).digest("hex")),
    ).toEqual({ revoked_at: null });
    expect(lookupPrincipalAccessToken(db, token, RESOURCE, NOW + 1)).toBeNull();
  });

  test.each(["credential", "grant", "principal"] as const)(
    "a buffered observation cannot stamp an inactive %s chain",
    (kind) => {
      seedIdentity();
      const observedAt = NOW - 1_000;
      if (kind === "credential") revokePrincipalCredential(db, "credential-1", "portal-token", NOW);
      else if (kind === "grant") revokeAccessGrant(db, "grant-1", "portal-token", NOW);
      else revokeAccessPrincipal(db, "principal-1", "portal-token", NOW);

      touchPrincipalCredentialUsageBatch(
        db,
        [{ credentialId: "credential-1", observedAt }],
        NOW + 1,
      );
      expect(
        db
          .prepare("SELECT last_used_at FROM principal_credentials WHERE id = 'credential-1'")
          .get(),
      ).toEqual({ last_used_at: null });
    },
  );

  test("stores the authentication observation time rather than the later flush time", () => {
    seedIdentity();
    touchPrincipalCredentialUsageBatch(
      db,
      [{ credentialId: "credential-1", observedAt: NOW - 2_000 }],
      NOW,
    );
    expect(
      db.prepare("SELECT last_used_at FROM principal_credentials WHERE id = 'credential-1'").get(),
    ).toEqual({ last_used_at: NOW - 2_000 });
  });

  test("rejects an empty allowlist at the store boundary", () => {
    const client = publicClient();
    const pending = createAuthorizationRequest(
      db,
      {
        clientId: client.clientId,
        redirectUri: TEST_OAUTH_REDIRECT,
        state: "state-empty-allowlist",
        codeChallenge: createHash("sha256").update(TEST_OAUTH_VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: MCP_ACCESS_SCOPE,
      },
      NOW,
    );
    if (!pending.ok) throw new Error(pending.error);

    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: pending.value.id,
          decision: "approve",
          selection: {
            kind: "new-principal",
            principalName: "Fictional scoped agent",
            grantName: "Empty source boundary",
            rules: [{ capability: "direct", sources: { mode: "allowlist", sourceIds: [] } }],
            credentialLabel: "Fictional workstation",
            expiresAt: null,
          },
          actorTokenId: "portal-token",
        },
        NOW + 1,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_principals").get()).toEqual({
      count: 0,
    });
  });

  test("normalizes an empty denylist to all-source access", () => {
    const authorized = authorizeInteractiveAccess(db, {
      clientId: publicClient().clientId,
      selection: {
        kind: "new-principal",
        principalName: "Fictional scoped agent",
        grantName: "Explicit empty source boundary",
        rules: [{ capability: "direct", sources: { mode: "denylist", sourceIds: [] } }],
        credentialLabel: "Fictional workstation",
        expiresAt: null,
      },
      resource: RESOURCE,
      scope: MCP_ACCESS_SCOPE,
      now: NOW,
    });

    expect(
      lookupPrincipalAccessToken(db, authorized.tokens.accessToken, RESOURCE, NOW + 13),
    ).toMatchObject({
      capabilities: [{ capability: "direct", sourceMode: "all", sourceIds: [] }],
    });
  });

  test("a confidential client revokes its own token only with its registered secret", () => {
    const client = registerOAuthClient(
      db,
      {
        clientName: "Stellar MCP Client",
        redirectUris: [TEST_OAUTH_REDIRECT],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "client_secret_basic",
        clientUri: "https://example.com/client",
      },
      NOW,
    );
    if (!client.clientSecret) throw new Error("a confidential client registers with a secret");
    const authorized = authorizeInteractiveAccess(db, {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      selection: {
        kind: "new-principal",
        principalName: "Fictional scoped agent",
        grantName: "Direct access",
        rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
        credentialLabel: "Fictional workstation",
        expiresAt: null,
      },
      resource: RESOURCE,
      scope: MCP_ACCESS_SCOPE,
      now: NOW,
    });
    const token = authorized.tokens.accessToken;
    const before = rawTokenState();

    expect(revokeOAuthToken(db, token, client.clientId, "invented-wrong-secret", NOW + 20)).toBe(
      false,
    );
    expect(revokeOAuthToken(db, token, client.clientId, undefined, NOW + 20)).toBe(false);
    expect(lookupPrincipalAccessToken(db, token, RESOURCE, NOW + 21)).not.toBeNull();
    expect(revokedEvents()).toEqual([]);

    expect(revokeOAuthToken(db, token, client.clientId, client.clientSecret, NOW + 22)).toBe(true);
    expect(lookupPrincipalAccessToken(db, token, RESOURCE, NOW + 23)).toBeNull();
    // Revocation fences the credential; the token rows themselves are untouched.
    expect(rawTokenState()).toEqual(before);
    expect(
      db
        .prepare("SELECT revoked_at FROM principal_credentials WHERE id = ?")
        .get(authorized.credentialId),
    ).toEqual({ revoked_at: NOW + 22 });
    expect(revokedEvents()).toEqual([
      {
        occurred_at: NOW + 22,
        principal_id: authorized.principalId,
        grant_id: authorized.grantId,
        grant_revision: 1,
        credential_id: authorized.credentialId,
        oauth_client_id: client.clientId,
      },
    ]);
  });

  test("forgetting an execution device removes its pending and issued principal authority", () => {
    seedIdentity();
    db.exec(`
      INSERT INTO devices (id, name, kind, capabilities, paired_at)
      VALUES ('device-1', 'Fictional agent runtime', 'agent', '{}', ${NOW});
      UPDATE principal_credentials
      SET execution_device_id = 'device-1'
      WHERE id = 'credential-1';
      INSERT INTO oauth_clients
        (client_id, client_name, redirect_uris, grant_types, response_types,
         token_endpoint_auth_method, created_at)
      VALUES (
        'client-1', 'Fictional client', '["http://127.0.0.1/callback"]',
        '["authorization_code","refresh_token"]', '["code"]', 'none', ${NOW}
      );
      INSERT INTO oauth_authorization_requests
        (id, browser_handle_hash, user_code, client_id, client_name, redirect_uri,
         state, code_challenge, resource, scope, created_at, expires_at, execution_device_id)
      VALUES (
        'request-1', 'browser-hash', 'ABCD2345', 'client-1', 'Fictional client',
        'http://127.0.0.1/callback', 'state-1', 'challenge-1', '${RESOURCE}',
        'omnesis:access', ${NOW}, ${NOW + 60_000}, 'device-1'
      );
      DELETE FROM devices WHERE id = 'device-1';
    `);

    for (const table of [
      "principal_credentials",
      "oauth_access_tokens",
      "oauth_refresh_tokens",
      "oauth_authorization_requests",
    ]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_principals").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_grants").get()).toEqual({ count: 1 });
  });
});

describe("renaming an identity", () => {
  const auditRows = () =>
    db
      .prepare<
        [],
        {
          event_type: string;
          principal_id: string | null;
          actor_token_id: string | null;
          detail: string;
        }
      >(
        `SELECT event_type, principal_id, actor_token_id, detail FROM access_audit_events
         WHERE event_type = 'principal-renamed'`,
      )
      .all();

  test("renames a live identity, leaving everything under it in place", () => {
    seedIdentity();
    const before = rawTokenState();

    const renamed = renameAccessPrincipal(
      db,
      {
        principalId: "principal-1",
        name: "  Fictional principal (laptop)  ",
        actorTokenId: "portal-token",
      },
      NOW,
    );

    expect(renamed).toEqual({
      ok: true,
      value: {
        id: "principal-1",
        name: "Fictional principal (laptop)",
        kind: "interactive",
        createdAt: NOW - 10_000,
        updatedAt: NOW,
        revokedAt: null,
      },
    });
    expect(
      db.prepare("SELECT name, updated_at FROM access_principals WHERE id = 'principal-1'").get(),
    ).toEqual({ name: "Fictional principal (laptop)", updated_at: NOW });
    // The name is a label: the grant, the credential and the tokens under
    // them are the rows they were.
    expect(rawTokenState()).toEqual(before);
    expect(db.prepare("SELECT id, principal_id, updated_at FROM access_grants").all()).toEqual([
      { id: "grant-1", principal_id: "principal-1", updated_at: NOW - 10_000 },
    ]);
    expect(db.prepare("SELECT id, grant_id, revoked_at FROM principal_credentials").all()).toEqual([
      { id: "credential-1", grant_id: "grant-1", revoked_at: null },
    ]);
    expect(auditRows()).toEqual([
      {
        event_type: "principal-renamed",
        principal_id: "principal-1",
        actor_token_id: "portal-token",
        detail: JSON.stringify({
          previousName: "Fictional principal",
          name: "Fictional principal (laptop)",
        }),
      },
    ]);
  });

  test("the name it already has is not a change, and leaves no audit row", () => {
    seedIdentity();
    const renamed = renameAccessPrincipal(
      db,
      { principalId: "principal-1", name: "Fictional principal ", actorTokenId: "portal-token" },
      NOW,
    );
    expect(renamed).toMatchObject({
      ok: true,
      value: { name: "Fictional principal", updatedAt: NOW - 10_000 },
    });
    expect(auditRows()).toEqual([]);
  });

  test("an unknown or revoked identity is not there to rename", () => {
    seedIdentity();
    expect(
      renameAccessPrincipal(
        db,
        { principalId: "principal-9", name: "Ghost", actorTokenId: "portal-token" },
        NOW,
      ),
    ).toEqual({ ok: false, error: "not-found" });
    revokeAccessPrincipal(db, "principal-1", "portal-token", NOW);
    expect(
      renameAccessPrincipal(
        db,
        { principalId: "principal-1", name: "Late", actorTokenId: "portal-token" },
        NOW + 1,
      ),
    ).toEqual({ ok: false, error: "not-found" });
    expect(db.prepare("SELECT name FROM access_principals WHERE id = 'principal-1'").get()).toEqual(
      { name: "Fictional principal" },
    );
    expect(auditRows()).toEqual([]);
  });
});

function seedIdentity(): void {
  const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
  db.exec(`
    INSERT INTO access_principals (id, name, kind, created_at, updated_at)
    VALUES ('principal-1', 'Fictional principal', 'interactive', ${NOW - 10_000}, ${NOW - 10_000});
    INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
    VALUES ('grant-1', 'principal-1', 'Privacy-reviewed answers', ${NOW - 10_000}, ${NOW - 10_000});
    INSERT INTO access_grant_capabilities
      (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
    VALUES (
      'grant-1', 'answer', 'all', '[]', 'reviewed',
      '00000000-0000-4000-8000-000000000001'
    );
    INSERT INTO principal_credentials
      (id, grant_id, oauth_client_id, kind, label, created_at)
    VALUES ('credential-1', 'grant-1', 'client-1', 'interactive', 'Fictional client', ${NOW - 10_000});
  `);
  db.prepare(
    `INSERT INTO oauth_access_tokens
       (id, credential_id, token_hash, audience, scope, grant_revision, created_at, expires_at)
     VALUES ('access-1', 'credential-1', ?, ?, 'omnesis:access', 1, ?, ?)`,
  ).run(tokenHash("raw-access-token"), RESOURCE, NOW - 5_000, NOW + 60_000);
  db.prepare(
    `INSERT INTO oauth_refresh_tokens
       (id, credential_id, family_id, generation, token_hash, audience, scope, created_at, expires_at)
     VALUES ('refresh-1', 'credential-1', 'family-1', 0, ?, ?, 'omnesis:access', ?, ?)`,
  ).run(tokenHash("raw-refresh-token"), RESOURCE, NOW - 5_000, NOW + 60_000);
}

function publicClient() {
  return registerOAuthClient(
    db,
    {
      clientName: "Stellar MCP Client",
      redirectUris: [TEST_OAUTH_REDIRECT],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      clientUri: "https://example.com/client",
    },
    NOW,
  );
}

function revokedEvents() {
  return db
    .prepare(
      `SELECT occurred_at, principal_id, grant_id, grant_revision, credential_id, oauth_client_id
       FROM access_audit_events WHERE event_type = 'oauth-authorization-revoked'`,
    )
    .all();
}

function rawTokenState() {
  return {
    access: db.prepare("SELECT id, revoked_at FROM oauth_access_tokens").all(),
    refresh: db.prepare("SELECT id, revoked_at FROM oauth_refresh_tokens").all(),
  };
}
