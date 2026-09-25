// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  clearProviderAccountAndLegacyCredentials,
  createLogger,
  CredentialPersistError,
  hasProviderAccountCredentials,
  hasProviderCredentials,
  listProviderAccountDirs,
  listProviderAccountIds,
  loadOrAdoptProviderAccountCredentials,
  MissingCredentialsError,
  writeProviderAccountCredentials,
} from "@omnesis/core";
import { AccountId, SyncError } from "@omnesis/types";
import { AuthFailure, credentialsChallenge } from "@omnesis/source-sdk";
import { GranolaClient } from "./client.js";
import { granolaCredentialsSpec } from "./credentials-spec.js";
import type {
  AuthFlowCallbacks,
  AuthResult,
  AuthSession,
  SourceLifecycleContext,
} from "@omnesis/source-sdk";

const log = createLogger("provider:granola");

const GRANOLA_FILE_KEY = "granola";

/**
 * Load one account's stored API key, adopting a pre-per-account shared file
 * when that is all this install has.
 */
export async function loadApiKey(accountId: string, configDir?: string): Promise<string> {
  const fields = await loadOrAdoptProviderAccountCredentials(
    GRANOLA_FILE_KEY,
    accountId,
    configDir,
  );
  if (!fields?.api_key) throw new MissingCredentialsError(GRANOLA_FILE_KEY, "Granola");
  return fields.api_key;
}

/** Whether this account's key is on disk. Offline — no network probe. */
export function hasCredentials(accountId: string, configDir?: string): boolean {
  if (hasProviderAccountCredentials(GRANOLA_FILE_KEY, accountId, configDir)) return true;
  // An install predating per-account storage: the shared file is this account's
  // key until the first read adopts it. Only while nothing has migrated — once
  // some account holds its own credential, an account without one has none.
  if (listProviderAccountIds(GRANOLA_FILE_KEY, configDir).length > 0) return false;
  return hasProviderCredentials(GRANOLA_FILE_KEY, configDir);
}

/**
 * Stable account id for a key. Granola issues one key per user, so the owner's
 * email is the natural identity; a workspace with no notes yet exposes no
 * owner, so fall back to a fingerprint of the key itself — two such keys are
 * two accounts, and a shared constant would collapse them into one.
 */
function deriveAccountId(
  apiKey: string,
  ownerEmail?: string,
): { accountId: AccountId; fromIdentity: boolean } {
  if (ownerEmail && ownerEmail.length > 0) {
    return { accountId: AccountId(ownerEmail), fromIdentity: true };
  }
  return {
    accountId: AccountId(
      `${KEY_FINGERPRINT_PREFIX}${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}`,
    ),
    fromIdentity: false,
  };
}

const KEY_FINGERPRINT_PREFIX = "granola-";

/**
 * Whether an account id is the key fingerprint `deriveAccountId` falls back to,
 * rather than an owner's email. Exact to that format — the prefix and twelve
 * hex digits — so an address that happens to start the same way is not
 * mistaken for one.
 */
export function isKeyFingerprintAccount(accountId: string): boolean {
  return new RegExp(`^${KEY_FINGERPRINT_PREFIX}[0-9a-f]{12}$`).test(accountId);
}

/**
 * Connect a Granola account.
 *
 * The key is asked for rather than handed in, which is what lets a
 * re-authentication offer a fresh one: a revoked key is the very thing that
 * stopped working, so a flow that could only re-present it had nothing to
 * offer but the same failure. Nothing is written until the probe succeeds, so
 * a key Granola will not accept leaves no trace.
 */
export async function authenticate(session: AuthSession): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const reauthAccountId = session.accountId;

  const challenge = credentialsChallenge(granolaCredentialsSpec, {
    title: reauthAccountId ? `Reconnect ${reauthAccountId}` : "Connect a Granola account",
    instructions:
      "In the Granola desktop app open Settings, then Connectors, then API keys, create a key " +
      "and paste it here. API access needs a Granola plan that includes the public API.",
  });

  // A client of the older shape collected the key on a wizard before the flow
  // started. Asking again would be asking twice; asking only when it is
  // absent is what makes both clients work from one code path.
  const suppliedKey = session.supplied.api_key?.trim();
  const answered = suppliedKey ? session.supplied : await session.ask(challenge);
  const apiKey = String(answered.api_key ?? "").trim();
  if (!apiKey) throw new MissingCredentialsError(GRANOLA_FILE_KEY, "Granola");

  session.show({ kind: "wait", title: "Checking the API key" });

  let ownerName: string | undefined;
  let ownerEmail: string | undefined;
  try {
    ({ ownerName, ownerEmail } = await new GranolaClient(apiKey).probe());
  } catch (err) {
    throw probeFailure(err);
  }
  const { accountId: derived, fromIdentity } = deriveAccountId(apiKey, ownerEmail);

  // A re-auth refreshes the account it was invoked for. Refuse a key that
  // belongs to somebody else: silently rebinding the account would point an
  // existing source at a different person's notes.
  // Only checkable when the id came from a real identity. A key-derived id is
  // a function of the key, so a rotated key never matches — enforcing it there
  // would make rotation impossible rather than catching a wrong account.
  if (fromIdentity && reauthAccountId && String(derived) !== reauthAccountId) {
    throw new AuthFailure(
      "identity-mismatch",
      `This API key belongs to Granola account ${derived}, not ${reauthAccountId}.`,
      { remedy: "Add it as a separate source instead of re-authenticating this one." },
    );
  }
  const accountId = reauthAccountId ? AccountId(reauthAccountId) : derived;

  try {
    await writeProviderAccountCredentials(
      GRANOLA_FILE_KEY,
      String(accountId),
      { api_key: apiKey },
      configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(GRANOLA_FILE_KEY, String(accountId), err);
  }
  log.info(
    `Authenticated with Granola as ${ownerName ?? ownerEmail ?? accountId} (account ${accountId})`,
  );
  return { accounts: [{ accountId: String(accountId), state: { status: "connected" } }] };
}

