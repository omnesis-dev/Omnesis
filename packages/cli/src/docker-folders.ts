// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Host paths, seen from the CLI a Docker install runs in a container.
 *
 * The operator types paths as they are on their own machine: `~` is their
 * home there, a relative path is read against the directory they ran
 * `omnesis` from. The host launcher passes both in (`OMNESIS_HOST_HOME`,
 * `OMNESIS_HOST_CWD`), because the container's own home and working directory
 * name nothing the operator knows.
 *
 * A path on the host is visible to the collector's container only inside the
 * install's config directory — mounted at the same absolute path — or inside a
 * folder shared with it (`omnesis folders share`, a launcher command that
 * records the folder in `<config>/shared-folders` and mounts it read-only at
 * the same path). For any other folder the CLI asks the launcher to offer the
 * share: it leaves a request beside the compose file, as `secure` leaves its
 * restart request, and the launcher asks on the host, mounts the folder and
 * runs the add again. Without a launcher that can (no terminal, or an older
 * launcher) it prints the exact command instead.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { HOST_HOME_ENV } from "@omnesis/source-sdk";
import { detectDockerContext, isWithinDir } from "./docker-install.js";

/** Set by a launcher that reads a share request after the command exits. */
const SHARE_REQUEST_ENV = "OMNESIS_DOCKER_SHARE_REQUEST";
/** The folders shared with the collector's container, one absolute path per line. */
const SHARED_FOLDERS_FILE = "shared-folders";
/** Where the CLI leaves a share request for the launcher. */
const SHARE_REQUEST_FILE = "share-request";

export interface DockerFolders {
  /** The host config directory, visible in every container at the same path. */
  projectDir: string;
  /** Host folders already shared with the collector's container. */
  shared: string[];
  /** Whether the launcher this command runs under offers a share when it exits. */
  canRequest: boolean;
}

/** Parse `<config>/shared-folders`: absolute paths, one per line; anything else is skipped. */
export function parseSharedFolders(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && isAbsolute(line));
}

/** This CLI's Docker install and the folders its collector sees, or null outside one. */
export function dockerFolders(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
  readText: (path: string) => string | null = (path) =>
    existsSync(path) ? readFileSync(path, "utf8") : null,
): DockerFolders | null {
  if (!env[HOST_HOME_ENV]) return null;
  const context = detectDockerContext(configDir, (path) => readText(path) ?? "");
  if (!context) return null;
  return {
    projectDir: context.projectDir,
    shared: parseSharedFolders(readText(join(context.projectDir, SHARED_FOLDERS_FILE)) ?? ""),
    canRequest: env[SHARE_REQUEST_ENV] === "1",
  };
}

/** Whether the collector's container can see `path`, an absolute host path. */
export function visibleInContainer(path: string, folders: DockerFolders): boolean {
  return (
    isWithinDir(path, folders.projectDir) || folders.shared.some((dir) => isWithinDir(path, dir))
  );
}

/** The launcher command that shares `path`, quoted to paste as one shell word. */
export function shareFolderCommand(path: string): string {
  return `omnesis folders share '${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * Leave a share request for the launcher: the folder, and the command that
 * picks the add up again once it is mounted. False when either cannot be
 * written as lines — the operator is then given the command instead.
 */
export function writeShareRequest(
  folders: DockerFolders,
  path: string,
  resume: readonly string[],
  write: (file: string, text: string) => void = (file, text) =>
    writeFileSync(file, text, { mode: 0o600 }),
): boolean {
  if ([path, ...resume].some((word) => word.includes("\n") || word.includes("\0"))) return false;
  const text = [`path=${path}`, ...resume.map((word) => `arg=${word}`)].join("\n") + "\n";
  write(join(folders.projectDir, SHARE_REQUEST_FILE), text);
  return true;
}
