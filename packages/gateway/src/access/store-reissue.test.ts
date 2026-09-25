// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Headless recovery of a harness's corpus access, and the state that says it
 * is needed.
 *
 * The interesting question is not whether re-issue works — it is whether it
 * can ever become a way to obtain authority nobody approved. A stolen
 * management token reaches this code; the tests below fix what it can do with
 * it, and what happens the moment the operator takes the grant away.
 */

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import { beforeEach, describe, expect, test } from "vitest";

import { runSchemaSetup } from "../data/schema.js";
import { commitPrivacyPolicy } from "../privacy/policy-history.js";
import {
  agentDeviceAuthorizations,
  agentDeviceRevocationImpacts,
  createAccessTables,
  createAuthorizationRequest,
  createExecutionBinding,
  decideAuthorizationRequest,
  defaultAuthorizationScope,
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  lookupPrincipalAccessToken,
  refreshPrincipalAccessToken,
  registerOAuthClient,
  reissueExecutionDeviceTokens,
  revokeAccessGrant,
} from "./store.js";
import type { Db } from "../data/types.js";

const NOW = 1_800_000_000_000;
const RESOURCE = "https://gateway.example.org/mcp";
const REDIRECT = "http://127.0.0.1:48123/callback";
const VERIFIER = "v".repeat(64);
const ANSWER_RULES = [
  {
    capability: "answer" as const,
    sources: { mode: "all" as const, sourceIds: [] },
    release: { mode: "reviewed" as const, policyFamilyId: DEFAULT_PRIVACY_POLICY_FAMILY_ID },
  },
];

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  createAccessTables(db);
  commitPrivacyPolicy(db, {
    policy: "# Fictional policy\n\nAllow invented summaries.\n",
    digest: "a".repeat(64),
    revision: "b".repeat(64),
    expectedRevision: null,
    action: "bootstrap",
    revertedFromGeneration: null,
    createdAt: NOW - 1,
  });
});

