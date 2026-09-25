// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Message contract between `BackupService` and `backup-worker.ts` (#57).
 *
 * The worker is one-shot: it receives its full work list via `workerData`
 * (no request/response loop), streams one `begin` + `file` pair per
 * completed item, and finishes with a single `done` or `error`.
 */

/** One SQLite store to snapshot via `VACUUM INTO`. */
export interface BackupVacuumJob {
  /** Absolute path of the live database file. */
  sourcePath: string;
  /** Absolute path the vacuumed copy is written to (must not exist yet). */
  destPath: string;
  /** Hex-encoded SQLite storage key, when the source store is encrypted. */
  keyHex?: string;
  /** Display name reported in progress messages (e.g. `omnesis.db`). */
  name: string;
}

/** One config file (or directory, copied recursively) to mirror as-is. */
export interface BackupCopyJob {
  from: string;
  to: string;
  /** Display name reported in progress messages (e.g. `omnesis.json`). */
  name: string;
}

export interface BackupWorkerInput {
  vacuums: BackupVacuumJob[];
  copies: BackupCopyJob[];
}

export type BackupWorkerMessage =
  | { type: "begin"; file: string }
  | { type: "file"; file: string; bytes: number; durationMs: number }
  | { type: "done" }
  | { type: "error"; error: string };
