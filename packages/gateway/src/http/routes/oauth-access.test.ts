// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import Database from "better-sqlite3";
import { Hono } from "hono";
import { DeviceId, Scope, TokenId, type DeviceRecord } from "@omnesis/types";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ClientAssertionVerifier } from "../../access/client-assertion.js";
import { AccessService } from "../../access/service.js";
import { createExecutionBinding } from "../../access/store.js";
import { authorizeInteractiveAccess } from "../../access/test-utils.js";
import { createDevice, getDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { runSchemaSetup } from "../../data/schema.js";
import { directWriteGate } from "../../write-gate.js";
import { HttpError, errorResponse } from "../errors.js";
import { commitPrivacyPolicy } from "../../privacy/policy-history.js";
import { AccessAuthorizationNotifier } from "../../access/authorization-notifier.js";
import { PushBroadcaster } from "../../push/broadcast.js";
import { mountOAuthAccessRoutes } from "./oauth-access.js";
import type { OAuthClientMetadataDocument } from "../../access/types.js";
import type { Db } from "../../data/types.js";
import type { AppEnv } from "./types.js";

const ORIGIN = "https://gateway.example.org";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "http://127.0.0.1:48123/callback";
const VERIFIER = "v".repeat(64);
const CSRF = "csrf-test-token";
const PORTAL_TOKEN_ID = "00000000-0000-4000-8000-000000000001";
const MOBILE_TOKEN_ID = "00000000-0000-4000-8000-000000000002";
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
const DIRECT_AND_ANSWER_RULES = [...DIRECT_RULES, ...ANSWER_RULES];

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
    } else if (c.req.header("X-Test-Mobile") === "yes") {
      c.set("auth", {
        authMethod: "bearer",
        deviceId: DeviceId("00000000-0000-4000-8000-000000000003"),
        tokenId: TokenId(MOBILE_TOKEN_ID),
        scopes: [Scope("admin")],
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

describe("MCP OAuth access routes", () => {
  test("publishes MCP OAuth discovery metadata", async () => {
    const protectedResource = await app.request(
      `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: ["omnesis:access", "offline_access"],
      bearer_methods_supported: ["header"],
    });
    const server = await app.request(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(await server.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["RS256", "PS256", "ES256"],
    });
    const clientCredentials = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", resource: RESOURCE }),
    });
    expect(clientCredentials.status).toBe(400);
    expect(await clientCredentials.json()).toMatchObject({ error: "unsupported_grant_type" });
    const portalOverview = await app.request(`${ORIGIN}/admin/access`, {
      headers: { "X-Test-Portal": "yes" },
    });
    expect(await portalOverview.json()).toMatchObject({ oauth: { resource: RESOURCE } });
  });

  test("offers local setup from a remote portal while keeping remote OAuth disabled", async () => {
    const local = createTestApp({
      publicBaseUrl: undefined,
      loopbackBaseUrl: "https://localhost:17600",
    });
    const overview = await local.request(`${ORIGIN}/portal/api/access`, {
      headers: { "X-Test-Portal": "yes" },
    });
    expect((await overview.json()).oauth).toMatchObject({
      resource: "https://localhost:17600/mcp",
      loopbackOnly: true,
    });
    const remoteDiscovery = await local.request(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(remoteDiscovery.status).toBe(503);
    const localDiscovery = await local.request(
      "https://localhost:17600/.well-known/oauth-authorization-server",
    );
    expect(localDiscovery.status).toBe(200);
    expect((await localDiscovery.json()).issuer).toBe("https://localhost:17600");
  });

  test("tells the portal which MCP resources present the gateway's own certificate", async () => {
    const fingerprint = "ab".repeat(32);
    const presented: Record<string, string | null> = {
      [`${ORIGIN}/mcp`]: "cd".repeat(32),
      "https://gateway.example.org:7600/mcp": fingerprint,
      "https://tailnet.example.net:7600/mcp": null,
    };
    const withAliases = createTestApp({
      mcpResourceUrls: [
        "https://gateway.example.org:7600/mcp",
        "https://tailnet.example.net:7600/mcp",
      ],
      tlsFingerprintSha256: () => fingerprint,
      probeCertificate: async (resource) => presented[resource.toString()] ?? null,
    });
    const overview = await withAliases.request(`${ORIGIN}/admin/access`, {
      headers: { "X-Test-Portal": "yes" },
    });
    expect((await overview.json()).oauth).toEqual({
      resource: RESOURCE,
      resources: [
        { resource: RESOURCE, servedByGateway: false },
        { resource: "https://gateway.example.org:7600/mcp", servedByGateway: true },
        { resource: "https://tailnet.example.net:7600/mcp", servedByGateway: false },
      ],
      tlsFingerprintSha256: fingerprint,
    });

    const withoutCertificate = await app.request(`${ORIGIN}/portal/api/access`, {
      headers: { "X-Test-Portal": "yes" },
    });
    expect((await withoutCertificate.json()).oauth).toEqual({
      resource: RESOURCE,
      resources: [{ resource: RESOURCE, servedByGateway: false }],
      tlsFingerprintSha256: null,
    });
  });

  test("supports origin-first protected-resource discovery and public-client DCR", async () => {
    const protectedResource = await app.request(`${ORIGIN}/.well-known/oauth-protected-resource`);
    expect(protectedResource.status).toBe(200);
    const resourceMetadata = (await protectedResource.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(resourceMetadata).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
    });

    const server = await app.request(
      `${resourceMetadata.authorization_servers[0]}/.well-known/oauth-authorization-server`,
    );
    expect(server.status).toBe(200);
    const openId = await app.request(`${ORIGIN}/.well-known/openid-configuration`);
    expect(openId.status).toBe(200);
    expect(await openId.json()).toMatchObject({
      issuer: ORIGIN,
      token_endpoint: `${ORIGIN}/oauth/token`,
    });
    const serverMetadata = (await server.json()) as {
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
      token_endpoint_auth_methods_supported: string[];
    };
    expect(serverMetadata.code_challenge_methods_supported).toContain("S256");
    expect(serverMetadata.token_endpoint_auth_methods_supported).toContain("none");

    const registration = await app.request(serverMetadata.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT Work",
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(201);
    expect(await registration.json()).toMatchObject({
      client_name: "ChatGPT Work",
      token_endpoint_auth_method: "none",
    });
  });

  test("authorizes a verified client metadata document without dynamic registration", async () => {
    const clientId = "https://client.example.com/oauth/client.json";
    const resolve = vi.fn(
      async (): Promise<OAuthClientMetadataDocument> => ({
        clientId,
        clientName: "Example client",
        redirectUris: [REDIRECT],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "none" as const,
        jwksUri: null,
        tokenEndpointAuthSigningAlg: null,
        clientUri: "https://client.example.com",
      }),
    );
    app = createTestApp({ clientMetadataResolver: { resolve } });
    const authorize = authorizationUrl(clientId, "state-cimd");
    const started = await app.request(authorize);

    expect(started.status).toBe(303);
    expect(resolve).toHaveBeenCalledWith(clientId);
    expect(
      db
        .prepare(
          "SELECT client_name, token_endpoint_auth_method FROM oauth_clients WHERE client_id = ?",
        )
        .get(clientId),
    ).toEqual({ client_name: "Example client", token_endpoint_auth_method: "none" });

    const wrongRedirect = authorizationUrl(clientId, "state-cimd-wrong");
    wrongRedirect.searchParams.set("redirect_uri", "https://attacker.example.org/callback");
    const refused = await app.request(wrongRedirect);
    expect(refused.status).toBe(400);

    const loopbackClientId = "https://client.example.com/oauth/native.json";
    // A native client's metadata document registers its loopback listener
    // without the port the operating system assigns at sign-in (RFC 9700 §2.1).
    resolve.mockResolvedValue({
      clientId: loopbackClientId,
      clientName: "Example native client",
      redirectUris: ["http://127.0.0.1/callback"],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none" as const,
      jwksUri: null,
      tokenEndpointAuthSigningAlg: null,
      clientUri: null,
    });
    const assignedPort = authorizationUrl(loopbackClientId, "state-cimd-port");
    assignedPort.searchParams.set("redirect_uri", "http://127.0.0.1:48124/callback");
    expect((await app.request(assignedPort)).status).toBe(303);

    for (const redirect of [
      "http://localhost:48124/callback",
      "http://127.0.0.1:48124/other",
      "https://127.0.0.1:48124/callback",
    ]) {
      const mismatched = authorizationUrl(loopbackClientId, "state-cimd-mismatch");
      mismatched.searchParams.set("redirect_uri", redirect);
      const response = await app.request(mismatched);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
  });

  test("publishes standards-derived discovery for a path-prefixed public URL", async () => {
    const prefixedBase = `${ORIGIN}/omnesis`;
    const prefixedApp = new Hono<AppEnv>();
    mountOAuthAccessRoutes(prefixedApp, new AccessService(db, directWriteGate(db)), {
      publicBaseUrl: prefixedBase,
    });

    const protectedResource = await prefixedApp.request(
      `${ORIGIN}/.well-known/oauth-protected-resource/omnesis/mcp`,
    );
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toMatchObject({
      resource: `${prefixedBase}/mcp`,
      authorization_servers: [prefixedBase],
    });

    const server = await prefixedApp.request(
      `${ORIGIN}/.well-known/oauth-authorization-server/omnesis`,
    );
    expect(server.status).toBe(200);
    expect(await server.json()).toMatchObject({
      issuer: prefixedBase,
      authorization_endpoint: `${prefixedBase}/oauth/authorize`,
      token_endpoint: `${prefixedBase}/oauth/token`,
      registration_endpoint: `${prefixedBase}/oauth/register`,
      revocation_endpoint: `${prefixedBase}/oauth/revoke`,
    });
  });

  test("publishes exact metadata for every configured MCP resource", async () => {
    const privateResource = "https://private.example.net:7600/mcp";
    const pathResource = "https://proxy.example.org/omnesis/mcp";
    const multiResourceApp = createTestApp({
      mcpResourceUrls: [privateResource, pathResource],
    });

    const metadata = await multiResourceApp.request(
      "https://private.example.net:7600/.well-known/oauth-protected-resource/mcp",
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: privateResource,
      authorization_servers: [ORIGIN],
    });
    const originMetadata = await multiResourceApp.request(
      "https://private.example.net:7600/.well-known/oauth-protected-resource",
    );
    expect(originMetadata.status).toBe(200);
    expect(await originMetadata.json()).toMatchObject({ resource: privateResource });
    const pathMetadata = await multiResourceApp.request(
      "https://proxy.example.org/.well-known/oauth-protected-resource/omnesis/mcp",
    );
    expect(pathMetadata.status).toBe(200);
    expect(await pathMetadata.json()).toMatchObject({ resource: pathResource });

    const server = await multiResourceApp.request(
      `${ORIGIN}/.well-known/oauth-authorization-server`,
    );
    expect(await server.json()).toMatchObject({ issuer: ORIGIN });

    const unknown = await multiResourceApp.request(
      "https://unknown.example.net/.well-known/oauth-protected-resource/mcp",
    );
    expect(unknown.status).toBe(404);
  });

  test("rejects malformed authorization and token inputs at the OAuth boundary", async () => {
    const registration = await registerClient();
    const authorize = new URL(`${ORIGIN}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: REDIRECT,
      state: "state-invalid",
      code_challenge: "too-short",
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    const invalidAuthorization = await app.request(authorize);
    expect(invalidAuthorization.status).toBe(303);
    const authorizationError = new URL(invalidAuthorization.headers.get("location")!);
    expect(authorizationError.searchParams.get("error")).toBe("invalid_request");
    expect(authorizationError.searchParams.get("state")).toBe("state-invalid");

    const invalidToken = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        code: "fictional-code",
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      }),
    });
    expect(invalidToken.status).toBe(400);
    expect(await invalidToken.json()).toMatchObject({ error: "invalid_request" });

    const unsupported = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", resource: RESOURCE }),
    });
    expect(await unsupported.json()).toMatchObject({ error: "unsupported_grant_type" });

    const duplicate = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&grant_type=refresh_token&resource=${encodeURIComponent(RESOURCE)}`,
    });
    expect(await duplicate.json()).toMatchObject({ error: "invalid_request" });

    const wrongContentType = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(await wrongContentType.json()).toMatchObject({ error: "invalid_request" });

    const oversized = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&resource=${encodeURIComponent(RESOURCE)}&code=${"x".repeat(65 * 1_024)}`,
    });
    expect(await oversized.json()).toMatchObject({ error: "invalid_request" });

    const statelessAuthorize = new URL(`${ORIGIN}/oauth/authorize`);
    statelessAuthorize.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: REDIRECT,
      code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    expect((await app.request(statelessAuthorize)).status).toBe(303);
  });

  test("accepts repeated identical resource indicators and rejects conflicting targets", async () => {
    const registration = await registerClient();
    const authorize = authorizationUrl(registration.client_id, "state-repeated-resource");
    authorize.searchParams.append("resource", RESOURCE);

    const accepted = await app.request(authorize);
    expect(accepted.status).toBe(303);
    expect(new URL(accepted.headers.get("location")!, ORIGIN).pathname).toBe("/oauth/consent");

    const conflicting = authorizationUrl(registration.client_id, "state-conflicting-resource");
    conflicting.searchParams.append("resource", "https://other.example.com/mcp");
    const rejected = await app.request(conflicting);
    expect(rejected.status).toBe(303);
    const callback = new URL(rejected.headers.get("location")!);
    expect(callback.searchParams.get("error")).toBe("invalid_target");
    expect(callback.searchParams.get("state")).toBe("state-conflicting-resource");
  });

  test("a consent link whose request is gone renders a page, not the API envelope", async () => {
    // A person lands on this link from a QR scan or a pasted URL, usually
    // after the ten-minute window has closed. They must get a sentence that
    // says so, with the same headers the live page carries.
    const gone = await app.request(
      `${ORIGIN}/oauth/consent?request=${encodeURIComponent(`omn_oar_${"0".repeat(32)}`)}`,
    );
    expect(gone.status).toBe(404);
    expect(gone.headers.get("content-type")).toMatch(/text\/html/u);
    expect(gone.headers.get("content-security-policy")).toMatch(/^default-src 'none';/u);
    expect(gone.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await gone.text();
    expect(html).toContain("no longer available");
    expect(html).toContain("/portal/settings/access/connect");
    expect(html).not.toContain("NOT_FOUND");
    // Nothing to authorize, so nothing to run: no controller, no QR.
    expect(html).not.toContain("oauth-consent-controller.js");
    expect(html).not.toContain("data-authorization-qr");
  });

  test("asks the access sweep to re-read its wake moment when a request is created or decided", async () => {
    // A request is a future event the sweep should wake for. Creating one
    // and deciding one both move that moment, so each asks for a tick now.
    const onAuthorizationPending = vi.fn();
    const wakeApp = createTestApp({ onAuthorizationPending });
    const registration = await registerClientOn(wakeApp);

    const malformed = new URL(authorizationUrl(registration.client_id, "state-wake-malformed"));
    malformed.searchParams.set("code_challenge", "too-short");
    await wakeApp.request(malformed);
    expect(onAuthorizationPending).not.toHaveBeenCalled();

    const started = await wakeApp.request(authorizationUrl(registration.client_id, "state-wake"));
    expect(started.status).toBe(303);
    expect(onAuthorizationPending).toHaveBeenCalledTimes(1);

    const consentUrl = new URL(started.headers.get("location")!, ORIGIN);
    const consentHtml = await (await wakeApp.request(consentUrl)).text();
    const userCode = consentHtml.match(/data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u)![1]!;
    const lookup = await wakeApp.request(`${ORIGIN}/portal/api/access/authorizations/lookup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Portal": "yes",
        "X-Omnesis-CSRF": CSRF,
      },
      body: JSON.stringify({ code: userCode }),
    });
    const approvalId = ((await lookup.json()) as { request: { approvalId: string } }).request
      .approvalId;
    const decided = await wakeApp.request(
      `${ORIGIN}/portal/api/access/authorizations/${approvalId}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Test-Portal": "yes",
          "X-Omnesis-CSRF": CSRF,
        },
        body: JSON.stringify({ decision: "deny" }),
      },
    );
    expect(decided.status).toBe(200);
    expect(onAuthorizationPending).toHaveBeenCalledTimes(2);
  });

  test("removes a connection and a profile over the portal route, taking the agent when it was the last", async () => {
    // Approving a request creates the pending credential the owner will see
    // as a connection; removing it through the route must reach the cascade.
    const registration = await registerClient();
    const started = await app.request(authorizationUrl(registration.client_id, "state-remove"));
    const consentUrl = new URL(started.headers.get("location")!, ORIGIN);
    const consentHtml = await (await app.request(consentUrl)).text();
    const userCode = consentHtml.match(/data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u)![1]!;
    const lookup = await portalJson("/portal/api/access/authorizations/lookup", { code: userCode });
    // The look-up never proposes joining by name or client.
    expect((lookup.body as { reconnect: unknown }).reconnect).toBeNull();
    const approvalId = (lookup.body as { request: { approvalId: string } }).request.approvalId;
    const decided = await portalJson(`/portal/api/access/authorizations/${approvalId}/decision`, {
      decision: "approve",
      selection: {
        kind: "new-principal",
        principalName: "Removable assistant",
        grantName: "Answer",
        rules: [
          {
            capability: "answer",
            sources: { mode: "all", sourceIds: [] },
            release: { mode: "unreviewed" },
          },
        ],
        credentialLabel: "Half-connected browser",
        expiresAt: null,
      },
    });
    expect(decided.response.status).toBe(200);

    const overviewOf = async () =>
      (await (
        await app.request(`${ORIGIN}/portal/api/access`, {
          headers: { "X-Test-Portal": "yes" },
        })
      ).json()) as {
        principals: {
          id: string;
          name: string;
          revokedAt: number | null;
          grants: {
            id: string;
            revokedAt: number | null;
            credentials: { id: string; status: string; revokedAt: number | null }[];
          }[];
        }[];
      };
    const before = (await overviewOf()).principals.find((p) => p.name === "Removable assistant")!;
    const credential = before.grants[0]!.credentials[0]!;
    expect(credential.status).toBe("pending");

    const removed = await portalJson("/portal/api/access/revoke", {
      kind: "connection",
      id: credential.id,
    });
    expect(removed.response.status).toBe(200);
    expect(removed.body).toEqual({ revoked: true });
    const after = (await overviewOf()).principals.find((p) => p.name === "Removable assistant")!;
    expect(after.grants[0]!.credentials[0]!.revokedAt).not.toBeNull();
    expect(after.grants[0]!.revokedAt).not.toBeNull();
    expect(after.revokedAt).not.toBeNull();

    // A profile removal on a grant that is already fenced is refused like any second revoke.
    const again = await portalJson("/portal/api/access/revoke", {
      kind: "profile",
      id: before.grants[0]!.id,
    });
    expect(again.response.status).toBe(200);
    expect(again.body).toEqual({ revoked: false });
  });

  test("accepts the loopback callback shapes used by Claude Code and Codex", async () => {
    const claudeRedirect = "http://localhost:48123/callback";
    const claude = await app.request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Code",
        redirect_uris: [claudeRedirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(claude.status).toBe(201);
    const claudeRegistration = (await claude.json()) as {
      client_id: string;
      redirect_uris: string[];
    };
    expect(claudeRegistration).toMatchObject({ redirect_uris: [claudeRedirect] });
    const reauthorization = authorizationUrl(
      claudeRegistration.client_id,
      "state-new-loopback-port",
    );
    reauthorization.searchParams.set("redirect_uri", "http://localhost:52992/callback");
    expect((await app.request(reauthorization)).status).toBe(303);

    const codexRedirect = "http://127.0.0.1:41803/callback/fictional-opaque-segment";
    const codex = await app.request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Codex",
        redirect_uris: [codexRedirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    });
    expect(codex.status).toBe(201);
    expect(await codex.json()).toMatchObject({ redirect_uris: [codexRedirect] });

    const pathlessRedirect = "http://localhost:48124";
    const pathless = await app.request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Fictional native client",
        redirect_uris: [pathlessRedirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(pathless.status).toBe(201);
    expect(await pathless.json()).toMatchObject({ redirect_uris: [pathlessRedirect] });
  });

  test("registers and authenticates Claude's confidential dynamic client", async () => {
    const claudeRedirect = "https://claude.ai/api/mcp/auth_callback";
    const response = await app.request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [claudeRedirect],
        token_endpoint_auth_method: "client_secret_basic",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "omnesis:access offline_access",
        client_name: "Claude",
        application_type: "web",
      }),
    });
    expect(response.status).toBe(201);
    const registration = (await response.json()) as {
      client_id: string;
      client_secret: string;
      client_secret_expires_at: number;
      token_endpoint_auth_method: string;
    };
    expect(registration).toMatchObject({
      client_secret_expires_at: 0,
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(registration.client_secret).toMatch(/^omn_ocs_[A-Za-z0-9_-]+$/);
    const stored = db
      .prepare<
        [string],
        { client_secret_hash: string }
      >("SELECT client_secret_hash FROM oauth_clients WHERE client_id = ?")
      .get(registration.client_id);
    expect(stored?.client_secret_hash).toBeTruthy();
    expect(stored?.client_secret_hash).not.toBe(registration.client_secret);

    const tokenRequest = (secret: string) =>
      app.request(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${registration.client_id}:${secret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: registration.client_id,
          code: "fictional-unused-code",
          redirect_uri: claudeRedirect,
          code_verifier: VERIFIER,
          resource: RESOURCE,
        }),
      });
    const authenticated = await tokenRequest(registration.client_secret);
    expect(authenticated.status).toBe(400);
    expect(await authenticated.json()).toMatchObject({ error: "invalid_grant" });
    const refused = await tokenRequest("wrong-secret");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: "invalid_client" });
  });

  test("rejects plain-HTTP hosts that only resemble loopback", async () => {
    for (const redirect of [
      "http://localhost.example.org:48123/callback",
      "http://127.0.0.2:48123/callback",
    ]) {
      const response = await app.request(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Fictional desktop client",
          redirect_uris: [redirect],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
  });

  test("bounds registration bodies before parsing, including streams without Content-Length", async () => {
    const oversizedJson = JSON.stringify({ client_name: "x".repeat(65 * 1_024) });
    const ordinary = await app.request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedJson,
    });
    expect(ordinary.status).toBe(413);
    expect(await ordinary.json()).toMatchObject({ error: "invalid_request" });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversizedJson));
        controller.close();
      },
    });
    const streamed = await app.fetch(
      new Request(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(streamed.status).toBe(413);

    for (let index = 0; index < 18; index += 1) {
      await app.request(`${ORIGIN}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not-json",
      });
    }
    const rateLimited = await app.request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversizedJson,
    });
    expect(rateLimited.status).toBe(429);
    expect(await rateLimited.json()).toMatchObject({ error: "temporarily_unavailable" });
  });

  test("rate-limits token requests deterministically per peer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-15T12:00:00.000Z"));
    try {
      const request = () =>
        app.request(`${ORIGIN}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "password", resource: RESOURCE }),
        });

      for (let attempt = 0; attempt < 120; attempt += 1) {
        const allowed = await request();
        expect(allowed.status).toBe(400);
      }

      const refused = await request();
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("60");
      expect(await refused.json()).toMatchObject({ error: "temporarily_unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("enforces each registered token-endpoint authentication method", async () => {
    const registration = await registerClient();
    const publicBasic = `Basic ${Buffer.from(`${registration.client_id}:not-a-secret`).toString("base64")}`;
    const post = (body: URLSearchParams, authorization?: string) =>
      app.request(`${ORIGIN}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body,
      });

    for (const body of [
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registration.client_id,
        code: "fictional",
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registration.client_id,
        refresh_token: "fictional",
        resource: RESOURCE,
      }),
    ]) {
      const response = await post(body, publicBasic);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "invalid_client" });
    }
  });

  test("rejects offline_access as invalid_scope when the client omitted refresh_token", async () => {
    const registration = await registerClient({ grant_types: ["authorization_code"] });
    const authorize = new URL(`${ORIGIN}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: REDIRECT,
      state: "state-no-refresh",
      code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "omnesis:access offline_access",
    }).toString();

    const response = await app.request(authorize);
    expect(response.status).toBe(303);
    const callback = new URL(response.headers.get("location")!);
    expect(callback.searchParams.get("error")).toBe("invalid_scope");
    expect(callback.searchParams.get("state")).toBe("state-no-refresh");
    expect(db.prepare("SELECT COUNT(*) AS count FROM oauth_authorization_requests").get()).toEqual({
      count: 0,
    });
  });

  test("keeps an existing refresh credential alive when its old resource becomes configured", async () => {
    const originalBaseUrl = "https://private.example.net:7600";
    const authorizedResource = "https://private.example.net:7600/mcp";
    app = createTestApp({ publicBaseUrl: originalBaseUrl });
    const registration = await registerClient();
    const challenge = createHash("sha256").update(VERIFIER).digest("base64url");
    const authorize = new URL(`${ORIGIN}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: REDIRECT,
      state: "state-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: authorizedResource,
      // ChatGPT follows the protected-resource challenge literally and does
      // not add the optional offline_access compatibility hint.
      scope: "omnesis:access",
    }).toString();
    const started = await app.request(authorize);
    expect(started.status).toBe(303);
    const consentUrl = new URL(started.headers.get("location")!, ORIGIN);
    const handle = consentUrl.searchParams.get("request")!;

    const consent = await app.request(consentUrl);
    expect(consent.status).toBe(200);
    expect(consent.headers.get("content-security-policy")).toMatch(
      /^default-src 'none'; style-src 'self' 'nonce-[A-Za-z0-9_-]+';/,
    );
    expect(consent.headers.get("content-security-policy")).not.toMatch(/https?:/);
    expect(consent.headers.get("referrer-policy")).toBe("no-referrer");
    const consentHtml = await consent.text();
    const userCode = consentHtml.match(/data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u)?.[1];
    expect(userCode).toBeDefined();
    expect(consentHtml.match(/data-copy-user-code/g)).toHaveLength(1);
    expect(consentHtml).toContain('"qrcode":"/portal/vendor/qrcode.js"');
    expect(consentHtml.match(/data-authorization-qr(?:[ =>])/g)).toHaveLength(1);
    expect(consentHtml.match(/data-authorization-qr-error(?:[ =>])/g)).toHaveLength(1);
    expect(consentHtml).not.toContain("omnesis://access-authorization");

    const prematureCompletion = await app.request(
      `${ORIGIN}/oauth/authorize/complete?request=${encodeURIComponent(handle)}`,
    );
    expect(prematureCompletion.status).toBe(303);
    expect(prematureCompletion.headers.get("location")).toBe(
      `/oauth/consent?request=${encodeURIComponent(handle)}`,
    );

    const lookup = await portalJson("/portal/api/access/authorizations/lookup", {
      code: userCode,
    });
    expect(lookup.response.status).toBe(200);
    const approvalId = (lookup.body as { request: { approvalId: string } }).request.approvalId;
    const decided = await portalJson(`/portal/api/access/authorizations/${approvalId}/decision`, {
      decision: "approve",
      selection: {
        kind: "new-principal",
        principalName: "Development assistant",
        grantName: "Direct and privacy-reviewed access",
        rules: DIRECT_AND_ANSWER_RULES,
        credentialLabel: "Fictional desktop",
        expiresAt: null,
      },
    });
    expect(decided.response.status).toBe(200);

    const completed = await app.request(
      `${ORIGIN}/oauth/authorize/complete?request=${encodeURIComponent(handle)}`,
    );
    expect(completed.status).toBe(303);
    const callback = new URL(completed.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    expect(callback.searchParams.get("state")).toBe("state-123");
    expect(callback.searchParams.get("iss")).toBe(originalBaseUrl);
    const code = callback.searchParams.get("code")!;

    const wrongTarget = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: registration.client_id,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        resource: `${ORIGIN}/other-resource`,
      }),
    });
    expect(wrongTarget.status).toBe(400);
    expect(await wrongTarget.json()).toMatchObject({ error: "invalid_target" });

    const token = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: registration.client_id,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        resource: authorizedResource,
      }),
    });
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(tokens).toMatchObject({
      access_token: expect.stringMatching(/^omn_oat_/),
      refresh_token: expect.stringMatching(/^omn_ort_/),
      scope: "omnesis:access",
    });
    const access = new AccessService(db, directWriteGate(db)).lookupAccessToken(
      tokens.access_token,
      authorizedResource,
    );
    expect(access).toMatchObject({
      principalName: "Development assistant",
      capabilities: [
        expect.objectContaining({ capability: "answer", privacyPolicy: "default" }),
        expect.objectContaining({ capability: "direct", privacyPolicy: null }),
      ],
    });

    db.prepare("UPDATE oauth_access_tokens SET expires_at = 0").run();
    expect(
      new AccessService(db, directWriteGate(db)).lookupAccessToken(
        tokens.access_token,
        authorizedResource,
      ),
    ).toBeNull();

    // The authorization server moved, while the old reachable MCP URL remains
    // explicitly configured for credentials already bound to that audience.
    app = createTestApp({ mcpResourceUrls: [authorizedResource] });

    const refreshed = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registration.client_id,
        refresh_token: tokens.refresh_token,
      }),
    });
    expect(refreshed.status).toBe(200);
    const refreshedTokens = (await refreshed.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    expect(refreshedTokens).toMatchObject({
      access_token: expect.stringMatching(/^omn_oat_/),
      refresh_token: expect.stringMatching(/^omn_ort_/),
      scope: "omnesis:access",
    });

    const invalidMethod = await app.request(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${registration.client_id}:invented-secret`).toString("base64")}`,
      },
      body: new URLSearchParams({ token: refreshedTokens.access_token }),
    });
    expect(invalidMethod.status).toBe(401);
    expect(
      new AccessService(db, directWriteGate(db)).lookupAccessToken(
        refreshedTokens.access_token,
        authorizedResource,
      ),
    ).not.toBeNull();

    const revoked = await app.request(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshedTokens.access_token,
        client_id: registration.client_id,
        token_type_hint: "urn:example:unrecognized-token-kind",
      }),
    });
    expect(revoked.status).toBe(200);
    expect(
      new AccessService(db, directWriteGate(db)).lookupAccessToken(
        refreshedTokens.access_token,
        authorizedResource,
      ),
    ).toBeNull();
  });

  test("revokes a confidential client's token only under its registered secret", async () => {
    const registration = await registerClient({
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(registration.client_secret).toMatch(/^omn_ocs_/);
    const basic = (secret: string) =>
      `Basic ${Buffer.from(`${registration.client_id}:${secret}`).toString("base64")}`;

    const started = await app.request(authorizationUrl(registration.client_id, "state-basic"));
    expect(started.status).toBe(303);
    const consentUrl = new URL(started.headers.get("location")!, ORIGIN);
    const handle = consentUrl.searchParams.get("request")!;
    const consent = await app.request(consentUrl);
    const userCode = (await consent.text()).match(
      /data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u,
    )?.[1];
    const lookup = await portalJson("/portal/api/access/authorizations/lookup", {
      code: userCode,
    });
    const approvalId = (lookup.body as { request: { approvalId: string } }).request.approvalId;
    const decided = await portalJson(`/portal/api/access/authorizations/${approvalId}/decision`, {
      decision: "approve",
      selection: {
        kind: "new-principal",
        principalName: "Fictional confidential agent",
        grantName: "Direct access",
        rules: DIRECT_RULES,
        credentialLabel: "Fictional server",
        expiresAt: null,
      },
    });
    expect(decided.response.status).toBe(200);
    const completed = await app.request(
      `${ORIGIN}/oauth/authorize/complete?request=${encodeURIComponent(handle)}`,
    );
    const code = new URL(completed.headers.get("location")!).searchParams.get("code")!;
    const token = await app.request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic(registration.client_secret!),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
        resource: RESOURCE,
      }),
    });
    expect(token.status).toBe(200);
    const { access_token: accessToken } = (await token.json()) as { access_token: string };
    const lookupAccess = () =>
      new AccessService(db, directWriteGate(db)).lookupAccessToken(accessToken, RESOURCE);
    expect(lookupAccess()).not.toBeNull();

    const wrongSecret = await app.request(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic("invented-wrong-secret"),
      },
      body: new URLSearchParams({ token: accessToken }),
    });
    expect(wrongSecret.status).toBe(401);
    expect(lookupAccess()).not.toBeNull();

    const revoked = await app.request(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: basic(registration.client_secret!),
      },
      body: new URLSearchParams({ token: accessToken }),
    });
    expect(revoked.status).toBe(200);
    expect(lookupAccess()).toBeNull();
  });

  test("lets a paired phone inspect and atomically decide the same pending request as Portal", async () => {
    const registration = await registerClient();
    const authorize = authorizationUrl(registration.client_id, "state-mobile");
    const started = await app.request(authorize);
    const consentUrl = new URL(started.headers.get("location")!, ORIGIN);
    const consent = await app.request(consentUrl);
    const userCode = (await consent.text()).match(
      /data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u,
    )?.[1];
    expect(userCode).toBeDefined();

    const lookup = await jsonRequest(
      app,
      "/admin/access/authorizations/lookup",
      { code: userCode },
      { "X-Test-Mobile": "yes" },
    );
    expect(lookup.response.status).toBe(200);
    expect(lookup.body).toMatchObject({
      request: {
        clientName: "Stellar MCP Client",
        status: "pending",
      },
    });
    const approvalId = (lookup.body as { request: { approvalId: string } }).request.approvalId;

    const mobileDecision = await jsonRequest(
      app,
      `/admin/access/authorizations/${approvalId}/decision`,
      {
        decision: "approve",
        selection: {
          kind: "new-principal",
          principalName: "Mobile-approved assistant",
          grantName: "Reviewed access",
          rules: ANSWER_RULES,
          credentialLabel: "Fictional phone-approved client",
          expiresAt: null,
        },
      },
      { "X-Test-Mobile": "yes" },
    );
    expect(mobileDecision.response.status).toBe(200);
    expect(mobileDecision.body).toMatchObject({ request: { status: "approved" } });

    const portalLostRace = await portalJson(
      `/portal/api/access/authorizations/${approvalId}/decision`,
      { decision: "deny" },
    );
    expect(portalLostRace.response.status).toBe(409);
    expect(portalLostRace.body).toEqual({ error: "already-decided" });
    expect(
      db
        .prepare<
          [string],
          { status: string; decision_token_id: string }
        >("SELECT status, decision_token_id FROM oauth_authorization_requests WHERE id = ?")
        .get(approvalId),
    ).toEqual({ status: "approved", decision_token_id: MOBILE_TOKEN_ID });
  });

  test("sends one generic phone wake only after a complete authorization request is durable", async () => {
    const phoneId = DeviceId("00000000-0000-4000-8000-000000000008");
    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
       VALUES (?, 'Synthetic phone', 'ios', '{}', 1)`,
    ).run(phoneId);
    const targetDeviceIds = vi.fn(() => [phoneId]);
    const wakeQueued = vi.fn(async () => undefined);
    const notificationApp = createTestApp({
      authorizationNotifier: { targetDeviceIds, wakeQueued },
    });
    const registration = await registerClientOn(notificationApp);

    const malformed = new URL(authorizationUrl(registration.client_id, "state-malformed"));
    malformed.searchParams.set("code_challenge", "too-short");
    await notificationApp.request(malformed);
    expect(targetDeviceIds).not.toHaveBeenCalled();

    const started = await notificationApp.request(
      authorizationUrl(registration.client_id, "state-notification"),
    );
    expect(started.status).toBe(303);
    expect(targetDeviceIds).toHaveBeenCalledTimes(1);
    const row = db
      .prepare<
        [],
        {
          id: string;
          expires_at: number;
          access_notification_reserved_at: number;
          access_notification_sent_at: number | null;
        }
      >(
        `SELECT id, expires_at, access_notification_reserved_at, access_notification_sent_at
           FROM oauth_authorization_requests ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get()!;
    expect(row.access_notification_reserved_at).toEqual(expect.any(Number));
    expect(row.access_notification_sent_at).toEqual(row.access_notification_reserved_at);
    expect(wakeQueued).toHaveBeenCalledWith([phoneId]);
    expect(
      db
        .prepare(
          `SELECT kind, target_id, route_data, title, body, collapse_id
             FROM notifications`,
        )
        .get(),
    ).toEqual({
      kind: "access-authorization",
      target_id: "access",
      route_data: JSON.stringify({ kind: "access-authorization" }),
      title: "Access request waiting",
      body: "Tap to enter the displayed code in Omnesis, or use Connect an agent on Portal → Settings → Access.",
      collapse_id: "access:authorization",
    });
  });

  test("marks authorization notification sent after durable enqueue even when its immediate wake throws", async () => {
    const phoneId = DeviceId("00000000-0000-4000-8000-000000000009");
    db.prepare(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
       VALUES (?, 'Synthetic phone', 'ios', '{}', 1)`,
    ).run(phoneId);
    const phone: DeviceRecord = {
      id: phoneId,
      name: "Synthetic phone",
      kind: "ios",
      capabilities: {},
      pairedAt: 1,
      lastSeenAt: null,
      revokedAt: null,
      installId: null,
      version: null,
      versionSeenAt: null,
      protocolVersion: null,
      desiredVersion: null,
      updateState: null,
      updateDetail: null,
      updateStateAt: null,
      selfEmails: [],
      selfPhones: [],
      accessLevelId: null,
      apnsRegistration: null,
      fcmRegistration: null,
      pushTransport: "relay",
      relayUrl: "https://relay.example",
      relayCredential: "synthetic-relay-credential",
      relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 },
      notificationDeliveryHealth: "healthy",
      notificationDeliveryHealthUpdatedAt: 1,
    };
    const broadcaster = new PushBroadcaster({
      queue: directWriteGate(db),
      listDevices: () => [phone],
      apnsClient: null,
      fcmClient: null,
      relayClient: {
        wake: vi.fn(async () => {
          throw new Error("synthetic immediate carrier fault");
        }),
      },
      socket: null,
    });
    const notificationApp = createTestApp({
      authorizationNotifier: new AccessAuthorizationNotifier(broadcaster),
    });
    const registration = await registerClientOn(notificationApp);

    const started = await notificationApp.request(
      authorizationUrl(registration.client_id, "state-durable-notification"),
    );
    expect(started.status).toBe(303);
    expect(
      db
        .prepare(
          `SELECT access_notification_sent_at IS NOT NULL AS sent
             FROM oauth_authorization_requests WHERE client_id = ?`,
        )
        .get(registration.client_id),
    ).toEqual({ sent: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM notifications").get()).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM notification_deliveries
          WHERE device_id = ? AND wake_state = 'pending'`,
        )
        .get(phoneId),
    ).toEqual({ count: 1 });
  });

  test("leaves notification state empty when no paired phone can accept it", async () => {
    const notificationApp = createTestApp({
      authorizationNotifier: {
        targetDeviceIds: () => [],
        wakeQueued: vi.fn(),
      },
    });
    const registration = await registerClientOn(notificationApp);

    const started = await notificationApp.request(
      authorizationUrl(registration.client_id, `state-no-phone-${registration.client_id}`),
    );

    expect(started.status).toBe(303);
    expect(
      db
        .prepare(
          `SELECT access_notification_reserved_at, access_notification_sent_at
             FROM oauth_authorization_requests
            WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(registration.client_id),
    ).toEqual({ access_notification_reserved_at: null, access_notification_sent_at: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM notifications").get()).toEqual({ count: 0 });
  });

  test("reuses an existing Portal session without pairing the consent page as a device", async () => {
    db.exec(`
      INSERT INTO access_principals (id, name, kind, created_at, updated_at) VALUES
        ('11111111-1111-4111-8111-111111111111', 'Interactive principal', 'interactive', 1, 1);
      INSERT INTO access_grants (id, principal_id, name, created_at, updated_at) VALUES
        ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'Combined grant', 1, 1),
        ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', 'Granular grant', 1, 1);
      INSERT INTO access_grant_capabilities
        (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id) VALUES
        ('33333333-3333-4333-8333-333333333333', 'answer', 'all', '[]', 'reviewed',
         '00000000-0000-4000-8000-000000000001'),
        ('33333333-3333-4333-8333-333333333333', 'direct', 'all', '[]', NULL, NULL),
        ('55555555-5555-4555-8555-555555555555', 'answer', 'denylist', '["fictional-mail:private"]', 'unreviewed', NULL),
        ('55555555-5555-4555-8555-555555555555', 'direct', 'allowlist', '["fictional-code:work"]', NULL, NULL);
    `);
    const registration = await registerClient();
    const authorize = new URL(`${ORIGIN}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: REDIRECT,
      state: "state-session",
      code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "omnesis:access",
    }).toString();
    const started = await app.request(authorize);
    const consentUrl = new URL(started.headers.get("location")!, ORIGIN);
    const consent = await app.request(consentUrl, { headers: { "X-Test-Portal": "yes" } });
    expect(consent.status).toBe(303);
    const portalTarget = new URL(consent.headers.get("location")!, ORIGIN);
    expect(portalTarget.pathname).toMatch(/^\/portal\/settings\/access\/authorizations\/[^/]+$/u);
    expect(portalTarget.searchParams.get("completion")).toBe("portal");
    const approvalId = portalTarget.pathname.split("/").at(-1)!;
    const request = await app.request(`${ORIGIN}/portal/api/access/authorizations/${approvalId}`, {
      headers: { "X-Test-Portal": "yes" },
    });
    expect(request.status).toBe(200);
    expect(await request.json()).toMatchObject({ request: { clientName: "Stellar MCP Client" } });
    db.prepare("UPDATE oauth_authorization_requests SET status = 'denied' WHERE id = ?").run(
      approvalId,
    );
    const completed = await app.request(
      `${ORIGIN}/portal/api/access/authorizations/${approvalId}/complete`,
      {
        method: "POST",
        headers: { "X-Test-Portal": "yes", "X-Omnesis-CSRF": CSRF },
      },
    );
    expect(completed.status).toBe(200);
    const redirectTo = new URL(((await completed.json()) as { redirectTo: string }).redirectTo);
    expect(redirectTo.origin + redirectTo.pathname).toBe(REDIRECT);
    expect(redirectTo.searchParams.get("error")).toBe("access_denied");
    expect(redirectTo.searchParams.get("state")).toBe("state-session");
    expect(db.prepare("SELECT COUNT(*) AS count FROM devices").get()).toEqual({ count: 0 });
  });

  test("requires Answer and leaves execution-bound completion to the connecting CLI", async () => {
    db.exec(`
      INSERT INTO devices (id, name, kind, capabilities, paired_at)
      VALUES ('agent-device', 'hermes-test-runtime', 'agent', '{"agentIntegration":{"harness":"hermes","deliveryProtocolMin":1,"deliveryProtocolMax":1,"maxConcurrentRuns":1}}', 1);
      INSERT INTO access_principals (id, name, kind, created_at, updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'Existing assistant', 'interactive', 1, 1);
      INSERT INTO access_grants (id, principal_id, name, created_at, updated_at)
      VALUES
        ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Direct only', 1, 1),
        ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'Unreviewed answer', 1, 1);
      INSERT INTO access_grant_capabilities
        (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
      VALUES
        ('22222222-2222-4222-8222-222222222222', 'direct', 'all', '[]', NULL, NULL),
        ('33333333-3333-4333-8333-333333333333', 'answer', 'all', '[]', 'unreviewed', NULL);
    `);
    const registration = await registerClient();
    const binding = createExecutionBinding(
      db,
      { deviceId: "agent-device", oauthClientId: registration.client_id, harness: "hermes" },
      Date.now(),
    );
    if (!binding.ok) throw new Error("execution binding not created");
    const authorize = new URL(`${ORIGIN}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: REDIRECT,
      state: "state-integration",
      code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "omnesis:access",
      omnesis_execution_binding: binding.value.binding,
    }).toString();
    const started = await app.request(authorize);
    const consentUrl = new URL(started.headers.get("location")!, ORIGIN);
    const consent = await app.request(consentUrl, { headers: { "X-Test-Portal": "yes" } });
    expect(consent.status).toBe(303);
    const portalTarget = new URL(consent.headers.get("location")!, ORIGIN);
    const request = await app.request(
      `${ORIGIN}/portal/api/access/authorizations/${portalTarget.pathname.split("/").at(-1)}`,
      { headers: { "X-Test-Portal": "yes" } },
    );
    expect(await request.json()).toMatchObject({ request: { requiresAnswer: true } });
    const completion = await app.request(
      `${ORIGIN}/portal/api/access/authorizations/${portalTarget.pathname.split("/").at(-1)}/complete`,
      {
        method: "POST",
        headers: { "X-Test-Portal": "yes", "X-Omnesis-CSRF": CSRF },
      },
    );
    expect(completion.status).toBe(409);
    expect(await completion.json()).toEqual({ error: "client-completes" });
  });

  test("lets the Portal revise a grant through the authenticated write path", async () => {
    const authorized = authorizeInteractiveAccess(db, {
      selection: {
        kind: "new-principal",
        principalName: "Fictional report agent",
        grantName: "Mutable access",
        rules: DIRECT_RULES,
        credentialLabel: "Report workstation",
        expiresAt: null,
      },
      resource: RESOURCE,
      scope: "omnesis:access",
    });

    const response = await app.request(`${ORIGIN}/admin/access/grants/${authorized.grantId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Portal": "yes",
        "X-Omnesis-CSRF": CSRF,
      },
      body: JSON.stringify({ expectedRevision: 1, rules: DIRECT_AND_ANSWER_RULES }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      grant: {
        grantId: authorized.grantId,
        revision: 2,
        capabilities: [
          { capability: "answer", privacyPolicy: "default" },
          { capability: "direct", privacyPolicy: null },
        ],
      },
    });

    const stale = await app.request(`${ORIGIN}/admin/access/grants/${authorized.grantId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Test-Portal": "yes",
        "X-Omnesis-CSRF": CSRF,
      },
      body: JSON.stringify({ expectedRevision: 1, rules: DIRECT_RULES }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "stale-revision" });
  });

  describe("renaming an identity", () => {
    const rename = (principalId: string, body: unknown) =>
      app.request(`${ORIGIN}/admin/access/principals/${principalId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Test-Portal": "yes",
          "X-Omnesis-CSRF": CSRF,
        },
        body: JSON.stringify(body),
      });
    const authorize = () =>
      authorizeInteractiveAccess(db, {
        selection: {
          kind: "new-principal",
          principalName: "Fictional report agent",
          grantName: "Mutable access",
          rules: DIRECT_RULES,
          credentialLabel: "Report workstation",
          expiresAt: null,
        },
        resource: RESOURCE,
        scope: "omnesis:access",
      });

    test("renames from the Portal and writes the change to the ledger", async () => {
      const authorized = authorize();

      const response = await rename(authorized.principalId, { name: "  Report agent (laptop) " });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        principal: { id: authorized.principalId, name: "Report agent (laptop)", revokedAt: null },
      });

      const overview = await app.request(`${ORIGIN}/admin/access`, {
        headers: { "X-Test-Portal": "yes" },
      });
      expect((await overview.json()).principals.map((p: { name: string }) => p.name)).toEqual([
        "Report agent (laptop)",
      ]);
      const audit = await app.request(
        `${ORIGIN}/admin/access/audit?principalId=${authorized.principalId}`,
        { headers: { "X-Test-Portal": "yes" } },
      );
      const events: Array<{ eventType: string }> = (await audit.json()).items;
      expect(events.filter((event) => event.eventType === "principal-renamed")).toHaveLength(1);
      expect(events.find((event) => event.eventType === "principal-renamed")).toMatchObject({
        eventType: "principal-renamed",
        principalId: authorized.principalId,
        actorTokenId: PORTAL_TOKEN_ID,
        detail: { previousName: "Fictional report agent", name: "Report agent (laptop)" },
      });
    });

    test("refuses a blank, oversized or extra-field body before touching the store", async () => {
      const authorized = authorize();
      const bodies = [
        { name: "   " },
        { name: "x".repeat(121) },
        { name: "Ok", kind: "service" },
        {},
      ];
      for (const body of bodies) {
        const response = await rename(authorized.principalId, body);
        expect(response.status).toBe(400);
      }
      const overview = await app.request(`${ORIGIN}/admin/access`, {
        headers: { "X-Test-Portal": "yes" },
      });
      expect((await overview.json()).principals[0].name).toBe("Fictional report agent");
    });

    test("an identity that is unknown, malformed or revoked is not found", async () => {
      const authorized = authorize();
      expect((await rename("not-a-uuid", { name: "Anything" })).status).toBe(404);
      const unknown = await rename("00000000-0000-4000-8000-0000000000aa", { name: "Anything" });
      expect(unknown.status).toBe(404);

      const revoked = await app.request(`${ORIGIN}/portal/api/access/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Test-Portal": "yes",
          "X-Omnesis-CSRF": CSRF,
        },
        body: JSON.stringify({ kind: "principal", id: authorized.principalId }),
      });
      expect(await revoked.json()).toEqual({ revoked: true });
      const late = await rename(authorized.principalId, { name: "Too late" });
      expect(late.status).toBe(404);
      expect(await late.json()).toEqual({ error: "not-found" });
    });

    test("needs an admin caller", async () => {
      const authorized = authorize();
      const anonymous = await app.request(
        `${ORIGIN}/admin/access/principals/${authorized.principalId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Anyone" }),
        },
      );
      expect(anonymous.status).toBe(401);
    });
  });
});

async function registerClient(
  overrides: Record<string, unknown> = {},
): Promise<{ client_id: string; client_secret?: string }> {
  return registerClientOn(app, overrides);
}

test("a client connects by saying what it may do, and its next look-up proposes that connection", async () => {
  const registration = await registerClient();
  const started = await app.request(authorizationUrl(registration.client_id, "state-connect"));
  const consentUrl = new URL(started.headers.get("location")!, ORIGIN);
  const consentHtml = await (await app.request(consentUrl)).text();
  const userCode = consentHtml.match(/data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u)![1]!;
  const lookup = await portalJson("/portal/api/access/authorizations/lookup", { code: userCode });
  expect((lookup.body as { reconnect: unknown }).reconnect).toBeNull();
  const approvalId = (lookup.body as { request: { approvalId: string } }).request.approvalId;
  const decided = await portalJson(`/portal/api/access/authorizations/${approvalId}/decision`, {
    decision: "approve",
    selection: {
      kind: "connect",
      rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
    },
  });
  expect(decided.response.status).toBe(200);
  const completed = await portalJson(
    `/portal/api/access/authorizations/${approvalId}/complete`,
    {},
  );
  expect(completed.response.status).toBe(200);

  const overview = (await (
    await app.request(`${ORIGIN}/portal/api/access`, { headers: { "X-Test-Portal": "yes" } })
  ).json()) as {
    principals: { id: string; name: string; grants: { id: string; levelId: string }[] }[];
  };
  expect(overview.principals.map((principal) => principal.name)).toEqual(["Stellar MCP Client"]);

  const again = await app.request(authorizationUrl(registration.client_id, "state-connect-2"));
  const againHtml = await (
    await app.request(new URL(again.headers.get("location")!, ORIGIN))
  ).text();
  const againCode = againHtml.match(/data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u)![1]!;
  const second = await portalJson("/portal/api/access/authorizations/lookup", { code: againCode });
  expect(second.body).toMatchObject({
    reconnect: null,
    connection: {
      defaultName: "Stellar MCP Client 2",
      defaultLevelName: "Stellar MCP Client 2",
      match: {
        connectionId: overview.principals[0]?.id,
        connectionName: "Stellar MCP Client",
        matchedBy: "client",
        levelId: overview.principals[0]?.grants[0]?.levelId,
        grant: { id: overview.principals[0]?.grants[0]?.id, revision: 1 },
      },
      recommended: "existing-level",
    },
  });
});

async function registerClientOn(
  targetApp: Hono<AppEnv>,
  overrides: Record<string, unknown> = {},
): Promise<{ client_id: string; client_secret?: string }> {
  const response = await targetApp.request(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Stellar MCP Client",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_uri: "https://example.com/client",
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string; client_secret?: string };
}

function authorizationUrl(clientId: string, state: string): URL {
  const authorize = new URL(`${ORIGIN}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state,
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "omnesis:access offline_access",
  }).toString();
  return authorize;
}

