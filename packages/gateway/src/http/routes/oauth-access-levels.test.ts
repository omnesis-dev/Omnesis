// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import { Hono } from "hono";
import { DeviceId, Scope, TokenId } from "@omnesis/types";
import { beforeEach, describe, expect, test } from "vitest";

import { AccessService } from "../../access/service.js";
import { runSchemaSetup } from "../../data/schema.js";
import { commitPrivacyPolicy } from "../../privacy/policy-history.js";
import { directWriteGate } from "../../write-gate.js";
import { errorResponse, HttpError } from "../errors.js";
import { mountOAuthAccessRoutes } from "./oauth-access.js";
import type { Db } from "../../data/types.js";
import type { AppEnv } from "./types.js";

const ORIGIN = "https://gateway.example.org";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "http://127.0.0.1:48123/callback";
const VERIFIER = "v".repeat(64);
const CSRF = "csrf-test-token";
const PORTAL = { "X-Test-Portal": "yes", "X-Omnesis-CSRF": CSRF };
const MISSING = "00000000-0000-4000-8000-00000000abcd";
const DIRECT_RULES = [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }];
const UNREVIEWED_ANSWER_RULES = [
  {
    capability: "answer",
    sources: { mode: "all", sourceIds: [] },
    release: { mode: "unreviewed" },
  },
];

let db: Db;
let app: Hono<AppEnv>;

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
    createdAt: 1,
  });
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
        tokenId: TokenId("00000000-0000-4000-8000-000000000001"),
        scopes: [Scope("admin")],
        csrfToken: CSRF,
      });
    } else if (c.req.header("X-Test-Bearer") === "yes") {
      c.set("auth", {
        authMethod: "bearer",
        deviceId: DeviceId("00000000-0000-4000-8000-000000000003"),
        tokenId: TokenId("00000000-0000-4000-8000-000000000002"),
        scopes: [Scope("admin")],
      });
    }
    await next();
  });
  mountOAuthAccessRoutes(app, new AccessService(db, directWriteGate(db)), {
    publicBaseUrl: ORIGIN,
  });
});

