// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HNSW vector search via usearch — the sole vector engine for Omnesis.
 * Returns `SearchCandidate[]` so the fusion stage consumes them
 * identically to any other candidate source.
 *
 * usearch has no filtered search in its JS bindings. The strategy is
 * over-fetch by a configurable multiplier, JOIN to `chunks` for
 * metadata, then post-filter in JS. An adaptive retry doubles the
 * over-fetch if the first pass yields too few results after filtering.
 */

import { hasPostJoinFilter, normalizeDateTo } from "./metadata.js";
import { hiddenSourceIdsToExclude } from "./hidden-sources.js";
import { visibleChunkClause } from "./visible-chunks.js";
import type Database from "better-sqlite3";
import type { VectorReadSource } from "../indexer/usearch-index.js";
import type { SearchCandidate, SearchFilters } from "./types.js";

type Db = Database.Database;

export interface HnswSearchOptions {
  documentIds?: readonly string[];
  hnswOverFetch?: number;
  /**
   * When true, apply the over-fetch multiplier to EVERY query, not just
   * filtered ones. usearch returns chunks; the fusion stage dedups to
   * distinct documents, so N chunks collapse to far fewer docs (a long
   * doc yields many near-neighbour chunks). Fetching only `limit` chunks
   * leaves the distinct-doc candidate pool well under `candidateLimit`;
   * over-fetching gives the doc-dedup the headroom to reach `limit`
   * distinct docs. Default false (over-fetch only when filters are
   * present, to feed the JS post-filter).
   */
  alwaysOverFetch?: boolean;
}

export function hnswSearchCandidates(
  usearch: VectorReadSource,
  indexDb: Db,
  queryEmbedding: Float32Array,
  filters: SearchFilters,
  limit: number,
  options?: HnswSearchOptions,
): SearchCandidate[] {
  const overFetch = options?.hnswOverFetch ?? 10;
  const hasDocIdFilter = options?.documentIds !== undefined;
  const hasFilters =
    hasPostJoinFilter(filters) ||
    hasDocIdFilter ||
    (filters.sourceIds && filters.sourceIds.length > 0) ||
    (filters.documentTypes && filters.documentTypes.length > 0);

  // Over-fetch headroom. With `alwaysOverFetch`, every query multiplies so
  // the doc-dedup in fusion (N chunks → fewer distinct docs) can still reach
  // `limit` distinct documents. Without it, only filtered queries over-fetch
  // — there the multiplier exists to survive the JS post-filter. `hasFilters`
  // continues to gate the adaptive retry below regardless of this flag.
  const multiplier = options?.alwaysOverFetch || hasFilters ? overFetch : 1;
  let effectiveK = Math.max(limit, limit * multiplier);

  const results = fetchAndFilter(
    usearch,
    indexDb,
    queryEmbedding,
    effectiveK,
    limit,
    filters,
    options?.documentIds,
  );

  if (results.length >= limit || !hasFilters) return results;

  // Adaptive retry: double the over-fetch for selective filters.
  effectiveK = Math.max(effectiveK * 2, limit * overFetch * 2);
  return fetchAndFilter(
    usearch,
    indexDb,
    queryEmbedding,
    effectiveK,
    limit,
    filters,
    options?.documentIds,
  );
}

function fetchAndFilter(
  usearch: VectorReadSource,
  indexDb: Db,
  queryEmbedding: Float32Array,
  effectiveK: number,
  limit: number,
  filters: SearchFilters,
  documentIds?: readonly string[],
): SearchCandidate[] {
  const hnswResults = usearch.search(queryEmbedding, effectiveK);
  if (hnswResults.length === 0) return [];

  const rowids = hnswResults.map((r) => r.key);
  const distanceByRowid = new Map<bigint, number>();
  for (const r of hnswResults) distanceByRowid.set(r.key, r.distance);

  // Batch fetch chunk metadata via rowid IN (...).
  const placeholders = rowids.map(() => "?").join(",");
  const rows = indexDb
    .prepare(
      // `content` is deliberately NOT selected: the chunks table is 2+ GB and
      // reading (decrypting, under storage encryption) a content blob for every
      // over-fetched candidate — most of which are discarded by filtering /
      // top-k — is pure waste. The vector stage scores by distance, never by
      // text; the pipeline hydrates `chunkText` for the FINAL results by
      // chunkRowid (see hydrate-chunks.ts), exactly as the BM25 + browse paths do.
      `SELECT c.rowid, c.document_id, c.source_id, c.document_type,
              c.title, c.source_url, c.source_created_at, c.author, c.tags, c.relevance_score
         FROM chunks c
        WHERE c.rowid IN (${placeholders})
          AND ${visibleChunkClause("c")}`,
    )
    .all(...rowids.map(Number)) as Array<{
    rowid: number;
    document_id: string;
    source_id: string;
    document_type: string | null;
    title: string;
    source_url: string | null;
    source_created_at: string;
    author: string | null;
    tags: string | null;
    relevance_score: number | null;
  }>;

  const docIdSet = documentIds ? new Set(documentIds) : undefined;

  // Tags filter: case-insensitive JSON-array membership check in JS.
  const filterTags = filters.tags?.map((t) => t.toLowerCase());

  // Normalize a bare `dateTo` (YYYY-MM-DD) to end-of-day so the `>` exclusion
  // is inclusive of the whole day — matching the BM25 lexical path. Without
  // this, a doc dated `2026-05-19T14:30:00Z` is wrongly dropped by
  // `dateTo = "2026-05-19"` because `"2026-05-19T…" > "2026-05-19"`.
  const dateTo = filters.dateTo ? normalizeDateTo(filters.dateTo) : undefined;

  // Hidden-from-general-search system sources (see hidden-sources.ts) —
  // the vector path's equivalent of the lexical NOT IN clause.
  const hiddenSourceIds = hiddenSourceIdsToExclude(filters);

  const candidates: SearchCandidate[] = [];
  for (const row of rows) {
    if (hiddenSourceIds.includes(row.source_id)) continue;
    if (filters.sourceIds?.length && !filters.sourceIds.includes(row.source_id)) continue;
    if (
      filters.documentTypes?.length &&
      (!row.document_type || !filters.documentTypes.includes(row.document_type))
    )
      continue;
    if (filters.dateFrom && row.source_created_at < filters.dateFrom) continue;
    if (dateTo && row.source_created_at > dateTo) continue;
    if (docIdSet && !docIdSet.has(row.document_id)) continue;

    if (filterTags?.length) {
      const rowTags: string[] = row.tags ? JSON.parse(row.tags) : [];
      const lower = rowTags.map((t) => t.toLowerCase());
      if (!filterTags.every((ft) => lower.includes(ft))) continue;
    }

    const distance = distanceByRowid.get(BigInt(row.rowid)) ?? 1;
    candidates.push({
      documentId: row.document_id,
      chunkRowid: row.rowid,
      sourceId: row.source_id,
      documentType: row.document_type ?? "",
      title: row.title,
      sourceUrl: row.source_url,
      sourceCreatedAt: row.source_created_at,
      author: row.author,
      tags: row.tags,
      chunkText: "", // hydrated for final results by chunkRowid (hydrate-chunks.ts)
      score: 1 - distance,
      rank: 0,
      relevanceScore: row.relevance_score,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  for (let i = 0; i < candidates.length; i++) candidates[i].rank = i + 1;
  return candidates.slice(0, limit);
}
