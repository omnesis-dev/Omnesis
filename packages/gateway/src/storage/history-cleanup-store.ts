// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { HistoryCleanupRequest, StoredHistoryCleanupJob } from "./history-cleanup-types.js";

export function createHistoryCleanupTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS storage_cleanup_jobs (
    id TEXT PRIMARY KEY, target TEXT NOT NULL, state TEXT NOT NULL,
    revision INTEGER NOT NULL, has_pending INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, record_json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_cleanup_active_target
    ON storage_cleanup_jobs(target) WHERE state IN ('queued','running') OR has_pending=1;
  CREATE INDEX IF NOT EXISTS idx_storage_cleanup_recent ON storage_cleanup_jobs(updated_at DESC,id DESC);`);
}
export function readHistoryCleanupJob(
  db: Database.Database,
  id: string,
): StoredHistoryCleanupJob | null {
  const row = db
    .prepare<[string], { record_json: string }>(
      "SELECT record_json FROM storage_cleanup_jobs WHERE id=?",
    )
    .get(id);
  return row ? (JSON.parse(row.record_json) as StoredHistoryCleanupJob) : null;
}
export function listHistoryCleanupJobs(
  db: Database.Database,
  limit = 50,
): StoredHistoryCleanupJob[] {
  const recent = db
    .prepare<[number], { record_json: string }>(
      "SELECT record_json FROM storage_cleanup_jobs ORDER BY updated_at DESC,id DESC LIMIT ?",
    )
    .all(Math.min(200, Math.max(1, limit)))
    .map((row) => JSON.parse(row.record_json) as StoredHistoryCleanupJob);
  return [
    ...new Map(
      [...recent, ...readActiveHistoryCleanupJobs(db)].map((job) => [job.id, job]),
    ).values(),
  ].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
}
export function readActiveHistoryCleanupJobs(db: Database.Database): StoredHistoryCleanupJob[] {
  return db
    .prepare<[], { record_json: string }>(
      "SELECT record_json FROM storage_cleanup_jobs INDEXED BY idx_storage_cleanup_active_target WHERE state IN ('queued','running') OR has_pending=1 ORDER BY updated_at,id LIMIT 3",
    )
    .all()
    .map((row) => JSON.parse(row.record_json) as StoredHistoryCleanupJob);
}
export interface StartHistoryCleanupJob {
  request: HistoryCleanupRequest;
  now: number;
}
export function startHistoryCleanupJob(
  db: Database.Database,
  input: StartHistoryCleanupJob,
): StoredHistoryCleanupJob {
  return db.transaction(() => {
    const active = db
      .prepare<[string], { record_json: string }>(
        "SELECT record_json FROM storage_cleanup_jobs WHERE target=? AND (state IN ('queued','running') OR has_pending=1)",
      )
      .get(input.request.target);
    if (active) throw new Error("A cleanup is already running for this storage category");
    const job: StoredHistoryCleanupJob = {
      id: randomUUID(),
      ...input.request,
      ...(input.request.target === "backups"
        ? { keepNewest: input.request.keepNewest ?? true }
        : {}),
      state: "queued",
      revision: 0,
      cursor: null,
      pending: null,
      scanned: 0,
      removed: 0,
      protected: 0,
      protectedReasons: {},
      removedBytesEstimate: 0,
      cancelRequested: false,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
      error: null,
    };
    db.prepare(
      "INSERT INTO storage_cleanup_jobs(id,target,state,revision,updated_at,record_json) VALUES(?,?,?,?,?,?)",
    ).run(job.id, job.target, job.state, job.revision, job.updatedAt, JSON.stringify(job));
    return job;
  })();
}
export interface UpdateHistoryCleanupJob {
  job: StoredHistoryCleanupJob;
  expectedRevision: number;
}
/** Compare-and-swap the complete bounded job record; cancellation cannot be overwritten by stale work. */
export function updateHistoryCleanupJob(
  db: Database.Database,
  input: UpdateHistoryCleanupJob,
): StoredHistoryCleanupJob | null {
  const job = { ...input.job, revision: input.expectedRevision + 1 };
  const updated = db
    .prepare(
      "UPDATE storage_cleanup_jobs SET state=?,revision=?,has_pending=?,updated_at=?,record_json=? WHERE id=? AND revision=?",
    )
    .run(
      job.state,
      job.revision,
      job.pending ? 1 : 0,
      job.updatedAt,
      JSON.stringify(job),
      job.id,
      input.expectedRevision,
    ).changes;
  return updated ? job : null;
}
export function cancelHistoryCleanupJob(
  db: Database.Database,
  input: { id: string; now: number },
): StoredHistoryCleanupJob | null {
  return db.transaction(() => {
    const job = readHistoryCleanupJob(db, input.id);
    if (!job || job.state === "completed" || job.state === "cancelled") return job;
    return updateHistoryCleanupJob(db, {
      expectedRevision: job.revision,
      job: {
        ...job,
        cancelRequested: true,
        state: job.pending ? "running" : "cancelled",
        updatedAt: input.now,
        completedAt: job.pending ? null : input.now,
      },
    });
  })();
}
