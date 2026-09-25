// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";

/**
 * Read USearch mappings owned by a spawned E2E command or one of its children.
 * `tsx` may keep a small launcher process above the actual gateway, so looking
 * only at the PID returned by `spawn()` can miss the native mappings entirely.
 */
export function usearchMappings(
  rootPid: number | undefined,
): { total: number; deleted: number; liveInodes: string[] } | null {
  if (process.platform !== "linux" || rootPid == null) return null;

  const pending = [rootPid];
  const seen = new Set<number>();
  const mappings: string[] = [];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      mappings.push(
        ...readFileSync(`/proc/${pid}/maps`, "utf8")
          .split("\n")
          .filter((line) => line.includes(".usearch")),
      );
      const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
      if (children) pending.push(...children.split(/\s+/).map(Number));
    } catch {
      // A short-lived launcher may exit while its descendants are inspected.
    }
  }
  return {
    total: mappings.length,
    deleted: mappings.filter((line) => line.endsWith(" (deleted)")).length,
    liveInodes: mappings
      .filter((line) => !line.endsWith(" (deleted)"))
      .map((line) => line.trim().split(/\s+/)[4] ?? "")
      .filter(Boolean)
      .sort(),
  };
}
