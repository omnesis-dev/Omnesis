// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import type { DesktopProfile } from "./environment.js";
export { desktopEnvironment, desktopProfile, type DesktopProfile } from "./environment.js";
import { CATALOG, type GgufCatalogEntry } from "@omnesis/core";

export interface DesktopResources {
  memoryLimitMb: number;
  embedder: GgufCatalogEntry;
}

/** Persist once at creation; transient memory pressure must never change vector dimensions. */
export function recommendDesktopResources(totalMemoryBytes: number): DesktopResources {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes < 1024 ** 3) {
    throw new Error("This computer needs at least 1 GB of memory to host a library");
  }
  const memoryLimitMb = Math.max(256, Math.min(4096, Math.floor(totalMemoryBytes / 1024 ** 2 / 4)));
  const candidates = CATALOG.filter(
    (entry): entry is GgufCatalogEntry =>
      entry.kind === "gguf" && entry.roles.includes("embed") && entry.sha256 !== undefined,
  );
  const budgetGb = memoryLimitMb / 1024;
  const embedder =
    candidates.find(
      (entry) =>
        entry.recommended && (entry.recommendedRamGb ?? Number.POSITIVE_INFINITY) <= budgetGb,
    ) ??
    candidates
      .filter((entry) => (entry.minRamGb ?? Number.POSITIVE_INFINITY) <= budgetGb)
      .sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
  if (!embedder) throw new Error("No local search model fits this computer's memory budget");
  return { memoryLimitMb, embedder };
}

export function desktopJournalPath(profile: DesktopProfile): string {
  return join(profile.configDir, "desktop-install.json");
}
