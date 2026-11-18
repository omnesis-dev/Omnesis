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
import { isCanonicalRetentionDate } from "./retention-policy.js";
import type Database from "better-sqlite3";

export const STORAGE_RETENTION_BATCH_SIZE = 100;

/** Bounded document headers resolved by the background cursor reader. */
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

export interface StorageRetentionDeleteResult {
  stale: boolean;
  deleted: number;
  cascade?: AbsenceCascade;
}

/** Recheck a bounded page on the writer; whole-cutoff jobs authorize current eligible revisions. */
export function currentStorageRetentionCandidates(
  db: Database.Database,
  sourceId: string,
  before: string,
  candidates: readonly StorageRetentionCandidate[],
): StorageRetentionCandidate[] {
  const read = db.prepare<[string], StorageRetentionCandidate & { document_type: string | null }>(
    `SELECT id, provider_id, source_id, stream_id, external_id, content_hash,
       updated_at, source_updated_at, source_created_at, title, metadata, 0 AS payload_bytes,
       json_extract(metadata, '$.documentType') AS document_type FROM documents WHERE id = ?`,
  );
  const ids = new Set<string>();
  const valid: StorageRetentionCandidate[] = [];
  for (const expected of candidates) {
    const current = read.get(expected.id);
    if (
      !current ||
      ids.has(current.id) ||
      current.source_id !== sourceId ||
      current.document_type === "contact" ||
      !isCanonicalRetentionDate(current.source_created_at) ||
      Date.parse(current.source_created_at) >= Date.parse(before)
    )
      continue;
    ids.add(current.id);
    valid.push(current);
  }
  return valid;
}

/** The shared deletion primitive: exact ids, normal derived bookkeeping, tombstones and durable cascade. */
export function removeStorageRetentionCandidates(
  db: Database.Database,
  candidates: readonly StorageRetentionCandidate[],
  tombstone: boolean,
): StorageRetentionDeleteResult {
  const deletedIds = deleteDocumentsByIds(
    db,
    candidates.map((row) => row.id),
  );
  if (tombstone) {
    for (const row of candidates)
      tombstoneDocuments(
        db,
        row.provider_id,
        row.source_id,
        [row.external_id],
        new Map([[row.external_id, row.id]]),
        row.stream_id,
      );
  }
  const cascade = enqueueDocumentCascade(db, deletedIds);
  return { stale: false, deleted: deletedIds.length, ...(cascade ? { cascade } : {}) };
}
