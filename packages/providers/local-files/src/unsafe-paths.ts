// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstatSync } from "node:fs";
import { dirname, normalize } from "node:path";
import { exactFileIdentity } from "./identity.js";

type Identity = { kind: "known"; value: string } | { kind: "missing" | "unverified" };

function noFollowIdentity(path: string): string {
  return exactFileIdentity(lstatSync(path, { bigint: true }));
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
