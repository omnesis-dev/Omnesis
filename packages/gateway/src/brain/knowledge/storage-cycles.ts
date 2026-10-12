// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KnowledgeStorageError, type KnowledgeDependency } from "./types.js";
import type Database from "better-sqlite3";
import type { ParsedClaim } from "./claims.js";

type Edge = { claim_id: string; target_id: string; ref: string };
/** Indexed, bounded claim traversal; never materialize the entire graph in the writer. */
export function assertAcyclicKnowledgeClaims(
  db: Database.Database,
  nodeId: string,
  claims: ParsedClaim[],
  dependencies: KnowledgeDependency[],
): void {
  const edges = new Map<string, Edge[]>([
    [
      nodeId,
      dependencies
        .filter(
          (dep) =>
            dep.targetKind === "node" && dep.relation !== "context" && !dep.ref.includes("#field:"),
        )
        .map((dep) => ({ claim_id: dep.claimId, target_id: dep.targetId, ref: dep.ref })),
    ],
  ]);
  const ids = new Map<string, string[]>([[nodeId, claims.map((claim) => claim.id)]]);
  const readEdges = db.prepare<[string], Edge>(
    "SELECT claim_id,target_id,ref FROM knowledge_dependencies WHERE node_id=? AND target_kind='node' AND relation!='context' AND instr(ref,'#field:')=0",
  );
  const readIds = db.prepare<[string], { id: string }>(
    "SELECT id FROM knowledge_claims WHERE node_id=?",
  );
  let budget = 8192;
  const spend = () => {
    if (--budget < 0)
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Claim dependency traversal exceeds the bounded write budget",
      );
  };
  for (const origin of claims) {
    const pending = [{ nodeId, claimId: origin.id }];
    const seen = new Set<string>();
    while (pending.length) {
      spend();
      const current = pending.pop()!;
      const key = JSON.stringify([current.nodeId, current.claimId]);
      if (seen.has(key)) continue;
      seen.add(key);
      let outgoing = edges.get(current.nodeId);
      if (!outgoing) {
        outgoing = readEdges.all(current.nodeId);
        edges.set(current.nodeId, outgoing);
      }
      for (const edge of outgoing) {
        spend();
        if (edge.claim_id !== current.claimId) continue;
        const selector = edge.ref.indexOf("#claim:");
        let targets: string[];
        if (selector >= 0) targets = [edge.ref.slice(selector + 7)];
        else {
          targets = ids.get(edge.target_id) ?? readIds.all(edge.target_id).map((claim) => claim.id);
          ids.set(edge.target_id, targets);
        }
        for (const claimId of targets) {
          spend();
          if (edge.target_id === nodeId && claimId === origin.id)
            throw new KnowledgeStorageError("cycle", "Circular claim support is not allowed");
          pending.push({ nodeId: edge.target_id, claimId });
        }
      }
    }
  }
}
