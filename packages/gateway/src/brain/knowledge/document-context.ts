// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readQualifiedKnowledgeSupport } from "./qualified-support.js";
import {
  knowledgeAnswerGuidance,
  knowledgeAnswerPolicy,
  type KnowledgeAnswerOptions,
} from "./answer-policy.js";
import { CONTEXTUAL_VERIFIER } from "./claim-context.js";
import { isKnowledgeDocumentReadable } from "./retrieval-fence.js";
import { parseClaimReference } from "./references.js";
import { resolveKnowledgeReference } from "./storage-validation.js";
import { KNOWLEDGE_SOURCE_ID, KNOWLEDGE_PROVIDER_ID } from "./source-meta.js";
import type { FreshKnowledgeProjection } from "./projection-read.js";
import type { KnowledgeClaim } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** Same bounded, privacy-fenced context as a normal projection read. */
export function readKnowledgeNodeDocumentContext(
  db: Db,
  nodeId: string,
  options: KnowledgeAnswerOptions = {},
) {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'").get()
  )
    return undefined;
  const id = projectionId(db, nodeId);
  if (!id) return undefined;
  const context = readKnowledgeDocumentContext(db, id, options);
  return context ? { ...context, documentId: id } : undefined;
}
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

/**
 * A maintained wiki or root page's `wiki:<nodeId>` reference from the id of its
 * corpus projection — the id a search hit carries. Null for every other document.
 */
export function knowledgePageRefForDocument(db: Db, documentId: string): string | null {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'").get()
  )
    return null;
  const node = db
    .prepare<
      [string, string, string],
      { id: string }
    >("SELECT n.id FROM documents d JOIN knowledge_nodes n ON n.id=d.external_id WHERE d.id=? AND d.provider_id=? AND d.source_id=? AND n.kind IN ('wiki','root') AND json_extract(n.fields_json,'$.withdrawn') IS NOT 1 LIMIT 1")
    .get(documentId, KNOWLEDGE_PROVIDER_ID, KNOWLEDGE_SOURCE_ID);
  return node ? `wiki:${node.id}` : null;
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
export function readKnowledgeDocumentContext(
  db: Db,
  documentId: string,
  options: KnowledgeAnswerOptions = {},
) {
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
  return buildKnowledgeDocumentContext(db, node, options);
}

/** Only the source-owned exact mirror validator can supply this read view. */
export function readFreshKnowledgeDocumentContext(
  db: Db,
  projection: FreshKnowledgeProjection,
  options: KnowledgeAnswerOptions = {},
) {
  return buildKnowledgeDocumentContext(
    db,
    {
      id: projection.node.id,
      kind: projection.node.kind,
      revision: projection.node.revision,
      validity: projection.node.validity,
      text_length: projection.node.plainText.length,
    },
    options,
  );
}

