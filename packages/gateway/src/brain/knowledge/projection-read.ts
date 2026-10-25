// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildKnowledgeDocumentInput } from "./mirror.js";
import { getKnowledgeNode } from "./storage-read.js";
import { knowledgeHash } from "./storage-validation.js";
import { KNOWLEDGE_PROVIDER_ID, KNOWLEDGE_SOURCE_ID } from "./source-meta.js";
import type { ListedDocumentRow } from "../../data/types.js";
import type { KnowledgeNode } from "./types.js";
import type Database from "better-sqlite3";

const validatedProjection = Symbol("validated freshness-only knowledge projection");
export interface FreshKnowledgeProjection {
  readonly [validatedProjection]: true;
  readonly row: ListedDocumentRow;
  readonly node: KnowledgeNode;
}

/** Read-only fallback for a freshness-only mirror lag. Never repairs a physical
 * revision mismatch or a malformed mirror. Call inside the authorized fetch
 * snapshot; normal repository/search exposure rules remain unchanged. */
export function readFreshKnowledgeProjection(
  db: Database.Database,
  id: string,
  allowedSources: ReadonlySet<string> | null,
  maxBytes?: number,
): FreshKnowledgeProjection | null {
  const identity = db
    .prepare<
      [string],
      { source_id: string; provider_id: string; size: number }
    >(`SELECT source_id,provider_id,length(CAST(content AS BLOB))+length(CAST(title AS BLOB))+length(CAST(metadata AS BLOB)) AS size FROM documents WHERE id=?`)
    .get(id);
  if (
    !identity ||
    identity.source_id !== KNOWLEDGE_SOURCE_ID ||
    identity.provider_id !== KNOWLEDGE_PROVIDER_ID ||
    (allowedSources && !allowedSources.has(identity.source_id))
  )
    return null;
  if (maxBytes !== undefined && identity.size > maxBytes)
    throw new Error("Document exceeds the configured read-size limit");
  if (
    db.prepare("SELECT 1 FROM removed_sources WHERE id=?").get(identity.source_id) ||
    db.prepare("SELECT 1 FROM knowledge_source_revisions WHERE document_id=? AND deleted=1").get(id)
  )
    return null;
  const stored = db
    .prepare<
      [string],
      {
        external_id: string;
        title: string;
        content: string;
        content_hash: string;
        metadata: string;
        source_created_at: string;
        updated_at: string;
      }
    >(
      "SELECT external_id,title,content,content_hash,metadata,source_created_at,updated_at FROM documents WHERE id=?",
    )
    .get(id)!;
  const node = getKnowledgeNode(db, stored.external_id);
  if (!node || !["wiki", "root"].includes(node.kind) || node.canonicalFields.withdrawn === true)
    return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(stored.metadata);
  } catch {
    return null;
  }
  const extra = (
    metadata as { extra?: { knowledgeRevision?: unknown; knowledgeValidity?: unknown } } | null
  )?.extra;
  const validity = extra?.knowledgeValidity;
  if (
    extra?.knowledgeRevision !== node.revision ||
    (validity !== "current" && validity !== "stale") ||
    validity === node.validity
  )
    return null;
  const expected = buildKnowledgeDocumentInput({ ...node, validity });
  if (
    stored.title !== expected.title ||
    stored.content !== expected.content ||
    stored.content_hash !== expected.contentHash ||
    knowledgeHash(metadata) !== knowledgeHash(expected.metadata) ||
    stored.source_created_at !== expected.sourceCreatedAt
  )
    return null;
  const effective = buildKnowledgeDocumentInput(node);
  const encodedMetadata = JSON.stringify(effective.metadata);
  if (
    maxBytes !== undefined &&
    Buffer.byteLength(effective.title) +
      Buffer.byteLength(effective.content) +
      Buffer.byteLength(encodedMetadata) >
      maxBytes
  )
    throw new Error("Document exceeds the configured read-size limit");
  return {
    [validatedProjection]: true,
    node,
    row: {
      id,
      sourceId: identity.source_id,
      title: effective.title,
      content: effective.content,
      contentHash: effective.contentHash,
      metadata: encodedMetadata,
      sourceCreatedAt: stored.source_created_at,
      updatedAt: stored.updated_at,
    },
  };
}
