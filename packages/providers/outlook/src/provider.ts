// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  BrokerCredentialError,
  createLogger,
  oauthCallbackHost,
  CredentialPersistError,
  DEFAULT_BROKER_PURPOSE,
  DEFAULT_CONFIG_DIR,
  hasBrokerBinding,
  readBrokerBinding,
  readProviderCredentials,
  readSecretTextFile,
  writeSecretTextFile,
  type BrokeredCredentials,
} from "@omnesis/core";
import { ProviderId, AccountId } from "@omnesis/types";
import {
  PublicClientApplication,
  CryptoProvider,
  InteractionRequiredAuthError,
  InteractionRequiredAuthErrorCodes,
  type Configuration,
  type AccountInfo,
} from "@azure/msal-node";
import {
  AuthFailure,
  readConnectionState,
  type ConnectionState,
  type AuthFlowCallbacks,
  type AuthResult,
  type AuthSession,
  type Provider,
} from "@omnesis/source-sdk";
import { AuthError, GraphClient } from "./graph-client.js";

const log = createLogger("provider:microsoft");

/**
 * Omnesis's registered public Azure app (PKCE / native client).
 * The client ID for native apps is public per the OAuth2 spec — no secret
 * is involved. Override with your own Azure app via `cli creds set outlook`
 * (file at `~/.config/omnesis/outlook-credentials.json`) to have the consent
 * screen and the audit trail name a registration you control. It does not
 * widen which accounts can sign in — see `AUTHORITY` below.
 */
const OMNESIS_PUBLIC_AZURE_CLIENT_ID = "c325262e-98f2-4ce7-8a51-417ad9b140ee";

/**
 * The identity endpoint sign-in goes to.
 *
 * `/consumers` accepts personal Microsoft accounts — Outlook.com, Hotmail,
 * Live — and refuses work or school ones, whatever client id is presented. So
 * a user's own Azure app registration cannot open the door to an
 * organizational tenant, and no user-facing text may suggest it does.
 *
 * Supporting those accounts means `/common` or `/organizations`, a tenant
 * setting on the credentials file to choose between them, and admin consent
 * for the Graph scopes below — none of which can be tested without a tenant to
 * test against. It is deliberately absent rather than half-built.
 */
const AUTHORITY = "https://login.microsoftonline.com/consumers";

// One shared scope set for the whole Microsoft provider: `Mail.Read` for the
// Outlook email source, `Files.Read` (delegated, read-only OneDrive) for the
// OneDrive file source, and `Calendars.Read` (delegated, read-only) for the
// Outlook Calendar source. A single consent grants all three sources; each
// scope is the minimal read-only grant — never write/delete (`*.ReadWrite`) nor
// an org-wide scope (`*.Read.All`).
//
// Re-consent note: an existing user authed before a scope was added holds a
// refresh token scoped to the older set. Microsoft's incremental consent means
// the next `acquireTokenSilent` for this widened set can fail with
// `interaction_required`; `isAuthenticated()` returns false in that case, which
// surfaces as needs-auth and routes the user back through `authFlow` — no extra
// code needed.
const SCOPES = ["Mail.Read", "Files.Read", "Calendars.Read", "offline_access"];
const CALLBACK_PORT = 3001;
const REDIRECT_URI = "http://localhost:3001/auth/callback";
const CALLBACK_PATH = "/auth/callback";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/** Every MSAL error code that means "only the user can unblock this". */
const INTERACTION_REQUIRED_CODES = new Set<string>(
  Object.values(InteractionRequiredAuthErrorCodes),
);

/**
 * Whether a silent-token failure is one the user has to resolve by signing in
 * again — a revoked or expired refresh token, a widened scope set awaiting
 * consent, an emptied token cache. MSAL raises these as
 * `InteractionRequiredAuthError`; the `errorCode` check is the fallback for a
 * duplicated msal-common in the dependency tree, where `instanceof` compares
 * against a different copy of the class and would quietly never match.
 */
function needsUserInteraction(err: unknown): boolean {
  if (err instanceof InteractionRequiredAuthError) return true;
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === "string" && INTERACTION_REQUIRED_CODES.has(code);
}

/** Read user-supplied Azure client ID, or fall back to Omnesis's public app. */
async function loadOutlookClientId(configDir: string): Promise<string> {
  const fields = await readProviderCredentials("outlook", configDir);
  if (fields?.client_id) {
    log.info("Using user-provided Azure app registration");
    return fields.client_id;
  }
  return OMNESIS_PUBLIC_AZURE_CLIENT_ID;
}

