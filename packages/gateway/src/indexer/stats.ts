// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The `/index/stats` payload, computed from the index and gateway
 * databases.
 *
 * This lives apart from the route so more than one surface can ask for it:
 * `GET /index/stats` serves it to the portal, and the doctor folds the same
 * numbers into its index checks. Sharing the computation rather than
 * re-deriving it is what keeps the two from drifting — a backlog percentage
 * the Debug page shows and a backlog warning the doctor raises are then
 * necessarily the same measurement.
 *
 * The four return shapes are a progression, not variants: no model file, no
 * index database, a worker still coming up, and finally the full running
 * figures. Callers branch on `state`.
 */

import { computeEtaSeconds } from "../workers/indexer-rate.js";
import {
  getIndexStatsBySource,
  getIndexDateRangeBySource,
  getIndexErrorCountsBySource,
  getDegradedStatsBySource,
  getIndexedDocumentCount,
  getChunkCount,
  getWatermark,
  getIndexGenerationStatus,
} from "./db.js";
import { configMaxAgeResolver, indexableCountsBySource } from "./indexable-documents.js";
import { computeIndexingProgress } from "./indexing-progress.js";
import { readScanProgressView, type ScanProgressView } from "./scan-progress.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { SemanticSearchStatus } from "@omnesis/source-sdk";
import type { ConfigStore } from "../config-store.js";
import type { IndexerModelInfo } from "./indexer-lifecycle.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface IndexStatsDeps {
  db: Db;
  indexDb?: Db;
  configStore?: ConfigStore;
  config?: OmnesisConfig;
  indexerModel?: IndexerModelInfo;
  getIndexRate?: () => number | null;
  indexerReadiness?: () => {
    status: string;
    message?: string;
    reason?: string;
    keywordIndexingActive?: boolean;
  };
  /** The HNSW graph's state against the memory budget; null before the worker reports. */
  getSemanticSearch?: () => SemanticSearchStatus | null;
}

/** Per-source index progress. */
interface IndexSourceStats {
  indexedDocs: number;
  gatewayDocs: number;
  chunks: number;
  percentIndexed: number;
  indexErrors: number;
  degradedDocs: number;
  truncatedChunks: number;
  droppedChunks: number;
  earliestIndexedDate: string | null;
  latestIndexedDate: string | null;
}

export interface IndexStatsPayload {
  enabled: boolean;
  keywordIndexingActive?: boolean;
  state: "model-missing" | "disabled" | "spawning" | "running";
  model?: IndexerModelInfo | null;
  totalIndexed?: number;
  totalIndexErrors?: number;
  percentIndexed?: number;
  totalChunks?: number;
  totalGatewayDocs?: number;
  totalDegraded?: number;
  totalTruncatedChunks?: number;
  totalDroppedChunks?: number;
  watermark?: string | null;
  indexRatePerSec?: number | null;
  etaSeconds?: number | null;
  /**
   * The indexing scan in progress, read from its durable record: where its
   * cursor is, how fast the current run is going and what pace it is on.
   * Null when no scan spans more than one page.
   */
  scan?: ScanProgressView | null;
  indexVersions?: ReturnType<typeof getIndexGenerationStatus>;
  semanticSearch?: SemanticSearchStatus;
  bySource?: Record<string, IndexSourceStats>;
}

/**
 * Read the current index figures. Synchronous and DB-bound: it issues
 * several reads against the index database plus, at most once a minute, one
 * counting query against the main database per source that has a data cutoff.
 */
