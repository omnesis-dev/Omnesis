// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { delimiter, dirname } from "node:path";

/** Homebrew's bin directories: Apple Silicon's prefix, then Intel's. */
const HOMEBREW_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * A Homebrew-installed tool by absolute path, for each Homebrew bin directory
 * `pathEnv` does not already cover. A launchd service's PATH is not a login
 * shell's: on Apple Silicon it lacks `/opt/homebrew/bin`, so the gateway would
 * not find a tool the installer found. Empty outside macOS.
 */
export function homebrewCliPaths(
  name: string,
  platform: NodeJS.Platform = process.platform,
  pathEnv: string = process.env.PATH ?? "",
): string[] {
  if (platform !== "darwin") return [];
  const onPath = new Set(pathEnv.split(delimiter));
  return HOMEBREW_BIN_DIRS.map((dir) => `${dir}/${name}`).filter(
    (file) => !onPath.has(dirname(file)),
  );
}

/** `mkcert` on PATH, then Homebrew's where PATH does not reach it. */
export function mkcertCliCandidates(
  platform: NodeJS.Platform = process.platform,
  pathEnv: string = process.env.PATH ?? "",
): string[] {
  return ["mkcert", ...homebrewCliPaths("mkcert", platform, pathEnv)];
}
