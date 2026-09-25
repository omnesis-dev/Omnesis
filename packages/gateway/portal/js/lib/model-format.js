// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Small formatting helpers shared by the Models view and its modal flows.
 * Kept here (not in a view) so both `models.js` and `model-config.js` can
 * import them without a circular dependency.
 */

/** Human-readable byte size, or "—" for null/undefined. */
export function formatBytes(n) {
  if (!n && n !== 0) return "—";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Decorate a GGUF catalog entry with system-fit hints relative to a SystemInfo
 * snapshot — RAM/disk warnings and the "recommended" tag. Non-GGUF entries (or
 * a missing snapshot) fit unconditionally.
 */
export function fit(entry, sys) {
  if (!sys || entry.kind !== "gguf") return { ok: true, badges: [] };
  const badges = [];
  if (entry.minRamGb && sys.freeRamGb < entry.minRamGb) {
    badges.push({ kind: "warn", text: `Needs ${entry.minRamGb} GB free RAM (you have ${sys.freeRamGb} GB)` });
  }
  if (sys.modelsDirFreeGb < entry.sizeBytes / 1024 ** 3) {
    badges.push({ kind: "warn", text: `Disk free (${sys.modelsDirFreeGb} GB) may not fit ${formatBytes(entry.sizeBytes)}` });
  }
  if (entry.recommended) badges.push({ kind: "good", text: "Recommended" });
  return { ok: badges.every((b) => b.kind !== "block"), badges };
}
