// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Exclude source-deleted documents whose durable index purge has not finished.
 *
 * The background indexer removes these rows in bounded batches. Keeping the
 * tombstone in each search query makes the source deletion visible immediately
 * without an unbounded startup scrub.
 */
export function visibleChunkClause(chunkAlias: string): string {
  return `NOT EXISTS (
    SELECT 1
      FROM pending_document_index_purges pending_purge
     WHERE pending_purge.document_id = ${chunkAlias}.document_id
       AND pending_purge.source_deleted = 1
  )`;
}