/**
 * Discover all configured Microsoft/Outlook accounts.
 * Returns an array of account directory names (email addresses).
 */
export function discoverAccounts(configDir?: string): AccountId[] {
  const outlookDir = join(configDir ?? DEFAULT_CONFIG_DIR, "outlook");
  if (!existsSync(outlookDir)) return [];

  return readdirSync(outlookDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(outlookDir, d.name, "tokens.json")))
    .map((d) => AccountId(d.name));
}

function getMsalConfig(clientId?: string): Configuration {
  return {
    auth: {
      clientId: clientId ?? OMNESIS_PUBLIC_AZURE_CLIENT_ID,
      authority: AUTHORITY,
    },
  };
}

export interface AuthFlowOptions {
  configDir?: string;
  /** Stream auth events (URL/QR) to a remote CLI/admin client. */
  callbacks?: AuthFlowCallbacks;
}

export type OAuthCallbackResult =
  | { kind: "code"; code: string }
  | {
      kind: "error";
      /**
       * Which of the two ways this request failed. Microsoft refusing the
       * authorization and a `state` that answers a different sign-in are one
       * `kind` and two different things to tell the operator.
       */
      reason: "oauth-error" | "state-mismatch";
      /** Microsoft's own error name, for the `oauth-error` reason. */
      error?: string;
      message: string;
      status: number;
    }
  | { kind: "waiting"; status: number; message: string }
  | { kind: "not-found"; status: number; message: string };

export function parseOAuthCallbackUrl(
  rawUrl: string,
  expectedState: string,
  callbackPath: string = CALLBACK_PATH,
): OAuthCallbackResult {
  const url = new URL(rawUrl, "http://localhost:3001");
  if (url.pathname !== callbackPath) {
    return { kind: "not-found", status: 404, message: "Not found." };
  }

  const error = url.searchParams.get("error");
  if (error) {
    const desc = url.searchParams.get("error_description") ?? error;
    return {
      kind: "error",
      reason: "oauth-error",
      error,
      status: 200,
      message: `OAuth error: ${desc}`,
    };
  }

  const code = url.searchParams.get("code");
  if (code) {
    const state = url.searchParams.get("state");
    if (state !== expectedState) {
      return {
        kind: "error",
        reason: "state-mismatch",
        status: 400,
        message: "OAuth state mismatch — possible CSRF attempt",
      };
    }
    return { kind: "code", code };
  }

  return { kind: "waiting", status: 400, message: "Waiting for OAuth callback..." };
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
 * Run the Microsoft OAuth flow using MSAL's PKCE + browser-callback path.
 *
 * Device-code flow is unviable for Microsoft: passwordless-only
 * accounts require a passkey/security key/biometric on the device being
 * authenticated, and the verification URL doesn't fall back to password —
 * so we use the same-machine PKCE callback. Cross-device auth instead relies
 * on catching the redirect on the admin-client host or relaying it through
 * the gateway.
 */
export async function authFlow(configDirOrOpts?: string | AuthFlowOptions): Promise<AccountId> {
  const opts =
    typeof configDirOrOpts === "string" ? { configDir: configDirOrOpts } : (configDirOrOpts ?? {});
  const dir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const callbacks = opts.callbacks ?? {};

  const clientId = await loadOutlookClientId(dir);
  const pca = new PublicClientApplication(getMsalConfig(clientId));

  const cryptoProvider = new CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const redirectUri = callbacks.publicBaseUrl
    ? gatewayRedirectUri(callbacks.publicBaseUrl)
    : REDIRECT_URI;
  const state = callbacks.publicBaseUrl
    ? publicCallbackState(callbacks, "Microsoft")
    : randomUUID();

  // Without an explicit prompt, Microsoft reuses whichever account the browser
  // is already signed into, so adding a second mailbox silently re-authorizes
  // the first one and registers nothing new. `select_account` makes the chooser
  // unconditional on a first-time add; a re-auth pins the account it is
  // refreshing via `loginHint` instead, so the user isn't asked to re-pick.
  const reauthAccountId = callbacks.accountId;
  const authUrl = await pca.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state,
    ...(reauthAccountId ? { loginHint: reauthAccountId } : { prompt: "select_account" }),
  });

  if (!callbacks.onAuthUrl) {
    throw new Error(
      "Microsoft authFlow requires a callbacks.onAuthUrl handler — every real caller " +
        "(auth-subprocess, CLI, portal) provides one. Pass `{ callbacks: { onAuthUrl } }`.",
    );
  }
  callbacks.onAuthUrl(authUrl);

  const code = callbacks.publicBaseUrl
    ? await callbacks.receiveCode!()
    : await waitForAuthCode(state);

  const tokenResponse = await pca.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri,
    codeVerifier: verifier,
  });

  const email = tokenResponse.account?.username;
  if (!email) {
    throw new Error("Could not resolve Microsoft account email");
  }

  // Save the serialized MSAL token cache. It holds refresh tokens — write it
  // 0600 (owner-only) via the atomic helper, not at the default umask mode.
  const accountDir = join(dir, "outlook", email);
  const cache = pca.getTokenCache().serialize();
  await writeSecretTextFile(join(accountDir, "tokens.json"), cache, { configDir: dir });

  log.info(`Authenticated Microsoft account: ${email}`);
  return AccountId(email);
}

