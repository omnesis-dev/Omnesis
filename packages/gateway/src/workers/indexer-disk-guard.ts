// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-cycle low-disk gate for the indexer worker (#15).
 *
 * An indexing cycle embeds + writes chunks into index.db and flushes the
 * usearch HNSW file. Under low disk those writes risk a partial / corrupting
 * flush, so the worker skips the cycle entirely — the unindexed docs stay
 * pending and the next wake retries once disk frees (automatic resume).
 *
 * Extracted as a pure decision so it can be unit-tested without spawning the
 * worker thread.
 */

import { hasFreeDiskSpace } from "../disk-guard.js";

export interface IndexCycleDiskDecision {
  /** True when the cycle may run; false when it must be skipped. */
  shouldRun: boolean;
  /** Bytes free on the index.db volume at decision time. */
  freeBytes: number;
}

/**
 * Decide whether an indexing cycle may run given the free disk on
 * `indexDbPath`'s volume and the configured `minFreeMb` floor. A
 * non-positive `minFreeMb` disables the gate (always runs).
 */
export function shouldRunIndexCycle(
  indexDbPath: string,
  minFreeMb: number,
  check: (
    path: string,
    minFreeBytes: number,
  ) => { ok: boolean; freeBytes: number } = hasFreeDiskSpace,
): IndexCycleDiskDecision {
  if (minFreeMb <= 0) return { shouldRun: true, freeBytes: Infinity };
  const { ok, freeBytes } = check(indexDbPath, minFreeMb * 1024 * 1024);
  return { shouldRun: ok, freeBytes };
}
