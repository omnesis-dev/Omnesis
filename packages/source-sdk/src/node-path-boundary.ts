// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstatSync } from "node:fs";
import { dirname, normalize, posix, win32 } from "node:path";

export type NodePathEntry =
  { kind: "directory" | "file"; identity: string } | { kind: "link" | "other" };
export interface NodePathBoundaryOptions {
  platform?: NodeJS.Platform;
  readEntry?: (path: string) => NodePathEntry;
}

function noFollowEntry(path: string): NodePathEntry {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink()) return { kind: "link" };
  if (stat.dev < 0n || stat.ino <= 0n) throw new Error("Cannot verify filesystem entry identity");
  if (stat.isDirectory()) return { kind: "directory", identity: `${stat.dev}:${stat.ino}` };
  if (stat.isFile()) return { kind: "file", identity: `${stat.dev}:${stat.ino}` };
  return { kind: "other" };
}

/** Resolve only a case-ambiguous spelling, without following any observed link. */
export function sameCanonicalPath(
  left: string,
  right: string,
  kind: "directory" | "file",
  { platform = process.platform, readEntry = noFollowEntry }: NodePathBoundaryOptions = {},
): boolean {
  const api = platform === "win32" ? win32 : posix;
  if (api.normalize(left) === api.normalize(right)) return true;
  if (platform !== "win32" || api.relative(left, right) !== "") return false;
  const identity = (path: string): string => {
    const entry = readEntry(path);
    if ((entry.kind !== "directory" && entry.kind !== "file") || entry.kind !== kind)
      throw new Error("Filesystem path is not the expected regular entry");
    let current = path;
    while (true) {
      const parent = api.dirname(current);
      if (parent === current) break;
      if (readEntry(parent).kind !== "directory")
        throw new Error("Filesystem path ancestor is not a regular directory");
      current = parent;
    }
    return entry.identity;
  };
  try {
    return identity(left) === identity(right);
  } catch {
    return false;
  }
}

/** Canonical path membership; Windows casing alone cannot establish a root boundary. */
export function containsCanonicalPath(
  root: string,
  path: string,
  options: NodePathBoundaryOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const api = platform === "win32" ? win32 : posix;
  const rel = api.relative(root, path);
  if (rel === ".." || rel.startsWith(`..${api.sep}`) || api.isAbsolute(rel)) return false;
  if (platform !== "win32") return true;
  let ancestor = path;
  const depth = rel.split(api.sep).filter(Boolean).length;
  for (let level = 0; level < depth; level++) ancestor = api.dirname(ancestor);
  return sameCanonicalPath(root, ancestor, "directory", options);
}

type Identity = { kind: "known"; value: string } | { kind: "missing" | "unverified" };

function noFollowIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (stat.dev < 0n || stat.ino <= 0n) throw new Error("Cannot verify filesystem entry identity");
  return `${stat.dev}:${stat.ino}`;
}

/** Match only the known paths whose entry a refused alias could have replaced. */
export function createUnsafePathMatcher(
  paths: readonly string[],
  platform: NodeJS.Platform = process.platform,
  readIdentity: (path: string) => string = noFollowIdentity,
): (path: string) => boolean {
  const exact = new Set(paths.map(normalize));
  const folded = new Map<string, string[]>();
  if (platform === "win32") {
    for (const path of exact) {
      const key = path.toLowerCase();
      const group = folded.get(key);
      if (group) group.push(path);
      else folded.set(key, [path]);
    }
  }
  const cache = new Map<string, Identity>();
  const identity = (path: string): Identity => {
    const cached = cache.get(path);
    if (cached) return cached;
    let result: Identity;
    try {
      result = { kind: "known", value: readIdentity(path) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      result = { kind: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unverified" };
    }
    cache.set(path, result);
    return result;
  };
  return (path) => {
    let current = normalize(path);
    while (true) {
      if (exact.has(current)) return true;
      const candidates = folded.get(current.toLowerCase());
      if (candidates) {
        // NTFS directories can be case-sensitive. A case-only spelling is
        // the same refused entry only when its no-follow file identity agrees.
        // Probe the ambiguous prefix itself, never a file below the alias.
        const observed = identity(current);
        if (observed.kind === "unverified") return true;
        if (observed.kind === "known") {
          for (const candidate of candidates) {
            const refused = identity(candidate);
            if (refused.kind === "unverified") return true;
            if (refused.kind === "known" && refused.value === observed.value) return true;
          }
        }
      }
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  };
}
