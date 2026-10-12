// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildKnowledgeDocumentInput } from "./mirror.js";
import { getKnowledgeNode } from "./storage-read.js";
import { knowledgeHash } from "./storage-validation.js";
import type { readKnowledgeDocumentContext } from "./document-context.js";
import type Database from "better-sqlite3";

/**
 * Factual authority of a complete qualified wiki read, not its byte identity.
 * Physical revision banners and maintenance timestamps are not factual support.
 * Partial reads/citations still require the ordinary exact document snapshot.
 * The caller holds the same authorized read transaction as the emitted document.
 */
export function knowledgePageReadAuthority(
  db: Database.Database,
  context: ReturnType<typeof readKnowledgeDocumentContext>,
  emitted: {
    title: string | null;
    content: string;
    metadata: unknown;
    sourceCreatedAt: string | null;
  },
): string | undefined {
  if (!context || !["wiki", "root"].includes(context.kind)) return undefined;
  const node = getKnowledgeNode(db, context.nodeId);
  if (!node || node.validity !== "current") return undefined;
  const canonical = buildKnowledgeDocumentInput(node);
  // A delayed or malformed mirror cannot authorize unseen canonical content.
  // Normalize bookkeeping only after proving the emitted projection is exact.
  if (
    emitted.title !== canonical.title ||
    emitted.content !== canonical.content ||
    knowledgeHash(emitted.metadata) !== knowledgeHash(canonical.metadata)
  )
    return undefined;
  const claims = db
    .prepare(
      `SELECT id,text,parent_id,support_logic,verification,fingerprint,verifier,
    valid_from,valid_until,meaning_revision,witness_refs_json,attribution,modality,epistemic_status
    FROM knowledge_claims WHERE node_id=? ORDER BY id LIMIT 1025`,
    )
    .all(node.id);
  const dependencies = db
    .prepare(
      `SELECT claim_id,ref,target_kind,target_id,
    relation,input_version_json FROM knowledge_dependencies WHERE node_id=?
    ORDER BY claim_id,ref LIMIT 1025`,
    )
    .all(node.id);
  if (claims.length > 1024 || dependencies.length > 1024) return undefined;
  const { revision: _revision, ...qualifiedView } = context;
  const value = {
    id: node.id,
    kind: node.kind,
    ownerId: node.ownerId,
    createdAt: node.createdAt,
    sourceCreatedAt: emitted.sourceCreatedAt,
    meaningRevision: node.meaningRevision,
    title: node.title,
    text: node.plainText,
    fields: node.canonicalFields,
    validity: node.validity,
    claims,
    dependencies,
    qualifiedView,
  };
  // Decline the optimization instead of truncating authority inputs.
  if (Buffer.byteLength(JSON.stringify(value)) > 262144) return undefined;
  return knowledgeHash(value);
}
