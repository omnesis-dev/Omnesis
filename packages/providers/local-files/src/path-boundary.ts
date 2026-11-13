// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstatSync } from "node:fs";
import { posix, win32 } from "node:path";
import { exactFileIdentity } from "./identity.js";

export type BoundaryEntry =
  { kind: "directory" | "file"; identity: string } | { kind: "link" | "other" };
interface BoundaryOptions {
  platform?: NodeJS.Platform;
  readEntry?: (path: string) => BoundaryEntry;
}

function noFollowEntry(path: string): BoundaryEntry {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink()) return { kind: "link" };
  if (stat.isDirectory()) return { kind: "directory", identity: exactFileIdentity(stat) };
  if (stat.isFile()) return { kind: "file", identity: exactFileIdentity(stat) };
  return { kind: "other" };
}

/** Resolve only a case-ambiguous spelling, without following any observed link. */
export function sameLocalPath(
  left: string,
  right: string,
  kind: "directory" | "file",
  { platform = process.platform, readEntry = noFollowEntry }: BoundaryOptions = {},
): boolean {
  const api = platform === "win32" ? win32 : posix;
  if (api.normalize(left) === api.normalize(right)) return true;
  if (platform !== "win32" || api.relative(left, right) !== "") return false;
  const identity = (path: string): string => {
    const entry = readEntry(path);
    if ((entry.kind !== "directory" && entry.kind !== "file") || entry.kind !== kind)
      throw new Error("Local path is not the expected regular entry");
    let current = path;
    while (true) {
      const parent = api.dirname(current);
      if (parent === current) break;
      if (readEntry(parent).kind !== "directory")
        throw new Error("Local path ancestor is not a regular directory");
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

/** Canonical membership; Windows casing alone cannot establish a root boundary. */
export function containsLocalPath(
  root: string,
  path: string,
  options: BoundaryOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const api = platform === "win32" ? win32 : posix;
  const rel = api.relative(root, path);
  if (rel === ".." || rel.startsWith(`..${api.sep}`) || api.isAbsolute(rel)) return false;
  if (platform !== "win32") return true;
  let ancestor = path;
  const depth = rel.split(api.sep).filter(Boolean).length;
  for (let level = 0; level < depth; level++) ancestor = api.dirname(ancestor);
  return sameLocalPath(root, ancestor, "directory", options);
}
