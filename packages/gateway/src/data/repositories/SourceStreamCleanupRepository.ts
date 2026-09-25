// SPDX-License-Identifier: AGPL-3.0-or-later

import { DeviceId, SourceId } from "@omnesis/types";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface SourceStreamCleanupJob {
  sourceId: SourceId;
  deviceId: DeviceId;
  generation: number;
  attempts: number;
}

/** Install the durable journal used by partitioned detach and move cleanup. */
export function createSourceStreamCleanupTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_stream_cleanups (
      source_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      queued_at INTEGER NOT NULL,
      completed_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      PRIMARY KEY (source_id, device_id)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_source_stream_cleanups_pending ON source_stream_cleanups(completed_at, queued_at)",
  );
}

function rowToJob(row: {
  source_id: string;
  device_id: string;
  generation: number;
  attempts: number;
}): SourceStreamCleanupJob {
  return {
    sourceId: SourceId(row.source_id),
    deviceId: DeviceId(row.device_id),
    generation: row.generation,
    attempts: row.attempts,
  };
}

/** Queue a new generation while the caller's membership transaction is open. */
export function enqueueSourceStreamCleanup(
  db: Db,
  sourceId: SourceId,
  deviceId: DeviceId,
  queuedAt = Date.now(),
): SourceStreamCleanupJob {
  const row = db
    .prepare<
      [string, string, number],
      { source_id: string; device_id: string; generation: number; attempts: number }
    >(
      `INSERT INTO source_stream_cleanups (
         source_id, device_id, generation, queued_at, completed_at, attempts, last_error
       ) VALUES (?, ?, 1, ?, NULL, 0, NULL)
       ON CONFLICT(source_id, device_id) DO UPDATE SET
         generation = source_stream_cleanups.generation + 1,
         queued_at = excluded.queued_at,
         completed_at = NULL,
         attempts = 0,
         last_error = NULL
       RETURNING source_id, device_id, generation, attempts`,
    )
    .get(sourceId, deviceId, queuedAt);
  if (!row) throw new Error(`Failed to queue stream cleanup for ${sourceId} on ${deviceId}`);
  return rowToJob(row);
}

export function listPendingSourceStreamCleanups(db: Db): SourceStreamCleanupJob[] {
  return db
    .prepare<[], { source_id: string; device_id: string; generation: number; attempts: number }>(
      `SELECT source_id, device_id, generation, attempts
         FROM source_stream_cleanups
        WHERE completed_at IS NULL
        ORDER BY queued_at, source_id, device_id`,
    )
    .all()
    .map(rowToJob);
}

export function isSourceStreamCleanupPending(
  db: Db,
  sourceId: SourceId,
  deviceId: DeviceId,
): boolean {
  return (
    db
      .prepare<[string, string], { found: number }>(
        `SELECT 1 AS found FROM source_stream_cleanups
          WHERE source_id = ? AND device_id = ? AND completed_at IS NULL`,
      )
      .get(sourceId, deviceId) !== undefined
  );
}

/** Completed cleanup remains evidence that only an explicit action may rejoin this stream. */
export function hasSourceStreamCleanupHistory(
  db: Db,
  sourceId: SourceId,
  deviceId: DeviceId,
): boolean {
  return (
    db
      .prepare("SELECT 1 FROM source_stream_cleanups WHERE source_id = ? AND device_id = ?")
      .get(sourceId, deviceId) !== undefined
  );
}

export function isCurrentSourceStreamCleanup(db: Db, job: SourceStreamCleanupJob): boolean {
  return (
    db
      .prepare<[string, string, number], { found: number }>(
        `SELECT 1 AS found FROM source_stream_cleanups
          WHERE source_id = ? AND device_id = ? AND generation = ? AND completed_at IS NULL`,
      )
      .get(job.sourceId, job.deviceId, job.generation) !== undefined
  );
}

/** Record failure only if this is still the current generation. */
export function recordSourceStreamCleanupFailure(
  db: Db,
  job: SourceStreamCleanupJob,
  message: string,
): boolean {
  return (
    db
      .prepare(
        `UPDATE source_stream_cleanups
            SET attempts = attempts + 1, last_error = ?
          WHERE source_id = ? AND device_id = ? AND generation = ? AND completed_at IS NULL`,
      )
      .run(message, job.sourceId, job.deviceId, job.generation).changes === 1
  );
}

/** Complete only the generation whose cleanup actually ran. */
export function completeSourceStreamCleanup(
  db: Db,
  job: SourceStreamCleanupJob,
  completedAt = Date.now(),
): boolean {
  return (
    db
      .prepare(
        `UPDATE source_stream_cleanups
            SET completed_at = ?, last_error = NULL
          WHERE source_id = ? AND device_id = ? AND generation = ? AND completed_at IS NULL`,
      )
      .run(completedAt, job.sourceId, job.deviceId, job.generation).changes === 1
  );
}
