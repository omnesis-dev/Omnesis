// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { loadIntegrationCredentials } from "./credentials.js";
import {
  IntegrationOAuthProvider,
  removeStaleRefreshLock,
  SerializedIntegrationAuthProvider,
  withCredentialRefreshLock,
} from "./oauth.js";

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
