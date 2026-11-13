// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Directories as something a filter can match on, for sources whose records
 * live at a path on one machine.
 *
 * Such a source has no upstream id for a folder, so the path is the id: a
 * record carries the id of the one directory it belongs to, and the source's
 * published list holds every directory it knows together with the directory
 * above it. A path only means something on the machine it is on, so a source
 * using these declares its field with `scope: "device"`.
 *
 * Nothing here reads the disk.
 */

import { posix, win32 } from "node:path";
import { FILTER_LIST_LIMITS, type FilterListItem } from "@omnesis/types";

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * The one spelling of an absolute directory path: NFC, no `.` or `..`
 * segment, no repeated or trailing separator, forward slashes. A Windows
 * drive path keeps its drive (`C:/Users/maya`).
 *
 * Null for anything that names no directory a filter could match: not a
 * string, not absolute, a network share, or too long to be an id.
 */
export function normalizeDirectoryPath(path: unknown): string | null {
  if (typeof path !== "string" || path.includes("\0")) return null;
  const composed = path.normalize("NFC");
  let normal: string;
  if (DRIVE_PATH.test(composed)) {
    const resolved = win32.normalize(composed).split("\\").join("/");
    normal = resolved[0]!.toUpperCase() + resolved.slice(1);
    if (normal.length > 3 && normal.endsWith("/")) normal = normal.slice(0, -1);
  } else if (composed.startsWith("/")) {
    normal = posix.normalize(composed);
    if (normal.length > 1 && normal.endsWith("/")) normal = normal.slice(0, -1);
  } else {
    return null;
  }
  return normal.length > FILTER_LIST_LIMITS.idLength ? null : normal;
}

/** Whether a normalized path is a Windows drive path. */
function onDrive(normal: string): boolean {
  return DRIVE_PATH.test(normal);
}

/**
 * Whether two names differing only by case are two directories, by the
 * convention of the platform this process runs on. A drive path never is.
 */
function platformCaseSensitive(): boolean {
  return process.platform !== "darwin" && process.platform !== "win32";
}

/** How directory paths are read on the machine they come from. */
export interface DirectoryPathOptions {
  /**
   * Whether two names differing only by case are two directories. Defaults to
   * the convention of the platform this process runs on.
   */
  caseSensitive?: boolean;
}

function idOf(normal: string, options: DirectoryPathOptions): string {
  const sensitive = !onDrive(normal) && (options.caseSensitive ?? platformCaseSensitive());
  return sensitive ? normal : normal.toLowerCase();
}

/**
 * The id a record carries for the directory it belongs to, and the id that
 * directory has in the list {@link directoryFilterList} builds.
 *
 * It is the normalized absolute path, lower-cased where the file system does
 * not tell two cases apart, so one directory reached under two spellings is
 * one id. Null when the path names no directory a filter could match; a record
 * then carries nothing, which reads as not known.
 */
export function directoryFilterId(
  path: unknown,
  options: DirectoryPathOptions = {},
): string | null {
  const normal = normalizeDirectoryPath(path);
  return normal === null ? null : idOf(normal, options);
}

/** The directory above a normalized path, or null at the top of a file system. */
function parentOf(normal: string): string | null {
  if (normal === "/" || (onDrive(normal) && normal.length === 3)) return null;
  const cut = normal.lastIndexOf("/");
  if (cut === 0) return "/";
  if (onDrive(normal) && cut === 2) return normal.slice(0, 3);
  return normal.slice(0, cut);
}

/** Where the tree of a {@link directoryFilterList} starts. */
export interface DirectoryTreeLayout extends DirectoryPathOptions {
  /**
   * The home directory of the machine. A directory inside it is shown from
   * `~`, and when no `roots` are given the home directory is the top of the
   * tree for everything inside it.
   */
  home?: string;
  /**
   * The directories the source was configured with. Each is listed whether or
   * not anything is known inside it, and is the top of the tree for what it
   * holds. When absent, the top is the home directory for a directory inside
   * it and the first path segment (`/srv`) for any other.
   */
  roots?: readonly string[];
}

