// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import { beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { commitPrivacyPolicy } from "../privacy/policy-history.js";
import {
  agentDeviceRevocationImpacts,
  createAccessLevel,
  createAuthorizationRequest,
  createExecutionBinding,
  decideAuthorizationRequest,
  defaultAuthorizationScope,
  deleteAccessLevel,
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  listAccessOverview,
  lookupPrincipalAccessToken,
  refreshPrincipalAccessToken,
  registerOAuthClient,
  renameAccessPrincipal,
  revokePrincipalCredential,
  setConnectionLevel,
  updateAccessGrant,
  updateAccessLevel,
} from "./store.js";
import { insertLevel, isLevelNameConflict } from "./store-level-writes.js";
import { normalizeGrantRules } from "./store-rules.js";
import {
  authorizeInteractiveAccess,
  TEST_OAUTH_REDIRECT,
  TEST_OAUTH_VERIFIER,
} from "./test-utils.js";
import type { Db } from "../data/types.js";
import type { AccessGrantRuleInput } from "./types.js";

const NOW = 1_800_000_000_000;
const RESOURCE = "https://gateway.example.org/mcp";
const ACTOR = "portal-token";
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
const BOTH_RULES: AccessGrantRuleInput[] = [...ANSWER_RULES, ...DIRECT_RULES];

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

function level(name: string, rules: AccessGrantRuleInput[]) {
  const created = createAccessLevel(db, { name, rules, actorTokenId: ACTOR }, NOW);
  if (!created.ok) throw new Error(`level not created: ${created.error}`);
  return created.value;
}

/** A connection on `levelId`, signed in and holding tokens. */
function connectOnLevel(name: string, levelId: string, now = NOW + 10) {
  return authorizeInteractiveAccess(db, {
    selection: {
      kind: "new-connection",
      name,
      level: { kind: "existing", levelId, expectedLevelRevision: currentLevel(levelId).revision },
    },
    resource: RESOURCE,
    scope: `${defaultAuthorizationScope()} offline_access`,
    now,
  });
}

/**
 * A connection on `levelId` whose sign-in is bound to the fictional agent
 * device, signed in through the whole flow.
 */
function boundConnectionOnLevel(name: string, levelId: string, now = NOW + 30) {
  const clientId = registerOAuthClient(
    db,
    {
      clientName: "Fictional OpenClaw client",
      redirectUris: [TEST_OAUTH_REDIRECT],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      clientUri: null,
    },
    now,
  ).clientId;
  db.prepare(
    `INSERT OR IGNORE INTO devices (id, name, kind, capabilities, paired_at) VALUES ('agent-device', 'Fictional runtime', 'agent', ?, ?)`,
  ).run(JSON.stringify({ agentIntegration: { harness: "openclaw" } }), now);
  const binding = createExecutionBinding(
    db,
    { deviceId: "agent-device", oauthClientId: clientId, harness: "openclaw" },
    now,
  );
  if (!binding.ok) throw new Error("binding not created");
  const pending = createAuthorizationRequest(
    db,
    {
      clientId,
      redirectUri: TEST_OAUTH_REDIRECT,
      state: "state-1",
      codeChallenge: createHash("sha256").update(TEST_OAUTH_VERIFIER).digest("base64url"),
      resource: RESOURCE,
      scope: defaultAuthorizationScope(),
      executionBinding: binding.value.binding,
    },
    now,
  );
  if (!pending.ok) throw new Error("request not created");
  const decided = decideAuthorizationRequest(
    db,
    {
      approvalId: pending.value.id,
      decision: "approve",
      actorTokenId: ACTOR,
      selection: {
        kind: "new-connection",
        name,
        level: { kind: "existing", levelId, expectedLevelRevision: currentLevel(levelId).revision },
      },
    },
    now + 1,
  );
  if (!decided.ok) throw new Error(`approval failed: ${decided.error}`);
  const issued = issueAuthorizationCode(db, pending.value.browserHandle, now + 2);
  if (!issued.ok || issued.value.status !== "approved") throw new Error("code not issued");
  const exchanged = exchangeAuthorizationCode(
    db,
    {
      code: issued.value.code,
      clientId,
      redirectUri: TEST_OAUTH_REDIRECT,
      codeVerifier: TEST_OAUTH_VERIFIER,
      resource: RESOURCE,
    },
    now + 3,
  );
  if (!exchanged.ok) throw new Error(`exchange failed: ${exchanged.error}`);
  return db
    .prepare<[string], { principalId: string; grantId: string; credentialId: string }>(
      `SELECT g.principal_id AS principalId, g.id AS grantId, c.id AS credentialId
         FROM oauth_authorization_requests r
         JOIN principal_credentials c ON c.id = r.credential_id
         JOIN access_grants g ON g.id = c.grant_id
        WHERE r.id = ?`,
    )
    .get(pending.value.id)!;
}

