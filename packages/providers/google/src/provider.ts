// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { google } from "googleapis";
import {
  AuthFailure,
  blocksSync,
  readConnectionState,
  stateFromStoredCredential,
} from "@omnesis/source-sdk";
import { ProviderId, AccountId } from "@omnesis/types";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const log = createLogger("provider:google");
import { unlink } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  createLogger,
  CredentialPersistError,
  DEFAULT_CONFIG_DIR,
  MissingCredentialsError,
  readProviderCredentials,
  readSecretJsonFile,
  writeSecretJsonFile,
  providerCredentialsPath,
} from "@omnesis/core";
import type {
  AuthFlowCallbacks,
  AuthResult,
  AuthSession,
  ConnectionState,
  Provider,
} from "@omnesis/source-sdk";

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
];

/**
 * Where Google sends the browser when the authorization completes.
 *
 * A loopback address, and only a loopback address. The wizard has every
 * install create a **Desktop app** OAuth client, and Google accepts nothing
 * but `http://localhost` and `http://127.0.0.1` redirects for that client
 * type — so there is no gateway-caught variant of this flow to offer, however
 * reachable the gateway is. A browser on another machine gets through by
 * bringing the code back by hand instead.
 */
const DEFAULT_REDIRECT_URI = "http://localhost:3000/oauth2callback";
const DEFAULT_CALLBACK_PORT = 3000;
/**
 * Loopback, explicitly.
 *
 * The redirect is followed by a browser on this machine, so nothing outside it
 * ever needs to reach this listener — and binding every interface both exposes
 * the flow on whatever networks the host is on and makes the bind collide with
 * any process holding this port on any single address, even while loopback
 * itself is free.
 */
const DEFAULT_CALLBACK_HOST = "localhost";
const DEFAULT_CALLBACK_PATH = "/oauth2callback";
/** How long the loopback listener waits for the browser before giving up. */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

