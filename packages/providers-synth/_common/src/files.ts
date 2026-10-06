// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  constants,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { loadActiveUniverse } from "./universe.js";

export interface SyntheticFile {
  path: string;
  content: string;
  modifiedAt?: string;
}

/** Only manifest-declared accounts are discoverable; absent fixture families stay absent. */
export function universeAccounts(descriptorId: string): string[] {
  return loadActiveUniverse()
    .manifest.sources.filter((source) => source.descriptorId === descriptorId)
    .flatMap((source) => [...source.accountIds]);
}

/** Materialize invented inputs exclusively below an explicitly supplied host state directory. */
export function materializeSyntheticFiles(
  stateDir: string | undefined,
  namespace: string,
  files: readonly SyntheticFile[],
): string {
  if (!stateDir || !isAbsolute(stateDir))
    throw new Error("Synthetic inputs require an absolute host state directory");
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) throw new Error("Invalid synthetic input namespace");
  if (!Array.isArray(files) || files.length > 100_000)
    throw new Error("Synthetic files must be a bounded array");
  const root = resolve(stateDir, `synthetic-${namespace}`);
  if (existsSync(root) && (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())) {
    throw new Error("Synthetic input root must be an owned directory, not a symlink");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const manifestPath = resolve(stateDir, `synthetic-${namespace}-files.json`);
  let previous: string[] = [];
  if (existsSync(manifestPath)) {
    if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink())
      throw new Error("Synthetic file manifest must be an owned regular file");
    const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      !Array.isArray(raw) ||
      raw.some(
        (path) =>
          typeof path !== "string" ||
          !path.startsWith(`${root}${sep}`) ||
          path
            .slice(root.length + 1)
            .split(sep)
            .some((part: string) => part === ".." || !part),
      )
    )
      throw new Error("Synthetic file manifest contains an unsafe path");
    previous = raw;
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path ||
      isAbsolute(file.path) ||
      file.path.includes("\0") ||
      file.path.split(/[\\/]/).some((part: string) => part === ".." || part === "." || !part) ||
      typeof file.content !== "string" ||
      Buffer.byteLength(file.content) > 25 * 1024 * 1024
    ) {
      throw new Error("Synthetic file must have a safe relative path and bounded text content");
    }
    const target = resolve(root, file.path);
    if (!target.startsWith(`${root}${sep}`) || seen.has(target))
      throw new Error("Synthetic file escapes its root or duplicates another path");
    seen.add(target);
    const parent = dirname(target);
    let current = root;
    for (const part of parent
      .slice(root.length + 1)
      .split(sep)
      .filter(Boolean)) {
      current = join(current, part);
      if (
        existsSync(current) &&
        (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())
      )
        throw new Error("Synthetic input parent is not an owned directory");
      mkdirSync(current, { recursive: true, mode: 0o700 });
    }
    if (existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()))
      throw new Error("Synthetic input target is not a regular file");
    if (!existsSync(target) || readFileSync(target, "utf8") !== file.content) {
      const fd = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, file.content);
      } finally {
        closeSync(fd);
      }
    }
    if (file.modifiedAt !== undefined) {
      const at = new Date(file.modifiedAt);
      if (!Number.isFinite(at.getTime())) throw new Error("Invalid synthetic file timestamp");
      utimesSync(target, at, at);
    }
  }
  // Remove only files the preceding fixture materialization explicitly owned.
  for (const oldPath of previous) {
    if (seen.has(oldPath) || !existsSync(oldPath)) continue;
    let current = root;
    for (const part of dirname(oldPath)
      .slice(root.length + 1)
      .split(sep)
      .filter(Boolean)) {
      current = join(current, part);
      if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())
        throw new Error("Synthetic input parent is not an owned directory");
    }
    if (!lstatSync(oldPath).isFile() || lstatSync(oldPath).isSymbolicLink())
      throw new Error("Synthetic input retirement target must be a regular file");
    unlinkSync(oldPath);
  }
  const manifestFd = openSync(
    manifestPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(manifestFd, JSON.stringify([...seen]));
  } finally {
    closeSync(manifestFd);
  }
  return root;
}
