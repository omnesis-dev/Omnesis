// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the helper program is looked for, and why it was not found. */
export type HelperBinary = { path: string } | { path: null; reason: string };

const BUILT_IN_TREE = fileURLToPath(
  new URL(
    `../../../tailnet-helper/dist/bin/omnesis-tailnet${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this installation has the helper program, which is what gives a gateway its
 * own Tailscale device: `OMNESIS_TAILSCALE_HELPER` names one (a wrong one is reported
 * once the owner turns the device on), or this source tree has built it.
 */
export function helperInstalled(
  env: NodeJS.ProcessEnv = process.env,
  builtIn: string = BUILT_IN_TREE,
): boolean {
  return Boolean(env.OMNESIS_TAILSCALE_HELPER?.trim()) || executable(builtIn);
}

/**
 * The helper program to run: `OMNESIS_TAILSCALE_HELPER` when set (the Docker
 * image sets it), otherwise the copy this source tree's build made.
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
      "This gateway was installed without its Tailscale helper program. The Docker image includes it, and a source install builds it when it installs or updates; to build it now, run `npm run tailnet-helper:build` in the source checkout. Or set OMNESIS_TAILSCALE_HELPER to the program's absolute path.",
  };
}
