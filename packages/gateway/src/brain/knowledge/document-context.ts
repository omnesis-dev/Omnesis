// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isKnowledgeDocumentReadable } from "./retrieval-fence.js";
import { parseClaimReference } from "./references.js";
import { resolveKnowledgeReference } from "./storage-validation.js";
import { KNOWLEDGE_SOURCE_ID, KNOWLEDGE_PROVIDER_ID } from "./source-meta.js";
import type Database from "better-sqlite3";

type Db = Database.Database;
const PROVENANCE_LIMIT = 32;
const NAVIGATION_LIMIT = 16;

/** Resolve only a readable, current corpus projection; never fall back to raw canonical text. */
function projectionId(db: Db, nodeId: string): string | null {
  if (
    !db
      .prepare(
        "SELECT 1 FROM knowledge_nodes WHERE id=? AND json_extract(fields_json,'$.withdrawn') IS NOT 1",
      )
      .get(nodeId)
  )
    return null;
  const row = db
    .prepare<
      [string, string, string],
      { id: string }
    >("SELECT id FROM documents WHERE provider_id=? AND source_id=? AND external_id=? LIMIT 1")
    .get(KNOWLEDGE_PROVIDER_ID, KNOWLEDGE_SOURCE_ID, nodeId);
  return row && isKnowledgeDocumentReadable(db, row.id) ? row.id : null;
}

export function resolveKnowledgeDocumentAlias(db: Db, id: string): string | null {
  if (!id.startsWith("wiki:")) return id;
  if (!/^wiki:[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'").get()
  )
    return null;
  // Resolve identity only. The fetch port applies source authorization and its
  // byte cap before the ordinary full-read privacy/revision fence materializes it.
  return (
    db
      .prepare<
        [string, string, string],
        { id: string }
      >("SELECT d.id FROM documents d JOIN knowledge_nodes n ON n.id=d.external_id WHERE d.provider_id=? AND d.source_id=? AND n.id=? AND n.kind IN ('wiki','root') AND json_extract(n.fields_json,'$.withdrawn') IS NOT 1 LIMIT 1")
      .get(KNOWLEDGE_PROVIDER_ID, KNOWLEDGE_SOURCE_ID, id.slice(5))?.id ?? null
  );
}

/**
 * Pointer-only context for an already-authorized projection read. The caller holds
 * the document-read SQLite snapshot and omits this overlay for restricted grants.
 * Limits bound rows inspected as well as output; filtered pointers are not counted
 * or identified. A truncated page is a lead, never a complete evidence inventory.
 */
export function readKnowledgeDocumentContext(db: Db, documentId: string) {
  const document = db
    .prepare<
      [string],
      { source_id: string; external_id: string }
    >("SELECT source_id,external_id FROM documents WHERE id=?")
    .get(documentId);
  if (document?.source_id !== KNOWLEDGE_SOURCE_ID || !isKnowledgeDocumentReadable(db, documentId))
    return undefined;
  const node = db
    .prepare<
      [string],
      { id: string; kind: string; revision: number; validity: string; text_length: number }
    >("SELECT n.id,n.kind,n.revision,json_extract(d.metadata,'$.extra.knowledgeValidity') AS validity,length(n.plain_text) AS text_length FROM knowledge_nodes n JOIN documents d ON d.external_id=n.id WHERE d.id=?")
    .get(documentId);
  if (!node) return undefined;
  const pointer = (id: string) => {
    if (!isKnowledgeDocumentReadable(db, id)) return null;
    return (
      db
        .prepare<
          [string],
          { documentId: string; title: string }
        >("SELECT id AS documentId,substr(title,1,300) AS title FROM documents WHERE id=?")
        .get(id) ?? null
    );
  };
  const dependencies = db
    .prepare<
      [string, number],
      {
        claim_id: string;
        ref: string;
        relation: string;
        claim_text: string;
        text_length: number;
        input_version_json: string;
      }
    >(
      "SELECT d.claim_id,d.ref,d.relation,d.input_version_json,substr(c.text,1,500) AS claim_text,length(c.text) AS text_length FROM knowledge_dependencies d JOIN knowledge_claims c ON c.node_id=d.node_id AND c.id=d.claim_id WHERE d.node_id=? ORDER BY d.claim_id,d.ref LIMIT ?",
    )
    .all(node.id, PROVENANCE_LIMIT + 1);
  const provenance = dependencies.slice(0, PROVENANCE_LIMIT).flatMap((dependency) => {
    try {
      const ref = parseClaimReference(dependency.ref);
      const resolved = resolveKnowledgeReference(db, ref);
      const id =
        resolved.targetKind === "source" ? resolved.targetId : projectionId(db, resolved.targetId);
      const target = id ? pointer(id) : null;
      if (!target) return [];
      return [
        {
          claimId: dependency.claim_id,
          relation: dependency.relation,
          ref: dependency.ref,
          ...target,
          ...(ref.selector?.kind === "claim" ? { targetClaimId: ref.selector.id } : {}),
          stale: resolved.stale || JSON.parse(dependency.input_version_json) !== resolved.revision,
        },
      ];
    } catch {
      return [];
    }
  });
  const claims: { id: string; excerpt: string; truncated: boolean }[] = [];
  let remainingClaimCharacters = Math.min(4000, node.text_length);
  for (const dependency of dependencies.slice(0, PROVENANCE_LIMIT)) {
    if (
      !provenance.some((item) => item.claimId === dependency.claim_id) ||
      claims.some((claim) => claim.id === dependency.claim_id)
    )
      continue;
    const excerpt = dependency.claim_text.slice(0, remainingClaimCharacters);
    remainingClaimCharacters -= excerpt.length;
    claims.push({
      id: dependency.claim_id,
      excerpt,
      truncated: excerpt.length < dependency.text_length,
    });
  }
  const links = db
    .prepare<
      [string, string, number],
      { from_id: string; to_id: string; kind: string }
    >("SELECT from_id,to_id,kind FROM knowledge_links WHERE from_id=? OR to_id=? ORDER BY from_id,to_id,kind LIMIT ?")
    .all(node.id, node.id, NAVIGATION_LIMIT + 1);
  const navigation = links.slice(0, NAVIGATION_LIMIT).flatMap((link) => {
    const id = projectionId(db, link.from_id === node.id ? link.to_id : link.from_id);
    const target = id ? pointer(id) : null;
    return target
      ? [
          {
            direction: link.from_id === node.id ? "outgoing" : "incoming",
            relationship: link.kind,
            ...target,
          },
        ]
      : [];
  });
  return {
    nodeId: node.id,
    kind: node.kind,
    revision: node.revision,
    validity: node.validity,
    guidance:
      "Maintained synthesis is orientation, not independent evidence. Fetch provenance documentIds to verify decisive claims. Navigation is not support. A truncated pointer list is incomplete; search for additional evidence when needed.",
    provenance: {
      claims,
      items: provenance,
      limit: PROVENANCE_LIMIT,
      truncated: dependencies.length > PROVENANCE_LIMIT,
    },
    navigation: {
      items: navigation,
      limit: NAVIGATION_LIMIT,
      truncated: links.length > NAVIGATION_LIMIT,
    },
  };
}
