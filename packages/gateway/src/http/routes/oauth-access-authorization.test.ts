// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import { Hono } from "hono";
import { Scope, TokenId } from "@omnesis/types";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AccessService } from "../../access/service.js";
import { createExecutionBinding } from "../../access/store.js";
import { appendAudit } from "../../access/store-helpers.js";
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
const PORTAL_TOKEN_ID = "00000000-0000-4000-8000-000000000001";
const PORTAL = { "X-Test-Portal": "yes" };
const DIRECT_RULES = [
  { capability: "direct" as const, sources: { mode: "all" as const, sourceIds: [] } },
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
  app = createTestApp();
});

function createTestApp(options: Parameters<typeof mountOAuthAccessRoutes>[2] = {}): Hono<AppEnv> {
  const testApp = new Hono<AppEnv>();
  testApp.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  testApp.use("*", async (c, next) => {
    if (c.req.header("X-Test-Portal") === "yes") {
      c.set("auth", {
        authMethod: "portal-session",
        deviceId: null,
        credentialDeviceId: null,
        tokenId: TokenId(PORTAL_TOKEN_ID),
        scopes: [Scope("admin")],
        csrfToken: CSRF,
      });
    }
    await next();
  });
  mountOAuthAccessRoutes(testApp, new AccessService(db, directWriteGate(db)), {
    publicBaseUrl: ORIGIN,
    ...options,
  });
  return testApp;
}

async function registerClient(): Promise<{ client_id: string }> {
  const response = await app.request(`${ORIGIN}/oauth/register`, {
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
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string };
}

function authorizationUrl(clientId: string, extra: Record<string, string> = {}): URL {
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
    ...extra,
  }).toString();
  return authorize;
}

/** Start one request and return what the browser and the portal hold for it. */
async function startRequest(extra: Record<string, string> = {}) {
  const registration = await registerClient();
  const started = await app.request(authorizationUrl(registration.client_id, extra));
  expect(started.status).toBe(303);
  const consentUrl = new URL(started.headers.get("location")!, ORIGIN);
  const handle = consentUrl.searchParams.get("request")!;
  const consentHtml = await (await app.request(consentUrl)).text();
  const userCode = consentHtml.match(/data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u)![1]!;
  const lookup = await portalJson("/portal/api/access/authorizations/lookup", { code: userCode });
  const approvalId = (lookup.body as { request: { approvalId: string } }).request.approvalId;
  return { registration, consentUrl, handle, userCode, approvalId };
}

async function portalJson(path: string, body: unknown) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...PORTAL, "X-Omnesis-CSRF": CSRF },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function getJson<T>(path: string, headers: Record<string, string> = PORTAL) {
  const response = await app.request(`${ORIGIN}${path}`, { headers });
  return { response, body: (await response.json()) as T };
}

function approve(approvalId: string) {
  return portalJson(`/portal/api/access/authorizations/${approvalId}/decision`, {
    decision: "approve",
    selection: { kind: "connect", rules: DIRECT_RULES },
  });
}

describe("pending requests on the overview", () => {
  test("both overviews list undecided requests newest first and by id for a device", async () => {
    const first = await startRequest({ state: "state-first" });
    const second = await startRequest({ state: "state-second" });

    for (const path of ["/admin/access", "/portal/api/access"]) {
      const { body } = await getJson<{
        pendingRequests: Array<{ id: string; clientName: string; userCode: string }>;
      }>(path);
      expect(body.pendingRequests.map((request) => request.id)).toEqual([
        second.approvalId,
        first.approvalId,
      ]);
      expect(body.pendingRequests[0]).toMatchObject({
        clientName: "Fictional notebook client",
        userCode: second.userCode,
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
      });
    }

    const byId = await getJson<{ request: { id: string; status: string }; reconnect: unknown }>(
      `/admin/access/authorizations/${second.approvalId}`,
    );
    expect(byId.response.status).toBe(200);
    expect(byId.body.request).toMatchObject({ id: second.approvalId, status: "pending" });
    expect(byId.body.reconnect).toBeNull();
  });

  test("a decided request leaves the pending list and the device lookup, but not the portal's", async () => {
    const { approvalId } = await startRequest();
    expect((await approve(approvalId)).response.status).toBe(200);

    const overview = await getJson<{ pendingRequests: unknown[] }>("/admin/access");
    expect(overview.body.pendingRequests).toEqual([]);
    expect((await getJson(`/admin/access/authorizations/${approvalId}`)).response.status).toBe(404);
    expect((await getJson(`/portal/api/access/authorizations/${approvalId}`)).response.status).toBe(
      200,
    );
    expect((await getJson("/admin/access/authorizations/not-a-uuid")).response.status).toBe(404);
  });
});

