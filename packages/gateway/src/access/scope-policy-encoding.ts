// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  SOURCE_FILTER_MAX_ENTRIES,
  canonicalSourceFilters,
  sourceFilterEntryCount,
  sourceFilterSchema,
} from "./scope-policy.js";
import type { SourceFilter } from "@omnesis/types";

/**
 * The storage protocol a saved filter is written at. The storage floor's
 * triggers refuse any other marker, so a build that does not know this
 * protocol cannot rewrite a filter it does not understand.
 */
export const SCOPE_POLICY_STORAGE_PROTOCOL = 1;
export type StoredSourceFilter = SourceFilter & { minimumProtocol: 1 };

export function encodeStoredScopePolicies(filters: readonly SourceFilter[]): StoredSourceFilter[] {
  return canonicalSourceFilters(filters).map((filter) => ({
    ...filter,
    minimumProtocol: SCOPE_POLICY_STORAGE_PROTOCOL,
  }));
}

/** Saved filters stay strict; the protocol marker is understood only at persistence boundaries. */
export function decodeStoredScopePolicies(value: unknown): SourceFilter[] {
  if (!Array.isArray(value) || value.length > SOURCE_FILTER_MAX_ENTRIES)
    throw new Error("Invalid stored source filters.");
  const filters = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid stored source filter.");
    const { minimumProtocol, ...filter } = item as Record<string, unknown>;
    if (minimumProtocol !== undefined && minimumProtocol !== SCOPE_POLICY_STORAGE_PROTOCOL)
      throw new Error("Unsupported source filter storage protocol.");
    return sourceFilterSchema.parse(filter);
  });
  if (sourceFilterEntryCount(filters) > SOURCE_FILTER_MAX_ENTRIES)
    throw new Error(`Stored source filters exceed ${SOURCE_FILTER_MAX_ENTRIES} entries.`);
  return canonicalSourceFilters(filters);
}
