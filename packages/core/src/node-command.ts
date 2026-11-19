// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface ResolveNpmInvocationOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Node installation to search first; defaults to this process's executable. */
  nodePath?: string;
}

/** Resolve npm as an executable and argv, without interpreting any shell syntax. */
export async function resolveNpmInvocation(
  args: readonly string[],
  opts: ResolveNpmInvocationOptions = {},
): Promise<NodeCommandInvocation> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const inheritedCli =
    opts.command === undefined && platform === "win32"
      ? environmentValue(env, "npm_execpath", platform)
      : undefined;
  if (inheritedCli !== undefined) {
    if (
      !isAbsolute(inheritedCli) ||
      !/\.[cm]?js$/iu.test(inheritedCli) ||
      !(await stat(inheritedCli)).isFile()
    )
      throw new Error("npm_execpath must name an existing absolute JavaScript npm CLI");
    return nodeCommandInvocation(inheritedCli, args, platform);
  }
  const command = await resolveNpmCommand(
    opts.command ?? "npm",
    env,
    platform,
    opts.nodePath ?? process.execPath,
  );
  return nodeCommandInvocation(command, args, platform);
}

/**
 * Locate npm's JavaScript CLI without running a Windows batch shim. Only the
 * standard npm layout is recognized; an arbitrary batch file is never parsed.
 */
async function resolveNpmCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  nodePath: string = process.execPath,
): Promise<string> {
  if (platform !== "win32") return command;
  const name = basename(command);
  const isNpm = /^npm(?:\.cmd|\.bat)?$/iu.test(name);
  if (!isNpm) {
    if (/\.(?:cmd|bat)$/iu.test(name)) {
      throw new Error("Windows npmCommand must name npm.cmd, a JavaScript CLI, or an executable.");
    }
    return command;
  }
  const directories =
    command !== name
      ? [dirname(command)]
      : [
          dirname(nodePath),
          ...(environmentValue(env, "PATH", platform) ?? "")
            .split(";")
            .filter(Boolean)
            .map((entry) => entry.replace(/^"(.*)"$/u, "$1")),
        ];
  for (const directory of directories) {
    const cli = join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    try {
      if ((await stat(cli)).isFile()) return cli;
    } catch (err) {
      if (!["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
    }
  }
  throw new Error(
    "Cannot locate npm's JavaScript CLI on Windows. Install npm beside Node.js or set npmCommand to its npm-cli.js path.",
  );
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (env[key] !== undefined || platform !== "win32") return env[key];
  const actual = Object.keys(env).find((name) => name.toUpperCase() === key.toUpperCase());
  return actual === undefined ? undefined : env[actual];
}

export interface NodeCommandInvocation {
  command: string;
  args: string[];
}

/** Windows does not execute a JavaScript entry's shebang; pass it to Node directly. */
export function nodeCommandInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NodeCommandInvocation {
  if (platform === "win32" && /\.(?:[cm]?js)$/iu.test(command)) {
    return { command: process.execPath, args: [command, ...args] };
  }
  return { command, args: [...args] };
}
