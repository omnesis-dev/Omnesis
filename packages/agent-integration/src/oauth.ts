// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { open, stat, unlink, type FileHandle } from "node:fs/promises";

import {
  auth,
  type AuthProvider,
  type FetchLike,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import {
  loadIntegrationCredentials,
  updateIntegrationOAuthState,
  type IntegrationOAuthState,
} from "./credentials.js";
import { mcpEndpointUrl } from "./tls.js";

const REFRESH_LOCK_WAIT_MS = 25;
const REFRESH_LOCK_TIMEOUT_MS = 30_000;
const REFRESH_LOCK_STALE_MS = 2 * 60_000;

/**
 * The SDK asked for a browser redirect where nobody can perform one.
 *
 * It is the plugin's signal that the stored refresh token can no longer be
 * traded — the one condition under which spending the device's management
 * token on a headless re-issue is the right move. A distinct type rather than
 * a message, so callers match on the fact instead of on prose.
 */
class InteractiveAuthorizationUnavailableError extends Error {
  constructor() {
    super("Omnesis MCP authorization must be repaired with `omnesis connect`");
    this.name = "InteractiveAuthorizationUnavailableError";
  }
}

function isInteractiveAuthorizationRequired(error: unknown): boolean {
  // The connect flow substitutes its own redirect hook, which throws its own
  // error type; both mean the same thing to a caller deciding whether the
  // ticket is spent.
  return (
    error instanceof InteractiveAuthorizationUnavailableError ||
    (error instanceof Error && error.name === "InteractiveAuthorizationRequired")
  );
}

/**
 * Durable MCP OAuth provider shared by the OpenClaw runtime and connect flow.
 *
 * `clientName` is what a dynamic registration sends as `client_name`, and it
 * is the name the gateway suggests for the approved connection — so it names
 * the harness (see `harnessClientName`). Registration happens only while the
 * credential file holds no client information; an installation that already
 * registered keeps its client id, and the name it registered under, until
 * that information is cleared.
 */
export class IntegrationOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly credentialsPath: string,
    private readonly clientName: string,
    private readonly onAuthorization?: (url: URL) => void | Promise<void>,
    private readonly onStateChanged?: (
      credentials: ReturnType<typeof loadIntegrationCredentials>,
    ) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get credentialsFilePath(): string {
    return this.credentialsPath;
  }

  get redirectUrl(): string {
    return this.loadState().redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    const current = this.loadState();
    if (current.authorizationState) return current.authorizationState;
    const authorizationState = `${randomUUID()}${randomUUID()}`;
    this.update({ authorizationState });
    return authorizationState;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    const value = this.loadState().clientInformation;
    return typeof value.client_id === "string"
      ? (value as StoredOAuthClientInformation)
      : undefined;
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation): void {
    this.update({ clientInformation });
  }

  tokens(): StoredOAuthTokens | undefined {
    const value = this.loadState().tokens;
    return typeof value.access_token === "string" ? (value as StoredOAuthTokens) : undefined;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    // Stamp the moment the refresh token was issued. Nothing in an OAuth token
    // response says when it dies, so this is the only thing the keepalive has
    // to reason about — and it must measure the ticket's age, not the age of
    // the last write. The SDK saves for reasons that are not an issuance: it
    // backfills a missing issuer stamp before it even attempts a refresh. So
    // an unchanged refresh token keeps the stamp it already had; moving it
    // would tell the keepalive there were weeks left on a ticket about to
    // expire, which is exactly the silence this whole mechanism exists to
    // break.
    const rotated =
      typeof tokens.refresh_token !== "string" ||
      tokens.refresh_token !== this.loadState().tokens.refresh_token;
    this.update({
      tokens,
      ...(rotated ? { tokensObtainedAt: this.now() } : {}),
      codeVerifier: undefined,
      authorizationState: undefined,
    });
  }

  /** When the stored token set was issued, or undefined if it predates the stamp. */
  tokensObtainedAt(): number | undefined {
    return this.loadState().tokensObtainedAt;
  }

  /**
   * Is an interactive authorization part-way through?
   *
   * The PKCE verifier is written when the consent page is opened and cleared
   * when tokens are saved, so its presence is what distinguishes "somebody is
   * approving this right now" from an ordinary idle installation.
   */
  hasPendingAuthorization(): boolean {
    return this.loadState().codeVerifier !== undefined;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    const value = this.loadState().discoveryState;
    return value ? (value as unknown as OAuthDiscoveryState) : undefined;
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    this.update({ discoveryState: { ...discoveryState } });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.onAuthorization) throw new InteractiveAuthorizationUnavailableError();
    await this.onAuthorization(url);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.update({ codeVerifier });
  }

  codeVerifier(): string {
    const verifier = this.loadState().codeVerifier;
    if (!verifier) throw new Error("Omnesis MCP authorization has no saved PKCE verifier");
    return verifier;
  }

  clearAuthorizationAttempt(): void {
    this.update({ codeVerifier: undefined, authorizationState: undefined });
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "discovery") {
      this.update({ discoveryState: undefined });
      return;
    }
    if (scope === "all") {
      this.update({
        clientInformation: {},
        tokens: {},
        codeVerifier: undefined,
        authorizationState: undefined,
      });
    } else if (scope === "client") {
      this.update({ clientInformation: {} });
    } else if (scope === "tokens") {
      this.update({ tokens: {} });
    } else {
      this.update({ codeVerifier: undefined });
    }
  }

  private loadState(): IntegrationOAuthState {
    return loadIntegrationCredentials(this.credentialsPath).oauth;
  }

  private update(patch: Partial<IntegrationOAuthState>): void {
    const current = this.loadState();
    const next = { ...current, ...patch };
    if (Object.hasOwn(patch, "codeVerifier") && patch.codeVerifier === undefined) {
      delete next.codeVerifier;
    }
    if (Object.hasOwn(patch, "authorizationState") && patch.authorizationState === undefined) {
      delete next.authorizationState;
    }
    if (Object.hasOwn(patch, "discoveryState") && patch.discoveryState === undefined) {
      delete next.discoveryState;
    }
    if (Object.hasOwn(patch, "tokensObtainedAt") && patch.tokensObtainedAt === undefined) {
      delete next.tokensObtainedAt;
    }
    updateIntegrationOAuthState(this.credentialsPath, next);
    this.onStateChanged?.(loadIntegrationCredentials(this.credentialsPath));
  }
}

