// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Resolves the absolute command line a service unit should exec for a
 * component. Service managers start daemons with a minimal environment and
 * no shell, so the unit must carry an absolute path that stays valid across
 * logins — never a bare `omnesis` resolved through the caller's PATH.
 *
 * Precedence:
 *   1. `--exec <path>` flag
 *   2. `$OMNESIS_SERVICE_EXEC`
 *   3. `which omnesis`
 *   4. compiled installs: when the CLI itself is running as a `.js`
 *      entry, exec `[node, <that entry>]` directly
 *   5. source checkouts: when the CLI is running as a `.ts` entry, exec
 *      `[node, --import, <checkout tsx loader URL>, <that entry>]`, so the
 *      checkout runs without depending on a platform-specific shell shim
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { CliError, EXIT_USER_ERROR } from "@omnesis/cli-shared";
import { COMPONENT_ARGV, type ServiceComponent } from "./types.js";
import { defaultExecRunner, type ExecRunner } from "./supervisor.js";

export interface ExecResolveDeps {
  env: Record<string, string | undefined>;
  /** The script the CLI process is running (`process.argv[1]`). */
  argv1: string | undefined;
  /** The node binary (`process.execPath`). */
  execPath: string;
  /** Locate a binary on PATH; null when not found. */
  which: (name: string) => Promise<string | null>;
  realpath: (path: string) => string;
  /** The source checkout's tsx loader; null when it is not installed. */
  sourceLoader: (entry: string) => string | null;
}

export function defaultExecResolveDeps(exec: ExecRunner = defaultExecRunner): ExecResolveDeps {
  return {
    env: process.env,
    argv1: process.argv[1],
    execPath: process.execPath,
    which: async (name) => {
      const res = await exec(process.platform === "win32" ? "where.exe" : "which", [name]);
      const found = res.stdout.trim().split(/\r?\n/)[0];
      return res.code === 0 && found ? found : null;
    },
    realpath: (path) => realpathSync(path),
    sourceLoader: (entry) => {
      try {
        return createRequire(pathToFileURL(entry)).resolve("tsx");
      } catch {
        return null;
      }
    },
  };
}

/** Binary name a component resolves through PATH. */
export function serviceBinaryName(component: ServiceComponent): string {
  void component;
  return "omnesis";
}

/**
 * Resolve the full command line (absolute executable + argv) for a
 * component's service unit. Throws a user error when nothing resolves.
 */
export async function resolveServiceExec(
  component: ServiceComponent,
  execFlag: string | undefined,
  deps: ExecResolveDeps,
): Promise<string[]> {
  const suffix = [...COMPONENT_ARGV[component]];

  const override = execFlag ?? deps.env.OMNESIS_SERVICE_EXEC;
  if (override) return [resolve(override), ...suffix];

  const binName = serviceBinaryName(component);
  const found = await deps.which(binName);
  if (found) return [found, ...suffix];

  if (deps.argv1 !== undefined && deps.argv1.endsWith(".js")) {
    return [deps.execPath, deps.realpath(deps.argv1), ...suffix];
  }

  if (deps.argv1 !== undefined && deps.argv1.endsWith(".ts")) {
    const entry = deps.realpath(deps.argv1);
    const loader = deps.sourceLoader(entry);
    if (loader) return [deps.execPath, "--import", pathToFileURL(loader).href, entry, ...suffix];
  }

  throw new CliError(
    `${binName} is not on PATH — install it globally or pass --exec <path>.`,
    EXIT_USER_ERROR,
  );
}
