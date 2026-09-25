// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Coinbase api-key auth + account identity.
 *
 * There is no browser leg: the pasted CDP key id + private key ARE the
 * per-account credential. `authFlow()` validates them against a liveness probe
 * (`GET /accounts?limit=1` + `GET /key_permissions`), asserts the key is
 * read-only (refuses any key that can trade or transfer), derives the stable
 * account id from the `retail_portfolio_id`, and stores the key under that
 * account so a second portfolio can be connected without displacing the
 * first.
 */

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
import { CoinbaseClient, COINBASE_API_HOST, COINBASE_BROKERAGE_BASE } from "./client.js";
import { coinbaseCredentialsSpec } from "./credentials-spec.js";
import { signCoinbaseJwt } from "./jwt.js";
import type {
  AuthFlowCallbacks,
  AuthResult,
  AuthSession,
  SourceLifecycleContext,
} from "@omnesis/source-sdk";
import type { CoinbaseClientOptions } from "./client.js";
import type { CoinbaseCredentials, CoinbaseKeyPermissions } from "./types.js";

const log = createLogger("provider:coinbase");

const COINBASE_FILE_KEY = "coinbase";

/**
 * Load one account's stored CDP credentials, adopting a pre-per-account shared
 * file when that is all this install has.
 */
export async function loadCredentials(
  accountId: string,
  configDir?: string,
): Promise<CoinbaseCredentials> {
  const fields = await loadOrAdoptProviderAccountCredentials(
    COINBASE_FILE_KEY,
    accountId,
    configDir,
  );
  if (!fields?.key_id || !fields.private_key) {
    throw new MissingCredentialsError(COINBASE_FILE_KEY, "Coinbase");
  }
  return { key_id: fields.key_id, private_key: fields.private_key };
}

/**
 * Stable account id. Prefer the portfolio identity the API returns
 * (`retail_portfolio_id`); fall back to a short hash of the key id when the
 * portfolio id is absent, so the account is still stable across restarts
 * without ever embedding the raw key in the id.
 */
export function deriveAccountId(portfolioId: string | undefined, keyId: string): AccountId {
  if (portfolioId && portfolioId.length > 0) return AccountId(portfolioId);
  const digest = createHash("sha256").update(keyId).digest("hex").slice(0, 12);
  return AccountId(`coinbase-${digest}`);
}

/** Whether an id came from the portfolio identity rather than the key itself. */
function derivedFromIdentity(portfolioId: string | undefined): boolean {
  return Boolean(portfolioId && portfolioId.length > 0);
}

/**
 * Validate a pasted key, resolve which portfolio it belongs to, and store it
 * under that account.
 *
 * Read-only is a property of the key the user actually pasted, so any key that
 * can trade or transfer is refused before anything is written. Network/timeout
 * failures surface as the client's typed `SyncError` rather than a crash.
 */