export async function authorizeIntegrationOAuth(
  provider: IntegrationOAuthProvider,
  gatewayUrl: string,
  fetchFn: FetchLike,
  authorizationCode?: string,
  iss?: string,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  return auth(provider, {
    serverUrl: mcpEndpointUrl(gatewayUrl),
    fetchFn,
    scope: "omnesis:access offline_access",
    ...(authorizationCode ? { authorizationCode } : {}),
    ...(iss ? { iss } : {}),
  });
}

/**
 * Serialize the refresh-or-redirect SDK phase across every process sharing
 * one integration credential file.
 *
 * The TypeScript and Hermes runtimes both hold the same existence-based lease,
 * so a refresh token that rotates on use is spent by only one process. A
 * concurrent process that already rotated the bearer satisfies this attempt
 * without consuming the old refresh token.
 * Interactive consent is never covered by the lock: the SDK's redirect hook
 * returns or throws before this function releases it.
 */
export async function authorizeIntegrationOAuthWithCredentialLock(
  provider: IntegrationOAuthProvider,
  gatewayUrl: string,
  fetchFn: FetchLike,
  authorize: typeof authorizeIntegrationOAuth = authorizeIntegrationOAuth,
): Promise<"AUTHORIZED" | "REDIRECT"> {
  const expectedBearer = provider.tokens()?.access_token;
  let result: "AUTHORIZED" | "REDIRECT" | undefined;
  await withCredentialRefreshLock(
    provider.credentialsFilePath,
    expectedBearer,
    () => provider.tokens()?.access_token,
    async () => {
      result = await authorize(provider, gatewayUrl, fetchFn);
    },
  );
  return result ?? "AUTHORIZED";
}

