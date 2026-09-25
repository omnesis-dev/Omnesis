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
 * Expand what an operator types into a path.
 *
 * Two conventions, both from the shell rather than the filesystem: a leading
 * tilde means the running user's home directory, and a bare relative path is
 * read against the process's working directory. Neither is understood by
 * `existsSync`, which is why the check has to go through here.
 */
export function expandHostPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
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
};
