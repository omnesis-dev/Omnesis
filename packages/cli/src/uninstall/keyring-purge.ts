// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Remove one config directory's entries from the OS keyring, for an install
 * that removes itself without the CLI's own uninstall — the native collector
 * beside a Docker install, whose `omnesis-collector uninstall --purge` must
 * not reach into the Docker install's `omnesis`.
 *
 * Two kinds of entry are this directory's. Its fail-closed markers are keyed
 * by the directory, so they always go. The install root key is one entry per
 * account (`dev.omnesis` / `install-root-key-v1`), shared by every native
 * config directory of the account, so it goes only when no other one is left:
 * an Omnesis directory under `~/.config` with a config, a database or a
 * keyring of its own. A Docker install's directory does not count — its
 * containers have no OS keyring and seal their secrets with a passphrase file
 * inside that directory — so it is never what keeps the key, and nothing of
 * it is touched.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  OMNESIS_INSTALL_ROOT_KEY,
  clearMarkerKeyringState,
  createSecretStore,
  type CreateSecretStoreOptions,
  type SecureMarkerKind,
} from "@omnesis/core";

const MARKER_KINDS: readonly SecureMarkerKind[] = ["storage-encryption", "secret-files"];

export interface KeyringPurgeDeps {
  listConfigParent(): string[];
  exists(path: string): boolean;
  readText(path: string): string | null;
  clearMarker(kind: SecureMarkerKind, opts: CreateSecretStoreOptions): Promise<void>;
  /** Delete the account's root key; false when there is no OS keyring to delete from. */
  deleteRootKey(opts: CreateSecretStoreOptions): Promise<boolean>;
}

export interface KeyringPurgeResult {
  markersCleared: boolean;
  rootKey: "deleted" | "kept" | "no-keyring";
  /** The directories that still use the root key, when it was kept. */
  keptFor: string[];
  notes: string[];
}

/** The other native Omnesis config directories of this account that may use the root key. */
export function otherKeyringConfigDirs(
  home: string,
  configDir: string,
  deps: Pick<KeyringPurgeDeps, "listConfigParent" | "exists" | "readText">,
): string[] {
  const parent = join(home, ".config");
  const self = resolve(configDir);
  return deps
    .listConfigParent()
    .filter((name) => name.startsWith("omnesis"))
    .map((name) => join(parent, name))
    .filter((dir) => resolve(dir) !== self)
    .filter((dir) =>
      ["omnesis.json", "omnesis.db", "keyring"].some((f) => deps.exists(join(dir, f))),
    )
    .filter((dir) => deps.readText(join(dir, "install-method"))?.trim() !== "docker");
}

export async function purgeConfigDirKeyring(
  home: string,
  configDir: string,
  deps: KeyringPurgeDeps = defaultKeyringPurgeDeps(home),
): Promise<KeyringPurgeResult> {
  const opts: CreateSecretStoreOptions = { configDir };
  const notes: string[] = [];
  let markersCleared = true;
  for (const kind of MARKER_KINDS) {
    try {
      await deps.clearMarker(kind, opts);
    } catch (err) {
      markersCleared = false;
      notes.push(
        `could not clear the ${kind} entry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const keptFor = otherKeyringConfigDirs(home, configDir, deps);
  if (keptFor.length > 0) return { markersCleared, rootKey: "kept", keptFor, notes };
  try {
    const deleted = await deps.deleteRootKey(opts);
    return { markersCleared, rootKey: deleted ? "deleted" : "no-keyring", keptFor, notes };
  } catch (err) {
    notes.push(
      `could not delete the install root key: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { markersCleared, rootKey: "kept", keptFor, notes };
  }
}

export function defaultKeyringPurgeDeps(home: string): KeyringPurgeDeps {
  return {
    listConfigParent: () => {
      try {
        return readdirSync(join(home, ".config"));
      } catch {
        return [];
      }
    },
    exists: existsSync,
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    clearMarker: (kind, opts) => clearMarkerKeyringState(kind, opts),
    deleteRootKey: async (opts) => {
      const store = createSecretStore(opts);
      // A file or passphrase store lives in the config directory, and goes with it.
      if (store.backend !== "macos-keychain" && store.backend !== "secret-service") return false;
      if (!(await store.status()).available) return false;
      await store.delete(OMNESIS_INSTALL_ROOT_KEY);
      return true;
    },
  };
}
