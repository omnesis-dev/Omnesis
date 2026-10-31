// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A path as the operator typed it, read on their machine. Inside a Docker
 * install's container the launcher passes the host's home and working
 * directory in, because the container's own name nothing the operator knows.
 */

import { isAbsolute, join, resolve } from "node:path";
import { hostHomeDir } from "@omnesis/source-sdk";

/** The directory the operator ran `omnesis` from on the host. */
const HOST_CWD_ENV = "OMNESIS_HOST_CWD";

/**
 * What the operator typed, as a path on their machine. Outside a container
 * this is the shell's reading; inside one, `~` and relative paths are taken
 * against the host home and working directory the launcher passed in.
 */
export function resolveOperatorPath(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = value.trim();
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return join(hostHomeDir(env), trimmed.slice(1));
  }
  if (isAbsolute(trimmed)) return trimmed;
  const cwd = env[HOST_CWD_ENV];
  return cwd && isAbsolute(cwd) ? resolve(cwd, trimmed) : resolve(trimmed);
}
