// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  clearProviderAccountCredentials,
  createLogger,
  CredentialPersistError,
  hasProviderAccountCredentials,
  listProviderAccountIds,
  readProviderAccountCredentials,
  tlsErrorCode,
  writeProviderAccountCredentials,
} from "@omnesis/core";
import { AccountId, SyncError, tryAccountId } from "@omnesis/types";
import { AuthFailure, credentialsChallenge } from "@omnesis/source-sdk";
import { normalizeBaseUrl, PaperlessClient } from "./client.js";
import { paperlessCredentialsSpec } from "./credentials-spec.js";
import type { AuthResult, AuthSession } from "@omnesis/source-sdk";

const log = createLogger("provider:paperless");

export const PAPERLESS_FILE_KEY = "paperless";

/** One account's stored connection. */
export interface PaperlessConnection {
  baseUrl: string;
  token: string;
}

/** Load one account's stored connection, or throw naming what is missing. */
export async function loadConnection(
  accountId: string,
  configDir?: string,
): Promise<PaperlessConnection> {
  const fields = await readProviderAccountCredentials(PAPERLESS_FILE_KEY, accountId, configDir);
  const baseUrl = fields?.base_url ? normalizeBaseUrl(fields.base_url) : undefined;
  if (!baseUrl || !fields?.api_token) {
    throw new Error(
      `No Paperless-ngx address and API token are stored for ${accountId}. Re-authenticate the source to enter them again.`,
    );
  }
  return { baseUrl, token: fields.api_token };
}

/** Whether this account's connection is on disk. Offline — no network probe. */
export function hasCredentials(accountId: string, configDir?: string): boolean {
  return hasProviderAccountCredentials(PAPERLESS_FILE_KEY, accountId, configDir);
}

/**
 * Stable account id for a Paperless user on one instance:
 * `<username>@<host>[+<port>][~<path segment>…]`, such as
 * `maya@paperless.example.com+8000` or `maya@nas.example.com~paperless`.
 *
 * The username alone would collapse two instances (home and office, say)
 * that both have a user called `admin`, so the instance's address is part of
 * the id. An account id may not carry colons or slashes, so the port and the
 * path get separators a hostname never contains, and an IPv6 literal's
 * colons become underscores. Returns `null` when no valid id can be made —
 * a username past the length an id allows.
 */
export function deriveAccountId(username: string, baseUrl: string): AccountId | null {
  const url = new URL(baseUrl);
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/:/g, "_")
    .toLowerCase();
  const port = url.port ? `+${url.port}` : "";
  const path = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => `~${segment}`)
    .join("");
  // Remote-user and single-sign-on logins can produce names Django's own
  // validator would not, such as `CORP\maya`.
  const user = username.replace(/[\s:/\\\p{Cc}]/gu, "_");
  return tryAccountId(`${user}@${host}${port}${path}`);
}

/**
 * Connect a Paperless-ngx account.
 *
 * The address and the token are asked for rather than handed in, which is
 * what lets a re-authentication offer a fresh token after the old one was
 * regenerated. Nothing is written until the instance accepts the token, so
 * an address or token Paperless-ngx will not accept leaves no trace.
 */
