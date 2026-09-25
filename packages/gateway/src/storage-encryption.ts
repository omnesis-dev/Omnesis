// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway live-storage encryption boot policy.
 *
 * The OS keyring owns the install root key. When it is available, gateway boot
 * creates one wrapped data-encryption key per durable live store the gateway
 * opens and opens those stores encrypted. Once any storage key exists, or the
 * required marker exists, future boots fail closed if the root key cannot be
 * read. The decision itself is `resolveStorageEncryptionReadiness` in core,
 * shared with the collector, which mints the keys of the provider stores it
 * hosts under the same rules.
 */

import {
  readStorageKey,
  resolveStorageEncryptionReadiness,
  storageKeyHex,
  storageKeyNamesForHost,
  type StorageKeyName,
} from "@omnesis/core";

// main-db, index-db, analytics-db and watch2-db. The watch journal's key keeps
// a frozen spelling the file no longer has; see STORAGE_KEY_NAMES for why.
const GATEWAY_STORAGE_KEYS = storageKeyNamesForHost("gateway");

export interface GatewayStorageEncryptionKeys {
  enabled: boolean;
  mainDbKey: Buffer | null;
  indexDbKey: Buffer | null;
  analyticsDbKey: Buffer | null;
  /**
   * The Watch runtime's own journal store. Derived and rebuildable, but it
   * holds document titles, person ids and analytics rows — corpus material,
   * whatever else it is — so it is keyed like the stores it is derived from.
   */
  watchDbKey: Buffer | null;
  mainDbKeyHex?: string;
  indexDbKeyHex?: string;
  analyticsDbKeyHex?: string;
  watchDbKeyHex?: string;
}

export async function resolveGatewayStorageEncryptionKeys(
  configDir: string,
): Promise<GatewayStorageEncryptionKeys> {
  const { enabled } = await resolveStorageEncryptionReadiness(configDir, GATEWAY_STORAGE_KEYS);
  if (!enabled) {
    return {
      enabled: false,
      mainDbKey: null,
      indexDbKey: null,
      analyticsDbKey: null,
      watchDbKey: null,
    };
  }

  const mainDbKey = await readRequiredStorageKey("main-db", configDir);
  const indexDbKey = await readRequiredStorageKey("index-db", configDir);
  const analyticsDbKey = await readRequiredStorageKey("analytics-db", configDir);
  const watchDbKey = await readRequiredStorageKey("watch2-db", configDir);
  return {
    enabled: true,
    mainDbKey,
    indexDbKey,
    analyticsDbKey,
    watchDbKey,
    mainDbKeyHex: storageKeyHex(mainDbKey),
    indexDbKeyHex: storageKeyHex(indexDbKey),
    analyticsDbKeyHex: storageKeyHex(analyticsDbKey),
    watchDbKeyHex: storageKeyHex(watchDbKey),
  };
}

async function readRequiredStorageKey(keyName: StorageKeyName, configDir: string): Promise<Buffer> {
  const key = await readStorageKey(keyName, { configDir });
  if (!key) throw new Error(`Omnesis storage key ${keyName} was not created`);
  return key;
}

/**
 * The boot-time storage-encryption posture line. When encryption is enabled it
 * is an info confirmation; when it is not (no install root key was configured),
 * it is a high-signal warning that the corpus databases are plaintext on disk —
 * so an operator who never ran `omnesis keyring init` is told at every boot
 * rather than silently running unencrypted.
 */
export function storageEncryptionPosture(enabled: boolean): {
  level: "info" | "warn";
  message: string;
} {
  if (enabled) {
    return {
      level: "info",
      message:
        "Live storage encryption enabled for the gateway, index, analytics, and watch stores",
    };
  }
  return {
    level: "warn",
    message:
      "Live storage is UNENCRYPTED — no install root key is configured, so the gateway, " +
      "index, analytics, and watch databases are plaintext on disk (protected only by " +
      "file permissions and full-disk encryption). Run `omnesis keyring init` to enable " +
      "at-rest encryption, or `omnesis doctor` to review the full posture.",
  };
}
