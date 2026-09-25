// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// TODO: add PKCE + custom-scheme cross-device auth flow. Same shape as
// Notion: collector keeps the code_verifier locally; iOS catches
// `omnesis://oauth/callback` and POSTs the code via the gateway. The
// localhost:3003 callback below remains the local-only fallback.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  createLogger,
  CredentialPersistError,
  DEFAULT_CONFIG_DIR,
  MissingCredentialsError,
  providerCredentialsPath,
  readSecretJsonFile,
  readSecretTextFileSync,
  writeSecretJsonFile,
} from "@omnesis/core";
import { AccountId } from "@omnesis/types";
import { AuthFailure } from "@omnesis/source-sdk";
import type {
  AuthFlowCallbacks,
  AuthResult,
  AuthSession,
  ConnectionState,
} from "@omnesis/source-sdk";
import type { StravaTokens, StravaCredentials } from "./types.js";

const log = createLogger("provider:strava");

const OAUTH_CALLBACK_HOST = "localhost";
const OAUTH_CALLBACK_PORT = 3003;
const OAUTH_CALLBACK_PATH = "/oauth2callback";
const REDIRECT_URI = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const TOKEN_URL = "https://www.strava.com/oauth/token";

/**
 * Scopes:
 * - `read` — public profile + segments
 * - `activity:read_all` — private + public activities
 * - `profile:read_all` — `/athlete/zones` and richer profile fields.
 *   Without it those endpoints 401 even though the token is otherwise
 *   valid; the client surfaces a `StravaScopeError` and athlete-refresh
 *   skips the endpoint, so missing this scope just means no zone data.
 */
const OAUTH_SCOPE = "read,activity:read_all,profile:read_all";

export type OAuthCallbackResult =
  | { kind: "code"; code: string; scope: string }
  | { kind: "error"; error: string }
  | { kind: "ignored"; status: 400 | 404; body: string };

/**
 * Load OAuth client credentials. Throws `MissingCredentialsError` when the
 * file is absent — Strava's shared-app limit is one connected athlete, so
 * every install must register its own API app. Run `cli creds set strava`
 * (or use the portal wizard) to set them up.
 */
export function loadClientCredentials(configDir?: string): StravaCredentials {
  const path = providerCredentialsPath("strava", configDir);
  if (!existsSync(path)) throw new MissingCredentialsError("strava", "Strava");
  const raw = readSecretTextFileSync(path, { configDir });
  if (raw === null) throw new MissingCredentialsError("strava", "Strava");
  const json = JSON.parse(raw) as StravaCredentials;
  if (!json.client_id || !json.client_secret) {
    throw new MissingCredentialsError("strava", "Strava");
  }
  return json;
}

/**
 * Discover all configured Strava accounts.
 * Scans `~/.config/omnesis/strava/` for athlete directories with tokens.json.
 */
export function discoverAccounts(configDir?: string): AccountId[] {
  const stravaDir = join(configDir ?? DEFAULT_CONFIG_DIR, "strava");
  if (!existsSync(stravaDir)) return [];

  return readdirSync(stravaDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(stravaDir, d.name, "tokens.json")))
    .map((d) => AccountId(d.name));
}

export function tokensPath(athleteId: string | number, configDir?: string): string {
  return join(configDir ?? DEFAULT_CONFIG_DIR, "strava", String(athleteId), "tokens.json");
}

/** Whether this athlete's OAuth grant is on disk. Offline — no network probe. */
export function hasTokens(athleteId: string | number, configDir?: string): boolean {
  return existsSync(tokensPath(athleteId, configDir));
}

export async function loadTokens(
  athleteId: string | number,
  configDir?: string,
): Promise<StravaTokens> {
  const path = tokensPath(athleteId, configDir);
  if (!existsSync(path)) {
    throw new Error(`No tokens found for Strava athlete ${athleteId}`);
  }
  const tokens = await readSecretJsonFile<StravaTokens>(path, { configDir });
  if (!tokens) throw new Error(`No readable tokens found for Strava athlete ${athleteId}`);
  return tokens;
}

export async function saveTokens(tokens: StravaTokens, configDir?: string): Promise<void> {
  const dir = join(configDir ?? DEFAULT_CONFIG_DIR, "strava", String(tokens.athlete_id));
  await writeSecretJsonFile(join(dir, "tokens.json"), tokens, { configDir });
}

