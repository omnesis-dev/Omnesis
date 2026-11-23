// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where the Tailscale helper's build writes, relative to the repository root.
 * Everything goes under the package's dist/, which the root .gitignore's
 * generic `dist/` rule covers in every release. An update that rolls a source
 * checkout back to an older release leaves these files behind, and that
 * release's updater refuses to run while `git status` lists anything, so a
 * path outside dist/ here would block every later update of that checkout.
 */

import { join } from "node:path";

export const HELPER_DIR = "packages/tailnet-helper";
export const OUTPUT_DIR = join(HELPER_DIR, "dist");
/** The Go toolchain, module cache and build cache. */
export const GO_CACHE_DIR = join(OUTPUT_DIR, "go");

/** The helper program for a platform; `windows` takes the .exe suffix. */
export function helperProgram(windows = process.platform === "win32") {
  return join(OUTPUT_DIR, "bin", `omnesis-tailnet${windows ? ".exe" : ""}`);
}
