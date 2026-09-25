// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Bounded SQLite deletion primitives for the activity-retention sweep.
 *
 * Every call performs one short transaction and then returns control to the
 * Scheduler. That boundary is intentional: Omnesis has one writer worker, so
 * a retention pass must yield between batches for queued user/realtime writes.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

export const ACTIVITY_RETENTION_PHASES = [
  "cognitionRuns",
  "subscriptionFirings",
  "subscriptionAudit",
  "resolvedDevAnnotations",
] as const;

export type ActivityRetentionPhase = (typeof ACTIVITY_RETENTION_PHASES)[number];

export interface ActivityRetentionBatchResult {
  phase: ActivityRetentionPhase;
  deleted: number;
  hasMore: boolean;
}

/**
 * Return at most `maxPages` freelist pages to the OS on databases created
 * with incremental auto-vacuum. Existing installs remain mode NONE: changing
 * them online would require a blocking full VACUUM and temporary disk space.
 */
export function reclaimActivityRetentionPages(db: Db, maxPages = 64): number {
  const mode = db.pragma("auto_vacuum", { simple: true }) as number;
  if (mode !== 2) return 0;
  const before = db.pragma("freelist_count", { simple: true }) as number;
  if (before <= 0) return 0;
  const pages = Math.min(Math.max(1, Math.floor(maxPages)), 256);
  db.exec(`PRAGMA incremental_vacuum(${pages})`);
  const after = db.pragma("freelist_count", { simple: true }) as number;
  return Math.max(0, before - after);
}

/**
 * Delete at most `limit` rows from one operational-history store.
 * Product/source state, pending work, approvals, rules and durable cognition
 * artifacts are deliberately absent from this phase list. In particular,
 * `/answer` conversations, approval snapshots, egress ledgers and their audit
 * history are security/protocol records, not disposable activity traces; they
 * remain governed by the explicit privacy-delete workflow.
 */
export function pruneActivityRetentionBatch(
  db: Db,
  phase: ActivityRetentionPhase,
  cutoff: number,
  limit = 100,
): ActivityRetentionBatchResult {
  const batchSize = Math.min(Math.max(1, limit), 500);
  let hasMoreThreshold = batchSize;
  let deleted: number;
  switch (phase) {
    case "cognitionRuns":
      deleted = db
        .prepare<[number, number]>(
          `DELETE FROM cognition_runs
            WHERE id IN (
              SELECT id
                FROM cognition_runs
               WHERE status IN ('completed', 'failed')
                 AND completed_at IS NOT NULL
                 AND completed_at < ?
               ORDER BY completed_at, id
               LIMIT ?
            )`,
        )
        .run(cutoff, batchSize).changes;
      break;
    case "subscriptionFirings":
      hasMoreThreshold = Math.min(batchSize, 25);
      deleted = pruneSubscriptionFirings(db, cutoff, hasMoreThreshold);
      break;
    case "subscriptionAudit":
      deleted = db
        .prepare<[number, number]>(
          `DELETE FROM subscription_audit_events
            WHERE sequence IN (
              SELECT sequence
                FROM subscription_audit_events
               WHERE created_at < ?
               ORDER BY created_at, sequence
               LIMIT ?
            )`,
        )
        .run(cutoff, batchSize).changes;
      break;
    case "resolvedDevAnnotations":
      deleted = db
        .prepare<[number, number]>(
          `DELETE FROM dev_annotations
            WHERE id IN (
              SELECT id
                FROM dev_annotations
               WHERE status = 'resolved'
                 AND resolved_at IS NOT NULL
                 AND resolved_at < ?
               ORDER BY resolved_at, id
               LIMIT ?
            )`,
        )
        .run(cutoff, batchSize).changes;
      break;
  }
  return { phase, deleted, hasMore: deleted === hasMoreThreshold };
}

/**
 * Subscription firings own delivery children and short-lived bearer tokens.
 * Deleting the authority row alone would orphan a still-valid token, so token
 * deletion and firing deletion are one transaction. Open/retry/manual-review
 * deliveries make their firing ineligible regardless of age.
 */
function pruneSubscriptionFirings(db: Db, cutoff: number, limit: number): number {
  return db.transaction(() => {
    const ids = db
      .prepare<[number, number], { id: string }>(
        `SELECT f.id
           FROM subscription_firings f
          WHERE f.status IN ('delivered', 'blocked', 'failed')
            AND f.fired_at < ?
            AND NOT EXISTS (
              SELECT 1
                FROM subscription_deliveries d
               WHERE d.firing_id = f.id
                 AND d.status IN (
                   'pending', 'claimed', 'retry', 'cancel_pending',
                   'commit_authorized', 'manual_review'
                 )
            )
          ORDER BY f.fired_at, f.id
          LIMIT ?`,
      )
      .all(cutoff, limit)
      .map((row) => row.id);
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM tokens
        WHERE id IN (
          SELECT token_id
            FROM subscription_firing_answer_authorities
           WHERE firing_id IN (${placeholders})
        )`,
    ).run(...ids);
    return db.prepare(`DELETE FROM subscription_firings WHERE id IN (${placeholders})`).run(...ids)
      .changes;
  })();
}
