// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceSyncMeta } from "./gateway-client.js";
import type { StructuredSyncResult, DocumentTemporalProjectionSpec } from "./structured-source.js";

/** Exact source output retained until both database planes and snapshots finish. */
export interface PendingStructuredPage {
  id: string;
  result: StructuredSyncResult;
  meta?: Omit<SourceSyncMeta, "contentRetention">;
  documentTemporalProjections?: DocumentTemporalProjectionSpec[];
  /**
   * The output revision of the source build that produced `result`. Stored
   * with the page so a replay after the host was upgraded still commits the
   * documents under the revision that wrote them.
   */
  sourceVersion?: number;
  cursorCommitted: boolean;
}

export type PrepareStructuredPage = Omit<PendingStructuredPage, "cursorCommitted"> & {
  writeEpoch: number;
};
