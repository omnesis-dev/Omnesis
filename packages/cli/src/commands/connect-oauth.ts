// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";

import {
  IntegrationOAuthProvider,
  PinnedGatewayHttpClient,
  authorizeIntegrationOAuth,
  authorizeIntegrationOAuthWithCredentialLock,
  harnessClientName,
  integrationOAuthFetch,
  loadIntegrationCredentials,
  writeIntegrationCredentials,
  type IntegrationCredentials,
} from "@omnesis/agent-integration";

import { c } from "../utils.js";
import type { Harness } from "../harness-skills.js";

const AUTHORIZATION_TIMEOUT_MS = 10 * 60_000;
const AUTHORIZATION_POLL_MS = 1_200;

export interface HarnessOAuthOptions {
  onCredentialsChanged?: (credentials: IntegrationCredentials) => void;
}

class InteractiveAuthorizationRequired extends Error {
  constructor(readonly authorizationUrl: URL) {
    super("Interactive OAuth authorization is required");
  }
}

/** Complete or refresh the OAuth connection belonging to one native integration. */
export async function authorizeHarness(
  home: string,
  harness: Harness,
  credentials: IntegrationCredentials,
  options: HarnessOAuthOptions = {},
): Promise<IntegrationCredentials> {
  const credentialsPath = join(home, "omnesis", "integration.json");
  const fetchFn = integrationOAuthFetch(credentials.gatewayUrl, credentials.tls);
  let callbackResolve!: (value: URL) => void;
  let callbackReject!: (error: Error) => void;
  const callback = new Promise<URL>((resolve, reject) => {
    callbackResolve = resolve;
    callbackReject = reject;
  });
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Omnesis authorization received. You can close this window.\n");
      callbackResolve(url);
    } catch (error) {
      callbackReject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const provider = new IntegrationOAuthProvider(
    credentialsPath,
    harnessClientName(harness),
    async (authorizationUrl) => {
      throw new InteractiveAuthorizationRequired(authorizationUrl);
    },
    options.onCredentialsChanged,
  );

  const listen = async (port: number): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  };
  const persistListeningRedirect = (): boolean => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("OAuth callback did not listen");
    const current = loadIntegrationCredentials(credentialsPath);
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    if (current.oauth.redirectUri === redirectUri) return false;
    const next = { ...current, oauth: { ...current.oauth, redirectUri } };
    writeIntegrationCredentials(credentialsPath, next);
    options.onCredentialsChanged?.(next);
    return true;
  };

  const startCallback = async (): Promise<boolean> => {
    const redirect = new URL(loadIntegrationCredentials(credentialsPath).oauth.redirectUri);
    const requestedPort = redirect.port ? Number(redirect.port) : 0;
    try {
      await listen(requestedPort);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") {
        throw error;
      }
      await listen(0);
    }
    return persistListeningRedirect();
  };

  try {
    const hasRefreshToken =
      typeof credentials.oauth.tokens.refresh_token === "string" &&
      credentials.oauth.tokens.refresh_token.length > 0;
    const initialRedirectChanged = !hasRefreshToken && (await startCallback());
    if (initialRedirectChanged) {
      provider.invalidateCredentials("client");
      provider.clearAuthorizationAttempt();
    }

    let authorizationUrl: URL;
    try {
      const result = await authorizeIntegrationOAuthWithCredentialLock(
        provider,
        credentials.gatewayUrl,
        fetchFn,
      );
      if (result === "AUTHORIZED") return loadIntegrationCredentials(credentialsPath);
      throw new Error("OAuth requested a redirect without an authorization URL");
    } catch (error) {
      if (!(error instanceof InteractiveAuthorizationRequired)) throw error;
      authorizationUrl = error.authorizationUrl;
    }

    if (!server.listening) {
      const redirectChanged = await startCallback();
      if (redirectChanged) {
        provider.invalidateCredentials("client");
        provider.clearAuthorizationAttempt();
        try {
          await authorizeIntegrationOAuthWithCredentialLock(
            provider,
            credentials.gatewayUrl,
            fetchFn,
          );
          throw new Error("OAuth unexpectedly completed after changing the callback URL");
        } catch (error) {
          if (!(error instanceof InteractiveAuthorizationRequired)) throw error;
          authorizationUrl = error.authorizationUrl;
        }
      }
    }

    const clientId = authorizationUrl.searchParams.get("client_id");
    if (!clientId) throw new Error("OAuth authorization omitted its client identifier");
    const management = new PinnedGatewayHttpClient(
      credentials.gatewayUrl,
      credentials.managementToken,
      credentials.tls,
    );
    const bound = await management.postJson<{ binding: string }>(
      "/agent-integration/oauth-binding",
      { clientId, harness },
    );
    authorizationUrl.searchParams.set("omnesis_execution_binding", bound.binding);
    const started = await fetchFn(authorizationUrl, { redirect: "manual" });
    const location = started.headers.get("location");
    if (started.status !== 303 || !location) {
      throw new Error(`OAuth authorization could not start (HTTP ${started.status})`);
    }
    const consentUrl = new URL(location, credentials.gatewayUrl);
    const consent = await fetchFn(consentUrl, { redirect: "manual" });
    const html = await consent.text();
    const shortCode = html.match(/[A-Z2-9]{4}-[A-Z2-9]{4}/u)?.[0];
    console.log(`Authorize this integration at ${c.cyan}${consentUrl.toString()}${c.reset}`);
    if (shortCode) {
      console.log(
        `If that page is not signed in, enter code ${c.bold}${shortCode}${c.reset} in your logged-in Omnesis portal.`,
      );
    }
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args =
      process.platform === "win32"
        ? ["/c", "start", "", consentUrl.toString()]
        : [consentUrl.toString()];
    spawnSync(opener, args, { stdio: "ignore", timeout: 5_000 });

    const completionController = new AbortController();
    const timeout = setTimeout(
      () => completionController.abort(new Error("OAuth authorization timed out")),
      AUTHORIZATION_TIMEOUT_MS,
    );
    const pollPortalDecision = async (): Promise<URL> => {
      const handle = consentUrl.searchParams.get("request");
      if (!handle) throw new Error("OAuth consent page omitted its authorization handle");
      while (true) {
        const statusResponse = await fetchFn(
          new URL(
            `/oauth/authorize/status?request=${encodeURIComponent(handle)}`,
            credentials.gatewayUrl,
          ),
          { signal: completionController.signal },
        );
        if (!statusResponse.ok) {
          throw new Error(`OAuth authorization status failed (HTTP ${statusResponse.status})`);
        }
        const status = (await statusResponse.json()) as { status?: unknown };
        if (status.status === "approved" || status.status === "denied") {
          const completed = await fetchFn(
            new URL(
              `/oauth/authorize/complete?request=${encodeURIComponent(handle)}`,
              credentials.gatewayUrl,
            ),
            { redirect: "manual", signal: completionController.signal },
          );
          const location = completed.headers.get("location");
          if (completed.status !== 303 || !location) {
            throw new Error(`OAuth authorization completion failed (HTTP ${completed.status})`);
          }
          return new URL(location, credentials.gatewayUrl);
        }
        if (status.status === "expired") throw new Error("OAuth authorization expired");
        await delay(AUTHORIZATION_POLL_MS, undefined, { signal: completionController.signal });
      }
    };
    let returned: URL;
    try {
      returned = await Promise.race([callback, pollPortalDecision()]);
    } finally {
      clearTimeout(timeout);
      completionController.abort();
    }
    const error = returned.searchParams.get("error");
    if (error) {
      provider.clearAuthorizationAttempt();
      throw new Error(`OAuth authorization was ${error}`);
    }
    const expectedState = loadIntegrationCredentials(credentialsPath).oauth.authorizationState;
    if (!expectedState || returned.searchParams.get("state") !== expectedState) {
      throw new Error("OAuth callback state did not match the authorization request");
    }
    const code = returned.searchParams.get("code");
    if (!code) throw new Error("OAuth callback did not include an authorization code");
    await authorizeIntegrationOAuth(
      provider,
      credentials.gatewayUrl,
      fetchFn,
      code,
      returned.searchParams.get("iss") ?? undefined,
    );
    return loadIntegrationCredentials(credentialsPath);
  } finally {
    if (server.listening) server.close();
  }
}
