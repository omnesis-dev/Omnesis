// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { posix } from "node:path";

/**
 * The gateway follows at most this many folders above a document; a deeper
 * directory would be stored as unknown there, so it is reported unknown here.
 */
export const MAX_PATH_SCOPE_DEPTH = 64;
const MAX_PATH_LENGTH = 4096;
const MAX_LABEL_LENGTH = 512;

/** How one source on one device turns directories into folders a filter can name. */
export interface PathScopeLayout {
  /**
   * The device's home directory. A directory inside it is named from `~`, so
   * the same folder under two differently placed homes is one folder.
   */
  home?: string;
  /**
   * The directories the source was configured with. When given, a directory
   * belongs to the outermost root holding it, the roots are the top of the
   * tree, and a directory outside every root has no folder. When absent, the
   * top of the tree is `~` for a directory inside the home directory and the
   * first path segment (`/srv`) for any other.
   */
  roots?: readonly string[];
  /**
   * Whether two names differing only by case are two folders. Defaults to the
   * convention of the platform the collector runs on.
   */
  caseSensitive?: boolean;
}

/** One folder of a directory's chain: itself, or one of its ancestors. */
export interface PathScopeFolder {
  /** Stable for a given layout and path; safe to store in a saved filter. */
  id: string;
  /** The path as the owner reads it, `~/work/atlas-api` or `/srv/work`. */
  label: string;
  /** Absent on the top folder of the tree. */
  parentId?: string;
}

/**
 * The one spelling of an absolute POSIX directory: NFC, no `.` or `..`
 * segment, no repeated or trailing slash. Null for anything that is not an
 * absolute POSIX path, which names no folder.
 */
export function normalizeDirectoryPath(path: unknown): string | null {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.length > MAX_PATH_LENGTH ||
    path.includes("\0")
  )
    return null;
  const normal = posix.normalize(path.normalize("NFC"));
  return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal;
}

const segmentsOf = (path: string): string[] => path.split("/").filter(Boolean);

function caseSensitive(layout: PathScopeLayout): boolean {
  return layout.caseSensitive ?? (process.platform !== "darwin" && process.platform !== "win32");
}

/** The segments of `path` below `base`, or null when `path` is not `base` or inside it. */
function segmentsBelow(
  base: readonly string[],
  path: readonly string[],
  fold: (name: string) => string,
): string[] | null {
  if (path.length < base.length) return null;
  for (let index = 0; index < base.length; index++)
    if (fold(base[index]!) !== fold(path[index]!)) return null;
  return path.slice(base.length);
}

function joinLabel(top: string, below: readonly string[]): string {
  if (below.length === 0) return top;
  return `${top === "/" ? "" : top}/${below.join("/")}`;
}

/**
 * The top folder a directory hangs from and the segments between the two.
 * `stem` is how the owner reads the top folder itself, one name per entry:
 * `["~", "Documents"]` for a tree that starts at `~/Documents`.
 */
function anchor(
  directory: string,
  layout: PathScopeLayout,
  fold: (name: string) => string,
): { top: string; stem: string[]; below: string[] } | null {
  const path = segmentsOf(directory);
  const home = normalizeDirectoryPath(layout.home);
  const homeSegments = home && home !== "/" ? segmentsOf(home) : null;
  const display = (segments: readonly string[]): { top: string; below: string[] } => {
    const inHome = homeSegments && segmentsBelow(homeSegments, segments, fold);
    if (inHome) return { top: "~", below: inHome };
    return segments.length === 0
      ? { top: "/", below: [] }
      : { top: `/${segments[0]!}`, below: segments.slice(1) };
  };
  if (layout.roots === undefined) {
    const named = display(path);
    return { top: named.top, stem: [named.top], below: named.below };
  }
  let outermost: string[] | null = null;
  for (const candidate of layout.roots) {
    const root = normalizeDirectoryPath(candidate);
    if (root === null) continue;
    const segments = segmentsOf(root);
    if (segmentsBelow(segments, path, fold) === null) continue;
    if (outermost === null || segments.length < outermost.length) outermost = segments;
  }
  if (outermost === null) return null;
  const named = display(outermost);
  return {
    top: joinLabel(named.top, named.below),
    stem: [named.top, ...named.below],
    below: path.slice(outermost.length),
  };
}

/**
 * The folders a directory is in: itself first, then each ancestor up to the
 * top of the layout's tree. Null when the directory names no folder a filter
 * could match — not an absolute path, outside every configured root, or
 * deeper than the gateway follows.
 *
 * A folder's id is a digest of its path as the owner reads it, name by name
 * from `~` or the first segment. It depends on nothing else: every device and
 * every scan names a folder identically, and a saved filter keeps naming the
 * same folder when the configured roots change. The roots decide only where
 * the tree starts, and so which folder has no parent. Ids carry no readable
 * path; the label does.
 */
export function pathScopeFolders(
  directory: unknown,
  layout: PathScopeLayout,
): PathScopeFolder[] | null {
  const normal = normalizeDirectoryPath(directory);
  if (normal === null) return null;
  const fold = caseSensitive(layout)
    ? (name: string) => name
    : (name: string) => name.toLowerCase();
  const anchored = anchor(normal, layout, fold);
  if (anchored === null || anchored.below.length >= MAX_PATH_SCOPE_DEPTH) return null;
  const folders: PathScopeFolder[] = [];
  for (let depth = 0; depth <= anchored.below.length; depth++) {
    const below = anchored.below.slice(0, depth);
    const label = joinLabel(anchored.top, below);
    folders.unshift({
      id: `dir:${createHash("sha256")
        .update(JSON.stringify([...anchored.stem, ...below].map(fold)))
        .digest("base64url")}`,
      label: label.length > MAX_LABEL_LENGTH ? `…${label.slice(1 - MAX_LABEL_LENGTH)}` : label,
      ...(depth > 0 ? { parentId: folders[0]!.id } : {}),
    });
  }
  return folders;
}

/** Changes whenever the layout would name or parent a folder differently. */
export function pathScopeLayoutKey(layout: PathScopeLayout): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        home: normalizeDirectoryPath(layout.home),
        roots:
          layout.roots === undefined
            ? null
            : [...new Set(layout.roots.map((root) => normalizeDirectoryPath(root)))].sort(),
        caseSensitive: caseSensitive(layout),
      }),
    )
    .digest("hex");
}

/**
 * The one directory a piece of work belongs to when it was done in several:
 * the directory all the others are inside, provided work was done in that
 * directory itself. Stepping into subdirectories keeps the work where it
 * started; stepping up moves it to the parent. Null when there is no such
 * directory — none was recorded, one is not an absolute path, or two of them
 * are unrelated — because filing the work under either would let a filter on
 * one folder share or hide what happened in the other.
 */
export function sharedWorkingDirectory(directories: readonly unknown[]): string | null {
  if (directories.length === 0) return null;
  let shared: string | null = null;
  const seen = new Set<string>();
  for (const directory of directories) {
    const normal = normalizeDirectoryPath(directory);
    if (normal === null) return null;
    seen.add(normal);
    if (shared === null) {
      shared = normal;
      continue;
    }
    const a = segmentsOf(shared);
    const b = segmentsOf(normal);
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    shared = `/${a.slice(0, common).join("/")}`;
  }
  return shared !== null && seen.has(shared) ? shared : null;
}
