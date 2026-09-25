// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  cleanupExpiredAccessStateBatch,
  createAuthorizationRequest,
  decideAuthorizationRequest,
  defaultAuthorizationScope,
  lookupPrincipalAccessToken,
  refreshPrincipalAccessToken,
  registerOAuthClient,
  revokeAccessPrincipal,
} from "../access/store.js";
import {
  authorizeInteractiveAccess,
  TEST_OAUTH_REDIRECT,
  TEST_OAUTH_VERIFIER,
  type InteractiveAccessFixture,
} from "../access/test-utils.js";
import { commitPrivacyPolicy } from "../privacy/policy-history.js";
import { migrateV171AccessLevels } from "./migration-171-access-levels.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import type { AccessGrantRuleInput, AuthorizationGrantSelection } from "../access/types.js";
import type { Db } from "./types.js";

const NOW = 1_800_000_000_000;
const RESOURCE = "https://gateway.example.org/mcp";
const SCOPE = `${defaultAuthorizationScope()} offline_access`;
const ANSWER_RULES: AccessGrantRuleInput[] = [
  {
    capability: "answer",
    sources: { mode: "all", sourceIds: [] },
    release: { mode: "reviewed", policyFamilyId: DEFAULT_PRIVACY_POLICY_FAMILY_ID },
  },
];
const DIRECT_RULES: AccessGrantRuleInput[] = [
  { capability: "direct", sources: { mode: "all", sourceIds: [] } },
];

let db: Db;

/** Rebuild the access tables in their schema-170 shape: no levels, no `level_id`, no `created_level_id`. */
function revertToV170(target: Db): void {
  target.pragma("foreign_keys = OFF");
  target.pragma("legacy_alter_table = ON");
  target.exec(`
    DROP INDEX idx_oauth_authorization_requests_created_level;
    ALTER TABLE oauth_authorization_requests DROP COLUMN created_level_id;
    DROP INDEX idx_access_grants_level;
    CREATE TABLE access_grants_v170 (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES access_principals(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER
    );
    INSERT INTO access_grants_v170
      SELECT id, principal_id, name, revision, created_at, updated_at, expires_at, revoked_at
        FROM access_grants;
    DROP TABLE access_grants;
    ALTER TABLE access_grants_v170 RENAME TO access_grants;
    CREATE INDEX idx_access_grants_principal ON access_grants(principal_id);
    DROP TABLE access_level_capabilities;
    DROP TABLE access_levels;
    DELETE FROM schema_migrations WHERE version >= 171;
    PRAGMA user_version = 170;
  `);
  target.pragma("legacy_alter_table = OFF");
  target.pragma("foreign_keys = ON");
}

function authorize(selection: AuthorizationGrantSelection, now: number): InteractiveAccessFixture {
  return authorizeInteractiveAccess(db, { selection, resource: RESOURCE, scope: SCOPE, now });
}

function answerOwner(fixture: InteractiveAccessFixture, suffix: string): string {
  return `principal:${fixture.principalId}:grant:${fixture.grantId}:credential:${fixture.credentialId}:answer-scope:${suffix}`;
}

/** Answer work for one owner in every table migration 171 re-keys. */
function seedAnswerWork(ownerId: string, id: string): void {
  db.prepare(
    `INSERT INTO answer_workflows (id, owner_id, name, purpose, status, created_at, expires_at)
     VALUES (?, ?, 'Fictional workflow', '', 'active', 1, 9999999999999)`,
  ).run(`workflow-${id}`, ownerId);
  db.prepare(
    `INSERT INTO answer_conversations (id, workflow_id, owner_id, active_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1)`,
  ).run(`conversation-${id}`, `workflow-${id}`, ownerId, `task-${id}`);
  db.prepare(
    `INSERT INTO answer_tasks (id, workflow_id, conversation_id, owner_id, client_request_id,
       request_fingerprint, question, status, policy_revision, created_at)
     VALUES (?, ?, ?, ?, ?, 'fingerprint', 'A fictional question?', 'approval_required', ?, 1)`,
  ).run(
    `task-${id}`,
    `workflow-${id}`,
    `conversation-${id}`,
    ownerId,
    `request-${id}`,
    "b".repeat(64),
  );
  db.prepare(
    "INSERT OR IGNORE INTO answer_egress_payloads (digest, response_json, response_bytes) VALUES ('digest', '{}', 2)",
  ).run();
  db.prepare(
    `INSERT INTO answer_egress_events (id, task_id, conversation_id, owner_id, endpoint, http_status,
       response_digest, created_at)
     VALUES (?, ?, ?, ?, '/answer', 200, 'digest', 1)`,
  ).run(`egress-${id}`, `task-${id}`, `conversation-${id}`, ownerId);
  db.prepare(
    "INSERT INTO answer_conversation_tombstones (id, owner_id, deleted_at) VALUES (?, ?, 1)",
  ).run(`tombstone-${id}`, ownerId);
  db.prepare(
    `INSERT INTO answer_request_tombstones (owner_id, client_request_id, request_fingerprint, deleted_at)
     VALUES (?, ?, 'fingerprint', 1)`,
  ).run(ownerId, `request-${id}`);
  db.prepare(
    `INSERT INTO answer_workflow_grants (id, workflow_id, owner_id, category, category_key, subject,
       max_detail_level, policy_revision, created_at, expires_at)
     VALUES (?, ?, ?, 'topic', 'topic', 'fictional subject', 'summary', ?, 1, 9999999999999)`,
  ).run(`workflow-grant-${id}`, `workflow-${id}`, ownerId, "b".repeat(64));
}

