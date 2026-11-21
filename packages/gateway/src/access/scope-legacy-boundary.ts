// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** The same conservative projection is used for writes and rollback reconciliation. */
export function conservativeSources(input: {
  sourceMode: "all" | "allowlist" | "denylist";
  sourceIds: readonly string[];
  scopePolicies: readonly { sourceId: string }[];
}): { sourceMode: "all" | "allowlist" | "denylist"; sourceIds: string[] } {
  const filtered = new Set(input.scopePolicies.map((policy) => policy.sourceId));
  if (!filtered.size) return { sourceMode: input.sourceMode, sourceIds: [...input.sourceIds] };
  return input.sourceMode === "allowlist"
    ? { sourceMode: "allowlist", sourceIds: input.sourceIds.filter((id) => !filtered.has(id)) }
    : { sourceMode: "denylist", sourceIds: [...new Set([...input.sourceIds, ...filtered])].sort() };
}
