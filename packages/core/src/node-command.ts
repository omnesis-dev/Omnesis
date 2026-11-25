// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { stat } from "node:fs/promises";
import { fstatSync, lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { StdioOptions } from "node:child_process";

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
  const managed = managedNpmInvocation(opts.command ?? "npm", args);
  if (managed) return managed;
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
    return managedNodeInvocation([command, ...args]);
  }
  return managedRuntimeExecutableInvocation(command, args);
}

export interface ManagedRuntimeLauncher {
  root: string;
  launcher: string;
  preload: string;
  data?: ManagedDesktopDataContext;
}
export interface ManagedDesktopDataScope {
  format: 1;
  configDir: string;
  instance: string;
  secretService: string;
  restoreActivation?: { operationId: string; attemptId: string; epoch: string | null };
}
export type ManagedDesktopDataPurpose =
  "erase" | "restore" | "rollback" | "update-snapshot" | "update-rollback";
export interface ManagedDesktopDataContext {
  format: 1;
  scope: ManagedDesktopDataScope;
  lease: { device: string; inode: string };
  exclusive?: { purpose: ManagedDesktopDataPurpose; operationId: string };
}
const dataDescriptor = 7;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

/** Native-preload metadata is useful only with the actual inherited private lease inode. */
export function assertManagedDesktopDataAuthority(
  scope: Omit<ManagedDesktopDataScope, "format">,
  purpose: ManagedDesktopDataPurpose,
  operationId: string,
): void {
  const data = managed?.data;
  if (
    !data?.exclusive ||
    data.exclusive.purpose !== purpose ||
    data.exclusive.operationId !== operationId ||
    data.scope.configDir !== scope.configDir ||
    data.scope.instance !== scope.instance ||
    data.scope.secretService !== scope.secretService
  )
    throw new Error("The managed data operation requires its native exclusive authority");
  assertManagedDesktopDataDescriptor(data);
}

/** Pure metadata validation; the native adapter establishes and retains the kernel lock. */
export function assertManagedDesktopDataDescriptor(data: ManagedDesktopDataContext): void {
  const scope = data.scope;
  if (
    data.format !== 1 ||
    scope.format !== 1 ||
    !isAbsolute(scope.configDir) ||
    resolve(scope.configDir) !== scope.configDir ||
    !/^desktop-[a-f0-9]{16}$/u.test(scope.instance) ||
    !/^dev\.omnesis\.desktop\.[a-f0-9]{64}$/u.test(scope.secretService) ||
    !/^\d+$/u.test(data.lease.device) ||
    !/^\d+$/u.test(data.lease.inode) ||
    (data.exclusive &&
      (!uuidPattern.test(data.exclusive.operationId) ||
        !["erase", "restore", "rollback", "update-snapshot", "update-rollback"].includes(
          data.exclusive.purpose,
        )))
  )
    throw new Error("The managed data authority metadata is invalid");
  const held = fstatSync(dataDescriptor, { bigint: true });
  const path = join(
    `${scope.configDir}.bootstrap`,
    `.data-use-${scope.secretService.slice(-64)}.lock`,
  );
  const published = lstatSync(path, { bigint: true });
  if (
    !held.isFile() ||
    held.nlink !== 1n ||
    (held.mode & 0o077n) !== 0n ||
    (process.getuid && held.uid !== BigInt(process.getuid())) ||
    published.isSymbolicLink() ||
    held.dev !== published.dev ||
    held.ino !== published.ino ||
    held.dev.toString() !== data.lease.device ||
    held.ino.toString() !== data.lease.inode
  )
    throw new Error("The managed data authority descriptor is unavailable");
}

/** The operation entry is fixed by the native adapter; request secrets stay on private stdin. */
export function managedDesktopDataOperationInvocation(
  scope: Omit<ManagedDesktopDataScope, "format">,
  purpose: ManagedDesktopDataPurpose,
  operationId: string,
): { command: string; args: string[] } {
  if (
    !managed ||
    managed.data ||
    !uuidPattern.test(operationId) ||
    !["erase", "restore", "rollback", "update-snapshot", "update-rollback"].includes(purpose)
  )
    throw new Error("The data operation requires the installed controller runtime");
  return {
    command: managed.launcher,
    args: [
      "--data-exclusive",
      purpose,
      operationId,
      Buffer.from(JSON.stringify({ format: 1, ...scope })).toString("base64url"),
    ],
  };
}

/** Controller preview workers pin the exact profile even when their env is independently curated. */
export function managedDesktopDataConsumerInvocation(
  scope: Omit<ManagedDesktopDataScope, "format">,
  args: readonly string[],
): { command: string; args: string[] } {
  if (!managed) return managedNodeInvocation(args);
  if (managed.data) {
    if (
      managed.data.scope.configDir !== scope.configDir ||
      managed.data.scope.instance !== scope.instance ||
      managed.data.scope.secretService !== scope.secretService
    )
      throw new Error("The managed data worker belongs to another installation");
    return managedNodeInvocation(args);
  }
  return {
    command: managed.launcher,
    args: [
      "--data-use",
      Buffer.from(JSON.stringify({ format: 1, ...scope })).toString("base64url"),
      "--node",
      ...args,
    ],
  };
}

