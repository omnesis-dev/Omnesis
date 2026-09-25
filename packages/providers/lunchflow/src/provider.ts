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
import { LunchflowClient } from "./client.js";
import { lunchflowCredentialsSpec } from "./credentials-spec.js";
import type {
  AuthFlowCallbacks,
  AuthResult,
  AuthSession,
  SourceLifecycleContext,
} from "@omnesis/source-sdk";

const log = createLogger("provider:lunchflow");

const LUNCHFLOW_FILE_KEY = "lunchflow";

/**
 * The account id every install used before Lunch Flow supported more than one
 * connection. Kept so an existing source keeps resolving; new connections get
 * a key-derived id instead.
 */
export const LUNCHFLOW_ACCOUNT_ID = "default";

/** Optional injection points for tests (probe transport). */
export interface AuthFlowDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * Stable account id for a key.
 *
 * Derived from the key rather than from the banks it reaches: an id built from
 * the connected `accounts[].id` set would change whenever the user connects or
 * disconnects a bank, orphaning the source at the next `discover()`. Lunch Flow
 * exposes no user identity endpoint, so the key itself is the only stable
 * handle — hashed, never stored raw in a path.
 */
export function deriveAccountId(apiKey: string): AccountId {
  return AccountId(`lunchflow-${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}`);
}

/**
 * Load one account's stored API key, adopting a pre-per-account shared file
 * when that is all this install has.
 */
export async function loadApiKey(accountId: string, configDir?: string): Promise<string> {
  const fields = await loadOrAdoptProviderAccountCredentials(
    LUNCHFLOW_FILE_KEY,
    accountId,
    configDir,
  );
  if (!fields?.api_key) throw new MissingCredentialsError(LUNCHFLOW_FILE_KEY, "Lunch Flow");
  return fields.api_key;
}

/** Whether this account's key is on disk — offline, no network probe. */
export function hasCredentials(accountId: string, configDir?: string): boolean {
  if (hasProviderAccountCredentials(LUNCHFLOW_FILE_KEY, accountId, configDir)) return true;
  // An install predating per-account storage: the shared file is this account's
  // key until the first read adopts it. Only while nothing has migrated — once
  // some account holds its own credential, an account without one has none.
  if (listProviderAccountIds(LUNCHFLOW_FILE_KEY, configDir).length > 0) return false;
  return hasProviderCredentials(LUNCHFLOW_FILE_KEY, configDir);
}

/**
 * Connect a Lunch Flow API destination.
 *
 * The key is asked for rather than handed in, which is what lets a renewal
 * offer a fresh one: a revoked key is the thing that stopped working, so a
 * flow that could only re-present it had nothing to offer but the same
 * failure.
 *
 * The overlap refusal below is not politeness — it prevents data loss. The
 * transactions table is keyed on the Lunch Flow *bank account* id, and the
 * upsert rewrites every non-key column including the discriminator recording
 * which Omnesis account owns a row. Two connections covering one bank would
 * therefore overwrite each other's ownership, and removing either would delete
 * history belonging to the other. Lunch Flow exposes no user identity to
 * compare, so the overlap is detected directly, by probing what each key can
 * see.
 */
export function authenticate(session: AuthSession): Promise<AuthResult> {
  return authenticateWith(session, {});
}

/** {@link authenticate}, with the probe transport its tests substitute. */
export async function authenticateWith(
  session: AuthSession,
  deps: AuthFlowDeps = {},
): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const reauthAccountId = session.accountId;

  const challenge = credentialsChallenge(lunchflowCredentialsSpec, {
    title: reauthAccountId ? "Reconnect this Lunch Flow connection" : "Connect Lunch Flow",
    instructions:
      "In Lunch Flow open Destinations, create an API destination, and paste the key it " +
      "generates. Omnesis reads your accounts through it and never writes.",
  });

  // A client of the older shape collected the key on a wizard before the flow
  // started. Asking again would be asking twice; asking only when it is
  // absent is what makes both clients work from one code path.
  const suppliedKey = session.supplied.api_key?.trim();
  const answered = suppliedKey ? session.supplied : await session.ask(challenge);
  const apiKey = String(answered.api_key ?? "").trim();
  if (!apiKey) throw new MissingCredentialsError(LUNCHFLOW_FILE_KEY, "Lunch Flow");

  session.show({ kind: "wait", title: "Checking the API key" });
  const client = new LunchflowClient({ apiKey, fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });
  let accounts;
  try {
    accounts = await client.listAccounts();
  } catch (err) {
    throw probeFailure(err);
  }
  const accountId = reauthAccountId ? AccountId(reauthAccountId) : deriveAccountId(apiKey);

  // Only on a first connection. A renewed key covers the banks the key it
  // replaces covered, so running the check on a renewal would refuse every
  // renewal against its own account.
  if (!reauthAccountId) {
    const clash = await findOverlappingAccount(
      new Set(accounts.map((a) => String(a.id))),
      configDir,
      deps,
    );
    if (clash) {
      throw new AuthFailure(
        "duplicate",
        `This API key covers bank accounts already connected under ${clash}.`,
        {
          remedy:
            "Connecting the same banks twice would make the two sources overwrite each " +
            "other's data. Use a Lunch Flow API destination covering different banks, or " +
            "remove the existing connection first.",
        },
      );
    }
  }

  try {
    await writeProviderAccountCredentials(
      LUNCHFLOW_FILE_KEY,
      String(accountId),
      { api_key: apiKey },
      configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(LUNCHFLOW_FILE_KEY, String(accountId), err);
  }
  log.info(
    `Authenticated with Lunch Flow — account ${accountId}, ${accounts.length} connected bank account(s)`,
  );
  return { accounts: [{ accountId: String(accountId), state: { status: "connected" } }] };
}

