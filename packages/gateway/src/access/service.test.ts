// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { runSchemaSetup } from "../data/schema.js";
import {
  AccessService,
  MAX_CONCURRENT_ACCESS_AUDIT_WRITES,
  MAX_PENDING_ACCESS_AUDIT_WRITES,
} from "./service.js";
import { registerOAuthClient } from "./store.js";
import { OAUTH_OFFLINE_ACCESS_SCOPE } from "./oauth-scopes.js";
import { MCP_ACCESS_SCOPE } from "./types.js";
import type { WriteGate } from "../write-gate.js";
import type { Db } from "../data/types.js";

const RESOURCE = "https://gateway.example.org/mcp";
let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
});

describe("AccessService token-exchange admission", () => {
  test("rejects unknown OAuth clients on the reader without calling the writer", async () => {
    const exchangeOAuthToken = vi.fn();
    const service = new AccessService(db, { exchangeOAuthToken } as unknown as WriteGate);

    await expect(
      service.exchangeOAuthToken(
        {
          grantType: "authorization_code",
          code: "unknown-code",
          clientId: "unknown-client",
          redirectUri: "http://127.0.0.1/callback",
          codeVerifier: "v".repeat(64),
          resource: RESOURCE,
        },
        RESOURCE,
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-client" });
    await expect(
      service.exchangeOAuthToken(
        {
          grantType: "refresh_token",
          refreshToken: "unknown-refresh-token",
          clientId: "unknown-client",
          resource: RESOURCE,
        },
        RESOURCE,
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-client" });
    expect(exchangeOAuthToken).not.toHaveBeenCalled();
  });
});

describe("AccessService authorization-request admission", () => {
  test("rejects invalid public requests on the reader before the shared writer", async () => {
    const redirectUri = "http://127.0.0.1:44123/callback";
    const client = registerOAuthClient(db, {
      clientName: "Fictional foreground client",
      redirectUris: [redirectUri],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      clientUri: null,
    });
    const createAuthorizationRequest = vi.fn(async () => ({
      ok: true as const,
      value: {
        id: "fictional-request",
        browserHandle: "fictional-handle",
        userCode: "ABCD-EFGH",
        expiresAt: Date.now() + 60_000,
      },
    }));
    const service = new AccessService(db, {
      createAuthorizationRequest,
    } as unknown as WriteGate);
    const base = {
      clientId: client.clientId,
      redirectUri,
      state: "fictional-state",
      codeChallenge: "x".repeat(43),
      resource: RESOURCE,
      scope: MCP_ACCESS_SCOPE,
    };

    await expect(
      service.createAuthorizationRequest({ ...base, clientId: "unknown-client" }, RESOURCE),
    ).resolves.toEqual({ ok: false, error: "invalid-client" });
    await expect(
      service.createAuthorizationRequest(
        { ...base, redirectUri: "http://127.0.0.1:44124/different-callback" },
        RESOURCE,
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-redirect-uri" });
    await expect(
      service.createAuthorizationRequest(
        { ...base, scope: `${MCP_ACCESS_SCOPE} ${OAUTH_OFFLINE_ACCESS_SCOPE}` },
        RESOURCE,
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-scope" });
    await expect(
      service.createAuthorizationRequest(
        { ...base, resource: "https://wrong.example/mcp" },
        RESOURCE,
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-resource" });
    expect(createAuthorizationRequest).not.toHaveBeenCalled();

    await expect(service.createAuthorizationRequest(base, RESOURCE)).resolves.toMatchObject({
      ok: true,
    });
    expect(createAuthorizationRequest).toHaveBeenCalledOnce();
  });
});

describe("AccessService durable audit admission", () => {
  test("bounds concurrent writer calls without acknowledging any event early", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let highWater = 0;
    const recordMcpToolInvocationAudit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          active += 1;
          highWater = Math.max(highWater, active);
          releases.push(() => {
            active -= 1;
            resolve(true);
          });
        }),
    );
    const service = new AccessService(db, { recordMcpToolInvocationAudit } as unknown as WriteGate);
    const calls = Array.from({ length: MAX_CONCURRENT_ACCESS_AUDIT_WRITES + 8 }, (_, index) =>
      service.recordMcpToolInvocation({
        accessTokenId: "44444444-4444-4444-8444-444444444444",
        principalId: "11111111-1111-4111-8111-111111111111",
        grantId: "22222222-2222-4222-8222-222222222222",
        grantRevision: 1,
        credentialId: "33333333-3333-4333-8333-333333333333",
        oauthClientId: "fictional-client",
        capability: "answer",
        tool: "ask_omnesis",
        outcome: "ok",
        requestId: `request-${index}`,
        sourceMode: "all",
        requireActiveAuthority: true,
      }),
    );
    await Promise.resolve();
    expect(recordMcpToolInvocationAudit).toHaveBeenCalledTimes(MAX_CONCURRENT_ACCESS_AUDIT_WRITES);
    expect(highWater).toBe(MAX_CONCURRENT_ACCESS_AUDIT_WRITES);
    expect(await Promise.race([calls.at(-1)!.then(() => "done"), Promise.resolve("pending")])).toBe(
      "pending",
    );

    while (releases.length > 0 || recordMcpToolInvocationAudit.mock.calls.length < calls.length) {
      releases.shift()?.();
      await Promise.resolve();
    }
    await Promise.all(calls);
    expect(highWater).toBeLessThanOrEqual(MAX_CONCURRENT_ACCESS_AUDIT_WRITES);
  });

  test("fails closed once both active and pending durable audit capacity are occupied", async () => {
    const never = new Promise<boolean>(() => {});
    const service = new AccessService(db, {
      recordMcpToolInvocationAudit: vi.fn(() => never),
    } as unknown as WriteGate);
    const input = {
      accessTokenId: "44444444-4444-4444-8444-444444444444",
      principalId: "11111111-1111-4111-8111-111111111111",
      grantId: "22222222-2222-4222-8222-222222222222",
      grantRevision: 1,
      credentialId: "33333333-3333-4333-8333-333333333333",
      oauthClientId: "fictional-client",
      capability: "answer" as const,
      tool: "ask_omnesis",
      outcome: "ok" as const,
      requestId: "request-capacity",
      sourceMode: "all" as const,
      requireActiveAuthority: true,
    };
    for (
      let index = 0;
      index < MAX_CONCURRENT_ACCESS_AUDIT_WRITES + MAX_PENDING_ACCESS_AUDIT_WRITES;
      index += 1
    ) {
      void service.recordMcpToolInvocation({ ...input, requestId: `request-${index}` });
    }
    await expect(
      service.recordMcpToolInvocation({ ...input, requestId: "request-over-capacity" }),
    ).rejects.toThrow("capacity exhausted");
  });
});
