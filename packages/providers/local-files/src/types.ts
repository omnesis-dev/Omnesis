// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Sync state for the Local Files source.
 *
 * Paths are absolute (independent of root ordering); the `stableId` is the
 * externalId emitted to the gateway so renames and moves don't churn the
 * corpus. Identity ladder mirrors Obsidian: a just-vanished file with a
 * matching `(rawHash, size)` is a pure move, a matching inode is a
 * rename-plus-edit, otherwise `ino:<dev>:<ino>`.
 */
export interface LocalFileState {
  mtime: number;
  contentHash: string;
  /**
   * Hash of the raw extracted text (not the rendered wrapper, which embeds
   * the display path). Rename detection matches on this: a pure move leaves
   * the bytes — and this hash — unchanged. Empty for terminally skipped
   * files, which never match by hash (only by inode).
   */
  rawHash: string;
  size: number;
  inode: number;
  device: number;
  stableId: string;
  /** Partition stamped on the last emitted document; absent on installed legacy state. */
  partitionKey?: string;
  /**
   * Terminal skip recorded so the file leaves the sync queue: `too-large`,
   * `no-text`, `unextractable`, `unreadable`. Retried when the file changes
   * or the skip ages past SKIP_RETRY_MS. Absent for indexed files.
   */
  skipped?: string;
  /** Wall-clock ms when the skip was recorded. */
  skippedAt?: number;
}

/** A terminally skipped file is retried after this long (config may change). */
export const SKIP_RETRY_MS = 24 * 60 * 60 * 1000;

export interface LocalFilesSyncCursor {
  version: 1;
  fileMap: Record<string, LocalFileState>;
  /**
   * Queue size pinned on the first page of a cycle so progress stays stable
   * across pages. Cleared when the cycle ends with `hasMore: false`.
   */
  cycleQueueTotal?: number;
  /**
   * Documents emitted so far this cycle, so progress reports a running
   * total rather than the current page's count. Cleared with
   * `cycleQueueTotal` when the cycle ends.
   */
  cycleProcessed?: number;
  // Paging slices the recomputed queue from zero: every attempted file is
  // either indexed or recorded as skipped, so resolved files leave the
  // queue and each page advances. No offset is needed.
  [key: string]: unknown;
}

export interface LocalFileEntry {
  /** Absolute, symlink-resolved path. */
  absolutePath: string;
  /** Display path, home-relative (`~/Documents/…`) when under home. */
  displayPath: string;
  /** Root-relative directory segments, for tags. */
  dirSegments: string[];
  mimeType: string;
  via: "text" | "extract";
  mtime: number;
  ctime: number;
  size: number;
  inode: number;
  device: number;
}
