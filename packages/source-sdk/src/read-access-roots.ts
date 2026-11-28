// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat } from "node:fs/promises";
import { probeDirectoryReadAccess, type ReadAccessOptions } from "./read-access.js";
import type { SourceReadAccessResult } from "./define-source.js";

/** Required source roots only: no exhaustive listing, contents, filenames or descendant grant. */
export async function probeRootReadAccess(
  options: ReadAccessOptions & { roots: readonly { path: string; optional?: boolean }[] },
): Promise<SourceReadAccessResult> {
  if (options.roots.length === 0 || options.roots.length > 32) return { status: "unavailable" };
  let observed = false;
  for (const root of options.roots) {
    if (options.signal.aborted) return { status: "unavailable" };
    if (root.optional) {
      try {
        await lstat(root.path);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          continue;
      }
    }
    const result = await probeDirectoryReadAccess(root.path, options);
    if (result.status !== "readable") return result;
    observed = true;
  }
  return { status: observed && !options.signal.aborted ? "readable" : "unavailable" };
}
