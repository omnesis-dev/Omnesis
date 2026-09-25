// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { DeviceId } from "@omnesis/types";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { runSchemaSetup } from "../data/schema.js";
import { commitPrivacyPolicy } from "../privacy/policy-history.js";
import { directWriteGate } from "../write-gate.js";
import {
  createAccessTables,
  createAuthorizationRequest,
  createExecutionBinding,
  cleanupExpiredAccessStateBatch,
  decideAuthorizationRequest,
  defaultAuthorizationScope,
  exchangeAuthorizationCode,
  getAuthorizationRequestByBrowserHandle,
  getAuthorizationRequestByUserCode,
  issueAuthorizationCode,
  listAccessOverview,
  lookupPrincipalAccessToken,
  refreshPrincipalAccessToken,
  registerOAuthClient,
  enqueueAccessAuthorizationNotification,
  revokeAccessGrant,
  removeConnection,
  removeProfile,
  revokePrincipalCredential,
  updateAccessGrant,
} from "./store.js";
import { AUTHORIZATION_CODE_TTL_MS, AUTHORIZATION_REQUEST_TTL_MS } from "./store-helpers.js";
import { authorizeInteractiveAccess } from "./test-utils.js";
import { MCP_ACCESS_SCOPE } from "./types.js";
import { AccessService } from "./service.js";
import type { Db } from "../data/types.js";
import type { WriteGate } from "../write-gate.js";
import type { OAuthClientCleanupCursor } from "./store-cleanup.js";

const NOW = 1_800_000_000_000;
const RESOURCE = "https://gateway.example.org/mcp";
const REDIRECT = "http://127.0.0.1:48123/callback";
const VERIFIER = "v".repeat(64);
const DIRECT_RULES = [
  { capability: "direct" as const, sources: { mode: "all" as const, sourceIds: [] } },
];
const ANSWER_RULES = [
  {
    capability: "answer" as const,
    sources: { mode: "all" as const, sourceIds: [] },
    release: { mode: "reviewed" as const, policyFamilyId: DEFAULT_PRIVACY_POLICY_FAMILY_ID },
  },
];
const UNREVIEWED_ANSWER_RULES = [
  {
    capability: "answer" as const,
    sources: { mode: "all" as const, sourceIds: [] },
    release: { mode: "unreviewed" as const },
  },
];
const DIRECT_AND_ANSWER_RULES = [...DIRECT_RULES, ...ANSWER_RULES];
const DIRECT_AND_UNREVIEWED_ANSWER_RULES = [...DIRECT_RULES, ...UNREVIEWED_ANSWER_RULES];

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  createAccessTables(db);
  commitPrivacyPolicy(db, {
    policy: "# Test policy\n\nAllow fictional summaries.\n",
    digest: "a".repeat(64),
    revision: "b".repeat(64),
    expectedRevision: null,
    action: "bootstrap",
    revertedFromGeneration: null,
    createdAt: NOW - 1,
  });
});