export interface AuthFlowOptions {
  configDir?: string;
  /** Stream auth events (URL/code delivery) to a remote admin client. */
  callbacks?: AuthFlowCallbacks;
  /** Called with the auth URL instead of printing to console. */
  onAuthUrl?: (url: string) => void;
}

/**
 * Build the Strava authorize URL.
 *
 * `approval_prompt=force` always shows the authorization screen. Under `auto`
 * Strava skips it entirely once the athlete has approved the app, so a second
 * `add` silently re-authorizes the athlete who is already signed in — the same
 * account comes back and no new source appears. Forcing the screen at least
 * puts the athlete's identity in front of the user before they approve.
 *
 * Strava has no account-chooser parameter (no `select_account` equivalent), so
 * connecting a *different* athlete still requires signing out of Strava in the
 * browser first. The add flow detects the duplicate and says so rather than
 * reporting a success that added nothing.
 */
export function buildAuthorizeUrl(
  creds: Pick<StravaCredentials, "client_id">,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    approval_prompt: "force",
    scope: OAUTH_SCOPE,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function parseOAuthCallbackUrl(
  requestUrl: string,
  expectedState: string,
): OAuthCallbackResult {
  const url = new URL(requestUrl || "/", REDIRECT_URI);
  if (url.pathname !== OAUTH_CALLBACK_PATH) {
    return { kind: "ignored", status: 404, body: "Not found." };
  }

  const state = url.searchParams.get("state");
  if (state !== expectedState) {
    return {
      kind: "ignored",
      status: 400,
      body: "Authentication failed (state mismatch). You can close this tab.",
    };
  }

  const error = url.searchParams.get("error");
  if (error) return { kind: "error", error };

  const code = url.searchParams.get("code");
  if (code) return { kind: "code", code, scope: url.searchParams.get("scope") ?? "" };

  return { kind: "ignored", status: 400, body: "Waiting for OAuth callback..." };
}

function gatewayRedirectUri(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/oauth/callback`;
}

function publicCallbackState(callbacks: AuthFlowCallbacks, providerName: string): string {
  if (!callbacks.flowId) {
    throw new Error(`${providerName} auth requires callbacks.flowId when publicBaseUrl is set`);
  }
  if (!callbacks.receiveCode) {
    throw new Error(
      `${providerName} auth requires callbacks.receiveCode when publicBaseUrl is set`,
    );
  }
  return callbacks.flowId;
}

/**
 * Run the Strava OAuth flow interactively.
 * Opens a local callback server on port 3003 and waits for the user to
 * authorize in the browser.
 *
 * Returns the athlete ID as a string (used as the account identifier).
 */
export async function authFlow(opts: AuthFlowOptions = {}): Promise<AccountId> {
  const dir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const callbacks = opts.callbacks ?? {};
  const creds = loadClientCredentials(dir);
  const redirectUri = callbacks.publicBaseUrl
    ? gatewayRedirectUri(callbacks.publicBaseUrl)
    : REDIRECT_URI;
  const state = callbacks.publicBaseUrl ? publicCallbackState(callbacks, "Strava") : randomUUID();
  const authUrl = buildAuthorizeUrl(creds, redirectUri, state);

  // No console fallback: this runs inside the auth subprocess, whose stdout is
  // the protocol the parent parses, so a diagnostic written there would put a
  // non-protocol line into the NDJSON stream and strand the flow.
  if (callbacks.onAuthUrl) {
    callbacks.onAuthUrl(authUrl);
  } else if (opts.onAuthUrl) {
    opts.onAuthUrl(authUrl);
  }

  const code = callbacks.publicBaseUrl
    ? await callbacks.receiveCode!()
    : await waitForAuthCode(state);

  // Exchange authorization code for tokens
  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    throw new Error(`Strava token exchange failed (${tokenResponse.status}): ${body}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    expires_in: number;
    token_type: string;
    athlete: { id: number; firstname?: string; lastname?: string; username?: string };
  };

  const tokens: StravaTokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: tokenData.expires_at,
    athlete_id: tokenData.athlete.id,
    athlete_firstname: tokenData.athlete.firstname,
    athlete_lastname: tokenData.athlete.lastname,
  };

  await saveTokens(tokens, dir);

  const name =
    [tokens.athlete_firstname, tokens.athlete_lastname].filter(Boolean).join(" ") ||
    `athlete ${tokens.athlete_id}`;
  log.info(`Authenticated with Strava as ${name} (athlete ${tokens.athlete_id})`);

  return AccountId(String(tokens.athlete_id));
}

