// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  deleteDocumentsByIds,
  tombstoneDocuments,
} from "../data/repositories/DocumentRepository.js";
import {
  enqueueDocumentCascade,
  type AbsenceCascade,
} from "../data/repositories/AbsenceRepository.js";
import type Database from "better-sqlite3";

export const STORAGE_RETENTION_BATCH_SIZE = 100;

/** Exact row revisions approved by a preview, never an unbounded date predicate. */
export interface StorageRetentionCandidate {
  id: string;
  provider_id: string;
  source_id: string;
  stream_id: string;
  external_id: string;
  content_hash: string;
  updated_at: string;
  source_updated_at: string;
  source_created_at: string;
  title: string;
  metadata: string;
  payload_bytes: number;
}

export interface StorageRetentionBatch {
  sourceId: string;
  before: string;
  candidates: StorageRetentionCandidate[];
  tombstone: boolean;
}

export interface StorageRetentionDeleteResult {
  stale: boolean;
  deleted: number;
  cascade?: AbsenceCascade;
}

/** Destructive cleanup keeps legacy/ambiguous date encodings until normalized. */
function isCanonicalUtcDate(value: string): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const normalized = new Date(timestamp).toISOString();
  return value === normalized || value === normalized.replace(".000Z", "Z");
}

/**
 * The writer checks every revision before deleting anything. The transaction
 * includes the existing durable cross-store outbox, so a crash after SQLite
 * commits cannot forget index/cognition cleanup. No attachment expansion: an
 * unapproved or newer child must survive a parent's removal.
 */
export function deleteStorageRetentionBatch(
  db: Database.Database,
  batch: StorageRetentionBatch,
): StorageRetentionDeleteResult {
  if (batch.candidates.length > STORAGE_RETENTION_BATCH_SIZE) {
    throw new Error("Storage retention batch exceeds its bound");
  }
  return db.transaction(() => {
    const read = db.prepare<[string], StorageRetentionCandidate & { document_type: string | null }>(
      `SELECT id, provider_id, source_id, stream_id, external_id, content_hash,
              updated_at, source_updated_at, source_created_at, title, metadata,
              json_extract(metadata, '$.documentType') AS document_type
         FROM documents WHERE id = ?`,
    );
    const ids = new Set<string>();
    for (const expected of batch.candidates) {
      const current = read.get(expected.id);
      if (
        !current ||
        ids.has(current.id) ||
        current.source_id !== batch.sourceId ||
        current.document_type === "contact" ||
        !isCanonicalUtcDate(current.source_created_at) ||
        Date.parse(current.source_created_at) >= Date.parse(batch.before) ||
        current.provider_id !== expected.provider_id ||
        current.stream_id !== expected.stream_id ||
        current.external_id !== expected.external_id ||
        current.content_hash !== expected.content_hash ||
        current.updated_at !== expected.updated_at ||
        current.source_updated_at !== expected.source_updated_at ||
        current.source_created_at !== expected.source_created_at ||
        current.title !== expected.title ||
        current.metadata !== expected.metadata
      ) {
        return { stale: true, deleted: 0 };
      }
      ids.add(current.id);
    }
    const deletedIds = deleteDocumentsByIds(db, [...ids]);
    if (batch.tombstone) {
      for (const row of batch.candidates) {
        tombstoneDocuments(
          db,
          row.provider_id,
          row.source_id,
          [row.external_id],
          new Map([[row.external_id, row.id]]),
          row.stream_id,
        );
      }
    }
    const cascade = enqueueDocumentCascade(db, deletedIds);
    return { stale: false, deleted: deletedIds.length, ...(cascade ? { cascade } : {}) };
  })();
}
