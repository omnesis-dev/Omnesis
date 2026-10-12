// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { OPEN_LOOP_SOURCE_ID } from "../open-loop-source/source-meta.js";
import { getKnowledgeNode } from "./storage-read.js";
import { KNOWLEDGE_SOURCE_ID } from "./source-meta.js";
import { isKnowledgeOwnerReadable } from "./storage-fence.js";
import type Database from "better-sqlite3";

/**
 * Corpus/index projections may lag authoritative privacy and revision changes.
 * Apply at exposure boundaries, including candidate snippets and graph neighbours.
 */
export function isKnowledgeDocumentReadable(
  db: Database.Database,
  documentId: string,
  sourceId?: string,
): boolean {
  // Index source metadata may lag a move without a content/hash change. The
  // live row owns identity; the hint only preserves ordinary missing-hit fallback.
  const source =
    db
      .prepare<[string], { source_id: string }>("SELECT source_id FROM documents WHERE id=?")
      .get(documentId)?.source_id ?? sourceId;
  if (source === undefined) return false;
  const hasTable = (name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (
    hasTable("knowledge_source_revisions") &&
    db
      .prepare("SELECT 1 FROM knowledge_source_revisions WHERE document_id=? AND deleted=1")
      .get(documentId)
  )
    return false;
  if (
    hasTable("removed_sources") &&
    db.prepare("SELECT 1 FROM removed_sources WHERE id=?").get(source)
  )
    return false;
  const generated = (id: string) => id === KNOWLEDGE_SOURCE_ID || id === OPEN_LOOP_SOURCE_ID;
  // Do not expose an old indexed identity across a generated/ordinary source move.
  if (sourceId !== undefined && sourceId !== source && (generated(sourceId) || generated(source)))
    return false;
  if (!generated(source)) return true;
  const row = db
    .prepare<
      [string],
      { source_id: string; external_id: string; metadata: string }
    >("SELECT source_id,external_id,metadata FROM documents WHERE id=?")
    .get(documentId);
  // A missing document is also a stale index hit and must not expose old content.
  if (!row) return false;
  if (row.source_id === OPEN_LOOP_SOURCE_ID) {
    // The old searchable loop projection can lag a bounded owner purge.
    return (
      !!db.prepare("SELECT 1 FROM open_loops WHERE id=?").get(row.external_id) &&
      isKnowledgeOwnerReadable(db, row.external_id)
    );
  }
  if (row.source_id !== KNOWLEDGE_SOURCE_ID) return true;
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'").get()
  )
    return false;
  const node = getKnowledgeNode(db, row.external_id);
  if (!node) return false;
  try {
    const metadata = JSON.parse(row.metadata) as {
      extra?: { knowledgeRevision?: unknown; knowledgeValidity?: unknown };
    };
    return (
      metadata.extra?.knowledgeRevision === node.revision &&
      metadata.extra?.knowledgeValidity === node.validity
    );
  } catch {
    return false;
  }
}
export function filterKnowledgeDocuments<T>(
  db: Database.Database,
  rows: readonly T[],
  documentId: (row: T) => string,
): T[] {
  return rows.filter((row) => isKnowledgeDocumentReadable(db, documentId(row)));
}
