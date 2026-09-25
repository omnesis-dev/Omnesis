// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import { beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { commitPrivacyPolicy } from "../privacy/policy-history.js";
import {
  cleanupExpiredAccessStateBatch,
  createAccessLevel,
  createAuthorizationRequest,
  createExecutionBinding,
  decideAuthorizationRequest,
  defaultAuthorizationScope,
  deleteAccessLevel,
  exchangeAuthorizationCode,
  findConnectionProposal,
  getAuthorizationRequestById,
  issueAuthorizationCode,
  listAccessOverview,
  lookupPrincipalAccessToken,
  refreshPrincipalAccessToken,
  registerOAuthClient,
  reissueExecutionDeviceTokens,
  renameAccessPrincipal,
  revokeAccessGrant,
  revokeAccessPrincipal,
  updateAccessLevel,
} from "./store.js";
import { authorizeInteractiveAccess } from "./test-utils.js";
import type { Db } from "../data/types.js";
import type { AccessGrantRuleInput, AuthorizationDecisionSelection } from "./types.js";

/**
 * Every approval makes a new connection, unless the approver explicitly
 * replaces an existing one. A connection always carries an access level's
 * rules: a new level made from the approval, or an existing level it joins.
 */
const NOW = 1_800_000_000_000;
const RESOURCE = "https://gateway.example.org/mcp";
const REDIRECT = "http://127.0.0.1:48123/callback";
const VERIFIER = "v".repeat(64);
const DIRECT_RULES: AccessGrantRuleInput[] = [
  { capability: "direct", sources: { mode: "all", sourceIds: [] } },
];
const ANSWER_RULES: AccessGrantRuleInput[] = [
  {
    capability: "answer",
    sources: { mode: "all", sourceIds: [] },
    release: { mode: "reviewed", policyFamilyId: DEFAULT_PRIVACY_POLICY_FAMILY_ID },
  },
];

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
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

function registerClient(clientName: string): string {
  return registerOAuthClient(
    db,
    {
      clientName,
      redirectUris: [REDIRECT],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      clientUri: null,
    },
    NOW,
  ).clientId;
}

function pendingAuthorization(clientId: string, now = NOW, executionBinding?: string) {
  const pending = createAuthorizationRequest(
    db,
    {
      clientId,
      redirectUri: REDIRECT,
      state: "state-123",
      codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      resource: RESOURCE,
      scope: defaultAuthorizationScope(),
      ...(executionBinding ? { executionBinding } : {}),
    },
    now,
  );
  if (!pending.ok) throw new Error(`authorization request failed: ${pending.error}`);
  return pending.value;
}

function decide(approvalId: string, selection: AuthorizationDecisionSelection, now: number) {
  return decideAuthorizationRequest(
    db,
    { approvalId, decision: "approve", actorTokenId: "portal-token", selection },
    now,
  );
}

/** Issue and redeem the code of an approved request, as its client would. */
function complete(pending: { browserHandle: string }, clientId: string, now: number) {
  const issued = issueAuthorizationCode(db, pending.browserHandle, now);
  if (!issued.ok || issued.value.status !== "approved") throw new Error("code not issued");
  const exchanged = exchangeAuthorizationCode(
    db,
    {
      code: issued.value.code,
      clientId,
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
    },
    now + 1,
  );
  if (!exchanged.ok) throw new Error(`exchange failed: ${exchanged.error}`);
  return exchanged.value;
}

function connect(clientId: string, rules: AccessGrantRuleInput[], now = NOW) {
  return authorizeInteractiveAccess(db, {
    clientId,
    selection: { kind: "connect", rules },
    resource: RESOURCE,
    scope: defaultAuthorizationScope(),
    now,
  });
}

function seedSource(id: string) {
  db.exec(`
    INSERT OR IGNORE INTO devices (id, name, kind, capabilities, paired_at)
    VALUES ('source-device', 'Fictional collector', 'collector', '{}', 1);
    INSERT INTO sources
      (id, type, account_id, device_id, config, enabled, multi_device_mode, created_at, updated_at)
    VALUES ('${id}', 'files', 'fictional', 'source-device', '{}', 1, 'exclusive', 1, 1);
  `);
}

function executionBindingFor(clientId: string, now: number): string {
  db.prepare(
    `INSERT OR IGNORE INTO devices (id, name, kind, capabilities, paired_at) VALUES (?, ?, 'agent', ?, ?)`,
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
    now,
  );
  const binding = createExecutionBinding(
    db,
    { deviceId: "agent-device", oauthClientId: clientId, harness: "openclaw" },
    now,
  );
  if (!binding.ok) throw new Error("execution binding not created");
  return binding.value.binding;
}

function storedRequest(requestId: string) {
  return db
    .prepare<
      [string],
      { selection_json: string; credential_id: string; created_level_id: string | null }
    >("SELECT selection_json, credential_id, created_level_id FROM oauth_authorization_requests WHERE id = ?")
    .get(requestId)!;
}

