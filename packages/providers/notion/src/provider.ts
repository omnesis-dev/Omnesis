// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// TODO: add PKCE + custom-scheme cross-device auth flow. iOS catches
// `omnesis://oauth/callback?code=...&state=<flowId>` and POSTs the code to
// /admin/auth-flows/:id/code; collector exchanges code + verifier
// (kept locally) for tokens. The localhost:3002 callback below stays as a
// local-only fallback for solo Mac use.
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
  readSecretJsonFileSync,
  readSecretTextFileSync,
  writeSecretJsonFile,
} from "@omnesis/core";
import { AccountId } from "@omnesis/types";
import { AuthFailure } from "@omnesis/source-sdk";
import type { AuthFlowCallbacks, AuthResult, AuthSession } from "@omnesis/source-sdk";
import type { NotionTokens, NotionCredentials } from "./types.js";

const log = createLogger("provider:notion");

const OAUTH_CALLBACK_HOST = "localhost";
const OAUTH_CALLBACK_PORT = 3002;
const OAUTH_CALLBACK_PATH = "/oauth2callback";
const REDIRECT_URI = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;

/**
 * Load OAuth client credentials. Throws `MissingCredentialsError` when
 * the file is absent — Notion now follows the same user-provided-OAuth
 * pattern Google and Strava use. Run `cli creds set notion` (or the
 * portal wizard) to set them up; the wizard walks the user through
 * registering a Notion public integration and pasting the resulting
 * client ID and secret.
 *
 * Pre-fix the provider shipped a hardcoded `secret_…` literal (split +
 * base64-encoded to defeat scanner regexes). The literal lit up every
 * secret scanner the moment the repo went public; switching to the
 * user-provided-creds pattern matches Google/Strava and removes the
 * literal entirely. See #314 for the migration history.
 */
export function loadClientCredentials(configDir?: string): NotionCredentials {
  const path = providerCredentialsPath("notion", configDir);
  if (!existsSync(path)) throw new MissingCredentialsError("notion", "Notion");
  const raw = readSecretTextFileSync(path, { configDir });
  if (raw === null) throw new MissingCredentialsError("notion", "Notion");
  const json = JSON.parse(raw) as NotionCredentials;
  if (!json.client_id || !json.client_secret) {
    throw new MissingCredentialsError("notion", "Notion");
  }
  return json;
}

/**
 * Discover all configured Notion accounts.
 * Scans `~/.config/omnesis/notion/` for workspace directories with tokens.json.
 */
export function discoverAccounts(configDir?: string): AccountId[] {
  const notionDir = join(configDir ?? DEFAULT_CONFIG_DIR, "notion");
  if (!existsSync(notionDir)) return [];

  return readdirSync(notionDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => existsSync(join(notionDir, d.name, "tokens.json")))
    .map((d) => AccountId(d.name));
}

/**
 * Load stored tokens for a Notion workspace.
 */
export function loadTokens(workspaceId: string, configDir?: string): NotionTokens {
  const tokensPath = join(configDir ?? DEFAULT_CONFIG_DIR, "notion", workspaceId, "tokens.json");
  if (!existsSync(tokensPath)) {
    throw new Error(`No tokens found for Notion workspace ${workspaceId}`);
  }
  const tokens = readSecretJsonFileSync<NotionTokens>(tokensPath, { configDir });
  if (!tokens) throw new Error(`No readable tokens found for Notion workspace ${workspaceId}`);
  return tokens;
}

/** Whether this workspace's OAuth grant is on disk. Offline — no network probe. */
export function hasTokens(workspaceId: string, configDir?: string): boolean {
  return existsSync(join(configDir ?? DEFAULT_CONFIG_DIR, "notion", workspaceId, "tokens.json"));
}

/**
 * Save tokens for a Notion workspace.
 */
export async function saveTokens(
  workspaceId: string,
  tokens: NotionTokens,
  configDir?: string,
): Promise<void> {
  const dir = join(configDir ?? DEFAULT_CONFIG_DIR, "notion", workspaceId);
  // Refresh tokens are bearer credentials — write them 0600 (owner-only) via
  // the atomic helper rather than at the process umask's default mode.
  await writeSecretJsonFile(join(dir, "tokens.json"), tokens, { configDir });
}

export interface AuthFlowOptions {
  configDir?: string;
  /** Stream auth events (URL/code delivery) to a remote admin client. */
  callbacks?: AuthFlowCallbacks;
  /** Called with the auth URL instead of printing to console */
  onAuthUrl?: (url: string) => void;
}

export type OAuthCallbackResult =
  | { kind: "code"; code: string }
  | { kind: "error"; error: string }
  | { kind: "ignored"; status: 400 | 404; body: string };

