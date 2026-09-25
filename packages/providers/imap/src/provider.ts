// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  clearProviderAccountCredentials,
  createLogger,
  CredentialPersistError,
  hasProviderAccountCredentials,
  listProviderAccountIds,
  readProviderAccountCredentials,
  MissingCredentialsError,
  writeProviderAccountCredentials,
} from "@omnesis/core";
import { AccountId, SyncError } from "@omnesis/types";
import { AuthFailure, credentialsChallenge } from "@omnesis/source-sdk";
import { createImapClient } from "./client.js";
import { imapCredentialsSpec } from "./credentials-spec.js";
import type {
  AuthFlowCallbacks,
  AuthResult,
  AuthSession,
  SourceLifecycleContext,
} from "@omnesis/source-sdk";
import type { ImapConnectionCredentials } from "./client.js";

const log = createLogger("provider:imap");
const FILE_KEY = "imap";
const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface StoredImapCredentials extends Record<string, string> {
  host: string;
  username: string;
  app_password: string;
}

export async function authFlow(
  _params?: Record<string, string>,
  callbacks?: AuthFlowCallbacks,
  ctx?: SourceLifecycleContext,
): Promise<AccountId> {
  const supplied = callbacks?.credentials;
  const fields =
    supplied ??
    (callbacks?.accountId
      ? await readProviderAccountCredentials(FILE_KEY, callbacks.accountId, ctx?.configDir)
      : null);
  if (!fields) throw new MissingCredentialsError(FILE_KEY, "IMAP");
  const stored = validateCredentials({
    host: fields.host,
    username: fields.username,
    app_password: fields.app_password,
  });
  const accountId = AccountId(stored.username);
  if (callbacks?.accountId && callbacks.accountId !== accountId) {
    throw new Error(
      `These credentials belong to ${accountId}, not ${callbacks.accountId}. Add them as a separate IMAP account.`,
    );
  }

  const client = createImapClient(toConnectionCredentials(stored));
  try {
    await client.connect();
  } catch (error) {
    // A renewal on this entry point arrives with no fields: the client asks
    // for none, so the stored password is revalidated, and when the stored
    // password is the thing that stopped working there is no way to offer a
    // new one. Reporting it as a missing credential is what opens the wizard
    // that collects a replacement.
    //
    // The typed entry point does not do this and must not: it asks directly,
    // so laundering a refusal into an absence there would send an operator to
    // a wizard for a credential they had just typed.
    if (!supplied && error instanceof SyncError && error.kind === "auth") {
      throw new MissingCredentialsError(FILE_KEY, "IMAP");
    }
    throw error;
  } finally {
    try {
      await client.close();
    } catch {
      log.warn("Failed to close IMAP authentication connection");
    }
  }

  if (supplied) {
    try {
      await writeProviderAccountCredentials(FILE_KEY, accountId, stored, ctx?.configDir);
    } catch (error) {
      throw new CredentialPersistError(FILE_KEY, accountId, error);
    }
  }
  log.info("Authenticated IMAP account");
  return accountId;
}

/**
 * Connect an IMAP mailbox.
 *
 * The hostname, the address and the password are one question: none of the
 * three is a source setting. The hostname is how the connection is made, and
 * the address is both the login and this account's identity, so a form that
 * held either of them would be holding part of the credential.
 *
 * A renewal starts from what is stored and lets all of it be edited, because
 * the repair an operator comes here for is as often a hostname their provider
 * moved as a password their provider revoked. The address is still checked
 * against the account being renewed: a different mailbox is a different
 * account, not a new credential for this one.
 *
 * Nothing is written until the login succeeds, so credentials the server will
 * not accept leave no trace.
 */
export async function authenticate(session: AuthSession): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const reauthAccountId = session.accountId;
  const existing = reauthAccountId
    ? await readProviderAccountCredentials(FILE_KEY, reauthAccountId, configDir)
    : null;

  const challenge = credentialsChallenge(imapCredentialsSpec, {
    title: reauthAccountId ? `Reconnect ${reauthAccountId}` : "Connect an IMAP account",
    instructions:
      "Omnesis connects with TLS on port 993. Use an app-specific password when your mail " +
      "provider offers one.",
  });
  if (existing) {
    challenge.prefill = {
      ...(existing.host ? { host: existing.host } : {}),
      ...(existing.username ? { username: existing.username } : {}),
    };
  }

  // A client of the older shape collected all three fields on a wizard before
  // the flow started. Asking again would be asking twice; asking only when
  // something is missing is what makes both clients work from one code path.
  const answered = isCompleteTriple(session.supplied)
    ? session.supplied
    : await session.ask(challenge);

  let next: StoredImapCredentials;
  try {
    next = validateCredentials({
      host: answered.host,
      username: answered.username,
      app_password: answered.app_password,
    });
  } catch (error) {
    throw new AuthFailure(
      "credential-rejected",
      error instanceof Error ? error.message : String(error),
      { remedy: "Check the hostname, the full email address and the password, then try again." },
    );
  }

  const accountId = AccountId(next.username);
  // Before the server is contacted: a mailbox that is not the one being
  // renewed is refused whether or not its password happens to work.
  if (reauthAccountId && reauthAccountId !== String(accountId)) {
    throw new AuthFailure(
      "identity-mismatch",
      `These credentials belong to ${accountId}, not ${reauthAccountId}.`,
      { remedy: "Add them as a separate IMAP account instead of re-authenticating this one." },
    );
  }

  session.show({ kind: "wait", title: "Checking the connection" });
  const client = createImapClient(toConnectionCredentials(next));
  try {
    await client.connect();
  } catch (error) {
    throw connectFailure(error, next.host);
  } finally {
    try {
      await client.close();
    } catch {
      log.warn("Failed to close IMAP authentication connection");
    }
  }

  // A revalidation that changed nothing must not rewrite the secret: storing
  // it goes through the keyring, and re-encrypting the same three values buys
  // nothing. Decided by comparing what is stored with what will be stored, so
  // that a pasted value identical to the stored one is the no-op it is.
  const unchanged =
    existing !== null &&
    existing.host === next.host &&
    existing.username === next.username &&
    existing.app_password === next.app_password;
  if (!unchanged) {
    try {
      await writeProviderAccountCredentials(FILE_KEY, String(accountId), next, configDir);
    } catch (error) {
      throw new CredentialPersistError(FILE_KEY, String(accountId), error);
    }
  }
  log.info("Authenticated IMAP account");
  return { accounts: [{ accountId: String(accountId), state: { status: "connected" } }] };
}

