// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether this CLI runs inside an installer-managed Docker install, and what
 * that install looks like from in here.
 *
 * The installer records `docker` in `<config>/install-method` and mounts the
 * host's config directory into every container at the same absolute path, so
 * the marker is readable from inside and every path under it names the same
 * file on the host. A host that only collects gives its collector container
 * `<config>/collector` as its config directory, so the marker is one level up.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, relative, isAbsolute } from "node:path";
import { detectDockerInstall } from "@omnesis/core/release-check";
import { detectDockerRoles } from "./update/detect.js";

/** The compose services that run an Omnesis daemon. */
export type DockerDaemonService = "gateway" | "collector";

export interface DockerContext {
  /** The host config directory the compose file lives in. */
  projectDir: string;
  composeFile: string;
  /** The daemon services the compose project declares. */
  services: DockerDaemonService[];
  /** A host that only collects: its CLI's config directory is `<projectDir>/collector`. */
  collectorOnly: boolean;
}

/** The Docker install `configDir` belongs to, or null for any other install. */
export function detectDockerContext(
  configDir: string,
  readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): DockerContext | null {
  const own = detectDockerInstall(configDir);
  const parent =
    own === null && basename(configDir) === "collector"
      ? detectDockerInstall(dirname(configDir))
      : null;
  const install = own ?? parent;
  if (!install || install.method !== "docker") return null;
  let composeText = "";
  try {
    composeText = readText(install.composeFile);
  } catch {
    // Unreadable reads as declaring nothing; callers say so.
  }
  const roles = detectDockerRoles(composeText, install.composeFile);
  const services: DockerDaemonService[] = [];
  if (roles.gateway.present) services.push("gateway");
  if (roles.collector.present) services.push("collector");
  return {
    projectDir: install.projectDir,
    composeFile: install.composeFile,
    services,
    collectorOnly: parent !== null,
  };
}

/** Whether `path` is `dir` or inside it. */
export function isWithinDir(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
