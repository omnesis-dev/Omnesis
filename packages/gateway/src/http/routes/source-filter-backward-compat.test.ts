// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import { Hono } from "hono";
import { DeviceId, Scope, TokenId, type ScopePolicy } from "@omnesis/types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createCorpusAuthorization,
  serializeCorpusAuthorization,
} from "../../access/corpus-authorization.js";
import { backfillDocumentScopes } from "../../access/scope-backfill.js";
import { upsertSourceScopes } from "../../access/scope-descriptors.js";
import { permittedAnalyticsSourceIds, permittedSourceIds } from "../../access/permitted-sources.js";
import { AccessService } from "../../access/service.js";
import { getGrantCapabilities, getLevelCapabilities } from "../../access/store-rules.js";
import { createGatewaySearchPort } from "../../agent/ports.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "../../data/migrations.js";
import { runSchemaSetup } from "../../data/schema.js";
import { commitPrivacyPolicy } from "../../privacy/policy-history.js";
import { directWriteGate } from "../../write-gate.js";
import { errorResponse, HttpError } from "../errors.js";
import { accessDecisionBody, accessLevelUpdateBody } from "../schemas/oauth-access.js";
import { mountOAuthAccessRoutes } from "./oauth-access.js";
import type { Db } from "../../data/types.js";
import type { SearchPipeline } from "../../search/pipeline.js";
import type { AppEnv } from "./types.js";

/**
 * What an install that never saved a source filter, and a client built before
 * filters existed, must keep seeing. Each test states one promise in the terms
 * of the wire or the stored rows, so a later change that breaks it fails here
 * rather than on a phone that was not updated.
 */

const ORIGIN = "https://gateway.example.org";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "http://127.0.0.1:48123/callback";
const VERIFIER = "v".repeat(64);
const CSRF = "csrf-test-token";
const PORTAL = { "X-Test-Portal": "yes", "X-Omnesis-CSRF": CSRF };
const OWNER_TOKEN = TokenId("00000000-0000-4000-8000-000000000001");
const PHONE = DeviceId("00000000-0000-4000-8000-000000000003");
const MAIL = "fictional-mail:reader@example.org";
const NOTES = "fictional-notes:vault";

/** Keys no response carried before source filters existed. */
const FILTER_KEYS = [
  "sourceFilters",
  "sourceType",
  "scopes",
  "scopeReadiness",
  "filterRevision",
  "scopePolicies",
  "scopeSources",
  "expectedFilterRevisions",
];

const SCOPE_TABLES = [
  "access_scope_capabilities",
  "access_scope_policy_sources",
  "access_scope_legacy_denials",
];

function keysOf(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const entry of value) keysOf(entry, found);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      keysOf(child, found);
    }
  return found;
}

let db: Db;
let app: Hono<AppEnv>;
let access: AccessService;

beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
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
    createdAt: 1,
  });
  db.prepare("INSERT INTO devices(id,name,kind,paired_at) VALUES(?,'Fictional phone','ios',1)").run(
    PHONE,
  );
  const source = db.prepare(
    "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES(?,?,?,?,1,1)",
  );
  source.run(MAIL, "fictional-mail", "reader@example.org", PHONE);
  source.run(NOTES, "fictional-notes", "vault", PHONE);
  access = new AccessService(db, directWriteGate(db));
  app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  app.use("*", async (c, next) => {
    if (c.req.header("X-Test-Portal") === "yes") {
      c.set("auth", {
        authMethod: "portal-session",
        deviceId: null,
        credentialDeviceId: null,
        tokenId: OWNER_TOKEN,
        scopes: [Scope("admin")],
        csrfToken: CSRF,
      });
    }
    await next();
  });
  mountOAuthAccessRoutes(app, access, { publicBaseUrl: ORIGIN });
});

afterEach(() => {
  (db as unknown as Database.Database).close();
  vi.unstubAllEnvs();
});

async function send(method: string, path: string, body?: unknown) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...PORTAL },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

