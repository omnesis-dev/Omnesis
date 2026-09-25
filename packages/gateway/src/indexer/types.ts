// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Interfaces for the indexer pipeline.
 * Each boundary is abstracted so components can be swapped
 * (e.g., replace with QMD's search layer in the future).
 */

import type { ListedDocument } from "@omnesis/source-sdk";

// ---------------------------------------------------------------------------
// Document source — where documents come from
// ---------------------------------------------------------------------------

/**
 * The shape the indexer pipeline operates on. Per #386,
 * this is now an alias for the canonical `ListedDocument` from
 * `@omnesis/core` — the same shape the gateway's `/documents/list`
 * HTTP route serves and the same shape `DirectDocumentSource` reads
 * from `omnesis.db`. A single field addition lands in core's
 * declaration and propagates to all three consumers.
 *
 * The `IndexableDocument` name is kept as an alias so the existing
 * indexer call sites continue to read naturally ("we're indexing a
 * document"), even though the type itself is shared.
 */
export type IndexableDocument = ListedDocument;

/**
 * Lightweight projection returned by `listUpdatedLightweight()`.
 * Contains only the columns needed to determine whether a document
 * needs re-embedding (content hash comparison, cutoff filtering)
 * without materialising the potentially-large `content` and
 * `metadata` blobs.
 */
export interface LightweightDocumentHeader {
  id: string;
  sourceId: string;
  contentHash: string;
  /**
   * Canonicalized `documents.source_url`. Carried in the lightweight scan
   * so a URL-only change (content hash unchanged) can be propagated to the
   * denormalized `chunks.source_url` column in place — without paying for a
   * full content fetch + re-embed. See #462.
   */
  sourceUrl: string | null;
  sourceCreatedAt: string;
  updatedAt: string;
  /** `metadata.documentType` — the retention cutoff exempts contacts. */
  documentType: string | null;
}

export interface DocumentSource {
  /** Fetch documents updated since the given timestamp (paginated). */
  listUpdated(
    since: string | null,
    limit: number,
    afterId?: string,
  ): Promise<{ documents: IndexableDocument[]; hasMore: boolean }>;

  /**
   * Lightweight variant of `listUpdated`. Returns only the columns
   * needed for content-hash comparison and cutoff filtering, without
   * materialising `content` or `metadata`. Used by the two-phase fetch
   * in `indexUpdated()` to determine which docs actually need
   * re-embedding before paying the cost of a full content fetch.
   */
  listUpdatedLightweight(
    since: string | null,
    limit: number,
    afterId?: string,
  ): Promise<{ documents: LightweightDocumentHeader[]; hasMore: boolean }>;

  /** Fetch all current document IDs (for deletion reconciliation). */
  listAllIds(): Promise<string[]>;

  /**
   * Batch-fetch documents by id. Used by the retry path so re-trying N
   * failed docs costs one source call, not N×M paginated scans.
   * Documents not found in the source are absent from the result.
   */
  getByIds(ids: string[]): Promise<IndexableDocument[]>;

  /**
   * Whether any document currently belongs to `sourceId`. Used by the
   * source-attribution reconcile to tell a live source from a retired one:
   * a source with indexed chunks but zero documents has been re-homed and
   * its chunks need re-pointing onto the surviving source.
   */
  hasDocuments(sourceId: string): Promise<boolean>;

  /**
   * Current `source_id` for each requested document id, keyed by id; ids of
   * documents that no longer exist are absent. Used by the source-attribution
   * reconcile to re-point a re-homed document's index chunks onto its new
   * source.
   */
  getSourceIdsByIds(ids: string[]): Promise<Map<string, string>>;
}

// ---------------------------------------------------------------------------
// Chunker — splits documents into embeddable pieces
// ---------------------------------------------------------------------------

export interface Chunk {
  /** 0-based index within the document */
  index: number;
  /** The chunk text (stored in the index for display) */
  text: string;
  /** Text with metadata preamble for embedding (not stored) */
  embeddingInput: string;
}

export interface Chunker {
  chunk(doc: IndexableDocument): Chunk[];
}

// ---------------------------------------------------------------------------
// Embedder — generates vector embeddings
// ---------------------------------------------------------------------------

export interface Embedder {
  /** Embed a batch of document texts. Returns one vector per input. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Embed a single search query. */
  embedQuery(query: string): Promise<Float32Array>;
  /** Clean up resources. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  query: string;
  limit?: number;
  sourceIds?: string[];
  documentTypes?: string[];
  dateFrom?: string;
  dateTo?: string;
}

export interface SearchResult {
  documentId: string;
  sourceId: string;
  documentType: string;
  title: string;
  sourceUrl?: string;
  sourceCreatedAt: string;
  author?: string;
  chunkText: string;
  score: number;
}
