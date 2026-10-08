// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { enqueueCognitionRun } from "../storage/run-queue.js";
import { createKnowledgeBatch, enqueueKnowledgeWork, type KnowledgeFrontierInput } from "./work.js";
import { abandonKnowledgeBatch } from "./work-lifecycle.js";
import {
  createOrganizationCohort,
  type completeOrganizationCohort,
  completeOrganizationCohortResult,
  abandonOrganizationCohort,
  type OrganizationCohortSelection,
} from "./organization-cohorts.js";
import { assertKnowledgeRunFence } from "./run-fence.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

export function startOrganizationBatch(
  db: Database.Database,
  input: OrganizationCohortSelection & {
    id: string;
    batchId: string;
    runId: string;
    workPrefix: string;
    intervalMs: number;
    retryMs: number;
    regionNodeIds: string[];
    frontier: KnowledgeFrontierInput[];
  },
  now: number,
): void {
  db.transaction(() => {
    const work = Object.entries(input.sourceVersions).map(([sourceId, revision], index) => {
      if (
        db
          .prepare(
            "SELECT 1 FROM knowledge_work WHERE subject_kind='source' AND subject_id=? AND status IN ('pending','batched') LIMIT 1",
          )
          .get(sourceId)
      )
        throw new KnowledgeStorageError(
          "revision_conflict",
          "Organization evidence has pending maintenance",
        );
      return enqueueKnowledgeWork(
        db,
        {
          id: `${input.workPrefix}_${index}`,
          subjectKind: "source",
          subjectId: sourceId,
          reason: "review",
          inputRevision: revision,
          tier: "routine",
          dueAt: now,
        },
        now,
      );
    });
    createKnowledgeBatch(
      db,
      {
        id: input.batchId,
        runId: input.runId,
        tier: "routine",
        work: work.map((row) => ({
          id: row.id,
          generation: row.generation,
          inputRevision: row.inputRevision,
        })),
        regionNodeIds: input.regionNodeIds,
        frontier: input.frontier,
      },
      now,
    );
    if (!createOrganizationCohort(db, input, now))
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Organization cohort changed before admission",
      );
    enqueueCognitionRun(
      db,
      {
        id: input.runId,
        kind: "synthesis",
        payload: {
          focus: "knowledge-maintenance",
          batchId: input.batchId,
          organizationCohortId: input.id,
        },
        notBefore: now,
      },
      now,
    );
  })();
}

export function completeOrganizationBatch(
  db: Database.Database,
  input: Parameters<typeof completeOrganizationCohort>[1] & { runId: string },
  now: number,
): boolean {
  return db.transaction(() => {
    assertKnowledgeRunFence(db, { batchId: input.batchId, runId: input.runId });
    if (
      db
        .prepare(
          "SELECT 1 FROM knowledge_frontier WHERE batch_id=? AND status IN ('pending','offered','deferred') LIMIT 1",
        )
        .get(input.batchId)
    )
      throw new KnowledgeStorageError(
        "claim_invalid",
        "Complete the offered source and synthesis work before recording the joint organization outcome",
      );
    const result = completeOrganizationCohortResult(db, input, now);
    if (!result.accepted) {
      if (result.reason === "grounding")
        throw new KnowledgeStorageError(
          "claim_invalid",
          "Organization targets lack actual claim supports from this cohort's sources. A valid page update grounded only in other retrieved evidence does not establish this cohort's organized outcome. Use no_page with insufficient_shared_context or insufficient_evidence when no further synthesis is warranted, or deferred with awaiting_more_evidence when relevant context is missing. Do not pad support references or guess targetVersions.",
        );
      if (result.reason === "budget")
        throw new KnowledgeStorageError(
          "claim_invalid",
          "Organization grounding exceeds the bounded support traversal budget. Narrow the target set or defer for missing context; changing targetVersions or padding references does not repair this limitation.",
        );
      if (result.reason === "target")
        throw new KnowledgeStorageError(
          "revision_conflict",
          "An organization target is unavailable, stale, or has a different revision. Fetch the target and current frontier, then use the returned current target revision; do not guess targetVersions.",
        );
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Organization cohort snapshot or completion arguments changed; fetch the current frontier and reconcile its identity, sources and outcome before retrying",
      );
    }
    return true;
  })();
}

export function abandonOrganizationBatch(
  db: Database.Database,
  input: { batchId: string; notBefore: number },
  now: number,
): boolean {
  return db.transaction(() => {
    abandonOrganizationCohort(db, input.batchId, now);
    return abandonKnowledgeBatch(db, input, now);
  })();
}