export function buildAuthorizeUrl(
  creds: Pick<NotionCredentials, "client_id">,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: creds.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    owner: "user",
    state,
  });
  return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;
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
  if (code) return { kind: "code", code };

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
 * Run the Notion OAuth flow interactively.
 * Returns the workspace_id of the authenticated workspace.
 */
export async function authFlow(configDirOrOpts?: string | AuthFlowOptions): Promise<AccountId> {
  const opts =
    typeof configDirOrOpts === "string" ? { configDir: configDirOrOpts } : (configDirOrOpts ?? {});
  const dir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const callbacks = opts.callbacks ?? {};
  const creds = loadClientCredentials(dir);
  const redirectUri = callbacks.publicBaseUrl
    ? gatewayRedirectUri(callbacks.publicBaseUrl)
    : REDIRECT_URI;
  const state = callbacks.publicBaseUrl ? publicCallbackState(callbacks, "Notion") : randomUUID();
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
  const basicAuth = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString("base64");

  const tokenResponse = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    throw new Error(`Notion token exchange failed (${tokenResponse.status}): ${errorBody}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    refresh_token?: string;
    workspace_id: string;
    workspace_name: string;
    bot_id: string;
    owner: unknown;
  };

  const tokens: NotionTokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    workspace_id: tokenData.workspace_id,
    workspace_name: tokenData.workspace_name,
    bot_id: tokenData.bot_id,
  };

  await saveTokens(tokens.workspace_id, tokens, dir);
  log.info(
    `Authenticated with Notion workspace "${tokens.workspace_name}" (${tokens.workspace_id})`,
  );

  return AccountId(tokens.workspace_id);
}

/**
 * Read this install's OAuth client credentials for a connection attempt.
 *
 * Separate from {@link loadClientCredentials} because a flow has somewhere to
 * put the distinction: a credentials file that is present but cannot be
 * decrypted is not the same situation as no credentials at all, and reporting
 * it as absent asks the operator to paste a client secret they already stored.
 */
function readClientCredentialsForFlow(configDir?: string): NotionCredentials {
  const path = providerCredentialsPath("notion", configDir);
  if (!existsSync(path)) throw new MissingCredentialsError("notion", "Notion");
  let raw: string | null;
  try {
    raw = readSecretTextFileSync(path, { configDir });
  } catch (err) {
    throw new AuthFailure(
      "unavailable",
      `The stored Notion OAuth client credentials could not be read: ${describe(err)}`,
      {
        remedy: "Unlock this install's keyring so stored secrets can be decrypted, then try again.",
      },
    );
  }
  if (raw === null) throw new MissingCredentialsError("notion", "Notion");
  const json = JSON.parse(raw) as NotionCredentials;
  if (!json.client_id || !json.client_secret) {
    throw new MissingCredentialsError("notion", "Notion");
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
    "The Notion authorization that came back belongs to a different sign-in attempt.",
    { remedy: "Close any other Notion sign-in you have open, then start this one again." },
  );
}

/**
 * What a refused token exchange means, split by what the operator would do
 * about it.
 *
 * One message for all of them tells somebody whose authorization simply went
 * stale to go and re-register their integration, and tells somebody whose
 * integration really is misconfigured to try again in a minute.
 */
function tokenExchangeFailure(status: number, body: string): AuthFailure {
  if (/invalid_grant/.test(body)) {
    return new AuthFailure(
      "challenge-expired",
      `Notion refused the authorization code (HTTP ${status}).`,
      {
        remedy:
          "Start the connection again — an authorization code works once and expires within minutes.",
      },
    );
  }
  if (status === 401 || /invalid_client/.test(body)) {
    return new AuthFailure(
      "credential-rejected",
      `Notion refused this install's OAuth client (HTTP ${status}).`,
      {
        remedy:
          "Check the client ID and secret against the integration's configuration page, set them again, then retry.",
      },
    );
  }
  if (status >= 500) {
    return new AuthFailure(
      "unavailable",
      `Notion could not complete the token exchange (HTTP ${status}).`,
      {
        remedy: "Try again in a few minutes.",
      },
    );
  }
  return new AuthFailure("unknown", `Notion token exchange failed (HTTP ${status}): ${body}`);
}

interface NotionTokenResponse {
  access_token: string;
  refresh_token?: string;
  workspace_id: string;
  workspace_name: string;
  bot_id: string;
}

