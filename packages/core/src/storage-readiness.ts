// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The fail-closed decision every Omnesis process makes before it opens an
 * encrypted store: given this install's root key and markers, may the
 * process run with live-storage encryption on, run plaintext, or must it
 * refuse to run at all?
 *
 * The gateway and the collector each own a different set of storage keys
 * and each host has its own config directory, root key and markers, so the
 * decision is made per process over that process's key set. The rules are
 * the same on both sides and live here so they cannot drift:
 *
 * - A root key that exists but cannot be opened is never a plaintext state.
 * - Encryption that was armed — by the marker file, by a wrapped key already
 *   on disk, or by the secret store's memory of the marker — cannot be
 *   silently downgraded because the root key went missing.
 * - Both markers must verify against the root key; a legacy marker is
 *   upgraded and a restored one has its secret-store state healed.
 * - With a usable root key, every key in the set is created if absent, and
 *   the marker is re-armed if it was lost.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { inspectInstallRootKey, readInstallRootKey } from "./secret-store.js";
import { GATEWAY_STORE_FILE } from "./utils.js";
import {
  readMarkerKeyringState,
  setMarkerKeyringState,
  verifySecureMarker,
  writeSecureMarker,
  type SecureMarkerKind,
} from "./secure-marker.js";
import {
  STORAGE_KEY_NAMES,
  ensureStorageKey,
  inspectStorageKey,
  storageEncryptionRequired,
  storageKeyNamesForHost,
  type StorageKeyHost,
  type StorageKeyName,
} from "./storage-keys.js";

/**
 * Which processes this config directory serves, read from the state each
 * one leaves behind: the gateway's main database at its default path and
 * the collector's pairing token. A directory that has neither yet — a fresh
 * install before its first boot — is treated as serving both, so a
 * key-preparation command run there prepares every key rather than
 * guessing. A gateway whose database was moved with OMNESIS_DB_PATH is not
 * detected; commands take `--host` for that.
 */
export function detectStorageKeyHosts(configDir: string): StorageKeyHost[] {
  const hosts: StorageKeyHost[] = [];
  if (existsSync(join(configDir, GATEWAY_STORE_FILE))) hosts.push("gateway");
  if (existsSync(join(configDir, "collector-token"))) hosts.push("collector");
  return hosts.length > 0 ? hosts : ["gateway", "collector"];
}

/** The keys a command should prepare in `configDir` for `hosts`, in registry order. */
export function storageKeyNamesForHosts(hosts: readonly StorageKeyHost[]): StorageKeyName[] {
  const wanted = new Set(hosts.flatMap((host) => [...storageKeyNamesForHost(host)]));
  return STORAGE_KEY_NAMES.filter((name) => wanted.has(name));
}

export interface StorageEncryptionReadiness {
  /** Whether the process must open its stores encrypted. */
  enabled: boolean;
  /** Keys minted by this call, so a caller can say what it created. */
  created: StorageKeyName[];
}

/**
 * Decide the encryption posture for `keyNames` in `configDir`, minting any
 * absent key when the root key is usable. Throws with an operator-facing
 * remedy whenever running would silently downgrade or corrupt the install.
 */
