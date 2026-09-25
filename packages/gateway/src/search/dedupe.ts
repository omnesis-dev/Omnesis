// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Post-pipeline dedupe by `content_hash`.
 *
 * The hybrid search pipeline already dedupes by `document_id` inside
 * fusion (same doc, multiple matching chunks → one row), but distinct
 * documents whose bodies are byte-identical still survive. The most
 * common offenders:
 *   - Drive re-uploads of the same PDF under different file IDs.
 *   - Duplicate captured pages reached via different URLs.
 *
 * Those duplicates push genuinely different documents off the top-k
 * frame the caller sees. This helper collapses them: group by
 * `content_hash` (sourced from the indexer's `indexed_documents`
 * table) and keep the first occurrence per group.
 *
 * Because the caller passes results already sorted by final score,
 * "first occurrence per hash" is equivalent to "highest score per
 * hash" — no second sort needed.
 *
 * Results whose document has no `indexed_documents` row (e.g. very
 * recently ingested, indexer hasn't caught up) pass through
 * unconditionally. Dropping fresh content because we can't dedupe it
 * yet is worse than letting the rare duplicate through.
 */

import type Database from "better-sqlite3";
import type { SearchResultItem } from "./types.js";

type Db = Database.Database;

interface HashRow {
  document_id: string;
  content_hash: string;
}

/**
 * Bulk-fetch `content_hash` for a candidate doc set into a plain map
 * (`document_id → content_hash`). A single `IN (?, ?, ...)` statement keeps
 * the latency cost O(1) round-trip even at large pool sizes; docs with no
 * `indexed_documents` row are simply absent from the map.
 *
 * The map is a null-prototype object so an odd `document_id` (e.g.
 * `"__proto__"`) can never alias `Object.prototype` — a `hashByDoc[id]` miss
 * is always `undefined`. It is structured-clone-safe, so the search-worker can
 * return it verbatim and the main thread consumes it via
 * {@link dedupeByContentHashWith} without a second `index.db` read.
 */
export function fetchContentHashByDoc(
  indexDb: Db,
  documentIds: readonly string[],
): Record<string, string> {
  const hashByDoc: Record<string, string> = Object.create(null);
  if (documentIds.length === 0) return hashByDoc;
  const docIds = [...new Set(documentIds)];
  const placeholders = docIds.map(() => "?").join(",");
  const hashRows = indexDb
    .prepare<
      string[],
      HashRow
    >(`SELECT document_id, content_hash FROM indexed_documents WHERE document_id IN (${placeholders})`)
    .all(...docIds);
  for (const r of hashRows) hashByDoc[r.document_id] = r.content_hash;
  return hashByDoc;
}

/**
 * Drop duplicate-content results using a pre-fetched `document_id →
 * content_hash` map, then slice to `limit`. This is the pure core: it issues
 * no database reads, so the finalize path can dedupe over a map the worker
 * already returned.
 *
 * Preserves the relative ordering of the surviving results — the first
 * occurrence per `content_hash` wins, which is the highest-scoring
 * representative by virtue of the input already being sorted by score. A
 * document absent from the map (fresh ingest, not yet indexed) passes through
 * unconditionally; classifying it as a duplicate of anything is worse than
 * letting the rare duplicate through.
 */
export function dedupeByContentHashWith(
  hashByDoc: Record<string, string>,
  results: readonly SearchResultItem[],
  limit: number,
): SearchResultItem[] {
  if (results.length === 0) return [];

  const seen = new Set<string>();
  const deduped: SearchResultItem[] = [];
  for (const result of results) {
    const hash = hashByDoc[result.documentId];
    if (hash === undefined) {
      // No indexed_documents row — fresh ingest, not yet indexed.
      // Pass through; we can't classify it as a duplicate of anything.
      deduped.push(result);
      if (deduped.length >= limit) break;
      continue;
    }
    if (seen.has(hash)) continue;
    seen.add(hash);
    deduped.push(result);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

/**
 * Drop duplicate-content results, then slice to `limit`.
 *
 * `indexDb` is the read-side handle (`SearchPipelineOptions.indexDb`);
 * the lookup is a single indexed point-query per candidate batch. Thin wrapper
 * over {@link fetchContentHashByDoc} + {@link dedupeByContentHashWith}.
 */
export function dedupeByContentHash(
  indexDb: Db,
  results: readonly SearchResultItem[],
  limit: number,
): SearchResultItem[] {
  if (results.length === 0) return [];
  const hashByDoc = fetchContentHashByDoc(
    indexDb,
    results.map((r) => r.documentId),
  );
  return dedupeByContentHashWith(hashByDoc, results, limit);
}
