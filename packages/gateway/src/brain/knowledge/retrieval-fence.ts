// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { OPEN_LOOP_SOURCE_ID } from "../open-loop-source/source-meta.js";
import { KNOWLEDGE_SOURCE_ID } from "./source-meta.js";
import {
  isKnowledgeNodeReadable,
  isKnowledgeOwnerReadable,
  knowledgeNodeFence,
} from "./storage-fence.js";
import type Database from "better-sqlite3";

/** A document to fence, with the source id its index entry carries, when it has one. */
export interface KnowledgeDocumentRef {
  documentId: string;
  sourceId?: string;
}

/**
 * Where a batch of readability verdicts is read. The gateway passes its read
 * worker, so a search's candidate pool is fenced off the main event loop;
 * {@link directKnowledgeReadabilityReads} reads on the caller's own handle.
 */
export interface KnowledgeReadabilityReads {
  knowledgeDocumentsReadable(refs: readonly KnowledgeDocumentRef[]): Promise<boolean[]>;
}

export function directKnowledgeReadabilityReads(db: Database.Database): KnowledgeReadabilityReads {
  return {
    knowledgeDocumentsReadable: (refs) => Promise.resolve(knowledgeDocumentsReadable(db, refs)),
  };
}

/**
 * Corpus/index projections may lag authoritative privacy and revision changes.
 * Apply at exposure boundaries, including candidate snippets and graph neighbours.
 */
export function isKnowledgeDocumentReadable(
  db: Database.Database,
  documentId: string,
  sourceId?: string,
): boolean {
  return knowledgeDocumentsReadable(db, [{ documentId, sourceId }])[0]!;
}

const generated = (id: string) => id === KNOWLEDGE_SOURCE_ID || id === OPEN_LOOP_SOURCE_ID;

/**
 * {@link isKnowledgeDocumentReadable} for each ref, in order. Table checks and
 * statements are prepared once for the batch, and a repeated ref is judged once.
 */
export function knowledgeDocumentsReadable(
  db: Database.Database,
  refs: readonly KnowledgeDocumentRef[],
): boolean[] {
  if (refs.length === 0) return [];
  const hasTable = (name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const documentSource = db.prepare<[string], { source_id: string }>(
    "SELECT source_id FROM documents WHERE id=?",
  );
  const deletedSource = hasTable("knowledge_source_revisions")
    ? db.prepare<[string]>(
        "SELECT 1 FROM knowledge_source_revisions WHERE document_id=? AND deleted=1",
      )
    : null;
  const removedSource = hasTable("removed_sources")
    ? db.prepare<[string]>("SELECT 1 FROM removed_sources WHERE id=?")
    : null;
  // Prepared only when a ref reaches them, so a store without these tables or
  // columns still fences its ordinary documents.
  let generatedDocument:
    | Database.Statement<[string], { source_id: string; external_id: string; metadata: string }>
    | undefined;
  let openLoop: Database.Statement<[string]> | undefined;
  let hasKnowledgeNodes: boolean | undefined;
  let knowledgeNode:
    Database.Statement<[string], { revision: number; validity: string }> | undefined;

  const judge = (documentId: string, sourceId: string | undefined): boolean => {
    // Index source metadata may lag a move without a content/hash change. The
    // live row owns identity; the hint only preserves ordinary missing-hit fallback.
    const source = documentSource.get(documentId)?.source_id ?? sourceId;
    if (source === undefined) return false;
    if (deletedSource?.get(documentId)) return false;
    if (removedSource?.get(source)) return false;
    // Do not expose an old indexed identity across a generated/ordinary source move.
    if (sourceId !== undefined && sourceId !== source && (generated(sourceId) || generated(source)))
      return false;
    if (!generated(source)) return true;
    generatedDocument ??= db.prepare(
      "SELECT source_id,external_id,metadata FROM documents WHERE id=?",
    );
    const row = generatedDocument.get(documentId);
    // A missing document is also a stale index hit and must not expose old content.
    if (!row) return false;
    if (row.source_id === OPEN_LOOP_SOURCE_ID) {
      openLoop ??= db.prepare<[string]>("SELECT 1 FROM open_loops WHERE id=?");
      // The old searchable loop projection can lag a bounded owner purge.
      return !!openLoop.get(row.external_id) && isKnowledgeOwnerReadable(db, row.external_id);
    }
    if (row.source_id !== KNOWLEDGE_SOURCE_ID) return true;
    hasKnowledgeNodes ??= hasTable("knowledge_nodes");
    if (!hasKnowledgeNodes) return false;
    knowledgeNode ??= db.prepare("SELECT revision,validity FROM knowledge_nodes WHERE id=?");
    const node = knowledgeNode.get(row.external_id);
    if (!node) return false;
    return knowledgeMirrorIsCurrent(db, row.external_id, node, row.metadata);
  };

  const verdicts = new Map<string, boolean>();
  return refs.map(({ documentId, sourceId }) => {
    const key = JSON.stringify([documentId, sourceId ?? null]);
    let verdict = verdicts.get(key);
    if (verdict === undefined) {
      verdict = judge(documentId, sourceId);
      verdicts.set(key, verdict);
    }
    return verdict;
  });
}

/**
 * A knowledge mirror is readable while its node is not hidden and the mirror
 * carries the node's revision and effective validity: the stored validity, or
 * stale when a current ancestor changed since the node read it. The ancestor
 * walk is the expensive part of the fence, so it runs only when the verdict
 * depends on it.
 */
function knowledgeMirrorIsCurrent(
  db: Database.Database,
  nodeId: string,
  node: { revision: number; validity: string },
  metadataJson: string,
): boolean {
  let revision: unknown;
  let validity: unknown;
  try {
    const metadata = JSON.parse(metadataJson) as {
      extra?: { knowledgeRevision?: unknown; knowledgeValidity?: unknown };
    };
    revision = metadata.extra?.knowledgeRevision;
    validity = metadata.extra?.knowledgeValidity;
  } catch {
    return false;
  }
  if (revision !== node.revision) return false;
  // The effective validity is the stored one or stale, nothing else.
  if (validity !== node.validity && validity !== "stale") return false;
  // A node stored stale is effectively stale whatever its ancestors say.
  if (node.validity === "stale") return isKnowledgeNodeReadable(db, nodeId);
  const fence = knowledgeNodeFence(db, nodeId);
  return !fence.hidden && validity === (fence.stale ? "stale" : node.validity);
}

export function filterKnowledgeDocuments<T>(
  db: Database.Database,
  rows: readonly T[],
  documentId: (row: T) => string,
): T[] {
  const verdicts = knowledgeDocumentsReadable(
    db,
    rows.map((row) => ({ documentId: documentId(row) })),
  );
  return rows.filter((_, i) => verdicts[i]);
}