interface StoredTokens {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

/** Subset of fields googleapis returns on auth/refresh; null is allowed. */
interface TokenPatch {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
  token_type?: string | null;
  id_token?: string | null;
}

/** Strip undefined/null entries so merge keeps the existing on-disk value. */
function compactPatch(patch: TokenPatch): StoredTokens {
  const out: StoredTokens = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && v !== null) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * Atomically persist Google OAuth tokens to disk with 0600 permissions.
 * Merges new credentials with existing on-disk content because Google's
 * token-refresh event sometimes only carries a fresh `access_token` while
 * keeping the old `refresh_token` intact, and sometimes rotates both.
 */
async function persistTokens(
  tokensPath: string,
  newTokens: TokenPatch,
  configDir: string,
): Promise<void> {
  const patch = compactPatch(newTokens);
  let merged: StoredTokens = { ...patch };
  if (existsSync(tokensPath)) {
    try {
      const existing = await readSecretJsonFile<StoredTokens>(tokensPath, { configDir });
      if (existing) {
        merged = { ...existing, ...patch };
      }
    } catch (err) {
      log.warn(
        `Existing tokens.json unreadable, overwriting: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await writeSecretJsonFile(tokensPath, merged, { configDir });
}

export interface ClientCredentials {
  client_id: string;
  client_secret: string;
  redirect_uri?: string;
}

/**
 * Path of the Google OAuth credentials file. Backwards-compat re-export of
 * the unified `providerCredentialsPath("google", ...)`.
 */
export function getCredentialsPath(configDir?: string): string {
  return providerCredentialsPath("google", configDir);
}

/**
 * Load OAuth client credentials. Throws `MissingCredentialsError` when the
 * file is absent — there is no bundled fallback, every install must register
 * its own OAuth client with Google. Run `cli creds set google` (or use the
 * portal wizard) to set them up.
 */
export async function loadClientCredentials(configDir?: string): Promise<ClientCredentials> {
  const fields = await readProviderCredentials("google", configDir);
  if (!fields) throw new MissingCredentialsError("google", "Google");
  if (!fields.client_id || !fields.client_secret) {
    throw new MissingCredentialsError("google", "Google");
  }
  return {
    client_id: fields.client_id,
    client_secret: fields.client_secret,
    redirect_uri: fields.redirect_uri,
  };
}

/**
 * Discover all configured Google accounts.
 * Returns an array of account directory names (email addresses).
 */
export function discoverAccounts(configDir?: string): AccountId[] {
  const googleDir = join(configDir ?? DEFAULT_CONFIG_DIR, "google");
  if (!existsSync(googleDir)) return [];

  return readdirSync(googleDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(googleDir, d.name, "tokens.json")))
    .map((d) => AccountId(d.name));
}

export interface AuthFlowOptions {
  configDir?: string;
  /** Stream auth events (URL/QR/device-code) to a remote CLI/admin client. */
  callbacks?: AuthFlowCallbacks;
}

/**
 * The authorize-URL parameters that decide *which* Google account the flow
 * authenticates.
 *
 * `prompt=consent` alone re-shows the consent screen but not the account
 * chooser: with a single signed-in Google session the browser re-authorizes
 * that same account, so adding a second mailbox would overwrite the first
 * account's tokens and register nothing new. `select_account` makes the chooser
 * unconditional for a first-time add.
 *
 * A re-auth is passed the account it is refreshing, so it pins that account
 * with `login_hint` and skips the chooser. `consent` appears in both cases:
 * Google only re-issues a refresh token when the user passes through consent.
 */
export function accountSelectionParams(reauthAccountId?: string): {
  prompt: string;
  login_hint?: string;
} {
  if (reauthAccountId) return { prompt: "consent", login_hint: reauthAccountId };
  return { prompt: "select_account consent" };
}

/**
 * Run the Google OAuth flow using the browser callback (loopback) path: the
 * user opens the auth URL, Google redirects to
 * http://localhost:3000/oauth2callback, and the collector intercepts the code.
 * Same-machine only — the loopback callback must be caught on the host running
 * the browser.
 *
 * Device flow (RFC 8628) is not viable for Google: it restricts the scope
 * allowlist to drive/youtube/email/profile/openid, which can't cover Gmail /
 * Calendar / Contacts (#170). Cross-device Google auth instead relies on
 * catching the redirect on the admin-client host or relaying it through the
 * gateway.
 */
export async function authFlow(configDirOrOpts?: string | AuthFlowOptions): Promise<AccountId> {
  const opts =
    typeof configDirOrOpts === "string" ? { configDir: configDirOrOpts } : (configDirOrOpts ?? {});
  const dir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const callbacks = opts.callbacks ?? {};
  const creds = await loadClientCredentials(dir);

  const oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uri ?? DEFAULT_REDIRECT_URI,
  );

  // Bind the OAuth callback to a freshly-minted `state` so a malicious local
  // process can't race a poisoned `?code=…` to localhost:3000 in the 5-minute
  // auth window. Google echoes `state` back unchanged; we reject the redirect
  // on mismatch.
  const state = randomUUID();
  const authUrl = oauth2Client.generateAuthUrl({
    ...accountSelectionParams(callbacks.accountId),
    access_type: "offline",
    scope: SCOPES,
    state,
  });

  if (!callbacks.onAuthUrl) {
    throw new Error(
      "Google authFlow requires a callbacks.onAuthUrl handler — every real caller " +
        "(auth-subprocess, CLI, portal) provides one. Pass `{ callbacks: { onAuthUrl } }`.",
    );
  }
  callbacks.onAuthUrl(authUrl);

  const code = await waitForAuthCode(state);
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Resolve email — gmail.users.getProfile only needs gmail.readonly, which
  // we already have. Avoids requiring a separate userinfo scope.
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  const email = profile.data.emailAddress;
  if (!email) throw new Error("Could not resolve Google account email");

  // Save tokens to account-specific directory.
  await persistTokens(join(dir, "google", email, "tokens.json"), tokens, dir);

  // Migrate old tokens file if it exists (from pre-multi-account)
  const oldTokensPath = join(dir, "google-tokens.json");
  if (existsSync(oldTokensPath)) {
    await unlink(oldTokensPath);
    log.info("Removed old google-tokens.json (migrated to account directory)");
  }

  return AccountId(email);
}

/** Where the loopback listener binds, and how long it waits. */
export interface AuthenticateDeps {
  /**
   * The redirect the authorize URL carries and the address the listener binds.
   *
   * Defaults to whatever the credentials file names, and to
   * {@link DEFAULT_REDIRECT_URI} when it names nothing. Both come from the
   * same value on purpose: a listener bound anywhere else is a listener the
   * browser never reaches.
   */
  redirectUri?: string;
  /** How long to wait for the browser. Defaults to five minutes. */
  timeoutMs?: number;
}

/**
 * Connect a Google account.
 *
 * The authorization is caught two ways at once. A listener on this machine
 * takes the redirect when the browser is here, and the same redirect is put to
 * the operator as a question, so a browser on another machine gets through by
 * bringing the code back by hand — the loopback address it lands on carries
 * the code in its own bar even when nothing answers there. Whichever arrives
 * first wins; the listener is bound before the URL is shown, so an operator
 * who consents immediately cannot beat it to the port.
 *
 * Nothing is written until Google has named the account, and a renewal that
 * named a different account is refused before the write rather than after it.
 */
export function authenticate(session: AuthSession): Promise<AuthResult> {
  return authenticateWith(session, {});
}

/** {@link authenticate}, with the callback address its tests substitute. */
export async function authenticateWith(
  session: AuthSession,
  deps: AuthenticateDeps = {},
): Promise<AuthResult> {
  const configDir = session.host.configDir;
  // Every install registers its own OAuth client, so an install that has not
  // done that yet is the ordinary first-run state rather than a failure of
  // this flow. Thrown as the real class: the host routes it to the wizard
  // that collects a client id and secret, which no failure code can ask for.
  const creds = await loadClientCredentials(configDir);
  const redirectUri = deps.redirectUri ?? creds.redirect_uri ?? DEFAULT_REDIRECT_URI;
  const oauth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, redirectUri);

  // `session.supplied` is deliberately not read. It carries the source
  // parameters and the per-account credential fields an older client
  // collected up front, and this provider has neither: its sources declare no
  // parameters, and its credentials spec is shared across accounts rather than
  // `perAccount`, so the host sends nothing. A bridge here could not fire.
  const reauthAccountId = session.accountId;
  const state = randomUUID();
  const authUrl = oauth2Client.generateAuthUrl({
    ...accountSelectionParams(reauthAccountId),
    access_type: "offline",
    scope: SCOPES,
    state,
  });

  const listener = await bindCallbackListener(state, redirectUri, deps.timeoutMs);
  let code: string;
  try {
    const delivered = session.ask({
      kind: "redirect",
      via: "loopback",
      title: "Authorize Omnesis in Google",
      instructions:
        "Sign in and approve the access Omnesis asks for. Leaving every box ticked is what " +
        "lets mail, calendar, files and contacts all sync.",
      url: authUrl,
    });
    // Only one of these is awaited to completion, so the other's eventual
    // rejection needs a reader of its own or it surfaces as an unhandled
    // rejection long after this flow has moved on.
    void delivered.catch(() => {});
    void listener.result.catch(() => {});
    const answer = await Promise.race([listener.result, delivered]);
    assertMatchingState(answer.state, state);
    code = answer.code;
  } finally {
    listener.close();
  }

  session.show({ kind: "wait", title: "Finishing the Google authorization" });
  let tokens;
  try {
    ({ tokens } = await oauth2Client.getToken(code));
  } catch (err) {
    throw exchangeFailure(err);
  }
  oauth2Client.setCredentials(tokens);

  const email = await resolveAccountEmail(oauth2Client);

  // Checked before anything is written. `login_hint` asks Google to preselect
  // the account being renewed, but the operator can still pick another one at
  // the chooser — and a renewal that authorized somebody else would store a
  // second account's tokens under a second directory and leave the source it
  // was sent to repair exactly as broken as it was.
  if (reauthAccountId && email !== reauthAccountId) {
    throw new AuthFailure(
      "identity-mismatch",
      `This authorization is for ${email}, not ${reauthAccountId}.`,
      {
        remedy:
          `Start the connection again and choose ${reauthAccountId} at Google's account ` +
          `chooser, or add ${email} as a separate account.`,
      },
    );
  }

  try {
    await persistTokens(join(configDir, "google", email, "tokens.json"), tokens, configDir);
  } catch (err) {
    throw new CredentialPersistError("google", email, err);
  }

  // An install that predates per-account storage keeps one shared token file
  // at the config root. It is superseded the moment the account directory
  // above exists, and leaving it behind would leave a live refresh token in a
  // file nothing reads. Failing to remove it costs the operator nothing that
  // is worth losing a completed authorization over.
  const oldTokensPath = join(configDir, "google-tokens.json");
  if (existsSync(oldTokensPath)) {
    try {
      await unlink(oldTokensPath);
      log.info("Removed old google-tokens.json (migrated to account directory)");
    } catch (err) {
      log.warn(
        `Could not remove the superseded google-tokens.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  log.info(`Authenticated Google account ${email}`);
  const granted = grantedScopes(tokens.scope);
  const withheld = SCOPES.filter((scope) => granted !== undefined && !granted.includes(scope));
  return {
    accounts: [
      {
        accountId: email,
        // No `expiresAt`. The refresh token this grant carries renews itself,
        // so the access token's hour-long expiry is not the grant's deadline
        // and reporting it would warn about a lapse every hour forever. A
        // Cloud project left in Testing status does give the grant a real
        // seven-day deadline, but Google's token response says nothing about
        // publishing status, so there is nothing here to read it from.
        state: { status: "connected", ...(granted ? { scopes: granted } : {}) },
      },
    ],
    // Google's consent screen lets each scope be unticked individually, and a
    // grant missing one is not a failure — the other sources work. Said out
    // loud because the source that lost its scope will fail every sync from
    // now on with a permission error that names nothing the operator did.
    ...(withheld.length > 0
      ? {
          notices: [
            {
              title: "Some of the access Omnesis asked for was not granted.",
              detail:
                `The authorization does not cover ${withheld.join(", ")}. Those sources will ` +
                `fail to sync until you connect again and leave every box ticked.`,
            },
          ],
        }
      : {}),
  };
}

/** The scopes Google says it granted, when the token response says. */
function grantedScopes(scope: string | null | undefined): string[] | undefined {
  if (typeof scope !== "string") return undefined;
  const granted = scope.split(" ").filter((value) => value.length > 0);
  return granted.length > 0 ? granted : undefined;
}

/**
 * Refuse a code that answers a different sign-in.
 *
 * `unknown` because no code fits: nothing expired, nobody refused, no
 * credential was rejected, and the port was free — a second authorization
 * simply arrived on the one this flow was holding open. The remedy is the
 * whole of what the operator can do about it, so it carries the meaning the
 * code cannot.
 */
function assertMatchingState(answered: string | undefined, expected: string): void {
  if (answered === undefined || answered === expected) return;
  throw new AuthFailure(
    "unknown",
    "The Google authorization that came back belongs to a different sign-in attempt.",
    { remedy: "Close any other Google sign-in you have open, then start this one again." },
  );
}

/** Which address the loopback listener has to answer on. */
function callbackAddress(redirectUri: string): { port: number; path: string } {
  try {
    const url = new URL(redirectUri);
    return {
      port: url.port ? Number(url.port) : DEFAULT_CALLBACK_PORT,
      path: url.pathname || DEFAULT_CALLBACK_PATH,
    };
  } catch {
    return { port: DEFAULT_CALLBACK_PORT, path: DEFAULT_CALLBACK_PATH };
  }
}

interface CallbackListener {
  /** The authorization the browser delivered here, or why it will not arrive. */
  readonly result: Promise<{ code: string; state: string }>;
  close(): void;
}

/**
 * Bind the loopback listener, and resolve only once it is actually listening.
 *
 * The order matters more than it looks: an operator who is already signed in
 * can complete Google's consent in under a second, and a listener bound after
 * the URL was shown would still be coming up when the browser arrived — the
 * redirect fails, and the flow waits out its whole deadline for a code that
 * was already delivered to nothing.
 */
function bindCallbackListener(
  expectedState: string,
  redirectUri: string,
  timeoutMs: number = AUTH_TIMEOUT_MS,
): Promise<CallbackListener> {
  const { port, path } = callbackAddress(redirectUri);
  return new Promise<CallbackListener>((bound, bindFailed) => {
    let resolveResult: (value: { code: string; state: string }) => void;
    let rejectResult: (err: Error) => void;
    let settled = false;
    const result = new Promise<{ code: string; state: string }>((resolve, reject) => {
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
      const callback = parseOAuthCallbackUrl(req.url ?? "/", expectedState, path);
      res.writeHead(callback.status, { "Content-Type": "text/plain" });
      res.end(callback.body);

      if (callback.kind === "ignored") return;
      if (callback.kind === "error") {
        rejectResult(callbackFailure(callback));
        return;
      }
      resolveResult({ code: callback.code, state: callback.state });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      server.close();
      // Every way this listener fails to come up is something occupying a port
      // on this machine — local and fixable, which is the one code that says
      // so rather than the untyped throw a client reads as not worth retrying.
      const failure = new AuthFailure(
        "local-conflict",
        err.code === "EADDRINUSE"
          ? `Port ${port} is already in use, so the Google sign-in cannot be caught here.`
          : `The Google sign-in listener could not bind port ${port}: ${err.message}`,
        {
          remedy:
            `Close any other Omnesis sign-in that is running, or stop whatever holds ` +
            `port ${port}, then try again.`,
        },
      );
      bindFailed(failure);
      rejectResult(failure);
    });

    const deadline = setTimeout(() => {
      // `timeout`, not `challenge-expired`: the authorize URL is still good
      // and Google would still honour it. This end stopped waiting.
      rejectResult(
        new AuthFailure("timeout", "Nobody completed the Google sign-in in time.", {
          remedy: "Start the connection again when you are ready to finish it.",
        }),
      );
    }, timeoutMs);
    deadline.unref?.();

    server.listen(port, () => {
      bound({
        result,
        close: () => {
          clearTimeout(deadline);
          // Long enough for the response that ended this flow to reach the
          // browser: closing the socket underneath it would show the operator
          // a failed page for an authorization that worked.
          setTimeout(() => server.close(), 100).unref?.();
        },
      });
    });
  });
}

/**
 * What a refused authorization means for the operator.
 *
 * Only one of Google's callback errors is a person being asked and saying no,
 * and it is the one that matters: the operator clicked Cancel on the consent
 * screen. The rest — a policy that forbids the app, a redirect the client does
 * not have registered — are refusals nobody in this flow made, and the
 * vocabulary has no code for them, so they carry Google's own error name and
 * a remedy instead.
 */
function callbackFailure(callback: {
  reason: "oauth-error" | "state-mismatch";
  error?: string;
  message: string;
}): AuthFailure {
  if (callback.reason === "state-mismatch") {
    return new AuthFailure(
      "unknown",
      "A Google authorization arrived for a different sign-in attempt.",
      { remedy: "Close any other Google sign-in you have open, then start this one again." },
    );
  }
  if (callback.error === "access_denied") {
    return new AuthFailure("denied", "The Google authorization was declined.", {
      remedy: "Start the connection again and approve the access Omnesis asks for.",
    });
  }
  return new AuthFailure("unknown", `Google refused the authorization: ${callback.error}.`, {
    remedy:
      "Check that the OAuth client in your Google Cloud project is a Desktop app and that " +
      "the consent screen is published, then try again.",
  });
}

/** Errors whose text is a machine or a network, not an answer from Google. */
const NETWORK_PATTERNS = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH/i;

/** Whatever Google's token endpoint put in the body, as one string. */
function oauthErrorText(err: unknown): string {
  const e = (err ?? {}) as {
    message?: unknown;
    response?: { data?: { error?: unknown; error_description?: unknown } };
  };
  const parts: string[] = [];
  if (typeof e.message === "string") parts.push(e.message);
  const data = e.response?.data;
  if (typeof data?.error === "string") parts.push(data.error);
  if (typeof data?.error_description === "string") parts.push(data.error_description);
  return parts.join(" ");
}

/**
 * Why the authorization code could not be exchanged for tokens.
 *
 * `invalid_grant` is the code itself: already spent, or older than the few
 * minutes Google honours one for — the challenge went stale, which is exactly
 * what `challenge-expired` names, and the remedy is a fresh authorization.
 * `invalid_client` is the *other* credential, the one from the Cloud project:
 * it was presented and refused, and re-authorizing will not change it.
 */
function exchangeFailure(err: unknown): AuthFailure {
  const text = oauthErrorText(err);
  if (/\binvalid_grant\b/i.test(text)) {
    return new AuthFailure(
      "challenge-expired",
      "Google would not exchange this authorization — it has already been used or has expired.",
      { remedy: "Start the connection again and finish the sign-in without pausing." },
    );
  }
  if (/\binvalid_client\b|\bunauthorized_client\b/i.test(text)) {
    return new AuthFailure(
      "credential-rejected",
      "Google refused the OAuth client this install presented.",
      {
        remedy:
          "Check the client ID and client secret against the OAuth client in your Google " +
          "Cloud project, and set them again if they differ.",
      },
    );
  }
  if (NETWORK_PATTERNS.test(text)) {
    return new AuthFailure("unavailable", `Google could not be reached: ${text}`);
  }
  return new AuthFailure("unknown", text || "Google refused the token exchange.");
}

/**
 * Which account was authorized, according to Google.
 *
 * Read from the Gmail profile because `gmail.readonly` is already in the
 * grant: asking a userinfo endpoint instead would mean widening every
 * authorization by a scope whose only purpose is this one lookup.
 */
async function resolveAccountEmail(auth: OAuth2Client): Promise<string> {
  let email: string | null | undefined;
  try {
    const profile = await google.gmail({ version: "v1", auth }).users.getProfile({ userId: "me" });
    email = profile.data.emailAddress;
  } catch (err) {
    throw profileFailure(err);
  }
  if (!email) {
    throw new AuthFailure(
      "unknown",
      "Google authorized the connection but did not say which account it belongs to.",
      { remedy: "Start the connection again." },
    );
  }
  return email;
}

/**
 * Why the authorized account could not be named.
 *
 * A 401 or 403 here is the grant itself coming up short — most often a
 * consent screen where the Gmail box was unticked, which leaves a token that
 * is real and cannot read the mailbox. There is no failure code for a grant
 * that is alive but too narrow, so it lands on the one a client acts on the
 * same way: ask again.
 */
function profileFailure(err: unknown): AuthFailure {
  const e = (err ?? {}) as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const status = [e.code, e.status, e.response?.status].find(
    (value): value is number => typeof value === "number",
  );
  const text = oauthErrorText(err);
  if (status === 401 || status === 403) {
    return new AuthFailure(
      "credential-rejected",
      "The authorization does not allow Omnesis to read the account it belongs to.",
      {
        remedy: "Start the connection again and leave every box on Google's consent screen ticked.",
      },
    );
  }
  if (typeof status === "number" && status >= 500) {
    return new AuthFailure("unavailable", `Google could not be reached: ${text}`);
  }
  if (NETWORK_PATTERNS.test(text)) {
    return new AuthFailure("unavailable", `Google could not be reached: ${text}`);
  }
  return new AuthFailure("unknown", text || "Google would not say which account was authorized.");
}

/** What one request to the OAuth callback turns out to be. */
export type GoogleCallbackResult =
  /** The authorization Google sent back, with a `state` that checked out. */
  | { kind: "code"; code: string; state: string; status: number; body: string }
  /** This authorization will not arrive: Google refused, or the state did not match. */
  | {
      kind: "error";
      reason: "oauth-error" | "state-mismatch";
      /** Google's own error name, for the `oauth-error` reason. */
      error?: string;
      message: string;
      status: number;
      body: string;
    }
  /** Someone else's request. Answered, and otherwise left alone. */
  | { kind: "ignored"; status: number; body: string };

/**
 * Read one request to the loopback callback.
 *
 * Restricts the path and verifies that the `state` Google echoes back matches
 * the one this flow minted — without both checks any local process could race
 * a poisoned `?code=…` to loopback during the authorization window.
 *
 * Pure, and separate from the two listeners that run it, so the CSRF check
 * exists once rather than once per entry point.
 */
export function parseOAuthCallbackUrl(
  rawUrl: string,
  expectedState: string,
  callbackPath: string = DEFAULT_CALLBACK_PATH,
): GoogleCallbackResult {
  const url = new URL(rawUrl, "http://localhost");

  if (url.pathname !== callbackPath) {
    return { kind: "ignored", status: 404, body: "Not found." };
  }

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (error) {
    return {
      kind: "error",
      reason: "oauth-error",
      error,
      message: `OAuth error: ${error}`,
      status: 200,
      body: "Authentication failed. You can close this tab.",
    };
  }
  if (code) {
    if (state !== expectedState) {
      return {
        kind: "error",
        reason: "state-mismatch",
        message: "OAuth state mismatch — possible CSRF attempt",
        status: 400,
        body: "Authentication failed (state mismatch). You can close this tab.",
      };
    }
    return {
      kind: "code",
      code,
      state,
      status: 200,
      body: "Authentication successful! You can close this tab.",
    };
  }
  return { kind: "ignored", status: 400, body: "Waiting for OAuth callback..." };
}

/**
 * Listen on localhost:3000 for Google's OAuth redirect, return the auth code.
 * Same-machine only. Times out after 5 minutes.
 */
function waitForAuthCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const result = parseOAuthCallbackUrl(req.url ?? "/", expectedState);
      res.writeHead(result.status, { "Content-Type": "text/plain" });
      res.end(result.body);

      if (result.kind === "code") {
        resolve(result.code);
        setTimeout(() => server.close(), 100);
        return;
      }
      if (result.kind === "error") {
        reject(new Error(result.message));
        setTimeout(() => server.close(), 100);
      }
    });
    // Without an `error` listener a `listen()` failure is an uncaught
    // exception inside the auth subprocess, which the parent then reports as a
    // flow that ended without completing — a message that says nothing about
    // the port and gives the operator nothing to do.
    server.on("error", (err: NodeJS.ErrnoException) => {
      server.close();
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            "Port 3000 is already in use — close any other Omnesis OAuth flow " +
              "(or whichever process is bound to localhost:3000) and try again.",
          ),
        );
        return;
      }
      reject(err);
    });
    server.listen(DEFAULT_CALLBACK_PORT, DEFAULT_CALLBACK_HOST);

    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out"));
    }, AUTH_TIMEOUT_MS);
  });
}

/**
 * Google OAuth 2.0 provider.
 * Each instance represents one Google account.
 */
export class GoogleProvider implements Provider {
  readonly name = "Google";

  private oauth2Client: OAuth2Client | null = null;
  private configDir: string;
  private _accountId: string;

  get id(): ProviderId {
    return ProviderId(`google:${this._accountId}`);
  }

  get accountId(): AccountId {
    return AccountId(this._accountId);
  }

  constructor(accountId: string, configDir?: string) {
    this._accountId = accountId;
    this.configDir = configDir ?? DEFAULT_CONFIG_DIR;
  }

  private get tokensPath() {
    return join(this.configDir, "google", this._accountId, "tokens.json");
  }

  async initialize(): Promise<void> {
    const creds = await loadClientCredentials(this.configDir);

    this.oauth2Client = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      creds.redirect_uri ?? DEFAULT_REDIRECT_URI,
    );

    // googleapis fires `tokens` whenever it refreshes credentials in flight
    // (access_token expiry, occasionally refresh_token rotation). The payload
    // is sometimes the rotated refresh_token only, sometimes both. Persist
    // the merge so a collector restart doesn't lose the rotation and end up
    // with `invalid_grant` against Google.
    const tokensPath = this.tokensPath;
    this.oauth2Client.on("tokens", (newTokens) => {
      persistTokens(tokensPath, newTokens, this.configDir).catch((err) => {
        log.warn(
          `Failed to persist refreshed Google tokens: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    if (existsSync(this.tokensPath)) {
      const tokens = await readSecretJsonFile<StoredTokens>(this.tokensPath, {
        configDir: this.configDir,
      });
      if (tokens) this.oauth2Client.setCredentials(tokens);
    }
  }

  async authenticate(): Promise<void> {
    // In multi-account mode, auth is done via CLI's authFlow().
    // This method is a no-op — tokens are already loaded in initialize().
    if (!this.oauth2Client) {
      throw new Error("Provider not initialized");
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return blocksSync(await this.credentialState()) === false;
  }

  /**
   * What state this account's credential is in, read from what is stored.
   *
   * Three answers, not two. No token at all means this account was never
   * connected. A refresh token means connected with no deadline worth
   * reporting — it renews itself. An access token alone has a real deadline,
   * and it is carried rather than consumed: a host can then say "working,
   * until Friday" instead of discovering the lapse afterwards.
   */
  async credentialState(): Promise<ConnectionState> {
    return readConnectionState(async () => {
      if (existsSync(this.tokensPath)) {
        // Check readability even when a usable token remains cached in memory.
        const stored = await readSecretJsonFile<StoredTokens>(this.tokensPath, {
          configDir: this.configDir,
        });
        if (!stored?.access_token && !stored?.refresh_token)
          throw new Error("Unreadable Google token");
      } else {
        return { status: "never-connected" };
      }
      if (!this.oauth2Client) return { status: "never-connected" };
      const creds = this.oauth2Client.credentials;
      if (!creds.access_token && !creds.refresh_token) return { status: "never-connected" };
      if (creds.refresh_token) return { status: "connected" };
      return creds.expiry_date
        ? stateFromStoredCredential(true, { expiresAt: new Date(creds.expiry_date).toISOString() })
        : { status: "expired" };
    });
  }

  async disconnect(): Promise<void> {
    if (this.oauth2Client) {
      try {
        await this.oauth2Client.revokeCredentials();
      } catch {
        // Ignore
      }
    }
    this.oauth2Client = null;
  }

  getAuth(): OAuth2Client {
    if (!this.oauth2Client) {
      throw new Error("Google provider not initialized");
    }
    return this.oauth2Client;
  }
}