export async function authenticate(
  session: AuthSession,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const reauthAccountId = session.accountId;

  const challenge = credentialsChallenge(paperlessCredentialsSpec, {
    title: reauthAccountId ? `Reconnect ${reauthAccountId}` : "Connect Paperless-ngx",
    instructions:
      "In Paperless-ngx open the user menu, then My Profile, and create or copy the API auth " +
      "token. Enter the address you open Paperless-ngx at, including any path it is served under. " +
      "A user with only the View permission is enough, including on UI settings: Omnesis only reads.",
  });

  const supplied =
    session.supplied.base_url?.trim() && session.supplied.api_token?.trim()
      ? session.supplied
      : undefined;
  const answered = supplied ?? (await session.ask(challenge));
  const rawUrl = String(answered.base_url ?? "").trim();
  const token = String(answered.api_token ?? "").trim();
  if (!rawUrl || !token) {
    throw new AuthFailure("credential-rejected", "Both the address and the API token are needed.", {
      remedy: "Enter the address you open Paperless-ngx at and the token from My Profile.",
    });
  }
  const baseUrl = normalizeBaseUrl(rawUrl);
  if (!baseUrl) {
    throw new AuthFailure("credential-rejected", `"${rawUrl}" is not an http or https address.`, {
      remedy:
        "Enter the address you open Paperless-ngx at, for example http://paperless.local:8000.",
    });
  }

  session.show({ kind: "wait", title: "Checking the token" });

  let username: string;
  try {
    ({ username } = await new PaperlessClient(baseUrl, token, opts).whoami());
  } catch (err) {
    throw probeFailure(err);
  }
  const derived = deriveAccountId(username, baseUrl);
  if (!derived) {
    throw new AuthFailure(
      "unsupported",
      `Omnesis cannot name an account for the Paperless-ngx user ${username}: the name is too long.`,
      { remedy: "Connect with a token belonging to a user with a shorter name." },
    );
  }

  // A re-auth renews the account it was invoked for: the same user on the
  // same instance. Anything else is someone else's documents, or the same
  // name on another instance — Paperless has no instance identity to tell a
  // moved server from a different one, and accepting the wrong one would
  // replace this source's archive with the other. Refused rather than
  // silently rebinding the source. The message names the derived account,
  // not the address: the collector masks every value the operator typed.
  const renewing = session.reason === "reauthenticate" ? reauthAccountId : undefined;
  if (renewing && String(derived) !== renewing) {
    throw new AuthFailure(
      "identity-mismatch",
      `This token belongs to the account ${derived}, not ${renewing}.`,
      {
        remedy:
          "Re-authenticate with the same user and address. To move to another address or user, add it as a separate source and remove this one.",
      },
    );
  }
  const accountId = derived;
  if (!renewing) await refuseNameCollision(accountId, baseUrl, configDir);

  try {
    await writeProviderAccountCredentials(
      PAPERLESS_FILE_KEY,
      String(accountId),
      { base_url: baseUrl, api_token: token },
      configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(PAPERLESS_FILE_KEY, String(accountId), err);
  }
  log.info(`Authenticated with Paperless-ngx at ${baseUrl} as ${username} (account ${accountId})`);
  return { accounts: [{ accountId: String(accountId), state: { status: "connected" } }] };
}

/**
 * What a failed probe means for the operator. A 401 is the token; a 403 is a
 * token whose user may not read the API; an unreachable address or a server
 * error may clear on its own; anything else (a 404, an answer that is not
 * Paperless-ngx) is almost always the address.
 */
function probeFailure(err: unknown): AuthFailure {
  const message = err instanceof Error ? err.message : String(err);
  // A certificate this host cannot verify will not clear by waiting.
  if (tlsErrorCode(err)) {
    return new AuthFailure("insecure-connection", message, {
      remedy:
        "Give Paperless-ngx a certificate from a public authority, or add the authority that signed it to NODE_EXTRA_CA_CERTS for the collector.",
    });
  }
  if (err instanceof SyncError) {
    if (err.kind === "auth") {
      return new AuthFailure("credential-rejected", message, {
        remedy:
          "Copy the token again from My Profile in Paperless-ngx; regenerating it replaces the old one.",
      });
    }
    if (err.kind === "permission") {
      return new AuthFailure("credential-rejected", message, {
        remedy:
          "Give the Paperless-ngx user the View permission on documents, tags, correspondents, document types, custom fields and UI settings.",
      });
    }
    if (err.kind === "network" || err.kind === "transient" || err.kind === "rate-limit") {
      return new AuthFailure("unavailable", message, {
        remedy: "Check that this collector can reach the address, then try again.",
      });
    }
    return new AuthFailure("credential-rejected", message, {
      remedy: "Check the address, including any path Paperless-ngx is served under.",
    });
  }
  return new AuthFailure("unknown", message);
}

/**
 * Refuse a new connection whose account id already names a stored connection
 * to a different address: writing it would point the existing source at
 * another archive. The same address is the same connection, connected again.
 */
async function refuseNameCollision(
  accountId: AccountId,
  baseUrl: string,
  configDir: string | undefined,
): Promise<void> {
  const stored = await readProviderAccountCredentials(
    PAPERLESS_FILE_KEY,
    String(accountId),
    configDir,
  ).catch(() => null);
  const storedUrl = stored?.base_url ? normalizeBaseUrl(stored.base_url) : undefined;
  if (storedUrl && storedUrl !== baseUrl) {
    throw new AuthFailure(
      "duplicate",
      `The account ${accountId} is already connected to Paperless-ngx at ${storedUrl}.`,
      { remedy: "Remove that source first, or connect with a different user." },
    );
  }
}

/**
 * Resolve configured accounts offline — the provider-instantiation path
 * derives its instances from this alone, so it must never hit the network.
 */
export function discoverAccounts(configDir?: string): AccountId[] {
  return listProviderAccountIds(PAPERLESS_FILE_KEY, configDir).map((id) => AccountId(id));
}

export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await clearProviderAccountCredentials(PAPERLESS_FILE_KEY, accountId, configDir);
  log.info(`Cleaned up Paperless-ngx credentials for account ${accountId}`);
}
