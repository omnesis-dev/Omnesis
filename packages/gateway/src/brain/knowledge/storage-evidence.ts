// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertKnowledgeRunFence, type KnowledgeRunFence } from "./run-fence.js";
import { KnowledgeStorageError } from "./types.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import { knowledgeHash } from "./storage-validation.js";
import type Database from "better-sqlite3";

export interface KnowledgeEvidence {
  id: string;
  documentId: string;
  contentHash: string;
  quote: string;
  start: number;
  end: number;
}
export function registerKnowledgeEvidence(
  db: Database.Database,
  input: { documentId: string; contentHash: string; quote: string; start?: number },
  now: number,
  runFence?: KnowledgeRunFence,
): KnowledgeEvidence {
  return db.transaction(() => {
    assertKnowledgeRunFence(db, runFence);
    const doc = db
      .prepare<
        [string],
        { content_hash: string; content: string }
      >("SELECT content_hash,content FROM documents WHERE id=?")
      .get(input.documentId);
    const tombstone = db
      .prepare<
        [string],
        { deleted: number }
      >("SELECT deleted FROM knowledge_source_revisions WHERE document_id=?")
      .get(input.documentId);
    if (!doc || tombstone?.deleted || !isKnowledgeEvidenceReadable(db, input.documentId))
      throw new KnowledgeStorageError("reference_invalid", "Evidence document does not exist");
    if (doc.content_hash !== input.contentHash)
      throw new KnowledgeStorageError("revision_conflict", "Evidence document changed");
    if (!input.quote || input.quote.length > 32000)
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Evidence quote must contain at most 32000 characters",
      );
    const start = input.start ?? doc.content.indexOf(input.quote);
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      doc.content.slice(start, start + input.quote.length) !== input.quote
    )
      throw new KnowledgeStorageError(
        "reference_invalid",
        "Evidence quote does not match the current source",
      );
    const id = knowledgeHash([input.documentId, input.contentHash, start, input.quote]);
    db.prepare(
      "INSERT OR IGNORE INTO knowledge_evidence(id,document_id,content_hash,quote,span_start,span_end,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      id,
      input.documentId,
      input.contentHash,
      input.quote,
      start,
      start + input.quote.length,
      now,
    );
    return {
      id,
      documentId: input.documentId,
      contentHash: input.contentHash,
      quote: input.quote,
      start,
      end: start + input.quote.length,
    };
  })();
}
/** Stale/deleted passages are never returned as usable evidence. */
export function getKnowledgeEvidence(db: Database.Database, id: string): KnowledgeEvidence | null {
  const row = db
    .prepare<
      [string],
      {
        id: string;
        document_id: string;
        content_hash: string;
        quote: string;
        span_start: number;
        span_end: number;
      }
    >(
      `
    SELECT e.* FROM knowledge_evidence e JOIN documents d ON d.id=e.document_id AND d.content_hash=e.content_hash
    LEFT JOIN knowledge_source_revisions r ON r.document_id=e.document_id
    WHERE e.id=? AND COALESCE(r.deleted,0)=0
  `,
    )
    .get(id);
  return row && isKnowledgeEvidenceReadable(db, row.document_id)
    ? {
        id: row.id,
        documentId: row.document_id,
        contentHash: row.content_hash,
        quote: row.quote,
        start: row.span_start,
        end: row.span_end,
      }
    : null;
}
