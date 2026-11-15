// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the helper program is looked for, and why it was not found. */
export type HelperBinary = { path: string } | { path: null; reason: string };

const BUILT_IN_TREE = fileURLToPath(
  new URL(
    `../../../tailnet-helper/bin/omnesis-tailnet${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The helper program to run: `OMNESIS_TAILSCALE_HELPER` when set (the Docker
 * image sets it), otherwise the copy built into this source tree by
 * `npm run tailnet-helper:build`.
 */
export function resolveHelperBinary(
  env: NodeJS.ProcessEnv = process.env,
  builtIn: string = BUILT_IN_TREE,
): HelperBinary {
  const configured = env.OMNESIS_TAILSCALE_HELPER?.trim();
  if (configured) {
    if (!isAbsolute(configured))
      return { path: null, reason: "OMNESIS_TAILSCALE_HELPER must be an absolute path." };
    return executable(configured)
      ? { path: configured }
      : {
          path: null,
          reason: `The Tailscale helper at ${configured} is missing or not executable.`,
        };
  }
  if (executable(builtIn)) return { path: builtIn };
  return {
    path: null,
    reason:
      "This gateway was installed without its Tailscale helper program. The Docker image includes it; in a source checkout, build it with `npm run tailnet-helper:build`. Or set OMNESIS_TAILSCALE_HELPER to the program's absolute path.",
  };
}
