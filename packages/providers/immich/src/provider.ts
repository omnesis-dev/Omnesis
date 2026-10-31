// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  clearProviderAccountCredentials,
  createLogger,
  CredentialPersistError,
  hasProviderAccountCredentials,
  listProviderAccountIds,
  MissingCredentialsError,
  readProviderAccountCredentials,
  writeProviderAccountCredentials,
} from "@omnesis/core";
import { AccountId, SyncError } from "@omnesis/types";
import { AuthFailure, credentialsChallenge } from "@omnesis/source-sdk";
import {
  formatVersion,
  ImmichClient,
  isSupportedVersion,
  normalizeBaseUrl,
  type ImmichClientOptions,
} from "./client.js";
import { immichCredentialsSpec, REQUIRED_PERMISSIONS } from "./credentials-spec.js";
import type {
  AuthFlowCallbacks,
  AuthResult,
  AuthSession,
  SourceLifecycleContext,
} from "@omnesis/source-sdk";

const log = createLogger("provider:immich");
const IMMICH_FILE_KEY = "immich";

export interface ImmichCredentials {
  baseUrl: string;
  apiKey: string;
  /**
   * The Immich user id the key was connected as, a UUID unique to one user on
   * one server. Absent only for a credential stored before it was recorded.
   */
  userId?: string;
}

/** What a probe of a key found, for the caller to store and report. */
interface ImmichProbe {
  accountId: string;
  /** The Immich user id: what tells one server's user from another's with the same email. */
  userId: string;
  userName: string;
  /** Why the key reaches further than this source needs, when it does. */
  broadAccess?: string;
}

/**
 * Check a key against its server: a version this source reads, the user the
 * key belongs to, and the permissions it carries.
 *
 * An admin user, or a key granted everything, is reported rather than
 * refused. On a single-person server the owner usually is the admin, and
 * refusing them would refuse the common case; the source only ever calls
 * endpoints that read the key's own user's view, never an admin endpoint.
 */
export async function probeImmich(
  creds: ImmichCredentials,
  clientOptions: ImmichClientOptions = {},
): Promise<ImmichProbe> {
  const client = new ImmichClient(creds.baseUrl, creds.apiKey, clientOptions);
  let version;
  try {
    version = await client.version();
  } catch (err) {
    // Something answered, but not Immich: a router page, a proxy's login
    // screen, a path prefix that does not lead to the API.
    if (err instanceof SyncError && err.kind === "unknown") {
      throw new AuthFailure(
        "credential-rejected",
        `${creds.baseUrl} does not serve the Immich API.`,
        {
          remedy: "Paste the address you open Immich at in a browser, including any path prefix.",
        },
      );
    }
    throw err;
  }
  if (!isSupportedVersion(version)) {
    throw new AuthFailure(
      "unsupported",
      `This server runs Immich ${formatVersion(version)}; Omnesis reads Immich v3.0 or later.`,
      { remedy: "Upgrade the Immich server, then connect again." },
    );
  }
  const key = await client.apiKeyMe();
  const granted = new Set(Array.isArray(key?.permissions) ? key.permissions : []);
  const hasAll = granted.has("all");
  const missing = hasAll ? [] : REQUIRED_PERMISSIONS.filter((p) => !granted.has(p));
  if (missing.length > 0) {
    throw new AuthFailure("credential-rejected", `The API key is missing ${missing.join(", ")}.`, {
      remedy:
        `In Immich open Account Settings, then API Keys, and give the key ${missing.join(", ")}, ` +
        "or create a new key with them.",
    });
  }
  const me = await client.me();
  if (
    typeof me?.email !== "string" ||
    !me.email.includes("@") ||
    typeof me.id !== "string" ||
    !me.id
  ) {
    throw new AuthFailure("unknown", "Immich did not say which user the API key belongs to.");
  }
  const reasons = [
    me.isAdmin ? "belongs to an Immich administrator" : undefined,
    hasAll ? "is granted every permission" : undefined,
  ].filter(Boolean);
  return {
    accountId: me.email.trim().toLowerCase(),
    userId: me.id,
    userName: me.name,
    ...(reasons.length > 0 ? { broadAccess: `The key ${reasons.join(" and ")}.` } : {}),
  };
}

