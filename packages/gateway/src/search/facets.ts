// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Facet builder for the search pipeline.
 *
 * Owned here (not in `pipeline.ts`) so the orchestrator
 * stays narrowly responsible for stage execution. Today the facet shape
 * is a per-type + per-source count over the final result set; future
 * facets (dateRange buckets, persons, tags) extend this module without
 * touching the pipeline.
 */

import type { SearchFacets, SearchResultItem } from "./types.js";

/**
 * Build the byType + bySource facet counts from the final, fused +
 * filtered result list. The portal renders these as filter-pill
 * badges next to the result list.
 */
export function buildFacets(results: SearchResultItem[]): SearchFacets {
  const byType: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const r of results) {
    byType[r.documentType] = (byType[r.documentType] ?? 0) + 1;
    bySource[r.sourceId] = (bySource[r.sourceId] ?? 0) + 1;
  }
  return { byType, bySource };
}