/** Trade the authorization code for the workspace's tokens. */
async function exchangeAuthorizationCode(
  creds: NotionCredentials,
  code: string,
  redirectUri: string,
): Promise<NotionTokenResponse> {
  const basicAuth = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString("base64");
  let response: Response;
  try {
    response = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch (err) {
    throw new AuthFailure(
      "unavailable",
      `Notion could not be reached to exchange the authorization code: ${describe(err)}`,
      { remedy: "Check this machine's network connection, then try again." },
    );
  }
  if (!response.ok) throw tokenExchangeFailure(response.status, await response.text());
  return (await response.json()) as NotionTokenResponse;
}

/**
 * Connect a Notion workspace.
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
  const title = "Authorize Omnesis in Notion";
  const instructions =
    "Sign in to Notion and choose the workspace to index, then approve the pages Omnesis may read.";

  let code: string;
  let redirectUri: string;

  if (session.publicBaseUrl) {
    redirectUri = gatewayRedirectUri(session.publicBaseUrl);
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
      url: buildAuthorizeUrl(creds, redirectUri, state),
    });
    assertMatchingState(answer.state, state);
    code = answer.code;
  } else {
    redirectUri = REDIRECT_URI;
    const state = randomUUID();
    const listener = await bindCallbackListener(state);
    try {
      const delivered = session.ask({
        kind: "redirect",
        via: "loopback",
        title,
        instructions,
        url: buildAuthorizeUrl(creds, redirectUri, state),
      });
      // Only one of these is awaited to completion, so the other's eventual
      // rejection needs a reader of its own or it surfaces as an unhandled
      // rejection long after this flow has moved on.
      void delivered.catch(() => {});
      void listener.result.catch(() => {});
      const answer: { code: string; state?: string } = await Promise.race([
        listener.result,
        delivered,
      ]);
      assertMatchingState(answer.state, state);
      code = answer.code;
    } finally {
      listener.close();
    }
  }

  session.show({ kind: "wait", title: "Finishing the Notion authorization" });
  const tokenData = await exchangeAuthorizationCode(creds, code, redirectUri);

  const tokens: NotionTokens = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    workspace_id: tokenData.workspace_id,
    workspace_name: tokenData.workspace_name,
    bot_id: tokenData.bot_id,
  };

  // Checked before anything is written. Notion authorizes whichever workspace
  // the browser is signed in to, so renewing one source's grant while another
  // workspace is signed in would mint tokens for that other workspace, store
  // them under a new account, and leave the source being repaired exactly as
  // broken as it was.
  if (
    session.reason === "reauthenticate" &&
    session.accountId &&
    tokens.workspace_id !== session.accountId
  ) {
    throw new AuthFailure(
      "identity-mismatch",
      `This authorization is for Notion workspace ${tokens.workspace_id}, not ${session.accountId}.`,
      {
        remedy:
          "Choose the original workspace on Notion's authorization screen, or add this one as a separate source instead of renewing that one.",
      },
    );
  }

  try {
    await saveTokens(tokens.workspace_id, tokens, configDir);
  } catch (err) {
    throw new CredentialPersistError("notion", tokens.workspace_id, err);
  }

  log.info(
    `Authenticated with Notion workspace "${tokens.workspace_name}" (${tokens.workspace_id})`,
  );
  return {
    accounts: [{ accountId: tokens.workspace_id, state: { status: "connected" } }],
  };
}

/** An unknown thrown value, as one line for an operator-facing message. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A bound loopback listener, and the authorization it is waiting for. */
interface CallbackListener {
  /** Resolves with the authorization code the browser brought back. */
  readonly result: Promise<{ code: string }>;
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
    let resolveResult: (value: { code: string }) => void;
    let rejectResult: (err: Error) => void;
    let settled = false;
    const result = new Promise<{ code: string }>((resolve, reject) => {
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
          log.warn("Rejected Notion OAuth callback with invalid state");
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
      resolveResult({ code: callback.code });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      // Every way this listener can fail to come up is something occupying a
      // port on this machine, which is local and fixable — the one code that
      // says so, rather than the untyped throw a client reads as not worth
      // retrying.
      const failure = new AuthFailure(
        "local-conflict",
        err.code === "EADDRINUSE"
          ? `Port ${OAUTH_CALLBACK_PORT} is already in use, so the Notion sign-in cannot be caught here.`
          : `The Notion sign-in listener could not bind ${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}: ${err.message}`,
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

/** What Notion reported on its own authorization screen. */
function authorizationError(error: string): AuthFailure {
  // `access_denied` is the operator saying no where they were asked. Repeating
  // the identical request to someone who just refused it is not a retry, which
  // is what `denied` encodes and `unknown` does not.
  return error === "access_denied"
    ? new AuthFailure("denied", "The Notion authorization was declined.", {
        remedy: "Start the connection again and approve the workspace you want indexed.",
      })
    : new AuthFailure("unknown", `Notion reported an authorization error: ${error}`);
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
    const { code } = await Promise.race([listener.result, expiry]);
    return code;
  } finally {
    if (timer) clearTimeout(timer);
    listener.close();
  }
}
