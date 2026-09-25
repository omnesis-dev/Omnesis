// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Atomic, ownership-preserving file operations for delivery migration. */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicWriteFileSync } from "@omnesis/core";
import { CliError, EXIT_USER_ERROR } from "../utils.js";
import { sourceRecoveryLauncher } from "./source-launcher.js";

export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface FileSnapshot {
  content: string;
  identity: FileIdentity;
}

export function captureDirectoryIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliError(`Refusing non-directory source checkout ${path}.`, EXIT_USER_ERROR);
  }
  return identity(stat);
}

export function canonicalPackageRoot(prefix: string, packageName: string): string {
  const canonicalPrefix = realpathSync(prefix);
  const lexicalModulesRoot = join(prefix, "lib", "node_modules");
  const modulesStat = lstatSync(lexicalModulesRoot);
  if (!modulesStat.isDirectory() || modulesStat.isSymbolicLink()) {
    throw new Error(`${lexicalModulesRoot} is not a regular modules directory`);
  }
  const modulesRoot = realpathSync(lexicalModulesRoot);
  if (modulesRoot !== join(canonicalPrefix, "lib", "node_modules")) {
    throw new Error(`${lexicalModulesRoot} escapes its selected package prefix`);
  }
  const lexicalRoot = join(prefix, "lib", "node_modules", packageName);
  const stat = lstatSync(lexicalRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${lexicalRoot} is not a regular package directory`);
  }
  const packageRoot = realpathSync(lexicalRoot);
  if (packageRoot !== join(modulesRoot, packageName)) {
    throw new Error(`${lexicalRoot} escapes its selected package prefix`);
  }
  return packageRoot;
}

function identity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

export function captureOwnedSourceLauncher(
  path: string,
  rootDir: string,
  configDir: string,
  homeDir: string,
): FileSnapshot {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new CliError(
      `The installer-owned source launcher is missing at ${path}. Re-run the source installer before migrating.`,
      EXIT_USER_ERROR,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new CliError(`Refusing to replace non-regular launcher ${path}.`, EXIT_USER_ERROR);
  }
  const content = readFileSync(path, "utf8");
  const expected = sourceRecoveryLauncher(
    rootDir,
    configDir,
    join(homeDir, ".local", "lib", "omnesis", "update-lock.cjs"),
  );
  if (content !== expected) {
    throw new CliError(
      `Refusing to replace ${path}: it is not the installer-owned launcher for ${rootDir}.`,
      EXIT_USER_ERROR,
    );
  }
  return { content, identity: identity(stat) };
}

export function captureRegularFile(path: string): FileSnapshot {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CliError(`Refusing to rewrite non-regular service unit ${path}.`, EXIT_USER_ERROR);
  }
  return { content: readFileSync(path, "utf8"), identity: identity(stat) };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function captureOptionalRegularFile(path: string): FileSnapshot | null {
  try {
    return captureRegularFile(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

export function assertFileSnapshot(path: string, expected: FileSnapshot): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !sameIdentity(identity(stat), expected.identity) ||
    readFileSync(path, "utf8") !== expected.content
  ) {
    throw new Error(`${path} changed after migration preflight`);
  }
}

export function assertOptionalFileSnapshot(path: string, expected: FileSnapshot | null): void {
  if (expected) {
    assertFileSnapshot(path, expected);
    return;
  }
  try {
    lstatSync(path);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  throw new Error(`${path} appeared after migration preflight`);
}

export function assertFileContent(path: string, expected: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(path, "utf8") !== expected) {
    throw new Error(`${path} changed during migration`);
  }
}

function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      try {
        fsyncSync(fd);
      } catch {
        // Directory fsync is unsupported on some filesystems.
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // link/rename still provide atomic namespace changes within the directory.
  }
}

/**
 * Replace a snapshotted regular file without a check→rename overwrite gap.
 * The old inode moves aside first and is validated there; linking the fully
 * fsynced replacement into the empty name refuses a concurrent creator.
 */
export function replaceFileSnapshot(
  path: string,
  expected: FileSnapshot,
  replacement: string,
  mode: number,
): FileIdentity {
  const marker = randomUUID();
  const previous = `${path}.omnesis-migration-${marker}.previous`;
  const ready = `${path}.omnesis-migration-${marker}.next`;
  atomicWriteFileSync(ready, replacement, { mode });
  let moved = false;
  let linked = false;
  try {
    renameSync(path, previous);
    moved = true;
    const stat = lstatSync(previous);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !sameIdentity(identity(stat), expected.identity) ||
      readFileSync(previous, "utf8") !== expected.content
    ) {
      throw new Error(`${path} changed before its atomic replacement`);
    }
    const installed = identity(lstatSync(ready));
    linkSync(ready, path);
    linked = true;
    fsyncDirectory(dirname(path));
    try {
      unlinkSync(ready);
      unlinkSync(previous);
      fsyncDirectory(dirname(path));
    } catch {
      // The active path is already durable and exact. A uniquely named spare
      // is safer than undoing a completed switch during cleanup.
    }
    return installed;
  } catch (error) {
    if (!linked && moved) {
      try {
        linkSync(previous, path);
        unlinkSync(previous);
        moved = false;
      } catch {
        // The error below names the preserved `.previous` artifact.
      }
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${moved ? `; original preserved at ${previous}` : ""}`,
      { cause: error },
    );
  } finally {
    if (!linked) {
      try {
        unlinkSync(ready);
      } catch {
        // Best-effort cleanup of a never-activated prepared file.
      }
    }
  }
}

export function restoreFileSnapshot(
  path: string,
  before: string,
  after: string,
  afterIdentity: FileIdentity,
  mode: number,
): void {
  const current = readFileSync(path, "utf8");
  if (current === before) return;
  if (current !== after) {
    throw new Error(`${path} changed during migration; it was not overwritten`);
  }
  replaceFileSnapshot(path, { content: after, identity: afterIdentity }, before, mode);
}

function pathInside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalExistingPath(path: string): string {
  return realpathSync(resolve(path));
}

/** Refusals that make recursive removal target one ordinary managed checkout. */
export function assertSafeCheckoutRemoval(
  rootDir: string,
  homeDir: string,
  configDir: string,
  cwd: string,
): void {
  const root = canonicalExistingPath(rootDir);
  const home = canonicalExistingPath(homeDir);
  const config = canonicalExistingPath(configDir);
  const workingDirectory = canonicalExistingPath(cwd);
  if (root === resolve("/") || root === home) {
    throw new Error(`Refusing to remove unsafe source checkout ${root}`);
  }
  if (pathInside(config, root) || pathInside(root, config)) {
    throw new Error(`Refusing to remove source checkout overlapping ${configDir}`);
  }
  if (pathInside(workingDirectory, root)) {
    throw new Error("Refusing to remove the source checkout while the shell is inside it");
  }
  const git = lstatSync(join(root, ".git"));
  if (!git.isDirectory() || git.isSymbolicLink()) {
    throw new Error("Refusing to remove a git worktree; remove it with git worktree remove");
  }
}

/** Move the exact preflight directory inode to a private deletion target. */
export function quarantineCheckout(path: string, expected: FileIdentity): string {
  const retired = `${path}.omnesis-migration-${randomUUID()}.retired`;
  let moved = false;
  try {
    renameSync(path, retired);
    moved = true;
    const stat = lstatSync(retired);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino
    ) {
      throw new Error(`${path} no longer names the preflight source checkout`);
    }
    return retired;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${moved ? `; moved tree preserved at ${retired}` : ""}`,
      { cause: error },
    );
  }
}
