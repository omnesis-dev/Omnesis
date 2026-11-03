// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  analyticsClaimNamespace,
  listAnalyticsOmissionCandidates,
} from "../../data/repositories/AnalyticsReplicaClaimRepository.js";
import { listClaimedExternalIds } from "../../data/repositories/ReplicaDeletionClaimRepository.js";
import type { ReadPort } from "../../scheduler/read-port.js";
import type Database from "better-sqlite3";

/**
 * The two replica deletion ledger reads a replicated member's analytics page
 * makes before it writes. The page's own rows are looked up in the ledger, so
 * a page of thousands of rows is thousands of keys read; the gateway runs them
 * on a read worker so an ingest never holds the event loop for them.
 */
export const ANALYTICS_REPLICA_READS = {
  /** Rows `deviceId` keeps alive against another member's deletion; see `listAnalyticsOmissionCandidates`. */
  analyticsOmissionCandidates: listAnalyticsOmissionCandidates,
  /** Of `keyValues`, the rows of one table that have a history in the ledger. */
  analyticsClaimedKeys: (
    db: Database.Database,
    sourceId: string,
    tableName: string,
    keyValues: readonly string[],
  ): string[] =>
    listClaimedExternalIds(db, analyticsClaimNamespace(tableName), sourceId, keyValues),
};

export type AnalyticsReplicaReads = ReadPort<typeof ANALYTICS_REPLICA_READS>;