let clientId: string | undefined;
async function startRequest() {
  if (!clientId) {
    const registered = await app.request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Fictional notebook client",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    clientId = ((await registered.json()) as { client_id: string }).client_id;
  }
  const authorize = new URL(`${ORIGIN}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "state-123",
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "omnesis:access offline_access",
  }).toString();
  const started = await app.request(authorize);
  const consent = await app.request(new URL(started.headers.get("location")!, ORIGIN));
  const userCode = (await consent.text()).match(/data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u)![1]!;
  const lookup = await send("POST", "/portal/api/access/authorizations/lookup", { code: userCode });
  return { lookup, approvalId: lookup.body.request.approvalId as string };
}

function decide(approvalId: string, selection: Record<string, unknown>) {
  return send("POST", `/portal/api/access/authorizations/${approvalId}/decision`, {
    decision: "approve",
    selection,
  });
}

function count(table: string): number {
  return db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

beforeEach(() => {
  clientId = undefined;
});

/** The three boundaries a level could hold before filters existed. */
const LEGACY_RULES = {
  everything: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
  listed: [
    { capability: "direct", sources: { mode: "allowlist", sourceIds: [MAIL] } },
    {
      capability: "answer",
      sources: { mode: "allowlist", sourceIds: [MAIL] },
      release: { mode: "unreviewed" },
    },
  ],
  excluding: [{ capability: "direct", sources: { mode: "denylist", sourceIds: [NOTES] } }],
} as const;

describe("an install that never saved a source filter", () => {
  test("requests written before filters existed are accepted unchanged and store no filter state", async () => {
    // Exactly the bodies an older portal tab or phone sends: no filter field anywhere.
    const first = await startRequest();
    const connected = await decide(first.approvalId, {
      kind: "new-connection",
      name: "Research notebook",
      level: { kind: "new", name: "Listed mail", rules: LEGACY_RULES.listed },
    });
    expect(connected.status).toBe(200);

    const created = await send("POST", "/admin/access/levels", {
      name: "Everything",
      rules: LEGACY_RULES.everything,
    });
    expect(created.status).toBe(201);
    const levelId = created.body.level.id as string;
    const edited = await send("PATCH", `/admin/access/levels/${levelId}`, {
      expectedRevision: created.body.level.revision,
      rules: LEGACY_RULES.excluding,
    });
    expect(edited.status).toBe(200);

    const second = await startRequest();
    const joined = await decide(second.approvalId, {
      kind: "new-connection",
      name: "Second notebook",
      level: {
        kind: "existing",
        levelId,
        expectedLevelRevision: edited.body.level.revision,
      },
    });
    expect(joined.status).toBe(200);

    for (const table of SCOPE_TABLES) expect(count(table)).toBe(0);
    // The rows an older gateway reads hold exactly what the client sent.
    expect(
      db
        .prepare(
          "SELECT capability,source_mode,source_ids FROM access_level_capabilities WHERE level_id=?",
        )
        .all(levelId),
    ).toEqual([{ capability: "direct", source_mode: "denylist", source_ids: `["${NOTES}"]` }]);
  });

  test("the overview and the authorization look-up carry no key an older client never saw", async () => {
    const first = await startRequest();
    await decide(first.approvalId, {
      kind: "new-connection",
      name: "Research notebook",
      level: { kind: "new", name: "Listed mail", rules: LEGACY_RULES.listed },
    });
    await send("POST", "/admin/access/levels", {
      name: "Everything",
      rules: LEGACY_RULES.everything,
    });
    // A second request from the same client: the look-up now describes its connection.
    const again = await startRequest();
    expect(again.lookup.body.connection.match).not.toBeNull();

    const overview = await send("GET", "/admin/access");
    expect(overview.status).toBe(200);
    expect(overview.body.levels).toHaveLength(2);
    for (const body of [overview.body, again.lookup.body]) {
      const keys = keysOf(body);
      expect(FILTER_KEYS.filter((key) => keys.has(key))).toEqual([]);
    }
    // A source is still described by the four fields it always had.
    expect(Object.keys(overview.body.sources[0]).sort()).toEqual(
      ["available", "icon", "id", "name"].sort(),
    );
  });

  test("upgrading from the previous schema leaves every level, connection and pending request as it was", async () => {
    const first = await startRequest();
    await decide(first.approvalId, {
      kind: "new-connection",
      name: "Research notebook",
      level: { kind: "new", name: "Listed mail", rules: LEGACY_RULES.listed },
    });
    const everything = await send("POST", "/admin/access/levels", {
      name: "Everything",
      rules: LEGACY_RULES.everything,
    });
    await send("POST", "/admin/access/levels", {
      name: "Not the vault",
      rules: LEGACY_RULES.excluding,
    });
    // An integration on a level, a revoked connection, and a request still waiting.
    db.prepare(
      "INSERT INTO devices(id,name,kind,paired_at,access_level_id) VALUES('00000000-0000-4000-8000-000000000009','Fictional harness','integration',1,?)",
    ).run(everything.body.level.id);
    const second = await startRequest();
    const revoked = await decide(second.approvalId, {
      kind: "new-connection",
      name: "Retired notebook",
      level: { kind: "new", name: "Retired", rules: LEGACY_RULES.everything },
    });
    expect(revoked.status).toBe(200);
    const retired = (await send("GET", "/admin/access")).body.principals.find(
      (principal: { name: string }) => principal.name === "Retired notebook",
    );
    expect(
      (await send("POST", "/portal/api/access/revoke", { kind: "connection", id: retired.id }))
        .status,
    ).toBe(200);
    await startRequest();

    const snapshot = () => ({
      overview: JSON.stringify(access.overview()),
      tables: [
        "access_levels",
        "access_level_capabilities",
        "access_grants",
        "access_grant_capabilities",
        "access_principals",
        "principal_credentials",
        "oauth_authorization_requests",
        "devices",
      ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()),
    });
    const before = snapshot();

    // The previous schema: none of the filter tables or their triggers.
    const raw = db as unknown as Database.Database;
    const rewind = () => {
      raw.exec("DELETE FROM schema_migrations WHERE version = 216");
      raw.pragma("user_version = 215");
    };
    for (const row of raw
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'scope_%' OR name LIKE 'access_scope_%' OR name LIKE 'native_%' OR name LIKE '%_scope_cleanup')",
      )
      .all())
      raw.exec(`DROP TRIGGER "${row.name}"`);
    for (const table of [
      ...SCOPE_TABLES,
      "scope_policy_mutation_context",
      "answer_task_scope",
      "answer_task_scope_documents",
    ])
      raw.exec(`DROP TABLE IF EXISTS ${table}`);
    rewind();

    runMigrations(raw);
    expect(raw.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(snapshot()).toEqual(before);
    for (const table of SCOPE_TABLES) expect(count(table)).toBe(0);
    // Running the step again changes nothing either.
    rewind();
    runMigrations(raw);
    expect(snapshot()).toEqual(before);
  });

  test("a legacy boundary reads the same sources and serializes with the keys an older gateway parses", async () => {
    for (const [name, rules] of Object.entries(LEGACY_RULES)) {
      const created = await send("POST", "/admin/access/levels", { name, rules });
      expect(created.status).toBe(201);
      const capabilities = getLevelCapabilities(db, created.body.level.id);
      for (const capability of capabilities) {
        expect(capability.filterRevision).toBeUndefined();
        expect(capability.scopePolicies).toBeUndefined();
      }
      const authorization = createCorpusAuthorization(
        {
          principalId: "principal",
          grantId: "grant",
          grantRevision: 1,
          credentialId: "credential",
          accessTokenId: "token",
        },
        capabilities,
        "direct",
      )!;
      const sources = permittedSourceIds(db, authorization);
      const expected = name === "everything" ? null : new Set(name === "listed" ? [MAIL] : [MAIL]);
      expect(sources).toEqual(expected);
      // Analytics follows the document boundary exactly when nothing is filtered.
      expect(permittedAnalyticsSourceIds(db, authorization)).toEqual(expected);
      expect(authorization.restricted).toBe(name !== "everything");
      expect(Object.keys(JSON.parse(serializeCorpusAuthorization(authorization))).sort()).toEqual(
        [
          "v",
          "principalId",
          "grantId",
          "grantRevision",
          "credentialId",
          "accessTokenId",
          "capability",
          "sourceMode",
          "sourceIds",
          "releaseMode",
          "policyFamilyId",
          "policyRevision",
          "privacyPolicy",
        ].sort(),
      );
    }
  });

  test("the request schemas still refuse nothing an older client sends and need no filter field", () => {
    expect(
      accessLevelUpdateBody.safeParse({ expectedRevision: 1, rules: LEGACY_RULES.listed }).success,
    ).toBe(true);
    expect(accessLevelUpdateBody.safeParse({ expectedRevision: 1, name: "Renamed" }).success).toBe(
      true,
    );
    for (const selection of [
      { kind: "connect", rules: LEGACY_RULES.everything },
      {
        kind: "new-connection",
        name: "Notebook",
        level: { kind: "new", name: "Level", rules: LEGACY_RULES.excluding },
      },
      {
        kind: "new-connection",
        name: "Notebook",
        level: {
          kind: "existing",
          levelId: "00000000-0000-4000-8000-0000000000aa",
          expectedLevelRevision: 1,
        },
      },
      {
        kind: "replace-connection",
        connectionId: "00000000-0000-4000-8000-0000000000aa",
        expectedGrantRevision: 1,
      },
    ])
      expect(accessDecisionBody.safeParse({ decision: "approve", selection }).success).toBe(true);
    expect(accessDecisionBody.safeParse({ decision: "deny" }).success).toBe(true);
  });
});

describe("a level that has a filter, edited by a client that predates filters", () => {
  const policy: ScopePolicy = {
    sourceId: MAIL,
    audience: { accessLevel: "new", capability: "direct" },
    rules: [{ match: [{ kind: "conversation", id: "invented" }], action: "share" }],
    otherwise: "hide",
  };

  async function filteredLevel() {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    upsertSourceScopes(
      db,
      [
        {
          sourceType: "fictional-mail",
          scopes: {
            items: [
              {
                kind: "conversation",
                noun: { one: "conversation", many: "conversations" },
                picker: "search",
                link: "fixed",
              },
            ],
          },
        },
      ],
      1,
    );
    db.prepare(
      "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES(?,'fictional-mail','{}',1)",
    ).run(MAIL);
    const created = await send("POST", "/admin/access/levels", {
      name: "One conversation",
      rules: [
        {
          capability: "direct",
          sources: { mode: "allowlist", sourceIds: [MAIL, NOTES] },
          scopePolicies: [policy],
        },
      ],
    });
    expect(created.status).toBe(201);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    return created.body.level as { id: string; revision: number };
  }

  test("the rows an older gateway reads leave the filtered source out", async () => {
    const level = await filteredLevel();
    expect(
      db
        .prepare(
          "SELECT source_mode,source_ids FROM access_level_capabilities WHERE level_id=? AND capability='direct'",
        )
        .get(level.id),
    ).toEqual({ source_mode: "allowlist", source_ids: `["${NOTES}"]` });
  });

  test("an edit that omits the filter is refused as stale and the filter stays", async () => {
    const level = await filteredLevel();
    const edited = await send("PATCH", `/admin/access/levels/${level.id}`, {
      expectedRevision: level.revision,
      rules: [{ capability: "direct", sources: { mode: "allowlist", sourceIds: [MAIL, NOTES] } }],
    });
    expect(edited).toEqual({ status: 409, body: { error: "stale-revision" } });
    expect(getLevelCapabilities(db, level.id)[0]!.scopePolicies).toHaveLength(1);
  });

  test("a connection joining the level, and one replacing it, keep the filter without sending it", async () => {
    const level = await filteredLevel();
    const first = await startRequest();
    expect(
      (
        await decide(first.approvalId, {
          kind: "new-connection",
          name: "Research notebook",
          level: { kind: "existing", levelId: level.id, expectedLevelRevision: level.revision },
        })
      ).status,
    ).toBe(200);
    const again = await startRequest();
    const match = again.lookup.body.connection.match as {
      connectionId: string;
      grant: { id: string; revision: number };
    };
    const connection = { grant: { id: match.grant.id } };
    expect(getGrantCapabilities(db, connection.grant.id)[0]!.scopePolicies).toHaveLength(1);
    expect(
      (
        await decide(again.approvalId, {
          kind: "replace-connection",
          connectionId: match.connectionId,
          expectedGrantRevision: match.grant.revision,
        })
      ).status,
    ).toBe(200);
    expect(getGrantCapabilities(db, connection.grant.id)[0]!.scopePolicies).toHaveLength(1);
  });
});

describe("a filtered connection, read back by a client", () => {
  async function filteredConnection() {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    upsertSourceScopes(
      db,
      [
        {
          sourceType: "fictional-mail",
          scopes: {
            items: [
              {
                kind: "conversation",
                noun: { one: "conversation", many: "conversations" },
                picker: "search",
                link: "fixed",
              },
            ],
          },
        },
      ],
      1,
    );
    db.prepare(
      "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES(?,'fictional-mail','{}',1)",
    ).run(MAIL);
    const created = await send("POST", "/admin/access/levels", {
      name: "One conversation",
      rules: [
        {
          capability: "direct",
          sources: { mode: "allowlist", sourceIds: [MAIL, NOTES] },
          scopePolicies: [
            {
              sourceId: MAIL,
              audience: { accessLevel: "new", capability: "direct" },
              rules: [{ match: [{ kind: "conversation", id: "invented" }], action: "share" }],
              otherwise: "hide",
            },
          ],
        },
      ],
    });
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    const first = await startRequest();
    await decide(first.approvalId, {
      kind: "new-connection",
      name: "Research notebook",
      level: {
        kind: "existing",
        levelId: created.body.level.id,
        expectedLevelRevision: created.body.level.revision,
      },
    });
    return created.body.level as { id: string; revision: number };
  }

  test("every served copy of the rule keeps the filtered source out of `sources` and states the real boundary beside it", async () => {
    const level = await filteredConnection();
    const again = await startRequest();
    const overview = (await send("GET", "/admin/access")).body;
    const served = [
      overview.levels.find((candidate: { id: string }) => candidate.id === level.id).rules[0],
      overview.principals[0].grants[0].rules[0],
      again.lookup.body.connection.match.grant.rules[0],
    ];
    for (const rule of served) {
      expect(rule.sources).toEqual({ mode: "allowlist", sourceIds: [NOTES] });
      expect(rule.scopeSources).toEqual({ mode: "allowlist", sourceIds: [MAIL, NOTES] });
      expect(rule.scopePolicies).toHaveLength(1);
    }
    // Inside the gateway the rule still reads the filtered account, through its filter.
    expect(getLevelCapabilities(db, level.id)[0]).toMatchObject({
      sourceMode: "allowlist",
      sourceIds: [MAIL, NOTES],
    });
  });

  test("the rules a client that predates filters copies into a new level cannot read the filtered source", async () => {
    await filteredConnection();
    // An older client reads `sources` and nothing else from each rule, starts a
    // new level from them, and sends them back without the filter it never saw.
    const again = await startRequest();
    const offered = again.lookup.body.connection.match.grant.rules as Array<{
      capability: string;
      sources: { mode: string; sourceIds: string[] };
    }>;
    const copied = offered.map(({ capability, sources }) => ({ capability, sources }));
    const approved = await decide(again.approvalId, {
      kind: "new-connection",
      name: "Research notebook again",
      level: { kind: "new", name: "Copied by an older client", rules: copied },
    });
    expect(approved.status).toBe(200);
    const copy = (await send("GET", "/admin/access")).body.levels.find(
      (candidate: { name: string }) => candidate.name === "Copied by an older client",
    );
    const capabilities = getLevelCapabilities(db, copy.id);
    expect(capabilities[0]).toMatchObject({ sourceMode: "allowlist", sourceIds: [NOTES] });
    expect(capabilities[0]!.scopePolicies).toBeUndefined();
    const authorization = createCorpusAuthorization(
      {
        principalId: "principal",
        grantId: "grant",
        grantRevision: 1,
        credentialId: "credential",
        accessTokenId: "token",
      },
      capabilities,
      "direct",
    )!;
    expect(permittedSourceIds(db, authorization)).toEqual(new Set([NOTES]));
    expect(authorization.allowsSource(MAIL)).toBe(false);
  });

  test("a client that knows filters sends the real boundary back and keeps both it and the filter", async () => {
    const level = await filteredConnection();
    const served = (await send("GET", "/admin/access")).body.levels.find(
      (candidate: { id: string }) => candidate.id === level.id,
    );
    const { scopeSources, ...rule } = served.rules[0];
    // `scopeSources` is a response field: a request carrying it is refused whole.
    const echoed = await send("PATCH", `/admin/access/levels/${level.id}`, {
      expectedRevision: served.revision,
      expectedFilterRevisions: { direct: rule.filterRevision },
      name: "Renamed",
      rules: [served.rules[0]],
    });
    expect(echoed.status).toBe(400);
    const edited = await send("PATCH", `/admin/access/levels/${level.id}`, {
      expectedRevision: served.revision,
      expectedFilterRevisions: { direct: rule.filterRevision },
      name: "Renamed",
      rules: [{ ...rule, sources: scopeSources }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.level.rules[0]).toEqual(served.rules[0]);
    expect(getLevelCapabilities(db, level.id)[0]).toMatchObject({
      sourceMode: "allowlist",
      sourceIds: [MAIL, NOTES],
      scopePolicies: served.rules[0].scopePolicies,
    });
  });
});

describe("work that runs whether or not a filter was ever saved", () => {
  test("a search with maintained knowledge switched off is not sent down the filtered search path", async () => {
    let authorization: unknown;
    const pipeline = {
      agentSearchV2Enabled: false,
      search: async (_query: unknown, searchAuthorization: unknown) => {
        authorization = searchAuthorization;
        return { results: [], timing: {} };
      },
    } as unknown as SearchPipeline;
    db.prepare(
      `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at)
       VALUES('doc-1','fictional',?,'one','Invented note','Invented body','hash','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
    ).run(NOTES);
    await createGatewaySearchPort(pipeline, undefined, db, undefined, false).search({
      query: "invented",
      limit: 5,
    });
    // The sources the search may read are listed, as before filters existed; nothing
    // marks it as a filtered search, which would need a search worker, scan vectors
    // exactly instead of through the ANN index, and drop the lexical ranker.
    expect(authorization).toEqual({ sourceIds: [NOTES], graphContext: "unrestricted" });
  });

  test("documents of a source that declares no filter kinds leave no reprojection work behind", () => {
    const insert = db.prepare(
      `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at)
       VALUES(?,'fictional',?,?,'Invented note','Invented body','hash','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
    );
    for (let i = 0; i < 20; i++) insert.run(`doc-${i}`, NOTES, `external-${i}`);
    // The queue is empty as soon as the documents are written, not only after a pass over it.
    expect(count("scope_native_reprojection")).toBe(0);
    db.prepare('UPDATE documents SET metadata = \'{"tags":["invented"]}\'').run();
    expect(count("scope_native_reprojection")).toBe(0);
    for (let pass = 0; pass < 5; pass++) backfillDocumentScopes(db, 100);
    expect(count("scope_native_reprojection")).toBe(0);
  });
});
