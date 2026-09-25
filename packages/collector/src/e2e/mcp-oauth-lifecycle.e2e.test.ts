// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";

import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  accessOverview,
  authorizeMcpClient,
  beginMcpAuthorization,
  clientFor,
  completeOAuthAuthorization,
  decideOAuthAuthorization,
  InMemoryOAuthClientProvider,
  loginPortal,
  lookupOAuthConsent,
  newAnswerPrincipalSelection,
  portalJson,
  requiredHeader,
  revokeAccess,
  transportFor,
} from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const CLAUDE_CODE_REDIRECT = "http://localhost:48124/callback";

describe("MCP OAuth host lifecycle — spawned gateway", () => {
  let harness: SyntheticE2EHarness;
  let aliasGatewayUrl = "";

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "default",
      agentBackend: "replay",
      extraInference: { assignments: { "privacy-reviewer": "replay" } },
      extraGatewayConfig: ({ gatewayUrl }) => {
        aliasGatewayUrl = gatewayUrl.replace("https://localhost:", "https://127.0.0.1:");
        return {
          gateway: {
            publicBaseUrl: gatewayUrl,
            mcpResourceUrls: [`${aliasGatewayUrl}/mcp`],
          },
        };
      },
    });
    await harness.start();
  }, 120_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("supports origin-first and challenge-first host discovery through a complete public-client flow", async () => {
    const originMetadataResponse = await fetch(
      `${harness.gatewayUrl}/.well-known/oauth-protected-resource`,
    );
    expect(originMetadataResponse.status).toBe(200);
    const originMetadata = (await originMetadataResponse.json()) as {
      resource: string;
      authorization_servers: string[];
    };

    const challengeResponse = await fetch(`${harness.gatewayUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28",
          capabilities: {},
          clientInfo: { name: "challenge-first-e2e", version: "1.0.0" },
        },
      }),
    });
    expect(challengeResponse.status).toBe(401);
    const challenge = challengeResponse.headers.get("www-authenticate");
    const metadataUrl = challenge?.match(/resource_metadata="([^"]+)"/u)?.[1];
    expect(metadataUrl).toBe(`${harness.gatewayUrl}/.well-known/oauth-protected-resource/mcp`);
    const challengedMetadata = (await (await fetch(metadataUrl!)).json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(challengedMetadata).toEqual(originMetadata);
    expect(originMetadata).toEqual(
      expect.objectContaining({
        resource: `${harness.gatewayUrl}/mcp`,
        authorization_servers: [harness.gatewayUrl],
      }),
    );

    const authorizationServer = (await (
      await fetch(
        `${originMetadata.authorization_servers[0]}/.well-known/oauth-authorization-server`,
      )
    ).json()) as {
      issuer: string;
      registration_endpoint: string;
      authorization_endpoint: string;
      token_endpoint: string;
      code_challenge_methods_supported: string[];
    };
    expect(authorizationServer).toMatchObject({
      issuer: harness.gatewayUrl,
      registration_endpoint: `${harness.gatewayUrl}/oauth/register`,
      authorization_endpoint: `${harness.gatewayUrl}/oauth/authorize`,
      token_endpoint: `${harness.gatewayUrl}/oauth/token`,
      code_challenge_methods_supported: expect.arrayContaining(["S256"]),
    });

    const authorized = await authorizeMcpClient(gateway(), {
      principalName: "Fictional hosted assistant",
      grantName: "hosted answer access",
      credentialLabel: "Fictional hosted public client",
      capabilities: ["answer"],
      client: {
        redirectUrl: CHATGPT_REDIRECT,
        clientName: "Fictional hosted MCP client",
        clientUri: "https://example.com/mcp-client",
      },
    });
    try {
      expect(authorized.provider.savedClientInformation).toMatchObject({
        client_id: expect.stringMatching(/^omn_oc_/u),
      });
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "ask_omnesis",
        "get_answer_status",
      ]);
    } finally {
      await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
    }
  }, 60_000);

  test("authorizes an alias resource through the canonical issuer and uses its exact audience", async () => {
    const configured = JSON.parse(
      readFileSync(`${harness.getConfigDir()}/omnesis.json`, "utf8"),
    ) as { gateway?: { mcpResourceUrls?: string[] } };
    expect(configured.gateway?.mcpResourceUrls).toEqual([`${aliasGatewayUrl}/mcp`]);
    const aliasMetadataResponse = await fetch(
      `${aliasGatewayUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    const aliasMetadataBody = await aliasMetadataResponse.text();
    expect(aliasMetadataResponse.status, aliasMetadataBody).toBe(200);
    expect(JSON.parse(aliasMetadataBody)).toMatchObject({
      resource: `${aliasGatewayUrl}/mcp`,
      authorization_servers: [harness.gatewayUrl],
    });

    const authorized = await authorizeMcpClient(
      { gatewayUrl: aliasGatewayUrl, apiKey: harness.apiKey },
      {
        principalName: "Fictional private-route assistant",
        grantName: "private-route answer access",
        credentialLabel: "Fictional private-route client",
        capabilities: ["answer"],
        client: {
          redirectUrl: "http://127.0.0.1:48126/callback",
          clientName: "Fictional alias MCP client",
        },
      },
    );
    try {
      expect(authorized.provider.discoveryState()).toMatchObject({
        resourceMetadata: { resource: `${aliasGatewayUrl}/mcp` },
        authorizationServerMetadata: { issuer: harness.gatewayUrl },
      });
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "ask_omnesis",
        "get_answer_status",
      ]);
    } finally {
      await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
    }
  }, 60_000);

  test("completes the Claude Code localhost callback flow", async () => {
    const authorized = await authorizeMcpClient(gateway(), {
      principalName: "claude-code e2e principal",
      grantName: "claude-code answer access",
      credentialLabel: "claude-code e2e credential",
      capabilities: ["answer"],
      client: {
        redirectUrl: CLAUDE_CODE_REDIRECT,
        clientName: "Claude Code",
      },
    });
    try {
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "ask_omnesis",
        "get_answer_status",
      ]);
    } finally {
      await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
    }
  }, 60_000);

  test("completes a Codex flow that repeats the OAuth resource indicator", async () => {
    const authorized = await authorizeMcpClient(gateway(), {
      principalName: "codex repeated-resource principal",
      grantName: "codex repeated-resource answer access",
      credentialLabel: "codex repeated-resource credential",
      capabilities: ["answer"],
      client: {
        redirectUrl: "http://127.0.0.1:48125/callback/fictional-opaque-segment",
        clientName: "Codex",
        duplicateResourceIndicator: true,
      },
    });
    try {
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "ask_omnesis",
        "get_answer_status",
      ]);
    } finally {
      await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
    }
  }, 60_000);

  test("keeps simultaneous authorization windows isolated for one registered client", async () => {
    const first = await beginMcpAuthorization(gateway());
    try {
      if (!first.provider.authorizationUrl)
        throw new Error("OAuth did not expose its authorization URL.");
      const secondStart = await fetch(first.provider.authorizationUrl, { redirect: "manual" });
      expect(secondStart.status).toBe(303);
      const secondConsentUrl = new URL(requiredHeader(secondStart, "location"), harness.gatewayUrl);

      const portal = await loginPortal(gateway());
      const firstRequest = await lookupOAuthConsent(harness.gatewayUrl, portal, first.consentUrl);
      const secondRequest = await lookupOAuthConsent(harness.gatewayUrl, portal, secondConsentUrl);
      expect(secondRequest.approvalId).not.toBe(firstRequest.approvalId);

      const overview = await accessOverview(harness.gatewayUrl, portal);
      await decideOAuthAuthorization(harness.gatewayUrl, portal, secondRequest.approvalId, {
        decision: "approve",
        selection: newAnswerPrincipalSelection(overview, "Duplicate-window principal"),
      });
      await decideOAuthAuthorization(harness.gatewayUrl, portal, firstRequest.approvalId, {
        decision: "deny",
      });

      const secondCompletion = await completeOAuthAuthorization(
        harness.gatewayUrl,
        secondConsentUrl,
      );
      expect(secondCompletion.status).toBe(303);
      const secondCallback = new URL(requiredHeader(secondCompletion, "location"));
      expect(secondCallback.searchParams.get("code")).toBeTruthy();
      await first.transport.finishAuth(secondCallback.searchParams);

      const firstCompletion = await completeOAuthAuthorization(harness.gatewayUrl, first);
      expect(firstCompletion.status).toBe(303);
      const firstCallback = new URL(requiredHeader(firstCompletion, "location"));
      expect(firstCallback.searchParams.get("error")).toBe("access_denied");
      expect(firstCallback.searchParams.get("code")).toBeNull();

      await Promise.allSettled([first.client.close(), first.transport.close()]);
      const transport = transportFor(harness.gatewayUrl, first.provider);
      const client = clientFor("duplicate-window-e2e");
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
          "ask_omnesis",
          "get_answer_status",
        ]);
      } finally {
        await Promise.allSettled([client.close(), transport.close()]);
      }

      const db = new Database(harness.getDbPath(), { readonly: true });
      try {
        expect(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM principal_credentials
               WHERE oauth_client_id = ? AND revoked_at IS NULL`,
            )
            .get(first.provider.savedClientInformation!.client_id),
        ).toEqual({ count: 1 });
      } finally {
        db.close();
      }
    } finally {
      await Promise.allSettled([first.client.close(), first.transport.close()]);
    }
  }, 60_000);

  test("isolates fresh state and PKCE for concurrent attempts by one registered client", async () => {
    const first = await beginMcpAuthorization(gateway());
    const secondProvider = new InMemoryOAuthClientProvider();
    secondProvider.saveClientInformation(first.provider.savedClientInformation!);
    const second = await beginMcpAuthorization(gateway(), undefined, secondProvider);
    try {
      expect(second.provider.savedClientInformation?.client_id).toBe(
        first.provider.savedClientInformation?.client_id,
      );
      expect(second.provider.stateValue).not.toBe(first.provider.stateValue);
      expect(second.provider.codeVerifier()).not.toBe(first.provider.codeVerifier());

      const portal = await loginPortal(gateway());
      const [firstRequest, secondRequest] = await Promise.all([
        lookupOAuthConsent(harness.gatewayUrl, portal, first.consentUrl),
        lookupOAuthConsent(harness.gatewayUrl, portal, second.consentUrl),
      ]);
      expect(secondRequest.approvalId).not.toBe(firstRequest.approvalId);

      const overview = await accessOverview(harness.gatewayUrl, portal);
      await decideOAuthAuthorization(harness.gatewayUrl, portal, secondRequest.approvalId, {
        decision: "approve",
        selection: newAnswerPrincipalSelection(overview, "Fresh-attempt principal"),
      });
      await decideOAuthAuthorization(harness.gatewayUrl, portal, firstRequest.approvalId, {
        decision: "deny",
      });

      const secondCompletion = await completeOAuthAuthorization(harness.gatewayUrl, second);
      expect(secondCompletion.status).toBe(303);
      const secondCallback = new URL(requiredHeader(secondCompletion, "location"));
      expect(secondCallback.searchParams.get("state")).toBe(second.provider.stateValue);
      await second.transport.finishAuth(secondCallback.searchParams);
      expect(second.provider.savedTokens?.access_token).toMatch(/^omn_oat_/u);

      const firstCompletion = await completeOAuthAuthorization(harness.gatewayUrl, first);
      expect(firstCompletion.status).toBe(303);
      const firstCallback = new URL(requiredHeader(firstCompletion, "location"));
      expect(firstCallback.searchParams.get("state")).toBe(first.provider.stateValue);
      expect(firstCallback.searchParams.get("error")).toBe("access_denied");
      expect(first.provider.savedTokens).toBeUndefined();
    } finally {
      await Promise.allSettled([
        first.client.close(),
        first.transport.close(),
        second.client.close(),
        second.transport.close(),
      ]);
    }
  }, 60_000);

  test("preserves a pending request and its issued PKCE code across gateway restarts", async () => {
    const pending = await beginMcpAuthorization(gateway());
    try {
      const portalBeforeRestart = await loginPortal(gateway());
      const request = await lookupOAuthConsent(
        harness.gatewayUrl,
        portalBeforeRestart,
        pending.consentUrl,
      );

      await harness.restartGateway();
      const portalAfterRestart = await loginPortal(gateway());
      const lookedUpAgain = await portalJson<{ request: { approvalId: string } }>(
        harness.gatewayUrl,
        portalAfterRestart,
        "/portal/api/access/authorizations/lookup",
        { code: request.userCode },
      );
      expect(lookedUpAgain.request.approvalId).toBe(request.approvalId);

      const overview = await accessOverview(harness.gatewayUrl, portalAfterRestart);
      await decideOAuthAuthorization(harness.gatewayUrl, portalAfterRestart, request.approvalId, {
        decision: "approve",
        selection: newAnswerPrincipalSelection(overview, "Restarted authorization principal"),
      });
      const completion = await completeOAuthAuthorization(harness.gatewayUrl, pending);
      expect(completion.status).toBe(303);
      const callback = new URL(requiredHeader(completion, "location"));
      expect(callback.searchParams.get("code")).toBeTruthy();

      await harness.restartGateway();
      await pending.transport.finishAuth(callback.searchParams);
      expect(pending.provider.savedTokens).toMatchObject({
        access_token: expect.stringMatching(/^omn_oat_/u),
        refresh_token: expect.stringMatching(/^omn_ort_/u),
      });

      await Promise.allSettled([pending.client.close(), pending.transport.close()]);
      const transport = transportFor(harness.gatewayUrl, pending.provider);
      const client = clientFor("restart-persisted-oauth-e2e");
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
          "ask_omnesis",
          "get_answer_status",
        ]);
      } finally {
        await Promise.allSettled([client.close(), transport.close()]);
      }
    } finally {
      await Promise.allSettled([pending.client.close(), pending.transport.close()]);
    }
  }, 90_000);

  test("leaves completion ownership with an execution-bound client even in an authenticated popup", async () => {
    const pairing = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        name: "Fictional bound OAuth host",
        kind: "agent",
        scopes: ["subscriptions:receive"],
      }),
    });
    const paired = await harness.gatewayJson<{ credentials: { management: { token: string } } }>(
      "/devices/pair",
      {
        method: "POST",
        body: JSON.stringify({
          pairingCode: pairing.pairingCode,
          agentIntegration: { harness: "openclaw" },
          capabilities: {
            suggestedName: "Fictional bound OAuth host",
            agentIntegration: {
              harness: "openclaw",
              deliveryProtocolMin: 3,
              deliveryProtocolMax: 4,
              maxConcurrentRuns: 1,
              watchPrivacyPolicyVersion: 1,
            },
          },
        }),
      },
    );
    const pending = await beginMcpAuthorization(gateway(), {
      deviceToken: paired.credentials.management.token,
      harness: "openclaw",
    });
    try {
      const portal = await loginPortal(gateway());
      const consent = await fetch(pending.consentUrl, {
        headers: { Cookie: portal.cookie },
        redirect: "manual",
      });
      expect(consent.status).toBe(303);
      const target = new URL(requiredHeader(consent, "location"), harness.gatewayUrl);
      const approvalId = decodeURIComponent(target.pathname.split("/").at(-1) ?? "");
      expect(approvalId).toBeTruthy();

      const overview = await accessOverview(harness.gatewayUrl, portal);
      await decideOAuthAuthorization(harness.gatewayUrl, portal, approvalId, {
        decision: "approve",
        selection: newAnswerPrincipalSelection(overview, "Execution-bound popup principal"),
      });

      const portalCompletion = await fetch(
        `${harness.gatewayUrl}/portal/api/access/authorizations/${encodeURIComponent(approvalId)}/complete`,
        {
          method: "POST",
          headers: {
            Cookie: portal.cookie,
            "Content-Type": "application/json",
            "X-Omnesis-CSRF": portal.csrfToken,
          },
          body: "{}",
        },
      );
      expect(portalCompletion.status).toBe(409);
      expect(await portalCompletion.json()).toMatchObject({ error: "client-completes" });

      const clientCompletion = await completeOAuthAuthorization(harness.gatewayUrl, pending);
      expect(clientCompletion.status).toBe(303);
      const callback = new URL(requiredHeader(clientCompletion, "location"));
      await pending.transport.finishAuth(callback.searchParams);
      await Promise.allSettled([pending.client.close(), pending.transport.close()]);

      const transport = transportFor(harness.gatewayUrl, pending.provider);
      const client = clientFor("execution-bound-popup-e2e");
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
          "ask_omnesis",
          "get_answer_status",
        ]);
      } finally {
        await Promise.allSettled([client.close(), transport.close()]);
      }
    } finally {
      await Promise.allSettled([pending.client.close(), pending.transport.close()]);
    }
  }, 60_000);

  test("revoking an agent device ends its already-minted MCP authority", async () => {
    const pairing = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
      method: "POST",
      body: JSON.stringify({ kind: "agent" }),
    });
    const paired = await harness.gatewayJson<{
      device: { id: string };
      credentials: { management: { token: string } };
    }>("/devices/pair", {
      method: "POST",
      body: JSON.stringify({
        pairingCode: pairing.pairingCode,
        agentIntegration: { harness: "openclaw" },
        capabilities: {
          suggestedName: "Fictional revocable OAuth host",
          agentIntegration: {
            harness: "openclaw",
            deliveryProtocolMin: 3,
            deliveryProtocolMax: 4,
            maxConcurrentRuns: 1,
            watchPrivacyPolicyVersion: 1,
          },
        },
      }),
    });
    const authorized = await authorizeMcpClient(gateway(), {
      principalName: "Fictional revocable assistant",
      grantName: "Revocable reviewed access",
      credentialLabel: "Fictional revocable installation",
      capabilities: ["answer"],
      executionBinding: {
        deviceToken: paired.credentials.management.token,
        harness: "openclaw",
      },
    });
    try {
      const accessToken = authorized.provider.savedTokens?.access_token;
      const refreshToken = authorized.provider.savedTokens?.refresh_token;
      const clientId = authorized.provider.savedClientInformation?.client_id;
      if (!accessToken || !refreshToken || !clientId) {
        throw new Error("execution-bound client omitted persisted OAuth credentials");
      }

      const devices = await harness.gatewayJson<{
        items: Array<{
          id: string;
          revocationImpact?: {
            fingerprint: string;
            corpusCredentials: Array<{
              credentialLabel: string;
              principalName: string;
              grantName: string;
            }>;
            corpusAccess: Array<{
              credentialLabel: string;
              principalName: string;
              grantName: string;
            }>;
          };
        }>;
      }>("/admin/devices");
      const revocationImpact = devices.items.find(
        (device) => device.id === paired.device.id,
      )?.revocationImpact;
      expect(revocationImpact).toEqual({
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        corpusCredentials: [
          {
            credentialLabel: "Fictional revocable installation",
            principalName: "Fictional revocable assistant",
            grantName: "Revocable reviewed access",
          },
        ],
        corpusAccess: [
          {
            credentialLabel: "Fictional revocable installation",
            principalName: "Fictional revocable assistant",
            grantName: "Revocable reviewed access",
          },
        ],
      });
      if (!revocationImpact) throw new Error("agent device omitted its revocation impact");

      await harness.gatewayJson(
        `/admin/devices/${encodeURIComponent(paired.device.id)}?impactFingerprint=${revocationImpact.fingerprint}`,
        { method: "DELETE" },
      );

      const mcp = await fetch(`${harness.gatewayUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(mcp.status).toBe(401);

      const refresh = await fetch(`${harness.gatewayUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          resource: `${harness.gatewayUrl}/mcp`,
        }),
      });
      expect(refresh.status).toBe(400);
      expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
    } finally {
      await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
    }
  }, 90_000);

  test("keeps a revoked credential and refresh token dead across a gateway restart", async () => {
    const authorized = await authorizeMcpClient(gateway(), {
      principalName: "Fictional revoked restart principal",
      grantName: "Revoked restart Answer grant",
      credentialLabel: "Revoked restart credential",
      capabilities: ["answer"],
    });
    const accessToken = authorized.provider.savedTokens?.access_token;
    const refreshToken = authorized.provider.savedTokens?.refresh_token;
    const clientId = authorized.provider.savedClientInformation?.client_id;
    try {
      if (!accessToken || !refreshToken || !clientId) {
        throw new Error("authorized client omitted persisted OAuth credentials");
      }
      await revokeAccess(harness.gatewayUrl, authorized.portal, {
        kind: "credential",
        id: authorized.credentialId,
      });
      await harness.restartGateway();

      const mcp = await fetch(`${harness.gatewayUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(mcp.status).toBe(401);

      const refresh = await fetch(`${harness.gatewayUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          resource: `${harness.gatewayUrl}/mcp`,
        }),
      });
      expect(refresh.status).toBe(400);
      expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
    } finally {
      await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
    }
  }, 90_000);

  function gateway() {
    return {
      gatewayUrl: harness.gatewayUrl,
      apiKey: harness.apiKey,
      gatewayLogPath: harness.getGatewayLogPath(),
    };
  }
});