/**
 * What a failed probe means for the operator.
 *
 * Lunch Flow answers both a missing key and a revoked one with 401 or 403 and
 * one message, so the two cannot be told apart here — and they need not be:
 * either way a credential was presented and not acted on, which is
 * `credential-rejected` rather than `denied`, since nobody was asked anything.
 * Everything else is Lunch Flow being unreachable.
 */
function probeFailure(err: unknown): AuthFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SyncError) {
    if (err.kind === "auth") {
      return new AuthFailure("credential-rejected", message, {
        remedy:
          "Open Destinations in Lunch Flow, create a fresh API destination, and paste its key.",
      });
    }
    if (err.kind === "network" || err.kind === "transient" || err.kind === "rate-limit") {
      return new AuthFailure("unavailable", message);
    }
  }
  return new AuthFailure("unknown", message);
}

/**
 * Validate a pasted API key, refuse it if it covers banks another connection
 * already syncs, and store it under its own account.
 *
 * The overlap check is not politeness — it prevents data loss. The transactions
 * table is keyed on the Lunch Flow *bank account* id, and the upsert rewrites
 * every non-key column including the discriminator that records which Omnesis
 * account owns a row. Two connections covering one bank would therefore
 * overwrite each other's ownership, and removing either would delete history
 * belonging to the other. Lunch Flow exposes no user identity to compare, so
 * the overlap is detected directly, by probing what each key can see.
 */
export async function authFlow(
  _params?: Record<string, string>,
  callbacks?: AuthFlowCallbacks,
  ctx?: SourceLifecycleContext,
  deps: AuthFlowDeps = {},
): Promise<AccountId> {
  const configDir = ctx?.configDir;
  const reauthAccountId = callbacks?.accountId;
  const apiKey =
    callbacks?.credentials?.api_key ??
    (reauthAccountId ? await loadApiKey(reauthAccountId, configDir) : undefined);
  if (!apiKey) throw new MissingCredentialsError(LUNCHFLOW_FILE_KEY, "Lunch Flow");

  const client = new LunchflowClient({ apiKey, fetchImpl: deps.fetchImpl, baseUrl: deps.baseUrl });
  const accounts = await client.listAccounts();
  const accountId = reauthAccountId ? AccountId(reauthAccountId) : deriveAccountId(apiKey);

  if (!reauthAccountId) {
    const clash = await findOverlappingAccount(
      new Set(accounts.map((a) => String(a.id))),
      configDir,
      deps,
    );
    if (clash) {
      throw new Error(
        `This API key covers bank accounts already connected under ${clash}. ` +
          `Connecting them twice would make the two sources overwrite each other's data.`,
      );
    }
  }

  try {
    await writeProviderAccountCredentials(
      LUNCHFLOW_FILE_KEY,
      String(accountId),
      { api_key: apiKey },
      configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(LUNCHFLOW_FILE_KEY, String(accountId), err);
  }
  log.info(
    `Authenticated with Lunch Flow — account ${accountId}, ${accounts.length} connected bank account(s)`,
  );
  return accountId;
}

/**
 * The existing account whose key reaches any of `bankAccountIds`, or `null`.
 *
 * A sibling whose own probe fails is skipped rather than treated as
 * non-overlapping: a revoked or rate-limited key says nothing about which banks
 * it covers, and blocking an add on it would be worse than the collision it is
 * guarding against.
 */
async function findOverlappingAccount(
  bankAccountIds: Set<string>,
  configDir?: string,
  deps: AuthFlowDeps = {},
): Promise<string | null> {
  // By DIRECTORY, not by stored credential: on an install that has not adopted
  // yet the existing connection holds no per-account file, and skipping it
  // would wave through exactly the overlap this guard exists to catch.
  for (const existing of listProviderAccountDirs(LUNCHFLOW_FILE_KEY, configDir)) {
    try {
      const key = await loadApiKey(existing, configDir);
      const client = new LunchflowClient({
        apiKey: key,
        fetchImpl: deps.fetchImpl,
        baseUrl: deps.baseUrl,
      });
      for (const account of await client.listAccounts()) {
        if (bankAccountIds.has(String(account.id))) return existing;
      }
    } catch (err) {
      log.warn(
        `Could not check Lunch Flow account ${existing} for overlap: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return null;
}

/**
 * Resolve configured accounts offline — the provider-instantiation path derives
 * its instances from this alone, so it must never hit the network.
 *
 * The legacy branch keeps a pre-per-account install alive: its account
 * directory holds no credential yet, and returning nothing would stop the
 * provider instantiating, which is what performs the adoption.
 */
export function discoverAccounts(configDir?: string): AccountId[] {
  const stored = listProviderAccountIds(LUNCHFLOW_FILE_KEY, configDir);
  if (stored.length > 0) return stored.map((id) => AccountId(id));
  if (!hasProviderCredentials(LUNCHFLOW_FILE_KEY, configDir)) return [];
  const dirs = listProviderAccountDirs(LUNCHFLOW_FILE_KEY, configDir).flatMap((name) => {
    try {
      return [AccountId(name)];
    } catch {
      return [];
    }
  });
  // A shared file with no account directory at all is an install that has the
  // key but never recorded which account it belongs to.
  return dirs.length > 0 ? dirs : [AccountId(LUNCHFLOW_ACCOUNT_ID)];
}

export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await clearProviderAccountAndLegacyCredentials(LUNCHFLOW_FILE_KEY, accountId, configDir);
  log.info(`Cleaned up Lunch Flow credentials for account ${accountId}`);
}