/** Where the loopback listener binds, and how long it waits. */
export interface AuthenticateDeps {
  /**
   * The redirect the authorize URL carries and the address the listener binds.
   *
   * Both come from the same value on purpose: a listener bound anywhere else
   * is a listener the browser never reaches. Defaults to
   * {@link REDIRECT_URI}, which is the redirect registered on the Azure app.
   */
  redirectUri?: string;
  /** How long to wait for the browser. Defaults to five minutes. */
  timeoutMs?: number;
}

/**
 * Connect a personal Microsoft account.
 *
 * Two ways in, chosen by whether this install has an origin a browser can
 * reach. With one, the redirect is caught by the gateway and works from any
 * browser anywhere. Without one, it is caught on this machine — and put to the
 * operator as a question at the same time, so a browser on another machine
 * still gets through by bringing the code back by hand. The listener is bound
 * before the URL is shown, so an operator who consents immediately cannot beat
 * it to the port.
 *
 * Nothing is written until Microsoft has named the account, and a renewal that
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
  // `host.configDir`, never `host.stateDir`: this package declares the
  // provider id `microsoft` but roots its credentials under `outlook`, so a
  // state-dir substitution would point the token store at a directory that
  // does not exist while discovery kept finding the account under the old
  // one — presenting as a failed sign-in rather than a missing directory.
  const configDir = session.host.configDir;
  // No `missing-credentials` arm: the client id falls back to Omnesis's own
  // public Azure app, which is a complete credential for a PKCE flow. There
  // is no state in which this install has nothing to present.
  const clientId = await loadOutlookClientId(configDir);
  const pca = new PublicClientApplication(getMsalConfig(clientId));

  const { verifier, challenge } = await new CryptoProvider().generatePkceCodes();
  // `session.supplied` is deliberately not read. It carries the source
  // parameters and the per-account credential fields an older client
  // collected up front, and this provider has neither: its sources declare no
  // parameters, and its credentials spec is shared across accounts rather than
  // `perAccount`, so the host sends nothing. A bridge here could not fire.
  const reauthAccountId = session.accountId;
  const title = "Sign in to your Microsoft account";
  const instructions =
    "Sign in with a personal Microsoft account — Outlook.com, Hotmail or Live — and approve " +
    "the read-only access to mail, calendar and files. A work or school account cannot be " +
    "used here.";

  // The gateway's origin is what a browser anywhere can reach, and its absence
  // is what leaves the loopback listener as the only way through. The host
  // withholds the origin when this attempt has no id, so an origin that is
  // present always brings a `flowId` with it — which is what the gateway
  // routes the callback back by.
  const publicBaseUrl = session.publicBaseUrl;
  const viaGateway = publicBaseUrl !== undefined;
  const redirectUri =
    deps.redirectUri ??
    (publicBaseUrl !== undefined ? gatewayRedirectUri(publicBaseUrl) : REDIRECT_URI);
  const state = viaGateway ? session.flowId : randomUUID();

  let code: string;
  if (viaGateway) {
    const answer = await session.ask({
      kind: "redirect",
      via: "gateway",
      title,
      instructions,
      url: await buildAuthorizeUrl(pca, { redirectUri, challenge, state, reauthAccountId }),
    });
    assertMatchingState(answer.state, state);
    code = answer.code;
  } else {
    const listener = await bindCallbackListener(state, redirectUri, deps.timeoutMs);
    try {
      const delivered = session.ask({
        kind: "redirect",
        via: "loopback",
        title,
        instructions,
        url: await buildAuthorizeUrl(pca, { redirectUri, challenge, state, reauthAccountId }),
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
  }

  session.show({ kind: "wait", title: "Finishing the Microsoft sign-in" });
  let tokenResponse;
  try {
    tokenResponse = await pca.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri,
      codeVerifier: verifier,
    });
  } catch (err) {
    throw exchangeFailure(err);
  }

  const email = tokenResponse.account?.username;
  if (!email) {
    throw new AuthFailure(
      "unknown",
      "Microsoft signed the connection in but did not say which account it belongs to.",
      { remedy: "Start the connection again." },
    );
  }

  // Checked before anything is written. `loginHint` asks Microsoft to
  // preselect the account being renewed, but the operator can still sign in as
  // somebody else — and a renewal that did would store a second account's
  // tokens under a second directory and leave the source it was sent to repair
  // exactly as broken as it was.
  if (reauthAccountId && email !== reauthAccountId) {
    throw new AuthFailure(
      "identity-mismatch",
      `This sign-in is for ${email}, not ${reauthAccountId}.`,
      {
        remedy:
          `Sign out of Microsoft in your browser, start the connection again and sign in as ` +
          `${reauthAccountId} — or add ${email} as a separate account.`,
      },
    );
  }

  // The serialized MSAL token cache holds refresh tokens — written 0600
  // (owner-only) through the atomic helper, not at the default umask mode.
  try {
    await writeSecretTextFile(
      join(configDir, "outlook", email, "tokens.json"),
      pca.getTokenCache().serialize(),
      { configDir },
    );
  } catch (err) {
    throw new CredentialPersistError("outlook", email, err);
  }

  log.info(`Authenticated Microsoft account: ${email}`);
  // No `expiresAt`. The grant carries a refresh token that renews itself, so
  // the access token's hour-long expiry is not the grant's deadline and
  // reporting it would warn about a lapse every hour forever.
  return { accounts: [{ accountId: email, state: { status: "connected" } }] };
}

/**
 * Which mailbox a brokered Microsoft grant belongs to: the id the sign-in here
 * would have stored the same account under.
 *
 * The sign-in names an account by MSAL's `account.username`, which MSAL reads
 * off the ID token — `preferred_username`, else `upn`, else the first of
 * `emails` — and keeps exactly as Microsoft wrote it, never lowercased. When
 * the broker kept an ID token in the token response (its integration asks for
 * `openid profile`), the same claims are read off it in the same order. Nango's
 * Microsoft integrations ask only for `offline_access .default` unless told
 * otherwise, which brings no ID token, so Graph is asked instead: `/me`'s
 * `userPrincipalName` is the address a personal account signs in with, which
 * is what `preferred_username` carries for one. `mail` is null for many
 * personal accounts, so it is read only when there is no UPN. `/me` is asked
 * without `$select`, which Graph has been reported to refuse on personal
 * accounts.
 */