describe("re-issuing an agent device's approved OAuth credential", () => {
  test("re-keys the credential the operator approved for that exact device", () => {
    const enrolled = enrolAgent("agent-openclaw", "openclaw");

    const reissued = reissueExecutionDeviceTokens(
      db,
      { deviceId: "agent-openclaw", oauthClientId: enrolled.clientId },
      NOW + 100,
    );
    expect(reissued).toMatchObject({
      ok: true,
      value: {
        accessToken: expect.stringMatching(/^omn_oat_/u),
        refreshToken: expect.stringMatching(/^omn_ort_/u),
        scope: defaultAuthorizationScope(),
      },
    });
    if (!reissued.ok) throw new Error("re-issue refused");

    // The new bearer is the same authority, not a new one: the same credential,
    // the same grant, the audience and scope the operator approved.
    const looked = lookupPrincipalAccessToken(db, reissued.value.accessToken, RESOURCE, NOW + 101);
    expect(looked).toMatchObject({
      credentialId: enrolled.credentialId,
      grantId: enrolled.grantId,
      executionDeviceId: "agent-openclaw",
    });
    expect(credentialCount()).toBe(1);
    expect(grantCount()).toBe(1);
    expect(auditEvents()).toContain("execution-credential-reissued");
  });

  test("leaves a ticket the plugin may still be holding usable", () => {
    // Recovery normally runs because the old ticket is dead, but it also runs
    // when the plugin never saw the reply to a previous one. Retiring that
    // ticket without marking it used would make the plugin's next ordinary
    // refresh look like a stolen-token replay — which revokes the credential
    // outright and strands the harness on the browser flow this route exists
    // to avoid.
    const enrolled = enrolAgent("agent-openclaw", "openclaw");
    const original = enrolled.refreshToken;
    // The enrolment always issues one; assert it rather than assume it, so a
    // change that stopped issuing refresh tokens fails here with a clear
    // message instead of further down on an undefined trade.
    if (original === undefined) throw new Error("enrolment issued no refresh token");

    const reissued = reissueExecutionDeviceTokens(
      db,
      { deviceId: "agent-openclaw", oauthClientId: enrolled.clientId },
      NOW + 100,
    );
    if (!reissued.ok) throw new Error("re-issue refused");
    expect(reissued.value.refreshToken).not.toBe(original);

    const traded = refreshPrincipalAccessToken(
      db,
      { refreshToken: original, clientId: enrolled.clientId, resource: RESOURCE },
      NOW + 200,
    );
    expect(traded.ok).toBe(true);
    // And no false alarm: the credential is still live and nothing was logged
    // as a replay.
    expect(activeCredentialCount()).toBe(1);
    expect(auditEvents()).not.toContain("refresh-token-replay-detected");
  });

  test("mints no refresh token for a client that never registered the grant", () => {
    const enrolled = enrolAgent("agent-openclaw", "openclaw", ["authorization_code"]);

    const reissued = reissueExecutionDeviceTokens(
      db,
      { deviceId: "agent-openclaw", oauthClientId: enrolled.clientId },
      NOW + 100,
    );
    if (!reissued.ok) throw new Error("re-issue refused");
    // The authorization-code exchange honours the registration; taking the
    // recovery route must not be a way around it.
    expect(reissued.value.refreshToken).toBeUndefined();
  });

  test("refuses once the operator revokes the grant, and cannot re-create it", () => {
    const enrolled = enrolAgent("agent-openclaw", "openclaw");
    expect(revokeAccessGrant(db, enrolled.grantId, "portal-token", NOW + 50)).toBe(true);

    expect(
      reissueExecutionDeviceTokens(
        db,
        { deviceId: "agent-openclaw", oauthClientId: enrolled.clientId },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "inactive-grant" });
    // Nothing was minted to replace it: this route can only ever find an
    // existing approval, never manufacture one.
    expect(credentialCount()).toBe(1);
    expect(grantCount()).toBe(1);
    expect(activeCredentialCount()).toBe(0);
  });

  test("refuses a device that was never approved for any credential", () => {
    insertAgentDevice("agent-hermes", "hermes");
    const client = publicClient();

    expect(
      reissueExecutionDeviceTokens(
        db,
        { deviceId: "agent-hermes", oauthClientId: client.clientId },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "not-found" });
    expect(credentialCount()).toBe(0);
  });

  test("cannot reach another device's credential", () => {
    const enrolled = enrolAgent("agent-openclaw", "openclaw");
    insertAgentDevice("agent-hermes", "hermes");

    // A stolen management token identifies its own device and nothing else,
    // so naming a sibling's OAuth client buys the caller nothing.
    expect(
      reissueExecutionDeviceTokens(
        db,
        { deviceId: "agent-hermes", oauthClientId: enrolled.clientId },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "not-found" });
  });

  test("cannot name an OAuth client the device is not bound to", () => {
    enrolAgent("agent-openclaw", "openclaw");
    const other = publicClient("Unrelated MCP Client");

    expect(
      reissueExecutionDeviceTokens(
        db,
        { deviceId: "agent-openclaw", oauthClientId: other.clientId },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "not-found" });
  });

  test("refuses a revoked device", () => {
    const enrolled = enrolAgent("agent-openclaw", "openclaw");
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(NOW + 10, "agent-openclaw");

    expect(
      reissueExecutionDeviceTokens(
        db,
        { deviceId: "agent-openclaw", oauthClientId: enrolled.clientId },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "not-found" });
  });

  test("re-keys a credential whose refresh token has already expired", () => {
    // The motivating case: nobody asked this installation anything for a
    // month, so there is no ticket left to trade.
    const enrolled = enrolAgent("agent-openclaw", "openclaw");
    const lapsed = NOW + 31 * 24 * 60 * 60_000;
    expect(agentDeviceAuthorizations(db, lapsed).get("agent-openclaw")).toEqual({
      status: "needs-reauthorization",
      remedy: "omnesis connect openclaw --refresh",
    });

    const reissued = reissueExecutionDeviceTokens(
      db,
      { deviceId: "agent-openclaw", oauthClientId: enrolled.clientId },
      lapsed,
    );
    expect(reissued.ok).toBe(true);
    expect(agentDeviceAuthorizations(db, lapsed + 1).get("agent-openclaw")).toEqual({
      status: "authorized",
    });
  });
});

