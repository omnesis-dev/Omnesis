// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { homedir } from "node:os";
import { homebrewCliPaths } from "./host-cli.js";

export interface TailscaleCliCandidate {
  file: string;
  bundledApp: boolean;
}

/**
 * Prefer a CLI on PATH, then Homebrew's CLI where PATH does not reach it, then
 * the CLI bundled with either macOS app variant.
 */
export function tailscaleCliCandidates(
  platform: NodeJS.Platform = process.platform,
  homeDir: string | undefined = homedir(),
  pathEnv: string = process.env.PATH ?? "",
): TailscaleCliCandidate[] {
  const candidates: TailscaleCliCandidate[] = [{ file: "tailscale", bundledApp: false }];
  if (platform === "darwin") {
    for (const file of homebrewCliPaths("tailscale", platform, pathEnv)) {
      candidates.push({ file, bundledApp: false });
    }
    candidates.push({
      file: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      bundledApp: true,
    });
    if (homeDir) {
      candidates.push({
        file: join(homeDir, "Applications/Tailscale.app/Contents/MacOS/Tailscale"),
        bundledApp: true,
      });
    }
  }
  return candidates;
}

/** macOS app executables need this flag when invoked outside an interactive shell. */
export function tailscaleCliEnv(
  candidate: TailscaleCliCandidate,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return candidate.bundledApp ? { ...baseEnv, TAILSCALE_BE_CLI: "1" } : baseEnv;
}

/** A status command can exit successfully even when Tailscale needs login. */
export function tailscaleIsRunningStatus(output: string): boolean {
  try {
    return (JSON.parse(output) as { BackendState?: unknown }).BackendState === "Running";
  } catch {
    return false;
  }
}

/**
 * How long a `tailscale status --json` may take outside the gateway's 2s
 * pairing discovery. A healthy CLI answers at once; one that hangs (a wedged
 * daemon, an app waiting on its GUI) must not stall renewal or provisioning.
 */
export const TAILSCALE_STATUS_TIMEOUT_MS = 10_000;
