// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  completeDocumentIndexPurges,
  completePendingVectorDeletes,
  deleteChunksByDocumentBatch,
  enqueueDocumentIndexPurge,
  preparePendingVectorDeletes,
  type DocumentIndexDeleteBatchResult,
} from "./db.js";
import type Database from "better-sqlite3";
import type { UsearchWriteHandle } from "./usearch-index.js";

export const DOCUMENT_PURGE_BATCH_SIZE = 100;
export const DOCUMENT_PURGE_CHUNK_LIMIT = 64;

/**
 * One cooperative SQL/vector purge group, published with at most one graph save.
 * SQL counters are maintained by each bounded delete; rescanning the whole
 * chunks table here would make repeated retention batches quadratic.
 *
 * An in-flight indexing cycle can restore rows it already read. Its durable
 * reapply obligations stay pending until that owner drains, and the caller
 * receives incomplete even if this pass removed every currently visible row.
 */
export function purgeDocumentIndexBatch(
  resources: { indexDb: Database.Database; usearchHandle?: UsearchWriteHandle },
  documentIds: readonly string[],
  limit: number,
  sourceDeleted: boolean,
  inFlight: boolean,
): DocumentIndexDeleteBatchResult {
  const ids = [...new Set(documentIds)];
  if (ids.length > DOCUMENT_PURGE_BATCH_SIZE)
    throw new Error(`Document purge accepts at most ${DOCUMENT_PURGE_BATCH_SIZE} documents`);
  if (!Number.isInteger(limit) || limit < 1 || limit > DOCUMENT_PURGE_CHUNK_LIMIT)
    throw new Error(
      `Document purge chunk limit must be between 1 and ${DOCUMENT_PURGE_CHUNK_LIMIT}`,
    );
  const completed: string[] = [];
  let deletedChunks = 0,
    complete = true,
    readyForSourceDelete = true;
  for (const documentId of ids) {
    enqueueDocumentIndexPurge(resources.indexDb, documentId, sourceDeleted);
    const result = deleteChunksByDocumentBatch(
      resources.indexDb,
      documentId,
      limit,
      sourceDeleted,
      {
        usearch: resources.usearchHandle,
      },
    );
    deletedChunks += result.deletedChunks;
    complete &&= result.complete;
    readyForSourceDelete &&= result.readyForSourceDelete;
    if (sourceDeleted && result.complete) completed.push(documentId);
  }
  if (inFlight) return { deletedChunks, complete: false, readyForSourceDelete };
  if (completed.length > 0) {
    // Independent vector removals remain durable if a graph is absent or shed.
    const prepared = preparePendingVectorDeletes(
      resources.indexDb,
      resources.usearchHandle,
      DOCUMENT_PURGE_BATCH_SIZE * DOCUMENT_PURGE_CHUNK_LIMIT,
    );
    resources.usearchHandle?.save();
    completePendingVectorDeletes(resources.indexDb, prepared);
    completeDocumentIndexPurges(resources.indexDb, completed);
  }
  return { deletedChunks, complete, readyForSourceDelete };
}
