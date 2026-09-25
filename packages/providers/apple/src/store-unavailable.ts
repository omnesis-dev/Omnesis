// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  SnapshotEnumeration,
  emptySync,
  type SyncCursor,
  type SyncResult,
} from "@omnesis/source-sdk";

/** A missing local store is unknown, not an observation of an empty store. */
export function unavailableStorePage<TCursor extends SyncCursor>(
  cursor: TCursor,
): SyncResult<TCursor> {
  return {
    ...emptySync(cursor),
    issues: [
      new SnapshotEnumeration(["store"])
        .gap("store", "the local store is unavailable")
        .withheldIssue()!,
    ],
  };
}