export async function resolveBrokeredAccount(
  credentials: BrokeredCredentials,
): Promise<{ accountId: string }> {
  const { credential } = await credentials.get(DEFAULT_BROKER_PURPOSE);
  const fromIdToken =
    credential.type === "oauth2" ? idTokenUsername(credential.raw.id_token) : undefined;
  if (fromIdToken) return { accountId: fromIdToken };

  const graph = new GraphClient((opts) => credentials.token(DEFAULT_BROKER_PURPOSE, opts));
  let me: { userPrincipalName?: unknown; mail?: unknown };
  try {
    me = await graph.get<{ userPrincipalName?: unknown; mail?: unknown }>("/me");
  } catch (err) {
    throw new Error(
      `Microsoft Graph would not say whose mailbox the broker's connection holds: ${err instanceof Error ? err.message : String(err)}. ` +
        "Give the broker's integration the User.Read scope, or openid and profile so its token response carries an ID token.",
      { cause: err },
    );
  }
  const accountId = nonEmptyString(me.userPrincipalName) ?? nonEmptyString(me.mail);
  if (!accountId) {
    throw new Error("Microsoft Graph did not name the mailbox the broker's connection holds");
  }
  return { accountId };
}

/**
 * The username MSAL would give the account an ID token describes, or
 * `undefined` when there is no readable token. The signature is not checked:
 * the token came from the broker with the access token itself, and the claim
 * only names the directory the account is stored under.
 */
