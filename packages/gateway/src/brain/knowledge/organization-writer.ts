// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { enqueueCognitionRun } from "../storage/run-queue.js";
import { createKnowledgeBatch, enqueueKnowledgeWork, type KnowledgeFrontierInput } from "./work.js";
import { abandonKnowledgeBatch } from "./work-lifecycle.js";
import {
  createOrganizationCohort,
  completeOrganizationCohort,
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
    if (!completeOrganizationCohort(db, input, now))
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Organization snapshot or target changed; fetch the current frontier before retrying",
      );
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
