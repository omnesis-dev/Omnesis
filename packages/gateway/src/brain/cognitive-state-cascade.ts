// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cognitive state grounded on documents that no longer exist.
 *
 * A source deletion is a change like an edit: the loops, observations and
 * annotations built on a deleted document survive it. They lose their pointer
 * to the document, are marked stale and are queued for the Brain's review
 * (see `source-deletion-review.ts`). Every path that deletes documents runs
 * this, which is why it is one function rather than a sequence each caller
 * repeats — a delete path that forgets a step is the failure mode worth
 * designing out. The per-document delete primitives already do the same
 * inside their own transaction; this pass covers the bulk wipes that remove
 * rows wholesale, and finds nothing left to do after the others.
 *
 * The per-source coverage tallies ride along here too, though they are the one
 * arm that reasons about the SOURCE rather than the documents named — see
 * `storage/coverage.ts`.
 *
 * Each arm is guarded by a cheap existence check on the read handle, so an
 * install that never enabled the Brain pays nothing for the call.
 */

import { hasAnyTemporalAnnotations } from "../enrichment/temporal-annotations/storage.js";
import {
  hasAnyCognitionCoverage,
  hasAnyDocAnnotations,
  hasAnyObservations,
  hasAnyOpenLoops,
  hasAnyPersonAnnotations,
} from "./index.js";
import type { SourceDeletionReview } from "./source-deletion-review.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** Deleted documents handed to one writer op, so a bulk wipe never parks the writer. */
export const SOURCE_DELETION_REVIEW_BATCH = 500;

/** The write-gate slice this cascade needs. */
export interface CognitiveStateCascadeOps {
  reviewBrainArtifactsForDeletedDocs(
    deletedDocIds: readonly string[],
  ): Promise<SourceDeletionReview>;
  retractOrphanCognitionCoverage(): Promise<number>;
}

/** `cascadeCognitiveStateForDocs` against the write gate. */
export async function cascadeCognitiveStateThroughGate(
  db: Db,
  gate: CognitiveStateCascadeOps,
  deletedDocIds: readonly string[],
): Promise<void> {
  await cascadeCognitiveStateForDocs(db, gate, deletedDocIds);
}

/**
 * Keep every cognitive artifact grounded on `deletedDocIds` and queue it for
 * review, and retract the coverage of any source that has since ceased to
 * exist. Safe to call with an empty list, and safe to call twice.
 */
export async function cascadeCognitiveStateForDocs(
  db: Db,
  ops: CognitiveStateCascadeOps,
  deletedDocIds: readonly string[],
): Promise<void> {
  // Coverage claims are the one arm keyed on the SOURCE rather than on the
  // documents, so it runs whether or not this call names any: removing a
  // source whose documents were already gone hands the cascade an empty list,
  // and its coverage row would otherwise outlive it.
  if (hasAnyCognitionCoverage(db)) await ops.retractOrphanCognitionCoverage();

  if (
    deletedDocIds.length === 0 ||
    !(
      hasAnyOpenLoops(db) ||
      hasAnyObservations(db) ||
      hasAnyDocAnnotations(db) ||
      hasAnyPersonAnnotations(db) ||
      hasAnyTemporalAnnotations(db)
    )
  )
    return;
  for (let i = 0; i < deletedDocIds.length; i += SOURCE_DELETION_REVIEW_BATCH)
    await ops.reviewBrainArtifactsForDeletedDocs(
      deletedDocIds.slice(i, i + SOURCE_DELETION_REVIEW_BATCH),
    );
}