export function computeIndexStats(deps: IndexStatsDeps): IndexStatsPayload {
  const { db, indexDb, configStore, config, indexerModel, indexerReadiness, getIndexRate } = deps;
  const semanticSearch = deps.getSemanticSearch?.() ?? null;

  const model = indexerModel?.disabled ? null : indexerModel;
  const keywordIndexingActive = indexerReadiness?.().keywordIndexingActive === true;
  if (model && !model.present) {
    return {
      enabled: false,
      state: "model-missing",
      model,
      ...(keywordIndexingActive && indexDb
        ? {
            keywordIndexingActive: true,
            totalIndexed: getIndexedDocumentCount(indexDb),
            totalChunks: getChunkCount(indexDb),
          }
        : {}),
    };
  }
  if (!indexDb) {
    return {
      enabled: false,
      state: "disabled",
      model: model ?? null,
    };
  }

  // Surface the spawning/loading-model state so the portal can
  // show "Starting..." instead of a misleading 0% progress bar.
  const readiness = indexerReadiness?.();
  if (readiness && (readiness.status === "spawning" || readiness.status === "loading-model")) {
    // Still return the index-side numbers (they're valid — just
    // stale from before the worker started) so the portal can
    // render partial progress if it chooses.
    const totalIndexed = getIndexedDocumentCount(indexDb);
    const totalChunks = getChunkCount(indexDb);
    return {
      enabled: true,
      state: "spawning",
      model: indexerModel ?? null,
      totalIndexed,
      totalIndexErrors: 0,
      percentIndexed: 0,
      totalChunks,
      totalGatewayDocs: 0,
      watermark: getWatermark(indexDb, "last_updated_at"),
      indexVersions: getIndexGenerationStatus(indexDb),
      ...(semanticSearch ? { semanticSearch } : {}),
      bySource: {},
    };
  }

  const bySource = getIndexStatsBySource(indexDb);
  const indexDateRanges = getIndexDateRangeBySource(indexDb);
  const indexErrorCounts = getIndexErrorCountsBySource(indexDb);
  const degradedStats = getDegradedStatsBySource(indexDb);
  const totalIndexed = getIndexedDocumentCount(indexDb);
  const totalChunks = getChunkCount(indexDb);
  const watermark = getWatermark(indexDb, "last_updated_at");

  const liveStatsConfig = configStore?.get() ?? config ?? {};
  const fullCounts: Record<string, number> = {};
  for (const row of db
    .prepare<[], { source_id: string; count: number }>(
      "SELECT source_id, doc_count AS count FROM source_stats",
    )
    .all()) {
    fullCounts[row.source_id] = row.count;
  }
  // Only documents the retention cutoff leaves in scope are work the indexer
  // is expected to do — the same population `reindexMissing` compares against
  // the index, contacts exempt as at the ingest boundary. The excluded part
  // is the cached figure `/status` also reads.
  const gatewaySourceCounts = indexableCountsBySource(
    db,
    fullCounts,
    configMaxAgeResolver(liveStatsConfig),
  );

  const totalGatewayDocs = Object.values(gatewaySourceCounts).reduce((a, b) => a + b, 0);

  const sources: Record<string, IndexSourceStats> = {};

  const allSourceIds = new Set([
    ...Object.keys(bySource),
    ...Object.keys(gatewaySourceCounts),
    ...Object.keys(indexErrorCounts),
    ...Object.keys(degradedStats),
  ]);

  let totalDegraded = 0;
  let totalTruncatedChunks = 0;
  let totalDroppedChunks = 0;

  for (const sourceId of allSourceIds) {
    const indexed = bySource[sourceId]?.indexedDocs ?? 0;
    const gateway = gatewaySourceCounts[sourceId] ?? 0;
    const errored = indexErrorCounts[sourceId] ?? 0;
    const dateRange = indexDateRanges[sourceId];
    const degraded = degradedStats[sourceId];
    totalDegraded += degraded?.docs ?? 0;
    totalTruncatedChunks += degraded?.truncatedChunks ?? 0;
    totalDroppedChunks += degraded?.droppedChunks ?? 0;
    sources[sourceId] = {
      indexedDocs: indexed,
      gatewayDocs: gateway,
      chunks: bySource[sourceId]?.chunks ?? 0,
      // Terminally-errored docs count as "done" so a source fully attempted
      // reads 100% rather than stalling below it forever on un-embeddable
      // docs; the failures stay visible in `indexErrors`.
      percentIndexed: computeIndexingProgress(indexed, errored, gateway).percent,
      indexErrors: errored,
      degradedDocs: degraded?.docs ?? 0,
      truncatedChunks: degraded?.truncatedChunks ?? 0,
      droppedChunks: degraded?.droppedChunks ?? 0,
      earliestIndexedDate: dateRange?.earliest ?? null,
      latestIndexedDate: dateRange?.latest ?? null,
    };
  }

  // Server-side ETA. The indexer worker tracks a rolling docs/sec rate
  // across cycles (survives portal refreshes); we turn it plus the
  // remaining backlog into an ETA here so the portal renders it on
  // first load with no client-side warm-up. Both fields are null when
  // the rate is unknown or there's nothing left to index.
  // A scan in progress reports its own rate from its durable record, which
  // exists from its first page; the cycle rate needs completed cycles, and a
  // catch-up scan is one cycle that can run for hours, so the last cycle's
  // rate would be stale or absent all that time.
  const scan = readScanProgressView(indexDb);
  const indexRatePerSec = scan?.indexedPerSec ?? getIndexRate?.() ?? null;
  const totalIndexErrors = Object.values(indexErrorCounts).reduce((a, b) => a + b, 0);
  // Errored docs are terminal, not backlog: fold them into "done" so the
  // overall percent reaches 100% and the ETA reaches zero once the indexer
  // has caught up, instead of stalling a hair under 100% (and reporting
  // phantom time) forever on the handful it can never embed. This is the
  // single authoritative overall figure — clients render it rather than each
  // recomputing indexed/total and dropping the errored docs.
  const overall = computeIndexingProgress(totalIndexed, totalIndexErrors, totalGatewayDocs);
  const etaSeconds = computeEtaSeconds(overall.remaining, indexRatePerSec);

  return {
    enabled: true,
    state: "running",
    ...(keywordIndexingActive ? { keywordIndexingActive: true } : {}),
    model: model ?? null,
    totalIndexed,
    totalIndexErrors,
    percentIndexed: overall.percent,
    totalChunks,
    totalGatewayDocs,
    totalDegraded,
    totalTruncatedChunks,
    totalDroppedChunks,
    watermark,
    indexRatePerSec,
    etaSeconds,
    scan,
    indexVersions: getIndexGenerationStatus(indexDb),
    ...(semanticSearch ? { semanticSearch } : {}),
    bySource: sources,
  };
}