/**
 * Connect one Immich user.
 *
 * The address and the key are one question. A renewal starts from the stored
 * address, so a server that moved can be pointed at again, and always asks for
 * the key, since a revoked key is usually what stopped working. Nothing is
 * written until the server accepts the key.
 */
export async function authenticate(
  session: AuthSession,
  clientOptions: ImmichClientOptions = {},
): Promise<AuthResult> {
  const configDir = session.host.configDir;
  const reauthAccountId = session.accountId;
  const existing = reauthAccountId
    ? await readProviderAccountCredentials(IMMICH_FILE_KEY, reauthAccountId, configDir)
    : null;

  const challenge = credentialsChallenge(immichCredentialsSpec, {
    title: reauthAccountId ? `Reconnect ${reauthAccountId}` : "Connect an Immich library",
    instructions:
      "Create an API key in Immich under Account Settings, then API Keys, with asset.read, " +
      "album.read and user.read, and paste it with the address you open Immich at.",
  });
  if (existing?.base_url) challenge.prefill = { base_url: existing.base_url };

  // A client of the older shape collected both fields before the flow
  // started; asking again would be asking twice.
  const supplied = session.supplied;
  const answered =
    supplied.base_url?.trim() && supplied.api_key?.trim() ? supplied : await session.ask(challenge);

  const baseUrl = normalizeBaseUrl(String(answered.base_url ?? ""));
  const apiKey = String(answered.api_key ?? "").trim();
  if (!baseUrl) {
    throw new AuthFailure("credential-rejected", "That is not an http:// or https:// address.", {
      remedy: "Paste the address you open Immich at in a browser.",
    });
  }
  if (!apiKey) {
    throw new AuthFailure("credential-rejected", "No API key was entered.", {
      remedy: "Create an API key in Immich under Account Settings, then API Keys, and paste it.",
    });
  }

  session.show({ kind: "wait", title: "Checking the API key" });
  let probe: ImmichProbe;
  try {
    probe = await probeImmich({ baseUrl, apiKey }, clientOptions);
  } catch (err) {
    throw probeFailure(err, baseUrl);
  }
  if (reauthAccountId && probe.accountId !== reauthAccountId.toLowerCase()) {
    throw new AuthFailure(
      "identity-mismatch",
      `This API key belongs to ${probe.accountId}, not ${reauthAccountId}.`,
      { remedy: "Add it as a separate Immich source instead of reconnecting this one." },
    );
  }
  const accountId = reauthAccountId ?? probe.accountId;
  await refuseOtherServer(accountId, probe, configDir);
  if (probe.broadAccess) {
    log.warn(`Immich key for ${accountId} reaches beyond its own library: ${probe.broadAccess}`);
  }

  try {
    await writeProviderAccountCredentials(
      IMMICH_FILE_KEY,
      accountId,
      { base_url: baseUrl, api_key: apiKey, user_id: probe.userId },
      configDir,
    );
  } catch (err) {
    throw new CredentialPersistError(IMMICH_FILE_KEY, accountId, err);
  }
  log.info(`Authenticated with Immich at ${baseUrl} as ${probe.userName || accountId}`);
  return {
    accounts: [{ accountId, state: { status: "connected" } }],
    ...(probe.broadAccess
      ? {
          notices: [
            {
              title: "This API key can do more than Omnesis needs",
              detail:
                `${probe.broadAccess} Omnesis only reads this user's own view of the library and ` +
                "never calls an administrator endpoint, but a key limited to asset.read, " +
                "album.read and user.read is safer to leave on this machine.",
            },
          ],
        }
      : {}),
  };
}

/**
 * Refuse a key for a different Immich user stored under the same account.
 *
 * The account is keyed by email, and two servers can each have a user with
 * the same email — a home server and a family one. Without this, adding the
 * second would overwrite the first account's credential, and the existing
 * source would start reading another library on the first one's cursor, whose
 * next daily rewalk would then delete everything it had indexed. The user id
 * is a UUID per user per server, so a server that merely moved keeps it.
 */
async function refuseOtherServer(
  accountId: string,
  probe: ImmichProbe,
  configDir: string | undefined,
): Promise<void> {
  const stored = await readProviderAccountCredentials(IMMICH_FILE_KEY, accountId, configDir);
  if (!stored?.user_id || stored.user_id === probe.userId) return;
  throw new AuthFailure(
    "identity-mismatch",
    `${accountId} is already connected to a different Immich server (${stored.base_url ?? "unknown address"}).`,
    {
      remedy:
        "One Immich user per email can be connected to a gateway. Remove the existing source first, " +
        "or connect this server with a user that has a different email.",
    },
  );
}