/**
 * What a failed probe means for the operator.
 *
 * Granola answers a bad key with 401 and a key whose workspace has no API
 * access with 403. Both are a credential presented and not acted on, and both
 * are `credential-rejected` rather than `denied` — nobody was asked anything —
 * and rather than `missing-credentials`, which is having nothing to present.
 * They differ only in the remedy: one is a new key, the other a plan that
 * includes the public API. Anything else is Granola being unreachable.
 */
function probeFailure(err: unknown): AuthFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SyncError) {
    if (err.kind === "auth") {
      return new AuthFailure("credential-rejected", message, {
        remedy:
          "Create a new key in the Granola desktop app under Settings, Connectors, API keys, " +
          "and paste that one.",
      });
    }
    if (err.kind === "permission") {
      return new AuthFailure("credential-rejected", message, {
        remedy:
          "The key is valid, but the public API is only available on a Granola plan that " +
          "includes it. Move the workspace to such a plan, then connect again.",
      });
    }
    if (err.kind === "network" || err.kind === "transient" || err.kind === "rate-limit") {
      return new AuthFailure("unavailable", message);
    }
  }
  return new AuthFailure("unknown", message);
}

/**
 * Validate a pasted API key against a liveness probe, resolve which account it
 * belongs to, and store it under that account. No browser leg — this is the
 * whole auth flow for an api-key source.
 *
 * The key arrives from the client for a new add and is read from disk for a
 * re-auth. Nothing is written until the probe succeeds, so a bad key leaves no
 * trace; and because the key is stored per account, adding a second Granola
 * account no longer overwrites the first.
 */
export async function authFlow(
  _params?: Record<string, string>,
  callbacks?: AuthFlowCallbacks,
  ctx?: SourceLifecycleContext,
): Promise<AccountId> {
  const configDir = ctx?.configDir;
  const reauthAccountId = callbacks?.accountId;
  const apiKey =
    callbacks?.credentials?.api_key ??
    (reauthAccountId
      ? (await loadOrAdoptProviderAccountCredentials(GRANOLA_FILE_KEY, reauthAccountId, configDir))
          ?.api_key
      : undefined);
  if (!apiKey) throw new MissingCredentialsError(GRANOLA_FILE_KEY, "Granola");

  const { ownerName, ownerEmail } = await new GranolaClient(apiKey).probe();
  const { accountId: derived, fromIdentity } = deriveAccountId(apiKey, ownerEmail);

  // A re-auth refreshes the account it was invoked for. Refuse a key that
  // belongs to somebody else: silently rebinding the account would point an
  // existing source at a different person's notes.
  // Only checkable when the id came from a real identity. A key-derived id is
  // a function of the key, so a rotated key never matches — enforcing it there
  // would make rotation impossible rather than catching a wrong account.
  if (fromIdentity && reauthAccountId && String(derived) !== reauthAccountId) {
    throw new Error(
      `This API key belongs to Granola account ${derived}, not ${reauthAccountId}. ` +
        `Add it as a separate source instead of re-authenticating this one.`,
    );
  }
  const accountId = reauthAccountId ? AccountId(reauthAccountId) : derived;

  try {
    await writeProviderAccountCredentials(
      GRANOLA_FILE_KEY,
      String(accountId),
      { api_key: apiKey },
      configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(GRANOLA_FILE_KEY, String(accountId), err);
  }
  log.info(
    `Authenticated with Granola as ${ownerName ?? ownerEmail ?? accountId} (account ${accountId})`,
  );
  return accountId;
}

/**
 * Resolve configured accounts offline — the provider-instantiation path derives
 * its instances from this alone, so it must never hit the network.
 *
 * The legacy fallback is load-bearing rather than defensive: an install
 * predating per-account storage has an empty account directory, so a
 * stored-credential-only predicate would return nothing, the provider would
 * never instantiate, its credential would never be adopted, and the source
 * would disappear with no way back.
 */
export function discoverAccounts(configDir?: string): AccountId[] {
  const stored = listProviderAccountIds(GRANOLA_FILE_KEY, configDir);
  if (stored.length > 0) return stored.map((id) => AccountId(id));
  if (!hasProviderCredentials(GRANOLA_FILE_KEY, configDir)) return [];
  return listProviderAccountDirs(GRANOLA_FILE_KEY, configDir).flatMap((name) => {
    try {
      return [AccountId(name)];
    } catch {
      return [];
    }
  });
}

export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await clearProviderAccountAndLegacyCredentials(GRANOLA_FILE_KEY, accountId, configDir);
  log.info(`Cleaned up Granola credentials for account ${accountId}`);
}