describe("access authorization store", () => {
  test("authenticates notes-only grants and preserves Notes in the editable overview", () => {
    const rules = [
      { capability: "notes" as const, sources: { mode: "all" as const, sourceIds: [] } },
    ];
    const authorized = authorizeInteractiveAccess(db, {
      selection: {
        kind: "new-principal",
        principalName: "Example note agent",
        grantName: "Capture",
        rules,
        credentialLabel: "Example credential",
        expiresAt: null,
      },
      resource: RESOURCE,
      scope: MCP_ACCESS_SCOPE,
      now: NOW,
    });
    expect(
      lookupPrincipalAccessToken(db, authorized.tokens.accessToken, RESOURCE, NOW + 13),
    ).toMatchObject({
      principalName: "Example note agent",
      capabilities: [{ capability: "notes", releaseMode: null, sourceMode: "all", sourceIds: [] }],
    });
    expect(
      listAccessOverview(db).principals.find((p) => p.id === authorized.principalId)?.grants[0]
        ?.rules,
    ).toEqual(rules);
  });
  test("atomically enqueues one durable notification and marks its request sent", () => {
    const client = publicClient();
    const pending = pendingAuthorization(client.clientId);
    const phoneId = insertPhone();

    expect(enqueueAccessAuthorizationNotification(db, pending.id, [phoneId], NOW + 1)).toEqual({
      requestId: pending.id,
      expiresAt: NOW + 10 * 60_000,
      deviceIds: [phoneId],
    });
    expect(enqueueAccessAuthorizationNotification(db, pending.id, [phoneId], NOW + 2)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM notifications").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM notification_deliveries").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare(
          `SELECT access_notification_reserved_at, access_notification_sent_at
             FROM oauth_authorization_requests WHERE id = ?`,
        )
        .get(pending.id),
    ).toEqual({
      access_notification_reserved_at: NOW + 1,
      access_notification_sent_at: NOW + 1,
    });

    const expired = pendingAuthorization(client.clientId);
    expect(
      enqueueAccessAuthorizationNotification(db, expired.id, [phoneId], expired.expiresAt),
    ).toBeNull();
  });

  test("rolls back the outbox if the one-shot marker cannot commit", () => {
    const client = publicClient();
    const pending = pendingAuthorization(client.clientId);
    const phoneId = insertPhone();
    db.exec(`
      CREATE TRIGGER fail_access_notification_marker
      BEFORE UPDATE OF access_notification_sent_at ON oauth_authorization_requests
      WHEN NEW.access_notification_sent_at IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'synthetic marker failure');
      END;
    `);

    expect(() =>
      enqueueAccessAuthorizationNotification(db, pending.id, [phoneId], NOW + 1),
    ).toThrow("synthetic marker failure");
    expect(db.prepare("SELECT COUNT(*) AS count FROM notifications").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM notification_deliveries").get()).toEqual({
      count: 0,
    });
    expect(
      db
        .prepare(
          `SELECT access_notification_reserved_at, access_notification_sent_at
             FROM oauth_authorization_requests WHERE id = ?`,
        )
        .get(pending.id),
    ).toEqual({ access_notification_reserved_at: null, access_notification_sent_at: null });

    db.exec("DROP TRIGGER fail_access_notification_marker");
    expect(
      enqueueAccessAuthorizationNotification(db, pending.id, [phoneId], NOW + 2),
    ).not.toBeNull();
  });

  test("leaves the request unmarked when no paired phone can accept the outbox row", () => {
    const pending = pendingAuthorization(publicClient().clientId);
    expect(
      enqueueAccessAuthorizationNotification(
        db,
        pending.id,
        [DeviceId("00000000-0000-4000-8000-000000000099")],
        NOW + 1,
      ),
    ).toBeNull();
    expect(
      db
        .prepare(
          `SELECT access_notification_reserved_at, access_notification_sent_at
             FROM oauth_authorization_requests WHERE id = ?`,
        )
        .get(pending.id),
    ).toEqual({ access_notification_reserved_at: null, access_notification_sent_at: null });
  });

  test("revalidates a snapshotted phone inside the writer transaction", () => {
    const pending = pendingAuthorization(publicClient().clientId);
    const phoneId = insertPhone();
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(NOW + 1, phoneId);

    expect(enqueueAccessAuthorizationNotification(db, pending.id, [phoneId], NOW + 2)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM notifications").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM notification_deliveries").get()).toEqual({
      count: 0,
    });
    expect(
      db
        .prepare(
          `SELECT access_notification_reserved_at, access_notification_sent_at
             FROM oauth_authorization_requests WHERE id = ?`,
        )
        .get(pending.id),
    ).toEqual({ access_notification_reserved_at: null, access_notification_sent_at: null });
  });

  test("uses the writer clock when deciding whether a queued request has expired", async () => {
    const pending = pendingAuthorization(publicClient().clientId);
    const phoneId = insertPhone();
    vi.useFakeTimers();
    vi.setSystemTime(pending.expiresAt);
    try {
      const service = new AccessService(db, directWriteGate(db));
      await expect(
        service.enqueueAuthorizationNotification(pending.id, [phoneId]),
      ).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM notifications").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM notification_deliveries").get()).toEqual({
      count: 0,
    });
    expect(
      db
        .prepare(
          `SELECT access_notification_reserved_at, access_notification_sent_at
             FROM oauth_authorization_requests WHERE id = ?`,
        )
        .get(pending.id),
    ).toEqual({ access_notification_reserved_at: null, access_notification_sent_at: null });
  });

  test("reinstalling the live schema never repeats the migration cutover transform", () => {
    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at, last_seen_at)
       VALUES (?, ?, 'agent', ?, ?, ?)`,
    ).run(
      "device-after-cutover",
      "Fictional integration host",
      JSON.stringify({ agentIntegration: { harness: "openclaw" } }),
      NOW,
      NOW,
    );
    db.prepare(
      `INSERT INTO tokens (id, token_hash, device_id, scopes, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "token-after-cutover",
      "hash-after-cutover",
      "device-after-cutover",
      JSON.stringify(["answer", "subscriptions:manage"]),
      NOW,
    );

    createAccessTables(db);

    expect(db.prepare("SELECT scopes FROM tokens WHERE id = ?").get("token-after-cutover")).toEqual(
      { scopes: '["answer","subscriptions:manage"]' },
    );
  });

  test("creates a Direct principal, grant, credential, and rotating OAuth tokens", async () => {
    const client = publicClient();
    const pending = pendingAuthorization(
      client.clientId,
      `${defaultAuthorizationScope()} offline_access`,
    );

    expect(getAuthorizationRequestByBrowserHandle(db, pending.browserHandle, NOW)).toMatchObject({
      status: "pending",
      clientName: "Stellar MCP Client",
      userCode: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
    });
    expect(
      getAuthorizationRequestByUserCode(db, pending.userCode.toLowerCase(), NOW),
    ).toMatchObject({ status: "pending", clientId: client.clientId });

    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: pending.id,
          decision: "approve",
          actorTokenId: "portal-token",
          selection: {
            kind: "new-principal",
            principalName: "Development assistant",
            grantName: "Whole-corpus Direct",
            rules: DIRECT_RULES,
            credentialLabel: "Laptop installation",
            expiresAt: null,
          },
        },
        NOW + 1,
      ),
    ).toMatchObject({ ok: true, value: { status: "approved" } });

    const approvedCredential = db
      .prepare<[], { id: string; status: string }>("SELECT id, status FROM principal_credentials")
      .get();
    expect(approvedCredential).toEqual({ id: expect.any(String), status: "pending" });
    expect(listAccessOverview(db).principals[0]?.grants[0]?.credentials[0]).toMatchObject({
      id: approvedCredential?.id,
      status: "pending",
      label: "Laptop installation",
    });
    expect(
      db
        .prepare("SELECT credential_id FROM oauth_authorization_requests WHERE id = ?")
        .get(pending.id),
    ).toEqual({ credential_id: approvedCredential?.id });

    const issued = issueAuthorizationCode(db, pending.browserHandle, NOW + 2);
    expect(issued).toMatchObject({ ok: true, value: { status: "approved" } });
    if (!issued.ok || issued.value.status !== "approved") throw new Error("code not issued");

    const exchanged = exchangeAuthorizationCode(
      db,
      {
        code: issued.value.code,
        clientId: client.clientId,
        redirectUri: REDIRECT,
        codeVerifier: VERIFIER,
        resource: RESOURCE,
      },
      NOW + 3,
    );
    expect(exchanged).toMatchObject({
      ok: true,
      value: {
        accessToken: expect.stringMatching(/^omn_oat_/),
        refreshToken: expect.stringMatching(/^omn_ort_/),
        tokenType: "Bearer",
        scope: `${defaultAuthorizationScope()} offline_access`,
      },
    });
    if (!exchanged.ok || !exchanged.value.refreshToken) throw new Error("tokens not issued");
    expect(db.prepare("SELECT id, status FROM principal_credentials").get()).toEqual({
      id: approvedCredential?.id,
      status: "active",
    });

    const access = lookupPrincipalAccessToken(db, exchanged.value.accessToken, RESOURCE, NOW + 4);
    expect(access).toMatchObject({
      principalName: "Development assistant",
      oauthClientId: client.clientId,
      grantRevision: 1,
      capabilities: [
        { capability: "direct", sourceMode: "all", sourceIds: [], privacyPolicy: null },
      ],
      scopes: [MCP_ACCESS_SCOPE, "offline_access"],
    });
    expect(
      lookupPrincipalAccessToken(db, exchanged.value.accessToken, `${RESOURCE}/other`, NOW + 4),
    ).toBeNull();

    const refreshed = refreshPrincipalAccessToken(
      db,
      { refreshToken: exchanged.value.refreshToken, clientId: client.clientId, resource: RESOURCE },
      NOW + 5,
    );
    expect(refreshed).toMatchObject({
      ok: true,
      value: {
        accessToken: expect.stringMatching(/^omn_oat_/),
        refreshToken: expect.stringMatching(/^omn_ort_/),
      },
    });
    if (!refreshed.ok || !refreshed.value.refreshToken) {
      throw new Error("rotated refresh token not issued");
    }
    const accessTokenRowsBeforeReplay = db
      .prepare("SELECT * FROM oauth_access_tokens ORDER BY id")
      .all();
    const refreshTokenRowsBeforeReplay = db
      .prepare("SELECT * FROM oauth_refresh_tokens ORDER BY id")
      .all();
    const retry = refreshPrincipalAccessToken(
      db,
      {
        refreshToken: exchanged.value.refreshToken,
        clientId: client.clientId,
        resource: RESOURCE,
      },
      NOW + 6,
    );
    expect(retry).toEqual({
      ok: true,
      value: { ...refreshed.value, expiresIn: refreshed.value.expiresIn - 1 },
    });
    expect(db.prepare("SELECT * FROM oauth_access_tokens ORDER BY id").all()).toEqual(
      accessTokenRowsBeforeReplay,
    );
    expect(db.prepare("SELECT * FROM oauth_refresh_tokens ORDER BY id").all()).toEqual(
      refreshTokenRowsBeforeReplay,
    );
    expect(cleanupExpiredAccessStateBatch(db, "refreshTokens", NOW + 60_006)).toMatchObject({
      phase: "refreshTokens",
      hasMore: false,
    });
    expect(
      db
        .prepare(
          "SELECT replacement_ciphertext, retry_until FROM oauth_refresh_tokens WHERE used_at IS NOT NULL",
        )
        .get(),
    ).toEqual({ replacement_ciphertext: null, retry_until: null });
    expect(
      refreshPrincipalAccessToken(
        db,
        {
          refreshToken: exchanged.value.refreshToken,
          clientId: client.clientId,
          resource: RESOURCE,
        },
        NOW + 60_006,
      ),
    ).toEqual({ ok: false, error: "invalid-grant" });
    const exchangeOAuthToken = vi.fn();
    const service = new AccessService(db, { exchangeOAuthToken } as unknown as WriteGate);
    await expect(
      service.exchangeOAuthToken(
        {
          grantType: "refresh_token",
          refreshToken: refreshed.value.refreshToken,
          clientId: client.clientId,
          resource: RESOURCE,
        },
        RESOURCE,
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-grant" });
    expect(exchangeOAuthToken).not.toHaveBeenCalled();
    expect(
      db
        .prepare<[], { count: number }>(
          `SELECT COUNT(*) AS count FROM access_audit_events
           WHERE event_type = 'refresh-token-replay-detected'`,
        )
        .get()?.count,
    ).toBe(1);
    expect(
      lookupPrincipalAccessToken(db, refreshed.value.accessToken, RESOURCE, NOW + 60_007),
    ).not.toBeNull();
  });

  test("issues refresh authority to a capable client without requiring offline_access", () => {
    const client = publicClient();
    const tokens = authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Foreground assistant",
      grantName: "Session access",
      rules: ANSWER_RULES,
      credentialLabel: "Browser session",
      expiresAt: null,
    });
    expect(tokens.refreshToken).toMatch(/^omn_ort_/);
    expect(tokens.scope).toBe(MCP_ACCESS_SCOPE);
  });

  test("refreshes against the credential's bound audience when resource is omitted", () => {
    const client = publicClient();
    const tokens = authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Fictional assistant",
      grantName: "Session access",
      rules: ANSWER_RULES,
      credentialLabel: "Fictional client",
      expiresAt: null,
    });
    if (!tokens.refreshToken) throw new Error("refresh token missing");

    const refreshed = refreshPrincipalAccessToken(
      db,
      { refreshToken: tokens.refreshToken, clientId: client.clientId },
      NOW + 20,
    );
    expect(refreshed).toMatchObject({ ok: true, value: { refreshToken: expect.any(String) } });
  });

  test("does not issue refresh authority to a client that omitted the refresh grant", () => {
    const client = registerOAuthClient(
      db,
      {
        clientName: "Foreground-only MCP Client",
        redirectUris: [REDIRECT],
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        clientUri: "https://example.com/foreground-client",
      },
      NOW,
    );
    const tokens = authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Foreground assistant",
      grantName: "Session access",
      rules: ANSWER_RULES,
      credentialLabel: "Browser session",
      expiresAt: null,
    });
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.scope).toBe(MCP_ACCESS_SCOPE);
  });

  test("caps advertised and stored access-token lifetime to the active authority", () => {
    const client = publicClient();
    const pending = pendingAuthorization(client.clientId);
    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: pending.id,
          decision: "approve",
          actorTokenId: "portal-token",
          selection: {
            kind: "new-principal",
            principalName: "Short-lived assistant",
            grantName: "Short session",
            rules: DIRECT_RULES,
            credentialLabel: "Ephemeral browser",
            expiresAt: NOW + 30_000,
          },
        },
        NOW + 1,
      ).ok,
    ).toBe(true);
    const issued = issueAuthorizationCode(db, pending.browserHandle, NOW + 2);
    if (!issued.ok || issued.value.status !== "approved") throw new Error("code not issued");
    const exchanged = exchangeAuthorizationCode(
      db,
      {
        code: issued.value.code,
        clientId: client.clientId,
        redirectUri: REDIRECT,
        codeVerifier: VERIFIER,
        resource: RESOURCE,
      },
      NOW + 3,
    );
    expect(exchanged).toMatchObject({ ok: true, value: { expiresIn: 29 } });
    if (!exchanged.ok) throw new Error("tokens not issued");
    expect(
      db
        .prepare<
          [],
          { expires_at: number }
        >("SELECT expires_at FROM oauth_access_tokens ORDER BY created_at DESC LIMIT 1")
        .get(),
    ).toEqual({ expires_at: NOW + 30_000 });
  });

  test("approves a pending request through the short code without the browser secret", () => {
    const client = publicClient();
    const pending = pendingAuthorization(client.clientId);
    const portalRequest = getAuthorizationRequestByUserCode(db, pending.userCode, NOW + 1);
    expect(portalRequest).toMatchObject({ approvalId: pending.id, status: "pending" });
    if (!portalRequest) throw new Error("portal request not found");

    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: portalRequest.approvalId,
          decision: "approve",
          actorTokenId: "portal-token",
          selection: {
            kind: "new-principal",
            principalName: "Portal-approved assistant",
            grantName: "Unreviewed answers",
            rules: UNREVIEWED_ANSWER_RULES,
            credentialLabel: "Desktop client",
            expiresAt: null,
          },
        },
        NOW + 2,
      ),
    ).toMatchObject({ ok: true, value: { status: "approved" } });
    expect(
      getAuthorizationRequestByBrowserHandle(db, pending.browserHandle, NOW + 3),
    ).toMatchObject({ status: "approved" });
  });

  test("rejects unregistered clients, redirects, malformed PKCE, and non-canonical scopes", () => {
    const client = publicClient();
    const base = {
      clientId: client.clientId,
      redirectUri: REDIRECT,
      state: "state-123",
      codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      resource: RESOURCE,
      scope: defaultAuthorizationScope(),
    };
    expect(createAuthorizationRequest(db, { ...base, clientId: "missing" }, NOW)).toEqual({
      ok: false,
      error: "invalid-client",
    });
    expect(
      createAuthorizationRequest(
        db,
        { ...base, redirectUri: "https://attacker.example/callback" },
        NOW,
      ),
    ).toEqual({ ok: false, error: "invalid-redirect-uri" });
    expect(createAuthorizationRequest(db, { ...base, codeChallenge: "short" }, NOW)).toEqual({
      ok: false,
      error: "invalid-pkce",
    });
    expect(
      createAuthorizationRequest(db, { ...base, scope: `${MCP_ACCESS_SCOPE} extra` }, NOW),
    ).toEqual({ ok: false, error: "invalid-request" });
  });

  test("accepts a new ephemeral port for the same registered loopback callback", () => {
    const client = registerOAuthClient(
      db,
      {
        clientName: "Fictional command-line client",
        redirectUris: ["http://localhost:41001/callback"],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        clientUri: null,
      },
      NOW,
    );
    expect(
      createAuthorizationRequest(
        db,
        {
          clientId: client.clientId,
          redirectUri: "http://localhost:52992/callback",
          codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
          resource: RESOURCE,
          scope: defaultAuthorizationScope(),
        },
        NOW + 1,
      ),
    ).toMatchObject({ ok: true });
  });

  test("binds an OpenClaw OAuth credential to its active operational device exactly once", () => {
    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
       VALUES (?, ?, 'agent', ?, ?)`,
    ).run(
      "agent-device",
      "Fictional OpenClaw runtime",
      JSON.stringify({
        agentIntegration: {
          harness: "openclaw",
          deliveryProtocolMin: 1,
          deliveryProtocolMax: 1,
          maxConcurrentRuns: 1,
        },
      }),
      NOW,
    );
    const client = publicClient();
    const binding = createExecutionBinding(
      db,
      { deviceId: "agent-device", oauthClientId: client.clientId, harness: "openclaw" },
      NOW + 1,
    );
    expect(binding).toMatchObject({
      ok: true,
      value: { binding: expect.stringMatching(/^omn_oeb_/) },
    });
    if (!binding.ok) throw new Error("execution binding not created");

    const created = createAuthorizationRequest(
      db,
      {
        clientId: client.clientId,
        redirectUri: REDIRECT,
        state: "openclaw-state",
        codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: defaultAuthorizationScope(),
        executionBinding: binding.value.binding,
      },
      NOW + 2,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("authorization request not created");
    expect(
      getAuthorizationRequestByBrowserHandle(db, created.value.browserHandle, NOW + 2),
    ).toMatchObject({ requiresAnswer: true });
    db.exec(`
      INSERT INTO access_principals (id, name, kind, created_at, updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'Existing assistant', 'interactive', 1, 1);
      INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
      VALUES
        ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Direct only', 1, 1),
        ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'Unreviewed answer', 1, 1),
        ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', 'Reviewed answer', 1, 1);
      INSERT INTO access_grant_capabilities
        (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
      VALUES
        ('22222222-2222-4222-8222-222222222222', 'direct', 'all', '[]', NULL, NULL),
        ('33333333-3333-4333-8333-333333333333', 'answer', 'all', '[]', 'unreviewed', NULL),
        ('44444444-4444-4444-8444-444444444444', 'answer', 'all', '[]', 'reviewed', '${DEFAULT_PRIVACY_POLICY_FAMILY_ID}');
    `);
    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: created.value.id,
          decision: "approve",
          actorTokenId: "portal-token",
          selection: {
            kind: "existing-grant",
            grantId: "22222222-2222-4222-8222-222222222222",
            credentialLabel: "OpenClaw runtime",
          },
        },
        NOW + 3,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: created.value.id,
          decision: "approve",
          actorTokenId: "portal-token",
          selection: {
            kind: "new-principal",
            principalName: "Fictional OpenClaw assistant",
            grantName: "Direct only",
            rules: DIRECT_RULES,
            credentialLabel: "OpenClaw runtime",
            expiresAt: null,
          },
        },
        NOW + 3,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: created.value.id,
          decision: "approve",
          actorTokenId: "portal-token",
          selection: {
            kind: "existing-grant",
            grantId: "33333333-3333-4333-8333-333333333333",
            credentialLabel: "OpenClaw runtime",
          },
        },
        NOW + 4,
      ),
    ).toMatchObject({ ok: true, value: { status: "approved", requiresAnswer: true } });
    const reviewedBinding = createExecutionBinding(
      db,
      { deviceId: "agent-device", oauthClientId: client.clientId, harness: "openclaw" },
      NOW + 5,
    );
    if (!reviewedBinding.ok) throw new Error("reviewed binding not created");
    const reviewedRequest = createAuthorizationRequest(
      db,
      {
        clientId: client.clientId,
        redirectUri: REDIRECT,
        state: "reviewed-state",
        codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: defaultAuthorizationScope(),
        executionBinding: reviewedBinding.value.binding,
      },
      NOW + 6,
    );
    if (!reviewedRequest.ok) throw new Error("reviewed authorization not created");
    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: reviewedRequest.value.id,
          decision: "approve",
          actorTokenId: "portal-token",
          selection: {
            kind: "existing-grant",
            grantId: "44444444-4444-4444-8444-444444444444",
            credentialLabel: "OpenClaw reviewed runtime",
          },
        },
        NOW + 7,
      ),
    ).toMatchObject({ ok: true, value: { status: "approved", requiresAnswer: true } });
    expect(
      createAuthorizationRequest(
        db,
        {
          clientId: client.clientId,
          redirectUri: REDIRECT,
          state: "replay-state",
          codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
          resource: RESOURCE,
          scope: defaultAuthorizationScope(),
          executionBinding: binding.value.binding,
        },
        NOW + 3,
      ),
    ).toEqual({ ok: false, error: "invalid-binding" });
    expect(
      db.prepare("SELECT execution_device_id FROM oauth_authorization_requests").get(),
    ).toEqual({ execution_device_id: "agent-device" });
  });

  test("treats the exact expiry instant as expired and cleans expired rows in bounded batches", () => {
    const client = publicClient();
    const challenge = createHash("sha256").update(VERIFIER).digest("base64url");
    for (let index = 0; index < 3; index += 1) {
      const created = createAuthorizationRequest(
        db,
        {
          clientId: client.clientId,
          redirectUri: REDIRECT,
          state: `state-${index}`,
          codeChallenge: challenge,
          resource: RESOURCE,
          scope: defaultAuthorizationScope(),
          ttlMs: 10,
        },
        NOW,
      );
      expect(created.ok).toBe(true);
      if (index === 0 && created.ok) {
        expect(
          getAuthorizationRequestByBrowserHandle(db, created.value.browserHandle, NOW + 10),
        ).toMatchObject({ status: "expired" });
        expect(
          decideAuthorizationRequest(
            db,
            {
              approvalId: created.value.id,
              decision: "deny",
              actorTokenId: "portal-token",
            },
            NOW + 10,
          ),
        ).toEqual({ ok: false, error: "expired" });
      }
    }
    expect(cleanupExpiredAccessStateBatch(db, "authorizationRequests", NOW + 10, 2)).toEqual({
      phase: "authorizationRequests",
      deleted: 2,
      hasMore: true,
      nextDueAt: NOW + 10,
    });
    expect(cleanupExpiredAccessStateBatch(db, "authorizationRequests", NOW + 10, 2)).toEqual({
      phase: "authorizationRequests",
      deleted: 1,
      hasMore: false,
    });
  });

  test("prioritizes expired issued codes within one bounded indexed cleanup batch", () => {
    const client = publicClient();
    const challenge = createHash("sha256").update(VERIFIER).digest("base64url");
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const created = createAuthorizationRequest(
        db,
        {
          clientId: client.clientId,
          redirectUri: REDIRECT,
          state: `mixed-cleanup-${index}`,
          codeChallenge: challenge,
          resource: RESOURCE,
          scope: defaultAuthorizationScope(),
          ttlMs: 10,
        },
        NOW,
      );
      if (!created.ok) throw new Error(created.error);
      ids.push(created.value.id);
    }
    const markIssued = db.prepare(
      `UPDATE oauth_authorization_requests
       SET status = 'code-issued', authorization_code_hash = ?,
           authorization_code_expires_at = ?
       WHERE id = ?`,
    );
    markIssued.run("fictional-code-hash-0", NOW + 10, ids[0]);
    markIssued.run("fictional-code-hash-1", NOW + 10, ids[1]);

    const codePlan = db
      .prepare<[number, number], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT id FROM oauth_authorization_requests
         WHERE status = 'code-issued' AND authorization_code_expires_at <= ?
         ORDER BY authorization_code_expires_at, id LIMIT ?`,
      )
      .all(NOW + 10, 2)
      .map((row) => row.detail)
      .join(" ");
    const ordinaryPlan = db
      .prepare<[number, number], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT id FROM oauth_authorization_requests
         WHERE status != 'code-issued' AND expires_at <= ?
         ORDER BY expires_at, id LIMIT ?`,
      )
      .all(NOW + 10, 2)
      .map((row) => row.detail)
      .join(" ");
    expect(codePlan).toContain("idx_oauth_authorization_requests_code_expiry");
    expect(ordinaryPlan).toContain("idx_oauth_authorization_requests_expiry");

    expect(cleanupExpiredAccessStateBatch(db, "authorizationRequests", NOW + 10, 2)).toEqual({
      phase: "authorizationRequests",
      deleted: 2,
      hasMore: true,
      nextDueAt: NOW + 10,
    });
    expect(
      db
        .prepare<
          [],
          { status: string }
        >("SELECT status FROM oauth_authorization_requests ORDER BY status, id")
        .all(),
    ).toEqual([{ status: "pending" }, { status: "pending" }]);
    expect(cleanupExpiredAccessStateBatch(db, "authorizationRequests", NOW + 10, 2)).toEqual({
      phase: "authorizationRequests",
      deleted: 2,
      hasMore: false,
    });
  });

  test("removes a pending credential when its approved authorization request expires", () => {
    const client = publicClient();
    const pending = createAuthorizationRequest(
      db,
      {
        clientId: client.clientId,
        redirectUri: REDIRECT,
        codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: defaultAuthorizationScope(),
        ttlMs: 10,
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
          actorTokenId: "portal-token",
          selection: {
            kind: "new-principal",
            principalName: "Expired approval assistant",
            grantName: "Answer",
            rules: ANSWER_RULES,
            credentialLabel: "Unclaimed browser",
            expiresAt: null,
          },
        },
        NOW + 1,
      ).ok,
    ).toBe(true);
    expect(db.prepare("SELECT status FROM principal_credentials").get()).toEqual({
      status: "pending",
    });

    expect(cleanupExpiredAccessStateBatch(db, "authorizationRequests", NOW + 10)).toEqual({
      phase: "authorizationRequests",
      deleted: 1,
      hasMore: false,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM principal_credentials").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_grants").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_principals").get()).toEqual({
      count: 0,
    });
  });

  test("denying an authorization request never creates an access identity graph", () => {
    const client = publicClient();
    const pending = createAuthorizationRequest(
      db,
      {
        clientId: client.clientId,
        redirectUri: REDIRECT,
        codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: defaultAuthorizationScope(),
      },
      NOW,
    );
    if (!pending.ok) throw new Error(pending.error);
    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: pending.value.id,
          decision: "deny",
          actorTokenId: "portal-token",
        },
        NOW + 1,
      ).ok,
    ).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM principal_credentials").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_grants").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_principals").get()).toEqual({
      count: 0,
    });
  });

  test("cleans only old orphaned public OAuth clients in bounded batches", () => {
    const retentionMs = 30 * 24 * 60 * 60_000;
    const registerAt = (name: string, createdAt: number) =>
      registerOAuthClient(
        db,
        {
          clientName: name,
          redirectUris: [REDIRECT],
          grantTypes: ["authorization_code", "refresh_token"],
          responseTypes: ["code"],
          clientUri: "https://example.com/client",
        },
        createdAt,
      );
    const oldOrphans = [
      registerAt("Orphan one", NOW - retentionMs - 3),
      registerAt("Orphan two", NOW - retentionMs - 2),
      registerAt("Orphan three", NOW - retentionMs - 1),
    ];
    const recent = registerAt("Recent client", NOW - retentionMs + 1);
    const credentialClient = registerAt("Credential client", NOW - retentionMs - 1);
    const requestClient = registerAt("Request client", NOW - retentionMs - 1);
    const bindingClient = registerAt("Binding client", NOW - retentionMs - 1);

    db.exec(`
      INSERT INTO access_principals (id, name, kind, created_at, updated_at)
      VALUES ('cleanup-principal', 'Fictional assistant', 'interactive', ${NOW}, ${NOW});
      INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
      VALUES ('cleanup-grant', 'cleanup-principal', 'Direct access', ${NOW}, ${NOW});
    `);
    db.prepare(
      `INSERT INTO principal_credentials
         (id, grant_id, oauth_client_id, kind, label, created_at)
       VALUES ('cleanup-credential', 'cleanup-grant', ?, 'interactive', 'Test client', ?)`,
    ).run(credentialClient.clientId, NOW);
    expect(
      createAuthorizationRequest(
        db,
        {
          clientId: requestClient.clientId,
          redirectUri: REDIRECT,
          state: "cleanup-request",
          codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
          resource: RESOURCE,
          scope: defaultAuthorizationScope(),
        },
        NOW,
      ).ok,
    ).toBe(true);
    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
       VALUES ('cleanup-device', 'Fictional runtime', 'agent', ?, ?)`,
    ).run(
      JSON.stringify({
        agentIntegration: {
          harness: "hermes",
          deliveryProtocolMin: 1,
          deliveryProtocolMax: 1,
          maxConcurrentRuns: 1,
        },
      }),
      NOW,
    );
    expect(
      createExecutionBinding(
        db,
        {
          deviceId: "cleanup-device",
          oauthClientId: bindingClient.clientId,
          harness: "hermes",
        },
        NOW,
      ).ok,
    ).toBe(true);

    let cursor: OAuthClientCleanupCursor | undefined;
    let deleted = 0;
    let hasMore: boolean;
    do {
      const result = cleanupExpiredAccessStateBatch(db, "oauthClients", NOW, 2, cursor);
      deleted += result.deleted;
      cursor = result.cursor;
      hasMore = result.hasMore;
      if (hasMore) expect(cursor).toBeDefined();
    } while (hasMore);
    expect(deleted).toBe(3);
    const remaining = db
      .prepare<[], { client_id: string }>("SELECT client_id FROM oauth_clients")
      .all()
      .map((row) => row.client_id);
    expect(remaining).toEqual(
      expect.arrayContaining([
        recent.clientId,
        credentialClient.clientId,
        requestClient.clientId,
        bindingClient.clientId,
      ]),
    );
    expect(remaining).not.toEqual(
      expect.arrayContaining(oldOrphans.map((client) => client.clientId)),
    );
  });

  test("bounds OAuth client cleanup work across a retained prefix", () => {
    const retentionMs = 30 * 24 * 60 * 60_000;
    db.exec(`
      INSERT INTO access_principals (id, name, kind, created_at, updated_at)
      VALUES ('retained-principal', 'Fictional assistant', 'interactive', ${NOW}, ${NOW});
      INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
      VALUES ('retained-grant', 'retained-principal', 'Direct access', ${NOW}, ${NOW});
    `);
    for (let index = 0; index < 20; index += 1) {
      const client = registerOAuthClient(
        db,
        {
          clientName: `Retained client ${index}`,
          redirectUris: [REDIRECT],
          grantTypes: ["authorization_code", "refresh_token"],
          responseTypes: ["code"],
          clientUri: null,
        },
        NOW - retentionMs - 100 + index,
      );
      db.prepare(
        `INSERT INTO principal_credentials
           (id, grant_id, oauth_client_id, kind, label, created_at)
         VALUES (?, 'retained-grant', ?, 'interactive', ?, ?)`,
      ).run(`retained-credential-${index}`, client.clientId, `Installation ${index}`, NOW);
    }
    const orphan = registerOAuthClient(
      db,
      {
        clientName: "Orphan after retained prefix",
        redirectUris: [REDIRECT],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        clientUri: null,
      },
      NOW - retentionMs - 1,
    );

    const plan = db
      .prepare<[number, number, string, number], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT client_id FROM oauth_clients
         WHERE token_endpoint_auth_method = 'none'
           AND created_at < ?
           AND (created_at, client_id) > (?, ?)
         ORDER BY created_at, client_id
         LIMIT ?`,
      )
      .all(NOW - retentionMs, NOW - retentionMs - 50, "cursor", 6)
      .map((row) => row.detail)
      .join(" ");
    expect(plan).toContain("idx_oauth_clients_created");

    let cursor: OAuthClientCleanupCursor | undefined;
    let calls = 0;
    let hasMore: boolean;
    do {
      const result = cleanupExpiredAccessStateBatch(db, "oauthClients", NOW, 5, cursor);
      calls += 1;
      cursor = result.cursor;
      hasMore = result.hasMore;
    } while (hasMore);

    expect(calls).toBe(5);
    expect(db.prepare("SELECT 1 FROM oauth_clients WHERE client_id = ?").get(orphan.clientId)).toBe(
      undefined,
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM principal_credentials").get()).toEqual({
      count: 20,
    });
  });

  test("retains 90 days of access audit history and prunes older rows in bounded batches", () => {
    const retentionMs = 90 * 24 * 60 * 60_000;
    const insert = db.prepare(
      `INSERT INTO access_audit_events (id, occurred_at, event_type, detail)
       VALUES (?, ?, 'mcp-tool-invoked', '{}')`,
    );
    insert.run("audit-old-1", NOW - retentionMs - 3);
    insert.run("audit-old-2", NOW - retentionMs - 2);
    insert.run("audit-old-3", NOW - retentionMs - 1);
    insert.run("audit-boundary", NOW - retentionMs);
    insert.run("audit-recent", NOW - 1);

    expect(cleanupExpiredAccessStateBatch(db, "auditEvents", NOW, 2)).toEqual({
      phase: "auditEvents",
      deleted: 2,
      hasMore: true,
    });
    expect(cleanupExpiredAccessStateBatch(db, "auditEvents", NOW, 2)).toEqual({
      phase: "auditEvents",
      deleted: 1,
      hasMore: false,
    });
    expect(
      db
        .prepare<[], { id: string }>("SELECT id FROM access_audit_events ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual(["audit-boundary", "audit-recent"]);
  });

  test("retains a just-issued authorization code through its own expiry", () => {
    const client = publicClient();
    const pending = createAuthorizationRequest(
      db,
      {
        clientId: client.clientId,
        redirectUri: REDIRECT,
        state: "late-code",
        codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: defaultAuthorizationScope(),
        ttlMs: 100,
      },
      NOW,
    );
    if (!pending.ok) throw new Error("authorization request failed");
    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: pending.value.id,
          decision: "approve",
          actorTokenId: "portal-token",
          selection: {
            kind: "new-principal",
            principalName: "Late approval assistant",
            grantName: "Answer",
            rules: ANSWER_RULES,
            credentialLabel: "Late callback",
            expiresAt: null,
          },
        },
        NOW + 98,
      ).ok,
    ).toBe(true);
    const issued = issueAuthorizationCode(db, pending.value.browserHandle, NOW + 99);
    if (!issued.ok || issued.value.status !== "approved") throw new Error("code not issued");

    expect(cleanupExpiredAccessStateBatch(db, "authorizationRequests", NOW + 101)).toEqual({
      phase: "authorizationRequests",
      deleted: 0,
      hasMore: false,
      nextDueAt: NOW + 99 + AUTHORIZATION_CODE_TTL_MS,
    });
    expect(
      exchangeAuthorizationCode(
        db,
        {
          code: issued.value.code,
          clientId: client.clientId,
          redirectUri: REDIRECT,
          codeVerifier: VERIFIER,
          resource: RESOURCE,
        },
        NOW + 102,
      ).ok,
    ).toBe(true);
  });

  test("represents Answer as all sources through the default policy and reuses one grant", () => {
    const client = publicClient();
    const first = authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Research assistant",
      grantName: "Privacy-reviewed answers",
      rules: ANSWER_RULES,
      credentialLabel: "Desktop installation",
      expiresAt: null,
    });
    const overview = listAccessOverview(db);
    const grant = overview.principals[0]?.grants[0];
    expect(grant).toMatchObject({
      capabilities: [
        {
          capability: "answer",
          sourceMode: "all",
          sourceIds: [],
          privacyPolicy: "default",
        },
      ],
      credentials: [expect.objectContaining({ label: "Desktop installation" })],
    });
    if (!grant) throw new Error("grant not created");

    authorize(client.clientId, {
      kind: "existing-grant",
      grantId: grant.id,
      credentialLabel: "Second machine",
    });
    const reused = listAccessOverview(db);
    expect(reused.principals).toHaveLength(1);
    expect(reused.principals[0]?.grants).toHaveLength(1);
    expect(reused.principals[0]?.grants[0]?.credentials).toHaveLength(2);

    const access = lookupPrincipalAccessToken(db, first.accessToken, RESOURCE, NOW + 50);
    expect(access?.capabilities.map((rule) => rule.capability)).toEqual(["answer"]);
  });

  test("allows one V1 grant to expose Direct and Answer together", () => {
    const client = publicClient();
    const tokens = authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Combined assistant",
      grantName: "Direct and privacy-reviewed access",
      rules: DIRECT_AND_ANSWER_RULES,
      credentialLabel: "Combined desktop installation",
      expiresAt: null,
    });

    expect(
      lookupPrincipalAccessToken(db, tokens.accessToken, RESOURCE, NOW + 50)?.capabilities,
    ).toMatchObject([
      { capability: "answer", sourceMode: "all", sourceIds: [], privacyPolicy: "default" },
      { capability: "direct", sourceMode: "all", sourceIds: [], privacyPolicy: null },
    ]);
  });

  test("updates capabilities behind one credential and refreshes onto the new grant revision", () => {
    const client = publicClient();
    const tokens = authorize(
      client.clientId,
      {
        kind: "new-principal",
        principalName: "Revisable assistant",
        grantName: "Changing role",
        rules: DIRECT_RULES,
        credentialLabel: "Desktop installation",
        expiresAt: null,
      },
      `${defaultAuthorizationScope()} offline_access`,
    );
    if (!tokens.refreshToken) throw new Error("refresh token missing");
    const before = lookupPrincipalAccessToken(db, tokens.accessToken, RESOURCE, NOW + 20);
    if (!before) throw new Error("access token missing");

    expect(
      updateAccessGrant(
        db,
        {
          grantId: before.grantId,
          expectedRevision: before.grantRevision,
          rules: ANSWER_RULES,
          actorTokenId: "portal-token",
        },
        NOW + 21,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        grantId: before.grantId,
        revision: 2,
        capabilities: [{ capability: "answer", privacyPolicy: "default" }],
      },
    });
    expect(
      updateAccessGrant(
        db,
        {
          grantId: before.grantId,
          expectedRevision: before.grantRevision,
          rules: DIRECT_AND_ANSWER_RULES,
          actorTokenId: "stale-portal-token",
        },
        NOW + 22,
      ),
    ).toEqual({ ok: false, error: "stale-revision" });
    expect(lookupPrincipalAccessToken(db, tokens.accessToken, RESOURCE, NOW + 22)).toBeNull();

    const refreshed = refreshPrincipalAccessToken(
      db,
      { refreshToken: tokens.refreshToken, clientId: client.clientId, resource: RESOURCE },
      NOW + 23,
    );
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) throw new Error(refreshed.error);
    expect(
      lookupPrincipalAccessToken(db, refreshed.value.accessToken, RESOURCE, NOW + 24),
    ).toMatchObject({
      credentialId: before.credentialId,
      grantRevision: 2,
      capabilities: [{ capability: "answer", privacyPolicy: "default" }],
    });
  });

  test("can save a grant while retaining a source that is temporarily unavailable", () => {
    db.exec(`
      INSERT INTO devices (id, name, kind, capabilities, paired_at)
      VALUES ('source-device', 'Fictional collector', 'collector', '{}', 1);
      INSERT INTO sources
        (id, type, account_id, device_id, config, enabled, multi_device_mode, created_at, updated_at)
      VALUES ('files:fictional', 'files', 'fictional', 'source-device', '{}', 1, 'exclusive', 1, 1);
    `);
    const client = publicClient();
    const tokens = authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Fictional assistant",
      grantName: "Selected files",
      rules: [
        {
          capability: "direct",
          sources: { mode: "allowlist", sourceIds: ["files:fictional"] },
        },
      ],
      credentialLabel: "Fictional client",
      expiresAt: null,
    });
    const access = lookupPrincipalAccessToken(db, tokens.accessToken, RESOURCE, NOW + 20);
    if (!access) throw new Error("access token missing");
    db.prepare("DELETE FROM sources WHERE id = 'files:fictional'").run();

    expect(
      updateAccessGrant(
        db,
        {
          grantId: access.grantId,
          expectedRevision: access.grantRevision,
          rules: [
            {
              capability: "direct",
              sources: { mode: "allowlist", sourceIds: ["files:fictional"] },
            },
            ANSWER_RULES[0]!,
          ],
          actorTokenId: "portal-token",
        },
        NOW + 21,
      ),
    ).toMatchObject({ ok: true, value: { revision: 2 } });

    expect(
      updateAccessGrant(
        db,
        {
          grantId: access.grantId,
          expectedRevision: 2,
          rules: [
            {
              capability: "direct",
              sources: { mode: "allowlist", sourceIds: ["files:fictional"] },
            },
            {
              capability: "answer",
              sources: { mode: "allowlist", sourceIds: ["files:fictional"] },
              release: { mode: "reviewed", policyFamilyId: DEFAULT_PRIVACY_POLICY_FAMILY_ID },
            },
          ],
          actorTokenId: "portal-token",
        },
        NOW + 22,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
  });

  test("allows an execution-bound grant to combine Direct with unreviewed Answer", () => {
    const client = publicClient();
    const tokens = authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Fictional integration",
      grantName: "Configurable access",
      rules: ANSWER_RULES,
      credentialLabel: "Fictional runtime",
      expiresAt: null,
    });
    const access = lookupPrincipalAccessToken(db, tokens.accessToken, RESOURCE, NOW + 20);
    if (!access) throw new Error("access token missing");
    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
       VALUES ('agent-device', 'Fictional runtime', 'agent', '{}', ?)`,
    ).run(NOW);
    db.prepare("UPDATE principal_credentials SET execution_device_id = ? WHERE id = ?").run(
      "agent-device",
      access.credentialId,
    );

    expect(
      updateAccessGrant(
        db,
        {
          grantId: access.grantId,
          expectedRevision: access.grantRevision,
          rules: DIRECT_AND_UNREVIEWED_ANSWER_RULES,
          actorTokenId: "portal-token",
        },
        NOW + 21,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        revision: 2,
        capabilities: [
          { capability: "answer", releaseMode: "unreviewed", privacyPolicy: null },
          { capability: "direct", releaseMode: null, privacyPolicy: null },
        ],
      },
    });
    expect(
      updateAccessGrant(
        db,
        {
          grantId: access.grantId,
          expectedRevision: 2,
          rules: DIRECT_RULES,
          actorTokenId: "portal-token",
        },
        NOW + 22,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
  });

  test("binds authorization codes to client, redirect URI, PKCE, and one-time use", () => {
    const alternateRedirect = "http://127.0.0.1:48124/callback";
    const client = registerOAuthClient(
      db,
      {
        clientName: "Stellar MCP Client",
        redirectUris: [REDIRECT, alternateRedirect],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        clientUri: "https://example.com/client",
      },
      NOW,
    );
    const otherClient = publicClient();
    const pending = pendingAuthorization(client.clientId);
    decideAuthorizationRequest(
      db,
      {
        approvalId: pending.id,
        decision: "approve",
        actorTokenId: "portal-token",
        selection: {
          kind: "new-principal",
          principalName: "answer-principal-test",
          grantName: "Answer",
          rules: ANSWER_RULES,
          credentialLabel: "Workstation",
          expiresAt: null,
        },
      },
      NOW + 1,
    );
    const issued = issueAuthorizationCode(db, pending.browserHandle, NOW + 2);
    if (!issued.ok || issued.value.status !== "approved") throw new Error("code not issued");

    expect(
      exchangeAuthorizationCode(
        db,
        {
          code: issued.value.code,
          clientId: otherClient.clientId,
          redirectUri: REDIRECT,
          codeVerifier: VERIFIER,
          resource: RESOURCE,
        },
        NOW + 3,
      ),
    ).toEqual({ ok: false, error: "invalid-client" });
    expect(
      exchangeAuthorizationCode(
        db,
        {
          code: issued.value.code,
          clientId: client.clientId,
          redirectUri: alternateRedirect,
          codeVerifier: VERIFIER,
          resource: RESOURCE,
        },
        NOW + 3,
      ),
    ).toEqual({ ok: false, error: "invalid-redirect-uri" });
    expect(
      exchangeAuthorizationCode(
        db,
        {
          code: issued.value.code,
          clientId: client.clientId,
          redirectUri: REDIRECT,
          codeVerifier: "x".repeat(64),
          resource: RESOURCE,
        },
        NOW + 3,
      ),
    ).toEqual({ ok: false, error: "invalid-pkce" });
    expect(
      exchangeAuthorizationCode(
        db,
        {
          code: issued.value.code,
          clientId: client.clientId,
          redirectUri: REDIRECT,
          codeVerifier: VERIFIER,
          resource: RESOURCE,
        },
        NOW + 4,
      ).ok,
    ).toBe(true);
    expect(
      exchangeAuthorizationCode(
        db,
        {
          code: issued.value.code,
          clientId: client.clientId,
          redirectUri: REDIRECT,
          codeVerifier: VERIFIER,
          resource: RESOURCE,
        },
        NOW + 5,
      ),
    ).toEqual({ ok: false, error: "invalid-code" });
  });

  test("lists only interactive rows when legacy service rows remain in the schema", () => {
    const client = publicClient();
    authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Fictional assistant",
      grantName: "Direct",
      rules: DIRECT_RULES,
      credentialLabel: "Fictional workstation",
      expiresAt: null,
    });
    db.exec(`
      INSERT INTO access_principals (id, name, kind, created_at, updated_at, revoked_at)
      VALUES ('service-principal', 'Fictional automation', 'service', 1, 1, NULL);
      INSERT INTO access_grants (id, principal_id, name, created_at, updated_at, revoked_at)
      VALUES ('service-grant', 'service-principal', 'Whole-corpus access', 1, 1, NULL);
      INSERT INTO principal_credentials
        (id, grant_id, oauth_client_id, kind, label, client_secret_hash, created_at, revoked_at)
      VALUES ('service-credential', 'service-grant', 'omn_svc_fictional', 'service', 'Worker',
              'hash', 1, NULL);
    `);

    const overview = listAccessOverview(db);
    expect(overview.principals.map((principal) => principal.kind)).toEqual(["interactive"]);
    expect(
      overview.principals.flatMap((principal) => principal.grants.map((g) => g.id)),
    ).not.toContain("service-grant");
    expect(
      overview.principals.flatMap((principal) =>
        principal.grants.flatMap((grant) => grant.credentials.map((c) => c.kind)),
      ),
    ).toEqual(["interactive"]);
  });

  test("revocation invalidates access immediately without deleting the identity graph", () => {
    const client = publicClient();
    const tokens = authorize(client.clientId, {
      kind: "new-principal",
      principalName: "direct-principal-test",
      grantName: "Direct",
      rules: DIRECT_RULES,
      credentialLabel: "Machine A",
      expiresAt: null,
    });
    const overview = listAccessOverview(db);
    const grant = overview.principals[0]!.grants[0]!;
    const credential = grant.credentials[0]!;

    expect(revokePrincipalCredential(db, credential.id, "portal-token", NOW + 10)).toBe(true);
    expect(lookupPrincipalAccessToken(db, tokens.accessToken, RESOURCE, NOW + 11)).toBeNull();
    expect(listAccessOverview(db).principals[0]?.grants[0]?.credentials[0]?.revokedAt).toBe(
      NOW + 10,
    );

    const second = authorize(client.clientId, {
      kind: "existing-grant",
      grantId: grant.id,
      credentialLabel: "Machine B",
    });
    expect(lookupPrincipalAccessToken(db, second.accessToken, RESOURCE, NOW + 21)).not.toBeNull();
    expect(revokeAccessGrant(db, grant.id, "portal-token", NOW + 22)).toBe(true);
    expect(lookupPrincipalAccessToken(db, second.accessToken, RESOURCE, NOW + 23)).toBeNull();
  });

  test("removing the last connection takes the grant and the agent with it", () => {
    const client = publicClient();
    const tokens = authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Lone assistant",
      grantName: "Answer",
      rules: ANSWER_RULES,
      credentialLabel: "Only machine",
      expiresAt: null,
    });
    const before = listAccessOverview(db).principals[0]!;
    const credential = before.grants[0]!.credentials[0]!;

    expect(removeConnection(db, credential.id, "portal-token", NOW + 10)).toBe(true);
    expect(lookupPrincipalAccessToken(db, tokens.accessToken, RESOURCE, NOW + 11)).toBeNull();
    const after = listAccessOverview(db).principals[0]!;
    expect(after.revokedAt).toBe(NOW + 10);
    expect(after.grants[0]!.revokedAt).toBe(NOW + 10);
    expect(after.grants[0]!.credentials[0]!.revokedAt).toBe(NOW + 10);
    // Each step is the ordinary revoke, so each leaves its own audit event.
    expect(
      db
        .prepare<[], { event_type: string }>(
          "SELECT event_type FROM access_audit_events WHERE event_type LIKE '%-revoked' ORDER BY event_type",
        )
        .all()
        .map((row) => row.event_type),
    ).toEqual(["credential-revoked", "grant-revoked", "principal-revoked"]);
    // Removing it twice is refused, as revoking twice is.
    expect(removeConnection(db, credential.id, "portal-token", NOW + 12)).toBe(false);
  });

  test("removing one connection leaves a sibling on the same grant untouched", () => {
    const client = publicClient();
    const first = authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Shared assistant",
      grantName: "Answer",
      rules: ANSWER_RULES,
      credentialLabel: "Machine A",
      expiresAt: null,
    });
    const grant = listAccessOverview(db).principals[0]!.grants[0]!;
    const second = authorize(client.clientId, {
      kind: "existing-grant",
      grantId: grant.id,
      credentialLabel: "Machine B",
    });
    const overview = listAccessOverview(db);
    const machineA = overview.principals[0]!.grants[0]!.credentials.find(
      (c) => c.label === "Machine A",
    )!;

    expect(removeConnection(db, machineA.id, "portal-token", NOW + 30)).toBe(true);
    expect(lookupPrincipalAccessToken(db, first.accessToken, RESOURCE, NOW + 31)).toBeNull();
    expect(lookupPrincipalAccessToken(db, second.accessToken, RESOURCE, NOW + 31)).not.toBeNull();
    const after = listAccessOverview(db).principals[0]!;
    expect(after.revokedAt).toBeNull();
    expect(after.grants[0]!.revokedAt).toBeNull();
  });

  test("removing the last connection on one grant keeps an agent that holds another", () => {
    const client = publicClient();
    authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Two-profile assistant",
      grantName: "Answer",
      rules: ANSWER_RULES,
      credentialLabel: "Answer machine",
      expiresAt: null,
    });
    const principal = listAccessOverview(db).principals[0]!;
    const direct = authorize(client.clientId, {
      kind: "new-grant",
      principalId: principal.id,
      grantName: "Direct",
      rules: DIRECT_RULES,
      credentialLabel: "Direct machine",
      expiresAt: null,
    });
    const overview = listAccessOverview(db).principals[0]!;
    const answerGrant = overview.grants.find((g) => g.name === "Answer")!;

    expect(removeConnection(db, answerGrant.credentials[0]!.id, "portal-token", NOW + 40)).toBe(
      true,
    );
    const after = listAccessOverview(db).principals[0]!;
    expect(after.revokedAt).toBeNull();
    expect(after.grants.find((g) => g.name === "Answer")!.revokedAt).toBe(NOW + 40);
    expect(after.grants.find((g) => g.name === "Direct")!.revokedAt).toBeNull();
    expect(lookupPrincipalAccessToken(db, direct.accessToken, RESOURCE, NOW + 41)).not.toBeNull();
  });

  test("a pending sibling keeps the grant and the agent alive", () => {
    // A connection somebody is still in the middle of making is a reason not
    // to fence the grant it will land on.
    const client = publicClient();
    authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Half-connected assistant",
      grantName: "Answer",
      rules: ANSWER_RULES,
      credentialLabel: "Finished machine",
      expiresAt: null,
    });
    const grant = listAccessOverview(db).principals[0]!.grants[0]!;
    const pending = createAuthorizationRequest(
      db,
      {
        clientId: client.clientId,
        redirectUri: REDIRECT,
        codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: defaultAuthorizationScope(),
      },
      NOW + 50,
    );
    if (!pending.ok) throw new Error(pending.error);
    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: pending.value.id,
          decision: "approve",
          actorTokenId: "portal-token",
          selection: {
            kind: "existing-grant",
            grantId: grant.id,
            credentialLabel: "Unfinished machine",
          },
        },
        NOW + 51,
      ).ok,
    ).toBe(true);
    const finished = listAccessOverview(db).principals[0]!.grants[0]!.credentials.find(
      (c) => c.label === "Finished machine",
    )!;

    expect(removeConnection(db, finished.id, "portal-token", NOW + 60)).toBe(true);
    const after = listAccessOverview(db).principals[0]!;
    expect(after.revokedAt).toBeNull();
    expect(after.grants[0]!.revokedAt).toBeNull();
  });

  test("an expired sibling does not keep the grant alive", () => {
    // Expired cannot authenticate, so it is not a reason to leave the grant
    // and the agent standing.
    const client = publicClient();
    authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Expiring assistant",
      grantName: "Answer",
      rules: ANSWER_RULES,
      credentialLabel: "Old machine",
      expiresAt: null,
    });
    const grant = listAccessOverview(db).principals[0]!.grants[0]!;
    authorize(client.clientId, {
      kind: "existing-grant",
      grantId: grant.id,
      credentialLabel: "New machine",
    });
    const overview = listAccessOverview(db).principals[0]!.grants[0]!;
    const old = overview.credentials.find((c) => c.label === "Old machine")!;
    const fresh = overview.credentials.find((c) => c.label === "New machine")!;
    db.prepare("UPDATE principal_credentials SET expires_at = ? WHERE id = ?").run(NOW + 5, old.id);

    expect(removeConnection(db, fresh.id, "portal-token", NOW + 10)).toBe(true);
    const after = listAccessOverview(db).principals[0]!;
    expect(after.grants[0]!.revokedAt).toBe(NOW + 10);
    expect(after.revokedAt).toBe(NOW + 10);
  });

  test("removing a connection under an already-fenced grant still fences the agent", () => {
    // The grant step is a no-op the second time; what matters is that nothing
    // live is left standing, and the result never reports less fencing.
    const client = publicClient();
    authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Half-fenced assistant",
      grantName: "Answer",
      rules: ANSWER_RULES,
      credentialLabel: "Only machine",
      expiresAt: null,
    });
    const principal = listAccessOverview(db).principals[0]!;
    const grant = principal.grants[0]!;
    expect(revokeAccessGrant(db, grant.id, "portal-token", NOW + 5)).toBe(true);

    expect(removeConnection(db, grant.credentials[0]!.id, "portal-token", NOW + 10)).toBe(true);
    const after = listAccessOverview(db).principals[0]!;
    expect(after.grants[0]!.credentials[0]!.revokedAt).toBe(NOW + 10);
    expect(after.grants[0]!.revokedAt).toBe(NOW + 5);
    expect(after.revokedAt).toBe(NOW + 10);
    expect(
      db
        .prepare<[], { event_type: string }>(
          "SELECT event_type FROM access_audit_events WHERE event_type LIKE '%-revoked' ORDER BY occurred_at, event_type",
        )
        .all()
        .map((row) => row.event_type),
    ).toEqual(["grant-revoked", "credential-revoked", "principal-revoked"]);
  });

  test("removing a profile takes the agent with it only when it was the last one", () => {
    const client = publicClient();
    authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Two-profile assistant",
      grantName: "Answer",
      rules: ANSWER_RULES,
      credentialLabel: "Answer machine",
      expiresAt: null,
    });
    const principal = listAccessOverview(db).principals[0]!;
    authorize(client.clientId, {
      kind: "new-grant",
      principalId: principal.id,
      grantName: "Direct",
      rules: DIRECT_RULES,
      credentialLabel: "Direct machine",
      expiresAt: null,
    });
    const grants = listAccessOverview(db).principals[0]!.grants;
    const answer = grants.find((g) => g.name === "Answer")!;
    const direct = grants.find((g) => g.name === "Direct")!;

    expect(removeProfile(db, answer.id, "portal-token", NOW + 20)).toBe(true);
    let after = listAccessOverview(db).principals[0]!;
    expect(after.revokedAt).toBeNull();
    expect(after.grants.find((g) => g.name === "Answer")!.revokedAt).toBe(NOW + 20);

    expect(removeProfile(db, direct.id, "portal-token", NOW + 30)).toBe(true);
    after = listAccessOverview(db).principals[0]!;
    expect(after.revokedAt).toBe(NOW + 30);
    // Twice is refused, as for any revoke.
    expect(removeProfile(db, direct.id, "portal-token", NOW + 31)).toBe(false);
    expect(
      removeProfile(db, "00000000-0000-4000-8000-00000000dead", "portal-token", NOW + 31),
    ).toBe(false);
  });

  test("collecting an orphan leaves a grant that still has another credential", () => {
    // An orphan under an existing grant takes only itself: the grant and the
    // agent are somebody else's too.
    const client = publicClient();
    authorize(client.clientId, {
      kind: "new-principal",
      principalName: "Shared-grant assistant",
      grantName: "Answer",
      rules: ANSWER_RULES,
      credentialLabel: "Finished machine",
      expiresAt: null,
    });
    const grant = listAccessOverview(db).principals[0]!.grants[0]!;
    const pending = createAuthorizationRequest(
      db,
      {
        clientId: client.clientId,
        redirectUri: REDIRECT,
        codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: defaultAuthorizationScope(),
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
          actorTokenId: "portal-token",
          selection: { kind: "existing-grant", grantId: grant.id, credentialLabel: "Lost browser" },
        },
        NOW + 1,
      ).ok,
    ).toBe(true);
    db.prepare("DELETE FROM oauth_authorization_requests").run();

    expect(
      cleanupExpiredAccessStateBatch(
        db,
        "authorizationRequests",
        NOW + AUTHORIZATION_REQUEST_TTL_MS + 1,
      ).deleted,
    ).toBe(1);
    const after = listAccessOverview(db).principals[0]!;
    expect(after.grants).toHaveLength(1);
    expect(after.grants[0]!.credentials.map((c) => c.label)).toEqual(["Finished machine"]);
  });

  test("the next-due minimums are served by the expiry indexes", () => {
    for (const sql of [
      "SELECT MIN(authorization_code_expires_at) AS due FROM oauth_authorization_requests WHERE status = 'code-issued'",
      "SELECT MIN(expires_at) AS due FROM oauth_authorization_requests WHERE status != 'code-issued'",
    ]) {
      const plan = db
        .prepare<[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => row.detail)
        .join(" ");
      expect(plan, sql).not.toMatch(/SCAN oauth_authorization_requests(?! USING)/u);
      expect(plan, sql).toMatch(/idx_oauth_authorization_requests_/u);
    }
  });

  test("a pending credential whose request is gone is collected once its window has closed", () => {
    const client = publicClient();
    const pending = createAuthorizationRequest(
      db,
      {
        clientId: client.clientId,
        redirectUri: REDIRECT,
        codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: defaultAuthorizationScope(),
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
          actorTokenId: "portal-token",
          selection: {
            kind: "new-principal",
            principalName: "Orphaned assistant",
            grantName: "Answer",
            rules: ANSWER_RULES,
            credentialLabel: "Lost browser",
            expiresAt: null,
          },
        },
        NOW + 1,
      ).ok,
    ).toBe(true);
    // The request row leaves by some other path; the credential must not
    // become a permanent pending row because of it.
    db.prepare("DELETE FROM oauth_authorization_requests").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM principal_credentials").get()).toEqual({
      count: 1,
    });

    // Inside the window it is still a connection somebody may finish.
    expect(
      cleanupExpiredAccessStateBatch(
        db,
        "authorizationRequests",
        NOW + AUTHORIZATION_REQUEST_TTL_MS - 1,
      ).deleted,
    ).toBe(0);
    expect(
      cleanupExpiredAccessStateBatch(
        db,
        "authorizationRequests",
        NOW + AUTHORIZATION_REQUEST_TTL_MS + 1,
      ),
    ).toMatchObject({ phase: "authorizationRequests", deleted: 1, hasMore: false });
    expect(db.prepare("SELECT COUNT(*) AS count FROM principal_credentials").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_grants").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM access_principals").get()).toEqual({
      count: 0,
    });
  });

  test("the request sweep says when the soonest pending request falls due", () => {
    const client = publicClient();
    for (const ttlMs of [5_000, 2_000]) {
      const pending = createAuthorizationRequest(
        db,
        {
          clientId: client.clientId,
          redirectUri: REDIRECT,
          codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
          resource: RESOURCE,
          scope: defaultAuthorizationScope(),
          ttlMs,
        },
        NOW,
      );
      if (!pending.ok) throw new Error(pending.error);
    }
    expect(cleanupExpiredAccessStateBatch(db, "authorizationRequests", NOW)).toEqual({
      phase: "authorizationRequests",
      deleted: 0,
      hasMore: false,
      nextDueAt: NOW + 2_000,
    });
    // Nothing pending, nothing to wake for.
    expect(cleanupExpiredAccessStateBatch(db, "authorizationRequests", NOW + 6_000)).toEqual({
      phase: "authorizationRequests",
      deleted: 2,
      hasMore: false,
    });
  });
});

