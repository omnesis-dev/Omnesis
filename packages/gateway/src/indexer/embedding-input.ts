// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The text a chunk is embedded from = a short metadata `preamble` followed by
 * the chunk body. Single-sourced here so every producer agrees byte-for-byte:
 *
 *   - the live indexer chunker ({@link import("./chunker.js").DocumentChunker}),
 *     which builds the preamble from the freshly-fetched document, and
 *   - the double-buffered generation builder
 *     ({@link import("./generation-builder.js").GenerationBuilder}),
 *     which re-embeds the *existing* `chunks` rows under a new model and must
 *     reproduce the exact same embedding input from the stored columns
 *     (`document_type`, `title`, `author`, `source_created_at`, `content`).
 *
 * If these two ever drifted, a graceful embedder swap would build the new
 * generation's vectors from subtly different text than the live index — a
 * silent retrieval-quality regression. Keeping the formatting in one function
 * makes that impossible.
 */

/** The metadata fields that compose a chunk's embedding preamble. */
export interface EmbeddingPreambleFields {
  /** `documents.document_type` (e.g. "email", "note"); omitted when unknown. */
  documentType?: string | null;
  /** The document title. */
  title: string;
  /** Already-derived author display string (see `deriveAuthor`), or null. */
  author?: string | null;
  /** ISO `source_created_at`; only the `YYYY-MM-DD` date is used. */
  sourceCreatedAt?: string | null;
}

/** `[type] title | author | YYYY-MM-DD` — fields absent are simply skipped. */
export function buildEmbeddingPreamble(fields: EmbeddingPreambleFields): string {
  const parts: string[] = [];
  if (fields.documentType) parts.push(`[${fields.documentType}]`);
  parts.push(fields.title);
  if (fields.author) parts.push(`| ${fields.author}`);
  if (fields.sourceCreatedAt) parts.push(`| ${fields.sourceCreatedAt.slice(0, 10)}`);
  return parts.join(" ");
}

/** Compose the full embedding input: `<preamble>\n<chunk body>`. */
export function buildEmbeddingInput(preamble: string, body: string): string {
  return `${preamble}\n${body}`;
}