async function jsonRequest(
  targetApp: Hono<AppEnv>,
  path: string,
  body: unknown,
  headers: Record<string, string>,
) {
  const response = await targetApp.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

describe("a device's access level", () => {
  function answerDevice(name: string) {
    const device = createDevice(db, { name, kind: "integration" });
    createToken(db, device.id, [Scope("answer")], "initial");
    return device;
  }

  async function createLevel(name: string, rules: unknown) {
    const created = await portalJson("/admin/access/levels", { name, rules });
    expect(created.response.status).toBe(201);
    return (created.body as { level: { id: string; revision: number } }).level;
  }

  function putLevel(deviceId: string, body: unknown, headers: Record<string, string>) {
    return app.request(`${ORIGIN}/admin/access/devices/${deviceId}/level`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
  const PORTAL = { "X-Test-Portal": "yes", "X-Omnesis-CSRF": CSRF };

  test("is set and cleared from a portal session, and listed on the level", async () => {
    const level = await createLevel("Voice answers", ANSWER_RULES);
    const device = answerDevice("voice-desk");

    const put = await putLevel(device.id, { levelId: level.id }, PORTAL);
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      deviceId: device.id,
      level: {
        id: level.id,
        devices: [{ id: device.id, name: "voice-desk", kind: "integration" }],
      },
    });
    expect(getDevice(db, device.id)?.accessLevelId).toBe(level.id);

    const overview = await app.request(`${ORIGIN}/admin/access`, {
      headers: { "X-Test-Portal": "yes" },
    });
    const levels = ((await overview.json()) as { levels: { id: string; devices: unknown[] }[] })
      .levels;
    expect(levels.find((entry) => entry.id === level.id)?.devices).toEqual([
      { id: device.id, name: "voice-desk", kind: "integration" },
    ]);

    const cleared = await putLevel(device.id, { levelId: null }, PORTAL);
    expect(await cleared.json()).toEqual({ deviceId: device.id, level: null });
    expect(getDevice(db, device.id)?.accessLevelId).toBeNull();
  });

  test("is refused to a bearer token, even an admin one, and without the CSRF token", async () => {
    const level = await createLevel("Voice answers", ANSWER_RULES);
    const device = answerDevice("voice-desk");

    expect(
      (await putLevel(device.id, { levelId: level.id }, { "X-Test-Mobile": "yes" })).status,
    ).toBe(403);
    expect(
      (await putLevel(device.id, { levelId: level.id }, { "X-Test-Portal": "yes" })).status,
    ).toBe(403);
    expect(getDevice(db, device.id)?.accessLevelId).toBeNull();
  });

  test("maps refusals: a missing device 404s, a level that cannot answer or a stale one 409s", async () => {
    const reading = await createLevel("Reading only", DIRECT_RULES);
    const answers = await createLevel("Voice answers", ANSWER_RULES);
    const device = answerDevice("voice-desk");

    const missing = await putLevel(
      "00000000-0000-4000-8000-00000000dcba",
      { levelId: answers.id },
      PORTAL,
    );
    expect(missing.status).toBe(404);
    expect((await putLevel("not-a-device", { levelId: answers.id }, PORTAL)).status).toBe(404);
    const noAnswer = await putLevel(device.id, { levelId: reading.id }, PORTAL);
    expect(noAnswer.status).toBe(409);
    expect(await noAnswer.json()).toEqual({ error: "invalid-selection" });
    const stale = await putLevel(
      device.id,
      { levelId: answers.id, expectedLevelRevision: answers.revision + 1 },
      PORTAL,
    );
    expect(await stale.json()).toEqual({ error: "stale-revision" });
    expect((await putLevel(device.id, { levelId: "not-a-uuid" }, PORTAL)).status).toBe(400);
  });

  test("a level with a device on it is not deleted", async () => {
    const level = await createLevel("Voice answers", ANSWER_RULES);
    const device = answerDevice("voice-desk");
    await putLevel(device.id, { levelId: level.id }, PORTAL);

    const removed = await app.request(`${ORIGIN}/admin/access/levels/${level.id}`, {
      method: "DELETE",
      headers: PORTAL,
    });
    expect(removed.status).toBe(409);
    expect(await removed.json()).toEqual({ error: "level-in-use" });
  });
});

async function portalJson(path: string, body: unknown) {
  const response = await app.request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Portal": "yes",
      "X-Omnesis-CSRF": CSRF,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

describe("a metadata-document client authenticating with private_key_jwt", () => {
  const CLIENT_ID = "https://assistant.example.com/oauth/client.json";
  const JWKS_URI = "https://assistant.example.com/oauth/jwks.json";
  const TOKEN_ENDPOINT = `${ORIGIN}/oauth/token`;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2_048 });
  const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2_048 });

  function signedAssertion(claims: Record<string, unknown> = {}, key = keys.privateKey): string {
    const now = Math.floor(Date.now() / 1_000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signingInput = `${encode({ alg: "RS256", kid: "assistant-key-1", typ: "JWT" })}.${encode({
      iss: CLIENT_ID,
      sub: CLIENT_ID,
      aud: TOKEN_ENDPOINT,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
      ...claims,
    })}`;
    return `${signingInput}.${sign("sha256", Buffer.from(signingInput), key).toString("base64url")}`;
  }

  function assertionFields(assertion = signedAssertion()) {
    return {
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    };
  }

  function post(
    path: string,
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) {
    return app.request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields),
    });
  }

  let jwksFetches: number;

  beforeEach(() => {
    jwksFetches = 0;
    const resolve = vi.fn(
      async (): Promise<OAuthClientMetadataDocument> => ({
        clientId: CLIENT_ID,
        clientName: "Example assistant",
        redirectUris: [REDIRECT],
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        tokenEndpointAuthMethod: "private_key_jwt",
        jwksUri: JWKS_URI,
        tokenEndpointAuthSigningAlg: "RS256",
        clientUri: "https://assistant.example.com/",
      }),
    );
    const clientAssertionVerifier = new ClientAssertionVerifier({
      now: Date.now,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      fetch: async (url) => {
        expect(url.href).toBe(JWKS_URI);
        jwksFetches += 1;
        return {
          status: 200,
          contentType: "application/json",
          cacheControl: "public, max-age=300",
          body: Buffer.from(
            JSON.stringify({
              keys: [
                {
                  ...keys.publicKey.export({ format: "jwk" }),
                  kid: "assistant-key-1",
                  use: "sig",
                  alg: "RS256",
                },
              ],
            }),
          ),
        };
      },
    });
    app = createTestApp({ clientMetadataResolver: { resolve }, clientAssertionVerifier });
  });

  async function authorizationCode(state: string): Promise<string> {
    const started = await app.request(authorizationUrl(CLIENT_ID, state));
    expect(started.status).toBe(303);
    const consentUrl = new URL(started.headers.get("location")!, ORIGIN);
    const handle = consentUrl.searchParams.get("request")!;
    const consent = await app.request(consentUrl);
    const userCode = (await consent.text()).match(
      /data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u,
    )?.[1];
    const lookup = await portalJson("/portal/api/access/authorizations/lookup", {
      code: userCode,
    });
    const approvalId = (lookup.body as { request: { approvalId: string } }).request.approvalId;
    const decided = await portalJson(`/portal/api/access/authorizations/${approvalId}/decision`, {
      decision: "approve",
      selection: {
        kind: "new-principal",
        principalName: "Fictional hosted assistant",
        grantName: "Direct access",
        rules: DIRECT_RULES,
        credentialLabel: "Fictional hosted assistant",
        expiresAt: null,
      },
    });
    expect(decided.response.status).toBe(200);
    const completed = await app.request(
      `${ORIGIN}/oauth/authorize/complete?request=${encodeURIComponent(handle)}`,
    );
    return new URL(completed.headers.get("location")!).searchParams.get("code")!;
  }

  function codeExchange(code: string) {
    return {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    };
  }

  test("registers the key set at authorize and exchanges, refreshes and revokes by assertion", async () => {
    const code = await authorizationCode("state-key-client");
    expect(
      db
        .prepare(
          `SELECT token_endpoint_auth_method, client_secret_hash, jwks_uri,
                  token_endpoint_auth_signing_alg
           FROM oauth_clients WHERE client_id = ?`,
        )
        .get(CLIENT_ID),
    ).toEqual({
      token_endpoint_auth_method: "private_key_jwt",
      client_secret_hash: null,
      jwks_uri: JWKS_URI,
      token_endpoint_auth_signing_alg: "RS256",
    });

    // Without any assertion the code is not spent: the client is refused first.
    const unauthenticated = await post("/oauth/token", {
      ...codeExchange(code),
      client_id: CLIENT_ID,
    });
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ error: "invalid_client" });

    const exchanged = await post("/oauth/token", {
      ...codeExchange(code),
      client_id: CLIENT_ID,
      ...assertionFields(),
    });
    expect(exchanged.status).toBe(200);
    const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string };
    expect(tokens.refresh_token).toBeTruthy();

    // The issuer identifier is an accepted audience too, and client_id may be omitted.
    const refreshed = await post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      ...assertionFields(signedAssertion({ aud: ORIGIN })),
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string };
    const lookupAccess = () =>
      new AccessService(db, directWriteGate(db)).lookupAccessToken(next.access_token, RESOURCE);
    expect(lookupAccess()).not.toBeNull();

    const unauthenticatedRevoke = await post("/oauth/revoke", {
      token: next.access_token,
      client_id: CLIENT_ID,
    });
    expect(unauthenticatedRevoke.status).toBe(401);
    expect(lookupAccess()).not.toBeNull();

    const revoked = await post("/oauth/revoke", {
      token: next.access_token,
      client_id: CLIENT_ID,
      ...assertionFields(signedAssertion({ aud: `${ORIGIN}/oauth/revoke` })),
    });
    expect(revoked.status).toBe(200);
    expect(lookupAccess()).toBeNull();
    // One key-set fetch served every assertion.
    expect(jwksFetches).toBe(1);
  });

  test("refuses invalid, replayed, mismatched or doubled client authentication", async () => {
    const code = await authorizationCode("state-key-client-refusals");
    const refusals: [string, Record<string, string>, Record<string, string>?][] = [
      [
        "wrong audience",
        assertionFields(signedAssertion({ aud: "https://elsewhere.example.org" })),
      ],
      ["another key", assertionFields(signedAssertion({}, otherKeys.privateKey))],
      [
        "missing assertion value",
        { client_assertion_type: assertionFields().client_assertion_type },
      ],
      [
        "unsupported assertion type",
        { ...assertionFields(), client_assertion_type: "urn:example:unsupported" },
      ],
      [
        "client_id that is not the assertion's",
        { ...assertionFields(), client_id: "https://attacker.example.com/client.json" },
      ],
    ];
    for (const [label, fields] of refusals) {
      const response = await post("/oauth/token", { ...codeExchange(code), ...fields });
      expect(response.status, label).toBe(401);
      expect(await response.json(), label).toMatchObject({ error: "invalid_client" });
    }

    const doubled = await post(
      "/oauth/token",
      { ...codeExchange(code), ...assertionFields() },
      { Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:invented`).toString("base64")}` },
    );
    expect(doubled.status).toBe(400);
    expect(await doubled.json()).toMatchObject({ error: "invalid_request" });

    const once = assertionFields();
    expect((await post("/oauth/token", { ...codeExchange(code), ...once })).status).toBe(200);
    const replayed = await post("/oauth/token", { ...codeExchange(code), ...once });
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toMatchObject({ error: "invalid_client" });
  });

  test("a public client presenting an assertion is refused, and public clients are unaffected", async () => {
    const registration = await registerClient();
    const withAssertion = await post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: "fictional-refresh-token",
      client_id: registration.client_id,
      ...assertionFields(
        signedAssertion({ iss: registration.client_id, sub: registration.client_id }),
      ),
    });
    expect(withAssertion.status).toBe(401);
    expect(await withAssertion.json()).toMatchObject({ error: "invalid_client" });

    const plain = await post("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: "fictional-refresh-token",
      client_id: registration.client_id,
    });
    expect(plain.status).toBe(400);
    expect(await plain.json()).toMatchObject({ error: "invalid_grant" });
    expect(jwksFetches).toBe(0);
  });

  test("dynamic registration still refuses private_key_jwt", async () => {
    const response = await app.request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Fictional key client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "private_key_jwt",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
  });
});
