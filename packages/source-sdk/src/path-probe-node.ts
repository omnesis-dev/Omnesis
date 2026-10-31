// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The host's filesystem, as a config schema sees it.
 *
 * Kept apart from the schema module so that module stays free of node
 * built-ins. The schema is data plus pure functions and is worth being able to
 * load anywhere; the filesystem behind it is a host detail, injected.
 */

import { accessSync, constants as fsConstants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { PathProbe } from "./config-schema.js";

/**
 * Set by a Docker install on the containers it runs: the home directory of the
 * account on the machine that runs Docker. The container's own account has a
 * home of its own that nobody types paths against, so inside a container `~`
 * means this one — the home the operator sees in Finder or a shell.
 */
export const HOST_HOME_ENV = "OMNESIS_HOST_HOME";

/** The home a typed `~` names: the Docker host's in a container, otherwise the running user's. */
export function hostHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const host = env[HOST_HOME_ENV];
  return host && isAbsolute(host) ? host : homedir();
}

/**
 * Expand what an operator types into a path.
 *
 * Two conventions, both from the shell rather than the filesystem: a leading
 * tilde means the operator's home directory (see `hostHomeDir`), and a bare
 * relative path is read against the process's working directory. Neither is
 * understood by `existsSync`, which is why the check has to go through here.
 */
export function expandHostPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return trimmed;
  if (trimmed === "~") return hostHomeDir();
  if (trimmed.startsWith("~/")) return join(hostHomeDir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

/**
 * What a missing path means when this process runs in a Docker install's
 * container, or undefined anywhere else. The container sees the install's
 * config directory and the host folders shared with it, nothing more, so a
 * path that exists on the operator's machine reads as missing here; saying
 * only "does not exist" sends them looking for a typo.
 */
export function containerPathHint(
  resolved: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!env[HOST_HOME_ENV]) return undefined;
  const quoted = `'${resolved.replaceAll("'", `'\\''`)}'`;
  return (
    "This collector runs in a Docker container, which sees only the install's config " +
    "directory and the folders shared with it. If the folder is on the machine that runs " +
    `Docker, share it with the collector there: omnesis folders share ${quoted}`
  );
}

/** The probe a collector supplies when it checks a declared configuration. */
export const nodePathProbe: PathProbe = {
  resolve: expandHostPath,
  exists: (path) => existsSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      // A path that cannot be stat'd is reported as "not a directory" rather
      // than throwing: the caller has already established that it exists, so
      // this is a permission or a race, and either way the answer is no.
      return false;
    }
  },
  readable: (path) => {
    try {
      // A folder has to be listed and entered, so it needs execute as well.
      const mode = statSync(path).isDirectory()
        ? fsConstants.R_OK | fsConstants.X_OK
        : fsConstants.R_OK;
      accessSync(path, mode);
      return true;
    } catch {
      return false;
    }
  },
  join: (...parts) => join(...parts),
  missingHint: (path) => containerPathHint(path),
};