export async function authFlow(
  _params?: Record<string, string>,
  callbacks?: AuthFlowCallbacks,
  ctx?: SourceLifecycleContext,
  overrides?: Partial<CoinbaseClientOptions>,
): Promise<AccountId> {
  const configDir = ctx?.configDir;
  const reauthAccountId = callbacks?.accountId;
  const pasted = callbacks?.credentials;
  const credentials: CoinbaseCredentials =
    pasted?.key_id && pasted.private_key
      ? { key_id: pasted.key_id, private_key: pasted.private_key }
      : reauthAccountId
        ? await loadCredentials(reauthAccountId, configDir)
        : (() => {
            throw new MissingCredentialsError(COINBASE_FILE_KEY, "Coinbase");
          })();

  const client = new CoinbaseClient({
    keyId: credentials.key_id,
    privateKeyPem: credentials.private_key,
    ...overrides,
  });

  const permissions = await client.getKeyPermissions();
  if (!permissions.can_view) {
    throw new Error(
      "Coinbase API key lacks View permission — create a key with View enabled and try again.",
    );
  }
  if (permissions.can_trade || permissions.can_transfer) {
    throw new Error(
      "Coinbase API key has Trade or Transfer permission — Omnesis requires a View-only (read-only) " +
        "key. Create a new key with only View enabled and try again.",
    );
  }

  // Confirm the key actually reads, and prefer the accounts-derived portfolio
  // id (key_permissions may omit it).
  const accounts = await client.getAccounts(1);
  const portfolioId = permissions.retail_portfolio_id ?? accounts.accounts[0]?.retail_portfolio_id;
  const derived = deriveAccountId(portfolioId, credentials.key_id);

  // A re-auth refreshes the account it was invoked for; a key for a different
  // portfolio would silently repoint an existing source at other holdings.
  // Only checkable when the id came from the portfolio identity. A key-derived
  // id is a function of the key, so a rotated key never matches — enforcing it
  // there would make rotation impossible rather than catching a wrong account.
  if (derivedFromIdentity(portfolioId) && reauthAccountId && String(derived) !== reauthAccountId) {
    throw new Error(
      `This API key belongs to Coinbase portfolio ${derived}, not ${reauthAccountId}. ` +
        `Add it as a separate source instead of re-authenticating this one.`,
    );
  }
  const accountId = reauthAccountId ? AccountId(reauthAccountId) : derived;

  try {
    await writeProviderAccountCredentials(
      COINBASE_FILE_KEY,
      String(accountId),
      { key_id: credentials.key_id, private_key: credentials.private_key },
      configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(COINBASE_FILE_KEY, String(accountId), err);
  }
  log.info(`Authenticated with Coinbase (read-only) — account ${accountId}`);
  return accountId;
}

/**
 * How many keys one connection attempt will take before it gives up.
 *
 * More than one because the most likely refusal — a key minted with Trade or
 * Transfer still enabled — is fixed by minting another one, and ending the flow
 * there means the operator does that and then starts the whole add again.
 * Bounded because a client resending the same rejected key is a client, not an
 * operator.
 */
const MAX_KEY_ATTEMPTS = 3;

/**
 * Connect a Coinbase portfolio.
 *
 * There is no browser leg: the pasted CDP key id and private key are the
 * credential, so the whole flow is asking for them, refusing anything wider
 * than View-only, and resolving which portfolio the key reads.
 */
export function authenticate(session: AuthSession): Promise<AuthResult> {
  return authenticateWith(session, {});
}

/**
 * {@link authenticate} with the client's transport seams open, so a test drives
 * the same code path the descriptor does.
 */
export async function authenticateWith(
  session: AuthSession,
  deps: Partial<CoinbaseClientOptions>,
): Promise<AuthResult> {
  // A client of the older shape collected the key pair on its wizard before
  // the flow started. Reading that first is what keeps both clients on one
  // code path without asking the operator for the same key twice.
  let pasted = suppliedCredentials(session.supplied);
  let rejected: AuthFailure | undefined;
  let rejectedKeyId: string | undefined;

  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
    const credentials = pasted ?? (await askForKey(session, rejected, rejectedKeyId));
    pasted = undefined;
    try {
      return await connectWithKey(session, credentials, deps);
    } catch (err) {
      // Only a refused credential is worth asking again for: the operator
      // mints a new key and pastes it without leaving the flow. Everything
      // else — a portfolio that is not the one being renewed, a key that
      // could not be stored — would give the same answer three times.
      if (!(err instanceof AuthFailure) || err.code !== "credential-rejected") throw err;
      rejected = err;
      rejectedKeyId = credentials.key_id;
    }
  }
  throw rejected;
}

/** The key pair a client of the older shape collected before the flow started. */
function suppliedCredentials(
  supplied: Readonly<Record<string, string>>,
): CoinbaseCredentials | undefined {
  const keyId = supplied.key_id?.trim();
  const privateKey = supplied.private_key;
  if (!keyId || !privateKey) return undefined;
  return { key_id: keyId, private_key: privateKey };
}

/** Ask the operator for a key, saying what was wrong with the last one. */
async function askForKey(
  session: AuthSession,
  rejected: AuthFailure | undefined,
  rejectedKeyId: string | undefined,
): Promise<CoinbaseCredentials> {
  const challenge = credentialsChallenge(coinbaseCredentialsSpec, {
    title: session.accountId
      ? `Reconnect Coinbase portfolio ${session.accountId}`
      : "Connect a Coinbase account",
    instructions: rejected
      ? [rejected.message, rejected.remedy].filter(Boolean).join(" ")
      : "Paste the name and private key of a View-only API key from the Coinbase Developer " +
        "Platform. Omnesis refuses a key that can trade or transfer.",
  });
  // The key name comes back so it need not be retyped. The private key never
  // does: it is the half that was refused, and offering it again invites the
  // operator to send the same one back.
  if (rejectedKeyId) challenge.prefill = { key_id: rejectedKeyId };

  const answered = await session.ask(challenge);
  const keyId = String(answered.key_id ?? "").trim();
  const privateKey = String(answered.private_key ?? "");
  if (!keyId || !privateKey) throw new MissingCredentialsError(COINBASE_FILE_KEY, "Coinbase");
  return { key_id: keyId, private_key: privateKey };
}