function currentLevel(levelId: string) {
  const found = listAccessOverview(db, NOW + 1).levels.find(
    (candidate) => candidate.id === levelId,
  );
  if (!found) throw new Error("level not listed");
  return found;
}

function grantOf(principalId: string) {
  return listAccessOverview(db, NOW + 1)
    .principals.find((principal) => principal.id === principalId)
    ?.grants.find((grant) => grant.revokedAt === null);
}

describe("creating and deleting levels", () => {
  test("a level with a live name in any case, or rules that point at nothing, is refused", () => {
    level("Reading only", DIRECT_RULES);
    expect(
      createAccessLevel(
        db,
        { name: " READING only ", rules: ANSWER_RULES, actorTokenId: ACTOR },
        NOW,
      ),
    ).toEqual({ ok: false, error: "level-name-taken" });
    expect(
      createAccessLevel(
        db,
        {
          name: "Ghost",
          rules: [
            { capability: "direct", sources: { mode: "allowlist", sourceIds: ["ghost:source"] } },
          ],
          actorTokenId: ACTOR,
        },
        NOW,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(listAccessOverview(db, NOW).levels.map((candidate) => candidate.name)).toEqual([
      "Reading only",
    ]);
  });

  test("a level in use cannot be deleted; an unused one is retired and its name freed", () => {
    const used = level("Reading only", DIRECT_RULES);
    const connection = connectOnLevel("orbit desk", used.id);
    expect(deleteAccessLevel(db, { levelId: used.id, actorTokenId: ACTOR }, NOW + 20)).toEqual({
      ok: false,
      error: "level-in-use",
    });

    const other = level("Answers", ANSWER_RULES);
    expect(
      setConnectionLevel(
        db,
        {
          connectionId: connection.principalId,
          levelId: other.id,
          expectedGrantRevision: 1,
          actorTokenId: ACTOR,
        },
        NOW + 30,
      ),
    ).toMatchObject({ ok: true });
    expect(deleteAccessLevel(db, { levelId: used.id, actorTokenId: ACTOR }, NOW + 40)).toEqual({
      ok: true,
      value: null,
    });
    expect(deleteAccessLevel(db, { levelId: used.id, actorTokenId: ACTOR }, NOW + 41)).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(listAccessOverview(db, NOW + 50).levels.map((candidate) => candidate.name)).toEqual([
      "Answers",
    ]);
    expect(
      createAccessLevel(
        db,
        { name: "Reading only", rules: DIRECT_RULES, actorTokenId: ACTOR },
        NOW + 60,
      ),
    ).toMatchObject({ ok: true });
  });
});

describe("level names and use", () => {
  test("a level whose only connection still waits to redeem its code is in use", () => {
    const reading = level("reading only", DIRECT_RULES);
    const clientId = registerOAuthClient(
      db,
      {
        clientName: "fictional notebook",
        redirectUris: [TEST_OAUTH_REDIRECT],
        grantTypes: ["authorization_code"],
        responseTypes: ["code"],
        clientUri: null,
      },
      NOW,
    ).clientId;
    const pending = createAuthorizationRequest(
      db,
      {
        clientId,
        redirectUri: TEST_OAUTH_REDIRECT,
        state: "state-1",
        codeChallenge: createHash("sha256").update(TEST_OAUTH_VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: defaultAuthorizationScope(),
      },
      NOW,
    );
    if (!pending.ok) throw new Error("request not created");
    expect(
      decideAuthorizationRequest(
        db,
        {
          approvalId: pending.value.id,
          decision: "approve",
          actorTokenId: ACTOR,
          selection: {
            kind: "new-connection",
            name: "orbit desk",
            level: { kind: "existing", levelId: reading.id, expectedLevelRevision: 1 },
          },
        },
        NOW + 1,
      ),
    ).toMatchObject({ ok: true });
    expect(deleteAccessLevel(db, { levelId: reading.id, actorTokenId: ACTOR }, NOW + 2)).toEqual({
      ok: false,
      error: "level-in-use",
    });
  });

  test("a write that loses a live name to another writer is recognised as a name conflict", () => {
    level("reading only", DIRECT_RULES);
    let caught: unknown;
    try {
      db.transaction(() =>
        insertLevel(db, " READING ONLY", normalizeGrantRules(DIRECT_RULES), ACTOR, NOW),
      )();
    } catch (error) {
      caught = error;
    }
    expect(isLevelNameConflict(caught)).toBe(true);
    expect(isLevelNameConflict(new Error("UNIQUE constraint failed: index 'idx_other'"))).toBe(
      false,
    );
  });
});

describe("editing a level", () => {
  test("new rules reach every member, fencing their tokens, and a refresh carries the new rules", () => {
    const shared = level("Shared reading", DIRECT_RULES);
    const first = connectOnLevel("orbit desk", shared.id);
    const second = connectOnLevel("Nimbus notebook", shared.id, NOW + 20);

    expect(
      updateAccessLevel(
        db,
        { levelId: shared.id, expectedRevision: 1, rules: BOTH_RULES, actorTokenId: ACTOR },
        NOW + 100,
      ),
    ).toMatchObject({ ok: true, value: { revision: 2, rules: BOTH_RULES, connectionCount: 2 } });
    for (const connection of [first, second]) {
      expect(grantOf(connection.principalId)).toMatchObject({ revision: 2, rules: BOTH_RULES });
      expect(
        lookupPrincipalAccessToken(db, connection.tokens.accessToken, RESOURCE, NOW + 101),
      ).toBeNull();
    }
    expect(
      db.prepare("SELECT 1 FROM access_audit_events WHERE event_type = 'grant-updated'").all(),
    ).toHaveLength(2);

    const refreshed = refreshPrincipalAccessToken(
      db,
      { refreshToken: first.tokens.refreshToken!, clientId: first.clientId },
      NOW + 102,
    );
    if (!refreshed.ok) throw new Error(`refresh failed: ${refreshed.error}`);
    expect(
      lookupPrincipalAccessToken(
        db,
        refreshed.value.accessToken,
        RESOURCE,
        NOW + 103,
      )?.capabilities.map((capability) => capability.capability),
    ).toEqual(["answer", "direct"]);
  });

  test("a rename advances the level's revision and leaves its members alone", () => {
    const shared = level("Shared reading", DIRECT_RULES);
    const member = connectOnLevel("orbit desk", shared.id);
    expect(
      updateAccessLevel(
        db,
        { levelId: shared.id, expectedRevision: 1, name: "Reading", actorTokenId: ACTOR },
        NOW + 100,
      ),
    ).toMatchObject({ ok: true, value: { name: "Reading", revision: 2 } });
    expect(grantOf(member.principalId)?.revision).toBe(1);
    expect(
      lookupPrincipalAccessToken(db, member.tokens.accessToken, RESOURCE, NOW + 101),
    ).not.toBeNull();
    // Saving what it already has is not a change.
    expect(
      updateAccessLevel(
        db,
        {
          levelId: shared.id,
          expectedRevision: 2,
          name: "Reading",
          rules: DIRECT_RULES,
          actorTokenId: ACTOR,
        },
        NOW + 102,
      ),
    ).toMatchObject({ ok: true, value: { revision: 2 } });
  });

  test("a stale revision, a missing level or a taken name is refused", () => {
    const shared = level("Shared reading", DIRECT_RULES);
    level("Answers", ANSWER_RULES);
    expect(
      updateAccessLevel(
        db,
        { levelId: shared.id, expectedRevision: 3, name: "X", actorTokenId: ACTOR },
        NOW,
      ),
    ).toEqual({ ok: false, error: "stale-revision" });
    expect(
      updateAccessLevel(
        db,
        {
          levelId: "00000000-0000-4000-8000-00000000abcd",
          expectedRevision: 1,
          name: "X",
          actorTokenId: ACTOR,
        },
        NOW,
      ),
    ).toEqual({ ok: false, error: "not-found" });
    expect(
      updateAccessLevel(
        db,
        { levelId: shared.id, expectedRevision: 1, name: "answers", actorTokenId: ACTOR },
        NOW,
      ),
    ).toEqual({ ok: false, error: "level-name-taken" });
  });

  test("an edit one member cannot take rolls back the level and every member", () => {
    const shared = level("Shared answers", BOTH_RULES);
    const plain = connectOnLevel("orbit desk", shared.id);
    boundConnectionOnLevel("Bound runtime", shared.id);

    expect(
      updateAccessLevel(
        db,
        {
          levelId: shared.id,
          expectedRevision: 1,
          name: "Renamed",
          rules: DIRECT_RULES,
          actorTokenId: ACTOR,
        },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(currentLevel(shared.id)).toMatchObject({
      name: "Shared answers",
      revision: 1,
      rules: BOTH_RULES,
    });
    expect(grantOf(plain.principalId)).toMatchObject({ revision: 1, rules: BOTH_RULES });
  });

  test("a policy edit advances the revision of levels that release under that policy", () => {
    const answers = level("Answers", ANSWER_RULES);
    const reading = level("Reading only", DIRECT_RULES);
    commitPrivacyPolicy(db, {
      policy: "# Test policy\n\nAllow fewer fictional summaries.\n",
      digest: "c".repeat(64),
      revision: "d".repeat(64),
      expectedRevision: "b".repeat(64),
      action: "edit",
      revertedFromGeneration: null,
      createdAt: NOW + 100,
    });
    expect(currentLevel(answers.id).revision).toBe(2);
    expect(currentLevel(reading.id).revision).toBe(1);
    expect(
      db
        .prepare<[], { detail: string }>(
          "SELECT detail FROM access_audit_events WHERE event_type = 'level-updated'",
        )
        .all()
        .map((row) => JSON.parse(row.detail)),
    ).toEqual([
      { levelId: answers.id, revision: 2, policyFamilyId: DEFAULT_PRIVACY_POLICY_FAMILY_ID },
    ]);
  });
});

describe("moving a connection between levels", () => {
  test("onto an existing level: its rules become that level's; the level it left stays", () => {
    const reading = level("Reading only", DIRECT_RULES);
    const answers = level("Answers", ANSWER_RULES);
    const member = connectOnLevel("orbit desk", reading.id);

    const moved = setConnectionLevel(
      db,
      {
        connectionId: member.principalId,
        levelId: answers.id,
        expectedGrantRevision: 1,
        actorTokenId: ACTOR,
      },
      NOW + 100,
    );
    expect(moved).toMatchObject({
      ok: true,
      value: {
        grant: { grantId: member.grantId, revision: 2 },
        level: { id: answers.id, connectionCount: 1 },
      },
    });
    expect(grantOf(member.principalId)).toMatchObject({ levelId: answers.id, rules: ANSWER_RULES });
    expect(
      lookupPrincipalAccessToken(db, member.tokens.accessToken, RESOURCE, NOW + 101),
    ).toBeNull();
    expect(currentLevel(reading.id).connectionCount).toBe(0);
  });

  test("onto a new level: the level copies its rules, so its tokens keep working", () => {
    const reading = level("Reading only", DIRECT_RULES);
    const member = connectOnLevel("orbit desk", reading.id);
    const moved = setConnectionLevel(
      db,
      {
        connectionId: member.principalId,
        newLevel: { name: "orbit desk only" },
        expectedGrantRevision: 1,
        actorTokenId: ACTOR,
      },
      NOW + 100,
    );
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.value).toMatchObject({
      grant: { grantId: member.grantId, revision: 1 },
      level: { name: "orbit desk only", rules: DIRECT_RULES, connectionCount: 1 },
    });
    expect(grantOf(member.principalId)?.levelId).toBe(moved.value.level.id);
    expect(
      lookupPrincipalAccessToken(db, member.tokens.accessToken, RESOURCE, NOW + 101),
    ).not.toBeNull();
  });

  test("a stale revision, a missing connection or level, and a taken name are refused", () => {
    const reading = level("Reading only", DIRECT_RULES);
    const member = connectOnLevel("orbit desk", reading.id);
    const base = { connectionId: member.principalId, actorTokenId: ACTOR };
    expect(
      setConnectionLevel(db, { ...base, levelId: reading.id, expectedGrantRevision: 5 }, NOW + 100),
    ).toEqual({ ok: false, error: "stale-revision" });
    expect(
      setConnectionLevel(
        db,
        {
          ...base,
          connectionId: "00000000-0000-4000-8000-00000000abcd",
          levelId: reading.id,
          expectedGrantRevision: 1,
        },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "not-found" });
    expect(
      setConnectionLevel(
        db,
        { ...base, levelId: "00000000-0000-4000-8000-00000000abcd", expectedGrantRevision: 1 },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "inactive-grant" });
    const retired = level("retired", DIRECT_RULES);
    expect(deleteAccessLevel(db, { levelId: retired.id, actorTokenId: ACTOR }, NOW + 90)).toEqual({
      ok: true,
      value: null,
    });
    expect(
      setConnectionLevel(db, { ...base, levelId: retired.id, expectedGrantRevision: 1 }, NOW + 100),
    ).toEqual({ ok: false, error: "inactive-grant" });
    expect(
      setConnectionLevel(
        db,
        { ...base, newLevel: { name: "reading ONLY" }, expectedGrantRevision: 1 },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "level-name-taken" });

    const answers = level("answers", ANSWER_RULES);
    expect(
      updateAccessLevel(
        db,
        { levelId: answers.id, expectedRevision: 1, name: "answers only", actorTokenId: ACTOR },
        NOW + 95,
      ),
    ).toMatchObject({ ok: true, value: { revision: 2 } });
    expect(
      setConnectionLevel(
        db,
        { ...base, levelId: answers.id, expectedLevelRevision: 1, expectedGrantRevision: 1 },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "stale-revision" });
    expect(grantOf(member.principalId)).toMatchObject({ levelId: reading.id, revision: 1 });
    expect(
      setConnectionLevel(
        db,
        { ...base, levelId: answers.id, expectedLevelRevision: 2, expectedGrantRevision: 1 },
        NOW + 100,
      ),
    ).toMatchObject({ ok: true, value: { level: { id: answers.id } } });
  });

  test("a connection with an execution-bound sign-in cannot move onto a level without usable Answer", () => {
    const answers = level("answers", BOTH_RULES);
    const bound = boundConnectionOnLevel("bound runtime", answers.id);
    const reading = level("reading only", DIRECT_RULES);
    expect(
      setConnectionLevel(
        db,
        {
          connectionId: bound.principalId,
          levelId: reading.id,
          expectedGrantRevision: 1,
          actorTokenId: ACTOR,
        },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(grantOf(bound.principalId)).toMatchObject({ levelId: answers.id, revision: 1 });

    // Answer the level holds but cannot release today: its policy has no published revision.
    const unpublished = "00000000-0000-4000-8000-0000000000f1";
    db.prepare(
      `INSERT INTO privacy_policy_families (id, name, name_key, created_at, updated_at)
       VALUES (?, 'unpublished policy', 'unpublished policy', ?, ?)`,
    ).run(unpublished, NOW, NOW);
    const unreleasable = level("unreleasable answers", [
      {
        capability: "answer",
        sources: { mode: "all", sourceIds: [] },
        release: { mode: "reviewed", policyFamilyId: unpublished },
      },
    ]);
    expect(
      setConnectionLevel(
        db,
        {
          connectionId: bound.principalId,
          levelId: unreleasable.id,
          expectedGrantRevision: 1,
          actorTokenId: ACTOR,
        },
        NOW + 110,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(grantOf(bound.principalId)).toMatchObject({ levelId: answers.id, revision: 1 });
  });
});

describe("editing one connection's rules", () => {
  test("is applied to its level while it is the level's only user, and refused once the level is shared", () => {
    const reading = level("Reading only", DIRECT_RULES);
    const first = connectOnLevel("orbit desk", reading.id);
    expect(
      updateAccessGrant(
        db,
        { grantId: first.grantId, expectedRevision: 1, rules: BOTH_RULES, actorTokenId: ACTOR },
        NOW + 100,
      ),
    ).toMatchObject({ ok: true, value: { grantId: first.grantId, revision: 2 } });
    expect(currentLevel(reading.id)).toMatchObject({ revision: 2, rules: BOTH_RULES });

    connectOnLevel("Nimbus notebook", reading.id, NOW + 200);
    expect(
      updateAccessGrant(
        db,
        { grantId: first.grantId, expectedRevision: 2, rules: DIRECT_RULES, actorTokenId: ACTOR },
        NOW + 300,
      ),
    ).toEqual({ ok: false, error: "level-managed" });
    expect(currentLevel(reading.id)).toMatchObject({ revision: 2, rules: BOTH_RULES });
  });
});

describe("editing one connection's rules, refused", () => {
  test("when its execution-bound sign-in would lose Answer, even as the level's only user", () => {
    const answers = level("answers", BOTH_RULES);
    const bound = boundConnectionOnLevel("bound runtime", answers.id);
    expect(
      updateAccessGrant(
        db,
        { grantId: bound.grantId, expectedRevision: 1, rules: DIRECT_RULES, actorTokenId: ACTOR },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "invalid-selection" });
    expect(currentLevel(answers.id)).toMatchObject({ revision: 1, rules: BOTH_RULES });
    expect(grantOf(bound.principalId)).toMatchObject({ revision: 1, rules: BOTH_RULES });
  });

  test("when its grant has no level to apply the edit to", () => {
    const reading = level("reading only", DIRECT_RULES);
    const member = connectOnLevel("orbit desk", reading.id);
    db.prepare("UPDATE access_grants SET level_id = NULL WHERE id = ?").run(member.grantId);
    expect(
      updateAccessGrant(
        db,
        { grantId: member.grantId, expectedRevision: 1, rules: BOTH_RULES, actorTokenId: ACTOR },
        NOW + 100,
      ),
    ).toEqual({ ok: false, error: "level-managed" });
  });
});

describe("renaming a connection", () => {
  test("its sign-ins that still work take the new name; a revoked one keeps its own", () => {
    const answers = level("answers", BOTH_RULES);
    const bound = boundConnectionOnLevel("bound runtime", answers.id);
    const extra = authorizeInteractiveAccess(db, {
      selection: { kind: "existing-grant", grantId: bound.grantId, credentialLabel: "old laptop" },
      resource: RESOURCE,
      scope: defaultAuthorizationScope(),
      now: NOW + 40,
    });
    expect(revokePrincipalCredential(db, extra.credentialId, ACTOR, NOW + 45)).toBe(true);
    expect(
      renameAccessPrincipal(
        db,
        { principalId: bound.principalId, name: "renamed runtime", actorTokenId: ACTOR },
        NOW + 50,
      ),
    ).toMatchObject({ ok: true });

    const labels = Object.fromEntries(
      grantOf(bound.principalId)!.credentials.map((credential) => [
        credential.id,
        credential.label,
      ]),
    );
    expect(labels).toEqual({
      [bound.credentialId]: "renamed runtime",
      [extra.credentialId]: "old laptop",
    });
    expect(
      agentDeviceRevocationImpacts(db, NOW + 60).get("agent-device")?.corpusCredentials,
    ).toEqual([
      {
        credentialLabel: "renamed runtime",
        principalName: "renamed runtime",
        grantName: "bound runtime access",
      },
    ]);
  });
});

describe("the overview", () => {
  test("lists live levels by name without regard to case, with their live connection counts", () => {
    const zeta = level("zeta", DIRECT_RULES);
    level("Alpha", ANSWER_RULES);
    connectOnLevel("orbit desk", zeta.id);
    const overview = listAccessOverview(db, NOW + 100);
    expect(overview.levels.map((candidate) => [candidate.name, candidate.connectionCount])).toEqual(
      [
        ["Alpha", 0],
        ["zeta", 1],
      ],
    );
    expect(overview.principals[0]?.grants[0]).toMatchObject({ levelId: zeta.id });
    expect(overview.principals[0]?.grants[0]?.credentials[0]).toMatchObject({
      clientName: "Stellar MCP Client",
    });
  });
});