function idTokenUsername(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!claims || typeof claims !== "object") return undefined;
  const { preferred_username, upn, emails } = claims as Record<string, unknown>;
  return (
    nonEmptyString(preferred_username) ??
    nonEmptyString(upn) ??
    (Array.isArray(emails) ? nonEmptyString(emails[0]) : undefined)
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The authorize URL for one attempt.
 *
 * Without an explicit prompt, Microsoft reuses whichever account the browser
 * is already signed into, so adding a second mailbox silently re-authorizes
 * the first one and registers nothing new. `select_account` makes the chooser
 * unconditional on a first-time add; a renewal pins the account it is
 * refreshing with `loginHint` instead, so the operator is not asked to re-pick.
 */
function buildAuthorizeUrl(
  pca: PublicClientApplication,
  options: {
    redirectUri: string;
    challenge: string;
    state: string;
    reauthAccountId?: string;
  },
): Promise<string> {
  return pca.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: options.redirectUri,
    codeChallenge: options.challenge,
    codeChallengeMethod: "S256",
    state: options.state,
    ...(options.reauthAccountId
      ? { loginHint: options.reauthAccountId }
      : { prompt: "select_account" }),
  });
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
    "The Microsoft sign-in that came back belongs to a different attempt.",
    { remedy: "Close any other Microsoft sign-in you have open, then start this one again." },
  );
}

/** Which address the loopback listener has to answer on. */
function callbackAddress(redirectUri: string): { port: number; path: string } {
  try {
    const url = new URL(redirectUri);
    return {
      port: url.port ? Number(url.port) : CALLBACK_PORT,
      path: url.pathname || CALLBACK_PATH,
    };
  } catch {
    return { port: CALLBACK_PORT, path: CALLBACK_PATH };
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
 * can complete Microsoft's consent in under a second, and a listener bound
 * after the URL was shown would still be coming up when the browser arrived —
 * the redirect fails, and the flow waits out its whole deadline for a code
 * that was already delivered to nothing.
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

      if (callback.kind === "not-found" || callback.kind === "waiting") {
        res.writeHead(callback.status, { "Content-Type": "text/plain" });
        res.end(callback.message);
        return;
      }
      if (callback.kind === "error") {
        res.writeHead(callback.status, { "Content-Type": "text/plain" });
        res.end("Authentication failed. You can close this tab.");
        rejectResult(callbackFailure(callback));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Authentication successful! You can close this tab.");
      resolveResult({ code: callback.code, state: expectedState });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      server.close();
      // Without this, a bind failure is an uncaught exception that kills the
      // auth subprocess with no terminal event on the wire, which the parent
      // can only report as a flow that ended without completing. Every way
      // this listener fails to come up is something occupying a port on this
      // machine — local and fixable, which is the one code that says so.
      const failure = new AuthFailure(
        "local-conflict",
        err.code === "EADDRINUSE"
          ? `Port ${port} is already in use, so the Microsoft sign-in cannot be caught here.`
          : `The Microsoft sign-in listener could not bind port ${port}: ${err.message}`,
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
      // and Microsoft would still honour it. This end stopped waiting.
      rejectResult(
        new AuthFailure("timeout", "Nobody completed the Microsoft sign-in in time.", {
          remedy: "Start the connection again when you are ready to finish it.",
        }),
      );
    }, timeoutMs);
    deadline.unref?.();

    server.listen(port, oauthCallbackHost("127.0.0.1"), () => {
      bound({
        result,
        close: () => {
          clearTimeout(deadline);
          // Long enough for the response that ended this flow to reach the
          // browser: closing the socket underneath it would show the operator
          // a failed page for a sign-in that worked.
          setTimeout(() => server.close(), 100).unref?.();
        },
      });
    });
  });
}

/**
 * What a refused sign-in means for the operator.
 *
 * Only one of Microsoft's callback errors is a person being asked and saying
 * no, and it is the one that matters: the operator clicked Cancel on the
 * consent screen. The rest — a redirect the app registration does not hold, a
 * tenant policy — are refusals nobody in this flow made, and the vocabulary
 * has no code for them, so they carry Microsoft's own error name and a remedy
 * instead.
 */
function callbackFailure(callback: {
  reason: "oauth-error" | "state-mismatch";
  error?: string;
  message: string;
}): AuthFailure {
  if (callback.reason === "state-mismatch") {
    return new AuthFailure("unknown", "A Microsoft sign-in arrived for a different attempt.", {
      remedy: "Close any other Microsoft sign-in you have open, then start this one again.",
    });
  }
  if (callback.error === "access_denied") {
    return new AuthFailure("denied", "The Microsoft sign-in was declined.", {
      remedy: "Start the connection again and approve the access Omnesis asks for.",
    });
  }
  return new AuthFailure("unknown", `Microsoft refused the sign-in: ${callback.message}`, {
    remedy:
      "Check that the account is a personal Microsoft account — Outlook.com, Hotmail or " +
      "Live — and that the Azure app registration holds this redirect, then try again.",
  });
}