/** Every owner id a seeded owner holds, by table, keyed by the seed id. */
function seededOwners(id: string): Record<string, string | undefined> {
  const one = (sql: string, key: string) =>
    db.prepare<[string], { owner_id: string }>(sql).get(key)?.owner_id;
  return {
    answer_workflows: one("SELECT owner_id FROM answer_workflows WHERE id = ?", `workflow-${id}`),
    answer_conversations: one(
      "SELECT owner_id FROM answer_conversations WHERE id = ?",
      `conversation-${id}`,
    ),
    answer_tasks: one("SELECT owner_id FROM answer_tasks WHERE id = ?", `task-${id}`),
    answer_egress_events: one(
      "SELECT owner_id FROM answer_egress_events WHERE id = ?",
      `egress-${id}`,
    ),
    answer_conversation_tombstones: one(
      "SELECT owner_id FROM answer_conversation_tombstones WHERE id = ?",
      `tombstone-${id}`,
    ),
    answer_request_tombstones: one(
      "SELECT owner_id FROM answer_request_tombstones WHERE client_request_id = ?",
      `request-${id}`,
    ),
    answer_workflow_grants: one(
      "SELECT owner_id FROM answer_workflow_grants WHERE id = ?",
      `workflow-grant-${id}`,
    ),
  };
}

function seedDirectSession(fixture: InteractiveAccessFixture, ownerId: string, id: string): void {
  db.prepare(
    `INSERT INTO direct_audit_sessions (id, owner_id, principal_id, credential_id, grant_id,
       explicit_key, heuristic_key, created_at, last_event_at)
     VALUES (?, ?, ?, ?, ?, NULL, 'heuristic', 1, 1)`,
  ).run(`session-${id}`, ownerId, fixture.principalId, fixture.credentialId, fixture.grantId);
  db.prepare(
    `INSERT INTO direct_audit_events (id, session_id, owner_id, tool, outcome, request_id, display_json, created_at)
     VALUES (?, ?, ?, 'search', 'ok', 'request', '{}', 1)`,
  ).run(`event-${id}`, `session-${id}`, ownerId);
}

function snapshot() {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    principals: all("SELECT * FROM access_principals ORDER BY id"),
    grants: all("SELECT * FROM access_grants ORDER BY id"),
    capabilities: all("SELECT * FROM access_grant_capabilities ORDER BY grant_id, capability"),
    credentials: all("SELECT * FROM principal_credentials ORDER BY id"),
    levels: all("SELECT * FROM access_levels ORDER BY id"),
    levelCapabilities: all("SELECT * FROM access_level_capabilities ORDER BY level_id, capability"),
    audit: all("SELECT id FROM access_audit_events ORDER BY id"),
    answerOwners: all("SELECT id, owner_id FROM answer_tasks ORDER BY id"),
    directSessions: all("SELECT * FROM direct_audit_sessions ORDER BY id"),
  };
}

