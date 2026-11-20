// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The toolchain a source update's `npm ci` needs, checked before the checkout
 * moves.
 *
 * A source tree carries native modules — better-sqlite3 and its ciphers
 * variant, usearch, tree-sitter — whose packages ship a `binding.gyp`. When a
 * release's dependency set has no prebuilt binary for this platform, npm
 * compiles them, and a machine with no compiler fails inside `npm ci` with
 * `gyp ERR! stack Error: not found: make`. That is a rollback and a message
 * naming npm, not the missing prerequisite, on a machine the operator cannot
 * tell is one package away from updating.
 *
 * The installer solves this for a fresh machine: `ensure_source_build_tools()`
 * in scripts/install.sh installs the toolchain before it builds. An update
 * runs on a machine that installer may never have touched — one installed by
 * an older release, whose tree compiled from prebuilt binaries at the time —
 * so it has to make the same demand. It does not install anything: an update
 * is not the moment to acquire root, and the checkout has not moved yet, so
 * refusing costs the operator nothing but the command they need to run.
 *
 * The same four tools as the installer's shell check, for the same reason: a
 * name on PATH that cannot run is not a toolchain, so each is executed.
 */

import { spawnSync } from "node:child_process";
import { resolveNpmInvocation } from "@omnesis/core";

/** The commands a native build invokes, in the order an operator reads them. */
export const REQUIRED_BUILD_TOOLS = ["make", "cc", "c++", "python3"] as const;

export type BuildTool = (typeof REQUIRED_BUILD_TOOLS)[number];

/**
 * How a machine is asked what it has; injected so the policy is testable.
 *
 * One question for both the toolchain and the package manager that would
 * install it, because it is the same question: running `--version` answers
 * whether the command exists *and* whether it can execute, and a name on PATH
 * that cannot execute is no use to either caller.
 */
export interface BuildToolProbe {
  platform: string;
  /** Whether `<command> --version` runs and succeeds. */
  runs(command: string): boolean;
}

/**
 * The tools a source build needs and this machine does not have.
 *
 * Empty off Linux: macOS gets its toolchain from Xcode's command-line tools, which
 * the installer's Homebrew requirement already implies, and no other platform
 * runs a source update.
 */
export function missingBuildTools(probe: BuildToolProbe): BuildTool[] {
  if (probe.platform !== "linux") return [];
  return REQUIRED_BUILD_TOOLS.filter((tool) => !probe.runs(tool));
}

/**
 * The command this machine's operator should run, or null when no package
 * manager this code knows is present — in which case the refusal names the
 * tools and leaves the distribution's own package names to the operator.
 */
export function buildToolsInstallCommand(probe: BuildToolProbe): string | null {
  if (probe.runs("apt-get")) return "sudo apt-get install -y build-essential python3";
  if (probe.runs("dnf")) return "sudo dnf install -y gcc-c++ make python3";
  return null;
}

/**
 * The whole refusal, as the operator reads it: what is missing, why an update
 * needs it, and the one command that fixes it.
 */
export function buildToolsRefusal(missing: readonly BuildTool[], command: string | null): string {
  const names = missing.join(", ");
  const it = missing.length === 1 ? "it" : "them";
  const fix = command
    ? `Install ${it} with: ${command}`
    : "Install your distribution's C/C++ compilers, make and Python 3.";
  return (
    `This update builds native modules from source and this machine is missing ${names}. ` +
    `${fix} Then re-run \`omnesis update\`. ` +
    `Nothing has been changed, so the installation is still on its current release.`
  );
}

/**
 * The refusal for a machine where `npm` does not run, or null where it does.
 *
 * Asked on every platform, unlike the toolchain. The update spawns `npm ci` by
 * name, and a service's PATH can hold `node` with no `npm` beside it. Once the
 * checkout has moved that is exit 127, a rollback whose own `npm ci` exits 127
 * too, and an unfinished update that refuses every later command.
 *
 * With `host`, the refusal ends by naming the directory of the Node running
 * the update and the PATH that was searched. An operator reading a fleet
 * update's result is not on that machine and cannot see either, and "beside
 * the node it runs" is that directory. They come last because a PATH can be
 * any length and a collector relays only the start of a long message.
 */
export function npmRefusal(
  probe: BuildToolProbe,
  host?: { nodeDir: string; path: string | undefined },
): string | null {
  if (probe.runs("npm")) return null;
  return (
    "This update runs `npm ci`, and `npm` does not run on this PATH. " +
    "An update a collector or gateway service runs uses that service's PATH, " +
    "so put `npm` there, for example beside the `node` it runs, then re-run `omnesis update`. " +
    "Nothing has been changed, so the installation is still on its current release." +
    (host ? ` That node is in ${host.nodeDir}, and the PATH is ${host.path || "empty"}.` : "")
  );
}

/** Probe npm through its JavaScript entry on Windows, without a batch shell. */
export async function nodeNpmRefusal(
  host?: { nodeDir: string; path: string | undefined },
  resolveNpm: typeof resolveNpmInvocation = resolveNpmInvocation,
): Promise<string | null> {
  let available = false;
  try {
    const invocation = await resolveNpm(["--version"]);
    const result = spawnSync(invocation.command, invocation.args, { stdio: "ignore" });
    available = !result.error && result.status === 0;
  } catch {
    // A missing or unreadable npm installation is the same actionable refusal.
  }
  return npmRefusal({ platform: process.platform, runs: () => available }, host);
}

function versionRuns(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], { stdio: "ignore" });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

export const nodeBuildToolProbe: BuildToolProbe = {
  platform: process.platform,
  runs: versionRuns,
};
