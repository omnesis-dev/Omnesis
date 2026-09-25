// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The journal half of the watch runtime, hosted inside the gateway.
 *
 * The package it hosts is standalone by design — `@omnesis/watch` imports
 * nothing from here, so the language and the engine can be proven against a
 * fixture universe rather than against a running install. Everything the
 * gateway knows enters that package as data. This module is the adapter that
 * turns one into the other: it subscribes to the bus, owns the journal, and
 * registers the drain as a scheduler task.
 *
 * It only writes. Nothing here decides anything or reaches anyone: the drain
 * turns bus traffic into journal events, and `engine-task.ts` — a separate
 * task on a separate connection to the same file — is what reads them,
 * evaluates watches and delivers what fires. The split is why this one can be
 * described as ingestion and mean it.
 *
 * Gated on `experimentalEnabled` rather than `experimentalVisible`: the latter
 * also lights up under synthetic mode, which is for surfaces a demo should
 * show, and switching it on for every synthetic gateway would put a two-second
 * main-thread task into timing-sensitive test lanes for no observable gain.
 */

import { createLogger, experimentalEnabled, type Logger } from "@omnesis/core";
import { getSourceDocumentProfile } from "../data/repositories/SourceDocumentProfileRepository.js";
import { Materializer, type DrainResult, type JournalTableSchema } from "./materializer.js";
import { capture, MaterializerQueue } from "./queue.js";
import { isReplayingHistory, type SyncPhaseSignals } from "./replaying-history.js";
import { WatchJournalStore } from "./store.js";
import { WriteLease } from "./write-lease.js";
import type { AnalyticsDb } from "../analytics-db.js";
import type { WatchOutboxStats } from "../analytics/watch-outbox-store.js";
import type { Db } from "../data/types.js";
import type { EventBus } from "../events.js";
import type { PeriodicTask, TaskOutcome } from "../scheduler/types.js";

const log: Logger = createLogger("gateway").child("watch-v2");
const OUTBOX_RETENTION_MS = 48 * 60 * 60 * 1_000;
const OUTBOX_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

export interface WatchV2Tunables {
  /** Drain cadence while events are arriving. */
  readonly drainIntervalMs?: number;
  /** Drain cadence when there is nothing to do. */
  readonly idleIntervalMs?: number;
  /** Journal events written, and queue entries examined, per drain. */
  readonly batchSize?: number;
  /** How many captured document events may wait in memory for the drain. */
  readonly queueCapacity?: number;
}

export interface WatchV2HostOptions {
  /**
   * The journal, already settled on its path.
   *
   * Passed in rather than derived here so exactly one place decides where the
   * file is — and so the boot that decides has already dealt with an install
   * whose journal is still under the old name.
   */
  readonly journalPath: string;
  readonly db: Db;
  readonly indexDb: Db | null;
  readonly analyticsDb: AnalyticsDb | null;
  readonly bus: EventBus;
  readonly signals: SyncPhaseSignals;
  /** The journal's own storage key, or null on a plaintext install. */
  readonly storageKey: Buffer | null;
  readonly tunables?: WatchV2Tunables;
  /** Overridable so a test can drive the gate without setting an env var. */
  readonly enabled?: () => boolean;
}

export interface WatchV2Host {
  readonly store: WatchJournalStore;
  readonly queue: MaterializerQueue;
  readonly task: PeriodicTask<unknown, DrainResult>;
  /**
   * Whose turn it is to write the journal. Handed to the runtime that reads
   * this journal, which writes the same file from its own task.
   */
  readonly writes: WriteLease;
  outboxStats(): Promise<WatchOutboxStats | null>;
  stop(): void;
}

/**
 * Wire the subsystem, or don't.
 *
 * `null` when the gate is off, and the Watch host creates no file, bus
 * subscription, or task. AnalyticsDb reserves its empty internal outbox table
 * independently so consumed retention can still be cleaned while Watch is off.
 */
