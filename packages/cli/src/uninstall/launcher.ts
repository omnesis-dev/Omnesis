// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What `~/.local/bin/omnesis` is. The installer writes one of three launchers
 * there — a source checkout's front door, a global package's prefix-pinning
 * shim, or the Docker wrapper — and each names, in its own text, what it
 * fronts. Anything else at that path (a symlink, an `npm link`, a script of the
 * operator's own) is not the installer's and is never removed.
 */

import { lstatSync, readFileSync } from "node:fs";
import { packageLauncher } from "../update/package-migration-plan.js";
import { sourceLauncherTargetsRoot } from "../update/source-launcher.js";

export type Launcher =
  | { kind: "absent"; path: string }
  | { kind: "source"; path: string; sourceRoot: string; configDir: string | null }
  | { kind: "package"; path: string; prefix: string; executable: string }
  | { kind: "docker"; path: string; composeFile: string }
  | { kind: "foreign"; path: string; reason: string };

/** The comment `docker_write_wrapper` puts on the wrapper's second line. */
export const DOCKER_WRAPPER_MARKER = "# Omnesis in Docker — written by install.sh --docker.";

/**
 * Read one shell word the installer wrote with `shell_single_quote`: single
 * quoted runs, joined by `"'"` for an embedded quote. Null for anything else,
 * so an assignment that needs real shell to evaluate is never guessed at.
 */
export function parseShellQuoted(word: string): string | null {
  let out = "";
  let rest = word;
  if (rest === "") return null;
  while (rest !== "") {
    const single = /^'([^']*)'/.exec(rest);
    if (single) {
      out += single[1];
      rest = rest.slice(single[0].length);
      continue;
    }
    if (rest.startsWith(`"'"`)) {
      out += "'";
      rest = rest.slice(3);
      continue;
    }
    return null;
  }
  return out;
}

function assignment(content: string, name: string): string | null {
  const match = new RegExp(`^${name}=(.*)$`, "m").exec(content);
  return match ? parseShellQuoted(match[1]!) : null;
}

/** Classify the launcher's text, without touching the disk. */
export function classifyLauncherText(path: string, content: string): Launcher {
  if (!content.startsWith("#!/bin/sh\n")) {
    return { kind: "foreign", path, reason: "it is not a launcher the installer writes" };
  }
  if (content.split("\n")[1] === DOCKER_WRAPPER_MARKER) {
    const composeFile = assignment(content, "COMPOSE_FILE");
    return composeFile
      ? { kind: "docker", path, composeFile }
      : { kind: "foreign", path, reason: "its Docker wrapper names no compose file" };
  }
  const sourceRoot = assignment(content, "SOURCE_ROOT");
  if (sourceRoot !== null) {
    return sourceLauncherTargetsRoot(content, sourceRoot)
      ? { kind: "source", path, sourceRoot, configDir: assignment(content, "DEFAULT_CONFIG_DIR") }
      : { kind: "foreign", path, reason: "it does not run the checkout it names" };
  }
  const prefix = assignment(content, "NPM_CONFIG_PREFIX");
  const exec = /^exec (.*) "\$@"$/m.exec(content);
  const executable = exec ? parseShellQuoted(exec[1]!) : null;
  if (prefix !== null && executable !== null && content === packageLauncher(prefix, executable)) {
    return { kind: "package", path, prefix, executable };
  }
  return { kind: "foreign", path, reason: "it is not a launcher the installer writes" };
}

/** Classify whatever is at `path`. A symlink or a directory is never the installer's. */
export function readLauncher(path: string): Launcher {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { kind: "absent", path };
  }
  if (stat.isSymbolicLink()) return { kind: "foreign", path, reason: "it is a symbolic link" };
  if (!stat.isFile()) return { kind: "foreign", path, reason: "it is not a regular file" };
  if (stat.size > 1024 * 1024) return { kind: "foreign", path, reason: "it is too large" };
  return classifyLauncherText(path, readFileSync(path, "utf8"));
}
