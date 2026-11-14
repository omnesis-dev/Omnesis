// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Literal harness invocation, including npm's Windows JavaScript launchers. */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  isAbsolute,
  dirname,
  extname,
  join,
  relative,
  resolve,
  win32,
  posix,
} from "node:path";
import type { Harness } from "./protocol.js";

export interface HarnessResolutionOptions {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
  isExecutable?: (path: string) => boolean;
}

export function harnessSearchPath(env: NodeJS.ProcessEnv, platform = process.platform): string {
  if (env.PATH !== undefined || platform !== "win32") return env.PATH ?? "";
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key ? (env[key] ?? "") : "";
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** PATH first, then the same service-manager fallback locations as on Unix. */
export function resolveHarnessBinary(
  harness: Harness,
  opts: HarnessResolutionOptions = {},
): string | null {
  return resolveKnownBinary(harness, opts);
}
function resolveKnownBinary(
  harness: Harness | "omnesis",
  opts: HarnessResolutionOptions,
): string | null {
  const platform = opts.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const env = opts.env ?? process.env;
  const home = env.HOME ?? (platform === "win32" ? env.USERPROFILE : undefined) ?? homedir();
  const isExecutable = opts.isExecutable ?? executableFile;
  const directories = [
    ...harnessSearchPath(env, platform).split(paths.delimiter).filter(Boolean),
    paths.dirname(opts.execPath ?? process.execPath),
    ...(platform === "win32"
      ? [
          ...(env.APPDATA ? [paths.join(env.APPDATA, "npm")] : []),
          paths.join(home, ".npm-global"),
          paths.join(home, ".local", "bin"),
        ]
      : [
          paths.join(home, ".npm-global", "bin"),
          paths.join(home, ".local", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
        ]),
  ];
  for (const directory of directories) {
    for (const suffix of platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const candidate = paths.join(directory, harness + suffix);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export interface HarnessCommand {
  command: string;
  args: string[];
}

/** Never parse a .cmd file or pass caller arguments through cmd.exe. */
export function resolveHarnessCommand(
  command: string,
  args: readonly string[],
  opts: HarnessResolutionOptions = {},
): HarnessCommand {
  if ((opts.platform ?? process.platform) !== "win32") return { command, args: [...args] };
  const harness = /^(openclaw|hermes|omnesis)$/i.test(command)
    ? (command.toLowerCase() as Harness | "omnesis")
    : null;
  const discovered = harness ? resolveKnownBinary(harness, opts) : command;
  if (!discovered) return { command, args: [...args] };
  const binary = discovered;
  const extension = extname(binary).toLowerCase();
  const npmName = basename(binary)
    .toLowerCase()
    .replace(/\.cmd$/, "");
  const knownNpm = npmName === "openclaw" || npmName === "omnesis";
  if (extension === ".exe" || (!extension && !harness && !knownNpm))
    return { command: binary, args: [...args] };
  if (knownNpm) {
    const packageRoot =
      basename(dirname(binary)).toLowerCase() === ".bin"
        ? resolve(dirname(binary), "..", npmName)
        : join(dirname(binary), "node_modules", npmName);
    const manifestPath = join(packageRoot, "package.json");
    try {
      if (statSync(manifestPath).size > 1024 * 1024) throw new Error("oversized manifest");
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        !manifest ||
        typeof manifest !== "object" ||
        !("name" in manifest) ||
        manifest.name !== npmName
      )
        throw new Error("unexpected package name");
      const bin =
        manifest && typeof manifest === "object" && "bin" in manifest ? manifest.bin : undefined;
      const entry =
        typeof bin === "string"
          ? bin
          : bin && typeof bin === "object" && npmName in bin
            ? (bin as Record<string, unknown>)[npmName]
            : undefined;
      if (typeof entry !== "string" || !entry || entry.includes("\0"))
        throw new Error("missing bin entry");
      const target = resolve(packageRoot, entry),
        inside = relative(packageRoot, target);
      if (
        !inside ||
        isAbsolute(inside) ||
        inside === ".." ||
        inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        resolve(target) === resolve(packageRoot) ||
        ![".js", ".mjs", ".cjs"].includes(extname(target).toLowerCase()) ||
        !statSync(target).isFile()
      )
        throw new Error("invalid bin entry");
      return { command: opts.execPath ?? process.execPath, args: [target, ...args] };
    } catch (error) {
      throw new Error(
        `Cannot resolve the installed ${npmName === "openclaw" ? "OpenClaw" : "Omnesis"} JavaScript entrypoint on Windows; reinstall ${npmName === "openclaw" ? "OpenClaw" : "Omnesis"} with npm.`,
        { cause: error },
      );
    }
  }
  if ([".cmd", ".bat", ".ps1"].includes(extension))
    throw new Error(
      "Windows harness commands require a native executable or a supported installed JavaScript entrypoint.",
    );
  return { command: binary, args: [...args] };
}
