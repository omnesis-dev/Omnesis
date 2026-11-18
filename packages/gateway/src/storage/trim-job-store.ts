// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import {
  readStorageSourceIncarnation,
  storageRetentionBindingIsCurrent,
  type BoundStorageRetentionPolicy,
} from "./retention-bindings.js";
import {
  removeStorageRetentionCandidates,
  currentStorageRetentionCandidates,
  STORAGE_RETENTION_BATCH_SIZE,
  type StorageRetentionCandidate,
} from "./retention-store.js";
import type { AbsenceCascade } from "../data/repositories/AbsenceRepository.js";
import type { ConfigRevisionFence } from "../config-store.js";
import type Database from "better-sqlite3";

export interface StorageTrimJob {
  id: string;
  kind: "manual" | "rolling";
  sourceId: string;
  before: string;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  deleted: number;
  examinedDocuments: number;
  skippedDocuments: number;
  cleanupPending: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  error: string | null;
}

export interface StoredStorageTrimJob extends StorageTrimJob {
  sourceIncarnation: string;
  bindingId: string | null;
  maxAgeDays: number | null;
  cursorDate: string;
  cursorId: string;
  upperDate: string;
  upperId: string;
  revision: number;
}

export interface StartStorageTrimJob {
  sourceId: string;
  before: string;
  kind: "manual" | "rolling";
  now: number;
  sourceIncarnation: string;
  policy?: BoundStorageRetentionPolicy;
  authority?: ConfigRevisionFence;
}

export interface StorageTrimPage {
  rows: StorageRetentionCandidate[];
  hasMore: boolean;
}

export interface ApplyStorageTrimPage {
  jobId: string;
  revision: number;
  page: StorageTrimPage;
  now: number;
  authority?: ConfigRevisionFence;
}

export interface FailStorageTrimJob {
  jobId: string;
  revision: number;
  now: number;
}

export interface AppliedStorageTrimPage {
  job: StoredStorageTrimJob | null;
  deleted: number;
  cascade?: AbsenceCascade;
}

