// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  listReadAccessDirectory,
  probeFileReadAccess,
  type ReadAccessOptions,
} from "./read-access.js";
import type { SourceReadAccessResult } from "./define-source.js";

// Hard health-check safety ceilings, not limits on what source sync can index.
const MAX_DISCOVERED_ENTRIES = 256;
const MAX_DISCOVERY_DEPTH = 32;

interface ReadAccessTreeOptions extends ReadAccessOptions {
  roots: readonly { path: string; optional?: boolean }[];
  fileExtensions: readonly string[];
  exclude?: (relativePath: string, directory: boolean) => boolean;
}

/** Bounded metadata discovery and fresh opens; never parses source contents. */
export async function probeTreeReadAccess(
  options: ReadAccessTreeOptions,
): Promise<SourceReadAccessResult> {
  let remainingEntries = MAX_DISCOVERED_ENTRIES;
  let observedRoot = false;
  async function visit(
    path: string,
    relativePath: string,
    depth: number,
  ): Promise<SourceReadAccessResult> {
    if (depth > MAX_DISCOVERY_DEPTH || options.signal.aborted) return { status: "unavailable" };
    const listing = await listReadAccessDirectory(path, options);
    if (listing.status !== "readable") return listing;
    remainingEntries -= listing.entries.length;
    if (remainingEntries < 0) return { status: "unavailable" };
    for (const entry of listing.entries) {
      if (options.signal.aborted) return { status: "unavailable" };
      const childRelative = relativePath ? join(relativePath, entry.name) : entry.name;
      if (options.exclude?.(childRelative, entry.isDirectory())) continue;
      // A link may lead outside the declared tree or into a cycle. Do not
      // follow it, or claim the inaccessible portion passed verification.
      if (entry.isSymbolicLink()) return { status: "unavailable" };
      let result: SourceReadAccessResult;
      if (entry.isDirectory()) {
        result = await visit(join(path, entry.name), childRelative, depth + 1);
      } else if (options.fileExtensions.some((extension) => entry.name.endsWith(extension))) {
        result = await probeFileReadAccess(join(path, entry.name), options);
      } else {
        continue;
      }
      if (result.status !== "readable") return result;
    }
    return { status: "readable" };
  }

  for (const root of options.roots) {
    if (options.signal.aborted) return { status: "unavailable" };
    if (root.optional) {
      try {
        await lstat(root.path);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          continue;
        // Let the fresh directory open classify denials without leaking paths.
      }
    }
    const result = await visit(root.path, "", 0);
    if (result.status !== "readable") return result;
    observedRoot = true;
  }
  return { status: observedRoot && !options.signal.aborted ? "readable" : "unavailable" };
}
