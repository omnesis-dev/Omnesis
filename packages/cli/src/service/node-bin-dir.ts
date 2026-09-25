// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** `<prefix>/Cellar/<formula>/<version>/bin/node` — a node binary inside a Homebrew keg. */
const HOMEBREW_CELLAR_NODE = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;

/**
 * The directory a service unit should put first on PATH to find `node`.
 *
 * Node reports its resolved binary as `process.execPath`, so a Homebrew Node
 * resolves into its versioned keg (`/opt/homebrew/Cellar/node@24/24.1.0/bin`).
 * A `brew upgrade` followed by a cleanup deletes that directory, and a unit
 * that baked it in can no longer start. Homebrew's `<prefix>/opt/<formula>`
 * link follows upgrades, so it is used whenever it points at the same binary;
 * every other layout keeps the binary's own directory.
 */
export function stableNodeBinDir(
  execPath: string,
  realpath: (path: string) => string = realpathSync,
): string {
  const match = HOMEBREW_CELLAR_NODE.exec(execPath);
  if (match) {
    const [, prefix, formula] = match;
    const optBin = join(prefix!, "opt", formula!, "bin");
    try {
      if (realpath(join(optBin, "node")) === realpath(execPath)) return optBin;
    } catch {
      // No opt link for this keg (or it cannot be read): keep the keg path.
    }
  }
  return dirname(execPath);
}
