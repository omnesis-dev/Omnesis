// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  readKnowledgeOwner,
  buildLegacyOwnerKnowledge,
  type KnowledgeOwnerKind,
} from "./owner-adapters.js";
import { parseClaimMarkup } from "./claims.js";
import {
  getKnowledgeClaims,
  getKnowledgeDependencies,
  getKnowledgeNode,
  purgeKnowledgeNode,
  resolveKnowledgeReference,
  saveKnowledgeNode,
} from "./storage.js";
import { KnowledgeStorageError, type KnowledgeRevision } from "./types.js";
import type Database from "better-sqlite3";

/** Bounded deterministic conversion/reconciliation. Synthesis may refine its unverified prose later. */
export function advanceKnowledgeOwnerSync(
  db: Database.Database,
  limit: number,
  now: number,
): { pending: boolean; updatedNodeIds: string[]; deletedNodeIds: string[]; deferred: number } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512)
    throw new Error("Owner sync limit must be between 1 and 512");
  const rows = db
    .prepare<
      [number],
      { seq: number; kind: KnowledgeOwnerKind; owner_id: string; operation: "update" | "delete" }
    >("SELECT seq,kind,owner_id,operation FROM knowledge_owner_changes ORDER BY CASE operation WHEN 'delete' THEN 0 ELSE 1 END,seq LIMIT ?")
    .all(limit);
  const updatedNodeIds: string[] = [];
  const deletedNodeIds: string[] = [];
  let deferred = 0;
  for (const row of rows) {
    try {
      db.transaction(() => {
        // Clear only inside this transaction; rollback restores work on any stale input.
        db.prepare("DELETE FROM knowledge_owner_changes WHERE seq=?").run(row.seq);
        if (row.operation === "delete") {
          deletedNodeIds.push(...purgeKnowledgeNode(db, row.owner_id, now));
          return;
        }
        const owner = readKnowledgeOwner(db, row.kind, row.owner_id);
        const node = getKnowledgeNode(db, row.owner_id);
        if (node && (node.kind !== owner.kind || node.ownerId !== owner.id))
          throw new KnowledgeStorageError(
            "claim_invalid",
            "Canonical owner identity collides with another synthesis node",
          );
        if (!node || node.plainText !== owner.markdown) {
          saveKnowledgeNode(db, buildLegacyOwnerKnowledge(db, owner, node?.revision ?? 0), now);
        } else {
          const parsed = parseClaimMarkup(node.markdown);
          const inputVersions: Record<string, KnowledgeRevision> = {};
          for (const claim of parsed.claims)
            for (const ref of claim.refs)
              inputVersions[ref.raw] = resolveKnowledgeReference(db, ref).revision;
          const dependencies = getKnowledgeDependencies(db, node.id);
          saveKnowledgeNode(
            db,
            {
              id: node.id,
              kind: node.kind,
              ownerId: node.ownerId,
              title: owner.title,
              markdown: node.markdown,
              expectedRevision: node.revision,
              inputVersions,
              canonicalFields: owner.canonicalFields,
              metadata: {
                ...node.metadata,
                ...(owner.canonicalFields.invalidatedAt != null ||
                (owner.kind === "loop" && owner.canonicalFields.state !== "open")
                  ? { activity: "historical" as const }
                  : {}),
              },
              claims: getKnowledgeClaims(db, node.id).map((claim) => ({
                id: claim.id,
                supportLogic: claim.supportLogic,
                validFrom: claim.validFrom,
                validUntil: claim.validUntil,
                relations: Object.fromEntries(
                  dependencies
                    .filter((dep) => dep.claimId === claim.id)
                    .map((dep) => [dep.ref, dep.relation]),
                ),
              })),
            },
            now,
          );
        }
        updatedNodeIds.push(row.owner_id);
      })();
    } catch (error) {
      if (!(error instanceof KnowledgeStorageError)) throw error;
      db.prepare(
        "UPDATE knowledge_owner_changes SET seq=(SELECT COALESCE(MAX(seq),0)+1 FROM knowledge_owner_changes) WHERE seq=?",
      ).run(row.seq);
      deferred++;
    }
  }
  return {
    pending: !!db.prepare("SELECT 1 FROM knowledge_owner_changes LIMIT 1").get(),
    updatedNodeIds,
    deletedNodeIds,
    deferred,
  };
}
