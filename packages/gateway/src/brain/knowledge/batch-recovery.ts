// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

interface RecoverableKnowledgeBatchOptions {
  /** A pending run at this many attempts is never claimed again. */
  maxAttempts: number;
  /** A run last claimed before this instant is presumed lost. */
  claimedBefore: number;
  limit: number;
}

interface RecoverableKnowledgeBatch {
  id: string;
  runId: string;
  /** The batch's run failed. */
  failed: number;
  /** The batch's run is still pending at its attempts cap and was last claimed long ago. */
  dead: number;
}

/**
 * Open batches whose run is over, oldest first: settled, missing, or still
 * pending at its attempts cap with its last claim older than `claimedBefore`.
 * Every open batch is visited and sorted by age, so with a large deferred
 * backlog this is a scan; the engine runs it on a read worker.
 */
export function listRecoverableKnowledgeBatches(
  db: Database.Database,
  options: RecoverableKnowledgeBatchOptions,
): RecoverableKnowledgeBatch[] {
  return db
    .prepare<[number, number, number], RecoverableKnowledgeBatch>(
      `SELECT b.id,b.run_id AS runId,COALESCE(r.status='failed',0) AS failed,COALESCE(r.status='pending',0) AS dead
      FROM knowledge_batches b
      LEFT JOIN cognition_runs r ON r.id=b.run_id WHERE b.status IN ('pending','running','deferred')
      AND (r.id IS NULL OR r.status IN ('completed','failed')
        OR (r.status='pending' AND r.attempts>=? AND r.last_attempt_at<=?))
      ORDER BY b.created_at LIMIT ?`,
    )
    .all(options.maxAttempts, options.claimedBefore, options.limit);
}
