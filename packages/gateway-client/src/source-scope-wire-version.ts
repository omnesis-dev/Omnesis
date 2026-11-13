// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentInput, SourceScopeUpdates, ScopeRefreshEpochs } from "@omnesis/types";

/** Negotiate new nested keys too: older scope gateways validate strict fact packets. */
export function sourceScopeWireVersion(
  updates: SourceScopeUpdates | undefined,
  documents: readonly DocumentInput[] | undefined,
): 0 | 1 | 2 {
  if (
    updates?.hierarchy ||
    updates?.refreshes?.some(
      (state) =>
        state.epoch !== undefined || state.restart !== undefined || state.requestId !== undefined,
    ) ||
    updates?.conversations?.some((update) => update.refreshEpoch !== undefined) ||
    updates?.documents?.some((update) => update.facts.refreshEpochs !== undefined) ||
    documents?.some(
      (doc) =>
        doc.metadata.scopeHierarchy !== undefined ||
        doc.metadata.scopeFacts?.refreshEpochs !== undefined,
    )
  )
    return 2;
  return updates !== undefined || documents?.some((doc) => doc.metadata.scopeFacts !== undefined)
    ? 1
    : 0;
}
export function parseScopeRefreshEpochs(value: unknown): ScopeRefreshEpochs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: ScopeRefreshEpochs = {};
  for (const kind of ["conversation", "participant", "label", "folder"] as const) {
    const epoch = Object.prototype.hasOwnProperty.call(value, kind)
      ? (value as Record<string, unknown>)[kind]
      : undefined;
    if (typeof epoch === "string" && epoch.length > 0 && epoch.length <= 512) result[kind] = epoch;
  }
  return result;
}
