// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";

import {
  IntegrationOAuthProvider,
  IntegrationReauthorizationRequiredError,
  PinnedGatewayHttpClient,
  authorizeIntegrationOAuth,
  authorizeIntegrationOAuthWithCredentialLock,
  clearPendingAuthorization,
  harnessClientName,
  integrationOAuthFetch,
  loadIntegrationCredentials,
  loadPendingAuthorization,
  reissueIntegrationOAuthTokens,
  savePendingAuthorization,
  withCredentialRefreshLock,
  writeIntegrationCredentials,
  type IntegrationCredentials,
  type PendingIntegrationAuthorization,
} from "@omnesis/agent-integration";

import { c } from "../utils.js";
import type { Harness } from "../harness-skills.js";

const AUTHORIZATION_POLL_MS = 1_200;
/**
 * How long a request is assumed to live when the gateway has not yet said.
 * The gateway's own lifetime; the status answer replaces it on the first poll.
 */
const ASSUMED_REQUEST_LIFETIME_MS = 10 * 60_000;
/**
 * How long past its expiry a request is still polled. The gateway is the one
 * that says a request expired; this only bounds the wait when it cannot be
 * reached to say so.
 */
const EXPIRY_GRACE_MS = 30_000;

export interface HarnessOAuthOptions {
  onCredentialsChanged?: (credentials: IntegrationCredentials) => void;
  /**
   * Whether this run may ask the operator for a new approval. Without it, a
   * connection with no approved access left fails with the command that
   * repairs it, instead of opening a request nobody is waiting on. An approval
   * already given for a request an earlier run opened is still collected.
   * Defaults to true.
   */
  consent?: boolean;
}

class InteractiveAuthorizationRequired extends Error {
  constructor(readonly authorizationUrl: URL) {
    super("Interactive OAuth authorization is required");
    this.name = "InteractiveAuthorizationRequired";
  }
}

class AuthorizationExpiredError extends Error {
  constructor() {
    super("OAuth authorization expired before it was approved");
    this.name = "AuthorizationExpiredError";
  }
}

/** The connection has no approved access left and this run may not ask for it. */
export class HarnessApprovalRequiredError extends Error {
  constructor(harness: Harness) {
    super(
      `Omnesis corpus access for ${harness} needs a new approval. ` +
        `Run \`omnesis connect ${harness} --refresh\` on this machine and approve it.`,
    );
    this.name = "HarnessApprovalRequiredError";
  }
}

/**
 * Complete or refresh the OAuth connection belonging to one native integration.
 *
 * In order of preference, and stopping at the first that works:
 *
 *   1. collect a decision on the approval request an earlier run opened and
 *      recorded, so an approval given after that run stopped — within the
 *      request's lifetime — is not lost;
 *   2. trade the stored refresh token;
 *   3. re-issue tokens for the credential the operator already approved,
 *      with the device's management token — the headless recovery the
 *      running plugins use;
 *   4. only then, and only with `consent`, ask the operator: wait on the
 *      recorded request when it is still open, or open exactly one new one
 *      and wait on it for its whole lifetime.
 *
 * Without `consent` a token set already on file is left alone — the running
 * plugin renews it — and nothing on file is ever cleared: the stored tokens
 * are replaced only by tokens in hand.
 */
