// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { DeviceId } from "@omnesis/types";
import type { Db } from "../types.js";

export type DeviceDoctorRunState = "pending" | "running" | "complete" | "failed";

export interface DeviceDoctorRun {
  deviceId: DeviceId;
  runId: string;
  state: DeviceDoctorRunState;
  requestedAt: string;
  startedAt: string | null;
  deadlineAt: string | null;
  completedAt: string | null;
  detail: string | null;
  reportJson: string | null;
}

export interface BeginDeviceDoctorRunInput {
  deviceId: DeviceId;
  runId: string;
  requestedAt: string;
}

export interface StartDeviceDoctorRunInput {
  deviceId: DeviceId;
  runId: string;
  startedAt: string;
  deadlineAt: string;
}

export interface RequeueDeviceDoctorRunInput {
  deviceId: DeviceId;
  runId: string;
  detail?: string | null;
  /** A real disconnect pauses the deadline; an online retry preserves it. */
  resetDeadline?: boolean;
}

export interface FailDeviceDoctorRunInput {
  deviceId: DeviceId;
  runId: string;
  completedAt: string;
  detail: string;
  /** Optional timer fence: fail only the run incarnation using this deadline. */
  expectedDeadlineAt?: string;
}

export interface CompleteDeviceDoctorRunInput {
  deviceId: DeviceId;
  runId: string;
  completedAt: string;
  detail?: string | null;
  reportJson: string;
}

interface StoredDeviceDoctorRun {
  device_id: string;
  run_id: string;
  state: DeviceDoctorRunState;
  requested_at: string;
  started_at: string | null;
  deadline_at: string | null;
  completed_at: string | null;
  detail: string | null;
  report_json: string | null;
}

const SELECT_COLUMNS = `
  device_id, run_id, state, requested_at, started_at, deadline_at, completed_at, detail, report_json
`;

export function createDeviceDoctorRunsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_doctor_runs (
      device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'complete', 'failed')),
      requested_at TEXT NOT NULL,
      started_at TEXT,
      deadline_at TEXT,
      completed_at TEXT,
      detail TEXT,
      report_json TEXT
    )
  `);
}

function rowToDeviceDoctorRun(row: StoredDeviceDoctorRun): DeviceDoctorRun {
  return {
    deviceId: DeviceId(row.device_id),
    runId: row.run_id,
    state: row.state,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    deadlineAt: row.deadline_at,
    completedAt: row.completed_at,
    detail: row.detail,
    reportJson: row.report_json,
  };
}

export function listDeviceDoctorRuns(db: Db): DeviceDoctorRun[] {
  return db
    .prepare<[], StoredDeviceDoctorRun>(
      `SELECT ${SELECT_COLUMNS}
         FROM device_doctor_runs
        ORDER BY requested_at DESC, device_id`,
    )
    .all()
    .map(rowToDeviceDoctorRun);
}

export function getDeviceDoctorRun(db: Db, deviceId: DeviceId): DeviceDoctorRun | null {
  const row = db
    .prepare<
      [string],
      StoredDeviceDoctorRun
    >(`SELECT ${SELECT_COLUMNS} FROM device_doctor_runs WHERE device_id = ?`)
    .get(deviceId);
  return row ? rowToDeviceDoctorRun(row) : null;
}

/**
 * Install a fresh pending run for a device. The one-row-per-device slot may
 * only be replaced after its previous run has settled, and a run id cannot be
 * reused: both rules keep late command responses fenced away from new work.
 */
export function beginDeviceDoctorRun(db: Db, input: BeginDeviceDoctorRunInput): boolean {
  const result = db
    .prepare(
      `INSERT INTO device_doctor_runs (
         device_id, run_id, state, requested_at,
         started_at, deadline_at, completed_at, detail, report_json
       ) VALUES (?, ?, 'pending', ?, NULL, NULL, NULL, NULL, NULL)
       ON CONFLICT(device_id) DO UPDATE SET
         run_id = excluded.run_id,
         state = 'pending',
         requested_at = excluded.requested_at,
         started_at = NULL,
         deadline_at = NULL,
         completed_at = NULL,
         detail = NULL,
         report_json = NULL
       WHERE device_doctor_runs.state IN ('complete', 'failed')
         AND device_doctor_runs.run_id <> excluded.run_id`,
    )
    .run(input.deviceId, input.runId, input.requestedAt);
  return result.changes === 1;
}

/** Claim a pending run for dispatch. */
export function startDeviceDoctorRun(db: Db, input: StartDeviceDoctorRunInput): boolean {
  const result = db
    .prepare(
      `UPDATE device_doctor_runs
          SET state = 'running', started_at = ?,
              deadline_at = COALESCE(deadline_at, ?), detail = NULL
        WHERE device_id = ? AND run_id = ? AND state = 'pending'`,
    )
    .run(input.startedAt, input.deadlineAt, input.deviceId, input.runId);
  return result.changes === 1;
}

/** Return a claimed run to the offline/retry queue. */
export function requeueDeviceDoctorRun(db: Db, input: RequeueDeviceDoctorRunInput): boolean {
  const result = db
    .prepare(
      `UPDATE device_doctor_runs
          SET state = 'pending', started_at = NULL,
              deadline_at = CASE WHEN ? THEN NULL ELSE deadline_at END,
              detail = ?
        WHERE device_id = ? AND run_id = ?
          AND (state = 'running' OR (state = 'pending' AND ?))`,
    )
    .run(
      input.resetDeadline ? 1 : 0,
      input.detail ?? null,
      input.deviceId,
      input.runId,
      input.resetDeadline ? 1 : 0,
    );
  return result.changes === 1;
}

/** Settle either a queued or claimed run as failed. */
export function failDeviceDoctorRun(db: Db, input: FailDeviceDoctorRunInput): boolean {
  const result = db
    .prepare(
      `UPDATE device_doctor_runs
          SET state = 'failed', completed_at = ?, detail = ?, report_json = NULL
        WHERE device_id = ? AND run_id = ? AND state IN ('pending', 'running')
          AND (? IS NULL OR deadline_at = ?)`,
    )
    .run(
      input.completedAt,
      input.detail,
      input.deviceId,
      input.runId,
      input.expectedDeadlineAt ?? null,
      input.expectedDeadlineAt ?? null,
    );
  return result.changes === 1;
}

/** Persist the final report only for the run that still owns the device slot. */
export function completeDeviceDoctorRun(db: Db, input: CompleteDeviceDoctorRunInput): boolean {
  const result = db
    .prepare(
      `UPDATE device_doctor_runs
          SET state = 'complete', completed_at = ?, detail = ?, report_json = ?
        WHERE device_id = ? AND run_id = ? AND state IN ('pending', 'running')`,
    )
    .run(input.completedAt, input.detail ?? null, input.reportJson, input.deviceId, input.runId);
  return result.changes === 1;
}
