// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import usearch from "usearch";
import { EMBEDDING_DIM, getActiveIndexVersion, getIndexVersion } from "../indexer/db.js";
import { buildMetadataFilter, normalizeDateTo } from "./metadata.js";
import { DEFAULT_SEARCH_PARAMS, DEFAULT_VECTOR_CONFIG } from "./search-config.js";
import { visibleChunkClause } from "./visible-chunks.js";
import type Database from "better-sqlite3";
import type { SearchCandidate, SearchFilters } from "./types.js";

// Reuse the normal default ANN candidate work budget as a hard ceiling. Larger
// operator settings must not turn this small-corpus path into a global scan.
const MAX_ROWS = DEFAULT_SEARCH_PARAMS.candidateLimit * DEFAULT_VECTOR_CONFIG.hnswOverFetch;
const MAX_VECTOR_BYTES = MAX_ROWS * EMBEDDING_DIM * Float32Array.BYTES_PER_ELEMENT;

interface Row {
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
  embedding: Buffer;
}

/** null means use ANN; [] means the complete bounded eligible set is empty. */
export function boundedExactVectorCandidates(
  db: Database.Database,
  query: Float32Array,
  filters: SearchFilters,
  limit: number,
  candidateBudget: number,
  documentIds?: readonly string[],
  expectedModelId?: string | null,
): SearchCandidate[] | null {
  const bound = Math.min(MAX_ROWS, Math.floor(candidateBudget));
  if (bound < 1 || query.byteLength > MAX_VECTOR_BYTES || !query.length) return null;
  if (!query.every(Number.isFinite)) return null;
  if (
    (documentIds?.length ?? 0) +
      (filters.sourceIds?.length ?? 0) +
      (filters.documentTypes?.length ?? 0) >
    MAX_ROWS
  )
    return null;
  if (documentIds?.length === 0) return [];
  // Vector tags require ALL tags, unlike the lexical helper's OR semantics.
  // Apply them after bounded row discovery; an oversized prefilter simply uses ANN.
  const metadata = buildMetadataFilter({ ...filters, tags: undefined });
  // Choose one indexed scope, then stop at bound+1 before evaluating sparse
  // visibility/secondary predicates. LIMIT after all predicates could otherwise
  // walk an arbitrarily large excluded corpus to discover a few eligible rows.
  let scope = "1=1";
  let scopeParams: (string | number)[] = [];
  const ids = documentIds?.length
    ? documentIds
    : filters.sourceIds?.length
      ? filters.sourceIds
      : filters.documentTypes;
  if (ids?.length) {
    const column = documentIds?.length
      ? "document_id"
      : filters.sourceIds?.length
        ? "source_id"
        : "document_type";
    scope = `c.${column} IN (${ids.map(() => "?").join(",")})`;
    scopeParams = [...ids];
  } else if (filters.dateFrom || filters.dateTo) {
    const clauses: string[] = [];
    if (filters.dateFrom) {
      clauses.push("c.source_created_at>=?");
      scopeParams.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      clauses.push("c.source_created_at<=?");
      scopeParams.push(normalizeDateTo(filters.dateTo));
    }
    scope = clauses.join(" AND ");
  }
  return db.transaction(() => {
    // A generation can flip after the outer registry guard. Bind model identity
    // and dimensions to the SAME committed snapshot as the embedding bytes.
    const version = getActiveIndexVersion(db);
    if (version !== null) {
      const active = getIndexVersion(db, version);
      if (
        !active ||
        active.embed_dim !== query.length ||
        (expectedModelId != null && active.embed_model !== expectedModelId)
      )
        throw new Error("Exact vector snapshot belongs to a different embedding generation");
    }
    const headers = db
      .prepare<
        unknown[],
        { rowid: number; bytes: number | null }
      >(`SELECT c.rowid,length(c.embedding) AS bytes FROM chunks c WHERE ${scope} LIMIT ?`)
      .all(...scopeParams, bound + 1);
    if (headers.length > bound) return null;
    if (!headers.length) return [];
    if (
      headers.some((row) => row.bytes !== query.byteLength) ||
      headers.reduce((sum, row) => sum + (row.bytes ?? 0), 0) > MAX_VECTOR_BYTES
    )
      return null;
    const rows = db
      .prepare<unknown[], Row>(
        `SELECT c.rowid,c.document_id,c.source_id,c.document_type,c.title,c.source_url,
              c.source_created_at,c.author,c.tags,c.relevance_score,c.embedding
       FROM chunks c WHERE c.rowid IN (${headers.map(() => "?").join(",")})
         AND ${metadata.clause} AND ${visibleChunkClause("c")}`,
      )
      .all(...headers.map((row) => row.rowid), ...metadata.params);
    const tags = filters.tags?.map((tag) => tag.toLowerCase());
    const eligible = rows.filter((row) => {
      if (!tags?.length) return true;
      const actual = row.tags
        ? (JSON.parse(row.tags) as string[]).map((tag) => tag.toLowerCase())
        : [];
      return tags.every((tag) => actual.includes(tag));
    });
    if (!eligible.length) return [];
    const matrix = new Float32Array(eligible.length * query.length);
    for (let i = 0; i < eligible.length; i++) {
      const blob = eligible[i]!.embedding;
      // SQLite buffers need not begin on a Float32-aligned byte offset.
      for (let j = 0; j < query.length; j++) {
        const value = blob.readFloatLE(j * Float32Array.BYTES_PER_ELEMENT);
        if (!Number.isFinite(value)) return null;
        matrix[i * query.length + j] = value;
      }
    }
    // Exact SIMD cosine on only the bounded matrix. Ask for every eligible row
    // before applying stable ties, so native top-k tie selection cannot drift.
    const matches = usearch.exactSearch(
      matrix,
      query,
      query.length,
      eligible.length,
      usearch.MetricKind.Cos,
      1,
    );
    const candidates: SearchCandidate[] = [];
    for (let i = 0; i < matches.keys.length; i++) {
      const row = eligible[Number(matches.keys[i])]!;
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
        relevanceScore: row.relevance_score,
        chunkText: "",
        score: 1 - matches.distances[i]!,
        rank: 0,
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.chunkRowid! - b.chunkRowid!);
    candidates.forEach((candidate, i) => {
      candidate.rank = i + 1;
    });
    return candidates.slice(0, limit);
  })();
}