export async function authorizeHarness(
  home: string,
  harness: Harness,
  credentials: IntegrationCredentials,
  options: HarnessOAuthOptions = {},
): Promise<IntegrationCredentials> {
  const consent = options.consent ?? true;
  const credentialsPath = join(home, "omnesis", "integration.json");
  const fetchFn = integrationOAuthFetch(credentials.gatewayUrl, credentials.tls);
  const gatewayUrl = credentials.gatewayUrl;
  const provider = new IntegrationOAuthProvider(
    credentialsPath,
    harnessClientName(harness),
    async (authorizationUrl) => {
      throw new InteractiveAuthorizationRequired(authorizationUrl);
    },
    options.onCredentialsChanged,
  );
  const loadCurrent = () => loadIntegrationCredentials(credentialsPath);
  const clientId = (): string | undefined => {
    const id = loadCurrent().oauth.clientInformation.client_id;
    return typeof id === "string" && id !== "" ? id : undefined;
  };

  const requestUrl = (route: string, handle: string): URL =>
    new URL(`${route}?request=${encodeURIComponent(handle)}`, gatewayUrl);

  /**
   * Ask the gateway where a request stands. `gone` covers both an expired
   * request and one the gateway no longer knows.
   */
  const readStatus = async (
    handle: string,
    signal?: AbortSignal,
  ): Promise<{ status: "pending" | "approved" | "denied" | "gone"; expiresAt?: number }> => {
    const response = await fetchFn(requestUrl("/oauth/authorize/status", handle), {
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404) return { status: "gone" };
    if (!response.ok) {
      throw new Error(`OAuth authorization status failed (HTTP ${response.status})`);
    }
    const body = (await response.json()) as { status?: unknown; expiresAt?: unknown };
    const expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : undefined;
    const status =
      body.status === "approved" || body.status === "denied" || body.status === "pending"
        ? body.status
        : "gone";
    return { status, ...(expiresAt !== undefined ? { expiresAt } : {}) };
  };

  /** Follow a decided request to the redirect that carries its code or refusal. */
  const collectDecision = async (handle: string, signal?: AbortSignal): Promise<URL> => {
    const completed = await fetchFn(requestUrl("/oauth/authorize/complete", handle), {
      redirect: "manual",
      ...(signal ? { signal } : {}),
    });
    const location = completed.headers.get("location");
    if (completed.status !== 303 || !location) {
      throw new Error(`OAuth authorization completion failed (HTTP ${completed.status})`);
    }
    return new URL(location, gatewayUrl);
  };

  /**
   * Poll a request until the operator decides it, for as long as it lives.
   * A poll that fails — a stalled gateway, a dropped connection — is not a
   * decision, so it is retried until the request's own expiry rather than
   * abandoning a request the operator can still approve.
   */
  const awaitDecision = async (
    pending: PendingIntegrationAuthorization,
    signal: AbortSignal,
  ): Promise<URL> => {
    let expiresAt = pending.expiresAt;
    for (;;) {
      let status: Awaited<ReturnType<typeof readStatus>> | undefined;
      try {
        status = await readStatus(pending.handle, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        if (Date.now() > expiresAt + EXPIRY_GRACE_MS) throw error;
      }
      if (status) {
        if (status.status === "gone") throw new AuthorizationExpiredError();
        if (status.status !== "pending") return collectDecision(pending.handle, signal);
        if (status.expiresAt !== undefined && status.expiresAt !== expiresAt) {
          expiresAt = status.expiresAt;
          savePendingAuthorization(credentialsPath, { ...pending, expiresAt });
        }
      }
      await delay(AUTHORIZATION_POLL_MS, undefined, { signal });
    }
  };

  /**
   * Let go of a request this run is done with: its record, and the verifier
   * it left in the credential file — each only while it is still this
   * request's, since another run may have recorded its own since.
   */
  const release = (pending: PendingIntegrationAuthorization): void => {
    clearPendingAuthorization(credentialsPath, pending.handle);
    if (loadCurrent().oauth.codeVerifier === pending.codeVerifier) {
      provider.clearAuthorizationAttempt();
    }
  };

  /**
   * Turn the gateway's redirect into tokens, with the verifier and state the
   * request was opened with. The verifier is handed to the exchange directly
   * rather than through the credential file, which a running plugin may
   * rewrite at any moment. The request is released whatever the outcome: a
   * decided request cannot be decided again.
   */
  const finish = async (
    pending: PendingIntegrationAuthorization,
    returned: URL,
  ): Promise<IntegrationCredentials> => {
    try {
      const error = returned.searchParams.get("error");
      if (error) throw new Error(`OAuth authorization was ${error}`);
      if (returned.searchParams.get("state") !== pending.state) {
        throw new Error("OAuth callback state did not match the authorization request");
      }
      const code = returned.searchParams.get("code");
      if (!code) throw new Error("OAuth callback did not include an authorization code");
      const exchanging = new (class extends IntegrationOAuthProvider {
        override codeVerifier(): string {
          return pending.codeVerifier;
        }
      })(credentialsPath, harnessClientName(harness), undefined, options.onCredentialsChanged);
      await authorizeIntegrationOAuth(
        exchanging,
        gatewayUrl,
        fetchFn,
        code,
        returned.searchParams.get("iss") ?? undefined,
      );
      return loadCurrent();
    } finally {
      release(pending);
    }
  };

  /** Wait on a request, with an optional loopback callback racing the poll. */
  const waitAndFinish = async (
    pending: PendingIntegrationAuthorization,
    callback?: Promise<URL>,
  ): Promise<IntegrationCredentials> => {
    const controller = new AbortController();
    let returned: URL;
    try {
      returned = await Promise.race([
        awaitDecision(pending, controller.signal),
        ...(callback ? [callback] : []),
      ]);
    } catch (error) {
      if (error instanceof AuthorizationExpiredError) release(pending);
      throw error;
    } finally {
      controller.abort();
    }
    return finish(pending, returned);
  };

  /** The headless re-issue, under the lease a running plugin renews under. */
  const reissue = async (): Promise<void> => {
    await withCredentialRefreshLock(
      credentialsPath,
      undefined,
      () => undefined,
      async () => {
        await reissueIntegrationOAuthTokens(provider, loadCurrent(), harness);
      },
    );
  };

  // 1. A request an earlier run opened for this same client. An approval on
  //    it is collected whatever this run may do; one still open, or one whose
  //    state cannot be read right now, is kept for step 4.
  let open: PendingIntegrationAuthorization | null = null;
  const recorded = loadPendingAuthorization(credentialsPath);
  if (recorded) {
    if (recorded.gatewayUrl !== gatewayUrl || recorded.clientId !== clientId()) {
      release(recorded);
    } else {
      const status = await readStatus(recorded.handle).catch(() => null);
      if (status?.status === "gone") {
        release(recorded);
      } else if (status?.status === "approved") {
        console.log("Collecting the approval given for the request opened earlier.");
        try {
          return await finish(recorded, await collectDecision(recorded.handle));
        } catch (error) {
          // An approval that cannot be turned into tokens is reported, and
          // the run carries on with the other ways it has of getting them.
          release(recorded);
          console.log(
            `${c.yellow}! The earlier approval could not be collected: ${error instanceof Error ? error.message : String(error)}${c.reset}`,
          );
        }
      } else if (status?.status === "denied") {
        // A refusal is the operator's answer to that request, not to this
        // run: it ends the record and the run goes on as if there were none.
        console.log("The approval request opened earlier was denied.");
        release(recorded);
      } else {
        open = recorded;
      }
    }
  }

  if (!consent) {
    // The running plugin renews a token set on file by itself, and falls back
    // to the headless re-issue when it must. Trading it here would only race
    // that plugin for the same refresh token.
    const tokens = loadCurrent().oauth.tokens;
    if (typeof tokens.access_token === "string" && typeof tokens.refresh_token === "string") {
      return loadCurrent();
    }
    if (!clientId()) throw new HarnessApprovalRequiredError(harness);
    try {
      await reissue();
    } catch (error) {
      if (error instanceof IntegrationReauthorizationRequiredError) {
        throw new HarnessApprovalRequiredError(harness);
      }
      throw error;
    }
    return loadCurrent();
  }

  /** Tokens in hand: a request still open is nobody's business any more. */
  const authorized = (): IntegrationCredentials => {
    if (open) release(open);
    return loadCurrent();
  };

  // 2. The stored refresh token.
  const stored = loadCurrent().oauth.tokens;
  if (typeof stored.refresh_token === "string" && stored.refresh_token.length > 0) {
    try {
      const result = await authorizeIntegrationOAuthWithCredentialLock(
        provider,
        gatewayUrl,
        fetchFn,
      );
      if (result === "AUTHORIZED") return authorized();
      throw new Error("OAuth requested a redirect without an authorization URL");
    } catch (error) {
      if (!(error instanceof InteractiveAuthorizationRequired)) throw error;
      // The authorization the SDK prepared is not one anybody will approve.
      const prepared = loadCurrent().oauth.codeVerifier;
      if (prepared !== undefined && prepared !== open?.codeVerifier) {
        provider.clearAuthorizationAttempt();
      }
    }
  }

  // 3. The headless re-issue. Only the gateway's "nothing approved for this
  //    device" moves on to asking the operator; any other failure says the
  //    gateway could not be asked, and a new approval would not get past that.
  if (clientId()) {
    try {
      await reissue();
      return authorized();
    } catch (error) {
      if (!(error instanceof IntegrationReauthorizationRequiredError)) throw error;
    }
  }

  // 4a. The request already open, rather than a second one.
  if (open) {
    console.log(
      `Waiting for the approval already requested at ${c.cyan}${open.consentUrl}${c.reset}`,
    );
    return waitAndFinish(open);
  }

  // 4b. A new approval request.
  return requestApproval();

  async function requestApproval(): Promise<IntegrationCredentials> {
    let callbackResolve!: (value: URL) => void;
    const callback = new Promise<URL>((resolve) => {
      callbackResolve = resolve;
    });
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Omnesis authorization received. You can close this window.\n");
      callbackResolve(url);
    });
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
    try {
      const redirect = new URL(loadCurrent().oauth.redirectUri);
      try {
        await listen(redirect.port ? Number(redirect.port) : 0);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") {
          throw error;
        }
        await listen(0);
      }
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("OAuth callback did not listen");
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;
      const current = loadCurrent();
      if (current.oauth.redirectUri !== redirectUri) {
        // A client is registered with its redirect URI, so a new callback
        // port means a new registration.
        const next = { ...current, oauth: { ...current.oauth, redirectUri } };
        writeIntegrationCredentials(credentialsPath, next);
        options.onCredentialsChanged?.(next);
        provider.invalidateCredentials("client");
        provider.clearAuthorizationAttempt();
      }

      let authorizationUrl: URL;
      try {
        await authorizeIntegrationOAuthWithCredentialLock(provider, gatewayUrl, fetchFn);
        return loadCurrent();
      } catch (error) {
        if (!(error instanceof InteractiveAuthorizationRequired)) throw error;
        authorizationUrl = error.authorizationUrl;
      }

      const requestClientId = authorizationUrl.searchParams.get("client_id");
      if (!requestClientId) throw new Error("OAuth authorization omitted its client identifier");
      const management = new PinnedGatewayHttpClient(
        gatewayUrl,
        credentials.managementToken,
        credentials.tls,
      );
      const bound = await management.postJson<{ binding: string }>(
        "/agent-integration/oauth-binding",
        { clientId: requestClientId, harness },
      );
      authorizationUrl.searchParams.set("omnesis_execution_binding", bound.binding);
      const started = await fetchFn(authorizationUrl, { redirect: "manual" });
      const location = started.headers.get("location");
      if (started.status !== 303 || !location) {
        throw new Error(`OAuth authorization could not start (HTTP ${started.status})`);
      }
      const consentUrl = new URL(location, gatewayUrl);
      const handle = consentUrl.searchParams.get("request");
      if (!handle) throw new Error("OAuth consent page omitted its authorization handle");
      const opened = loadCurrent().oauth;
      if (!opened.codeVerifier || !opened.authorizationState) {
        throw new Error("OAuth authorization was prepared without its verifier and state");
      }
      // Recorded before anything else can fail, so the request is never one
      // the operator can approve but no later run knows about.
      const pending: PendingIntegrationAuthorization = {
        gatewayUrl,
        clientId: requestClientId,
        handle,
        consentUrl: consentUrl.toString(),
        expiresAt: Date.now() + ASSUMED_REQUEST_LIFETIME_MS,
        codeVerifier: opened.codeVerifier,
        state: opened.authorizationState,
      };
      savePendingAuthorization(credentialsPath, pending);

      const consentPage = await fetchFn(consentUrl, { redirect: "manual" });
      const html = await consentPage.text();
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

      return await waitAndFinish(pending, callback);
    } finally {
      if (server.listening) server.close();
    }
  }
}
