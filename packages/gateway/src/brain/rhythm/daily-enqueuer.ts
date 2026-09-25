// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The daily enqueuer — one pass of the daily rhythm. When the stored
 * last-run day is behind the most recent daily boundary (default 5am,
 * gateway local time), it enqueues:
 *
 *   - one `daily` batch run per source that produced high-throughput
 *     structured data during the previous boundary-to-boundary day,
 *     payload = source id + date range only. A source qualifies if it
 *     produced sample-typed or rolling-aggregate DOCUMENTS (the ones the
 *     real-time waker defers here — see `waker/eligibility.ts`) OR analytics
 *     SAMPLES (health, financial samples — rows in the analytics store,
 *     never documents).
 *     The two sets are unioned, so a source whose day's entire output was
 *     analytics-only still gets its batch (the frozen spec's trigger 2:
 *     "Apple health, Google health, and financial samples").
 *
 * The day-ahead lookahead is NOT here: it is a system sweep (`may-day`) on a
 * 24-hour cadence, so it is retimed, silenced or forked like any other sweep
 * rather than being welded to the batch pass.
 *
 * Every enqueue carries a day-scoped dedupe key, so a crash between the
 * enqueues and the marker write (or a restart replaying the pass) folds
 * into the existing pending rows instead of double-enqueueing. The
 * marker is written LAST — if an enqueue fails the pass retries on the
 * next tick.
 *
 * Discovery is by the datum's OWN (semantic) timestamp on both planes —
 * `source_created_at` for documents, the table's `semanticTimeColumn` for
 * samples — never ingest time, so a source is batched for the day its data
 * belongs to. After downtime the due-gate fires once, for the most recent
 * boundary only — never once per missed day. A late-synced sample (ingested
 * after its day's boundary already fired) is therefore NOT retro-batched;
 * like a late-synced document, it is left to the prompts' backlog rule and
 * remains reachable by the agent through search. Health and financial
 * samples ride on exactly the same footing as transaction/activity docs.
 */

import { WAKER_DAILY_BATCH_DOC_TYPES } from "../waker/eligibility.js";
import { dailySourceRunDedupeKey, type CognitionDailyRunPayload } from "../run-payloads.js";
import {
  getCognitionEngineState,
  COGNITION_DAILY_LAST_RUN_DAY_KEY,
} from "../storage/engine-state.js";
import { mostRecentDailyBoundary } from "./daily-boundary.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { EnqueueCognitionRunInput, EnqueueCognitionRunResult } from "../storage/run-queue.js";
import type { Clock } from "../storage/types.js";

type Db = Database.Database;

/** The write-gate slice the enqueuer mutates through. */
export interface DailyEnqueuerWriteOps {
  enqueueCognitionRun(
    input: EnqueueCognitionRunInput,
    now: number,
  ): Promise<EnqueueCognitionRunResult>;
  setCognitionEngineState(key: string, value: string): Promise<void>;
}

export interface DailyEnqueuerDeps {
  db: Db;
  writeGate: DailyEnqueuerWriteOps;
  clock: Clock;
  getDailyRunHour: () => number;
  log: Logger;
  /**
   * Sources whose analytics store held samples with a semantic timestamp
   * in `[fromMs, toMs)` — the analytics plane of daily-batch discovery.
   * Unioned with the document-derived sources. Omitted = document-only
   * discovery (the unit tests that don't wire an analytics store).
   */
  listAnalyticsSampleSourceIds?: (fromMs: number, toMs: number) => Promise<string[]>;
  idGen?: () => string;
}

export interface DailyEnqueuePassResult {
  /** False = the boundary's day was already handled (the common tick). */
  fired: boolean;
  /** Sources a `daily` batch run was enqueued for. */
  sourceIds: string[];
}

/**
 * Sources that produced daily-batch-bound documents inside [fromMs, toMs)
 * by source timestamp — the sample-typed documents the waker defers
 * (`WAKER_DAILY_BATCH_DOC_TYPES`) OR documents carrying the generic
 * `metadata.rollingAggregate` marker (a continuously-rewritten local summary
 * the waker also routes here instead of waking per edit). Generic by
 * construction — the signals are the document type and a metadata flag, never
 * a source name. (`json_extract` returns SQLite integer 1 for a JSON `true`.)
 */
function listDailyBatchSourceIds(db: Db, fromMs: number, toMs: number): string[] {
  const types = [...WAKER_DAILY_BATCH_DOC_TYPES];
  const typePlaceholders = types.map(() => "?").join(", ");
  return db
    .prepare<string[], { source_id: string }>(
      `SELECT DISTINCT source_id FROM documents
       WHERE (json_extract(metadata, '$.documentType') IN (${typePlaceholders})
              OR json_extract(metadata, '$.rollingAggregate') = 1)
         AND source_created_at >= ? AND source_created_at < ?
       ORDER BY source_id`,
    )
    .all(...types, new Date(fromMs).toISOString(), new Date(toMs).toISOString())
    .map((r) => r.source_id);
}

/** One due-gated pass. Called from the rhythm task each tick. */
export async function runDailyEnqueuePass(
  deps: DailyEnqueuerDeps,
): Promise<DailyEnqueuePassResult> {
  const now = deps.clock();
  const boundary = mostRecentDailyBoundary(now, deps.getDailyRunHour());
  const lastRunDay = getCognitionEngineState(deps.db, COGNITION_DAILY_LAST_RUN_DAY_KEY);
  // Strict `<` (not `!==`): if the machine clock jumps backwards past a
  // day it already ran, stay quiet rather than re-firing that day.
  if (lastRunDay !== null && lastRunDay >= boundary.day) {
    return { fired: false, sourceIds: [] };
  }

  const idGen = deps.idGen ?? (() => crypto.randomUUID());
  // Union the two discovery planes — sample-typed documents and analytics
  // samples — so a source whose day was analytics-only still gets a batch,
  // and a source that produced both gets exactly one (deduped by source id).
  const docSourceIds = listDailyBatchSourceIds(
    deps.db,
    boundary.prevBoundaryMs,
    boundary.boundaryMs,
  );
  const analyticsSourceIds = deps.listAnalyticsSampleSourceIds
    ? await deps.listAnalyticsSampleSourceIds(boundary.prevBoundaryMs, boundary.boundaryMs)
    : [];
  const sourceIds = [...new Set([...docSourceIds, ...analyticsSourceIds])].sort();
  for (const sourceId of sourceIds) {
    const payload: CognitionDailyRunPayload = {
      sourceId,
      dateFrom: new Date(boundary.prevBoundaryMs).toISOString(),
      dateTo: new Date(boundary.boundaryMs).toISOString(),
    };
    await deps.writeGate.enqueueCognitionRun(
      {
        id: `run_${idGen()}`,
        kind: "daily",
        payload,
        dedupeKey: dailySourceRunDedupeKey(sourceId, boundary.day),
      },
      now,
    );
  }

  // Marker last: a crash above replays the pass, and the dedupe keys
  // make the replay fold instead of duplicate.
  await deps.writeGate.setCognitionEngineState(COGNITION_DAILY_LAST_RUN_DAY_KEY, boundary.day);
  deps.log.info(`daily rhythm fired for ${boundary.day}: ${sourceIds.length} source batch(es)`);
  return { fired: true, sourceIds };
}