/** Errors whose text is a machine or a network, not an answer from Microsoft. */
const NETWORK_PATTERNS =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|fetch failed|network_error/i;

/**
 * Why the authorization code could not be exchanged for tokens.
 *
 * `invalid_grant` is the code itself: already spent, or older than the few
 * minutes Microsoft honours one for — the challenge went stale, which is what
 * `challenge-expired` names, and the remedy is a fresh sign-in.
 * `invalid_client` and `unauthorized_client` are the *other* credential, the
 * Azure app registration: it was presented and refused, and signing in again
 * will not change it.
 */
function exchangeFailure(err: unknown): AuthFailure {
  const errorCode = (err as { errorCode?: unknown } | null)?.errorCode;
  const message = err instanceof Error ? err.message : String(err);
  const text = [typeof errorCode === "string" ? errorCode : "", message].join(" ");

  if (/\binvalid_grant\b/i.test(text)) {
    return new AuthFailure(
      "challenge-expired",
      "Microsoft would not exchange this sign-in — it has already been used or has expired.",
      { remedy: "Start the connection again and finish the sign-in without pausing." },
    );
  }
  if (/\binvalid_client\b|\bunauthorized_client\b/i.test(text)) {
    return new AuthFailure(
      "credential-rejected",
      "Microsoft refused the Azure app registration this install presented.",
      {
        remedy:
          "Check the Application (client) ID against the app registration in the Azure " +
          "portal, and set it again if it differs.",
      },
    );
  }
  if (/\baccess_denied\b|\bconsent_required\b/i.test(text)) {
    return new AuthFailure("denied", "The Microsoft sign-in was declined.", {
      remedy: "Start the connection again and approve the access Omnesis asks for.",
    });
  }
  if (NETWORK_PATTERNS.test(text)) {
    return new AuthFailure("unavailable", `Microsoft could not be reached: ${message}`);
  }
  return new AuthFailure("unknown", message || "Microsoft refused the token exchange.");
}

/**
 * Listen on localhost:3001 for Microsoft's OAuth redirect, return the auth
 * code. Same-machine only. Times out after 5 minutes.
 */
function waitForAuthCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const result = parseOAuthCallbackUrl(req.url ?? "/", expectedState);

      if (result.kind === "not-found") {
        res.writeHead(result.status, { "Content-Type": "text/plain" });
        res.end(result.message);
        return;
      }

      if (result.kind === "error") {
        reject(new Error(result.message));
        res.writeHead(result.status, { "Content-Type": "text/plain" });
        res.end("Authentication failed. You can close this tab.");
        setTimeout(() => server.close(), 100);
        return;
      }

      if (result.kind === "code") {
        resolve(result.code);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Authentication successful! You can close this tab.");
        setTimeout(() => server.close(), 100);
        return;
      }
      res.writeHead(result.status, { "Content-Type": "text/plain" });
      res.end(result.message);
    });
    server.listen(CALLBACK_PORT, oauthCallbackHost());

    setTimeout(() => {
      server.close();
      reject(new Error("OAuth callback timed out"));
    }, AUTH_TIMEOUT_MS);
  });
}

export interface MicrosoftProviderOptions {
  /**
   * The account's credentials, for an account whose grant the credential
   * broker holds. Its tokens then come from the broker alone: MSAL is never
   * set up, no client id is read, and nothing is written to `tokens.json`.
   */
  broker?: BrokeredCredentials;
}

/**
 * Microsoft OAuth 2.0 provider (personal accounts, PKCE).
 * Each instance represents one Microsoft account.
 */
export class MicrosoftProvider implements Provider {
  readonly name = "Microsoft";

  private pca: PublicClientApplication | null = null;
  private account: AccountInfo | null = null;
  private configDir: string;
  private _accountId: string;

  /**
   * Serialized MSAL cache as last committed to disk. `getAccessToken`
   * runs once per Graph request and MSAL leaves the cache untouched on
   * all but the occasional refresh, so comparing against this keeps the
   * encrypt-and-fsync to once per refresh rather than once per request.
   */
  private persistedCache: string | null = null;
  private grantRevoked = false;

  /**
   * Serializes cache writes. One provider instance is shared by every
   * source on the account (mail, calendar, files), and those fan their
   * Graph calls out concurrently — unqueued, their compare-then-write
   * pairs would interleave and re-commit cache states already on disk.
   */
  private persistQueue: Promise<void> = Promise.resolve();

