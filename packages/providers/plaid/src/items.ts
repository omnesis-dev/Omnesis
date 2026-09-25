// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A connected Plaid item: where its credential lives on this host, and how it
 * is disconnected at Plaid.
 *
 * Each item is stored under `<configDir>/plaid/<item_id>/item.json` (mode
 * 0600) so the connected banks resolve offline on later collector starts — the
 * marker-dir pattern. The access token is never logged.
 *
 * Disconnecting belongs here too, because on this platform the two halves are
 * one lifecycle: deleting the local credential without calling `/item/remove`
 * leaves an item that keeps billing and keeps its bank consent, and nothing
 * can ever reach it again — Plaid serves no listing of an app's items, so a
 * stored access token is the only handle there is.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createLogger,
  DEFAULT_CONFIG_DIR,
  isSecretFileRootKeyUnavailableError,
  providerCredentialsPath,
  readSecretJsonFileSync,
  toErrorMessage,
  writeSecretJsonFileSync,
} from "@omnesis/core";
import { AccountId, safePathSegment, SyncError } from "@omnesis/types";
import { z } from "zod";
import { PLAID_ITEM_GONE_CODES, PlaidApiError } from "./client.js";
import { PLAID_FILE_KEY } from "./types.js";
import type { PlaidClient } from "./client.js";
import type { PlaidItemCredential } from "./types.js";

const log = createLogger("provider:plaid");

// ── Per-item credential storage ─────────────────────────────────────

/** The provider's own directory: one subdirectory per connected item. */
export function plaidDir(configDir?: string): string {
  return join(configDir ?? DEFAULT_CONFIG_DIR, PLAID_FILE_KEY);
}

export function itemDir(accountId: string, configDir?: string): string {
  return join(plaidDir(configDir), safePathSegment(accountId));
}

function itemCredentialPath(accountId: string, configDir?: string): string {
  return join(itemDir(accountId, configDir), "item.json");
}

/**
 * Whether this host has a credential for an item — asked of the file's
 * existence, never of its contents. `loadItemCredential` answers `null` both
 * for an item that was never connected and for one whose credential cannot be
 * decoded, and callers whose next move is destructive must not conflate the
 * two: an item that cannot be read is still a connected bank.
 */
export function findStoredItem(accountId: string, configDir?: string): boolean {
  return existsSync(itemCredentialPath(accountId, configDir));
}

const storedItemSchema = z.object({
  access_token: z.string().min(1),
  item_id: z.string().min(1),
  institution_name: z.string().optional(),
  institution_id: z.string().optional(),
  institution_logo: z.string().optional(),
  institution_color: z.string().optional(),
});

/** Persist a per-item credential atomically with mode 0600 (it is a secret). */
export function saveItemCredential(item: PlaidItemCredential, configDir?: string): void {
  writeSecretJsonFileSync(itemCredentialPath(item.item_id, configDir), item, { configDir });
}

/** Read + validate a stored per-item credential. Malformed or absent → null. */
export function loadItemCredential(
  accountId: string,
  configDir?: string,
): PlaidItemCredential | null {
  const path = itemCredentialPath(accountId, configDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readSecretJsonFileSync<unknown>(path, { configDir });
    if (raw === null) return null;
    const parsed = storedItemSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn(`item.json for ${accountId} has unexpected shape; treating as missing`);
      return null;
    }
    return parsed.data;
  } catch (err) {
    if (isSecretFileRootKeyUnavailableError(err)) throw err;
    log.warn(
      `failed to read item.json for ${accountId} (${(err as Error).message}); treating as missing`,
    );
    return null;
  }
}

/**
 * Resolve connected items offline by scanning the per-item dirs `authFlow`
 * wrote (`<configDir>/plaid/<item_id>/item.json`). No network call — the
 * collector derives source instances from this alone.
 */
export function discoverAccounts(configDir?: string): AccountId[] {
  const dir = plaidDir(configDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(itemCredentialPath(d.name, configDir)))
    .map((d) => AccountId(d.name));
}

/**
 * Offline credentials-exist check. The app credential plus a stored item dir
 * must both be present. Never hits the network: a transient API blip must not
 * flip a connected item into sticky needs-auth — a genuinely revoked consent
 * surfaces as `SyncError("auth")` during sync.
 */
export function hasCredentials(accountId: string, configDir?: string): boolean {
  if (!existsSync(providerCredentialsPath(PLAID_FILE_KEY, configDir))) return false;
  return loadItemCredential(accountId, configDir) !== null;
}

/**
 * Revoke an item at Plaid. `/item/remove` invalidates the access token and
 * ends the item's product subscriptions — without it the item keeps billing

 * and keeps its bank consent. Resolves with `undefined` when the item is gone,
 * including when it already was (`PLAID_ITEM_GONE_CODES`); any other failure
 * — a bad app credential, an outage, a rate limit — is returned as a message,
 * never thrown, so each caller surfaces it its own way.
 */
export async function revokeItem(
  client: PlaidClient,
  itemId: string,
  accessToken: string,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<string | undefined> {
  // One bounded retry on a retryable failure: the token is deleted locally
  // right after this, so a blip here would otherwise strand the item at Plaid.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.itemRemove(accessToken);
      log.info(`Revoked Plaid item ${itemId}`);
      return undefined;
    } catch (err) {
      if (
        err instanceof PlaidApiError &&
        err.errorCode &&
        PLAID_ITEM_GONE_CODES.has(err.errorCode)
      ) {
        log.info(`Plaid item ${itemId} was already revoked`);
        return undefined;
      }
      if (attempt === 0 && isRetryable(err)) {
        await sleep(retryDelayMs(err));
        continue;
      }
      return toErrorMessage(err);
    }
  }
}

const REVOKE_RETRY_DELAY_MS = 2_000;

export function isRetryable(err: unknown): boolean {
  return (
    err instanceof SyncError &&
    (err.kind === "transient" || err.kind === "network" || err.kind === "rate-limit")
  );
}

function retryDelayMs(err: unknown): number {
  return err instanceof SyncError && err.retryAfterMs ? err.retryAfterMs : REVOKE_RETRY_DELAY_MS;
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The stored item for an institution this host already connected, if any.
 * Plaid mints a distinct item id for a second login at the same bank, so the
 * institution id is the only thing that identifies the duplicate.
 */
export function findItemForInstitution(
  institutionId: string,
  configDir?: string,
): PlaidItemCredential | null {
  for (const accountId of discoverAccounts(configDir)) {
    const item = loadItemCredential(String(accountId), configDir);
    if (item?.institution_id === institutionId) return item;
  }
  return null;
}
