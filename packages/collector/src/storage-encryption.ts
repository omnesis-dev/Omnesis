// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Collector live-storage encryption boot policy.
 *
 * A collector keeps provider archives and caches on its own host, under its
 * own config directory, sealed by that host's install root key: pairing
 * hands it a gateway credential, never the gateway's storage keys. So the
 * keys those stores open with have to exist on this host before the first
 * sync, and nothing but this process can be relied on to create them — a
 * remote collector has no gateway boot beside it.
 *
 * The decision is `resolveStorageEncryptionReadiness` from core, the same
 * rules the gateway boots under, applied to the collector's key set: with a
 * usable root key every absent key is minted; with encryption armed and no
 * usable root key the collector refuses to start rather than opening a
 * store plaintext or failing later, one source at a time.
 */

import {
  createLogger,
  resolveStorageEncryptionReadiness,
  storageKeyNamesForHost,
  type StorageEncryptionReadiness,
} from "@omnesis/core";

const log = createLogger("collector:storage");

/** The keys of the provider stores a collector opens. */
export const COLLECTOR_STORAGE_KEYS = storageKeyNamesForHost("collector");

/**
 * Establish this collector's storage keys and log the resulting posture.
 * Throws with the operator-facing remedy when encryption is armed but
 * cannot be honoured; the caller turns that into a refused boot.
 */
export async function prepareCollectorStorageEncryption(
  configDir: string,
): Promise<StorageEncryptionReadiness> {
  const readiness = await resolveStorageEncryptionReadiness(configDir, COLLECTOR_STORAGE_KEYS);
  const posture = collectorStoragePosture(readiness);
  log[posture.level](posture.message);
  return readiness;
}

/**
 * The boot-time posture line: a confirmation when the collector's stores
 * are encrypted, a high-signal warning naming the remedy when they are not.
 */
export function collectorStoragePosture(readiness: StorageEncryptionReadiness): {
  level: "info" | "warn";
  message: string;
} {
  if (readiness.enabled) {
    const minted = readiness.created.length > 0 ? ` (created ${readiness.created.join(", ")})` : "";
    return {
      level: "info",
      message: `Live storage encryption enabled for the collector's provider stores: ${COLLECTOR_STORAGE_KEYS.join(", ")}${minted}`,
    };
  }
  return {
    level: "warn",
    message:
      "Collector stores are UNENCRYPTED — no install root key is configured on this host, so " +
      "provider archives and caches are plaintext on disk (protected only by file permissions " +
      "and full-disk encryption). Run `omnesis keyring init` on this host and restart the " +
      "collector to enable at-rest encryption.",
  };
}
