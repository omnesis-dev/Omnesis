// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { storageAccountingMetadata, storageAccountingPage } from "./accounting.js";
import { STORAGE_RETENTION_BATCH_SIZE, type StorageRetentionCandidate } from "./retention-store.js";
import type Database from "better-sqlite3";
import type { ReadPort } from "../scheduler/read-port.js";

function storageRetentionCandidates(
  db: Database.Database,
  sourceId: string,
  before: string,
): StorageRetentionCandidate[] {
  return db
    .prepare<[string, string, number], StorageRetentionCandidate>(
      `SELECT id, provider_id, source_id, stream_id, external_id, content_hash,
            updated_at, source_updated_at, source_created_at, title, metadata,
            length(CAST(content AS BLOB)) + length(CAST(title AS BLOB)) + length(CAST(metadata AS BLOB)) AS payload_bytes
       FROM documents WHERE source_id = ? AND source_created_at < ?
        AND (source_created_at = strftime('%Y-%m-%dT%H:%M:%fZ', source_created_at)
          OR source_created_at = strftime('%Y-%m-%dT%H:%M:%SZ', source_created_at))
        AND COALESCE(json_extract(metadata, '$.documentType'), '') <> 'contact'
       ORDER BY source_created_at, id LIMIT ?`,
    )
    .all(sourceId, before, STORAGE_RETENTION_BATCH_SIZE + 1);
}

/** Corpus aggregates and candidate reads run on the gateway's existing read workers. */
export const STORAGE_READS = {
  storageRetentionCandidates,
  storageAccountingMetadata,
  storageAccountingPage,
};
export type StorageReads = ReadPort<typeof STORAGE_READS>;
