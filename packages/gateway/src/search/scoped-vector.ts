// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import usearch from "usearch";
import { buildMetadataFilter } from "./metadata.js";
import { withDocIdRestriction } from "./docid-filter.js";
import { visibleChunkClause } from "./visible-chunks.js";
import type { Db } from "../data/types.js";
import type { SearchCandidate, SearchFilters } from "./types.js";

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

/**
 * Native ANN bindings cannot filter neighbours. Stream only SQL-authorized
 * vectors through bounded exact batches, retaining a bounded ranked head.
 * Hidden vectors never enter ranking and cannot consume its candidate budget.
 */
export function scopedVectorCandidates(
  db: Db,
  query: Float32Array,
  filters: SearchFilters,
  limit: number,
  documentIds?: readonly string[],
  extra?: { sql: string; params: Array<string | number> },
): SearchCandidate[] {
  if (!query.length || !query.every(Number.isFinite) || limit < 1) return [];
  const metadata = buildMetadataFilter({ ...filters, tags: undefined });
  const tags = (filters.tags ?? []).map(
    () => "EXISTS (SELECT 1 FROM json_each(c.tags) st WHERE lower(st.value)=?)",
  );
  return withDocIdRestriction(db, "c.document_id", documentIds, ({ clause, params }) => {
    const statement = db.prepare<
      unknown[],
      Row
    >(`SELECT c.rowid,c.document_id,c.source_id,c.document_type,c.title,
      c.source_url,c.source_created_at,c.author,c.tags,c.relevance_score,c.embedding
      FROM chunks c WHERE c.embedding IS NOT NULL AND ${visibleChunkClause("c")} AND ${metadata.clause}${clause}
      ${tags.length ? `AND ${tags.join(" AND ")}` : ""} ${extra ? `AND (${extra.sql})` : ""}`);
    let head: SearchCandidate[] = [];
    let batch: Row[] = [];
    const flush = () => {
      if (!batch.length) return;
      const matrix = new Float32Array(batch.length * query.length);
      for (let i = 0; i < batch.length; i++) {
        if (batch[i]!.embedding.length !== query.byteLength)
          throw new Error("Scoped vector dimensions changed.");
        for (let j = 0; j < query.length; j++) {
          const value = batch[i]!.embedding.readFloatLE(j * 4);
          if (!Number.isFinite(value)) throw new Error("Invalid scoped vector.");
          matrix[i * query.length + j] = value;
        }
      }
      const matches = usearch.exactSearch(
        matrix,
        query,
        query.length,
        batch.length,
        usearch.MetricKind.Cos,
        1,
      );
      for (let i = 0; i < matches.keys.length; i++) {
        const row = batch[Number(matches.keys[i])]!;
        head.push({
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
      head.sort((a, b) => b.score - a.score || a.chunkRowid! - b.chunkRowid!);
      head = head.slice(0, limit);
      batch = [];
    };
    for (const row of statement.iterate(
      ...metadata.params,
      ...params,
      ...(filters.tags ?? []).map((tag) => tag.toLowerCase()),
      ...(extra?.params ?? []),
    )) {
      batch.push(row);
      if (batch.length === 256) flush();
    }
    flush();
    head.forEach((row, i) => {
      row.rank = i + 1;
    });
    return head;
  });
}
