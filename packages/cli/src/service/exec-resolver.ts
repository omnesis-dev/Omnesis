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
 *      `[<checkout>/node_modules/.bin/tsx, <that entry>]` — the same command
 *      line the `~/.local/bin/omnesis` wrapper runs, so a checkout whose
 *      wrapper directory is off PATH still registers a working unit
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  /** Whether a path exists on disk. */
  exists: (path: string) => boolean;
}

export function defaultExecResolveDeps(exec: ExecRunner = defaultExecRunner): ExecResolveDeps {
  return {
    env: process.env,
    argv1: process.argv[1],
    execPath: process.execPath,
    which: async (name) => {
      const res = await exec("which", [name]);
      const found = res.stdout.trim();
      return res.code === 0 && found ? found : null;
    },
    realpath: (path) => realpathSync(path),
    exists: (path) => existsSync(path),
  };
}

/**
 * The TypeScript runner a source checkout uses to run the CLI. Walks up from
 * the entry file to the workspace root that owns the installed `tsx` binary,
 * so a checkout at any depth resolves. Null when there is no such runner —
 * a `.ts` entry executed by something other than a workspace install.
 */
function findSourceRunner(entry: string, exists: (path: string) => boolean): string | null {
  let dir = dirname(entry);
  for (;;) {
    const runner = join(dir, "node_modules", ".bin", "tsx");
    if (exists(runner)) return runner;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
    const runner = findSourceRunner(entry, deps.exists);
    if (runner) return [runner, entry, ...suffix];
  }

  throw new CliError(
    `${binName} is not on PATH — install it globally or pass --exec <path>.`,
    EXIT_USER_ERROR,
  );
}
