// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { loadIntegrationCredentials } from "./credentials.js";
import { integrationOAuthFetch } from "./native-answer-mcp.js";
import { savePendingAuthorization } from "./pending-authorization.js";
import {
  authorizeIntegrationOAuthWithCredentialLock,
  IntegrationOAuthProvider,
  removeStaleRefreshLock,
  SerializedIntegrationAuthProvider,
  withCredentialRefreshLock,
} from "./oauth.js";

/** A credential file holding a refresh token and a cached token endpoint, so `auth()` refreshes. */
function writeRefreshableCredentials(
  directory: string,
  gatewayUrl = "https://gateway.example.org:7600",
): string {
  const credentialsPath = join(directory, "integration.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      gatewayUrl,
      deliveryToken: "omn_fictional_delivery",
      ingestionToken: "omn_fictional_ingestion",
      managementToken: "omn_fictional_management",
      oauth: {
        redirectUri: "http://127.0.0.1:48123/callback",
        clientInformation: {
          client_id: "client_fictional",
          issuer: gatewayUrl,
        },
        tokens: {
          access_token: "access-fictional",
          refresh_token: "refresh-fictional",
          issuer: gatewayUrl,
        },
        discoveryState: {
          authorizationServerUrl: gatewayUrl,
          authorizationServerMetadata: {
            issuer: gatewayUrl,
            authorization_endpoint: `${gatewayUrl}/oauth/authorize`,
            token_endpoint: `${gatewayUrl}/oauth/token`,
            response_types_supported: ["code"],
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  return credentialsPath;
}

describe("integration OAuth provider", () => {
  test("reclaims only a stale refresh lock whose owning process is gone", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-lock-"));
    try {
      const activeLock = join(directory, "active.refresh.lock");
      writeFileSync(activeLock, `${process.pid}\n`, { mode: 0o600 });
      const old = new Date(Date.now() - 5 * 60_000);
      utimesSync(activeLock, old, old);
      await removeStaleRefreshLock(activeLock);
      expect(existsSync(activeLock)).toBe(true);

      const abandonedLock = join(directory, "abandoned.refresh.lock");
      writeFileSync(abandonedLock, "999999\n", { mode: 0o600 });
      utimesSync(abandonedLock, old, old);
      await removeStaleRefreshLock(abandonedLock);
      expect(existsSync(abandonedLock)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("waits for the exclusive-create lease used by the Python integration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-cross-language-lock-"));
    const credentialsPath = join(directory, "integration.json");
    const lockPath = `${credentialsPath}.refresh.lock`;
    const holder = spawn(
      "python3",
      [
        "-c",
        "import os,sys,time; p=sys.argv[1]; f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.write(f,(str(os.getpid())+'\\n').encode()); print('ready',flush=True); time.sleep(.15); s=os.fstat(f); c=os.stat(p); (os.unlink(p) if (s.st_dev,s.st_ino)==(c.st_dev,c.st_ino) else None); os.close(f)",
        lockPath,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const exited = once(holder, "exit");
      await once(holder.stdout!, "data");
      let refreshed = false;
      await withCredentialRefreshLock(
        credentialsPath,
        undefined,
        () => undefined,
        async () => {
          refreshed = true;
        },
      );
      expect(refreshed).toBe(true);
      await exited;
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      holder.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("registers under the client name it was given", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-client-name-"));
    try {
      const credentialsPath = join(directory, "integration.json");
      writeFileSync(
        credentialsPath,
        JSON.stringify({
          gatewayUrl: "https://gateway.example.org:7600",
          deliveryToken: "omn_delivery_example",
          ingestionToken: "omn_ingestion_example",
          managementToken: "omn_management_example",
          oauth: {
            redirectUri: "http://127.0.0.1:48123/callback",
            clientInformation: {},
            tokens: {},
          },
        }),
        { mode: 0o600 },
      );
      expect(new IntegrationOAuthProvider(credentialsPath, "Hermes").clientMetadata).toMatchObject({
        client_name: "Hermes",
        redirect_uris: ["http://127.0.0.1:48123/callback"],
      });
      expect(
        new IntegrationOAuthProvider(credentialsPath, "OpenClaw").clientMetadata.client_name,
      ).toBe("OpenClaw");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists one authorization state and clears it with the PKCE verifier after exchange", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-provider-"));
    try {
      const credentialsPath = join(directory, "integration.json");
      writeFileSync(
        credentialsPath,
        JSON.stringify({
          gatewayUrl: "https://gateway.example.org:7600",
          deliveryToken: "omn_delivery_example",
          ingestionToken: "omn_ingestion_example",
          managementToken: "omn_management_example",
          oauth: {
            redirectUri: "http://127.0.0.1:48123/callback",
            clientInformation: {},
            tokens: {},
          },
        }),
        { mode: 0o600 },
      );
      const provider = new IntegrationOAuthProvider(credentialsPath, "OpenClaw");

      provider.saveDiscoveryState({
        authorizationServerUrl: "https://gateway.example.org:7600",
        authorizationServerMetadata: {
          issuer: "https://gateway.example.org:7600",
          authorization_endpoint: "https://gateway.example.org:7600/oauth/authorize",
          token_endpoint: "https://gateway.example.org:7600/oauth/token",
          response_types_supported: ["code"],
        },
      });
      expect(provider.discoveryState()).toMatchObject({
        authorizationServerUrl: "https://gateway.example.org:7600",
        authorizationServerMetadata: { issuer: "https://gateway.example.org:7600" },
      });

      const state = provider.state();
      expect(provider.state()).toBe(state);
      provider.saveCodeVerifier("pkce-verifier-fictional");
      expect(loadIntegrationCredentials(credentialsPath).oauth).toMatchObject({
        authorizationState: state,
        codeVerifier: "pkce-verifier-fictional",
      });

      const issuedAt = Date.now();
      provider.saveTokens({
        access_token: "principal-access-fictional",
        refresh_token: "principal-refresh-fictional",
        token_type: "Bearer",
      });
      expect(loadIntegrationCredentials(credentialsPath).oauth).toEqual({
        redirectUri: "http://127.0.0.1:48123/callback",
        clientInformation: {},
        discoveryState: expect.objectContaining({
          authorizationServerUrl: "https://gateway.example.org:7600",
        }),
        tokens: {
          access_token: "principal-access-fictional",
          refresh_token: "principal-refresh-fictional",
          token_type: "Bearer",
        },
        // The refresh token's issue time, which is the only thing the
        // keepalive has to reason about — no OAuth token response carries it.
        tokensObtainedAt: expect.any(Number),
      });
      expect(provider.tokensObtainedAt()).toBeGreaterThanOrEqual(issuedAt);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps the ticket's age when a save is not an issuance", () => {
    // The SDK saves for reasons that are not an issuance — it backfills a
    // missing issuer stamp before it even attempts a refresh. Moving the stamp
    // there would tell the keepalive there were weeks left on a ticket about
    // to expire, disarming the one mechanism that keeps a quiet installation
    // alive.
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-age-"));
    try {
      const credentialsPath = join(directory, "integration.json");
      const issuedAt = Date.now() - 20 * 24 * 60 * 60_000;
      writeFileSync(
        credentialsPath,
        `${JSON.stringify({
          gatewayUrl: "https://gateway.example.org:7600",
          deliveryToken: "omn_fictional_delivery",
          ingestionToken: "omn_fictional_ingestion",
          managementToken: "omn_fictional_management",
          oauth: {
            redirectUri: "http://127.0.0.1:48123/callback",
            clientInformation: { client_id: "client_fictional" },
            tokens: { access_token: "access-old", refresh_token: "refresh-old" },
            tokensObtainedAt: issuedAt,
          },
        })}\n`,
        { mode: 0o600 },
      );
      const provider = new IntegrationOAuthProvider(credentialsPath, "OpenClaw");

      provider.saveTokens({
        access_token: "access-old",
        refresh_token: "refresh-old",
        issuer: "https://gateway.example.org:7600",
      } as never);
      expect(provider.tokensObtainedAt()).toBe(issuedAt);

      provider.saveTokens({ access_token: "access-new", refresh_token: "refresh-new" } as never);
      expect(provider.tokensObtainedAt()).toBeGreaterThan(issuedAt);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("recovers only when the refresh token is spent, never on a transient failure", async () => {
    const provider = {
      tokens: () => ({ access_token: "principal-access-old" }),
      credentialsFilePath: "",
    } as unknown as IntegrationOAuthProvider;
    const context = {
      response: new Response(null, { status: 401 }),
      serverUrl: new URL("https://gateway.example.org:7600/mcp"),
      fetchFn: fetch,
    };

    // A throw from outside the SDK's own refresh attempt — an unreadable
    // credential file, a discovery failure, a bug — says nothing about the
    // ticket. Spending the device's management token on one would bury the
    // real error behind a call that usually succeeds.
    let recoveries = 0;
    const unrelated = new SerializedIntegrationAuthProvider(
      provider,
      "https://gateway.example.org:7600",
      () => Promise.reject(new Error("could not read integration credentials")),
      async () => {
        recoveries += 1;
      },
    );
    await expect(unrelated.onUnauthorized(context)).rejects.toThrow(/could not read/u);
    expect(recoveries).toBe(0);

    // The SDK asking for a browser redirect is the one signal that does mean
    // the ticket is gone.
    const spent = new SerializedIntegrationAuthProvider(
      provider,
      "https://gateway.example.org:7600",
      async () => "REDIRECT",
      async () => {
        recoveries += 1;
      },
    );
    await spent.onUnauthorized(context);
    expect(recoveries).toBe(1);
  });

  test("keeps the cause of a refresh failure the SDK swallowed", async () => {
    const provider = {
      tokens: () => ({ access_token: "principal-access-old" }),
      credentialsFilePath: "",
      clearAuthorizationAttempt: () => {},
    } as unknown as IntegrationOAuthProvider;
    const refreshBody = () => new URLSearchParams({ grant_type: "refresh_token" });
    // Stands in for `auth()`: the refresh POST fails, the SDK swallows it and
    // asks for a browser instead.
    const swallowingAuthorize = async (
      _provider: unknown,
      _gatewayUrl: string,
      fetchFn: (input: string | URL, init?: RequestInit) => Promise<Response>,
    ) => {
      await fetchFn("https://gateway.example.org:7600/oauth/token", {
        method: "POST",
        body: refreshBody(),
      }).catch(() => undefined);
      return "REDIRECT" as const;
    };
    const warnings: string[] = [];
    const logger = { warn: (message: string) => warnings.push(message) };
    const networkDown = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
    };

    // Recovery heals it: the cause is logged, nothing is thrown.
    const healed = new SerializedIntegrationAuthProvider(
      provider,
      "https://gateway.example.org:7600",
      swallowingAuthorize,
      async () => {},
      logger,
    );
    await healed.onUnauthorized(unauthorized(networkDown));
    expect(warnings).toEqual([
      "Omnesis OAuth refresh failed (fetch failed: ECONNRESET socket hang up); re-issuing with the device's management token",
    ]);

    // Recovery fails too: its own error is what the caller sees, and the
    // refresh failure that led there is not lost behind it.
    const refused = new SerializedIntegrationAuthProvider(
      provider,
      "https://gateway.example.org:7600",
      swallowingAuthorize,
      () => Promise.reject(new Error("Omnesis corpus access is no longer authorized.")),
      logger,
    );
    await expect(
      refused.onUnauthorized(
        unauthorized(async () => Response.json({ error: "server_error" }, { status: 503 })),
      ),
    ).rejects.toThrow(
      'Omnesis corpus access is no longer authorized. (The refresh attempt before it failed: HTTP 503: {"error":"server_error"}.)',
    );
  });

  test("recognises the refresh request the real SDK sends", async () => {
    // The observer keys on the request shape `auth()` produces, so this runs
    // the SDK itself against a token endpoint that refuses the refresh token.
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-refusal-"));
    try {
      const credentialsPath = writeRefreshableCredentials(directory);
      const tokenRequests: string[] = [];
      const gateway = async (input: string | URL, init?: RequestInit) => {
        if (String(input) !== "https://gateway.example.org:7600/oauth/token") {
          return new Response(null, { status: 404 });
        }
        tokenRequests.push(String(init?.body));
        return Response.json(
          {
            error: "invalid_grant",
            error_description: "The refresh token is\n  no longer valid.",
          },
          { status: 400 },
        );
      };
      const warnings: string[] = [];
      let recoveries = 0;
      await new SerializedIntegrationAuthProvider(
        new IntegrationOAuthProvider(credentialsPath, "OpenClaw"),
        "https://gateway.example.org:7600",
        undefined,
        async () => {
          recoveries += 1;
        },
        { warn: (message) => warnings.push(message) },
      ).renew(gateway);

      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0]).toContain("grant_type=refresh_token");
      expect(recoveries).toBe(1);
      expect(warnings).toEqual([
        'Omnesis OAuth refresh failed (HTTP 400: {"error":"invalid_grant","error_description":"The refresh token is\\n no longer valid."}); re-issuing with the device\'s management token',
      ]);
      expect(warnings.join("\n")).not.toContain("refresh-fictional");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("repeats a refresh whose response never arrived instead of recovering", async () => {
    // The gateway may already have rotated the token when the first response
    // is lost; it answers the identical repeat with the pair it issued.
    const lostResponses = [
      async (): Promise<Response> => {
        throw new Error("Omnesis OAuth request timed out");
      },
      async () => Response.json({ error: "server_error" }, { status: 503 }),
    ];
    for (const lost of lostResponses) {
      const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-retry-"));
      try {
        const credentialsPath = writeRefreshableCredentials(directory);
        const tokenRequests: string[] = [];
        const gateway = async (input: string | URL, init?: RequestInit) => {
          if (String(input) !== "https://gateway.example.org:7600/oauth/token") {
            return new Response(null, { status: 404 });
          }
          tokenRequests.push(String(init?.body));
          if (tokenRequests.length === 1) return lost();
          return Response.json({
            access_token: "access-rotated",
            refresh_token: "refresh-rotated",
            token_type: "Bearer",
            expires_in: 3600,
          });
        };
        let recoveries = 0;
        await new SerializedIntegrationAuthProvider(
          new IntegrationOAuthProvider(credentialsPath, "OpenClaw"),
          "https://gateway.example.org:7600",
          undefined,
          async () => {
            recoveries += 1;
          },
        ).renew(gateway);

        expect(tokenRequests).toHaveLength(2);
        expect(tokenRequests[1]).toBe(tokenRequests[0]);
        expect(tokenRequests[1]).toContain("refresh_token=refresh-fictional");
        expect(recoveries).toBe(0);
        expect(loadIntegrationCredentials(credentialsPath).oauth.tokens).toMatchObject({
          access_token: "access-rotated",
          refresh_token: "refresh-rotated",
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test("rides out a 40-second writer stall instead of asking for a browser", async () => {
    // A restarted gateway can hold its single writer for about 40 seconds, so
    // the token endpoint answers that late. The connect flow's refresh must
    // wait for it — and, when even that budget runs out, repeat into the
    // gateway's replay window — rather than fall through to an interactive
    // approval.
    for (const stall of [
      { answeredAttempt: 1, beforeAnswerMs: 40_000 },
      { answeredAttempt: 2, beforeAnswerMs: 70_000 },
    ]) {
      const held: ServerResponse[] = [];
      let arrived: () => void = () => {};
      const server = createServer((request, response) => {
        if (request.url !== "/oauth/token") {
          response.writeHead(404).end();
          return;
        }
        held.push(response);
        arrived();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("fictional server did not listen");
      const gatewayUrl = `http://127.0.0.1:${address.port}`;
      const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-stall-"));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const credentialsPath = writeRefreshableCredentials(directory, gatewayUrl);
        const browsers: URL[] = [];
        const provider = new IntegrationOAuthProvider(credentialsPath, "Hermes", (url) => {
          browsers.push(url);
        });
        const nextArrival = () => new Promise<void>((resolve) => (arrived = resolve));
        let arrival = nextArrival();
        const result = authorizeIntegrationOAuthWithCredentialLock(
          provider,
          gatewayUrl,
          integrationOAuthFetch(gatewayUrl),
        );
        await arrival;
        if (stall.answeredAttempt === 2) {
          // The first attempt outlives its budget; the repeat goes out at once.
          arrival = nextArrival();
          await vi.advanceTimersByTimeAsync(55_000);
          await arrival;
          await vi.advanceTimersByTimeAsync(stall.beforeAnswerMs - 55_000);
        } else {
          await vi.advanceTimersByTimeAsync(stall.beforeAnswerMs);
        }
        held[stall.answeredAttempt - 1]!.writeHead(200, { "content-type": "application/json" });
        held[stall.answeredAttempt - 1]!.end(
          JSON.stringify({
            access_token: "access-rotated",
            refresh_token: "refresh-rotated",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );

        await expect(result).resolves.toBe("AUTHORIZED");
        expect(held).toHaveLength(stall.answeredAttempt);
        expect(browsers).toEqual([]);
        expect(loadIntegrationCredentials(credentialsPath).oauth.tokens).toMatchObject({
          access_token: "access-rotated",
          refresh_token: "refresh-rotated",
        });
      } finally {
        vi.useRealTimers();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test("repeats a lost refresh only once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-retry-once-"));
    try {
      const credentialsPath = writeRefreshableCredentials(directory);
      let tokenRequests = 0;
      const gateway = async (input: string | URL): Promise<Response> => {
        if (String(input) !== "https://gateway.example.org:7600/oauth/token") {
          return new Response(null, { status: 404 });
        }
        tokenRequests += 1;
        throw new Error("Omnesis OAuth request timed out");
      };
      let recoveries = 0;
      await new SerializedIntegrationAuthProvider(
        new IntegrationOAuthProvider(credentialsPath, "OpenClaw"),
        "https://gateway.example.org:7600",
        undefined,
        async () => {
          recoveries += 1;
        },
      ).renew(gateway);
      expect(tokenRequests).toBe(2);
      expect(recoveries).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("says nothing about a refresh when the SDK never attempted one", async () => {
    const provider = {
      tokens: () => ({ access_token: "principal-access-old" }),
      credentialsFilePath: "",
      clearAuthorizationAttempt: () => {},
    } as unknown as IntegrationOAuthProvider;
    const warnings: string[] = [];
    const serialized = new SerializedIntegrationAuthProvider(
      provider,
      "https://gateway.example.org:7600",
      async () => "REDIRECT",
      () => Promise.reject(new Error("Omnesis corpus access is no longer authorized.")),
      { warn: (message) => warnings.push(message) },
    );
    await expect(serialized.onUnauthorized(unauthorized(fetch))).rejects.toThrow(
      /^Omnesis corpus access is no longer authorized\.$/u,
    );
    expect(warnings).toEqual([]);
  });

  test("a failed recovery leaves no authorization the keepalive would wait on", async () => {
    // Getting to recovery means the SDK already wrote a PKCE verifier for an
    // authorization nobody can complete. Left there, it reads as "somebody is
    // approving this right now" — which is exactly what the scheduled
    // keepalive stands down for, so one transient failure would disarm it for
    // the life of the installation.
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-recovery-"));
    try {
      const credentialsPath = join(directory, "integration.json");
      writeFileSync(
        credentialsPath,
        `${JSON.stringify({
          gatewayUrl: "https://gateway.example.org:7600",
          deliveryToken: "omn_fictional_delivery",
          ingestionToken: "omn_fictional_ingestion",
          managementToken: "omn_fictional_management",
          oauth: {
            redirectUri: "http://127.0.0.1:48123/callback",
            clientInformation: { client_id: "client_fictional" },
            tokens: {},
            codeVerifier: "v".repeat(64),
          },
        })}\n`,
        { mode: 0o600 },
      );
      const provider = new IntegrationOAuthProvider(credentialsPath, "OpenClaw");
      expect(provider.hasPendingAuthorization()).toBe(true);

      const serialized = new SerializedIntegrationAuthProvider(
        provider,
        "https://gateway.example.org:7600",
        async () => "REDIRECT",
        () => Promise.reject(new Error("gateway unreachable")),
      );
      await expect(
        serialized.onUnauthorized({
          response: new Response(null, { status: 401 }),
          serverUrl: new URL("https://gateway.example.org:7600/mcp"),
          fetchFn: fetch,
        }),
      ).rejects.toThrow(/gateway unreachable/u);

      expect(provider.hasPendingAuthorization()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("withdraws an invalidated token set without erasing it until a replacement is saved", () => {
    // The SDK invalidates the stored set on `invalid_grant` and then looks for
    // a replacement. An attempt that finds none must not leave the file with
    // nothing: the access token may still be good, and the client it names is
    // what the headless recovery re-keys.
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-withdraw-"));
    try {
      const credentialsPath = join(directory, "integration.json");
      writeFileSync(
        credentialsPath,
        `${JSON.stringify({
          gatewayUrl: "https://gateway.example.org:7600",
          deliveryToken: "omn_fictional_delivery",
          ingestionToken: "omn_fictional_ingestion",
          managementToken: "omn_fictional_management",
          oauth: {
            redirectUri: "http://127.0.0.1:48123/callback",
            clientInformation: { client_id: "client_fictional" },
            tokens: { access_token: "access_old", refresh_token: "refresh_old" },
          },
        })}\n`,
        { mode: 0o600 },
      );
      const provider = new IntegrationOAuthProvider(credentialsPath, "Hermes");
      provider.invalidateCredentials("tokens");

      expect(provider.tokens()).toBeUndefined();
      expect(loadIntegrationCredentials(credentialsPath).oauth.tokens).toEqual({
        access_token: "access_old",
        refresh_token: "refresh_old",
      });
      // Another process, or a fresh one, still reads the file as it is.
      expect(new IntegrationOAuthProvider(credentialsPath, "Hermes").tokens()).toMatchObject({
        access_token: "access_old",
      });

      provider.saveTokens({ access_token: "access_new", refresh_token: "refresh_new" } as never);
      expect(provider.tokens()).toMatchObject({ access_token: "access_new" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("offers a token set another process wrote after this one withdrew its own", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-withdraw-peer-"));
    try {
      const credentialsPath = join(directory, "integration.json");
      const write = (accessToken: string) =>
        writeFileSync(
          credentialsPath,
          `${JSON.stringify({
            gatewayUrl: "https://gateway.example.org:7600",
            deliveryToken: "omn_fictional_delivery",
            ingestionToken: "omn_fictional_ingestion",
            managementToken: "omn_fictional_management",
            oauth: {
              redirectUri: "http://127.0.0.1:48123/callback",
              clientInformation: { client_id: "client_fictional" },
              tokens: { access_token: accessToken, refresh_token: `${accessToken}-refresh` },
            },
          })}\n`,
          { mode: 0o600 },
        );
      write("access_old");
      const provider = new IntegrationOAuthProvider(credentialsPath, "Hermes");
      provider.invalidateCredentials("tokens");
      write("access_from_peer");
      expect(provider.tokens()).toMatchObject({ access_token: "access_from_peer" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a verifier stops counting as a live approval once its recorded request expired", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-pending-"));
    try {
      const credentialsPath = join(directory, "integration.json");
      writeFileSync(
        credentialsPath,
        `${JSON.stringify({
          gatewayUrl: "https://gateway.example.org:7600",
          deliveryToken: "omn_fictional_delivery",
          ingestionToken: "omn_fictional_ingestion",
          managementToken: "omn_fictional_management",
          oauth: {
            redirectUri: "http://127.0.0.1:48123/callback",
            clientInformation: { client_id: "client_fictional" },
            tokens: { access_token: "a", refresh_token: "r" },
            codeVerifier: "v".repeat(64),
          },
        })}\n`,
        { mode: 0o600 },
      );
      let now = 1_000_000;
      const provider = new IntegrationOAuthProvider(
        credentialsPath,
        "OpenClaw",
        undefined,
        undefined,
        () => now,
      );
      // A verifier with no record: an attempt this version cannot date.
      expect(provider.hasPendingAuthorization()).toBe(true);
      savePendingAuthorization(credentialsPath, {
        gatewayUrl: "https://gateway.example.org:7600",
        clientId: "client_fictional",
        handle: "omn_oar_fictional",
        consentUrl: "https://gateway.example.org:7600/oauth/consent?request=omn_oar_fictional",
        expiresAt: now + 60_000,
        codeVerifier: "v".repeat(64),
        state: "s".repeat(40),
      });
      expect(provider.hasPendingAuthorization()).toBe(true);
      now += 60_000;
      expect(provider.hasPendingAuthorization()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("coalesces concurrent 401 refreshes before retrying with the rotated token", async () => {
    let accessToken = "principal-access-old";
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const provider = {
      tokens: () => ({ access_token: accessToken }),
    } as unknown as IntegrationOAuthProvider;
    const serialized = new SerializedIntegrationAuthProvider(
      provider,
      "https://gateway.example.org:7600",
      async () => {
        refreshCalls += 1;
        await refreshGate;
        accessToken = "principal-access-rotated";
        return "AUTHORIZED";
      },
    );
    const context = {
      response: new Response(null, { status: 401 }),
      serverUrl: new URL("https://gateway.example.org:7600/mcp"),
      fetchFn: fetch,
    };
    const first = serialized.onUnauthorized(context);
    const second = serialized.onUnauthorized(context);
    await Promise.resolve();
    expect(refreshCalls).toBe(1);
    releaseRefresh();
    await Promise.all([first, second]);
    expect(await serialized.token()).toBe("principal-access-rotated");
  });

  test("does not rotate again for a stale 401 that arrives after the first refresh", async () => {
    let accessToken = "principal-access-old";
    let refreshCalls = 0;
    const provider = {
      tokens: () => ({ access_token: accessToken }),
    } as unknown as IntegrationOAuthProvider;
    const serialized = new SerializedIntegrationAuthProvider(
      provider,
      "https://gateway.example.org:7600",
      async () => {
        refreshCalls += 1;
        accessToken = "principal-access-rotated";
        return "AUTHORIZED";
      },
    );
    const tracked = serialized.trackFetch(async () => new Response(null, { status: 401 }));
    const staleResponses = await Promise.all([
      tracked("https://gateway.example.org:7600/mcp", {
        headers: { Authorization: "Bearer principal-access-old" },
      }),
      tracked("https://gateway.example.org:7600/mcp", {
        headers: { Authorization: "Bearer principal-access-old" },
      }),
    ]);
    const context = (response: Response) => ({
      response,
      serverUrl: new URL("https://gateway.example.org:7600/mcp"),
      fetchFn: fetch,
    });

    await serialized.onUnauthorized(context(staleResponses[0]!));
    await serialized.onUnauthorized(context(staleResponses[1]!));

    expect(refreshCalls).toBe(1);
    expect(await serialized.token()).toBe("principal-access-rotated");
  });

  test("serializes refresh-token rotation across providers sharing one credential file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-lock-"));
    try {
      const credentialsPath = join(directory, "integration.json");
      writeFileSync(
        credentialsPath,
        JSON.stringify({
          gatewayUrl: "https://gateway.example.org:7600",
          deliveryToken: "omn_delivery_example",
          ingestionToken: "omn_ingestion_example",
          managementToken: "omn_management_example",
          oauth: {
            redirectUri: "http://127.0.0.1:48123/callback",
            clientInformation: { client_id: "client_fictional" },
            tokens: {
              access_token: "principal-access-old",
              refresh_token: "principal-refresh-old",
              token_type: "Bearer",
            },
          },
        }),
        { mode: 0o600 },
      );
      const firstProvider = new IntegrationOAuthProvider(credentialsPath, "OpenClaw");
      const secondProvider = new IntegrationOAuthProvider(credentialsPath, "OpenClaw");
      let refreshCalls = 0;
      const authorize = async (provider: IntegrationOAuthProvider) => {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        provider.saveTokens({
          access_token: "principal-access-rotated",
          refresh_token: "principal-refresh-rotated",
          token_type: "Bearer",
        });
        return "AUTHORIZED" as const;
      };
      const first = new SerializedIntegrationAuthProvider(
        firstProvider,
        "https://gateway.example.org:7600",
        authorize,
      );
      const second = new SerializedIntegrationAuthProvider(
        secondProvider,
        "https://gateway.example.org:7600",
        authorize,
      );
      const context = {
        response: new Response(null, { status: 401 }),
        serverUrl: new URL("https://gateway.example.org:7600/mcp"),
        fetchFn: fetch,
      };

      await Promise.all([first.onUnauthorized(context), second.onUnauthorized(context)]);

      expect(refreshCalls).toBe(1);
      expect(await first.token()).toBe("principal-access-rotated");
      expect(await second.token()).toBe("principal-access-rotated");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/** A 401 on the MCP endpoint, as the SDK hands it to `onUnauthorized`. */
function unauthorized(fetchFn: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  return {
    response: new Response(null, { status: 401 }),
    serverUrl: new URL("https://gateway.example.org:7600/mcp"),
    fetchFn,
  };
}
