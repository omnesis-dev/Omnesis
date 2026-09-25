// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Metadata filter builder — generates SQL WHERE clauses for structured filters.
 *
 *   - `buildMetadataFilter` — used by the BM25 stage, which queries
 *     the `chunks`/`chunks_fts` tables directly.
 *
 *   - `buildPostJoinFilter` / `hasPostJoinFilter` — used by the HNSW
 *     vector stage for post-filter predicates that run after the KNN
 *     candidate set has been materialized (e.g. `tags` JSON-array
 *     membership, case-insensitive).
 *
 * Person filters (`from:`/`to:`/`with:`) never appear here. The
 * pipeline resolves them up-front into a `document_id` set that
 * BM25 + vector apply as a separate IN clause; the raw refs are not
 * collapsed onto the `chunks.author` column.
 */

import { hiddenSourceIdsToExclude } from "./hidden-sources.js";
import type { SearchFilters } from "./types.js";

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * When `dateTo` is a bare date (YYYY-MM-DD) the lexicographic `<=`
 * comparison against a full ISO timestamp like `2026-05-19T14:30:00Z`
 * excludes everything ON that date because `T` > end-of-string.
 * Normalizing to end-of-day makes the boundary inclusive of the whole day.
 */
export function normalizeDateTo(date: string): string {
  return DATE_ONLY_RE.test(date) ? `${date}T23:59:59.999Z` : date;
}

export interface SqlFilter {
  clause: string;
  params: (string | number)[];
}

/**
 * Build SQL WHERE conditions from search filters, all against the
 * `chunks` table (aliased as `c`). Used by the BM25 stage, which
 * operates entirely on the `chunks`/`chunks_fts` tables.
 */
export function buildMetadataFilter(filters: SearchFilters, tableAlias: string = "c"): SqlFilter {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.sourceIds && filters.sourceIds.length > 0) {
    const placeholders = filters.sourceIds.map(() => "?").join(", ");
    conditions.push(`${tableAlias}.source_id IN (${placeholders})`);
    params.push(...filters.sourceIds);
  }

  if (filters.documentTypes && filters.documentTypes.length > 0) {
    const placeholders = filters.documentTypes.map(() => "?").join(", ");
    conditions.push(`${tableAlias}.document_type IN (${placeholders})`);
    params.push(...filters.documentTypes);
  }

  if (filters.dateFrom) {
    conditions.push(`${tableAlias}.source_created_at >= ?`);
    params.push(filters.dateFrom);
  }

  if (filters.dateTo) {
    conditions.push(`${tableAlias}.source_created_at <= ?`);
    params.push(normalizeDateTo(filters.dateTo));
  }

  if (filters.tags && filters.tags.length > 0) {
    const tagConditions = filters.tags.map(
      () =>
        `EXISTS (SELECT 1 FROM json_each(${tableAlias}.tags) WHERE LOWER(json_each.value) = LOWER(?))`,
    );
    conditions.push(`(${tagConditions.join(" OR ")})`);
    params.push(...filters.tags);
  }

  // Hidden-from-general-search system sources (see hidden-sources.ts):
  // excluded from every lexical/browse candidate query unless the
  // caller's explicit filters name the source or its document type.
  const hiddenSourceIds = hiddenSourceIdsToExclude(filters);
  if (hiddenSourceIds.length > 0) {
    const placeholders = hiddenSourceIds.map(() => "?").join(", ");
    conditions.push(`${tableAlias}.source_id NOT IN (${placeholders})`);
    params.push(...hiddenSourceIds);
  }

  const clause = conditions.length > 0 ? conditions.join(" AND ") : "1=1";
  return { clause, params };
}

/**
 * Build the post-JOIN filter that runs on the `chunks` table after the
 * HNSW candidate set has been materialized. Covers predicates that
 * can't be pre-filtered in the HNSW index: `tags` JSON-array membership
 * (case-insensitive).
 */
export function buildPostJoinFilter(filters: SearchFilters, tableAlias: string = "c"): SqlFilter {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.tags && filters.tags.length > 0) {
    const tagConditions = filters.tags.map(
      () =>
        `EXISTS (SELECT 1 FROM json_each(${tableAlias}.tags) WHERE LOWER(json_each.value) = LOWER(?))`,
    );
    conditions.push(`(${tagConditions.join(" OR ")})`);
    params.push(...filters.tags);
  }

  const clause = conditions.length > 0 ? conditions.join(" AND ") : "";
  return { clause, params };
}

/** Whether any post-JOIN filter is active — for over-query sizing. */
export function hasPostJoinFilter(filters: SearchFilters): boolean {
  return filters.tags !== undefined && filters.tags.length > 0;
}