function publicClient() {
  return registerOAuthClient(
    db,
    {
      clientName: "Stellar MCP Client",
      redirectUris: [REDIRECT],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      clientUri: "https://example.com/client",
    },
    NOW,
  );
}

function insertPhone() {
  const phoneId = DeviceId("00000000-0000-4000-8000-000000000009");
  db.prepare(
    `INSERT INTO devices (id, name, kind, capabilities, paired_at)
     VALUES (?, 'Synthetic phone', 'ios', '{}', 1)`,
  ).run(phoneId);
  return phoneId;
}

function pendingAuthorization(clientId: string, scope = defaultAuthorizationScope()) {
  const pending = createAuthorizationRequest(
    db,
    {
      clientId,
      redirectUri: REDIRECT,
      state: "state-123",
      codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      resource: RESOURCE,
      scope,
    },
    NOW,
  );
  if (!pending.ok) throw new Error(`authorization request failed: ${pending.error}`);
  return pending.value;
}

function authorize(
  clientId: string,
  selection: Parameters<typeof decideAuthorizationRequest>[1]["selection"] & {},
  scope = defaultAuthorizationScope(),
) {
  return authorizeInteractiveAccess(db, {
    clientId,
    selection,
    resource: RESOURCE,
    scope,
    now: NOW,
  }).tokens;
}