/** The scopes the authorize URL asks for, as the callback reports them. */
const REQUESTED_SCOPES = OAUTH_SCOPE.split(",");

/**
 * Read this install's OAuth client credentials for a connection attempt.
 *
 * Separate from {@link loadClientCredentials} because a flow has somewhere to
 * put the distinction: a credentials file that is present but cannot be
 * decrypted is not the same situation as no credentials at all, and reporting
 * it as absent asks the operator to paste a client secret they already stored.
 */
function readClientCredentialsForFlow(configDir?: string): StravaCredentials {
  const path = providerCredentialsPath("strava", configDir);
  if (!existsSync(path)) throw new MissingCredentialsError("strava", "Strava");
  let raw: string | null;
  try {
    raw = readSecretTextFileSync(path, { configDir });
  } catch (err) {
    throw new AuthFailure(
      "unavailable",
      `The stored Strava OAuth client credentials could not be read: ${describe(err)}`,
      {
        remedy: "Unlock this install's keyring so stored secrets can be decrypted, then try again.",
      },
    );
  }
  if (raw === null) throw new MissingCredentialsError("strava", "Strava");
  const json = JSON.parse(raw) as StravaCredentials;
  if (!json.client_id || !json.client_secret) {
    throw new MissingCredentialsError("strava", "Strava");
  }
  return json;
}

/**
 * Refuse an answer that belongs to a different authorization.
 *
 * No code in the vocabulary describes this: nothing was refused, nothing went
 * stale, and no credential was presented. `unknown` carrying a remedy is the
 * honest report — minting a code for a case the vocabulary does not name would
 * make every other code mean a little less.
 */
function assertMatchingState(answered: string | undefined, expected: string): void {
  if (answered === undefined || answered === expected) return;
  throw new AuthFailure(
    "unknown",
    "The Strava authorization that came back belongs to a different sign-in attempt.",
    { remedy: "Close any other Strava sign-in you have open, then start this one again." },
  );
}

/**
 * What a refused token exchange means, split by what the operator would do
 * about it.
 *
 * One message for all of them tells somebody whose authorization simply went
 * stale to go and re-register their API application, and tells somebody whose
 * application really is misconfigured to try again in a minute.
 */
function tokenExchangeFailure(status: number, body: string): AuthFailure {
  if (/invalid_grant/.test(body)) {
    return new AuthFailure(
      "challenge-expired",
      `Strava refused the authorization code (HTTP ${status}).`,
      {
        remedy:
          "Start the connection again — an authorization code works once and expires within minutes.",
      },
    );
  }
  if (status === 401 || /invalid_client/.test(body)) {
    return new AuthFailure(
      "credential-rejected",
      `Strava refused this install's API application (HTTP ${status}).`,
      {
        remedy:
          "Check the client ID and secret against the Strava API settings page, set them again, then retry.",
      },
    );
  }
  if (status >= 500) {
    return new AuthFailure(
      "unavailable",
      `Strava could not complete the token exchange (HTTP ${status}).`,
      { remedy: "Try again in a few minutes." },
    );
  }
  return new AuthFailure("unknown", `Strava token exchange failed (HTTP ${status}): ${body}`);
}

interface StravaTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete: { id: number; firstname?: string; lastname?: string; username?: string };
}

/** Trade the authorization code for the athlete's tokens. */
async function exchangeAuthorizationCode(
  creds: StravaCredentials,
  code: string,
): Promise<StravaTokenResponse> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        code,
        grant_type: "authorization_code",
      }),
    });
  } catch (err) {
    throw new AuthFailure(
      "unavailable",
      `Strava could not be reached to exchange the authorization code: ${describe(err)}`,
      { remedy: "Check this machine's network connection, then try again." },
    );
  }
  if (!response.ok) throw tokenExchangeFailure(response.status, await response.text());
  return (await response.json()) as StravaTokenResponse;
}

/**
 * What the athlete actually granted, as a connection state.
 *
 * Strava reports the granted scopes on the callback and nowhere else — not on
 * the token response, and not on any later request — so this is the only
 * moment a narrowed grant can be recorded at all. `scope-insufficient` does
 * not stop the source: what the grant does cover still syncs, and only a new
 * authorization can widen it.
 */