export async function resolveStorageEncryptionReadiness(
  configDir: string,
  keyNames: readonly StorageKeyName[],
): Promise<StorageEncryptionReadiness> {
  const required = storageEncryptionRequired(configDir);
  const storageStates = await Promise.all(
    keyNames.map((keyName) => inspectStorageKey(keyName, { configDir })),
  );
  const hasAnyStorageKey = storageStates.some((state) => state.present);
  const root = await inspectInstallRootKey({ configDir });

  if (!root.valid) {
    if (root.present) {
      // A root key entry EXISTS but cannot be opened (wrong keyring passphrase,
      // corrupt entry). That is never a legitimate plaintext state — refuse
      // rather than quietly creating an unencrypted corpus beside a sealed key.
      throw new Error(
        "An Omnesis install root key exists but cannot be read — the configured keyring " +
          "passphrase does not open it, or the entry is corrupt. Fix the secret-store " +
          "configuration (see `omnesis keyring status`) instead of running plaintext.",
      );
    }
    if (required || hasAnyStorageKey) {
      throw new Error(
        "Omnesis live storage encryption is required, but the install root key is unavailable. Unlock the OS keyring, restore the root key, or set OMNESIS_SECRET_STORE to the backend that holds it.",
      );
    }
    // Deletion detection without a root key: the secret store may still hold
    // the marker state even when the marker files and wrapped keys are gone
    // (partial restore, overzealous cleanup). A positive answer means this
    // install had encryption armed — refuse to quietly open plaintext.
    const state = await readMarkerKeyringState("storage-encryption", { configDir });
    if (state === "required") {
      throw new Error(
        "The OS secret store records that live storage encryption was enabled for this install, " +
          "but the keyring/storage-encryption-required marker and wrapped storage keys are missing. " +
          "Restore <configDir>/keyring/ from a backup. If this install was intentionally rebuilt " +
          "from scratch, clear the stale state with the keyring tooling first.",
      );
    }
    return { enabled: false, created: [] };
  }

  const rootKeyValue = await readInstallRootKey({ configDir });
  if (!rootKeyValue) {
    throw new Error(
      "Omnesis install root key became unavailable while resolving storage encryption. Unlock the OS keyring and retry.",
    );
  }
  await enforceMarkerIntegrity(configDir, rootKeyValue);

  const created: StorageKeyName[] = [];
  for (const keyName of keyNames) {
    const result = await ensureStorageKey(keyName, { configDir });
    if (result.created) created.push(keyName);
  }

  // ensureStorageKey only writes the marker when it creates a key, so a
  // deleted marker alongside pre-existing keys (with no keyring state to
  // catch it above — a pre-MAC install) would stay missing forever. Re-arm it.
  if (!storageEncryptionRequired(configDir)) {
    await writeSecureMarker("storage-encryption", { configDir, rootKeyValue });
  }
  return { enabled: true, created };
}

/**
 * Verify both fail-closed markers against the install root key before any
 * store opens. Outcomes per marker:
 *  - `invalid` (tampered, corrupted, or written under a different install's
 *    root key) → fail loud; a mixed-epoch config dir must be untangled, not
 *    guessed at.
 *  - `missing` while the secret store's state entry says it was armed → fail
 *    loud; a deleted marker must not silently downgrade the install.
 *  - `legacy` (pre-MAC v1 sentinel) → upgrade in place to the MAC-bound format
 *    and set the keyring state.
 *  - `valid` with no keyring state (e.g. right after `omnesis restore` onto a
 *    fresh machine) → self-heal the state entry; the verified MAC proves the
 *    marker was written by this root key's holder.
 */
export async function enforceMarkerIntegrity(
  configDir: string,
  rootKeyValue: string,
): Promise<void> {
  const kinds: SecureMarkerKind[] = ["storage-encryption", "secret-files"];
  for (const kind of kinds) {
    const status = await verifySecureMarker(kind, rootKeyValue, configDir);
    const state = await readMarkerKeyringState(kind, { configDir });
    if (status === "invalid") {
      const markerFile =
        kind === "storage-encryption" ? "storage-encryption-required" : "secret-files-required";
      // Each marker is re-armed by the command that owns it: storage keys by
      // `storage-init`, secret files by `migrate`. Both converge the marker to
      // the current root key, so they repair a corrupted-but-recoverable marker.
      const repairCmd =
        kind === "storage-encryption" ? "omnesis keyring storage-init" : "omnesis keyring migrate";
      throw new Error(
        `The keyring/${markerFile} marker failed integrity verification — it was tampered with, ` +
          "corrupted, or belongs to a different install's root key. If the root key is intact and " +
          `only the marker is corrupted, run \`${repairCmd}\` to re-arm it; otherwise restore ` +
          "<configDir>/keyring/ from a backup that matches this root key.",
      );
    }
    if (status === "missing" && state === "required") {
      throw new Error(
        `The OS secret store records that the ${kind} fail-closed marker was armed, but the marker ` +
          "file is missing — a partial restore or deletion would silently downgrade this install. " +
          "Restore <configDir>/keyring/ from a backup.",
      );
    }
    if (status === "legacy") {
      await writeSecureMarker(kind, { configDir, rootKeyValue });
    } else if (status === "valid" && state === null) {
      await setMarkerKeyringState(kind, { configDir }).catch(() => {
        /* best-effort: an unavailable store must not block boot */
      });
    }
  }
}