describe("migration 171", () => {
  let shared: { laptop: InteractiveAccessFixture; workstation: InteractiveAccessFixture };
  let twoGrants: { desk: InteractiveAccessFixture; phone: InteractiveAccessFixture };
  let plain: InteractiveAccessFixture;
  let pendingCredentialId: string;
  let waitingOnly: { principalId: string; grantId: string };
  let expired: InteractiveAccessFixture;
  let revoked: InteractiveAccessFixture;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as Db;
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
    runMigrations(db);
    commitPrivacyPolicy(db, {
      policy: "# Test policy\n\nAllow fictional summaries.\n",
      digest: "a".repeat(64),
      revision: "b".repeat(64),
      expectedRevision: null,
      action: "bootstrap",
      revertedFromGeneration: null,
      createdAt: NOW - 1,
    });

    // (c) a plain connection whose name will collide with a split-out credential's label.
    plain = authorize(
      {
        kind: "new-principal",
        principalName: "workstation",
        grantName: "Plain access",
        rules: DIRECT_RULES,
        credentialLabel: "Plain",
        expiresAt: null,
      },
      NOW,
    );
    // (a) one grant, two active sign-ins.
    const laptop = authorize(
      {
        kind: "new-principal",
        principalName: "Research agent",
        grantName: "Research access",
        rules: ANSWER_RULES,
        credentialLabel: "Laptop",
        expiresAt: null,
      },
      NOW + 100,
    );
    const workstation = authorize(
      { kind: "existing-grant", grantId: laptop.grantId, credentialLabel: "Workstation" },
      NOW + 200,
    );
    shared = { laptop, workstation };
    // (b) one principal, two grants.
    const desk = authorize(
      {
        kind: "new-principal",
        principalName: "Report agent",
        grantName: "Reports",
        rules: DIRECT_RULES,
        credentialLabel: "Desk",
        expiresAt: null,
      },
      NOW + 300,
    );
    const phone = authorize(
      {
        kind: "new-grant",
        principalId: desk.principalId,
        grantName: "Report answers",
        rules: ANSWER_RULES,
        credentialLabel: "Phone",
        expiresAt: null,
      },
      NOW + 400,
    );
    twoGrants = { desk, phone };
    // (d) a pending sign-in on the shared grant.
    const clientId = registerOAuthClient(
      db,
      {
        clientName: "Fictional tablet client",
        redirectUris: [TEST_OAUTH_REDIRECT],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        clientUri: null,
      },
      NOW + 500,
    ).clientId;
    const pending = createAuthorizationRequest(
      db,
      {
        clientId,
        redirectUri: TEST_OAUTH_REDIRECT,
        state: "state-pending",
        codeChallenge: createHash("sha256").update(TEST_OAUTH_VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: SCOPE,
      },
      NOW + 500,
    );
    if (!pending.ok) throw new Error("request not created");
    const decided = decideAuthorizationRequest(
      db,
      {
        approvalId: pending.value.id,
        decision: "approve",
        actorTokenId: "portal-token",
        selection: { kind: "existing-grant", grantId: laptop.grantId, credentialLabel: "Tablet" },
      },
      NOW + 510,
    );
    if (!decided.ok) throw new Error("request not approved");
    pendingCredentialId = db
      .prepare<
        [string],
        { credential_id: string }
      >("SELECT credential_id FROM oauth_authorization_requests WHERE id = ?")
      .get(pending.value.id)!.credential_id;

    // (e) a principal whose second grant holds only an approved sign-in still
    // waiting for its code.
    const notebook = authorize(
      {
        kind: "new-principal",
        principalName: "notebook agent",
        grantName: "notebook access",
        rules: DIRECT_RULES,
        credentialLabel: "notebook",
        expiresAt: null,
      },
      NOW + 600,
    );
    const waiting = createAuthorizationRequest(
      db,
      {
        clientId: notebook.clientId,
        redirectUri: TEST_OAUTH_REDIRECT,
        state: "state-waiting",
        codeChallenge: createHash("sha256").update(TEST_OAUTH_VERIFIER).digest("base64url"),
        resource: RESOURCE,
        scope: SCOPE,
      },
      NOW + 650,
    );
    if (!waiting.ok) throw new Error("request not created");
    const waitingDecision = decideAuthorizationRequest(
      db,
      {
        approvalId: waiting.value.id,
        decision: "approve",
        actorTokenId: "portal-token",
        selection: {
          kind: "new-grant",
          principalId: notebook.principalId,
          grantName: "notebook answers",
          rules: ANSWER_RULES,
          credentialLabel: "notebook tablet",
          expiresAt: null,
        },
      },
      NOW + 660,
    );
    if (!waitingDecision.ok) throw new Error("request not approved");
    waitingOnly = {
      principalId: notebook.principalId,
      grantId: db
        .prepare<
          [string],
          { created_grant_id: string }
        >("SELECT created_grant_id FROM oauth_authorization_requests WHERE id = ?")
        .get(waiting.value.id)!.created_grant_id,
    };
    // (f) a grant that has expired, and (g) a revoked connection.
    expired = authorize(
      {
        kind: "new-principal",
        principalName: "expired agent",
        grantName: "expired access",
        rules: DIRECT_RULES,
        credentialLabel: "expired",
        expiresAt: NOW + 800,
      },
      NOW + 700,
    );
    revoked = authorize(
      {
        kind: "new-principal",
        principalName: "revoked agent",
        grantName: "revoked access",
        rules: DIRECT_RULES,
        credentialLabel: "revoked",
        expiresAt: null,
      },
      NOW + 700,
    );
    revokeAccessPrincipal(db, revoked.principalId, "portal-token", NOW + 750);

    revertToV170(db);
    // An older grant edit: the shared grant and its tokens are at revision 4.
    db.prepare("UPDATE access_grants SET revision = 4 WHERE id = ?").run(laptop.grantId);
    db.prepare(
      "UPDATE oauth_access_tokens SET grant_revision = 4 WHERE credential_id IN (?, ?)",
    ).run(laptop.credentialId, workstation.credentialId);

    seedAnswerWork(answerOwner(laptop, "scope-laptop"), "laptop");
    seedAnswerWork(answerOwner(workstation, "scope-workstation"), "workstation");
    seedAnswerWork(answerOwner(phone, "scope-phone"), "phone");
    seedDirectSession(workstation, `principal:${workstation.principalId}`, "workstation");
    seedDirectSession(laptop, `principal:${laptop.principalId}`, "laptop");
    seedDirectSession(phone, answerOwner(phone, "scope-phone"), "phone");
  });

  afterEach(() => db.close());

  test("runs from schema 170 through the migration runner", () => {
    runMigrations(db);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('access_grants')")
        .all()
        .map((column) => column.name),
    ).toContain("level_id");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  test("splits every extra grant and active sign-in into its own connection, each on its original grant's level", () => {
    migrateV171AccessLevels(db, NOW + 1_000);

    const principalOf = (credentialId: string) =>
      db
        .prepare<
          [string],
          {
            principal_id: string;
            principal_name: string;
            grant_id: string;
            revision: number;
            level_id: string | null;
            grant_name: string;
          }
        >(
          `SELECT p.id AS principal_id, p.name AS principal_name, g.id AS grant_id, g.revision,
                  g.level_id, g.name AS grant_name
             FROM principal_credentials c
             JOIN access_grants g ON g.id = c.grant_id
             JOIN access_principals p ON p.id = g.principal_id
            WHERE c.id = ?`,
        )
        .get(credentialId)!;
    const levelName = (levelId: string | null) =>
      db
        .prepare<[string], { name: string }>("SELECT name FROM access_levels WHERE id = ?")
        .get(levelId ?? "")?.name;

    // (a) The oldest sign-in keeps the grant; the other moves, keeping its level and revision.
    const laptop = principalOf(shared.laptop.credentialId);
    expect(laptop).toMatchObject({
      principal_id: shared.laptop.principalId,
      grant_id: shared.laptop.grantId,
      revision: 4,
    });
    expect(levelName(laptop.level_id)).toBe("Research agent");
    const workstation = principalOf(shared.workstation.credentialId);
    expect(workstation.principal_id).not.toBe(shared.laptop.principalId);
    expect(workstation).toMatchObject({
      principal_name: "Workstation 2",
      grant_name: "Workstation 2 access",
      revision: 4,
      level_id: laptop.level_id,
    });
    expect(
      db
        .prepare(
          "SELECT capability, source_mode, source_ids, release_mode, policy_family_id FROM access_grant_capabilities WHERE grant_id = ?",
        )
        .all(workstation.grant_id),
    ).toEqual(
      db
        .prepare(
          "SELECT capability, source_mode, source_ids, release_mode, policy_family_id FROM access_grant_capabilities WHERE grant_id = ?",
        )
        .all(shared.laptop.grantId),
    );
    // (d) The pending sign-in stays where it was.
    expect(principalOf(pendingCredentialId).grant_id).toBe(shared.laptop.grantId);

    // (b) The second grant moves to a connection named after its sign-in, on a level of its own.
    const desk = principalOf(twoGrants.desk.credentialId);
    const phone = principalOf(twoGrants.phone.credentialId);
    expect(desk.principal_id).toBe(twoGrants.desk.principalId);
    expect(phone).toMatchObject({ grant_id: twoGrants.phone.grantId, principal_name: "Phone" });
    expect(phone.principal_id).not.toBe(twoGrants.desk.principalId);
    expect(levelName(desk.level_id)).toBe("Report agent");
    expect(levelName(phone.level_id)).toBe("Report agent 2");

    // (c) A plain connection only gains its level.
    expect(principalOf(plain.credentialId)).toMatchObject({
      principal_id: plain.principalId,
      grant_id: plain.grantId,
      revision: 1,
    });
    expect(levelName(principalOf(plain.credentialId).level_id)).toBe("workstation");

    // Every live grant has a level, and each level's capabilities are its grants'.
    const liveGrant = `g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ${NOW + 1_000})
      AND EXISTS (SELECT 1 FROM access_principals p WHERE p.id = g.principal_id AND p.revoked_at IS NULL)`;
    expect(
      db
        .prepare(`SELECT g.id FROM access_grants g WHERE ${liveGrant} AND g.level_id IS NULL`)
        .all(),
    ).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT g.id FROM access_grants g
            WHERE ${liveGrant} AND (SELECT json_group_array(capability || source_mode || source_ids || IFNULL(release_mode, '') || IFNULL(policy_family_id, ''))
                     FROM (SELECT * FROM access_grant_capabilities WHERE grant_id = g.id ORDER BY capability))
               <> (SELECT json_group_array(capability || source_mode || source_ids || IFNULL(release_mode, '') || IFNULL(policy_family_id, ''))
                     FROM (SELECT * FROM access_level_capabilities WHERE level_id = g.level_id ORDER BY capability))`,
        )
        .all(),
    ).toEqual([]);

    expect(
      db
        .prepare<[], { principal_id: string; credential_id: string | null; detail: string }>(
          "SELECT principal_id, credential_id, detail FROM access_audit_events WHERE event_type = 'connection-split' ORDER BY occurred_at, credential_id",
        )
        .all()
        .map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, string> })),
    ).toEqual(
      expect.arrayContaining([
        {
          principal_id: workstation.principal_id,
          credential_id: shared.workstation.credentialId,
          detail: {
            sourcePrincipalId: shared.laptop.principalId,
            sourceGrantId: shared.laptop.grantId,
            levelId: laptop.level_id,
          },
        },
        {
          principal_id: phone.principal_id,
          credential_id: null,
          detail: {
            sourcePrincipalId: twoGrants.desk.principalId,
            sourceGrantId: twoGrants.phone.grantId,
          },
        },
      ]),
    );
  });

  test("tokens issued before the split keep resolving, and refresh onto the moved identity", () => {
    migrateV171AccessLevels(db, NOW + 1_000);
    const moved = lookupPrincipalAccessToken(
      db,
      shared.workstation.tokens.accessToken,
      RESOURCE,
      NOW + 1_001,
    );
    expect(moved).toMatchObject({
      credentialId: shared.workstation.credentialId,
      grantRevision: 4,
    });
    expect(moved?.principalId).not.toBe(shared.laptop.principalId);
    expect(
      lookupPrincipalAccessToken(db, shared.laptop.tokens.accessToken, RESOURCE, NOW + 1_001),
    ).toMatchObject({ principalId: shared.laptop.principalId });
    expect(
      lookupPrincipalAccessToken(db, twoGrants.phone.tokens.accessToken, RESOURCE, NOW + 1_001)
        ?.principalId,
    ).not.toBe(twoGrants.desk.principalId);

    const refreshed = refreshPrincipalAccessToken(
      db,
      {
        refreshToken: shared.workstation.tokens.refreshToken!,
        clientId: shared.workstation.clientId,
      },
      NOW + 1_002,
    );
    if (!refreshed.ok) throw new Error(`refresh failed: ${refreshed.error}`);
    expect(
      lookupPrincipalAccessToken(db, refreshed.value.accessToken, RESOURCE, NOW + 1_003),
    ).toMatchObject({ principalId: moved?.principalId, grantId: moved?.grantId });
  });

  test("Answer owners and Direct sessions follow a moved sign-in; others keep theirs", () => {
    migrateV171AccessLevels(db, NOW + 1_000);
    const identity = (credentialId: string) =>
      db
        .prepare<[string], { principal_id: string; grant_id: string }>(
          `SELECT g.principal_id, g.id AS grant_id FROM principal_credentials c
             JOIN access_grants g ON g.id = c.grant_id WHERE c.id = ?`,
        )
        .get(credentialId)!;
    const workstation = identity(shared.workstation.credentialId);
    const phone = identity(twoGrants.phone.credentialId);
    const ownerFor = (
      moved: { principal_id: string; grant_id: string },
      credentialId: string,
      suffix: string,
    ) =>
      `principal:${moved.principal_id}:grant:${moved.grant_id}:credential:${credentialId}:answer-scope:${suffix}`;

    const owners = Object.fromEntries(
      db
        .prepare<[], { id: string; owner_id: string }>("SELECT id, owner_id FROM answer_tasks")
        .all()
        .map((row) => [row.id, row.owner_id]),
    );
    expect(owners).toEqual({
      "task-laptop": answerOwner(shared.laptop, "scope-laptop"),
      "task-workstation": ownerFor(
        workstation,
        shared.workstation.credentialId,
        "scope-workstation",
      ),
      "task-phone": ownerFor(phone, twoGrants.phone.credentialId, "scope-phone"),
    });
    const movedOwner = owners["task-workstation"];
    expect(seededOwners("workstation")).toEqual(
      Object.fromEntries(
        Object.keys(seededOwners("workstation")).map((table) => [table, movedOwner]),
      ),
    );
    const keptOwner = answerOwner(shared.laptop, "scope-laptop");
    expect(seededOwners("laptop")).toEqual(
      Object.fromEntries(Object.keys(seededOwners("laptop")).map((table) => [table, keptOwner])),
    );

    const sessions = db
      .prepare<
        [],
        { id: string; owner_id: string; principal_id: string; grant_id: string }
      >("SELECT id, owner_id, principal_id, grant_id FROM direct_audit_sessions ORDER BY id")
      .all();
    expect(sessions).toEqual([
      {
        id: "session-laptop",
        owner_id: `principal:${shared.laptop.principalId}`,
        principal_id: shared.laptop.principalId,
        grant_id: shared.laptop.grantId,
      },
      {
        id: "session-phone",
        owner_id: ownerFor(phone, twoGrants.phone.credentialId, "scope-phone"),
        principal_id: phone.principal_id,
        grant_id: phone.grant_id,
      },
      {
        id: "session-workstation",
        owner_id: `principal:${workstation.principal_id}`,
        principal_id: workstation.principal_id,
        grant_id: workstation.grant_id,
      },
    ]);
    expect(
      db
        .prepare(
          "SELECT e.id FROM direct_audit_events e JOIN direct_audit_sessions s ON s.id = e.session_id WHERE e.owner_id <> s.owner_id",
        )
        .all(),
    ).toEqual([]);
  });

  test("an approval still waiting on a moved grant reaps the connection it moved to", () => {
    migrateV171AccessLevels(db, NOW + 1_000);
    const movedTo = db
      .prepare<
        [string],
        { principal_id: string }
      >("SELECT principal_id FROM access_grants WHERE id = ?")
      .get(waitingOnly.grantId)!.principal_id;
    expect(movedTo).not.toBe(waitingOnly.principalId);

    cleanupExpiredAccessStateBatch(db, "authorizationRequests", NOW + 60 * 60_000);
    expect(
      db.prepare("SELECT id FROM access_principals WHERE id = ?").get(movedTo),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          `SELECT p.id FROM access_principals p
            WHERE p.kind = 'interactive' AND p.revoked_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM access_grants g WHERE g.principal_id = p.id)`,
        )
        .all(),
    ).toEqual([]);
  });

  test("leaves an expired grant and a revoked connection where they are, without a level", () => {
    migrateV171AccessLevels(db, NOW + 1_000);
    const grant = db.prepare<[string], { principal_id: string; level_id: string | null }>(
      "SELECT principal_id, level_id FROM access_grants WHERE id = ?",
    );
    expect(grant.get(expired.grantId)).toEqual({
      principal_id: expired.principalId,
      level_id: null,
    });
    expect(grant.get(revoked.grantId)).toEqual({
      principal_id: revoked.principalId,
      level_id: null,
    });
    expect(
      db
        .prepare(
          "SELECT id FROM access_audit_events WHERE event_type = 'connection-split' AND principal_id IN (?, ?)",
        )
        .all(expired.principalId, revoked.principalId),
    ).toEqual([]);
  });

  test("a second run changes nothing", () => {
    migrateV171AccessLevels(db, NOW + 1_000);
    const first = snapshot();
    migrateV171AccessLevels(db, NOW + 2_000);
    expect(snapshot()).toEqual(first);
  });
});