describe("consent page states", () => {
  test("the pending page carries the code, the three-step sentence and no stale copy", async () => {
    const { consentUrl } = await startRequest();
    const html = await (await app.request(consentUrl)).text();
    expect(html).toContain("data-authorization-approval");
    expect(html).toContain("choose what this client may do, choose its data and privacy");
    expect(html).not.toContain("choose the principal or grant");
    expect(html).toContain('data-status="pending"');
    expect(html).toContain('data-client-name="Fictional notebook client"');
  });

  test("a reload after approval issues the code for a redirect-based client", async () => {
    const { consentUrl, handle, approvalId } = await startRequest();
    expect((await approve(approvalId)).response.status).toBe(200);
    const reload = await app.request(consentUrl);
    expect(reload.status).toBe(303);
    expect(reload.headers.get("location")).toBe(
      `/oauth/authorize/complete?request=${encodeURIComponent(handle)}`,
    );
    const completion = await app.request(new URL(reload.headers.get("location")!, ORIGIN));
    expect(completion.status).toBe(303);
    const target = new URL(completion.headers.get("location")!);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get("code")).toBeTruthy();
    expect(target.searchParams.get("state")).toBe("state-123");
  });

  test("a reload after approval shows the outcome to a client that completes itself", async () => {
    db.exec(`
      INSERT INTO devices (id, name, kind, capabilities, paired_at)
      VALUES ('00000000-0000-4000-8000-000000000021', 'Fictional agent host', 'agent',
        '{"agentIntegration":{"harness":"hermes","deliveryProtocolMin":1,"deliveryProtocolMax":1,"maxConcurrentRuns":1}}', 1);
    `);
    const registration = await registerClient();
    const binding = createExecutionBinding(
      db,
      {
        deviceId: "00000000-0000-4000-8000-000000000021",
        oauthClientId: registration.client_id,
        harness: "hermes",
      },
      Date.now(),
    );
    if (!binding.ok) throw new Error("execution binding not created");
    const started = await app.request(
      authorizationUrl(registration.client_id, {
        scope: "omnesis:access",
        omnesis_execution_binding: binding.value.binding,
      }),
    );
    expect(started.status).toBe(303);
    const consentUrl = new URL(started.headers.get("location")!, ORIGIN);
    const consentHtml = await (await app.request(consentUrl)).text();
    expect(consentHtml).toContain('data-completes-in-client="true"');
    const userCode = consentHtml.match(/data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u)![1]!;
    const lookup = await portalJson("/portal/api/access/authorizations/lookup", { code: userCode });
    const approvalId = (lookup.body as { request: { approvalId: string } }).request.approvalId;
    const decided = await portalJson(`/portal/api/access/authorizations/${approvalId}/decision`, {
      decision: "approve",
      selection: {
        kind: "connect",
        rules: [
          { capability: "direct", sources: { mode: "all", sourceIds: [] } },
          {
            capability: "answer",
            sources: { mode: "all", sourceIds: [] },
            release: { mode: "unreviewed" },
          },
        ],
      },
    });
    expect(decided.response.status).toBe(200);

    const reload = await app.request(consentUrl);
    expect(reload.status).toBe(200);
    const html = await reload.text();
    expect(html).toContain('data-authorization-state="approved"');
    expect(html).toContain("Fictional notebook client can finish connecting.");
    expect(html).not.toContain("data-user-code");
    expect(html).not.toContain("data-authorization-qr");
    expect(html).toContain('data-status="approved"');
  });

  test("a denied request renders the denied state", async () => {
    const { consentUrl, approvalId } = await startRequest();
    await portalJson(`/portal/api/access/authorizations/${approvalId}/decision`, {
      decision: "deny",
    });
    const html = await (await app.request(consentUrl)).text();
    expect(html).toContain('data-authorization-state="denied"');
    expect(html).toContain("Nothing was shared.");
  });
});

describe("completion after the client already finished", () => {
  test("a browser gets a page, an API caller keeps the envelope", async () => {
    const { handle, approvalId } = await startRequest();
    expect((await approve(approvalId)).response.status).toBe(200);
    const clientWon = await portalJson(
      `/portal/api/access/authorizations/${approvalId}/complete`,
      {},
    );
    expect(clientWon.response.status).toBe(200);

    const completion = `${ORIGIN}/oauth/authorize/complete?request=${encodeURIComponent(handle)}`;
    const browser = await app.request(completion);
    expect(browser.status).toBe(409);
    expect(browser.headers.get("content-type")).toContain("text/html");
    expect(browser.headers.get("content-security-policy")).toMatch(/^default-src 'none';/);
    const html = await browser.text();
    expect(html).toContain("The client has already finished connecting");
    expect(html).toContain("You can close this window.");

    const api = await app.request(completion, { headers: { Accept: "application/json" } });
    expect(api.status).toBe(409);
    expect(await api.json()).toEqual({
      error: "invalid_request",
      error_description: "already-decided",
    });
  });

  test("an unknown handle gets the gone page for a browser and 404 JSON for an API caller", async () => {
    const completion = `${ORIGIN}/oauth/authorize/complete?request=omn_oar_unknown`;
    const browser = await app.request(completion);
    expect(browser.status).toBe(404);
    expect(await browser.text()).toContain("This request is no longer available");
    const api = await app.request(completion, { headers: { Accept: "application/json" } });
    expect(api.status).toBe(404);
    expect(await api.json()).toMatchObject({ error_description: "not-found" });
  });

  test("a pending request still redirects the browser back to the consent page", async () => {
    const { handle } = await startRequest();
    const early = await app.request(
      `${ORIGIN}/oauth/authorize/complete?request=${encodeURIComponent(handle)}`,
    );
    expect(early.status).toBe(303);
    expect(early.headers.get("location")).toBe(
      `/oauth/consent?request=${encodeURIComponent(handle)}`,
    );
  });
});