/** What a failed probe means for the operator. */
function probeFailure(err: unknown, baseUrl: string): AuthFailure {
  if (err instanceof AuthFailure) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof SyncError) {
    if (err.kind === "auth") {
      return new AuthFailure("credential-rejected", message, {
        remedy:
          "Create a new API key in Immich under Account Settings, then API Keys, and paste it.",
      });
    }
    if (err.kind === "permission") {
      return new AuthFailure("credential-rejected", message, {
        remedy: "Give the key asset.read, album.read and user.read, or create one that has them.",
      });
    }
    if (err.kind === "network" || err.kind === "transient" || err.kind === "rate-limit") {
      return new AuthFailure("unavailable", message, {
        remedy: `Check that ${baseUrl} opens Immich from the machine running the collector.`,
      });
    }
  }
  return new AuthFailure("unknown", message);
}

/**
 * The older entry point: the fields arrive on `callbacks.credentials` for a
 * new add, and are read from disk for a renewal.
 */
export async function authFlow(
  _params?: Record<string, string>,
  callbacks?: AuthFlowCallbacks,
  ctx?: SourceLifecycleContext,
  clientOptions: ImmichClientOptions = {},
): Promise<AccountId> {
  const supplied = callbacks?.credentials;
  const fields =
    supplied ??
    (callbacks?.accountId
      ? await readProviderAccountCredentials(IMMICH_FILE_KEY, callbacks.accountId, ctx?.configDir)
      : null);
  const baseUrl = normalizeBaseUrl(fields?.base_url ?? "");
  const apiKey = fields?.api_key?.trim();
  if (!baseUrl || !apiKey) throw new MissingCredentialsError(IMMICH_FILE_KEY, "Immich");
  let probe: ImmichProbe;
  try {
    probe = await probeImmich({ baseUrl, apiKey }, clientOptions);
  } catch (err) {
    throw probeFailure(err, baseUrl);
  }
  if (callbacks?.accountId && probe.accountId !== callbacks.accountId.toLowerCase()) {
    throw new AuthFailure(
      "identity-mismatch",
      `This API key belongs to ${probe.accountId}, not ${callbacks.accountId}.`,
      { remedy: "Add it as a separate Immich source instead of reconnecting this one." },
    );
  }
  const accountId = AccountId(callbacks?.accountId ?? probe.accountId);
  await refuseOtherServer(String(accountId), probe, ctx?.configDir);
  if (supplied) {
    try {
      await writeProviderAccountCredentials(
        IMMICH_FILE_KEY,
        String(accountId),
        { base_url: baseUrl, api_key: apiKey, user_id: probe.userId },
        ctx?.configDir,
      );
    } catch (err) {
      throw new CredentialPersistError(IMMICH_FILE_KEY, String(accountId), err);
    }
  }
  return accountId;
}

/** Configured accounts, offline. */
export function discoverAccounts(configDir?: string): AccountId[] {
  return listProviderAccountIds(IMMICH_FILE_KEY, configDir).flatMap((value) => {
    try {
      return [AccountId(value)];
    } catch {
      return [];
    }
  });
}

export function hasCredentials(accountId: string, configDir?: string): boolean {
  return hasProviderAccountCredentials(IMMICH_FILE_KEY, accountId, configDir);
}

export async function loadCredentials(
  accountId: string,
  configDir?: string,
): Promise<ImmichCredentials> {
  const fields = await readProviderAccountCredentials(IMMICH_FILE_KEY, accountId, configDir);
  const baseUrl = normalizeBaseUrl(fields?.base_url ?? "");
  const apiKey = fields?.api_key?.trim();
  if (!baseUrl || !apiKey) {
    throw new Error(
      `No usable Immich address and API key are stored for ${accountId}. Reconnect the source to enter them again.`,
    );
  }
  return { baseUrl, apiKey, ...(fields?.user_id ? { userId: fields.user_id } : {}) };
}

export async function cleanupCredentials(accountId: string, configDir?: string): Promise<void> {
  await clearProviderAccountCredentials(IMMICH_FILE_KEY, accountId, configDir);
  log.info(`Cleaned up Immich credentials for account ${accountId}`);
}