function grantState(scope: string | undefined): ConnectionState {
  if (scope === undefined) return { status: "connected" };
  const granted = new Set(scope.split(",").filter(Boolean));
  const missing = REQUESTED_SCOPES.filter((requested) => !granted.has(requested));
  return missing.length > 0 ? { status: "scope-insufficient", missing } : { status: "connected" };
}

/**
 * Connect a Strava athlete.
 *
 * Where the browser lands decides the shape: the gateway's own callback route
 * when the host has a public origin, otherwise a listener on this machine. The
 * loopback listener is bound before the authorization URL reaches the operator,
 * and the flow then waits on both it and the operator at once — a browser on
 * another machine cannot reach the listener, and delivering the code by hand is
 * the only way through from there.
 */
export async function authenticate(session: AuthSession): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const creds = readClientCredentialsForFlow(configDir);
  const title = "Authorize Omnesis in Strava";
  const instructions =
    "Sign in to Strava and approve the requested access. Leaving every box ticked is what lets " +
    "private activities and heart-rate zones sync.";

  let code: string;
  let scope: string | undefined;

  if (session.publicBaseUrl) {
    const state = session.flowId;
    if (!state) {
      throw new AuthFailure(
        "unknown",
        "This connection attempt has no id, so an authorization caught by the gateway could not be matched back to it.",
        { remedy: "Start the connection again." },
      );
    }
    const answer = await session.ask({
      kind: "redirect",
      via: "gateway",
      title,
      instructions,
      url: buildAuthorizeUrl(creds, gatewayRedirectUri(session.publicBaseUrl), state),
    });
    assertMatchingState(answer.state, state);
    code = answer.code;
  } else {
    const state = randomUUID();
    const listener = await bindCallbackListener(state);
    try {
      const delivered = session.ask({
        kind: "redirect",
        via: "loopback",
        title,
        instructions,
        url: buildAuthorizeUrl(creds, REDIRECT_URI, state),
      });
      // Only one of these is awaited to completion, so the other's eventual
      // rejection needs a reader of its own or it surfaces as an unhandled
      // rejection long after this flow has moved on.
      void delivered.catch(() => {});
      void listener.result.catch(() => {});
      const answer: { code: string; state?: string; scope?: string } = await Promise.race([
        listener.result,
        delivered,
      ]);
      assertMatchingState(answer.state, state);
      code = answer.code;
      scope = answer.scope;
    } finally {
      listener.close();
    }
  }

  session.show({ kind: "wait", title: "Finishing the Strava authorization" });
  const tokenData = await exchangeAuthorizationCode(creds, code);

  const tokens: StravaTokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: tokenData.expires_at,
    athlete_id: tokenData.athlete.id,
    athlete_firstname: tokenData.athlete.firstname,
    athlete_lastname: tokenData.athlete.lastname,
  };
  const accountId = String(tokens.athlete_id);

  // Checked before anything is written. Strava has no account chooser, so it
  // authorizes whoever is signed in to the browser — renewing one source's
  // grant while a different athlete is signed in would mint tokens for that
  // athlete, store them under a new account, and leave the source being
  // repaired exactly as broken as it was.
  if (session.reason === "reauthenticate" && session.accountId && accountId !== session.accountId) {
    throw new AuthFailure(
      "identity-mismatch",
      `This authorization is for Strava athlete ${accountId}, not ${session.accountId}.`,
      { remedy: "Sign out of Strava in your browser, then try again." },
    );
  }

  try {
    await saveTokens(tokens, configDir);
  } catch (err) {
    throw new CredentialPersistError("strava", accountId, err);
  }

  const name =
    [tokens.athlete_firstname, tokens.athlete_lastname].filter(Boolean).join(" ") ||
    `athlete ${tokens.athlete_id}`;
  log.info(`Authenticated with Strava as ${name} (athlete ${tokens.athlete_id})`);

  // Deliberately no `expiresAt`: the six-hour access token is not the grant.
  // The grant renews itself from the refresh token, so reporting the access
  // token's expiry would warn about a lapse every six hours forever.
  return { accounts: [{ accountId, state: grantState(scope) }] };
}

/** An unknown thrown value, as one line for an operator-facing message. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A bound loopback listener, and the authorization it is waiting for. */
interface CallbackListener {
  /**
   * Resolves with the authorization code the browser brought back, and the
   * scopes the athlete actually ticked on Strava's screen.
   */
  readonly result: Promise<{ code: string; scope: string }>;
  /** Free the port. Delayed briefly so the browser receives the last response. */
  close(): void;
}