describe("request creation and the phone wake", () => {
  test("the redirect does not wait for the immediate wake", async () => {
    db.prepare(
      `INSERT INTO devices (id, name, kind, paired_at, notification_delivery_health)
       VALUES ('00000000-0000-4000-8000-000000000011', 'Fictional phone', 'ios', 1, 'authorized')`,
    ).run();
    let releaseWake = (): void => undefined;
    const wakeQueued = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseWake = resolve;
        }),
    );
    app = createTestApp({
      authorizationNotifier: {
        targetDeviceIds: () => ["00000000-0000-4000-8000-000000000011" as never],
        wakeQueued,
      },
    });
    const registration = await registerClient();
    const started = await app.request(authorizationUrl(registration.client_id));
    expect(started.status).toBe(303);
    expect(wakeQueued).toHaveBeenCalledWith(["00000000-0000-4000-8000-000000000011"]);
    releaseWake();
  });
});

describe("access audit route", () => {
  function seed(count: number, principalId: string, grantId: string, base: number) {
    for (let index = 0; index < count; index += 1) {
      appendAudit(db, {
        eventType: index % 2 === 0 ? "grant-updated" : "mcp-tool-invoked",
        principalId,
        grantId,
        grantRevision: 1,
        detail: { sequence: index },
        now: base + index,
      });
    }
  }

  test("lists newest first with the shared page shape and a stable keyset cursor", async () => {
    seed(5, "principal-a", "grant-a", 1_000);
    seed(2, "principal-b", "grant-b", 2_000);
    const first = await getJson<{
      items: Array<{ occurredAt: number; principalId: string; detail: { sequence: number } }>;
      pageInfo: { hasMore: boolean; limit: number; nextCursor?: string };
    }>("/admin/access/audit?limit=3");
    expect(first.response.status).toBe(200);
    expect(first.body.items.map((event) => event.occurredAt)).toEqual([2_001, 2_000, 1_004]);
    expect(first.body.pageInfo).toMatchObject({ hasMore: true, limit: 3 });
    expect(first.body.items[0]).toMatchObject({
      eventType: "mcp-tool-invoked",
      principalId: "principal-b",
      grantId: "grant-b",
      grantRevision: 1,
      detail: { sequence: 1 },
    });

    // A newer event landing above the boundary does not shift the next page.
    appendAudit(db, { eventType: "grant-updated", principalId: "principal-c", now: 9_000 });
    const second = await getJson<{
      items: Array<{ occurredAt: number }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    }>(`/admin/access/audit?limit=3&cursor=${encodeURIComponent(first.body.pageInfo.nextCursor!)}`);
    expect(second.body.items.map((event) => event.occurredAt)).toEqual([1_003, 1_002, 1_001]);
    expect(second.body.pageInfo.hasMore).toBe(true);
    const third = await getJson<{
      items: Array<{ occurredAt: number }>;
      pageInfo: { hasMore: boolean };
    }>(
      `/admin/access/audit?limit=3&cursor=${encodeURIComponent(second.body.pageInfo.nextCursor!)}`,
    );
    expect(third.body.items.map((event) => event.occurredAt)).toEqual([1_000]);
    expect(third.body.pageInfo).toEqual({ hasMore: false, limit: 3 });
  });

  test("filters by principal and by grant, and refuses a cursor from another filter", async () => {
    seed(3, "principal-a", "grant-a", 1_000);
    seed(3, "principal-b", "grant-b", 2_000);
    const byPrincipal = await getJson<{ items: Array<{ principalId: string }> }>(
      "/admin/access/audit?principalId=principal-a",
    );
    expect(byPrincipal.body.items.map((event) => event.principalId)).toEqual([
      "principal-a",
      "principal-a",
      "principal-a",
    ]);
    const byGrant = await getJson<{
      items: Array<{ grantId: string }>;
      pageInfo: { nextCursor?: string };
    }>("/admin/access/audit?grantId=grant-b&limit=2");
    expect(byGrant.body.items.map((event) => event.grantId)).toEqual(["grant-b", "grant-b"]);
    const crossed = await app.request(
      `${ORIGIN}/admin/access/audit?cursor=${encodeURIComponent(byGrant.body.pageInfo.nextCursor!)}`,
      { headers: PORTAL },
    );
    expect(crossed.status).toBe(400);
  });

  test("requires the admin scope", async () => {
    const response = await app.request(`${ORIGIN}/admin/access/audit`);
    expect([401, 403]).toContain(response.status);
  });
});
