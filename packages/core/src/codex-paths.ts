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
 * The layout is two homes. One is the runtime's own; the other is a base under
 * which a pooled runtime gives each member an isolated home named by its index,
 * so concurrent turns do not share a working directory.
 */

import { join } from "node:path";

/** The single runtime's home, and the shared login every pooled member tracks. */
export const CODEX_HOME_DIR = "codex-home";
/** The base a pooled runtime's member homes sit under, one directory per index. */
export const CODEX_POOL_HOME_DIR = "codex-home-pool";
/** The single runtime's workspace, and the base for a pool's per-member ones. */
export const CODEX_WORKSPACE_DIR = "codex-workspace";
export const CODEX_POOL_WORKSPACE_DIR = "codex-workspace-pool";
export const CODEX_RUNTIME_STORE_DIR = "codex-runtimes";

/** Every Codex path, resolved against one config directory. */
export function codexPaths(configDir: string): {
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
  const home = join(configDir, CODEX_HOME_DIR);
  return {
    home,
    sharedAuth: join(home, "auth.json"),
    poolHomeBase: join(configDir, CODEX_POOL_HOME_DIR),
    workspace: join(configDir, CODEX_WORKSPACE_DIR),
    poolWorkspaceBase: join(configDir, CODEX_POOL_WORKSPACE_DIR),
    runtimeStore: join(configDir, CODEX_RUNTIME_STORE_DIR),
    runtimeVersions: join(configDir, CODEX_RUNTIME_STORE_DIR, "versions"),
    runtimeStaging: join(configDir, CODEX_RUNTIME_STORE_DIR, "staging"),
    runtimeCurrent: join(configDir, CODEX_RUNTIME_STORE_DIR, "current.json"),
    runtimeUpdateLock: join(configDir, CODEX_RUNTIME_STORE_DIR, "update.lock"),
  };
}
