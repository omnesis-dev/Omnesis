// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared release-discovery primitives.
 *
 * The CLI updater and gateway's passive release check must answer from the
 * exact same installation evidence, so the pure detector and strict
 * stable-version helpers live in this Node-specific subpath.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export type InstallMethod =
  | { method: "npm-global" }
  | { method: "source"; rootDir: string }
  | { method: "docker"; composeFile: string; projectDir: string }
  | { method: "unknown" };

export type ReleaseInstallMethod = Exclude<InstallMethod["method"], "unknown">;

/** Last successful answer from the gateway-owned release check. */
export interface ReleaseCheckSnapshot {
  currentVersion: string;
  latestVersion: string;
  installMethod: ReleaseInstallMethod;
  checkedAt: string;
  updateAvailable: boolean;
}

/** Filesystem accessors install-method detection needs — injectable for tests. */
export interface DetectFs {
  realpath(path: string): string;
  exists(path: string): boolean;
  readFile(path: string): string;
}

export const nodeDetectFs: DetectFs = {
  realpath: (path) => realpathSync(path),
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
};

const NPM_GLOBAL_PATTERN = /\/node_modules\/omnesis\//;

/** Classify a running entry script as a global package, source checkout, or unknown. */
export function detectInstallMethod(argv1Path: string, fs: DetectFs = nodeDetectFs): InstallMethod {
  if (!argv1Path) return { method: "unknown" };

  let real: string;
  try {
    real = fs.realpath(argv1Path);
  } catch {
    return { method: "unknown" };
  }

  if (NPM_GLOBAL_PATTERN.test(real.replaceAll("\\", "/"))) {
    return { method: "npm-global" };
  }

  let dir = dirname(real);
  for (;;) {
    const packagePath = join(dir, "package.json");
    if (fs.exists(packagePath)) {
      let name: string | undefined;
      try {
        name = (JSON.parse(fs.readFile(packagePath)) as { name?: string }).name;
      } catch {
        // An unreadable package manifest does not stop the upward walk.
      }
      if (name === CLI_PACKAGE && fs.exists(join(dir, ".git"))) {
        return { method: "source", rootDir: dir };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { method: "unknown" };
}

const INSTALL_METHOD_FILE = "install-method";
const DOCKER_COMPOSE_FILE = "docker-compose.yml";

/** Compose's env file, which carries the concrete image tag. */
export const DOCKER_ENV_FILE = ".env";
/** The `.env` key naming the image tag every Omnesis service resolves. */
export const IMAGE_TAG_KEY = "OMNESIS_IMAGE_TAG";

/** Detect an installer-managed Docker host from its config directory. */
export function detectDockerInstall(
  configDir: string,
  fs: DetectFs = nodeDetectFs,
): InstallMethod | null {
  try {
    const marker = fs.readFile(join(configDir, INSTALL_METHOD_FILE));
    if (marker.split(/\r?\n/)[0]?.trim() !== "docker") return null;
    const composeFile = join(configDir, DOCKER_COMPOSE_FILE);
    if (!fs.exists(composeFile)) return null;
    return { method: "docker", composeFile, projectDir: configDir };
  } catch {
    return null;
  }
}

/** Strip whitespace and a leading `v` from a version-like value. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/u, "");
}

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** Whether a value is one exact stable product version, with no prefix or suffix. */
export function isStableReleaseVersion(value: unknown): value is string {
  return typeof value === "string" && STABLE_VERSION_PATTERN.test(value);
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  return left === right ? 0 : left > right ? 1 : -1;
}

/** Compare strict stable versions without coercing untrusted identifiers to numbers. */
export function compareStableReleaseVersions(left: string, right: string): number | null {
  const a = left.match(STABLE_VERSION_PATTERN);
  const b = right.match(STABLE_VERSION_PATTERN);
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index += 1) {
    const compared = compareNumericIdentifier(a[index]!, b[index]!);
    if (compared !== 0) return compared;
  }
  return 0;
}

/** Newest strict `vX.Y.Z` tag from untrusted `git ls-remote` output. */
export function newestStableTag(lsRemoteOutput: string): string | null {
  let newest: string | null = null;
  for (const line of lsRemoteOutput.split(/\r?\n/)) {
    const tag = line.match(/refs\/tags\/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u)?.[1];
    if (
      tag &&
      (newest === null || compareStableReleaseVersions(tag.slice(1), newest.slice(1)) === 1)
    ) {
      newest = tag;
    }
  }
  return newest;
}

/** Product version encoded by one strict stable tag. */
export function versionFromStableTag(tag: string): string | null {
  const match = tag.match(STABLE_TAG_PATTERN);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export const CLI_PACKAGE = "omnesis";
export const DEFAULT_PACKAGE_INDEX_URL = `https://registry.npmjs.org/${CLI_PACKAGE}`;

/** Package-index endpoint that names the version behind one dist-tag. */
export function packageIndexUrl(distTag: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.OMNESIS_PACKAGE_INDEX_URL || DEFAULT_PACKAGE_INDEX_URL).replace(/\/+$/u, "");
  return `${base}/${encodeURIComponent(distTag)}`;
}

/** A version shape accepted by an explicit package/update target. */
export function isResolvedVersion(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?$/u.test(normalizeVersion(value));
}
