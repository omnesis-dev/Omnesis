// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Retract the cognitive state grounded on documents that no longer exist.
 *
 * Annotations, brief claims and open loops quote their evidence verbatim, so a
 * deleted document leaves behind both a dangling reference and a copy of the
 * content that was removed. Every path that deletes documents runs this, which
 * is why it is one function rather than a sequence each caller repeats — a
 * delete path that forgets a step is the failure mode worth designing out.
 *
 * Retracting a loop also strands its mirror: the open-loop source projects
 * every loop into a corpus document, and that projection carries the loop's
 * title and description. The writer removes both in one transaction and
 * records durable cleanup for the mirror's separate search index.
 *
 * The per-source coverage tallies ride along here too, for the same reason,
 * though they are the one arm that reasons about the SOURCE rather than the
 * documents named — see `storage/coverage.ts`.
 *
 * Each store is guarded by a cheap existence check on the read handle, so an
 * install that never enabled the Brain pays nothing for the call.
 */

import { hasAnyTemporalAnnotations } from "../enrichment/temporal-annotations/storage.js";
import {
  hasAnyBriefClaims,
  hasAnyCognitionCoverage,
  hasAnyDocAnnotations,
  hasAnyOpenLoops,
  hasAnyPersonAnnotations,
} from "./index.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** The write-gate slice this cascade needs. */
export interface CognitiveStateCascadeOps {
  cascadeAnnotationPrivacyDelete(deletedDocIds: readonly string[]): Promise<string[]>;
  cascadePersonAnnotationPrivacyDelete(deletedDocIds: readonly string[]): Promise<string[]>;
  cascadeTemporalAnnotationPrivacyDelete(deletedDocIds: readonly string[]): Promise<string[]>;
  cascadeBriefClaimPrivacyDelete(deletedDocIds: readonly string[]): Promise<string[]>;
  cascadeOpenLoopPrivacyDelete(
    deletedDocIds: readonly string[],
  ): Promise<{ deletedLoopIds: string[]; deletedBriefIds: string[] }>;
  retractOrphanCognitionCoverage(): Promise<number>;
}

/**
 * `purgeCognitiveStateForDocs` against the write gate. The writer's loop
 * cascade also removes mirrored documents in the same transaction.
 */
export async function purgeCognitiveStateThroughGate(
  db: Db,
  gate: CognitiveStateCascadeOps,
  deletedDocIds: readonly string[],
): Promise<void> {
  await purgeCognitiveStateForDocs(db, gate, deletedDocIds);
}

/**
 * Purge every cognitive artifact grounded on `deletedDocIds`, and retract the
 * coverage of any source that has since ceased to exist. Safe to call with an
 * empty list, and safe to call twice — each cascade is a delete by id.
 */
export async function purgeCognitiveStateForDocs(
  db: Db,
  ops: CognitiveStateCascadeOps,
  deletedDocIds: readonly string[],
): Promise<void> {
  // Coverage claims are the one arm keyed on the SOURCE rather than on the
  // documents, so it runs whether or not this call names any: removing a
  // source whose documents were already gone hands the cascade an empty list,
  // and its coverage row would otherwise outlive it.
  if (hasAnyCognitionCoverage(db)) await ops.retractOrphanCognitionCoverage();

  if (deletedDocIds.length === 0) return;

  // Doc annotations: dangling, and their derived text may embed the removed
  // content.
  if (hasAnyDocAnnotations(db)) await ops.cascadeAnnotationPrivacyDelete(deletedDocIds);
  // Person annotations ground in an evidence document too.
  if (hasAnyPersonAnnotations(db)) await ops.cascadePersonAnnotationPrivacyDelete(deletedDocIds);
  // A temporal annotation may embed content derived from a cited document.
  if (hasAnyTemporalAnnotations(db))
    await ops.cascadeTemporalAnnotationPrivacyDelete(deletedDocIds);
  // A brief claim's evidence quote is the cited document's content verbatim.
  if (hasAnyBriefClaims(db)) await ops.cascadeBriefClaimPrivacyDelete(deletedDocIds);

  // Loops built on the removed documents, and the briefs attached to them.
  // The writer removes each loop, its attached briefs and its mirror together.
  if (hasAnyOpenLoops(db)) {
    await ops.cascadeOpenLoopPrivacyDelete(deletedDocIds);
  }
}