/**
 * The list of a directory field: every given directory, and each directory
 * between it and the top of its tree, with the directory above as its parent.
 *
 * Ancestry in the list is ancestry by path segments, whatever the layout:
 * when one listed directory is inside another, the list holds every directory
 * between the two, so a filter on `/work` covers `/work/atlas-api` and never
 * `/workshop`. The layout only decides how far above the given directories
 * the list goes.
 *
 * An item's id is {@link directoryFilterId} of its path. Its label is the
 * path as the owner reads it, `~/work/atlas-api` inside the home directory
 * and the full path elsewhere. Paths that name no directory are left out.
 *
 * The cost is one step per directory and per level above it; it does not
 * depend on how many records the directories hold.
 */
export function directoryFilterList(
  directories: Iterable<unknown>,
  layout: DirectoryTreeLayout = {},
): FilterListItem[] {
  const givenHome = normalizeDirectoryPath(layout.home);
  // A home directory at the top of the file system holds everything, so it
  // singles nothing out.
  const home = givenHome !== null && parentOf(givenHome) !== null ? givenHome : null;
  const homeId = home === null ? null : idOf(home, layout);
  /** Whether `id` is `ancestorId` or inside it. */
  const within = (id: string, ancestorId: string): boolean =>
    id === ancestorId || id.startsWith(ancestorId.endsWith("/") ? ancestorId : `${ancestorId}/`);

  const rootIds = new Set<string>();
  const underRoot = (id: string): boolean => {
    for (const rootId of rootIds) if (within(id, rootId)) return true;
    return false;
  };
  /** id → the spelling shown for it. */
  const nodes = new Map<string, string>();
  const add = (normal: string): string => {
    const id = idOf(normal, layout);
    const shown = nodes.get(id);
    // Two spellings of one directory: keep the same one whatever order they
    // arrive in, so the list does not change between two listings.
    if (shown === undefined || normal < shown) nodes.set(id, normal);
    return id;
  };
  for (const root of layout.roots ?? []) {
    const normal = normalizeDirectoryPath(root);
    if (normal !== null) rootIds.add(add(normal));
  }

  /** Whether the walk up from a directory stops at `normal`. */
  const isTop = (normal: string, id: string, startId: string): boolean => {
    if (layout.roots !== undefined) return rootIds.has(id);
    if (homeId !== null && within(startId, homeId)) return id === homeId;
    const parent = parentOf(normal);
    return parent === null || parentOf(parent) === null;
  };
  for (const directory of directories) {
    const start = normalizeDirectoryPath(directory);
    if (start === null) continue;
    const startId = idOf(start, layout);
    // Outside every configured root there is no top to walk to: the directory
    // stands alone unless another listed directory holds it.
    const reachesTop = layout.roots === undefined || underRoot(startId);
    let at: string | null = start;
    while (at !== null) {
      const id = add(at);
      if (!reachesTop || isTop(at, id, startId)) break;
      at = parentOf(at);
    }
  }

  // A directory whose parent is not listed is the top of a tree, unless a
  // listed directory sits further up: then the ones in between are listed
  // too, so that being inside it by path is being under it in the tree.
  for (const normal of [...nodes.values()]) {
    const parent = parentOf(normal);
    if (parent === null || nodes.has(idOf(parent, layout))) continue;
    const between: string[] = [];
    let at: string | null = parent;
    while (at !== null && !nodes.has(idOf(at, layout))) {
      between.push(at);
      at = parentOf(at);
    }
    if (at !== null) for (const missing of between) add(missing);
  }

  const label = (id: string, normal: string): string => {
    if (homeId === null || home === null || !within(id, homeId)) return normal;
    return `~${normal.slice(home.length)}`;
  };
  const items: FilterListItem[] = [];
  for (const [id, normal] of nodes) {
    const parent = parentOf(normal);
    const parentId = parent === null ? undefined : idOf(parent, layout);
    items.push({
      id,
      label: label(id, normal),
      ...(parentId !== undefined && nodes.has(parentId) ? { parentId } : {}),
    });
  }
  return items;
}
