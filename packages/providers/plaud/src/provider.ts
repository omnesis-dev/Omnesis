// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  clearProviderAccountCredentials,
  createLogger,
  CredentialPersistError,
  hasProviderAccountCredentials,
  listProviderAccountIds,
  readProviderAccountCredentials,
  writeProviderAccountCredentials,
} from "@omnesis/core";
import { AccountId, SyncError, tryAccountId } from "@omnesis/types";
import { AuthFailure, credentialsChallenge } from "@omnesis/source-sdk";
import { login, sendCode } from "./client.js";
import { plaudCredentialsSpec } from "./credentials-spec.js";
import { plaudApiBase } from "./hosts.js";
import type { AuthResult, AuthSession } from "@omnesis/source-sdk";
import type { PlaudHttpOptions, PlaudTokens } from "./client.js";

const log = createLogger("provider:plaud");

export const PLAUD_FILE_KEY = "plaud";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

const PLAUD_TERMS_URL = "https://www.plaud.ai/pages/plaud-terms-of-service";

/** One account's stored sign-in. */
export interface PlaudConnection {
  email: string;
  apiBase: string;
  tokens: PlaudTokens;
}

/** The fields a sign-in is stored as. */
export function connectionFields(connection: PlaudConnection): Record<string, string> {
  const { tokens } = connection;
  return {
    email: connection.email,
    api_base: connection.apiBase,
    access_token: tokens.accessToken,
    ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    ...(tokens.accessExpiresAt !== undefined
      ? { access_expires_at: String(tokens.accessExpiresAt) }
      : {}),
    ...(tokens.sessionExpiresAt !== undefined
      ? { session_expires_at: String(tokens.sessionExpiresAt) }
      : {}),
  };
}

/** Load one account's stored sign-in, or throw naming what is missing. */
export async function loadConnection(
  accountId: string,
  configDir?: string,
): Promise<PlaudConnection> {
  const fields = await readProviderAccountCredentials(PLAUD_FILE_KEY, accountId, configDir);
  const apiBase = fields?.api_base ? plaudApiBase(fields.api_base) : undefined;
  if (!fields?.access_token || !apiBase || !fields.email) {
    throw new SyncError(
      "auth",
      `No Plaud sign-in is stored for ${accountId}. Re-authenticate the source to sign in again.`,
      { scope: "connection" },
    );
  }
  const seconds = (v: string | undefined) => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const accessExpiresAt = seconds(fields.access_expires_at);
  const sessionExpiresAt = seconds(fields.session_expires_at);
  return {
    email: fields.email,
    apiBase,
    tokens: {
      accessToken: fields.access_token,
      ...(fields.refresh_token ? { refreshToken: fields.refresh_token } : {}),
      ...(accessExpiresAt !== undefined ? { accessExpiresAt } : {}),
      ...(sessionExpiresAt !== undefined ? { sessionExpiresAt } : {}),
    },
  };
}

/** Whether this account's sign-in is on disk. Offline — no network probe. */
export function hasCredentials(accountId: string, configDir?: string): boolean {
  return hasProviderAccountCredentials(PLAUD_FILE_KEY, accountId, configDir);
}

/**
 * Sign in to a Plaud account with the one-time code Plaud emails.
 *
 * A re-authentication signs the same address in again and asks only for the
 * code. Nothing is written until Plaud accepts the code, so a wrong one
 * leaves no trace.
 */
export async function authenticate(
  session: AuthSession,
  opts: PlaudHttpOptions = {},
): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const renewing = session.reason === "reauthenticate" ? session.accountId : undefined;

  let email = renewing ?? session.supplied.email?.trim();
  if (!email) {
    const answered = await session.ask(
      credentialsChallenge(plaudCredentialsSpec, {
        title: "Connect a Plaud account",
        instructions:
          "Enter the email address of your Plaud account. Plaud emails a code to it. Accounts " +
          "created with Google or Apple sign-in have no emailed code and cannot be connected. " +
          "Using this source is subject to the Plaud Terms of Service " +
          `(${PLAUD_TERMS_URL}); it is your responsibility to read and follow them.`,
      }),
    );
    email = String(answered.email ?? "").trim();
  }
  email = email.toLowerCase();
  const accountId = tryAccountId(email);
  if (!EMAIL_PATTERN.test(email) || !accountId) {
    throw new AuthFailure("credential-rejected", `"${email}" is not an email address.`, {
      remedy: "Enter the address you sign in to Plaud with.",
    });
  }

  session.show({ kind: "wait", title: "Asking Plaud to email a code" });
  let otp: { otpToken: string; apiBase: string };
  try {
    otp = await sendCode(email, opts);
  } catch (err) {
    throw failure(err, {
      remedy:
        "Check the address. An account created with Google or Apple sign-in has no emailed " +
        "code and cannot be connected.",
    });
  }

  const { code } = await session.ask({
    kind: "code",
    title: "Enter the code Plaud emailed you",
    instructions: `Plaud sent a code to ${email}. It can take a minute to arrive.`,
    pattern: "^\\s*\\S+\\s*$",
    patternHint: "The code from Plaud's email",
  });

  session.show({ kind: "wait", title: "Signing in to Plaud" });
  let tokens: PlaudTokens;
  try {
    tokens = await login(otp.apiBase, code.trim(), otp.otpToken, opts);
  } catch (err) {
    throw failure(err, { remedy: "Start again to have Plaud email a new code." });
  }

  try {
    await writeProviderAccountCredentials(
      PLAUD_FILE_KEY,
      String(accountId),
      connectionFields({ email, apiBase: otp.apiBase, tokens }),
      configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(PLAUD_FILE_KEY, String(accountId), err);
  }
  log.info(`Signed in to Plaud as ${accountId} on ${new URL(otp.apiBase).host}`);
  return { accounts: [{ accountId: String(accountId), state: { status: "connected" } }] };
}

/** What a failed sign-in step means for the operator. */
function failure(err: unknown, onRejected: { remedy: string }): AuthFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SyncError) {
    if (err.kind === "auth" || err.kind === "permission") {
      return new AuthFailure("credential-rejected", message, onRejected);
    }
    if (err.kind === "network" || err.kind === "transient" || err.kind === "rate-limit") {
      return new AuthFailure("unavailable", message, {
        remedy: "Plaud could not be reached. Try again in a few minutes.",
      });
    }
  }
  return new AuthFailure("unknown", message);
}

/**
 * Resolve configured accounts offline — the provider-instantiation path
 * derives its instances from this alone, so it must never hit the network.
 */
export function discoverAccounts(configDir?: string): AccountId[] {
  return listProviderAccountIds(PLAUD_FILE_KEY, configDir).map((id) => AccountId(id));
}

export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await clearProviderAccountCredentials(PLAUD_FILE_KEY, accountId, configDir);
  log.info(`Cleaned up Plaud credentials for account ${accountId}`);
}