/** Whether a client already collected every field this flow would ask for. */
function isCompleteTriple(values: Readonly<Record<string, string>>): boolean {
  return ["host", "username", "app_password"].every((name) => (values[name] ?? "").trim() !== "");
}

/**
 * Certificate problems, as OpenSSL and Node name them.
 *
 * Kept apart from an unreachable server because waiting will not clear one: a
 * name the certificate does not cover, or an issuer this machine has no reason
 * to believe, stays wrong until the hostname or the server changes.
 */
const TLS_TRUST_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** The trust-failure code somewhere in an error's cause chain, if there is one. */
function tlsTrustCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && TLS_TRUST_CODES.has(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

/**
 * Why the login did not happen, in the vocabulary a client acts on.
 *
 * The credential rejection and the unreachable server arrive already
 * classified. A certificate this machine will not trust does not: it is a
 * plain transport error, and left alone it reaches the operator as the
 * library's own text about issuers and chains. It is named here, with the
 * hostname it is about, because the hostname is usually the thing to fix.
 */
function connectFailure(error: unknown, host: string): AuthFailure {
  if (error instanceof SyncError) {
    if (error.kind === "auth") {
      return new AuthFailure("credential-rejected", error.message, {
        remedy:
          "Paste a current password for this mailbox — an app-specific password when your mail " +
          "provider issues them.",
      });
    }
    if (error.kind === "network" || error.kind === "transient") {
      return new AuthFailure("unavailable", error.message);
    }
  }
  const trustCode = tlsTrustCode(error);
  if (trustCode) {
    return new AuthFailure(
      "insecure-connection",
      `The certificate ${host} presented could not be verified (${trustCode}).`,
      {
        remedy:
          "Check the hostname against the one your mail provider publishes for TLS IMAP. " +
          "Omnesis will not connect to a server whose certificate it cannot verify.",
      },
    );
  }
  return new AuthFailure("unknown", error instanceof Error ? error.message : String(error));
}

export function discoverAccounts(configDir?: string): AccountId[] {
  return listProviderAccountIds(FILE_KEY, configDir).flatMap((value) => {
    try {
      return [AccountId(value)];
    } catch {
      return [];
    }
  });
}

export function hasCredentials(accountId: string, configDir?: string): boolean {
  return hasProviderAccountCredentials(FILE_KEY, accountId, configDir);
}

export async function loadCredentials(
  accountId: string,
  configDir?: string,
): Promise<ImapConnectionCredentials> {
  const fields = await readProviderAccountCredentials(FILE_KEY, accountId, configDir);
  if (!fields) throw new MissingCredentialsError(FILE_KEY, "IMAP");
  const stored = validateCredentials({
    host: fields.host,
    username: fields.username,
    app_password: fields.app_password,
  });
  if (stored.username !== accountId) {
    throw new Error(`Stored IMAP username does not match account ${accountId}`);
  }
  return toConnectionCredentials(stored);
}

export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await clearProviderAccountCredentials(FILE_KEY, accountId, configDir);
}

function validateCredentials(fields: {
  host?: string;
  username?: string;
  app_password?: string;
}): StoredImapCredentials {
  const host = fields.host?.trim().toLowerCase() ?? "";
  const username = fields.username?.trim().toLowerCase() ?? "";
  const appPassword = fields.app_password?.trim() ?? "";
  if (!HOST_PATTERN.test(host)) throw new Error("Enter a valid IMAP hostname");
  if (username.length > 320 || !EMAIL_PATTERN.test(username)) {
    throw new Error("Enter a valid email address as IMAP username");
  }
  if (!appPassword || appPassword.length > 1024) throw new Error("Enter a valid IMAP password");
  return { host, username, app_password: appPassword };
}

function toConnectionCredentials(stored: StoredImapCredentials): ImapConnectionCredentials {
  return { host: stored.host, username: stored.username, password: stored.app_password };
}
