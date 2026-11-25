// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where a Codex runtime keeps its state inside the Omnesis config directory.
 *
 * An on-disk contract rather than install machinery, and shared for the same
 * reason the service-unit paths are: the gateway creates these directories and
 * the doctor's security collector reads them back to classify what it finds
 * there. A Codex runtime makes symlinks the collector has to recognise —
 * without a single definition, renaming a directory on the writing side leaves
 * the collector reporting every one of them as unsafe, with nothing to say so.
 *
 * Headless pools retain per-member homes. Managed desktop workers share one
 * generation-scoped credential home while keeping separate workspaces and
 * diagnostic state directories; a new installation generation gets a new scope.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";

export const CODEX_KEYRING_SERVICE = "Codex Auth";

/** Pinned Codex direct Keychain namespace, derived only from its owned home. */
export function codexKeyringAccount(codexHome: string): string {
  if (!isAbsolute(codexHome))
    throw new Error("The owned Codex home must be absolute and canonical");
  const canonical = resolve(codexHome);
  for (let ancestor = canonical; ; ancestor = dirname(ancestor)) {
    try {
      const info = lstatSync(ancestor);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        (ancestor === canonical && process.getuid && info.uid !== process.getuid())
      )
        throw new Error("The owned Codex home contains an unsafe directory alias or owner");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw error;
    }
    if (dirname(ancestor) === ancestor) break;
  }
  try {
    if (realpathSync(canonical) !== canonical)
      throw new Error("The owned Codex home must remain canonical");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  return `cli|${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/** The single runtime's home, and the shared login every pooled member tracks. */
export const CODEX_HOME_DIR = "codex-home";
/** The base a pooled runtime's member homes sit under, one directory per index. */
export const CODEX_POOL_HOME_DIR = "codex-home-pool";
/** The single runtime's workspace, and the base for a pool's per-member ones. */
export const CODEX_WORKSPACE_DIR = "codex-workspace";
export const CODEX_POOL_WORKSPACE_DIR = "codex-workspace-pool";
export const CODEX_RUNTIME_STORE_DIR = "codex-runtimes";

/** Every Codex path, resolved against one config directory. */
export function codexPaths(
  configDir: string,
  managedInstance?: string,
): {
  readonly home: string;
  readonly sharedAuth: string;
  readonly poolHomeBase: string;
  readonly workspace: string;
  readonly poolWorkspaceBase: string;
  readonly runtimeStore: string;
  readonly runtimeVersions: string;
  readonly runtimeStaging: string;
  readonly runtimeCurrent: string;
  readonly runtimeUpdateLock: string;
} {
  if (managedInstance !== undefined && !/^desktop-[a-f0-9]{16}$/u.test(managedInstance))
    throw new Error("The managed Codex installation identity is invalid");
  const owned = (directory: string): string =>
    managedInstance === undefined
      ? join(configDir, directory)
      : join(configDir, directory, managedInstance);
  const home = owned(CODEX_HOME_DIR);
  return {
    home,
    sharedAuth: join(home, "auth.json"),
    poolHomeBase: owned(CODEX_POOL_HOME_DIR),
    workspace: owned(CODEX_WORKSPACE_DIR),
    poolWorkspaceBase: owned(CODEX_POOL_WORKSPACE_DIR),
    runtimeStore: join(configDir, CODEX_RUNTIME_STORE_DIR),
    runtimeVersions: join(configDir, CODEX_RUNTIME_STORE_DIR, "versions"),
    runtimeStaging: join(configDir, CODEX_RUNTIME_STORE_DIR, "staging"),
    runtimeCurrent: join(configDir, CODEX_RUNTIME_STORE_DIR, "current.json"),
    runtimeUpdateLock: join(configDir, CODEX_RUNTIME_STORE_DIR, "update.lock"),
  };
}
