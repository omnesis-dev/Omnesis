// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Recency browse — answers restrictor-only queries.
 *
 * A query like `with:Maya`, `from:alice source:gmail`, or
 * `source:whatsapp-messages` carries a document restrictor (a resolved
 * person-filter docId set and/or `source:`/`type:`/`date:` filters) but no
 * free-text terms. BM25 needs FTS MATCH terms and the vector stage needs a
 * query embedding, so neither candidate generator can answer such a query —
 * the pipeline would otherwise fall back to an empty-query KNN that only
 * incidentally returns rows for very large restrictor sets. This lists the
 * matching documents newest-first instead, so "show me everything with X"
 * works uniformly for the CLI, portal, and agent.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import { buildMetadataFilter } from "./metadata.js";
import { withDocIdRestriction } from "./docid-filter.js";
import { visibleChunkClause } from "./visible-chunks.js";
import type { SearchCandidate, SearchFilters } from "./types.js";

interface BrowseRow {
  rowid: number;
  document_id: string;
  chunk_index: number;
  source_id: string;
  document_type: string | null;
  title: string;
  source_url: string | null;
  source_created_at: string;
  author: string | null;
  tags: string | null;
  relevance_score: number | null;
}

/**
 * List documents matching the structured filters, newest first, one
 * representative chunk (the document's first) per document.
 *
 * `documentIds` mirrors `bm25Search`: `undefined` means no person-filter
 * restriction is active; an empty array means a person filter resolved to
 * zero docs, so the result is empty.
 */
export function browseByRecency(
  db: Db,
  filters: SearchFilters,
  documentIds: readonly string[] | undefined,
  limit: number,
): SearchCandidate[] {
  if (documentIds && documentIds.length === 0) return [];

  const { clause: filterClause, params: filterParams } = buildMetadataFilter(filters, "c");

  // The `documentIds` set is unbounded; a large set is staged into a temp table
  // so it never overflows SQLite's bound-variable limit. Pick the
  // most-recent `limit` documents — GROUP BY collapses the per-document chunk
  // fan-out; ORDER BY the max chunk timestamp ranks whole documents by recency.
  const idRows = withDocIdRestriction(
    db,
    "c.document_id",
    documentIds,
    ({ clause: docIdClause, params: docIdParams }) =>
      db
        .prepare<(string | number)[], { document_id: string; mx: string }>(
          `SELECT c.document_id AS document_id, MAX(c.source_created_at) AS mx
       FROM chunks c
       WHERE ${visibleChunkClause("c")}
         AND ${filterClause}${docIdClause}
       GROUP BY c.document_id
       ORDER BY mx DESC
       LIMIT ?`,
        )
        .all(...filterParams, ...docIdParams, limit),
  );

  if (idRows.length === 0) return [];

  const order = new Map<string, number>();
  idRows.forEach((r, i) => order.set(r.document_id, i));
  const ids = idRows.map((r) => r.document_id);

  const chunkRows = db
    .prepare<string[], BrowseRow>(
      `SELECT c.rowid AS rowid, c.document_id AS document_id, c.chunk_index AS chunk_index,
              c.source_id AS source_id, c.document_type AS document_type, c.title AS title,
              c.source_url AS source_url, c.source_created_at AS source_created_at,
              c.author AS author, c.tags AS tags, c.relevance_score AS relevance_score
       FROM chunks c
       WHERE c.document_id IN (${ids.map(() => "?").join(",")})
         AND ${visibleChunkClause("c")}`,
    )
    .all(...ids);

  // Keep the lowest-chunk_index row per document as its representative —
  // chunk 0 carries the document header/title.
  const repByDoc = new Map<string, BrowseRow>();
  for (const row of chunkRows) {
    const existing = repByDoc.get(row.document_id);
    if (!existing || row.chunk_index < existing.chunk_index) {
      repByDoc.set(row.document_id, row);
    }
  }

  // Emit in the recency order from the id query. Score descends with rank
  // so any downstream single-stage projection keeps newest-first.
  const candidates: SearchCandidate[] = [];
  for (const id of ids) {
    const row = repByDoc.get(id);
    if (!row) continue;
    const rank = (order.get(id) ?? 0) + 1;
    candidates.push({
      documentId: row.document_id,
      chunkRowid: row.rowid,
      sourceId: row.source_id,
      documentType: row.document_type ?? "unknown",
      title: row.title,
      sourceUrl: row.source_url,
      sourceCreatedAt: row.source_created_at,
      author: row.author,
      tags: row.tags,
      chunkText: "",
      score: 1 / rank,
      rank,
      relevanceScore: row.relevance_score,
    });
  }
  return candidates;
}

/**
 * Whether a parsed query should be answered by a recency browse: it has no
 * free-text terms but does carry a document restrictor. `allowedDocumentIds`
 * is the resolved person-filter set (`undefined` = no person filter).
 */
export function shouldBrowse(
  effectiveText: string,
  allowedDocumentIds: readonly string[] | undefined,
  filters: SearchFilters,
): boolean {
  if (effectiveText.trim().length > 0) return false;
  const hasPersonFilter = allowedDocumentIds !== undefined;
  const hasMetadataFilter =
    (filters.sourceIds?.length ?? 0) > 0 ||
    (filters.documentTypes?.length ?? 0) > 0 ||
    filters.dateFrom !== undefined ||
    filters.dateTo !== undefined ||
    (filters.tags?.length ?? 0) > 0;
  return hasPersonFilter || hasMetadataFilter;
}
