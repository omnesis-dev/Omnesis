// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared backpressure detector for scheduler tasks.
 *
 * `isBackpressure(err)` returns true when `err` represents transient
 * writer-queue or SQLite contention that the caller should treat as
 * "skip this tick, retry next interval" rather than a hard failure.
 *
 * Patterns covered:
 *   - `SchedulerQueueFullError` instance (writer/compute queue cap hit)
 *   - "queue full" message substring (cross-process surface of the above)
 *   - "SQLITE_BUSY" message substring (busy_timeout exhausted)
 *   - "database is locked" message substring (SQLite's human-readable
 *     form of the same condition on some paths)
 */

import { SchedulerQueueFullError } from "./types.js";

export function isBackpressure(err: unknown): boolean {
  if (err instanceof SchedulerQueueFullError) return true;
  if (err instanceof Error) {
    if (err.message.includes("queue full")) return true;
    if (err.message.includes("SQLITE_BUSY")) return true;
    if (err.message.includes("database is locked")) return true;
  }
  return false;
}
