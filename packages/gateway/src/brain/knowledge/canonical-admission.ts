// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { assertKnowledgeCanonicalFence, type KnowledgeCanonicalFence } from "./canonical-fence.js";
import { KnowledgeGraph } from "./engine-graph.js";
import { planMaintenanceGroups } from "./planner.js";
import { abandonOrganizationBatch } from "./organization-writer.js";
import { reserveKnowledgeRegion } from "./work.js";
import { recordKnowledgeDiscoveryTargets } from "./work-lifecycle.js";
import { readKnowledgeOwner } from "./owner-adapters.js";
import { getKnowledgeNode } from "./storage-read.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

/** Discovering a mutation target extends ownership before any paid verification. */
export function admitCanonicalMaintenance(
  db: Database.Database,
  input: { fence: KnowledgeCanonicalFence; maxVisited: number },
  now: number,
): { admitted: boolean } {
  return db.transaction(() => {
    const { fence } = input;
    assertKnowledgeCanonicalFence(db, fence);
    const targets = [
      ...new Set(fence.owners.filter((owner) => owner.version !== null).map((owner) => owner.id)),
    ];
    if (!targets.length) return { admitted: true };
    if (!Number.isInteger(input.maxVisited) || input.maxVisited < 1 || input.maxVisited > 4096)
      throw new KnowledgeStorageError("claim_invalid", "Invalid canonical region bound");
    const graph = new KnowledgeGraph(db, () => input.maxVisited);
    const roots = new Set(
      db
        .prepare<[], { id: string }>("SELECT id FROM knowledge_nodes WHERE kind='root'")
        .all()
        .map((row) => row.id),
    );
    const [group] = planMaintenanceGroups(
      [
        {
          id: fence.batchId,
          revision: "admission",
          changedAt: now,
          dueAt: now,
          tier: "immediate",
          targets,
        },
      ],
      (id) => graph.arcs(id).map((arc) => arc.dependent),
      roots,
      { maxSeeds: 1, maxVisitedPerSeed: input.maxVisited },
    );
    const region = group!.nodes;
    // Hints describe scheduling overlap, never support or entailment. Only offered
    // current source inputs may provide provenance. Existing canonical owners can
    // be reserved even before conversion; do not force conversion to close a loop
    // whose historical supporting document has become unavailable.
    const materialized = targets.filter((id) => {
      const node = getKnowledgeNode(db, id);
      if (!node || node.canonicalFields.withdrawn === true) return false;
      return (
        !["doc_annotation", "person_annotation"].includes(node.kind) ||
        readKnowledgeOwner(
          db,
          node.kind as "doc_annotation" | "person_annotation",
          node.ownerId ?? node.id,
        ).canonicalFields.invalidatedAt == null
      );
    });
    const sources = fence.inputs.filter((item) => item.nodeId.startsWith("source:"));
    if (materialized.length * sources.length > 4096)
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Canonical routing hints exceed their bounded budget",
      );
    for (const source of sources) {
      for (let offset = 0; offset < materialized.length; offset += 64)
        recordKnowledgeDiscoveryTargets(
          db,
          {
            runFence: fence,
            sourceId: source.nodeId.slice(7),
            sourceRevision: String(source.versions[source.nodeId]),
            nodeIds: materialized.slice(offset, offset + 64),
          },
          now,
        );
    }
    const blocker = db.prepare<[string, string], { batch_id: string }>(
      "SELECT r.batch_id FROM knowledge_batch_regions r JOIN knowledge_batches b ON b.id=r.batch_id WHERE r.node_id=? AND r.batch_id!=? AND b.status NOT IN ('completed','abandoned') ORDER BY r.batch_id LIMIT 1",
    );
    const blockingBatch = region
      .flatMap((id) => {
        const row = blocker.get(id, fence.batchId);
        return row ? [row.batch_id] : [];
      })
      .sort()[0];
    if (blockingBatch) {
      // Release every old reservation instead of waiting while holding a region
      // another contender may need. The existing planner can adopt the queued
      // current inputs using the newly persisted hints, or replan after completion.
      abandonOrganizationBatch(db, { batchId: fence.batchId, notBefore: now }, now);
      // An owner may not have a readable synthesis mirror yet, so an FK-backed
      // routing hint cannot always be recorded. Hand off the offered source
      // reservations too: no new paid discovery may rediscover this same lock.
      // A third party already reserving a source already prevents that retry;
      // do not steal its reservation. All observations and transfers are atomic.
      const transferable = sources
        .map((source) => source.nodeId)
        .filter((id) => !blocker.get(id, blockingBatch));
      reserveKnowledgeRegion(db, blockingBatch, transferable);
      return { admitted: false };
    }
    reserveKnowledgeRegion(db, fence.batchId, region);
    return { admitted: true };
  })();
}
