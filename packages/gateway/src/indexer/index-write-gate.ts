// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * IndexWriteGate — the typed surface for every write against
 * `index.db`. Mirrors `WriteGate` (the gateway-DB equivalent) so the
 * single-writer story is symmetric across the two SQLite stores.
 *
 * Why a typed gate:
 *
 * - Pre-gate, three call paths reached into `indexer/db.ts` directly
 *   on raw `Db` handles: HTTP services (`DocumentService`,
 *   `SourceService`) for delete cascades, the indexer worker for its
 *   own writes, and `index.ts`'s model-swap path which briefly
 *   reopened the file writable on the main thread. The pattern was
 *   safe (the indexer worker is disposed before the model-swap reopen
 *   fires; HTTP-side deletes use a long-lived handle) but the
 *   discipline lived in comments, not in the type system.
 *
 * - The gate gives every external caller one method per write op,
 *   tested against a `:memory:` instance via `directIndexWriteGate`,
 *   and a single brief-reopen helper (`withFreshIndexWriteGate`) for
 *   the model-swap shape. Future work that routes index.db writes
 *   through the indexer worker (closing the gap entirely) just adds
 *   a new implementation behind the same interface.
 *
 * The eight methods cover everything currently called from outside
 * `indexer/db.ts`:
 *   - `upsertChunks`, `upsertChunksAndMarkIndexed`, `setIndexedDocument`,
 *     `setWatermark` — indexer-worker writes.
 *   - `deleteChunksByDocument`, `deleteChunksByDocuments`,
 *     `deleteIndexBySource` — HTTP-services delete cascade.
 *   - `wipeAndRecreateVectorIndex` — model-swap reopen.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  createIndexDatabase,
  deleteChunksByDocument,
  deleteChunksByDocumentBatch,
  deleteChunksByDocuments,
  deleteIndexBySource,
  setIndexedDocument,
  setWatermark,
  upsertChunks,
  upsertChunksAndMarkIndexed,
  wipeAndRecreateVectorIndex,
  type ChunkUpsertInput,
  type DocumentIndexDeleteBatchResult,
} from "./db.js";

export interface IndexWriteGate {
  upsertChunks(chunks: readonly ChunkUpsertInput[]): Promise<void>;
  upsertChunksAndMarkIndexed(
    documentId: string,
    contentHash: string,
    chunks: readonly ChunkUpsertInput[],
  ): Promise<void>;
  setIndexedDocument(documentId: string, contentHash: string, chunkCount: number): Promise<void>;
  setWatermark(key: string, value: string): Promise<void>;
  /** Returns the number of `chunks` rows removed. */
  deleteChunksByDocument(documentId: string): Promise<number>;
  /** Cooperatively delete one bounded chunk batch for retention. */
  deleteChunksByDocumentBatch(
    documentId: string,
    limit: number,
    sourceDeleted: boolean,
  ): Promise<DocumentIndexDeleteBatchResult>;
  /** Returns the total number of `chunks` rows removed. */
  deleteChunksByDocuments(documentIds: readonly string[]): Promise<number>;
  /** Returns the number of indexed documents removed. */
  deleteIndexBySource(sourceId: string): Promise<number>;
  wipeAndRecreateVectorIndex(embeddingDim: number, embedModelName?: string): Promise<void>;
}

/**
 * Direct in-process implementation backed by a writable handle on
 * `index.db`. Used by tests AND production HTTP services — both have
 * a long-lived writable handle in scope, so wrapping the existing
 * sync write functions in `Promise.resolve` matches the
 * `directWriteGate(db)` pattern the gateway-DB side already uses.
 */
export function directIndexWriteGate(db: Db): IndexWriteGate {
  return {
    async upsertChunks(chunks) {
      upsertChunks(db, chunks as ChunkUpsertInput[]);
    },
    async upsertChunksAndMarkIndexed(documentId, contentHash, chunks) {
      upsertChunksAndMarkIndexed(db, documentId, contentHash, chunks as ChunkUpsertInput[]);
    },
    async setIndexedDocument(documentId, contentHash, chunkCount) {
      setIndexedDocument(db, documentId, contentHash, chunkCount);
    },
    async setWatermark(key, value) {
      setWatermark(db, key, value);
    },
    async deleteChunksByDocument(documentId) {
      return deleteChunksByDocument(db, documentId);
    },
    async deleteChunksByDocumentBatch(documentId, limit, sourceDeleted) {
      return deleteChunksByDocumentBatch(db, documentId, limit, sourceDeleted);
    },
    async deleteChunksByDocuments(documentIds) {
      return deleteChunksByDocuments(db, documentIds as string[]);
    },
    async deleteIndexBySource(sourceId) {
      return deleteIndexBySource(db, sourceId);
    },
    async wipeAndRecreateVectorIndex(embeddingDim, embedModelName) {
      wipeAndRecreateVectorIndex(db, embeddingDim, embedModelName);
    },
  };
}

/**
 * Gate that routes the one op which must not race the indexer worker —
 * `deleteIndexBySource` — through the worker instead of running it on the
 * HTTP thread, while leaving every other op on the direct in-process path.
 *
 * Why only this op: a source deletion mutates `chunks` / `indexed_documents`
 * / `index_totals` and the HNSW sidecar, and the worker owns the live usearch
 * write handle whenever it is running. The worker performs the deletion
 * immediately on arrival — it cannot interleave with a cycle, since usearch
 * calls are synchronous and a message handler only runs between them — and
 * re-applies it once any in-flight job stops, which is what clears the rows
 * that job wrote for documents it had already read (orphan drift → progress
 * stuck below 100%).
 *
 * `deleteViaWorker` returns a promise whenever an indexer worker owns the
 * files, including during startup, or `undefined` when none does (tests,
 * agent/briefs runtimes, before worker spawn) — in which case the direct path
 * is safe precisely because no worker owns the usearch handle.
 */
export function workerCoordinatedIndexWriteGate(
  db: Db,
  deleteViaWorker: (sourceId: string) => Promise<number> | undefined,
): IndexWriteGate {
  const direct = directIndexWriteGate(db);
  return {
    ...direct,
    async deleteIndexBySource(sourceId) {
      const viaWorker = deleteViaWorker(sourceId);
      if (viaWorker) return viaWorker;
      return direct.deleteIndexBySource(sourceId);
    },
  };
}

/**
 * Open a fresh writable `index.db` handle for the duration of one
 * gate-shaped op, then close it. The model-swap path uses this — the
 * indexer worker has been disposed, so no other writable handle is
 * alive on the file. Encapsulating the brief-reopen here keeps the
 * pattern in one place and obeys the gate contract.
 */
export async function withFreshIndexWriteGate<T>(
  indexDbPath: string,
  fn: (gate: IndexWriteGate) => Promise<T>,
  opts: { encryptionKey?: Buffer | null } = {},
): Promise<T> {
  const db = createIndexDatabase(indexDbPath, { encryptionKey: opts.encryptionKey ?? null });
  try {
    return await fn(directIndexWriteGate(db));
  } finally {
    db.close();
  }
}