/** Coalesces rotating refresh-token use across concurrent native Answer calls. */
export class SerializedIntegrationAuthProvider implements AuthProvider {
  private refreshInFlight: Promise<void> | null = null;
  private readonly bearerByResponse = new WeakMap<Response, string>();

  constructor(
    private readonly provider: IntegrationOAuthProvider,
    private readonly gatewayUrl: string,
    private readonly authorize: typeof authorizeIntegrationOAuth = authorizeIntegrationOAuth,
    /**
     * Last resort when the refresh token can no longer be traded. Without
     * one, a lapsed ticket ends the call — which is what an interactive
     * client wants, because a person is there to repair it. A long-running
     * plugin supplies the headless recovery instead.
     */
    private readonly recover?: () => Promise<void>,
  ) {}

  /**
   * Run one refresh attempt, falling back to recovery when the SDK reaches the
   * point of wanting a browser.
   *
   * That is the only signal available: `auth()` either returns REDIRECT or
   * asks this provider to perform a redirect it cannot, which surfaces as
   * `InteractiveAuthorizationUnavailableError`. A spent refresh token gets
   * there — the token endpoint's `invalid_grant` sends `auth()` round a second
   * time with the tokens cleared, which has nothing left to trade — and so
   * does a refresh POST that failed on the network, which the SDK swallows
   * rather than rethrows. Recovery is safe to attempt in both cases: it
   * re-keys an approval that already exists, and if the network is what was
   * broken it fails too, with its own error.
   *
   * What must NOT reach recovery is everything thrown outside that attempt —
   * an unreadable credential file, a discovery failure, a bug. Those say
   * nothing about the ticket, and folding them in would spend the device's
   * management token on each one and bury the real error behind a call that
   * usually succeeds. So they are rethrown.
   */
  private async refreshOrRecover(attempt: () => Promise<"AUTHORIZED" | "REDIRECT">): Promise<void> {
    let result: "AUTHORIZED" | "REDIRECT";
    try {
      result = await attempt();
    } catch (error) {
      if (!this.recover || !isInteractiveAuthorizationRequired(error)) throw error;
      await this.attemptRecovery();
      return;
    }
    if (result === "AUTHORIZED") return;
    if (!this.recover) throw new InteractiveAuthorizationUnavailableError();
    await this.attemptRecovery();
  }

  /**
   * Recover, and leave nothing behind if recovery itself fails.
   *
   * Getting here means the SDK went all the way to wanting a browser: it has
   * already cleared the stored tokens and written a PKCE verifier for the
   * authorization it was about to start. Nobody is going to complete that
   * authorization — this provider cannot open a browser — so if recovery does
   * not replace the tokens, the leftovers have to go. A verifier left on disk
   * reads as "somebody is approving this right now", which is precisely what
   * the scheduled keepalive stands down for: one transient recovery failure
   * would otherwise disarm it for the life of the installation.
   *
   * Runs outside the cross-process credential lock, which the refresh attempt
   * released on its way out. Two processes recovering at once is harmless:
   * each re-issue starts its own token family, so neither looks like a replay
   * of the other and the last write wins.
   */
  private async attemptRecovery(): Promise<void> {
    try {
      await this.recover!();
    } catch (error) {
      this.provider.clearAuthorizationAttempt();
      throw error;
    }
  }

  async token(): Promise<string | undefined> {
    return this.provider.tokens()?.access_token;
  }

