// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What this source persists between runs.
 *
 * The cursor carries one entry per tracked file — a map that grows with the
 * corpus and is rewritten every page — so the shape it is stored in is worth
 * stating rather than assuming. Declaring it means the host checks the stored
 * value once, before `sync` runs, instead of the source re-deriving "is this
 * mine?" on every page for the life of the install.
 *
 * A value that does not decode is treated as a first run: the file map is a
 * cache of what the disk already holds, so rebuilding it costs a rescan and
 * loses nothing. That is why this rebootstraps rather than parking the source
 * for the operator to deal with.
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { LocalFileState, LocalFilesSyncCursor } from "./types.js";

export const LOCAL_FILES_STATE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileState(value: unknown): value is LocalFileState {
  if (!isRecord(value)) return false;
  return (
    typeof value.mtime === "number" &&
    typeof value.contentHash === "string" &&
    typeof value.rawHash === "string" &&
    typeof value.size === "number" &&
    typeof value.inode === "number" &&
    typeof value.device === "number" &&
    typeof value.stableId === "string" &&
    (value.partitionKey === undefined || typeof value.partitionKey === "string")
  );
}

export const localFilesStateSpec: SourceStateSpec<LocalFilesSyncCursor> = {
  version: LOCAL_FILES_STATE_VERSION,

  /**
   * Accepts a mid-cycle cursor as well as a settled one. A page that reports
   * `hasMore` carries the queue total it pinned, and rejecting that shape
   * would make the host store the value unwrapped — which reads as a first
   * run on the very next page, restarting the cycle it was in the middle of.
   */
  decode(value: unknown): LocalFilesSyncCursor | null {
    if (!isRecord(value)) return null;
    if (value.version !== LOCAL_FILES_STATE_VERSION) return null;
    if (!isRecord(value.fileMap) || !Object.values(value.fileMap).every(isFileState)) return null;
    if (value.cycleQueueTotal !== undefined && typeof value.cycleQueueTotal !== "number") {
      return null;
    }
    return value as unknown as LocalFilesSyncCursor;
  },

  onUnreadable: "rebootstrap",
};
