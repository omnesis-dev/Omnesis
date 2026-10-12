// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { outcomeWriteConflict, type OutcomeWriteFence } from "../storage/outcome-write-fence.js";
import { KnowledgeStorageError } from "./types.js";
import type { OutcomeProposal } from "../record-check/outcome-context.js";
import type Database from "better-sqlite3";

export interface OutcomeAssessmentReceipt {
  policy: string;
  fingerprint: string;
  decisionId: string;
  reviewBatchId: string | null;
}
export interface OutcomeAssessmentRow {
  policy: string;
  fingerprint: string;
  decision_id: string;
  review_batch_id: string | null;
  status: "pass" | "skip" | "unavailable";
  retry_at: number;
}

export function makeOutcomeAssessment(
  policy: string,
  proposed: OutcomeProposal,
  sources: OutcomeWriteFence["sources"],
  decisionId: string,
  reviewBatchId: string | null,
  actorRoles: Array<{ id: string; is_self: boolean | null }> = [],
  evidenceIds: readonly string[] = sources.slice(0, 8).map((source) => source.id),
): OutcomeAssessmentReceipt {
  return {
    policy,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify([
          policy,
          proposed,
          [...sources].sort((a, b) => a.id.localeCompare(b.id)),
          [...actorRoles].sort((a, b) => a.id.localeCompare(b.id)),
          evidenceIds,
        ]),
      )
      .digest("hex"),
    decisionId,
    reviewBatchId,
  };
}

/** An accepted canonical edit inside this review also satisfies its terminal proof save. */
export function outcomeReviewBatch(
  db: Database.Database,
  ownerId: string,
  runId: string,
): string | null {
  return (
    db
      .prepare<
        [string, string],
        { batch_id: string }
      >("SELECT w.batch_id FROM knowledge_work w JOIN knowledge_batches b ON b.id=w.batch_id WHERE b.run_id=? AND w.subject_kind='node' AND w.subject_id=? AND w.reason='review' LIMIT 1")
      .get(runId, ownerId)?.batch_id ?? null
  );
}

export function readOutcomeAssessment(db: Database.Database, ownerId: string, fingerprint: string) {
  return db
    .prepare<
      [string, string],
      OutcomeAssessmentRow
    >("SELECT * FROM knowledge_outcome_assessments WHERE owner_id=? AND fingerprint=?")
    .get(ownerId, fingerprint);
}

/** Caller holds the canonical writer transaction and has checked the pre-judge fence. */
export function persistOutcomeAssessment(
  db: Database.Database,
  ownerId: string,
  receipt: OutcomeAssessmentReceipt,
  sources: OutcomeWriteFence["sources"],
  now: number,
  status: OutcomeAssessmentRow["status"] = "pass",
  retryAt = now,
): void {
  db.prepare(
    `INSERT INTO knowledge_outcome_assessments(owner_id,policy,fingerprint,decision_id,review_batch_id,status,retry_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,fingerprint) DO UPDATE SET policy=excluded.policy,fingerprint=excluded.fingerprint,decision_id=excluded.decision_id,review_batch_id=excluded.review_batch_id,status=excluded.status,retry_at=excluded.retry_at,updated_at=excluded.updated_at`,
  ).run(
    ownerId,
    receipt.policy,
    receipt.fingerprint,
    receipt.decisionId,
    receipt.reviewBatchId,
    status,
    retryAt,
    now,
  );
  // One accepted snapshot plus at most two rejected/unavailable proposals per owner.
  if (status === "pass")
    db.prepare("DELETE FROM knowledge_outcome_assessments WHERE owner_id=? AND fingerprint!=?").run(
      ownerId,
      receipt.fingerprint,
    );
  else
    db.prepare(
      "DELETE FROM knowledge_outcome_assessments WHERE owner_id=? AND status!='pass' AND fingerprint!=? AND fingerprint NOT IN (SELECT fingerprint FROM knowledge_outcome_assessments WHERE owner_id=? AND status!='pass' AND fingerprint!=? ORDER BY updated_at DESC,fingerprint LIMIT 1)",
    ).run(ownerId, receipt.fingerprint, ownerId, receipt.fingerprint);
  db.prepare(
    "DELETE FROM knowledge_outcome_assessment_sources WHERE owner_id=? AND fingerprint=?",
  ).run(ownerId, receipt.fingerprint);
  const add = db.prepare(
    "INSERT INTO knowledge_outcome_assessment_sources(owner_id,fingerprint,document_id) VALUES(?,?,?)",
  );
  for (const id of new Set(sources.map((source) => source.id)))
    add.run(ownerId, receipt.fingerprint, id);
}

/** Refusals/backoff are durable too, but can never confer a successful proof. */
export function recordOutcomeAssessmentAttempt(
  db: Database.Database,
  input: {
    fence: OutcomeWriteFence;
    receipt: OutcomeAssessmentReceipt;
    status: "skip" | "unavailable";
    retryAt: number;
  },
  now: number,
): void {
  db.transaction(() => {
    if (
      (input.fence.kind ?? "loop") !== "loop" ||
      outcomeWriteConflict(db, input.fence.ownerId, input.fence)
    )
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Outcome assessment inputs changed; read the current outcome and evidence.",
      );
    persistOutcomeAssessment(
      db,
      input.fence.ownerId,
      input.receipt,
      input.fence.sources,
      now,
      input.status,
      input.retryAt,
    );
  })();
}
