// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A source deletion is a change like an edit: nothing the Brain built on the
 * deleted document is deleted with it.
 *
 * Whatever removed the document — a sync tombstone, a snapshot-absence sweep,
 * a source removal, a retention pass or an explicit delete — the document's
 * own rows go, and so do the pointers that exist only to name it: a loop's
 * link to it, an observation's citation of it. Every artifact that rested on
 * it survives in place and is marked the way its own store marks a claim that
 * lost its grounding:
 *
 *  - loops (and so the owner's Tasks) keep their state and journal entry; a
 *    ledger entry names the deleted document;
 *  - observations keep their summary, claims and state;
 *  - doc and person annotations keep their claim; the atoms citing the
 *    document break and the claim turns `unverified`, even one left with no
 *    live grounding or whose subject was the deleted document;
 *  - temporal annotations keep their sentence; the atoms citing the document
 *    break.
 *
 * Each surviving loop, observation and annotation is then queued for review
 * (`queueKnowledgeOwnerReview`): when the Brain's owner sync drains it, the
 * owner's knowledge node is marked stale and offered to maintenance, where
 * only a deliberate decision (a keep, an update, a resolution, a retraction,
 * a delete) may change or remove it. A temporal annotation is reviewed
 * through the loops it is linked to; one linked to none stays, ungrounded,
 * until a deliberate `temporal_annotation_update` or delete.
 *
 * Runs inside the deleting writer transaction for the per-document delete
 * primitives, and from the cognitive-state cascade for bulk wipes; both are
 * bounded by the caller's batch, and every lookup is an index-driven probe
 * per deleted document. Idempotent: a repeated call finds no live pointer left,
 * and an annotation about the deleted document already marked unverified.
 */

import {
  breakTemporalAnnotationEvidenceForDeletedDocs,
  hasAnyTemporalAnnotations,
} from "../enrichment/temporal-annotations/storage.js";
import { queueKnowledgeOwnerReview } from "./knowledge/owner-sync.js";
import { hasAnyDocAnnotations, reviewDocAnnotationsForDeletedDoc } from "./storage/annotations.js";
import { hasAnyObservations, reviewObservationsForDeletedDocs } from "./storage/observations.js";
import { hasAnyOpenLoops, reviewOpenLoopsForDeletedDocs } from "./storage/open-loops.js";
import {
  hasAnyPersonAnnotations,
  reviewPersonAnnotationsForDeletedDoc,
} from "./storage/person-annotations.js";
import type { KnowledgeOwnerKind } from "./knowledge/owner-adapters.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** What one source-deletion pass kept and queued for review. */
export interface SourceDeletionReview {
  loopIds: string[];
  observationIds: string[];
  docAnnotationIds: string[];
  personAnnotationIds: string[];
  temporalAnnotationIds: string[];
}

/** Keep every Brain artifact built on `deletedDocIds` and queue it for review. */
export function reviewBrainArtifactsForDeletedDocs(
  db: Db,
  deletedDocIds: readonly string[],
  now: number,
): SourceDeletionReview {
  const review: SourceDeletionReview = {
    loopIds: [],
    observationIds: [],
    docAnnotationIds: [],
    personAnnotationIds: [],
    temporalAnnotationIds: [],
  };
  if (deletedDocIds.length === 0) return review;
  return db.transaction(() => {
    const docs = JSON.stringify(deletedDocIds);
    const has = (table: string, populated: (db: Db) => boolean): boolean =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) &&
      populated(db);
    if (has("open_loops", hasAnyOpenLoops))
      review.loopIds = reviewOpenLoopsForDeletedDocs(db, deletedDocIds, now);
    if (has("observations", hasAnyObservations))
      review.observationIds = reviewObservationsForDeletedDocs(db, deletedDocIds);
    if (has("doc_annotations", hasAnyDocAnnotations)) {
      const touched = new Set<string>();
      for (const docId of annotatedDocs(db, docs, "doc"))
        for (const id of reviewDocAnnotationsForDeletedDoc(db, docId, now)) touched.add(id);
      review.docAnnotationIds = [...touched];
    }
    if (has("person_annotations", hasAnyPersonAnnotations)) {
      const touched = new Set<string>();
      for (const docId of annotatedDocs(db, docs, "person"))
        for (const id of reviewPersonAnnotationsForDeletedDoc(db, docId, now)) touched.add(id);
      review.personAnnotationIds = [...touched];
    }
    const linkedLoopIds = new Set<string>();
    if (has("temporal_annotations", hasAnyTemporalAnnotations)) {
      review.temporalAnnotationIds = breakTemporalAnnotationEvidenceForDeletedDocs(
        db,
        deletedDocIds,
        now,
      );
      if (review.temporalAnnotationIds.length > 0)
        for (const row of db
          .prepare<[string], { loop_id: string }>(
            `SELECT DISTINCT loop_id FROM temporal_annotation_loops
              WHERE annotation_id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(review.temporalAnnotationIds)))
          linkedLoopIds.add(row.loop_id);
    }
    // Owners are reviewed through the knowledge layer; without it the marks
    // above are the whole record.
    const reviewable = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_owner_changes'")
      .get();
    const queue = (kind: KnowledgeOwnerKind, ids: Iterable<string>) => {
      if (reviewable) for (const id of ids) queueKnowledgeOwnerReview(db, kind, id, now);
    };
    queue("loop", new Set([...review.loopIds, ...linkedLoopIds]));
    queue("observation", review.observationIds);
    queue("doc_annotation", review.docAnnotationIds);
    queue("person_annotation", review.personAnnotationIds);
    // An owner's node may still cite the document after its own pointer went:
    // synthesis cited it, or a bulk wipe dropped the pointer and owner sync
    // projected the node before the document row itself was deleted. Each is
    // queued too; once projected without the deleted source it no longer
    // depends on it, so a repeated pass finds nothing here.
    if (reviewable)
      for (const row of db
        .prepare<[string], { id: string; kind: KnowledgeOwnerKind }>(
          `SELECT DISTINCT n.id, n.kind FROM knowledge_dependencies d
             JOIN knowledge_nodes n ON n.id = d.node_id
            WHERE d.target_kind = 'source' AND d.target_id IN (SELECT value FROM json_each(?))
              AND n.owner_id = n.id AND n.kind NOT IN ('wiki', 'root')`,
        )
        .all(docs))
        queueKnowledgeOwnerReview(db, row.kind, row.id, now);
    return review;
  })();
}

/** The deleted documents some live annotation is about or grounded in. */
function annotatedDocs(db: Db, docs: string, store: "doc" | "person"): string[] {
  const sql =
    store === "doc"
      ? `SELECT j.value AS doc_id FROM json_each(?) j
          WHERE EXISTS (SELECT 1 FROM doc_annotations a
                         WHERE a.doc_id = j.value AND a.invalidated_at IS NULL
                           AND a.verification_state IS NOT 'unverified')
             OR EXISTS (SELECT 1 FROM doc_annotation_evidence e
                         WHERE e.evidence_doc_id = j.value AND e.broken_at IS NULL)`
      : `SELECT j.value AS doc_id FROM json_each(?) j
          WHERE EXISTS (SELECT 1 FROM person_annotation_evidence e
                         WHERE e.evidence_doc_id = j.value AND e.broken_at IS NULL)`;
  return db
    .prepare<[string], { doc_id: string }>(sql)
    .all(docs)
    .map((row) => row.doc_id);
}