  /** Associate a 401 with the bearer that produced it so late stale failures cannot rotate twice. */
  trackFetch(fetchFn: FetchLike): FetchLike {
    return async (input, init) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      const response = await fetchFn(input, init);
      if (authorization?.startsWith("Bearer ")) {
        this.bearerByResponse.set(response, authorization.slice(7));
      }
      return response;
    };
  }

  /**
   * Spend the refresh token deliberately, outside any failing request.
   *
   * `auth()` trades a refresh token whenever one is stored, so this is a real
   * rotation and not a no-op — which is the whole point of a keepalive: the
   * clock on the ticket restarts. Shares the cross-process lock and the
   * recovery fallback with the reactive path.
   */
  async renew(fetchFn: FetchLike): Promise<void> {
    await this.refreshOrRecover(() =>
      authorizeIntegrationOAuthWithCredentialLock(
        this.provider,
        this.gatewayUrl,
        fetchFn,
        this.authorize,
      ),
    );
  }

  async onUnauthorized(context: Parameters<NonNullable<AuthProvider["onUnauthorized"]>>[0]) {
    const failedBearer = this.bearerByResponse.get(context.response);
    const currentBearer = this.provider.tokens()?.access_token;
    if (failedBearer && currentBearer && failedBearer !== currentBearer) return;
    if (!this.refreshInFlight) {
      this.refreshInFlight = (async () => {
        const refresh = () =>
          this.refreshOrRecover(() =>
            this.authorize(this.provider, this.gatewayUrl, context.fetchFn),
          );
        if (!this.provider.credentialsFilePath) {
          await refresh();
          return;
        }
        if (failedBearer === undefined) {
          await this.refreshOrRecover(() =>
            authorizeIntegrationOAuthWithCredentialLock(
              this.provider,
              this.gatewayUrl,
              context.fetchFn,
              this.authorize,
            ),
          );
          return;
        }
        await withCredentialRefreshLock(
          this.provider.credentialsFilePath,
          failedBearer,
          () => this.provider.tokens()?.access_token,
          refresh,
        );
      })().finally(() => {
        this.refreshInFlight = null;
      });
    }
    await this.refreshInFlight;
  }
}

/** @internal Exported for cross-language lease regression tests. */
export async function withCredentialRefreshLock(
  credentialsPath: string,
  expectedBearer: string | undefined,
  readBearer: () => string | undefined,
  refresh: () => Promise<void>,
): Promise<void> {
  const lockPath = `${credentialsPath}.refresh.lock`;
  const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS;
  for (;;) {
    if (expectedBearer && readBearer() !== expectedBearer) return;
    let handle: FileHandle | null = null;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
    } catch (error) {
      await handle?.close();
      if (!isAlreadyExists(error)) throw error;
      await removeStaleRefreshLock(lockPath);
      if (Date.now() >= deadline) {
        if (expectedBearer && readBearer() !== expectedBearer) return;
        throw new Error("Timed out waiting for another Omnesis OAuth refresh process", {
          cause: error,
        });
      }
      await delay(REFRESH_LOCK_WAIT_MS);
      continue;
    }

    try {
      if (expectedBearer && readBearer() !== expectedBearer) return;
      await refresh();
      return;
    } finally {
      await releaseOwnedRefreshLock(lockPath, handle);
    }
  }
}

/** @internal Exported for the cross-process lease regression tests. */
export async function removeStaleRefreshLock(lockPath: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(lockPath, "r");
    const inspected = await handle.stat();
    if (Date.now() - inspected.mtimeMs <= REFRESH_LOCK_STALE_MS) return;
    const ownerPid = Number.parseInt((await handle.readFile("utf8")).trim(), 10);
    if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && processIsAlive(ownerPid)) return;

    // Re-check the directory entry against the opened inode. A prior owner may
    // have released its lock and a new refresher may have acquired the same
    // path while this process was inspecting it; never unlink that new lease.
    const current = await stat(lockPath);
    if (inspected.dev === current.dev && inspected.ino === current.ino) await unlink(lockPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}

async function releaseOwnedRefreshLock(lockPath: string, handle: FileHandle): Promise<void> {
  try {
    const [owned, current] = await Promise.all([handle.stat(), stat(lockPath)]);
    if (owned.dev === current.dev && owned.ino === current.ino) await unlink(lockPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  } finally {
    await handle.close();
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