  private readonly broker?: BrokeredCredentials;

  /**
   * The broker refresh one Graph 401 started, shared by every request that
   * meets the same refused token — mail, calendar and files fan out at once,
   * and each refresh at the broker is a round trip to Microsoft.
   */
  private brokerRefresh: Promise<string> | null = null;

  get id(): ProviderId {
    return ProviderId(`microsoft:${this._accountId}`);
  }

  get accountId(): AccountId {
    return AccountId(this._accountId);
  }

  constructor(accountId: string, configDir?: string, opts: MicrosoftProviderOptions = {}) {
    this._accountId = accountId;
    this.configDir = configDir ?? DEFAULT_CONFIG_DIR;
    this.broker = opts.broker;
  }

  private get tokensPath() {
    return join(this.configDir, "outlook", this._accountId, "tokens.json");
  }

  async initialize(): Promise<void> {
    // The broker holds and refreshes a brokered grant. An MSAL cache here
    // would be a second copy of it, and an empty one would only ever answer
    // that the account needs signing in.
    if (this.broker) return;
    const clientId = await loadOutlookClientId(this.configDir);
    this.pca = new PublicClientApplication(getMsalConfig(clientId));

    if (existsSync(this.tokensPath)) {
      const cache = await readSecretTextFile(this.tokensPath, { configDir: this.configDir });
      if (cache) {
        this.pca.getTokenCache().deserialize(cache);
        // Baseline for the change check in `persistTokenCache`. Taken by
        // re-serializing rather than reusing `cache`, so a round-trip that
        // reorders or normalizes the JSON doesn't read as a change.
        this.persistedCache = this.pca.getTokenCache().serialize();
      }

      const accounts = await this.pca.getTokenCache().getAllAccounts();
      this.account = accounts.find((a) => a.username === this._accountId) ?? accounts[0] ?? null;
    }
  }

  async authenticate(): Promise<void> {
    // Auth is done via CLI's authFlow(). This is a no-op.
    if (!this.pca && !this.broker) {
      throw new Error("Provider not initialized");
    }
  }

