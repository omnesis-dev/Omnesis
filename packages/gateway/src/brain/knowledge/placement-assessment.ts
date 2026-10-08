// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { pendingMaintenanceClaimIds } from "./claim-maintenance.js";
import { enqueueKnowledgeWork } from "./work.js";
import { getKnowledgeNode } from "./storage-read.js";
import { KnowledgeStorageError, type SaveKnowledgeNodeInput } from "./types.js";
import type Database from "better-sqlite3";

export interface KnowledgePlacementLink {
  fromId: string;
  toId: string;
  kind: "part_of" | "belongs_to_project" | "related_to";
  otherRevision: number;
}
export type KnowledgePlacementAssessment =
  | { status: "integrated"; reason: string; links: KnowledgePlacementLink[] }
  | { status: "standalone" | "deferred"; reason: string };
export interface KnowledgePlacementRecord {
  status: "integrated" | "standalone" | "deferred";
  batchId: string;
  inputFingerprint: string;
  revision: number;
  assessedAt: number;
  nextReviewAt?: number;
}

/** Only terminal whole-page wiki reviews require an editorial placement decision.
 * The writer derives scope from trusted work/claim state, never model metadata. */
export function recordKnowledgePlacement(
  db: Database.Database,
  input: SaveKnowledgeNodeInput,
  now: number,
): KnowledgePlacementRecord | undefined {
  const maintenance = input.maintenance;
  if (!maintenance || input.kind !== "wiki") return undefined;
  const review = db
    .prepare(
      "SELECT 1 FROM knowledge_work WHERE batch_id=? AND subject_id=? AND subject_kind='node' AND reason='review' AND (status='batched' OR (status='deferred' AND last_error='placement_unresolved'))",
    )
    .get(maintenance.batchId, input.id);
  if (!review || pendingMaintenanceClaimIds(db, { ...maintenance, nodeId: input.id }).length)
    return undefined;
  const assessment = maintenance.placementAssessment;
  if (!assessment || !assessment.reason?.trim() || assessment.reason.length > 500)
    throw new KnowledgeStorageError(
      "claim_invalid",
      "A terminal wiki review needs placementAssessment: integrated with actual links, standalone after reading the library, or deferred when placement remains unresolved. Partial claim repair does not require it.",
    );
  if (!["integrated", "standalone", "deferred"].includes(assessment.status))
    throw new KnowledgeStorageError("claim_invalid", "Invalid placement assessment");
  // Inventory is an observed editorial context, not a global absence proof.
  if (assessment.status !== "deferred" && !input.runFence?.placementLibrary)
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Read knowledge_list({kind:'wiki'}) before assessing page placement.",
    );
  if (assessment.status === "integrated") {
    if (!assessment.links.length || assessment.links.length > 16)
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Integrated placement needs one to sixteen actual incident organizational links",
      );
    for (const link of assessment.links) {
      const otherId =
        link.fromId === input.id ? link.toId : link.toId === input.id ? link.fromId : null;
      const other = otherId ? getKnowledgeNode(db, otherId) : null;
      if (
        !other ||
        other.canonicalFields.withdrawn === true ||
        !["wiki", "root"].includes(other.kind) ||
        other.id === input.id
      )
        throw new KnowledgeStorageError(
          "reference_invalid",
          "Placement counterpart is unavailable",
        );
      if (
        other.revision !== link.otherRevision ||
        input.runFence?.placementNodeReads?.[other.id] !== link.otherRevision
      )
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Read the placement counterpart with knowledge_fetch and use its current revision",
        );
      if (
        !["part_of", "belongs_to_project", "related_to"].includes(link.kind) ||
        !db
          .prepare("SELECT 1 FROM knowledge_links WHERE from_id=? AND to_id=? AND kind=?")
          .get(link.fromId, link.toId, link.kind)
      )
        throw new KnowledgeStorageError(
          "claim_invalid",
          "Integrated placement requires a persisted organizational link; make the justified knowledge_link first, then refresh the frontier",
        );
    }
  }
  const revision = getKnowledgeNode(db, input.id)!.revision;
  const record: KnowledgePlacementRecord = {
    status: assessment.status,
    batchId: maintenance.batchId,
    inputFingerprint: maintenance.inputFingerprint,
    revision,
    assessedAt: now,
  };
  if (assessment.status !== "deferred")
    db.prepare(
      "UPDATE knowledge_work SET status='batched',last_error=NULL WHERE batch_id=? AND subject_id=? AND subject_kind='node' AND reason='review' AND status='deferred' AND last_error='placement_unresolved'",
    ).run(maintenance.batchId, input.id);
  if (assessment.status === "deferred") {
    const delay = Math.max(60000, maintenance.placementRetryDelayMs ?? 21600000);
    record.nextReviewAt = now + delay;
    // Existing review scheduling discovers this obligation after the bounded delay.
    // No immediate successor frontier or extra lifecycle is created.
    db.prepare(
      "UPDATE knowledge_nodes SET metadata_json=json_set(metadata_json,'$.nextReviewAt',?,'$.reviewDecision','defer','$.reviewReason','placement_unresolved','$.reviewDecidedAt',?) WHERE id=?",
    ).run(record.nextReviewAt, now, input.id);
    db.prepare(
      "UPDATE knowledge_work SET status='deferred',updated_at=?,last_error='placement_unresolved' WHERE batch_id=? AND subject_id=? AND subject_kind='node' AND reason='review' AND status='batched'",
    ).run(now, maintenance.batchId, input.id);
    enqueueKnowledgeWork(
      db,
      {
        id: `kw_${randomUUID()}`,
        subjectId: input.id,
        subjectKind: "node",
        reason: "review",
        inputRevision: String(revision),
        tier: "routine",
        dueAt: record.nextReviewAt,
      },
      now,
    );
  }
  return record;
}