export function startWatchV2(options: WatchV2HostOptions): WatchV2Host | null {
  const enabled = options.enabled ?? experimentalEnabled;
  if (!enabled()) return null;

  const tunables = options.tunables ?? {};
  const store = WatchJournalStore.open(options.journalPath, options.storageKey);
  const queue = new MaterializerQueue(tunables.queueCapacity);
  const writes = new WriteLease();
  const schemas = new Map<string, JournalTableSchema | null>();

  const materializer = new Materializer({
    db: options.db,
    indexDb: options.indexDb,
    store,
    queue,
    analyticsOutbox: options.analyticsDb ?? undefined,
    batchSize: tunables.batchSize,
    tableSchema: async (table) => {
      // Cached: the catalog is a DuckDB read and the drain asks once per table
      // per tick, while a table's declared columns change only when a provider
      // ships a new schema — which restarts the gateway.
      //
      // Only a real answer is cached. A table the catalog does not know yet is
      // not a fact about the table, it is a fact about the moment; caching it
      // would drop every later row of that table, un-deduplicated, for the
      // lifetime of the process.
      const cached = schemas.get(table);
      if (cached !== undefined) return cached;
      const entry = (await options.analyticsDb?.getRecordTableSchema(table)) ?? null;
      if (!entry) return null;
      const schema: JournalTableSchema = {
        columns: entry.columns,
        primaryKey: entry.primaryKey,
        semanticTimeColumn: entry.semanticTimeColumn,
      };
      schemas.set(table, schema);
      return schema;
    },
    documentProfile: (sourceType) => getSourceDocumentProfile(options.db, sourceType),
  });

  // Both handlers reduce the event to the fields the drain needs and append.
  // No read, no hash, no allocation beyond the captured record — the bus runs
  // them synchronously on the main thread right after the writer commits, so
  // every instruction here is on the ingest path.
  const unsubscribeDocuments = options.bus.on("document.upserted", (event) => {
    queue.pushDocument(capture(event, Date.now()));
  });
  options.analyticsDb?.enableWatchOutbox((sourceId) =>
    isReplayingHistory(options.signals, sourceId),
  );

  let reportedDrops = 0;
  let lastOutboxPrune = 0;
  const task: PeriodicTask<unknown, DrainResult> = {
    name: "watchV2.materialize.tick",
    runner: "main",
    priority: "background",
    periodMs: tunables.drainIntervalMs ?? 2_000,
    idlePeriodMs: tunables.idleIntervalMs ?? 15_000,
    startDelayMs: tunables.drainIntervalMs ?? 2_000,
    initialArgs: undefined,
    isIdle: (result) => result.idle,
    async run(): Promise<TaskOutcome<unknown, DrainResult>> {
      const started = Date.now();
      try {
        // DuckDB reads and JSON decoding do not need the Watch writer. Doing
        // them first keeps the single SQLite write turn short.
        const beforeOutboxCursor = materializer.outboxCursor();
        const analyticsBatch = await materializer.loadAnalyticsBatch();
        // The runtime writes this file from its own task on the same thread.
        // Taking a turn means the one that arrives second awaits rather than
        // blocking the event loop inside SQLite's busy handler.
        const result = await writes.run(() => materializer.drain(analyticsBatch));
        const afterOutboxCursor = materializer.outboxCursor();
        if (
          options.analyticsDb &&
          (afterOutboxCursor.pageSeq !== beforeOutboxCursor.pageSeq ||
            afterOutboxCursor.rowOffset !== beforeOutboxCursor.rowOffset)
        ) {
          await options.analyticsDb.acknowledgeWatchOutbox(afterOutboxCursor.pageSeq);
        }
        if (options.analyticsDb && Date.now() - lastOutboxPrune >= OUTBOX_PRUNE_INTERVAL_MS) {
          const cursor = materializer.outboxCursor();
          await options.analyticsDb.pruneWatchOutbox(
            cursor.pageSeq,
            Date.now() - OUTBOX_RETENTION_MS,
          );
          lastOutboxPrune = Date.now();
        }
        if (!result.idle) {
          log.debug(
            `materialized ${result.documents} doc, ${result.rows} row, ${result.indexed} indexed ` +
              `(${result.deferred} deferred, ${result.pending} queued, ${result.degraded} degraded, ` +
              `${result.droppedRedeliveries} redelivered) in ${Date.now() - started}ms`,
          );
        }
        // Overflow is the one loss nothing downstream repairs for analytics
        // rows, so it is said out loud the moment it happens rather than left
        // in a counter nobody reads.
        const dropped = queue.dropped.documents;
        if (dropped > reportedDrops) {
          log.warn(
            `journal queue overflowed: ${queue.dropped.documents} document(s) dropped since boot — ` +
              `the drain is behind`,
          );
          reportedDrops = dropped;
        }
        return { kind: "done", value: result };
      } catch (err) {
        log.warn(`materializer drain failed: ${err instanceof Error ? err.message : String(err)}`);
        // Idle on failure so a persistent fault backs off instead of spinning
        // the main thread every two seconds, rather than because there is
        // nothing to do — the batch went back to the queue and the next tick
        // will find it. The counts are zero because this drain accomplished
        // nothing, not because nothing was pending.
        return {
          kind: "done",
          value: {
            documents: 0,
            rows: 0,
            indexed: 0,
            recovered: 0,
            deferred: 0,
            pending: 0,
            degraded: 0,
            droppedRedeliveries: 0,
            idle: true,
          },
        };
      }
    },
  };

  log.info("watch journal active — recording events for the runtime to evaluate");

  return {
    store,
    queue,
    task,
    writes,
    outboxStats: () =>
      options.analyticsDb
        ? options.analyticsDb.watchOutboxStats(materializer.outboxCursor())
        : Promise.resolve(null),
    stop: () => {
      unsubscribeDocuments();
      options.analyticsDb?.disableWatchOutbox();
      store.close();
    },
  };
}
