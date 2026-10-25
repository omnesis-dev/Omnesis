// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/**
 * Retry policy for maintenance work whose batch failed.
 *
 * A failure counts only when a failed run had the item offered (or settled it
 * without finishing what it owed) and the batch was then abandoned. Work that
 * a batch never reached is not charged. Each counted failure doubles the
 * successor's delay up to the cap; at `maxFailedAttempts` the work is parked
 * at its input revision instead of being re-enqueued.
 */
export interface KnowledgeRetryPolicy {
  backoffMs: number;
  backoffCapMs: number;
  maxFailedAttempts: number;
}

/** `last_error` of a deferred work row that is parked rather than retried. */
export const KNOWLEDGE_WORK_PARKED = "parked";

/** Delay before retrying work that has failed `failures` times (failures >= 1). */
export function knowledgeRetryDelayMs(failures: number, policy: KnowledgeRetryPolicy): number {
  const exponent = Math.max(0, Math.min(52, failures - 1));
  return Math.min(policy.backoffCapMs, policy.backoffMs * 2 ** exponent);
}

/**
 * SQL predicate: the subject's work for this reason and input revision is
 * parked. Pass `reason` as null to match a park under any reason. Served by
 * the partial `knowledge_work_parked` index.
 */
export function knowledgeWorkParkedSql(
  subjectKind: string,
  subjectId: string,
  inputRevision: string,
  reason: string | null = null,
): string {
  return `EXISTS(SELECT 1 FROM knowledge_work parked WHERE parked.status='deferred' AND parked.last_error='${KNOWLEDGE_WORK_PARKED}'
    AND parked.subject_kind=${subjectKind} AND parked.subject_id=${subjectId} AND parked.input_revision=${inputRevision}${reason ? ` AND parked.reason=${reason}` : ""})`;
}

export function createKnowledgeRetryIndexes(db: Database.Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS knowledge_work_parked
    ON knowledge_work(subject_kind,subject_id,reason,input_revision)
    WHERE status='deferred' AND last_error='${KNOWLEDGE_WORK_PARKED}'`);
}

/**
 * True when a node's obligation at this revision belongs to an isolated retry
 * (queued after a charged failure) or is parked.
 */
export function isolatedKnowledgeRetry(
  db: Database.Database,
  nodeId: string,
  revision: number,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM knowledge_work WHERE subject_kind='node' AND subject_id=? AND input_revision=?
      AND ((status='pending' AND failures>0) OR (status='deferred' AND last_error='${KNOWLEDGE_WORK_PARKED}')) LIMIT 1`,
    )
    .get(nodeId, String(revision));
}