function buildKnowledgeDocumentContext(
  db: Db,
  node: {
    id: string;
    kind: string;
    revision: number;
    validity: string;
    text_length: number;
  },
  options: KnowledgeAnswerOptions,
) {
  const pointer = (id: string) => {
    if (!isKnowledgeDocumentReadable(db, id)) return null;
    return (
      db
        .prepare<
          [string],
          {
            documentId: string;
            title: string;
            sourceCreatedAt: string | null;
            sourceUpdatedAt: string | null;
          }
        >(
          "SELECT id AS documentId,substr(title,1,300) AS title,substr(source_created_at,1,64) AS sourceCreatedAt,substr(source_updated_at,1,64) AS sourceUpdatedAt FROM documents WHERE id=?",
        )
        .get(id) ?? null
    );
  };
  const dependencies = db
    .prepare<
      [string, number],
      {
        claim_id: string;
        ref: string | null;
        relation: string;
        claim_text: string;
        text_length: number;
        input_version_json: string;
        verification: KnowledgeClaim["verification"];
        verifier: string | null;
        epistemic_status: KnowledgeClaim["epistemicStatus"];
        modality: KnowledgeClaim["modality"];
        support_logic: KnowledgeClaim["supportLogic"];
        attribution: string | null;
        valid_from: number | null;
        valid_until: number | null;
      }
    >(
      "SELECT c.id AS claim_id,d.ref,d.relation,d.input_version_json,substr(c.text,1,500) AS claim_text,length(c.text) AS text_length,c.verification,c.verifier,c.epistemic_status,c.modality,c.support_logic,substr(c.attribution,1,300) AS attribution,c.valid_from,c.valid_until FROM knowledge_claims c LEFT JOIN knowledge_dependencies d ON c.node_id=d.node_id AND c.id=d.claim_id WHERE c.node_id=? ORDER BY c.id,d.ref LIMIT ?",
    )
    .all(node.id, PROVENANCE_LIMIT + 1);
  const provenance = dependencies.slice(0, PROVENANCE_LIMIT).flatMap((dependency) => {
    try {
      if (dependency.ref === null) return [];
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
          observedVersion: JSON.parse(dependency.input_version_json) as string | number,
          currentVersion: resolved.revision,
          stale: resolved.stale || JSON.parse(dependency.input_version_json) !== resolved.revision,
        },
      ];
    } catch {
      return [];
    }
  });
  const claims: Array<
    Pick<
      KnowledgeClaim,
      | "id"
      | "verification"
      | "epistemicStatus"
      | "modality"
      | "supportLogic"
      | "attribution"
      | "validFrom"
      | "validUntil"
    > & {
      excerpt: string;
      truncated: boolean;
      verificationScope: "claim_text" | "page_context" | null;
    }
  > = [];
  let remainingClaimCharacters = Math.min(4000, node.text_length);
  for (const dependency of dependencies.slice(0, PROVENANCE_LIMIT)) {
    if (
      (dependency.ref !== null &&
        !provenance.some((item) => item.claimId === dependency.claim_id)) ||
      claims.some((claim) => claim.id === dependency.claim_id)
    )
      continue;
    const excerpt = dependency.claim_text.slice(0, remainingClaimCharacters);
    remainingClaimCharacters -= excerpt.length;
    claims.push({
      id: dependency.claim_id,
      excerpt,
      truncated: excerpt.length < dependency.text_length,
      // Until individually evaluated, a stale page cannot vouch for this claim.
      verification: node.validity === "stale" ? "stale" : dependency.verification,
      verificationScope:
        dependency.verifier === CONTEXTUAL_VERIFIER
          ? "page_context"
          : dependency.verifier
            ? "claim_text"
            : null,
      epistemicStatus: dependency.epistemic_status,
      modality: dependency.modality,
      supportLogic: dependency.support_logic,
      attribution: dependency.attribution,
      validFrom: dependency.valid_from,
      validUntil: dependency.valid_until,
    });
  }
  const { verifiedSupport, truncated: supportTruncated } = readQualifiedKnowledgeSupport(
    db,
    node.id,
  );
  for (const claim of claims) {
    if (
      verifiedSupport.some(
        (view) =>
          view.ref === `${node.kind === "loop" ? "loop" : "wiki"}:${node.id}#claim:${claim.id}`,
      )
    )
      claim.verification = "verified";
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
    answerPolicy: knowledgeAnswerPolicy(verifiedSupport, options),
    guidance:
      "This is a summary Omnesis wrote, not a source. " +
      knowledgeAnswerGuidance(verifiedSupport, options) +
      " verifiedSupport lists statements individually checked against current sources; other prose is orientation. For claims outside verifiedSupport, provenance.claims lists each claim, and provenance.items gives the documentId (with matching claimId) each rests on; read those with fetch_many. References sharing a claimId support that claim together under its supportLogic, not phrase by phrase. A stale summary, a stale item or a missing pointer grants no additional authority beyond verifiedSupport. Source timestamps describe when a record was created or changed, not when its events happened, and the summary's own timestamps describe when it was written or maintained; check later evidence when currentness matters. A current validity means its sources have not changed since, not that every statement still describes today. Navigation links are for finding related pages, not support. A truncated list is incomplete.",
    verifiedSupport,
    supportCoverage: { partial: node.validity !== "current", truncated: supportTruncated },
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