export function createStorageTrimJobsTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_trim_jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('manual', 'rolling')),
      source_id TEXT NOT NULL, source_incarnation TEXT NOT NULL, before_date TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      binding_id TEXT, max_age_days INTEGER,
      cursor_date TEXT NOT NULL DEFAULT '', cursor_id TEXT NOT NULL DEFAULT '',
      upper_date TEXT NOT NULL, upper_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      examined INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER, error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_trim_one_active ON storage_trim_jobs(source_id,kind) WHERE state IN ('queued','running');
    CREATE INDEX IF NOT EXISTS idx_storage_trim_source_active
      ON storage_trim_jobs(source_id, kind, state);
    CREATE INDEX IF NOT EXISTS idx_storage_trim_recent ON storage_trim_jobs(updated_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_storage_trim_recent_manual ON storage_trim_jobs(updated_at DESC,id DESC)
      WHERE kind='manual' AND state NOT IN ('queued','running');
    CREATE INDEX IF NOT EXISTS idx_storage_trim_pending
      ON storage_trim_jobs(state, updated_at, id);
    CREATE INDEX IF NOT EXISTS idx_storage_trim_kind_recent
      ON storage_trim_jobs(kind, source_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS storage_trim_job_cascades (
      job_id TEXT NOT NULL REFERENCES storage_trim_jobs(id) ON DELETE CASCADE,
      cascade_id INTEGER NOT NULL REFERENCES snapshot_absence_cascade_outbox(id) ON DELETE CASCADE,
      PRIMARY KEY(job_id, cascade_id)
    );
    CREATE INDEX IF NOT EXISTS idx_storage_trim_cascade ON storage_trim_job_cascades(cascade_id);
  `);
}

const JOB_COLUMNS = `j.id, j.kind, j.source_id AS sourceId, j.source_incarnation AS sourceIncarnation,
  j.before_date AS before, j.state, j.binding_id AS bindingId, j.max_age_days AS maxAgeDays,
  j.cursor_date AS cursorDate, j.cursor_id AS cursorId, j.upper_date AS upperDate, j.upper_id AS upperId,
  j.revision, j.deleted, j.examined AS examinedDocuments, j.skipped AS skippedDocuments,
  j.created_at AS createdAt, j.updated_at AS updatedAt, j.completed_at AS completedAt, j.error,
  EXISTS(SELECT 1 FROM storage_trim_job_cascades c WHERE c.job_id = j.id) AS cleanupPending`;

function normalized(job: StoredStorageTrimJob): StoredStorageTrimJob {
  return { ...job, cleanupPending: !!job.cleanupPending };
}

export function readStorageTrimJob(db: Database.Database, id: string): StoredStorageTrimJob | null {
  const job = db
    .prepare<[string], StoredStorageTrimJob>(
      `SELECT ${JOB_COLUMNS} FROM storage_trim_jobs j WHERE j.id = ?`,
    )
    .get(id);
  return job ? normalized(job) : null;
}

/** A job may own at most one unfinished bounded cross-store obligation. */
export function readStorageTrimPendingCascade(
  db: Database.Database,
  jobId: string,
): AbsenceCascade | null {
  const row = db
    .prepare<
      [string],
      { id: number; document_ids: string; index_done: number; cognition_done: number }
    >(
      `SELECT o.id,o.document_ids,o.index_done,o.cognition_done FROM storage_trim_job_cascades c
      JOIN snapshot_absence_cascade_outbox o ON o.id=c.cascade_id WHERE c.job_id=? ORDER BY o.id LIMIT 1`,
    )
    .get(jobId);
  return row
    ? {
        id: row.id,
        documentIds: JSON.parse(row.document_ids) as string[],
        indexDone: !!row.index_done,
        cognitionDone: !!row.cognition_done,
      }
    : null;
}

export function listStorageTrimJobs(
  db: Database.Database,
  currentIncarnationOnly = false,
): StoredStorageTrimJob[] {
  const current = currentIncarnationOnly
    ? ` AND EXISTS(SELECT 1 FROM storage_source_incarnations i JOIN sources s ON s.id=i.source_id
    WHERE i.source_id=j.source_id AND i.incarnation=j.source_incarnation AND NOT EXISTS(SELECT 1 FROM removed_sources r WHERE r.id=j.source_id))`
    : "";
  // Active work is bounded by the registered source roster; recent terminal
  // work is bounded independently rather than scanning every historic job.
  const active = db
    .prepare<[], StoredStorageTrimJob>(
      `SELECT ${JOB_COLUMNS} FROM storage_trim_jobs j
    WHERE j.state IN ('queued', 'running') ${current} ORDER BY j.updated_at, j.id LIMIT 1000`,
    )
    .all();
  const recent = db
    .prepare<[], StoredStorageTrimJob>(
      `SELECT ${JOB_COLUMNS} FROM storage_trim_jobs j
    WHERE j.id IN (SELECT id FROM storage_trim_jobs WHERE kind='manual' AND state NOT IN ('queued','running') ORDER BY updated_at DESC, id DESC LIMIT 20)
    AND j.state NOT IN ('queued', 'running') ${current} ORDER BY j.updated_at DESC, j.id DESC`,
    )
    .all();
  return [...active, ...recent].map(normalized);
}

function authorityMatches(authority?: ConfigRevisionFence): boolean {
  return !authority || Atomics.load(new Int32Array(authority.buffer), 0) === authority.revision;
}

export function startStorageTrimJob(
  db: Database.Database,
  input: StartStorageTrimJob,
): StoredStorageTrimJob | null {
  return db.transaction(() => {
    if (
      !authorityMatches(input.authority) ||
      readStorageSourceIncarnation(db, input.sourceId) !== input.sourceIncarnation ||
      (input.policy && !storageRetentionBindingIsCurrent(db, input.policy))
    )
      return null;
    const existing =
      db
        .prepare<[string, string], { id: string }>(
          "SELECT id FROM storage_trim_jobs WHERE source_id=? AND kind=? AND state IN ('queued','running') LIMIT 1",
        )
        .get(input.sourceId, input.kind) ??
      db
        .prepare<[string, string], { id: string }>(
          "SELECT id FROM storage_trim_jobs WHERE source_id=? AND kind=? ORDER BY updated_at DESC,rowid DESC LIMIT 1",
        )
        .get(input.sourceId, input.kind);
    const previous = existing ? readStorageTrimJob(db, existing.id) : null;
    if (previous && (previous.state === "queued" || previous.state === "running")) {
      // A second command cannot revoke an already accepted manual cutoff.
      if (
        input.kind === "manual" &&
        previous.sourceIncarnation === input.sourceIncarnation &&
        previous.before !== input.before
      )
        return null;
      if (
        previous.sourceIncarnation === input.sourceIncarnation &&
        (input.kind === "manual"
          ? previous.before === input.before
          : previous.bindingId === input.policy?.bindingId)
      )
        return previous;
      db.prepare(
        "UPDATE storage_trim_jobs SET state='cancelled', error='Trim authority changed', updated_at=?, completed_at=?, revision=revision+1 WHERE id=?",
      ).run(input.now, input.now, previous.id);
    }
    if (
      input.kind === "rolling" &&
      previous?.state === "failed" &&
      input.now - previous.updatedAt < 60_000
    )
      return previous;
    const upper = db
      .prepare<[string, string], { date: string; id: string }>(
        `SELECT source_created_at AS date, id FROM documents INDEXED BY idx_documents_source_created_revision
        WHERE source_id = ? AND source_created_at < ? ORDER BY source_created_at DESC, id DESC LIMIT 1`,
      )
      .get(input.sourceId, input.before);
    const samePassAuthority =
      input.kind === "rolling" &&
      previous?.sourceIncarnation === input.sourceIncarnation &&
      previous.bindingId === input.policy?.bindingId;
    const cursorDate = samePassAuthority ? previous.cursorDate : "";
    const cursorId = samePassAuthority ? previous.cursorId : "";
    const hasWork =
      upper && (upper.date > cursorDate || (upper.date === cursorDate && upper.id > cursorId));
    const id = samePassAuthority ? previous.id : randomUUID();
    db.prepare(
      `INSERT INTO storage_trim_jobs(id,kind,source_id,source_incarnation,before_date,state,binding_id,max_age_days,
      upper_date,upper_id,cursor_date,cursor_id,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET before_date=excluded.before_date, state=excluded.state,
      binding_id=excluded.binding_id,max_age_days=excluded.max_age_days,cursor_date=excluded.cursor_date,cursor_id=excluded.cursor_id,
      upper_date=excluded.upper_date,upper_id=excluded.upper_id,revision=storage_trim_jobs.revision+1,
      updated_at=excluded.updated_at,completed_at=excluded.completed_at,error=NULL`,
    ).run(
      id,
      input.kind,
      input.sourceId,
      input.sourceIncarnation,
      input.before,
      hasWork ? "queued" : "completed",
      input.policy?.bindingId ?? null,
      input.policy?.maxAgeDays ?? null,
      upper?.date ?? "",
      upper?.id ?? "",
      cursorDate,
      cursorId,
      input.now,
      input.now,
      hasWork ? null : input.now,
    );
    return readStorageTrimJob(db, id);
  })();
}

export const STORAGE_TRIM_PAGE_SQL = `SELECT id,source_created_at
      FROM documents INDEXED BY idx_documents_source_created_revision WHERE source_id = ?
       AND (source_created_at,id) > (?,?) AND (source_created_at,id) <= (?,?)
      ORDER BY source_created_at,id LIMIT ?`;

/** Every returned row advances the cursor, including protected/noncanonical rows. */
export function readStorageTrimPage(
  db: Database.Database,
  job: StoredStorageTrimJob,
): StorageTrimPage {
  const rows = db
    .prepare<[string, string, string, string, string, number], StorageRetentionCandidate>(
      STORAGE_TRIM_PAGE_SQL,
    )
    .all(
      job.sourceId,
      job.cursorDate,
      job.cursorId,
      job.upperDate,
      job.upperId,
      STORAGE_RETENTION_BATCH_SIZE + 1,
    );
  return {
    rows: rows.slice(0, STORAGE_RETENTION_BATCH_SIZE),
    hasMore: rows.length > STORAGE_RETENTION_BATCH_SIZE,
  };
}

export function applyStorageTrimPage(
  db: Database.Database,
  input: ApplyStorageTrimPage,
): AppliedStorageTrimPage {
  if (input.page.rows.length > STORAGE_RETENTION_BATCH_SIZE)
    throw new Error("Storage trim page exceeds bound");
  return db.transaction(() => {
    const job = readStorageTrimJob(db, input.jobId);
    if (!job || job.revision !== input.revision || !["queued", "running"].includes(job.state))
      return { job, deleted: 0 };
    if (job.cleanupPending) return { job, deleted: 0 };
    const policy =
      job.bindingId && job.maxAgeDays !== null
        ? {
            sourceId: job.sourceId,
            maxAgeDays: job.maxAgeDays,
            sourceIncarnation: job.sourceIncarnation,
            bindingId: job.bindingId,
          }
        : null;
    if (
      readStorageSourceIncarnation(db, job.sourceId) !== job.sourceIncarnation ||
      (policy && !storageRetentionBindingIsCurrent(db, policy))
    ) {
      db.prepare(
        "UPDATE storage_trim_jobs SET state='cancelled',error='Source or retention authority changed',updated_at=?,completed_at=?,revision=revision+1 WHERE id=?",
      ).run(input.now, input.now, job.id);
      return { job: readStorageTrimJob(db, job.id), deleted: 0 };
    }
    if (!authorityMatches(input.authority)) return { job, deleted: 0 };
    const candidates = currentStorageRetentionCandidates(
      db,
      job.sourceId,
      job.before,
      input.page.rows,
    );
    const removed = removeStorageRetentionCandidates(db, candidates, job.kind === "manual");
    if (removed.cascade)
      db.prepare("INSERT INTO storage_trim_job_cascades(job_id,cascade_id) VALUES(?,?)").run(
        job.id,
        removed.cascade.id,
      );
    const last = input.page.rows.at(-1);
    db.prepare(
      `UPDATE storage_trim_jobs SET state=?,cursor_date=?,cursor_id=?,deleted=deleted+?,examined=examined+?,
      skipped=skipped+?,updated_at=?,completed_at=?,revision=revision+1 WHERE id=?`,
    ).run(
      input.page.hasMore ? "running" : "completed",
      last?.source_created_at ?? job.upperDate,
      last?.id ?? job.upperId,
      removed.deleted,
      input.page.rows.length,
      input.page.rows.length - removed.deleted,
      input.now,
      input.page.hasMore ? null : input.now,
      job.id,
    );
    return {
      job: readStorageTrimJob(db, job.id),
      deleted: removed.deleted,
      ...(removed.cascade ? { cascade: removed.cascade } : {}),
    };
  })();
}

/** Failure is durable and content-free; a retry keeps already committed progress auditable. */
export function failStorageTrimJob(
  db: Database.Database,
  input: FailStorageTrimJob,
): StoredStorageTrimJob | null {
  db.prepare(
    `UPDATE storage_trim_jobs SET state='failed',error='Storage cleanup could not continue. Retry this trim.',
    updated_at=?,revision=revision+1 WHERE id=? AND revision=? AND state IN ('queued','running')`,
  ).run(input.now, input.jobId, input.revision);
  return readStorageTrimJob(db, input.jobId);
}