describe("which agent devices can still reach the corpus", () => {
  test("names the principal and grant whose live authority device revocation ends", () => {
    const enrolled = enrolAgent("agent-openclaw", "openclaw");

    expect(agentDeviceRevocationImpacts(db, NOW + 10).get("agent-openclaw")).toEqual({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      corpusCredentials: [
        {
          credentialLabel: "openclaw runtime",
          principalName: "Fictional openclaw assistant",
          grantName: "Reviewed answer",
        },
      ],
      corpusAccess: [
        {
          credentialLabel: "openclaw runtime",
          principalName: "Fictional openclaw assistant",
          grantName: "Reviewed answer",
        },
      ],
    });

    expect(revokeAccessGrant(db, enrolled.grantId, "portal-token", NOW + 20)).toBe(true);
    expect(agentDeviceRevocationImpacts(db, NOW + 21).get("agent-openclaw")).toMatchObject({
      corpusCredentials: [],
      corpusAccess: [],
    });
  });

  test("separates a bound credential from already-lapsed OAuth authority", () => {
    enrolAgent("agent-hermes", "hermes");
    const afterRefreshExpiry = NOW + 31 * 24 * 60 * 60_000;

    expect(agentDeviceRevocationImpacts(db, afterRefreshExpiry).get("agent-hermes")).toEqual({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      corpusCredentials: [
        {
          credentialLabel: "hermes runtime",
          principalName: "Fictional hermes assistant",
          grantName: "Reviewed answer",
        },
      ],
      corpusAccess: [],
    });
  });

  test("does not call an access-only token live after its grant revision changes", () => {
    const enrolled = enrolAgent("agent-openclaw", "openclaw", ["authorization_code"]);
    expect(
      agentDeviceRevocationImpacts(db, NOW + 10).get("agent-openclaw")?.corpusAccess,
    ).toHaveLength(1);

    db.prepare("UPDATE access_grants SET revision = revision + 1 WHERE id = ?").run(
      enrolled.grantId,
    );

    expect(lookupPrincipalAccessToken(db, enrolled.accessToken, RESOURCE, NOW + 11)).toBeNull();
    expect(agentDeviceRevocationImpacts(db, NOW + 11).get("agent-openclaw")).toEqual({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      corpusCredentials: [
        {
          credentialLabel: "openclaw runtime",
          principalName: "Fictional openclaw assistant",
          grantName: "Reviewed answer",
        },
      ],
      corpusAccess: [],
    });
  });

  test("reports every bound credential, including one pending token exchange", () => {
    const enrolled = enrolAgent("agent-openclaw", "openclaw");
    db.prepare(
      `INSERT INTO principal_credentials
         (id, grant_id, oauth_client_id, kind, status, label, execution_device_id, created_at)
       VALUES (?, ?, ?, 'interactive', 'pending', ?, 'agent-openclaw', ?)`,
    ).run("pending-credential", enrolled.grantId, enrolled.clientId, "secondary runtime", NOW + 6);

    expect(agentDeviceRevocationImpacts(db, NOW + 10).get("agent-openclaw")).toEqual({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      corpusCredentials: [
        {
          credentialLabel: "openclaw runtime",
          principalName: "Fictional openclaw assistant",
          grantName: "Reviewed answer",
        },
        {
          credentialLabel: "secondary runtime",
          principalName: "Fictional openclaw assistant",
          grantName: "Reviewed answer",
        },
      ],
      corpusAccess: [
        {
          credentialLabel: "openclaw runtime",
          principalName: "Fictional openclaw assistant",
          grantName: "Reviewed answer",
        },
      ],
    });
  });

  test("names the harness's own repair command when the grant is revoked", () => {
    const enrolled = enrolAgent("agent-hermes", "hermes");
    expect(agentDeviceAuthorizations(db, NOW + 10).get("agent-hermes")).toEqual({
      status: "authorized",
    });

    expect(revokeAccessGrant(db, enrolled.grantId, "portal-token", NOW + 50)).toBe(true);
    expect(agentDeviceAuthorizations(db, NOW + 60).get("agent-hermes")).toEqual({
      status: "needs-reauthorization",
      remedy: "omnesis connect hermes --refresh",
    });
  });

  test("a paired agent that never completed OAuth needs authorizing", () => {
    insertAgentDevice("agent-openclaw", "openclaw");
    expect(agentDeviceAuthorizations(db, NOW + 10).get("agent-openclaw")).toEqual({
      status: "needs-reauthorization",
      remedy: "omnesis connect openclaw --refresh",
    });
  });

  test("says nothing about devices that are not agent integrations", () => {
    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
       VALUES ('phone', 'Fictional phone', 'ios', '{}', ?)`,
    ).run(NOW);
    insertAgentDevice("agent-openclaw", "openclaw");
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = 'agent-openclaw'").run(NOW + 1);

    // A revoked agent has no corpus access to repair — unpairing is the state
    // that matters there, and the device list already shows it.
    expect([...agentDeviceAuthorizations(db, NOW + 10).keys()]).toEqual([]);
  });
});

function insertAgentDevice(id: string, harness: "openclaw" | "hermes"): void {
  db.prepare(
    `INSERT INTO devices (id, name, kind, capabilities, paired_at)
     VALUES (?, ?, 'agent', ?, ?)`,
  ).run(
    id,
    `Fictional ${harness} runtime ${id}`,
    JSON.stringify({
      agentIntegration: {
        harness,
        deliveryProtocolMin: 1,
        deliveryProtocolMax: 1,
        maxConcurrentRuns: 1,
      },
    }),
    NOW,
  );
}

/** Walk one agent device all the way to a live OAuth credential. */
function enrolAgent(
  deviceId: string,
  harness: "openclaw" | "hermes",
  grantTypes: string[] = ["authorization_code", "refresh_token"],
): {
  clientId: string;
  credentialId: string;
  grantId: string;
  accessToken: string;
  refreshToken?: string;
} {
  insertAgentDevice(deviceId, harness);
  const client = publicClient("Stellar MCP Client", grantTypes);
  const binding = createExecutionBinding(
    db,
    { deviceId, oauthClientId: client.clientId, harness },
    NOW + 1,
  );
  if (!binding.ok) throw new Error("execution binding refused");
  const created = createAuthorizationRequest(
    db,
    {
      clientId: client.clientId,
      redirectUri: REDIRECT,
      state: `${deviceId}-state`,
      codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      resource: RESOURCE,
      scope: defaultAuthorizationScope(),
      executionBinding: binding.value.binding,
    },
    NOW + 2,
  );
  if (!created.ok) throw new Error("authorization request refused");
  const decided = decideAuthorizationRequest(
    db,
    {
      approvalId: created.value.id,
      decision: "approve",
      actorTokenId: "portal-token",
      selection: {
        kind: "new-principal",
        principalName: `Fictional ${harness} assistant`,
        grantName: "Reviewed answer",
        rules: ANSWER_RULES,
        credentialLabel: `${harness} runtime`,
        expiresAt: null,
      },
    },
    NOW + 3,
  );
  if (!decided.ok) throw new Error(`approval refused: ${decided.error}`);
  const code = issueAuthorizationCode(db, created.value.browserHandle, NOW + 4);
  if (!code.ok || code.value.status !== "approved") throw new Error("no authorization code");
  const exchanged = exchangeAuthorizationCode(
    db,
    {
      code: code.value.code,
      clientId: client.clientId,
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
    },
    NOW + 5,
  );
  if (!exchanged.ok) throw new Error(`token exchange refused: ${exchanged.error}`);
  const row = db
    .prepare<
      [],
      { id: string; grant_id: string }
    >("SELECT id, grant_id FROM principal_credentials WHERE execution_device_id IS NOT NULL")
    .get();
  if (!row) throw new Error("no execution-bound credential was created");
  return {
    clientId: client.clientId,
    credentialId: row.id,
    grantId: row.grant_id,
    accessToken: exchanged.value.accessToken,
    ...(exchanged.value.refreshToken ? { refreshToken: exchanged.value.refreshToken } : {}),
  };
}

function publicClient(
  clientName = "Stellar MCP Client",
  grantTypes: string[] = ["authorization_code", "refresh_token"],
) {
  return registerOAuthClient(
    db,
    {
      clientName,
      redirectUris: [REDIRECT],
      grantTypes,
      responseTypes: ["code"],
      clientUri: "https://example.com/client",
    },
    NOW,
  );
}

function credentialCount(): number {
  return db
    .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM principal_credentials")
    .get()!.count;
}

function activeCredentialCount(): number {
  return db
    .prepare<
      [],
      { count: number }
    >("SELECT COUNT(*) AS count FROM principal_credentials c JOIN access_grants g ON g.id = c.grant_id WHERE c.status = 'active' AND c.revoked_at IS NULL AND g.revoked_at IS NULL")
    .get()!.count;
}

function grantCount(): number {
  return db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM access_grants").get()!
    .count;
}

function auditEvents(): string[] {
  return db
    .prepare<[], { event_type: string }>("SELECT event_type FROM access_audit_events")
    .all()
    .map((row) => row.event_type);
}