/** Only exclusive operation workers share the inherited open description; consumers reacquire SH. */
export function managedRuntimeSubprocessStdio(stdio: StdioOptions): StdioOptions {
  if (!managed?.data?.exclusive) return stdio;
  assertManagedDesktopDataDescriptor(managed.data);
  if (!Array.isArray(stdio))
    throw new Error("Exclusive data workers require explicit private streams");
  const result = [...stdio];
  while (result.length <= dataDescriptor) result.push("ignore");
  if (result[dataDescriptor] !== "ignore" && result[dataDescriptor] !== dataDescriptor)
    throw new Error("The exclusive data descriptor must remain reserved");
  result[dataDescriptor] = dataDescriptor;
  return result;
}
function managedDataArguments(): string[] {
  const data = managed?.data;
  if (!data) return [];
  const encoded = Buffer.from(JSON.stringify(data.scope)).toString("base64url");
  return data.exclusive
    ? ["--data-inherit", data.exclusive.purpose, data.exclusive.operationId, encoded]
    : ["--data-use", encoded];
}
let managed: Readonly<ManagedRuntimeLauncher> | undefined;
/** Installed only by the authenticated payload's fixed Node preload, never environment values. */
export function installManagedRuntimeLauncher(value: ManagedRuntimeLauncher): void {
  if (
    !isAbsolute(value.root) ||
    value.launcher !== join(value.root, "runtime-exec") ||
    value.preload !== join(value.root, "packages/core/dist/managed-runtime-bootstrap.js")
  )
    throw new Error("Invalid managed runtime launcher");
  if (managed && JSON.stringify(managed) !== JSON.stringify(value))
    throw new Error("The managed runtime identity cannot change while this process is running");
  if (value.data) assertManagedDesktopDataDescriptor(value.data);
  managed = Object.freeze({
    ...value,
    ...(value.data ? { data: Object.freeze(structuredClone(value.data)) } : {}),
  });
}
export function managedRuntimePreload(): string[] {
  if (!managed) return [];
  const preload = pathToFileURL(managed.preload);
  // Worker isolates share this OS descriptor but not module state. Their own fixed preload
  // receives metadata explicitly even after the controller curated process.env.
  if (managed.data)
    preload.searchParams.set(
      "data",
      Buffer.from(JSON.stringify(managed.data)).toString("base64url"),
    );
  return ["--use-system-ca", "--import", preload.href];
}
export function managedNodeInvocation(args: readonly string[]): {
  command: string;
  args: string[];
} {
  return managed
    ? { command: managed.launcher, args: [...managedDataArguments(), "--node", ...args] }
    : { command: process.execPath, args: [...args] };
}
export function managedNpmInvocation(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } | null {
  if (
    !managed ||
    !["npm", "npx", join(managed.root, "npm"), join(managed.root, "npx")].includes(command)
  )
    return null;
  const cli = command.endsWith("npx") ? "npx-cli.js" : "npm-cli.js";
  return managedNodeInvocation([join(managed.root, "lib/node_modules/npm/bin", cli), ...args]);
}
/** Every directly owned child retains its epoch, including external interpreters reading payload files. */
export function managedRuntimeExecutableInvocation(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (!managed) return { command, args: [...args] };
  if (command === managed.launcher)
    return {
      command,
      args: args[0]?.startsWith("--data-") ? [...args] : [...managedDataArguments(), ...args],
    };
  const npm = managedNpmInvocation(command, args);
  if (npm) return npm;
  if (command === process.execPath || command === "node") return managedNodeInvocation(args);
  if (isAbsolute(command)) {
    const local = relative(managed.root, resolve(command));
    if (
      local &&
      !isAbsolute(local) &&
      local !== ".." &&
      !local.startsWith(`..${sep}`) &&
      command !== managed.launcher
    )
      return {
        command: managed.launcher,
        args: [...managedDataArguments(), "--exec", local.split(sep).join("/"), ...args],
      };
  }
  return {
    command: managed.launcher,
    args: [...managedDataArguments(), "--external", command, ...args],
  };
}

/** Only exact, secret-free absence selectors may name a proposed fresh generation. */
export function managedDesktopMetadataInvocation(
  command: string,
  args: readonly string[],
  generation: string,
): NodeCommandInvocation {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(generation) ||
    !["security", "/usr/bin/security"].includes(command) ||
    args.length !== 5 ||
    args[0] !== "find-generic-password" ||
    args[1] !== "-a" ||
    args[3] !== "-s"
  )
    throw new Error("Invalid fresh-generation metadata request");
  if (!managed) return { command, args: [...args] };
  return {
    command: managed.launcher,
    args: ["--metadata-generation", generation, "--external", "/usr/bin/security", ...args],
  };
}
