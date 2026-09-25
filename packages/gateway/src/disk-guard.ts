// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Low-disk write guard (#15).
 *
 * The gateway must never write under low disk — a partial SQLite write or a
 * truncated usearch flush risks corrupting the store. Two write paths consult
 * this guard before touching disk:
 *
 *   - document ingestion (`DocumentService` → 507 Insufficient Storage; the collector's sync
 *     cursor doesn't advance, so the page is re-sent on its next sync), and
 *   - the indexer cycle (`indexer-worker` → skip the cycle; the unindexed docs
 *     stay pending and the next wake retries them).
 *
 * Both resume automatically once free space climbs back above the threshold,
 * because each is re-evaluated per write attempt / per cycle.
 */

import { freeDiskBytes } from "./system-info.js";

export interface DiskSpaceCheck {
  /** True when free disk meets or exceeds the configured minimum. */
  ok: boolean;
  /** Bytes free on the filesystem containing the checked path. */
  freeBytes: number;
}

/**
 * Check whether the filesystem containing `path` has at least `minFreeBytes`
 * free for a non-root process. A `statfs` failure surfaces as `freeBytes:
 * Infinity` (see `freeDiskBytes`), so a transient probe error reads as `ok`
 * — better to risk one write under a flaky syscall than to wedge ingestion
 * on a false low-disk reading.
 */
export function hasFreeDiskSpace(path: string, minFreeBytes: number): DiskSpaceCheck {
  const freeBytes = freeDiskBytes(path);
  return { ok: freeBytes >= minFreeBytes, freeBytes };
}