async function send(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = PORTAL,
) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** Register a client, start a request, and read the user code the consent page shows. */
async function startRequest(clientName = "Fictional notebook client") {
  const registered = await app.request(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
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
  return { clientId, userCode };
}

async function approveNewConnection(name: string, level: Record<string, unknown>) {
  const { userCode } = await startRequest();
  const lookup = await send("POST", "/portal/api/access/authorizations/lookup", { code: userCode });
  const approvalId = lookup.body.request.approvalId as string;
  return send("POST", `/portal/api/access/authorizations/${approvalId}/decision`, {
    decision: "approve",
    selection: { kind: "new-connection", name, level },
  });
}

async function overview() {
  return (await send("GET", "/admin/access")).body;
}

describe("authorization look-up", () => {
  test("offers a connection proposal while the request is pending, and always a null reconnect", async () => {
    const { userCode } = await startRequest();
    const pending = await send("POST", "/admin/access/authorizations/lookup", { code: userCode });
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({
      reconnect: null,
      connection: {
        defaultName: "Fictional notebook client",
        defaultLevelName: "Fictional notebook client",
        match: null,
        recommended: "new-level",
      },
    });
    const approvalId = pending.body.request.approvalId as string;
    expect(
      (
        await send("POST", `/portal/api/access/authorizations/${approvalId}/decision`, {
          decision: "approve",
          selection: { kind: "connect", rules: DIRECT_RULES },
        })
      ).status,
    ).toBe(200);
    const decided = await send("GET", `/portal/api/access/authorizations/${approvalId}`);
    expect(decided.body).toMatchObject({ reconnect: null, connection: null });

    const again = await startRequest();
    const second = await send("POST", "/portal/api/access/authorizations/lookup", {
      code: again.userCode,
    });
    expect(second.body.connection).toMatchObject({
      defaultName: "Fictional notebook client 2",
      match: { matchedBy: "name", connectionName: "Fictional notebook client" },
      recommended: "existing-level",
    });
  });
});

describe("decisions", () => {
  test("approves a new connection on a new level, refuses a taken level name, and rejects unknown kinds", async () => {
    const approved = await approveNewConnection("Research notebook", {
      kind: "new",
      name: "Reading only",
      rules: DIRECT_RULES,
    });
    expect(approved.status).toBe(200);
    const taken = await approveNewConnection("Second notebook", {
      kind: "new",
      name: "reading only",
      rules: DIRECT_RULES,
    });
    expect(taken).toEqual({ status: 409, body: { error: "level-name-taken" } });
    const { userCode } = await startRequest();
    const lookup = await send("POST", "/portal/api/access/authorizations/lookup", {
      code: userCode,
    });
    const unknown = await send(
      "POST",
      `/portal/api/access/authorizations/${lookup.body.request.approvalId}/decision`,
      { decision: "approve", selection: { kind: "join-level", name: "X", levelId: MISSING } },
    );
    expect(unknown.status).toBe(400);
  });
});

describe("access level management", () => {
  test("creates, edits, moves onto and deletes levels, with the overview showing each step", async () => {
    const created = await send("POST", "/admin/access/levels", {
      name: "Answers",
      rules: UNREVIEWED_ANSWER_RULES,
    });
    expect(created.status).toBe(201);
    expect(created.body.level).toMatchObject({ name: "Answers", revision: 1, connectionCount: 0 });
    expect(
      await send("POST", "/admin/access/levels", { name: "ANSWERS", rules: DIRECT_RULES }),
    ).toEqual({ status: 409, body: { error: "level-name-taken" } });

    expect(
      (
        await approveNewConnection("Research notebook", {
          kind: "new",
          name: "Reading only",
          rules: DIRECT_RULES,
        })
      ).status,
    ).toBe(200);
    const listed = await overview();
    expect(listed.levels.map((level: { name: string }) => level.name)).toEqual([
      "Answers",
      "Reading only",
    ]);
    const connection = listed.principals[0];
    const grant = connection.grants[0];
    expect(grant.levelId).toBe(listed.levels[1].id);
    expect(grant.credentials[0].clientName).toBe("Fictional notebook client");

    const moved = await send("PUT", `/admin/access/connections/${connection.id}/level`, {
      levelId: created.body.level.id,
      expectedGrantRevision: grant.revision,
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      grant: { grantId: grant.id, revision: 2 },
      level: { id: created.body.level.id, connectionCount: 1 },
    });
    expect(
      await send("PUT", `/admin/access/connections/${connection.id}/level`, {
        newLevel: { name: "Copied" },
        expectedGrantRevision: 1,
      }),
    ).toEqual({ status: 409, body: { error: "stale-revision" } });
    expect(
      (
        await send("PUT", `/admin/access/connections/${MISSING}/level`, {
          levelId: created.body.level.id,
          expectedGrantRevision: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send("PUT", `/admin/access/connections/${connection.id}/level`, {
          levelId: null,
          expectedGrantRevision: 2,
        })
      ).status,
    ).toBe(400);

    const renamed = await send("PATCH", `/admin/access/levels/${created.body.level.id}`, {
      expectedRevision: 1,
      name: "Unreviewed answers",
    });
    expect(renamed).toMatchObject({
      status: 200,
      body: { level: { name: "Unreviewed answers", revision: 2 } },
    });
    expect(
      await send("PATCH", `/admin/access/levels/${created.body.level.id}`, {
        expectedRevision: 1,
        name: "Too late",
      }),
    ).toEqual({ status: 409, body: { error: "stale-revision" } });
    expect(
      (await send("PATCH", `/admin/access/levels/${MISSING}`, { expectedRevision: 1, name: "X" }))
        .status,
    ).toBe(404);

    expect(await send("DELETE", `/admin/access/levels/${created.body.level.id}`)).toEqual({
      status: 409,
      body: { error: "level-in-use" },
    });
    expect(await send("DELETE", `/admin/access/levels/${listed.levels[1].id}`)).toEqual({
      status: 200,
      body: { removed: true },
    });
    expect((await send("DELETE", `/admin/access/levels/${listed.levels[1].id}`)).status).toBe(404);
    expect(
      await send("PUT", `/admin/access/connections/${connection.id}/level`, {
        levelId: listed.levels[1].id,
        expectedGrantRevision: 2,
      }),
    ).toEqual({ status: 409, body: { error: "inactive-grant" } });
    expect(
      (
        await send("PATCH", `/admin/access/levels/${created.body.level.id}`, {
          expectedRevision: 2,
        })
      ).status,
    ).toBe(400);
  });

  test("a connection's rules can be edited directly only while it is alone on its level", async () => {
    const level = await send("POST", "/admin/access/levels", {
      name: "Shared",
      rules: DIRECT_RULES,
    });
    const onShared = { kind: "existing", levelId: level.body.level.id, expectedLevelRevision: 1 };
    expect((await approveNewConnection("First notebook", onShared)).status).toBe(200);
    const grant = (await overview()).principals[0].grants[0];
    const alone = await send("PATCH", `/admin/access/grants/${grant.id}`, {
      expectedRevision: 1,
      rules: UNREVIEWED_ANSWER_RULES,
    });
    expect(alone).toMatchObject({
      status: 200,
      body: { grant: { grantId: grant.id, revision: 2 } },
    });

    expect(
      (
        await approveNewConnection("Second notebook", {
          kind: "existing",
          levelId: level.body.level.id,
          expectedLevelRevision: 2,
        })
      ).status,
    ).toBe(200);
    expect(
      await send("PATCH", `/admin/access/grants/${grant.id}`, {
        expectedRevision: 2,
        rules: DIRECT_RULES,
      }),
    ).toEqual({ status: 409, body: { error: "level-managed" } });
  });

  test("needs an admin caller", async () => {
    const anonymous = await send(
      "POST",
      "/admin/access/levels",
      { name: "X", rules: DIRECT_RULES },
      {},
    );
    expect(anonymous.status).toBe(401);
  });

  test("changes only from a portal session presenting its CSRF token", async () => {
    const created = await send("POST", "/admin/access/levels", {
      name: "answers",
      rules: UNREVIEWED_ANSWER_RULES,
    });
    const levelId = created.body.level.id as string;
    const bearerAdmin = { "X-Test-Bearer": "yes" };
    const portalWithoutCsrf = { "X-Test-Portal": "yes" };
    const mutations: Array<[string, string, unknown]> = [
      ["POST", "/admin/access/levels", { name: "reading only", rules: DIRECT_RULES }],
      ["PATCH", `/admin/access/levels/${levelId}`, { expectedRevision: 1, name: "renamed" }],
      ["DELETE", `/admin/access/levels/${levelId}`, undefined],
      ["PUT", `/admin/access/connections/${MISSING}/level`, { levelId, expectedGrantRevision: 1 }],
    ];
    for (const [method, path, body] of mutations) {
      for (const headers of [bearerAdmin, portalWithoutCsrf]) {
        expect((await send(method, path, body, headers)).status, `${method} ${path}`).toBe(403);
      }
    }
    expect((await overview()).levels).toEqual([
      expect.objectContaining({ id: levelId, name: "answers", revision: 1 }),
    ]);
  });
});