/**
 * Bind the loopback callback listener, then hand back what it is waiting for.
 *
 * Binding is separated from waiting because the two failures belong at
 * different moments: a port that is not free is something the operator can
 * fix, and finding out about it after they have already authorized in the
 * browser costs them the whole round trip for nothing.
 */
function bindCallbackListener(expectedState: string): Promise<CallbackListener> {
  return new Promise<CallbackListener>((bound, bindFailed) => {
    let resolveResult: (value: { code: string; scope: string }) => void;
    let rejectResult: (err: Error) => void;
    let settled = false;
    const result = new Promise<{ code: string; scope: string }>((resolve, reject) => {
      resolveResult = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      rejectResult = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
    });
    // A failure to bind rejects both this and the promise the caller is
    // waiting on for the listener itself, and only that second one has a
    // reader — so this needs one of its own or the rejection escapes.
    void result.catch(() => {});

    const server = createServer((req, res) => {
      const callback = parseOAuthCallbackUrl(req.url ?? "/", expectedState);

      if (callback.kind === "ignored") {
        // A request that is not this authorization — a stray scan, or a
        // browser finishing some other sign-in. Answered and ignored rather
        // than treated as a failure: the authorization this flow is waiting
        // for may still be on its way.
        if (callback.body.includes("state mismatch")) {
          log.warn("Rejected Strava OAuth callback with invalid state");
        }
        res.writeHead(callback.status, { "Content-Type": "text/plain" });
        res.end(callback.body);
        return;
      }

      if (callback.kind === "error") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>",
        );
        rejectResult(authorizationError(callback.error));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h2>Authentication successful!</h2><p>You can close this tab.</p></body></html>",
      );
      resolveResult({ code: callback.code, scope: callback.scope });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      // Every way this listener can fail to come up is something occupying a
      // port on this machine, which is local and fixable — the one code that
      // says so, rather than the untyped throw a client reads as not worth
      // retrying.
      const failure = new AuthFailure(
        "local-conflict",
        err.code === "EADDRINUSE"
          ? `Port ${OAUTH_CALLBACK_PORT} is already in use, so the Strava sign-in cannot be caught here.`
          : `The Strava sign-in listener could not bind ${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}: ${err.message}`,
        {
          remedy:
            `Close any other Omnesis sign-in that is running, or stop whatever holds ` +
            `${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}, then try again.`,
        },
      );
      bindFailed(failure);
      rejectResult(failure);
    });

    server.listen(OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_HOST, () => {
      bound({
        result,
        close: () => {
          setTimeout(() => server.close(), 100).unref?.();
        },
      });
    });
  });
}

/** What Strava reported on its own authorization screen. */
function authorizationError(error: string): AuthFailure {
  // `access_denied` is the athlete saying no where they were asked. Repeating
  // the identical request to someone who just refused it is not a retry, which
  // is what `denied` encodes and `unknown` does not.
  return error === "access_denied"
    ? new AuthFailure("denied", "The Strava authorization was declined.", {
        remedy: "Start the connection again and approve the requested access.",
      })
    : new AuthFailure("unknown", `Strava reported an authorization error: ${error}`);
}

async function waitForAuthCode(expectedState: string): Promise<string> {
  const listener = await bindCallbackListener(expectedState);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("OAuth callback timed out after 5 minutes")),
      5 * 60 * 1000,
    );
    timer.unref?.();
  });
  try {
    const granted = await Promise.race([listener.result, expiry]);
    // Strava grants whatever scopes the athlete left ticked. Without
    // `activity:read_all` the source still works and private activities are
    // simply absent.
    const grantedScopes = new Set(granted.scope.split(",").filter(Boolean));
    if (!grantedScopes.has("activity:read_all")) {
      log.warn(
        `User did not grant 'activity:read_all' scope (got: ${granted.scope}). Private activities will not sync.`,
      );
    }
    return granted.code;
  } finally {
    if (timer) clearTimeout(timer);
    listener.close();
  }
}

/** Remove stored credentials for an athlete. */
export async function cleanupCredentials(athleteId: string, configDir?: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  const dir = join(configDir ?? DEFAULT_CONFIG_DIR, "strava", athleteId);
  await rm(dir, { recursive: true, force: true });
  log.info(`Cleaned up Strava credentials for athlete ${athleteId}`);
}
