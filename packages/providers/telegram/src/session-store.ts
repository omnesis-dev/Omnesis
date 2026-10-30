// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Each connected account's credential: its mtcute session string, in a
 * root-key-wrapped secret file at `<configDir>/telegram/<userId>/credentials.json`.
 *
 * The session string is canonical. mtcute's own cache (`mtcute.db`) is
 * rebuilt from it on every connect, so losing the cache costs nothing and
 * losing this file means signing in again.
 *
 * A revoked session is rewritten with an empty `session` plus when and why,
 * rather than deleted. The dead key is not kept, and `credentialState` can still
 * say "this was ended from another device" offline, which is the remedy the
 * operator needs to read. Removing the account is what deletes the directory.
 */

import {
  clearProviderAccountCredentials,
  listProviderAccountIds,
  readProviderAccountCredentials,
  writeProviderAccountCredentials,
} from "@omnesis/core";
import { readConnectionState, type ConnectionState } from "@omnesis/source-sdk";
import { TELEGRAM_FILE_KEY } from "./credentials-spec.js";
import { isRevocationReason, type RevocationReason } from "./client/types.js";

export interface TelegramSessionRecord {
  /** The mtcute session string; empty once revoked. */
  session: string;
  /** The Telegram user id, as a decimal string: the account id. */
  userId: string;
  /** The `api_id` the session was created with. */
  apiId: string;
  /** International digits, when Telegram shared the account's number. */
  phone?: string;
  username?: string;
  /** ISO 8601. */
  connectedAt: string;
  /** ISO 8601, set once the session was ended. */
  revokedAt?: string;
  revokedReason?: RevocationReason;
}

/** Reasons that mean the session was ended from elsewhere; pairing again fixes it. */
const UNLINKED_REASONS: ReadonlySet<RevocationReason> = new Set([
  "AUTH_KEY_UNREGISTERED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "AUTH_KEY_DUPLICATED",
]);

/**
 * Read one account's record. `null` when none is stored. Throws when the file
 * exists but cannot be decrypted — a locked keyring is not an absent credential.
 */
export async function readSessionRecord(
  accountId: string,
  configDir: string,
): Promise<TelegramSessionRecord | null> {
  const fields = await readProviderAccountCredentials(TELEGRAM_FILE_KEY, accountId, configDir);
  if (!fields) return null;
  if (typeof fields.userId !== "string" || typeof fields.apiId !== "string") return null;
  return {
    session: fields.session ?? "",
    userId: fields.userId,
    apiId: fields.apiId,
    connectedAt: fields.connectedAt ?? "",
    ...(fields.phone ? { phone: fields.phone } : {}),
    ...(fields.username ? { username: fields.username } : {}),
    ...(fields.revokedAt ? { revokedAt: fields.revokedAt } : {}),
    ...(isRevocationReason(fields.revokedReason) ? { revokedReason: fields.revokedReason } : {}),
  };
}

export async function writeSessionRecord(
  record: TelegramSessionRecord,
  configDir: string,
): Promise<void> {
  const fields: Record<string, string> = {
    session: record.session,
    userId: record.userId,
    apiId: record.apiId,
    connectedAt: record.connectedAt,
  };
  if (record.phone) fields.phone = record.phone;
  if (record.username) fields.username = record.username;
  if (record.revokedAt) fields.revokedAt = record.revokedAt;
  if (record.revokedReason) fields.revokedReason = record.revokedReason;
  await writeProviderAccountCredentials(TELEGRAM_FILE_KEY, record.userId, fields, configDir);
}

/** Drop the session and record that it ended. A no-op when there is no record. */
export async function markSessionRevoked(
  accountId: string,
  reason: RevocationReason,
  configDir: string,
  at: Date,
): Promise<void> {
  const record = await readSessionRecord(accountId, configDir);
  if (!record) return;
  await writeSessionRecord(
    { ...record, session: "", revokedAt: at.toISOString(), revokedReason: reason },
    configDir,
  );
}

/** Accounts with a stored credential. Never lists bare directories. */
export function listSessionAccounts(configDir: string): string[] {
  return listProviderAccountIds(TELEGRAM_FILE_KEY, configDir);
}

/** Remove the account directory: the credential, the archive and the cache. */
export async function removeAccount(accountId: string, configDir: string): Promise<void> {
  await clearProviderAccountCredentials(TELEGRAM_FILE_KEY, accountId, configDir);
}

/** The connection state a record implies, without any network request. */
export function recordConnectionState(record: TelegramSessionRecord | null): ConnectionState {
  if (!record) return { status: "never-connected" };
  if (record.revokedReason || record.revokedAt || !record.session) {
    const reason = record.revokedReason;
    if (reason && !UNLINKED_REASONS.has(reason)) {
      return {
        status: "revoked",
        ...(record.revokedAt ? { at: record.revokedAt } : {}),
        detail: "Telegram deactivated this account.",
      };
    }
    return {
      status: "unlinked",
      detail: "This Omnesis session was ended from another Telegram device.",
    };
  }
  return { status: "connected", ...(record.connectedAt ? { since: record.connectedAt } : {}) };
}

/** `credentialState` for one account: offline, and `unknown` when the record cannot be read. */
export function sessionConnectionState(
  accountId: string,
  configDir: string,
): Promise<ConnectionState> {
  return readConnectionState(async () =>
    recordConnectionState(await readSessionRecord(accountId, configDir)),
  );
}