function auditDetails(eventType: string): Array<Record<string, unknown>> {
  return db
    .prepare<[string], { detail: string }>(
      "SELECT detail FROM access_audit_events WHERE event_type = ? ORDER BY occurred_at, id",
    )
    .all(eventType)
    .map((row) => JSON.parse(row.detail) as Record<string, unknown>);
}

function grantSummary(principalId: string) {
  const principal = listAccessOverview(db, NOW + 1_000).principals.find(
    (candidate) => candidate.id === principalId,
  );
  return principal?.grants[0];
}

describe("legacy connect", () => {
  test("a client becomes a connection named after it, on a new level named after it", () => {
    const clientId = registerClient("  Nimbus MCP Notebook  ");
    const first = connect(clientId, DIRECT_RULES);

    const overview = listAccessOverview(db, NOW + 100);
    expect(overview.principals).toHaveLength(1);
    expect(overview.principals[0]).toMatchObject({
      id: first.principalId,
      name: "Nimbus MCP Notebook",
    });
    expect(overview.levels).toEqual([
      expect.objectContaining({ name: "Nimbus MCP Notebook", rules: DIRECT_RULES, revision: 1 }),
    ]);
    expect(overview.levels[0]?.connectionCount).toBe(1);
    expect(overview.principals[0]?.grants[0]).toMatchObject({
      id: first.grantId,
      name: "Nimbus MCP Notebook access",
      revision: 1,
      expiresAt: null,
      levelId: overview.levels[0]?.id,
      rules: DIRECT_RULES,
    });
    expect(overview.principals[0]?.grants[0]?.credentials[0]).toMatchObject({
      id: first.credentialId,
      label: "Nimbus MCP Notebook",
      clientName: "  Nimbus MCP Notebook  ",
      status: "active",
    });
  });

  test("the same client connecting again becomes a second connection and never changes the first", () => {
    const clientId = registerClient("Nimbus MCP Notebook");
    const first = connect(clientId, DIRECT_RULES);
    const second = connect(clientId, ANSWER_RULES, NOW + 100);

    expect(second.principalId).not.toBe(first.principalId);
    expect(second.grantId).not.toBe(first.grantId);
    const overview = listAccessOverview(db, NOW + 200);
    expect(overview.principals.map((principal) => principal.name)).toEqual([
      "Nimbus MCP Notebook",
      "Nimbus MCP Notebook 2",
    ]);
    expect(overview.levels.map((level) => level.name)).toEqual([
      "Nimbus MCP Notebook",
      "Nimbus MCP Notebook 2",
    ]);
    expect(grantSummary(first.principalId)).toMatchObject({ revision: 1, rules: DIRECT_RULES });
    expect(grantSummary(second.principalId)).toMatchObject({ revision: 1, rules: ANSWER_RULES });
    expect(
      db.prepare("SELECT 1 FROM access_audit_events WHERE event_type = 'grant-updated'").all(),
    ).toHaveLength(0);
    // The first connection's sign-in still works.
    expect(
      lookupPrincipalAccessToken(db, first.tokens.accessToken, RESOURCE, NOW + 300),
    ).toMatchObject({ principalId: first.principalId });
  });

  test("a name too long for the schema is cut to fit, suffix included", () => {
    const long = registerClient("N".repeat(200));
    connect(long, DIRECT_RULES);
    connect(long, DIRECT_RULES, NOW + 100);
    const [first, second] = listAccessOverview(db, NOW + 200).principals;
    expect(first?.name).toBe("N".repeat(120));
    expect(first?.grants[0]?.name).toBe(`${"N".repeat(113)} access`);
    expect(first?.grants[0]?.credentials[0]?.label).toBe("N".repeat(120));
    expect(second?.name).toBe(`${"N".repeat(118)} 2`);
  });

  test("a credential label longer than the schema allows is refused before anything is written", () => {
    const pending = pendingAuthorization(registerClient("Nimbus MCP Notebook"));
    expect(
      decide(
        pending.id,
        { kind: "connect", rules: DIRECT_RULES, credentialLabel: "L".repeat(161) },
        NOW + 1,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(listAccessOverview(db, NOW + 2)).toMatchObject({ principals: [], levels: [] });
  });

  test("a blank credential label falls back to the connection's name", () => {
    const pending = pendingAuthorization(registerClient("nimbus notebook"));
    expect(
      decide(pending.id, { kind: "connect", rules: DIRECT_RULES, credentialLabel: "   " }, NOW + 1),
    ).toMatchObject({ ok: true });
    expect(listAccessOverview(db, NOW + 2).principals[0]?.grants[0]?.credentials[0]?.label).toBe(
      "nimbus notebook",
    );
  });

  test("from a device that already holds a sign-in, it replaces that device's connection", () => {
    const clientId = registerClient("nimbus runtime");
    const first = pendingAuthorization(clientId, NOW, executionBindingFor(clientId, NOW));
    expect(decide(first.id, { kind: "connect", rules: ANSWER_RULES }, NOW + 1)).toMatchObject({
      ok: true,
    });
    const firstTokens = complete(first, clientId, NOW + 2);
    const connection = listAccessOverview(db, NOW + 10).principals[0]!;

    const again = pendingAuthorization(
      clientId,
      NOW + 100,
      executionBindingFor(clientId, NOW + 100),
    );
    expect(decide(again.id, { kind: "connect", rules: ANSWER_RULES }, NOW + 101)).toMatchObject({
      ok: true,
    });
    const stored = storedRequest(again.id);
    expect(JSON.parse(stored.selection_json)).toEqual({
      kind: "existing-grant",
      grantId: connection.grants[0]!.id,
      credentialLabel: "nimbus runtime",
      replaces: true,
    });
    expect(stored.created_level_id).toBeNull();

    const tokens = complete(again, clientId, NOW + 102);
    const overview = listAccessOverview(db, NOW + 110);
    expect(overview.principals.map((principal) => principal.id)).toEqual([connection.id]);
    expect(overview.levels).toHaveLength(1);
    expect(lookupPrincipalAccessToken(db, firstTokens.accessToken, RESOURCE, NOW + 110)).toBeNull();
    expect(lookupPrincipalAccessToken(db, tokens.accessToken, RESOURCE, NOW + 110)).toMatchObject({
      principalId: connection.id,
      credentialId: stored.credential_id,
    });
  });

  test("rules that point at nothing are refused and leave no level behind", () => {
    const pending = pendingAuthorization(registerClient("Nimbus MCP Notebook"));
    expect(
      decide(
        pending.id,
        {
          kind: "connect",
          rules: [
            { capability: "direct", sources: { mode: "allowlist", sourceIds: ["ghost:source"] } },
          ],
        },
        NOW + 1,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(listAccessOverview(db, NOW + 2)).toMatchObject({ principals: [], levels: [] });
    expect(
      db
        .prepare<
          [string],
          { status: string }
        >("SELECT status FROM oauth_authorization_requests WHERE id = ?")
        .get(pending.id),
    ).toEqual({ status: "pending" });
  });

  test("an execution-bound request refuses a connection without Answer", () => {
    const clientId = registerClient("Nimbus MCP Notebook");
    const bound = pendingAuthorization(clientId, NOW, executionBindingFor(clientId, NOW));
    expect(decide(bound.id, { kind: "connect", rules: DIRECT_RULES }, NOW + 1)).toEqual({
      ok: false,
      error: "invalid-selection",
    });
    expect(decide(bound.id, { kind: "connect", rules: ANSWER_RULES }, NOW + 2)).toMatchObject({
      ok: true,
      value: { status: "approved", requiresAnswer: true },
    });
  });
});

describe("new-connection", () => {
  test("on a new level: a named connection whose grant carries the level and whose sign-in bears the name", () => {
    const clientId = registerClient("Nimbus MCP Notebook");
    const pending = pendingAuthorization(clientId);
    expect(
      decide(
        pending.id,
        {
          kind: "new-connection",
          name: "  Research notebook ",
          level: { kind: "new", name: "Reading only", rules: DIRECT_RULES },
        },
        NOW + 1,
      ),
    ).toMatchObject({ ok: true });
    const overview = listAccessOverview(db, NOW + 2);
    expect(overview.levels).toEqual([
      expect.objectContaining({ name: "Reading only", connectionCount: 1 }),
    ]);
    expect(overview.principals[0]).toMatchObject({ name: "Research notebook" });
    expect(overview.principals[0]?.grants[0]).toMatchObject({
      name: "Research notebook access",
      levelId: overview.levels[0]?.id,
      rules: DIRECT_RULES,
      credentials: [expect.objectContaining({ label: "Research notebook", status: "pending" })],
    });
  });

  test("a new level whose name is already live, in any case, is refused and nothing is written", () => {
    connect(registerClient("Nimbus MCP Notebook"), DIRECT_RULES);
    const pending = pendingAuthorization(registerClient("orbit desk"), NOW + 10);
    expect(
      decide(
        pending.id,
        {
          kind: "new-connection",
          name: "orbit desk",
          level: { kind: "new", name: " nimbus mcp NOTEBOOK ", rules: DIRECT_RULES },
        },
        NOW + 11,
      ),
    ).toEqual({ ok: false, error: "level-name-taken" });
    const overview = listAccessOverview(db, NOW + 12);
    expect(overview.principals).toHaveLength(1);
    expect(overview.levels).toHaveLength(1);
  });

  test("on an existing level: the connection takes the level's rules, even a source that has since gone", () => {
    seedSource("files:fictional");
    const scoped: AccessGrantRuleInput[] = [
      { capability: "direct", sources: { mode: "allowlist", sourceIds: ["files:fictional"] } },
    ];
    const first = connect(registerClient("Nimbus MCP Notebook"), scoped);
    db.prepare("DELETE FROM sources WHERE id = ?").run("files:fictional");
    const levelId = grantSummary(first.principalId)!.levelId!;

    const pending = pendingAuthorization(registerClient("orbit desk"), NOW + 10);
    expect(
      decide(
        pending.id,
        {
          kind: "new-connection",
          name: "orbit desk",
          level: { kind: "existing", levelId, expectedLevelRevision: 1 },
        },
        NOW + 11,
      ),
    ).toMatchObject({ ok: true });
    const overview = listAccessOverview(db, NOW + 12);
    expect(overview.levels).toEqual([expect.objectContaining({ id: levelId, connectionCount: 2 })]);
    const joined = overview.principals.find((principal) => principal.name === "orbit desk");
    expect(joined?.grants[0]).toMatchObject({ levelId, revision: 1, rules: scoped });
    expect(getAuthorizationRequestById(db, pending.id, NOW + 12)?.selection).toMatchObject({
      kind: "new-principal",
      rules: scoped,
    });
  });

  test("an existing level whose revision a policy edit advanced refuses the revision shown before it", () => {
    const answers = createAccessLevel(
      db,
      { name: "answers", rules: ANSWER_RULES, actorTokenId: "portal-token" },
      NOW,
    );
    if (!answers.ok) throw new Error("level not created");
    commitPrivacyPolicy(db, {
      policy: "# Test policy\n\nAllow fewer fictional summaries.\n",
      digest: "c".repeat(64),
      revision: "d".repeat(64),
      expectedRevision: "b".repeat(64),
      action: "edit",
      revertedFromGeneration: null,
      createdAt: NOW + 5,
    });
    const pending = pendingAuthorization(registerClient("orbit desk"), NOW + 10);
    const onLevel = (expectedLevelRevision: number): AuthorizationDecisionSelection => ({
      kind: "new-connection",
      name: "orbit desk",
      level: { kind: "existing", levelId: answers.value.id, expectedLevelRevision },
    });
    expect(decide(pending.id, onLevel(1), NOW + 11)).toEqual({
      ok: false,
      error: "stale-revision",
    });
    expect(decide(pending.id, onLevel(2), NOW + 12)).toMatchObject({ ok: true });
  });

  test("a level with no rules to record cannot take a connection", () => {
    const level = createAccessLevel(
      db,
      { name: "reading only", rules: DIRECT_RULES, actorTokenId: "portal-token" },
      NOW,
    );
    if (!level.ok) throw new Error("level not created");
    db.prepare("DELETE FROM access_level_capabilities WHERE level_id = ?").run(level.value.id);
    const pending = pendingAuthorization(registerClient("orbit desk"), NOW + 10);
    expect(
      decide(
        pending.id,
        {
          kind: "new-connection",
          name: "orbit desk",
          level: { kind: "existing", levelId: level.value.id, expectedLevelRevision: 1 },
        },
        NOW + 11,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(listAccessOverview(db, NOW + 12).principals).toHaveLength(0);
  });

  test("an execution-bound request's new level needs Answer it can use today", () => {
    const unpublished = "00000000-0000-4000-8000-0000000000f1";
    db.prepare(
      `INSERT INTO privacy_policy_families (id, name, name_key, created_at, updated_at)
       VALUES (?, 'unpublished policy', 'unpublished policy', ?, ?)`,
    ).run(unpublished, NOW, NOW);
    const clientId = registerClient("nimbus runtime");
    const bound = pendingAuthorization(clientId, NOW, executionBindingFor(clientId, NOW));
    expect(
      decide(
        bound.id,
        {
          kind: "new-connection",
          name: "nimbus runtime",
          level: {
            kind: "new",
            name: "unpublished answers",
            rules: [
              {
                capability: "answer",
                sources: { mode: "all", sourceIds: [] },
                release: { mode: "reviewed", policyFamilyId: unpublished },
              },
            ],
          },
        },
        NOW + 1,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(listAccessOverview(db, NOW + 2)).toMatchObject({ principals: [], levels: [] });
  });

  test("an existing level refuses a stale revision and a retired level", () => {
    const level = createAccessLevel(
      db,
      { name: "Reading only", rules: DIRECT_RULES, actorTokenId: "portal-token" },
      NOW,
    );
    if (!level.ok) throw new Error("level not created");
    const pending = pendingAuthorization(registerClient("orbit desk"), NOW + 10);
    const onLevel = (expectedLevelRevision: number): AuthorizationDecisionSelection => ({
      kind: "new-connection",
      name: "orbit desk",
      level: { kind: "existing", levelId: level.value.id, expectedLevelRevision },
    });
    expect(decide(pending.id, onLevel(2), NOW + 11)).toEqual({
      ok: false,
      error: "stale-revision",
    });
    expect(
      deleteAccessLevel(db, { levelId: level.value.id, actorTokenId: "portal-token" }, NOW + 12),
    ).toEqual({ ok: true, value: null });
    expect(decide(pending.id, onLevel(1), NOW + 13)).toEqual({
      ok: false,
      error: "inactive-grant",
    });
    expect(listAccessOverview(db, NOW + 14).principals).toHaveLength(0);
  });

  test("an execution-bound request cannot join a level without Answer", () => {
    const level = createAccessLevel(
      db,
      { name: "Reading only", rules: DIRECT_RULES, actorTokenId: "portal-token" },
      NOW,
    );
    if (!level.ok) throw new Error("level not created");
    const clientId = registerClient("Nimbus MCP Notebook");
    const bound = pendingAuthorization(clientId, NOW, executionBindingFor(clientId, NOW));
    expect(
      decide(
        bound.id,
        {
          kind: "new-connection",
          name: "Nimbus",
          level: { kind: "existing", levelId: level.value.id, expectedLevelRevision: 1 },
        },
        NOW + 1,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(
      decide(
        bound.id,
        {
          kind: "new-connection",
          name: "Nimbus",
          level: { kind: "new", name: "Direct without Answer", rules: DIRECT_RULES },
        },
        NOW + 2,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
  });
});

describe("replace-connection", () => {
  test("the new sign-in joins the chosen connection and retires the others once it is used", () => {
    const clientId = registerClient("Nimbus MCP Notebook");
    const first = connect(clientId, DIRECT_RULES);
    const again = pendingAuthorization(clientId, NOW + 100);
    expect(
      decide(
        again.id,
        { kind: "replace-connection", connectionId: first.principalId, expectedGrantRevision: 1 },
        NOW + 101,
      ),
    ).toMatchObject({ ok: true });
    const stored = db
      .prepare<
        [string],
        { selection_json: string; credential_id: string }
      >("SELECT selection_json, credential_id FROM oauth_authorization_requests WHERE id = ?")
      .get(again.id)!;
    expect(JSON.parse(stored.selection_json)).toEqual({
      kind: "existing-grant",
      grantId: first.grantId,
      credentialLabel: "Nimbus MCP Notebook",
      replaces: true,
    });
    // Until the new sign-in is used, the old one keeps working.
    expect(
      lookupPrincipalAccessToken(db, first.tokens.accessToken, RESOURCE, NOW + 102),
    ).not.toBeNull();

    const tokens = complete(again, clientId, NOW + 103);
    expect(
      lookupPrincipalAccessToken(db, first.tokens.accessToken, RESOURCE, NOW + 110),
    ).toBeNull();
    expect(lookupPrincipalAccessToken(db, tokens.accessToken, RESOURCE, NOW + 110)).toMatchObject({
      principalId: first.principalId,
      grantId: first.grantId,
      credentialId: stored.credential_id,
    });
    const overview = listAccessOverview(db, NOW + 110);
    expect(overview.principals).toHaveLength(1);
    expect(overview.principals[0]?.grants[0]?.credentials).toEqual([
      expect.objectContaining({ id: first.credentialId, revokedAt: NOW + 104 }),
      expect.objectContaining({ id: stored.credential_id, status: "active", revokedAt: null }),
    ]);
    expect(
      db
        .prepare<[], { credential_id: string; detail: string }>(
          "SELECT credential_id, detail FROM access_audit_events WHERE event_type = 'credential-revoked'",
        )
        .all()
        .map((row) => ({ credentialId: row.credential_id, detail: JSON.parse(row.detail) })),
    ).toEqual([
      {
        credentialId: first.credentialId,
        detail: { replacedByCredentialId: stored.credential_id },
      },
    ]);
  });

  test("completing it revokes every other active sign-in, and a sign-in still waiting for its code is left to finish", () => {
    const clientId = registerClient("nimbus notebook");
    const first = connect(clientId, DIRECT_RULES);
    const second = authorizeInteractiveAccess(db, {
      clientId,
      selection: { kind: "existing-grant", grantId: first.grantId, credentialLabel: "second" },
      resource: RESOURCE,
      scope: defaultAuthorizationScope(),
      now: NOW + 50,
    });
    const waiting = pendingAuthorization(clientId, NOW + 60);
    expect(
      decide(
        waiting.id,
        { kind: "existing-grant", grantId: first.grantId, credentialLabel: "waiting" },
        NOW + 61,
      ),
    ).toMatchObject({ ok: true });
    const again = pendingAuthorization(clientId, NOW + 100);
    expect(
      decide(
        again.id,
        { kind: "replace-connection", connectionId: first.principalId, expectedGrantRevision: 1 },
        NOW + 101,
      ),
    ).toMatchObject({ ok: true });
    complete(again, clientId, NOW + 103);

    const byId = new Map(
      listAccessOverview(db, NOW + 110).principals[0]!.grants[0]!.credentials.map((credential) => [
        credential.id,
        credential,
      ]),
    );
    expect(byId.get(first.credentialId)?.revokedAt).toBe(NOW + 104);
    expect(byId.get(second.credentialId)?.revokedAt).toBe(NOW + 104);
    const waitingCredentialId = storedRequest(waiting.id).credential_id;
    expect(byId.get(waitingCredentialId)).toMatchObject({ status: "pending", revokedAt: null });
    expect(
      auditDetails("credential-revoked").map((detail) => detail.replacedByCredentialId),
    ).toEqual([storedRequest(again.id).credential_id, storedRequest(again.id).credential_id]);

    // The replaced sign-ins' refresh tokens no longer refresh.
    for (const replaced of [first, second]) {
      expect(
        refreshPrincipalAccessToken(
          db,
          { refreshToken: replaced.tokens.refreshToken!, clientId },
          NOW + 120,
        ).ok,
      ).toBe(false);
    }
    // The waiting sign-in still completes on its own.
    expect(() => complete(waiting, clientId, NOW + 130)).not.toThrow();
  });

  test("the device's re-issue hands out the sign-in that replaced its old one", () => {
    const clientId = registerClient("nimbus runtime");
    const first = pendingAuthorization(clientId, NOW, executionBindingFor(clientId, NOW));
    expect(decide(first.id, { kind: "connect", rules: ANSWER_RULES }, NOW + 1)).toMatchObject({
      ok: true,
    });
    complete(first, clientId, NOW + 2);
    const principalId = listAccessOverview(db, NOW + 3).principals[0]!.id;
    const again = pendingAuthorization(
      clientId,
      NOW + 100,
      executionBindingFor(clientId, NOW + 100),
    );
    expect(
      decide(
        again.id,
        { kind: "replace-connection", connectionId: principalId, expectedGrantRevision: 1 },
        NOW + 101,
      ),
    ).toMatchObject({ ok: true });
    complete(again, clientId, NOW + 102);

    const reissued = reissueExecutionDeviceTokens(
      db,
      { deviceId: "agent-device", oauthClientId: clientId },
      NOW + 200,
    );
    if (!reissued.ok) throw new Error(`re-issue refused: ${reissued.error}`);
    expect(
      lookupPrincipalAccessToken(db, reissued.value.accessToken, RESOURCE, NOW + 201),
    ).toMatchObject({ principalId, credentialId: storedRequest(again.id).credential_id });
  });

  test("a replacement that is never used revokes nothing, and its reaping leaves the level", () => {
    const clientId = registerClient("Nimbus MCP Notebook");
    const first = connect(clientId, DIRECT_RULES);
    const again = pendingAuthorization(clientId, NOW + 100);
    expect(
      decide(
        again.id,
        { kind: "replace-connection", connectionId: first.principalId, expectedGrantRevision: 1 },
        NOW + 101,
      ),
    ).toMatchObject({ ok: true });
    cleanupExpiredAccessStateBatch(db, "authorizationRequests", NOW + 60 * 60_000);

    const overview = listAccessOverview(db, NOW + 60 * 60_000);
    expect(overview.levels).toHaveLength(1);
    expect(overview.principals[0]?.grants[0]?.credentials).toEqual([
      expect.objectContaining({ id: first.credentialId, revokedAt: null }),
    ]);
  });

  test("a stale revision or a removed connection refuses the replacement", () => {
    const clientId = registerClient("Nimbus MCP Notebook");
    const first = connect(clientId, DIRECT_RULES);
    const again = pendingAuthorization(clientId, NOW + 100);
    const replace = (expectedGrantRevision: number): AuthorizationDecisionSelection => ({
      kind: "replace-connection",
      connectionId: first.principalId,
      expectedGrantRevision,
    });
    expect(decide(again.id, replace(2), NOW + 101)).toEqual({ ok: false, error: "stale-revision" });
    expect(revokeAccessPrincipal(db, first.principalId, "portal-token", NOW + 102)).toBe(true);
    expect(decide(again.id, replace(1), NOW + 103)).toEqual({ ok: false, error: "inactive-grant" });
  });

  test("an execution-bound replacement needs Answer on the connection it replaces", () => {
    const clientId = registerClient("Nimbus MCP Notebook");
    const first = connect(clientId, DIRECT_RULES);
    const bound = pendingAuthorization(
      clientId,
      NOW + 100,
      executionBindingFor(clientId, NOW + 100),
    );
    expect(
      decide(
        bound.id,
        { kind: "replace-connection", connectionId: first.principalId, expectedGrantRevision: 1 },
        NOW + 101,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
  });
});

describe("primitives", () => {
  test("new-principal and new-grant land on a new level named after the principal", () => {
    const clientId = registerClient("Nimbus MCP Notebook");
    const first = authorizeInteractiveAccess(db, {
      clientId,
      selection: {
        kind: "new-principal",
        principalName: "Report agent",
        grantName: "Reports",
        rules: DIRECT_RULES,
        credentialLabel: "Laptop",
        expiresAt: null,
      },
      resource: RESOURCE,
      scope: defaultAuthorizationScope(),
      now: NOW,
    });
    const second = authorizeInteractiveAccess(db, {
      clientId,
      selection: {
        kind: "new-grant",
        principalId: first.principalId,
        grantName: "Answers",
        rules: ANSWER_RULES,
        credentialLabel: "Laptop",
        expiresAt: null,
      },
      resource: RESOURCE,
      scope: defaultAuthorizationScope(),
      now: NOW + 100,
    });
    const overview = listAccessOverview(db, NOW + 200);
    expect(overview.levels.map((level) => [level.name, level.rules])).toEqual([
      ["Report agent", DIRECT_RULES],
      ["Report agent 2", ANSWER_RULES],
    ]);
    const grants = overview.principals[0]!.grants;
    expect(grants.find((grant) => grant.id === first.grantId)?.levelId).toBe(
      overview.levels[0]?.id,
    );
    expect(grants.find((grant) => grant.id === second.grantId)?.levelId).toBe(
      overview.levels[1]?.id,
    );
  });
});

describe("connection proposal", () => {
  test("an unknown client is offered a new level under its own name", () => {
    const pending = pendingAuthorization(registerClient("Nimbus MCP Notebook"));
    expect(findConnectionProposal(db, pending.id, NOW + 1)).toEqual({
      defaultName: "Nimbus MCP Notebook",
      defaultLevelName: "Nimbus MCP Notebook",
      match: null,
      recommended: "new-level",
    });
  });

  test("the same client is matched through its registration and offered the level it uses", () => {
    const clientId = registerClient("Nimbus MCP Notebook");
    const first = connect(clientId, DIRECT_RULES);
    expect(
      renameAccessPrincipal(
        db,
        {
          principalId: first.principalId,
          name: "Nimbus (workstation)",
          actorTokenId: "portal-token",
        },
        NOW + 50,
      ),
    ).toMatchObject({ ok: true });
    const pending = pendingAuthorization(clientId, NOW + 100);
    const proposal = findConnectionProposal(db, pending.id, NOW + 101);
    expect(proposal).toMatchObject({
      defaultName: "Nimbus MCP Notebook",
      defaultLevelName: "Nimbus MCP Notebook 2",
      match: {
        connectionId: first.principalId,
        connectionName: "Nimbus (workstation)",
        matchedBy: "client",
        levelId: grantSummary(first.principalId)?.levelId,
        grant: { id: first.grantId, revision: 1, rules: DIRECT_RULES },
      },
      recommended: "existing-level",
    });
  });

  test("another registration under the same client name matches by that name, in any case", () => {
    const first = connect(registerClient("Nimbus MCP Notebook"), DIRECT_RULES);
    const pending = pendingAuthorization(registerClient(" nimbus mcp NOTEBOOK"), NOW + 100);
    expect(findConnectionProposal(db, pending.id, NOW + 101)).toMatchObject({
      defaultName: "nimbus mcp NOTEBOOK 2",
      match: { connectionId: first.principalId, matchedBy: "name" },
      recommended: "existing-level",
    });
  });

  test("a sign-in bound to the request's device is recommended for replacement", () => {
    const clientId = registerClient("Nimbus MCP Notebook");
    const bound = pendingAuthorization(clientId, NOW, executionBindingFor(clientId, NOW));
    expect(decide(bound.id, { kind: "connect", rules: ANSWER_RULES }, NOW + 1)).toMatchObject({
      ok: true,
    });
    complete(bound, clientId, NOW + 2);
    const principalId = listAccessOverview(db, NOW + 3).principals[0]!.id;

    // A refresh from the same device arrives under a fresh registration.
    const reinstalled = registerClient("Different integration name");
    const refresh = pendingAuthorization(
      reinstalled,
      NOW + 100,
      executionBindingFor(reinstalled, NOW + 100),
    );
    expect(findConnectionProposal(db, refresh.id, NOW + 101)).toMatchObject({
      match: { connectionId: principalId, matchedBy: "device" },
      recommended: "replace",
    });
  });

  test("a removed connection is never matched; one still waiting to redeem its code is", () => {
    const clientId = registerClient("Nimbus MCP Notebook");
    const first = connect(clientId, DIRECT_RULES);
    expect(revokeAccessGrant(db, first.grantId, "portal-token", NOW + 50)).toBe(true);
    const unused = pendingAuthorization(clientId, NOW + 100);
    expect(findConnectionProposal(db, unused.id, NOW + 101)).toMatchObject({
      match: null,
      recommended: "new-level",
    });

    expect(decide(unused.id, { kind: "connect", rules: DIRECT_RULES }, NOW + 102)).toMatchObject({
      ok: true,
    });
    const later = pendingAuthorization(clientId, NOW + 200);
    expect(findConnectionProposal(db, later.id, NOW + 201)).toMatchObject({
      match: { matchedBy: "client", connectionName: "Nimbus MCP Notebook 2" },
      recommended: "existing-level",
    });
    expect(findConnectionProposal(db, "00000000-0000-4000-8000-00000000abcd", NOW)).toBeNull();
  });
});

describe("cleanup", () => {
  const LATER = NOW + 60 * 60_000;

  test("an abandoned approval takes its connection and the level it made with it", () => {
    const legacy = pendingAuthorization(registerClient("nimbus notebook"));
    expect(decide(legacy.id, { kind: "connect", rules: DIRECT_RULES }, NOW + 1)).toMatchObject({
      ok: true,
    });
    const named = pendingAuthorization(registerClient("orbit desk"));
    expect(
      decide(
        named.id,
        {
          kind: "new-connection",
          name: "orbit desk",
          level: { kind: "new", name: "reading only", rules: DIRECT_RULES },
        },
        NOW + 2,
      ),
    ).toMatchObject({ ok: true });
    const shared = createAccessLevel(
      db,
      { name: "shared answers", rules: ANSWER_RULES, actorTokenId: "portal-token" },
      NOW,
    );
    if (!shared.ok) throw new Error("level not created");
    const joined = pendingAuthorization(registerClient("comet desk"));
    expect(
      decide(
        joined.id,
        {
          kind: "new-connection",
          name: "comet desk",
          level: { kind: "existing", levelId: shared.value.id, expectedLevelRevision: 1 },
        },
        NOW + 3,
      ),
    ).toMatchObject({ ok: true });

    cleanupExpiredAccessStateBatch(db, "authorizationRequests", LATER);
    const overview = listAccessOverview(db, LATER);
    expect(overview.principals).toHaveLength(0);
    expect(overview.levels.map((level) => level.name)).toEqual(["shared answers"]);
    expect(auditDetails("level-deleted")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "nimbus notebook",
          abandonedAuthorizationRequestId: legacy.id,
        }),
        expect.objectContaining({
          name: "reading only",
          abandonedAuthorizationRequestId: named.id,
        }),
      ]),
    );
    expect(auditDetails("level-deleted")).toHaveLength(2);
  });

  test("a level another approval chose, or someone edited, while the approval waited is kept", () => {
    const first = pendingAuthorization(registerClient("nimbus notebook"));
    expect(decide(first.id, { kind: "connect", rules: DIRECT_RULES }, NOW + 1)).toMatchObject({
      ok: true,
    });
    const chosenId = listAccessOverview(db, NOW + 2).levels[0]!.id;
    const chooser = pendingAuthorization(registerClient("orbit desk"), NOW + 2);
    expect(
      decide(
        chooser.id,
        {
          kind: "new-connection",
          name: "orbit desk",
          level: { kind: "existing", levelId: chosenId, expectedLevelRevision: 1 },
        },
        NOW + 3,
      ),
    ).toMatchObject({ ok: true });
    const edited = pendingAuthorization(registerClient("comet desk"), NOW + 4);
    expect(
      decide(
        edited.id,
        {
          kind: "new-connection",
          name: "comet desk",
          level: { kind: "new", name: "comet", rules: DIRECT_RULES },
        },
        NOW + 5,
      ),
    ).toMatchObject({ ok: true });
    const cometId = listAccessOverview(db, NOW + 6).levels.find(
      (level) => level.name === "comet",
    )!.id;
    expect(
      updateAccessLevel(
        db,
        {
          levelId: cometId,
          expectedRevision: 1,
          name: "comet renamed",
          actorTokenId: "portal-token",
        },
        NOW + 6,
      ),
    ).toMatchObject({ ok: true });

    cleanupExpiredAccessStateBatch(db, "authorizationRequests", LATER);
    const overview = listAccessOverview(db, LATER);
    expect(overview.principals).toHaveLength(0);
    expect(overview.levels.map((level) => level.name)).toEqual([
      "comet renamed",
      "nimbus notebook",
    ]);
  });

  test("a level any grant still refers to, even a revoked one, is kept", () => {
    const done = connect(registerClient("nimbus notebook"), DIRECT_RULES);
    expect(revokeAccessGrant(db, done.grantId, "portal-token", NOW + 50)).toBe(true);
    cleanupExpiredAccessStateBatch(db, "authorizationRequests", LATER);
    expect(listAccessOverview(db, LATER).levels).toEqual([
      expect.objectContaining({ name: "nimbus notebook", connectionCount: 0 }),
    ]);
  });
});