  async isAuthenticated(): Promise<boolean> {
    if (this.broker) {
      // Same split as below: the broker answering that it holds no usable
      // grant is the only `false`; a broker that cannot be reached is not.
      try {
        await this.getAccessToken();
        return true;
      } catch (err) {
        return !(err instanceof AuthError);
      }
    }
    if (!this.pca || !this.account) return false;
    try {
      await this.pca.acquireTokenSilent({
        account: this.account,
        scopes: SCOPES,
      });
    } catch (err) {
      // Only a failure that asks for the user to come back means the grant is
      // gone — `interaction_required`, `consent_required`, `login_required`,
      // an expired or revoked refresh token. MSAL raises all of those as
      // `InteractionRequiredAuthError`. Everything else it can throw here is
      // Microsoft being unreachable or unwell, and answering `false` for that
      // parks every Microsoft source in needs-auth and pushes a re-auth
      // reminder that re-authorizing would not have fixed. Stay authenticated;
      // the real error surfaces on the sync path where it is retried.
      if (!needsUserInteraction(err)) {
        log.warn(
          `Could not silently refresh the Microsoft token — treating the account as still authenticated: ${err instanceof Error ? err.message : String(err)}`,
        );
        return true;
      }
      this.grantRevoked = true;
      return false;
    }
    // This acquisition can rotate the refresh token just as the one in
    // `getAccessToken` can. A process that only ever probes authentication
    // would otherwise drop the rotation and cost the user a re-auth. A
    // failed write leaves the baseline untouched, so the next commit
    // retries — hence the warn rather than a failed probe.
    await this.persistTokenCache().catch((err: unknown) => {
      log.warn(
        `Could not persist the rotated Microsoft token cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    this.grantRevoked = false;
    return true;
  }

  /** Inspect stored state only; token refresh belongs to requests, not status. */
  credentialState(): Promise<ConnectionState> {
    return readConnectionState(async () => {
      if (hasBrokerBinding("outlook", this._accountId, this.configDir)) {
        // The broker holds the grant and refreshes it; a binding that reads
        // is the stored answer. A connection the broker has lost surfaces on
        // the next sync as an `auth` failure.
        await readBrokerBinding("outlook", this._accountId, this.configDir);
        return { status: "connected" };
      }
      const cache = await readSecretTextFile(this.tokensPath, { configDir: this.configDir });
      if (cache === null) return { status: "never-connected" };
      if (!cache || !this.account) throw new Error("Unreadable Microsoft account cache");
      JSON.parse(cache);
      return this.grantRevoked ? { status: "revoked" } : { status: "connected" };
    });
  }

  /**
   * Local only, in both modes: MSAL's `removeAccount` drops the account from
   * this process's cache, and a brokered account has no cache at all. The
   * grant at Microsoft — or at the broker, shared with other software — is
   * never revoked from here.
   */
  async disconnect(): Promise<void> {
    const pca = this.pca;
    const account = this.account;

    // Disarm before draining. `cleanupCredentials` deletes the account
    // directory right after this resolves, and `writeSecretTextFile`
    // recreates parent directories — so a queued write landing afterwards
    // would restore a live refresh token and resurrect the account on the
    // next discovery pass.
    this.pca = null;
    this.account = null;
    this.persistedCache = null;
    await this.persistQueue;

    if (pca && account) {
      try {
        await pca.getTokenCache().removeAccount(account);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * A Graph access token for the account.
   *
   * `forceRefresh` is what `GraphClient` asks after Graph refused a token. A
   * brokered account then asks the broker to refresh the grant, which picks up
   * a token the broker rotated since this one was handed out. A stored grant
   * ignores it: MSAL renews its token when due, so Graph refusing one MSAL
   * still holds means the grant itself is gone, which the `AuthError` that
   * follows reports.
   */
  async getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
    if (this.broker) return this.brokeredAccessToken(this.broker, opts.forceRefresh === true);
    if (!this.pca || !this.account) {
      throw new Error("Microsoft provider not initialized or not authenticated");
    }

    // A silent acquisition that needs the user back is the same condition
    // `isAuthenticated` reads as revoked — the refresh token itself is dead,
    // not this one request. Surfaced as `AuthError` so every source built on
    // `GraphClient` recognizes it as an account-wide failure, the same as a
    // Graph 401, instead of the sync loop reading it as a problem with
    // whichever calendar or folder happened to need a token first.
    const result = await this.pca
      .acquireTokenSilent({
        account: this.account,
        scopes: SCOPES,
      })
      .catch((err: unknown) => {
        if (needsUserInteraction(err)) {
          this.grantRevoked = true;
          throw new AuthError(err instanceof Error ? err.message : String(err));
        }
        throw err;
      });

    await this.persistTokenCache();

    this.grantRevoked = false;

    return result.accessToken;
  }

  /**
   * The broker's token for this account. A refusal at the broker — no such
   * connection, a grant it can no longer refresh, Omnesis's key refused — is
   * raised as `AuthError`, the same account-wide failure a dead MSAL grant is,
   * so every source parks on it rather than reading it as one calendar's or
   * one folder's problem. A broker that cannot be reached stays a `network`
   * error and is retried.
   */
  private async brokeredAccessToken(
    broker: BrokeredCredentials,
    forceRefresh: boolean,
  ): Promise<string> {
    try {
      if (!forceRefresh) return await broker.token(DEFAULT_BROKER_PURPOSE);
      this.brokerRefresh ??= broker
        .token(DEFAULT_BROKER_PURPOSE, { forceRefresh: true })
        .finally(() => {
          this.brokerRefresh = null;
        });
      return await this.brokerRefresh;
    } catch (err) {
      if (err instanceof BrokerCredentialError && err.kind === "auth") {
        throw new AuthError(err.message, { cause: err });
      }
      throw err;
    }
  }

  /**
   * Commit the MSAL cache to disk when a silent acquisition changed it —
   * a refresh token may have been rotated, and losing the rotation costs
   * the user a re-auth. Writes 0600 into a directory it creates, matching
   * the write `authFlow` makes when the account is first authenticated.
   *
   * The cache is serialized inside the queued closure, not at call time,
   * so a write that has been waiting always commits the latest state
   * rather than a stale snapshot. `persistedCache` advances only after a
   * successful write, so a failure leaves the next caller to retry.
   */
  private persistTokenCache(): Promise<void> {
    const write = this.persistQueue.then(async () => {
      if (!this.pca) return;
      const cache = this.pca.getTokenCache().serialize();
      if (cache === this.persistedCache) return;
      await writeSecretTextFile(this.tokensPath, cache, { configDir: this.configDir });
      this.persistedCache = cache;
    });
    // The queue must outlive a failed write, and only the caller whose
    // write failed should see the rejection.
    this.persistQueue = write.catch(() => {});
    return write;
  }
}
