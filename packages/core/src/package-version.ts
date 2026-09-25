// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cache = new Map<string, string>();

/**
 * Product version of the package containing the calling module: the
 * `version` field of the nearest `package.json` found by walking up from
 * the module's directory. Works identically from `.ts` source (dev) and
 * emitted `dist/*.js` (published) since both live under the package root.
 *
 * Returns `"0.0.0"` when no package.json is found — callers surface the
 * version, they shouldn't crash on a broken install layout.
 */
export function readPackageVersion(
  importMetaUrl: string,
  opts: {
    /**
     * Read the manifest again instead of answering from the first read. For a
     * process that outlives a change to its own installation, such as an
     * update that waited for another update to finish.
     */
    fresh?: boolean;
  } = {},
): string {
  const cached = opts.fresh ? undefined : cache.get(importMetaUrl);
  if (cached) return cached;

  let dir = dirname(fileURLToPath(importMetaUrl));
  for (let i = 0; i < 10; i += 1) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const version = (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
      cache.set(importMetaUrl, version);
      return version;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  cache.set(importMetaUrl, "0.0.0");
  return "0.0.0";
}