/** Validate one pasted key, resolve its portfolio, and store it. */
async function connectWithKey(
  session: AuthSession,
  credentials: CoinbaseCredentials,
  deps: Partial<CoinbaseClientOptions>,
): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const reauthAccountId = session.reason === "reauthenticate" ? session.accountId : undefined;

  // Parsed here rather than left to the first request. `CoinbaseClient` signs
  // outside the block that maps its failures, so an unparseable private key
  // escapes as a bare error nobody downstream can classify — and a key file
  // whose PEM arrives with escaped newlines is the ordinary way a good key
  // turns up unusable.
  try {
    signCoinbaseJwt({
      keyId: credentials.key_id,
      privateKeyPem: credentials.private_key,
      request: {
        method: "GET",
        host: deps.host ?? COINBASE_API_HOST,
        path: COINBASE_BROKERAGE_BASE,
      },
      nowEpochSeconds: (deps.now?.() ?? Date.now()) / 1000,
    });
  } catch (err) {
    throw new AuthFailure("credential-rejected", describe(err), {
      remedy:
        "Paste the whole BEGIN … END private key block from the downloaded key file, newlines and all.",
    });
  }

  const client = new CoinbaseClient({
    keyId: credentials.key_id,
    privateKeyPem: credentials.private_key,
    ...deps,
  });

  session.show({ kind: "wait", title: "Checking the Coinbase key" });

  const permissions = await probe(() => client.getKeyPermissions());
  assertReadOnly(permissions);

  // Confirm the key actually reads, and prefer the accounts-derived portfolio
  // id (key_permissions may omit it).
  const accounts = await probe(() => client.getAccounts(1));
  const portfolioId = permissions.retail_portfolio_id ?? accounts.accounts[0]?.retail_portfolio_id;
  const derived = deriveAccountId(portfolioId, credentials.key_id);

  // A renewal refreshes the account it was invoked for; a key for a different
  // portfolio would silently repoint an existing source at other holdings.
  // Only checkable when the id came from the portfolio identity: a key-derived
  // id is a function of the key, so a rotated key never matches, and enforcing
  // it there would make rotation impossible rather than catch a wrong account.
  if (derivedFromIdentity(portfolioId) && reauthAccountId && String(derived) !== reauthAccountId) {
    throw new AuthFailure(
      "identity-mismatch",
      `This API key belongs to Coinbase portfolio ${derived}, not ${reauthAccountId}.`,
      { remedy: "Add it as a separate source instead of renewing this one." },
    );
  }
  const accountId = reauthAccountId ? AccountId(reauthAccountId) : derived;

  try {
    await writeProviderAccountCredentials(
      COINBASE_FILE_KEY,
      String(accountId),
      { key_id: credentials.key_id, private_key: credentials.private_key },
      configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(COINBASE_FILE_KEY, String(accountId), err);
  }
  log.info(`Authenticated with Coinbase (read-only) — account ${accountId}`);
  return { accounts: [{ accountId: String(accountId), state: { status: "connected" } }] };
}

/**
 * Refuse a key that carries more than Omnesis will hold.
 *
 * The credential is authentic and it is Omnesis declining it, which is what
 * `credential-rejected` names — and the retry is the operator minting a
 * narrower key, which is why the flow asks again rather than ending.
 */
function assertReadOnly(permissions: CoinbaseKeyPermissions): void {
  if (!permissions.can_view) {
    throw new AuthFailure("credential-rejected", "This Coinbase key has no View permission.", {
      remedy: "Create a key with View enabled and paste it here.",
    });
  }
  if (permissions.can_trade || permissions.can_transfer) {
    throw new AuthFailure(
      "credential-rejected",
      "This Coinbase key can trade or transfer, and Omnesis only holds a View-only key.",
      { remedy: "Create a key with View enabled and Trade and Transfer off, then paste it here." },
    );
  }
}

/** Run one probe request, translating what the client reports about failure. */
async function probe<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (err) {
    if (!(err instanceof SyncError)) throw new AuthFailure("unknown", describe(err));
    switch (err.kind) {
      case "auth":
      case "permission":
        // Presented and refused: expired, revoked, or minted in a project this
        // key cannot read. The retry is a different key.
        throw new AuthFailure("credential-rejected", err.message, {
          remedy:
            "Check the key is still active on the Coinbase Developer Platform, then paste a working one.",
        });
      case "network":
      case "rate-limit":
      case "transient":
        throw new AuthFailure("unavailable", err.message, {
          remedy: "Try again in a few minutes.",
        });
      default:
        throw new AuthFailure("unknown", err.message);
    }
  }
}

/** An unknown thrown value, as one line for an operator-facing message. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const stored = listProviderAccountIds(COINBASE_FILE_KEY, configDir);
  if (stored.length > 0) return stored.map((id) => AccountId(id));
  if (!hasProviderCredentials(COINBASE_FILE_KEY, configDir)) return [];
  return listProviderAccountDirs(COINBASE_FILE_KEY, configDir).flatMap((name) => {
    try {
      return [AccountId(name)];
    } catch {
      return [];
    }
  });
}

/**
 * Offline credentials-exist check. Matches the auth-once model: a transient
 * API blip must never flip the source into sticky needs-auth, so this never
 * hits the network. A genuinely revoked key surfaces as a 401 →
 * `SyncError("auth")` during sync.
 */
export function hasCredentials(accountId: string, configDir?: string): boolean {
  if (hasProviderAccountCredentials(COINBASE_FILE_KEY, accountId, configDir)) return true;
  // An install predating per-account storage: the shared file is this account's
  // key until the first read adopts it. Only while nothing has migrated — once
  // some account holds its own credential, an account without one has none.
  if (listProviderAccountIds(COINBASE_FILE_KEY, configDir).length > 0) return false;
  return hasProviderCredentials(COINBASE_FILE_KEY, configDir);
}

export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await clearProviderAccountAndLegacyCredentials(COINBASE_FILE_KEY, accountId, configDir);
  log.info(`Cleaned up Coinbase credentials for account ${accountId}`);
}
