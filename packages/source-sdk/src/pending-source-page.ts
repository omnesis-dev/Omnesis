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
  cursorCommitted: boolean;
}

export type PrepareStructuredPage = Omit<PendingStructuredPage, "cursorCommitted"> & {
  writeEpoch: number;
};
