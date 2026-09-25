// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Indexer worker — runs in a Node worker_thread so the embedding model's
 * native inference can't starve the gateway's HTTP event loop.
 *
 * Owns:
 *   - LlamaCppEmbedder (node-llama-cpp, Metal GPU pool)
 *   - Indexer cycle: indexUpdated / reconcileDeletedDocuments / reindexMissing
 *   - Write connection to index.db
 *   - Read connection to the gateway DB (via DirectDocumentSource)
 *
 * Comms with main:
 *   init → ready (after model loads, watermark set)
 *   embedQuery{id,text} → embedQueryResult{id,vector} | embedQueryError{id,err}
 *   heartbeat every N ms so main can detect a wedged worker
 *   shutdown → shutdownComplete (main side calls worker.terminate())
 */

import Database from "better-sqlite3";
type Db = Database.Database;
import { parentPort } from "node:worker_threads";
import { parseDuration } from "@omnesis/core";
import { LlamaCppEmbedder } from "../indexer/embedder.js";
import { Indexer } from "../indexer/indexer.js";
import { DocumentChunker } from "../indexer/chunker.js";
import { DirectDocumentSource } from "../indexer/direct-document-source.js";
import {
  openIndexDb,
  refreshIndexStats,
  getIndexEmbedModel,
  setIndexEmbedModel,
  wipeAndRecreateVectorIndex,
  getWatermark,
  getIndexedDocumentCount,
  deleteIndexBySource,
  deleteChunksByDocumentBatch,
  preparePendingVectorDeletes,
  completePendingVectorDeletes,
  enqueueSourceIndexPurge,
  listPendingSourceIndexPurges,
  completeSourceIndexPurges,
  enqueueDocumentIndexPurge,
  listPendingDocumentIndexPurges,
  completeDocumentIndexPurges,
  getVectorWriteSeq,
  getUsearchSavedSeq,
  setUsearchSavedSeq,
} from "../indexer/db.js";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { computeRatePerSec, type IndexRateSample } from "./indexer-rate.js";
import { shouldRunIndexCycle } from "./indexer-disk-guard.js";
import { applyPendingPurges } from "./pending-source-purges.js";
import { resolveIndexerCutoffMaxAge } from "./protocol.js";
import type {
  IndexerCutoffMap,
  IndexerInit,
  IndexerJobUpdate,
  IndexerWorkerJobId,
  MainToIndexer,
  IndexerToMain,
  LogLevel,
} from "./protocol.js";

if (!parentPort) {
  throw new Error("indexer-worker must be run as a Node worker_thread");
}

function post(msg: IndexerToMain): void {
  parentPort!.postMessage(msg);
}

function log(level: LogLevel, component: string, message: string): void {
  post({ type: "log", level, component, message });
}

/**
 * Emit a job-phase transition for the BackgroundJob registry on main.
 * Cheap structured-clone postMessage; main side stores the latest
 * observation per jobId without polling. See IndexerJobUpdate in
 * `protocol.ts` for field semantics.
 */
function postJobUpdate(
  jobId: IndexerWorkerJobId,
  phase: IndexerJobUpdate["phase"],
  opts: {
    trigger?: IndexerJobUpdate["trigger"];
    stats?: IndexerJobUpdate["stats"];
    error?: string;
  } = {},
): void {
  post({
    type: "jobUpdate",
    jobId,
    ts: Date.now(),
    phase,
    trigger: opts.trigger,
    stats: opts.stats,
    error: opts.error,
  });
}

function openGatewayReadConn(path: string, gatewayDbKeyHex?: string): Db {
  // Gateway DB only holds documents, not the vector index.
  const db = gatewayDbKeyHex
    ? (openEncryptedSqlite(path, {
        key: Buffer.from(gatewayDbKeyHex, "hex"),
        readonly: true,
        fileMustExist: true,
        migratePlaintext: false,
      }) as unknown as Db)
    : new Database(path, { readonly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  // Disable mmap-based reads — see packages/gateway/src/db.ts.
  db.exec("PRAGMA mmap_size = 0");
  return db;
}

function openIndexWriteConn(path: string, indexDbKeyHex?: string): Db {
  // Open index.db with standard pragmas.
  return openIndexDb(path, {
    encryptionKey: indexDbKeyHex ? Buffer.from(indexDbKeyHex, "hex") : null,
    migratePlaintext: false,
  });
}

/**
 * Mutable ref to the active cutoff map. Indexer reads via the closure
 * passed into `getCutoff` so swapping this object hot-reloads the cutoffs
 * without recreating the Indexer.
 */
let currentCutoffs: IndexerCutoffMap = { default: null, perSource: {} };

/** Compute the ISO cutoff for a given sourceId at the time of the call. */
function resolveCutoff(sourceId: string): string | null {
  const maxAge = resolveIndexerCutoffMaxAge(currentCutoffs, sourceId);
  if (!maxAge) return null;
  try {
    return new Date(Date.now() - parseDuration(maxAge)).toISOString();
  } catch {
    return null;
  }
}

/**
 * Rolling history of indexed-document counts, one sample per completed
 * indexing cycle, used to derive a docs-per-second throughput that
 * survives across cycles for the worker's lifetime. Bounded to keep
 * memory trivial: ~10 minutes of recency or 200 samples, whichever is
 * smaller. At one cycle every few seconds under backlog that's plenty to
 * smooth out a stable rate; at the idle cadence the time cutoff prevents
 * a single ancient sample from skewing the figure once indexing resumes.
 */
const RATE_HISTORY_WINDOW_MS = 10 * 60_000;
const RATE_HISTORY_MAX_SAMPLES = 200;
const PENDING_VECTOR_DELETE_BATCH = 512;
const PENDING_DOCUMENT_PURGE_BATCH = 1;
const rateHistory: IndexRateSample[] = [];

type StartupIndexResources = {
  indexDb: Db;
  usearchHandle: import("../indexer/usearch-index.js").UsearchWriteHandle;
};

type DeferredSourceDelete = {
  id: number;
  sourceId: string;
};
type DeferredDocumentDelete = {
  id: number;
  documentId: string;
  limit: number;
  sourceDeleted: boolean;
};

/**
 * The worker owns index.db as soon as init opens it, several awaits before the
 * full indexer state is ready. Keep that ownership visible to message handlers
 * so a source deletion during graph restore/model warmup can run here instead
 * of racing through a main-thread fallback.
 */
let startupIndexResources: StartupIndexResources | null = null;
const deferredSourceDeletes: DeferredSourceDelete[] = [];
const deferredDocumentDeletes: DeferredDocumentDelete[] = [];

/**
 * Record the current absolute indexed count, evict stale/excess samples,
 * and return the freshly-computed docs/sec rate (null until the window
 * has enough signal). Called after each completed cycle. Reads the
 * indexed count the same way /index/stats does (`getIndexedDocumentCount`)
 * so the rate denominator matches the totals the route reports.
 */
function recordRateSample(indexDb: Db): number | undefined {
  const now = Date.now();
  const totalIndexed = getIndexedDocumentCount(indexDb);
  rateHistory.push({ ts: now, totalIndexed });
  const cutoff = now - RATE_HISTORY_WINDOW_MS;
  while (rateHistory.length > 0 && rateHistory[0].ts < cutoff) rateHistory.shift();
  while (rateHistory.length > RATE_HISTORY_MAX_SAMPLES) rateHistory.shift();
  const rate = computeRatePerSec(rateHistory);
  return rate === null ? undefined : rate;
}

let state: {
  embedder: import("../indexer/types.js").Embedder;
  indexer: Indexer;
  gatewayDb: Db;
  indexDb: Db;
  /**
   * Self-rescheduling timeout handles for the three periodic jobs.
   * Replaces the older `setInterval(async () => …)` pattern, which
   * fires on a wallclock cadence regardless of whether the previous
   * async invocation has settled — a pile-up risk when reconcile or
   * reindex-missing exceeds the interval.
   *
   * Each handle holds the timer for the NEXT tick; the current tick
   * (if any) shows up in `inFlightWork`.
   */
  cycleTimer: ReturnType<typeof setTimeout> | null;
  reconcileTimer: ReturnType<typeof setTimeout> | null;
  reindexMissingTimer: ReturnType<typeof setTimeout> | null;
  heartbeatInterval: ReturnType<typeof setInterval>;
  /**
   * Single in-flight gate shared by all three indexer jobs (cycle,
   * reconcile, reindex-missing). They all touch the same `chunks` /
   * `indexed_documents` rows and would race against each other on the
   * single index.db write handle. Holding one Promise here lets each
   * job await any other in-flight work before starting.
   */
  inFlightWork: Promise<unknown> | null;
  /**
   * Sources deleted while an exclusive job was mid-flight. That job may still
   * write chunk / `indexed_documents` rows for documents it read before the
   * delete landed, so the delete is re-applied once it stops. Re-running an
   * idempotent delete afterwards is what lets the delete itself answer
   * immediately instead of waiting for the job to finish. The same ids live
   * in `pending_source_index_purges` until publication succeeds, so this
   * in-memory set can be reconstructed after a restart.
   */
  pendingSourcePurges: Set<string>;
  /**
   * Set to true if a wake arrived while a cycle was already in flight.
   * On cycle completion we fire one more cycle to pick up any docs that
   * landed mid-cycle. Belt-and-suspenders against the Scheduler-side
   * wake debounce missing a trailing wake (it's `coalesceTrailingWake:
   * false` for the indexer wakeable since the Scheduler can't see
   * worker-side cycle completion).
   */
  pendingWake: boolean;
  /**
   * True when the most recent cycle indexed/updated/errored at least one
   * document. The adaptive timer uses this to pick the short (backlog)
   * interval vs. the long (idle) interval for the next tick.
   */
  lastCycleHadWork: boolean;
  shuttingDown: boolean;
  /**
   * Quiesced for a graceful embedder swap (epic #1011). While true the three
   * indexing jobs (cycle / reconcile / reindex-missing) no-op so the `chunks`
   * corpus stays frozen for the swap's catch-up + flip, but the embedder stays
   * loaded and `embedQuery` keeps answering — search remains live under the old
   * model. Cleared by `resumeIndexing` (or implicitly when the worker is later
   * disposed and a fresh one spawns on the new active generation).
   */
  paused: boolean;
  usearchHandle: import("../indexer/usearch-index.js").UsearchWriteHandle;
  /** index.db path + low-disk floor (MB) for the per-cycle write guard (#15). */
  indexDbPath: string;
  minFreeDiskMb: number;
  /** Last wall-clock we logged a low-disk skip, to throttle the warning. */
  lastDiskSkipLogAt: number;
} | null = null;

/** Throttle interval for the repeated "indexing paused: low disk" warning. */
const DISK_SKIP_LOG_THROTTLE_MS = 60_000;

/**
 * Per-cycle low-disk gate (#15). Returns true when the cycle may proceed;
 * false (and logs, throttled) when free disk on the index.db volume is below
 * the configured floor so the cycle should be skipped. Skipped docs stay
 * pending and the next wake retries once disk frees.
 */
function diskOkForCycle(): boolean {
  if (!state) return false;
  const { shouldRun, freeBytes } = shouldRunIndexCycle(state.indexDbPath, state.minFreeDiskMb);
  if (!shouldRun) {
    const now = Date.now();
    if (now - state.lastDiskSkipLogAt > DISK_SKIP_LOG_THROTTLE_MS) {
      state.lastDiskSkipLogAt = now;
      const freeMb = Number.isFinite(freeBytes) ? Math.round(freeBytes / (1024 * 1024)) : freeBytes;
      log(
        "warn",
        "indexer-worker",
        `indexing paused: ${freeMb}MB free < ${state.minFreeDiskMb}MB minimum on the index.db volume — skipping cycle (#15)`,
      );
    }
  }
  return shouldRun;
}

/** Run `body` only when no other indexer job is in flight. The caller's
 *  promise is resolved either way; if a job is already running, body is
 *  skipped (the next tick will catch up). */
async function runExclusive<T>(body: () => Promise<T>): Promise<T | "skipped"> {
  if (!state || state.shuttingDown) return "skipped";
  if (state.inFlightWork) return "skipped";
  const p = body();
  state.inFlightWork = p;
  try {
    return await p;
  } finally {
    if (state) state.inFlightWork = null;
    drainPendingSourcePurges();
  }
}

/**
 * Fire the cycle a wake asked for while an exclusive job held the latch.
 *
 * Every exclusive job — the boot scan, an indexing cycle, reconcile-deleted,
 * reindex-missing — must call this once it releases the latch. A wake that
 * lands during any of them only sets `pendingWake`; without a drain here the
 * documents it announced wait for the next periodic tick, which on an
 * otherwise-idle gateway is a full `cycleInterval` away.
 */
function drainPendingWake(): void {
  if (!state || !state.pendingWake || state.shuttingDown) return;
  state.pendingWake = false;
  void runIndexCycle("wake");
}

/**
 * Publish the worker's in-memory graph for main-thread readers without turning
 * a transient filesystem failure into a half-initialized worker. Dirty handles
 * remain dirty after a failed save, so the next unconditional cycle save can
 * retry.
 */
function trySaveUsearchGraph(context: string): string | null {
  if (!state) return "indexer state unavailable";
  try {
    state.usearchHandle.save();
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "indexer-worker", `${context} HNSW save failed: ${message}`);
    return message;
  }
}

/**
 * Re-apply the deletes that landed while an exclusive job was writing, and
 * persist the result.
 *
 * The delete itself already ran and already answered its caller; this is the
 * pass that removes anything the job wrote for those documents afterwards.
 * `deleteIndexBySource` is idempotent — a source that is already clean deletes
 * nothing and still refreshes its counters — so the common case where the job
 * touched none of them costs one no-op query.
 *
 * Never throws: it also runs in a `finally` that nobody awaits. Callers that
 * are about to publish or start another long phase can use the returned error
 * to stop rather than exposing data from a source whose re-purge is incomplete.
 */
function drainPendingSourcePurges(): string | null {
  if (!state) return null;
  if (state.pendingSourcePurges.size === 0) return drainPendingDocumentPurges();
  const pending = [...state.pendingSourcePurges];
  const { failure } = applyPendingPurges(pending, (sourceId) =>
    deleteIndexBySource(state!.indexDb, sourceId, { usearch: state!.usearchHandle }),
  );
  if (failure) {
    // Retain every id, including ones already re-applied in this pass. Their
    // removals have not been persisted yet, and another long phase must not be
    // allowed to write them back after we forget them.
    state.pendingSourcePurges = new Set(pending);
    const message = `re-applying source-index deletion failed (${pending.length} still pending): ${failure.message}`;
    log("error", "indexer-worker", message);
    return message;
  }
  try {
    state.usearchHandle.save();
    refreshIndexStats(state.indexDb);
    completeSourceIndexPurges(state.indexDb, pending);
    state.pendingSourcePurges.clear();
    return drainPendingDocumentPurges();
  } catch (err) {
    state.pendingSourcePurges = new Set(pending);
    const message = `persisting re-applied source deletions failed: ${err instanceof Error ? err.message : String(err)}`;
    log("error", "indexer-worker", `${message} (${pending.length} still pending)`);
    return message;
  }
}

/**
 * Re-apply one bounded batch per retained document after an exclusive index
 * job. The durable row stays until the authoritative source document is gone,
 * every chunk/summary row is gone, and the HNSW deletion is published.
 */
function drainPendingDocumentPurges(): string | null {
  if (!state) return null;
  const pending = listPendingDocumentIndexPurges(state.indexDb, {
    limit: PENDING_DOCUMENT_PURGE_BATCH,
    sourceDeletedOnly: true,
  });
  if (pending.length === 0) return null;
  const completed: string[] = [];
  try {
    for (const item of pending) {
      const result = deleteChunksByDocumentBatch(
        state.indexDb,
        item.documentId,
        64,
        item.sourceDeleted,
        { usearch: state.usearchHandle },
      );
      if (item.sourceDeleted && result.complete) completed.push(item.documentId);
    }
    if (completed.length === 0) return null;
    const preparedVectorDeletes = preparePendingVectorDeletes(
      state.indexDb,
      state.usearchHandle,
      PENDING_VECTOR_DELETE_BATCH,
    );
    state.usearchHandle.save();
    refreshIndexStats(state.indexDb);
    completePendingVectorDeletes(state.indexDb, preparedVectorDeletes);
    completeDocumentIndexPurges(state.indexDb, completed);
    return null;
  } catch (err) {
    const message = `re-applying document-index retention deletion failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    log("error", "indexer-worker", message);
    return message;
  }
}

/**
 * Re-apply queued privacy deletions before publishing a graph snapshot.
 * Message handlers cannot interleave between the synchronous purge and save,
 * so a successful return means the on-disk graph and index.db agree.
 */
function persistGraphAfterSourcePurges(
  context: string,
  preparedVectorDeletes: ReturnType<typeof preparePendingVectorDeletes> = [],
): string | null {
  const purgeError = drainPendingSourcePurges();
  if (purgeError) return purgeError;
  const saveError = trySaveUsearchGraph(context);
  if (!saveError) completePendingVectorDeletes(state!.indexDb, preparedVectorDeletes);
  return saveError;
}

/**
 * Finish all durable delete residue while the worker is starting, before the
 * model warmup/readiness boundary. This runs without `state` because the graph
 * and index DB become available before the embedder/indexer do.
 */
function publishStartupPurges(resources: StartupIndexResources): void {
  const { indexDb, usearchHandle } = resources;
  const sourceIds = listPendingSourceIndexPurges(indexDb);
  if (sourceIds.length > 0) {
    const { failure } = applyPendingPurges(sourceIds, (sourceId) =>
      deleteIndexBySource(indexDb, sourceId, { usearch: usearchHandle }),
    );
    if (failure) {
      throw new Error(
        `startup source-index purge retry failed (${sourceIds.length} still pending): ${failure.message}`,
      );
    }
  }
  const completedDocumentIds: string[] = [];
  const documentItems = listPendingDocumentIndexPurges(indexDb, {
    limit: PENDING_DOCUMENT_PURGE_BATCH,
    sourceDeletedOnly: true,
  });
  for (const item of documentItems) {
    const result = deleteChunksByDocumentBatch(indexDb, item.documentId, 64, true, {
      usearch: usearchHandle,
    });
    if (result.complete) completedDocumentIds.push(item.documentId);
  }

  // This queue is independently durable. It can contain crash residue from a
  // per-document/direct delete even when no source-wide obligation exists.
  const preparedVectorDeletes = preparePendingVectorDeletes(
    indexDb,
    usearchHandle,
    PENDING_VECTOR_DELETE_BATCH,
  );
  if (
    sourceIds.length === 0 &&
    completedDocumentIds.length === 0 &&
    preparedVectorDeletes.length === 0
  )
    return;

  try {
    usearchHandle.save();
    refreshIndexStats(indexDb);
    completePendingVectorDeletes(indexDb, preparedVectorDeletes);
    completeSourceIndexPurges(indexDb, sourceIds);
    completeDocumentIndexPurges(indexDb, completedDocumentIds);
  } catch (err) {
    const kind =
      sourceIds.length > 0
        ? "startup source-index purge publication failed"
        : "startup vector-delete publication failed";
    throw new Error(
      `${kind} (${sourceIds.length} source purge(s), ${preparedVectorDeletes.length} vector delete(s)): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

function flushDeferredSourceDeletes(): void {
  if (!startupIndexResources || deferredSourceDeletes.length === 0) return;
  const queued = deferredSourceDeletes.splice(0);
  for (const request of queued) {
    handleDeleteSourceIndex(request.id, request.sourceId);
  }
}

function flushDeferredDocumentDeletes(): void {
  if (!startupIndexResources || deferredDocumentDeletes.length === 0) return;
  const queued = deferredDocumentDeletes.splice(0);
  for (const request of queued) {
    handleDeleteDocumentIndexBatch(
      request.id,
      request.documentId,
      request.limit,
      request.sourceDeleted,
    );
  }
}

/** Construct the configured embedder (HTTP backend, or the local model). */
async function buildEmbedder(init: IndexerInit): Promise<import("../indexer/types.js").Embedder> {
  if (init.httpEmbedderUrl) {
    return new (await import("../indexer/http-embedder.js")).HttpEmbedder({
      baseUrl: init.httpEmbedderUrl,
      apiPathPrefix: init.httpEmbedderApiPathPrefix,
      model: init.httpEmbedderModel ?? "",
      outputDim: init.embedDim,
      maxInputChars: init.embedderMaxInputChars,
      encoding: init.embedderEncoding,
      apiKey: init.httpEmbedderApiKey,
      allowRemoteInference: init.httpEmbedderAllowRemoteInference,
    });
  }
  return new LlamaCppEmbedder(init.modelPath, {
    concurrency: init.embedConcurrency,
    contextSize: init.embedderContextSize,
    timeoutMs: init.embedderTimeoutMs,
    maxInputChars: init.embedderMaxInputChars,
    encoding: init.embedderEncoding,
    outputDim: init.embedDim,
    onLoadProgress: (progress) => post({ type: "bootProgress", stage: "loading-model", progress }),
  });
}

async function handleInit(init: IndexerInit): Promise<void> {
  if (state) {
    log("warn", "indexer-worker", "init received twice — ignoring");
    return;
  }
  let warmupEmbedder: import("../indexer/types.js").Embedder | null = null;
  try {
    const gatewayDb = openGatewayReadConn(init.gatewayDbPath, init.gatewayDbKeyHex);
    const indexDb = openIndexWriteConn(init.indexDbPath, init.indexDbKeyHex);
    // Detect a model swap that bypassed the runtime config-change path
    // (env-override edits while the gateway is down, same-name file
    // replaced with a different dim, fresh installs whose stamp is
    // missing). On mismatch, wipe + rebuild before any cycle runs.
    const stamped = getIndexEmbedModel(indexDb);
    let warmedUp = false;
    if (stamped === null) {
      log(
        "info",
        "indexer-worker",
        `index_meta empty — stamping model=${init.modelName} dim=${init.embedDim} (existing embeddings assumed to match)`,
      );
      setIndexEmbedModel(indexDb, init.modelName, init.embedDim);
    } else if (stamped.name !== init.modelName || stamped.dim !== init.embedDim) {
      log(
        "warn",
        "indexer-worker",
        `embedding model mismatch: stamped=${stamped.name}/${stamped.dim} live=${init.modelName}/${init.embedDim} — wiping vector index for re-embed`,
      );
      // Prove the replacement embedder can embed BEFORE discarding the vectors
      // the previous one produced. The warm-up is not retried and a failure is
      // terminal for this worker, so wiping first would trade a working vector
      // index for an empty one on nothing more than an unreachable embedder.
      // The embedder is built here and reused below; the warm-up is paid once
      // either way.
      warmupEmbedder = await buildEmbedder(init);
      post({ type: "bootProgress", stage: "warmup", progress: 0 });
      await warmupEmbedder.embed(["warmup"]);
      post({ type: "bootProgress", stage: "warmup", progress: 1 });
      warmedUp = true;
      wipeAndRecreateVectorIndex(indexDb, init.embedDim, init.modelName);
    }

    // HNSW index: create write handle, backfill if needed.
    const { UsearchWriteHandle } = await import("../indexer/usearch-index.js");
    const usearchHandle = new UsearchWriteHandle(init.usearchIndexPath, init.embedDim);
    // After every save, record the seq the on-disk plaintext graph now reflects,
    // so the gateway's shutdown can encrypt the sidecar with a fingerprint that
    // exactly matches the file — no dependency on a "clean shutdown" signal.
    usearchHandle.setOnSaved(() => setUsearchSavedSeq(indexDb, getVectorWriteSeq(indexDb)));
    // Capture this before a queued startup delete can save the loaded graph and
    // advance its stamp. Such a save makes the deletion durable but cannot
    // certify unrelated stale same-cardinality vectors already in that graph.
    const forceHnswRebuild = getUsearchSavedSeq(indexDb) !== getVectorWriteSeq(indexDb);
    startupIndexResources = { indexDb, usearchHandle };
    flushDeferredSourceDeletes();
    flushDeferredDocumentDeletes();
    post({ type: "bootProgress", stage: "hnsw-backfill", progress: 0 });
    await usearchHandle.backfillFromDbCooperatively(indexDb, {
      onProgress: (fraction) =>
        post({ type: "bootProgress", stage: "hnsw-backfill", progress: fraction }),
      forceRebuild: forceHnswRebuild,
      pageSize: init.usearchBackfillPageSize,
    });

    // Finish both source-wide and standalone vector-delete residue before
    // model warmup/readiness, then serve any delete messages that arrived while
    // the graph handle was still opening.
    publishStartupPurges(startupIndexResources);
    flushDeferredSourceDeletes();
    flushDeferredDocumentDeletes();

    const source = new DirectDocumentSource(gatewayDb);
    const chunker = new DocumentChunker(init.chunkerChunkSize, init.chunkerOverlap);
    const embedder = warmupEmbedder ?? (await buildEmbedder(init));
    currentCutoffs = init.cutoffs;
    const indexer = new Indexer(indexDb, source, chunker, embedder, {
      getCutoff: (doc) => resolveCutoff(doc.sourceId),
      pageSize: init.indexerPageSize,
      betweenPageSleepMs: init.indexerBetweenPageSleepMs,
      dbWriteBatchSize: init.dbWriteBatchSize,
      indexWriteOptions: { usearch: usearchHandle },
    });

    log(
      "info",
      "indexer-worker",
      `starting: model=${init.modelPath}, indexInterval=${init.indexIntervalMs}ms, ` +
        `backlogInterval=${init.indexBacklogIntervalMs}ms, dbWriteBatch=${init.dbWriteBatchSize}, ` +
        `embedConcurrency=${init.embedConcurrency}, pageSize=${init.indexerPageSize}, ` +
        `betweenPageSleepMs=${init.indexerBetweenPageSleepMs}, reindexMissingAtBoot=${init.reindexMissingAtBoot}, ` +
        `chunker={size=${init.chunkerChunkSize},overlap=${init.chunkerOverlap}}, ` +
        `embedder={ctx=${init.embedderContextSize},timeout=${init.embedderTimeoutMs}ms,maxInput=${init.embedderMaxInputChars}}`,
    );

    // Repair denormalized chunk source attribution that a one-time document
    // re-home left stale (for example, legacy browser pages moved into `web`).
    // Runs before the stats seed below so the first
    // /index/stats already credits the survivor and drops the retired source.
    // A no-op in steady state.
    try {
      const ms = Date.now();
      const r = await indexer.reconcileSourceAttribution();
      if (r.repaired > 0) {
        log(
          "info",
          "indexer-worker",
          `startup reconcileSourceAttribution: re-pointed ${r.repaired} chunk(s) from ${r.sources} re-homed source(s) in ${Date.now() - ms}ms`,
        );
      }
    } catch (err) {
      log(
        "error",
        "indexer-worker",
        `startup reconcileSourceAttribution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Seed index_totals + source_index_stats BEFORE the initial indexing
    // cycle runs so the /index/stats endpoint returns real numbers within
    // a few tens of seconds of gateway boot, rather than waiting for the
    // full initial sweep (which can take hours on a large backlog).
    try {
      const ms = Date.now();
      refreshIndexStats(indexDb);
      log("info", "indexer-worker", `startup refreshIndexStats in ${Date.now() - ms}ms`);
    } catch (err) {
      log(
        "error",
        "indexer-worker",
        `startup refreshIndexStats failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Warm-up embed so the model is fully loaded before we post ready.
    // The embedder applies the configured document-side prefix internally.
    // Skipped when the model-mismatch branch above already paid for it.
    if (!warmedUp) {
      post({ type: "bootProgress", stage: "warmup", progress: 0 });
      await embedder.embed(["warmup"]);
      post({ type: "bootProgress", stage: "warmup", progress: 1 });
    }

    const heartbeatInterval = setInterval(() => {
      post({ type: "heartbeat", ts: Date.now() });
    }, init.heartbeatIntervalMs);

    state = {
      embedder,
      indexer,
      gatewayDb,
      indexDb,
      cycleTimer: null,
      reconcileTimer: null,
      reindexMissingTimer: null,
      heartbeatInterval,
      inFlightWork: null,
      pendingSourcePurges: new Set(listPendingSourceIndexPurges(indexDb)),
      pendingWake: false,
      lastCycleHadWork: false,
      shuttingDown: false,
      paused: false,
      usearchHandle,
      indexDbPath: init.indexDbPath,
      minFreeDiskMb: init.minFreeDiskMb,
      lastDiskSkipLogAt: 0,
    };
    startupIndexResources = null;

    // A prior worker may have stopped after acknowledging a source deletion
    // but before its trailing purge became durable. Replay that persisted
    // obligation before advertising the worker as ready.
    const startupPurgeError = drainPendingSourcePurges();
    if (startupPurgeError) {
      throw new Error(`startup source-index purge retry failed: ${startupPurgeError}`);
    }

    post({ type: "ready" });

    // Ready is posted before the initial scan so interactive query embedding can
    // come online without waiting for a large backlog. Treat all boot mutations
    // as one exclusive job, though: wakes, pause, flush and shutdown must see
    // the scan as in-flight rather than racing or closing its databases.
    await runExclusive(async () => {
      const preBootPurgeError = drainPendingSourcePurges();
      if (preBootPurgeError) {
        log(
          "error",
          "indexer-worker",
          `boot indexing deferred with source purge pending: ${preBootPurgeError}`,
        );
        return;
      }

      // If the watermark is current but most docs are unindexed, reset it.
      // This happens when a previous run was interrupted mid-backlog (crash,
      // stall, embedder swap) — the watermark advanced past docs that never
      // got indexed. Resetting lets `indexUpdated` rescan from the start;
      // the two-phase hash check skips already-indexed docs cheaply.
      const existingWatermark = getWatermark(indexDb, "last_updated_at");
      if (existingWatermark) {
        const indexedCount = getIndexedDocumentCount(indexDb);
        const gatewayCount =
          (
            gatewayDb.prepare<[], { c: number }>("SELECT COUNT(*) as c FROM documents").get() as {
              c: number;
            }
          )?.c ?? 0;
        if (gatewayCount > 0 && indexedCount / gatewayCount < 0.9) {
          indexDb.prepare("DELETE FROM watermark WHERE key = ?").run("last_updated_at");
          log(
            "info",
            "indexer-worker",
            `watermark reset: ${indexedCount}/${gatewayCount} indexed (${Math.round((indexedCount / gatewayCount) * 100)}%) — rescan from start`,
          );
        }
      }

      // Initial indexing cycle, then schedule periodic work. Skipped under
      // low disk (#15) — the periodic timers below still arm, so it retries
      // once disk frees and `lastCycleHadWork` stays false (idle cadence).
      if (diskOkForCycle()) {
        const startMs = Date.now();
        postJobUpdate("indexer.cycle", "started", { trigger: "boot" });
        let result;
        let saveError: string | null;
        const preparedVectorDeletes = preparePendingVectorDeletes(indexDb, usearchHandle);
        try {
          result = await indexer.indexUpdated();
          // The main-thread search handle reads the on-disk graph. Persist each
          // boot phase before starting another potentially long scan.
          saveError = persistGraphAfterSourcePurges("post-initial", preparedVectorDeletes);
        } catch (err) {
          postJobUpdate("indexer.cycle", "errored", {
            trigger: "boot",
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
        const initialDurationMs = Date.now() - startMs;
        if (saveError) {
          postJobUpdate("indexer.cycle", "errored", {
            trigger: "boot",
            error: `index publication failed: ${saveError}`,
          });
        } else {
          postJobUpdate("indexer.cycle", "completed", {
            trigger: "boot",
            stats: {
              indexed: result.indexed,
              updated: result.updated,
              skipped: result.skipped,
              errors: result.errors,
              durationMs: initialDurationMs,
              indexRatePerSec: recordRateSample(indexDb),
            },
          });
        }
        state!.lastCycleHadWork = result.indexed > 0 || result.updated > 0 || result.errors > 0;
        const stats = indexer.getStats();
        log(
          "info",
          "indexer-worker",
          `initial indexing: ${result.indexed} indexed, ${result.updated} updated, ${result.skipped} skipped, ${result.errors} errors, ${stats.documents} docs, ${stats.chunks} chunks in ${initialDurationMs}ms`,
        );
        // Do not enter another potentially multi-hour boot phase if a queued
        // source deletion or graph save could not be made durable.
        if (saveError) return;
      }

      // Config-gated (`indexer.reindexMissingAtBoot` in omnesis.json).
      // The at-boot reindexMissing is a heavy double-scan that fires
      // while the writer worker is still absorbing the collector
      // reconnect flood — exactly the peak race-window for the #192
      // crash. Off by default; the hourly interval still catches gaps.
      // Gated on free disk (#15): reindexMissing embeds + writes chunks, so a
      // low-disk boot skips it (the periodic cycle retries once disk frees).
      if (init.reindexMissingAtBoot && diskOkForCycle()) {
        const rmStart = Date.now();
        postJobUpdate("indexer.reindex-missing", "started", { trigger: "boot" });
        try {
          const prePhasePurgeError = drainPendingSourcePurges();
          if (prePhasePurgeError) {
            postJobUpdate("indexer.reindex-missing", "errored", {
              trigger: "boot",
              error: `source purge failed: ${prePhasePurgeError}`,
            });
            return;
          }
          const preparedVectorDeletes = preparePendingVectorDeletes(indexDb, usearchHandle);
          const r = await indexer.reindexMissing();
          const saveError = persistGraphAfterSourcePurges(
            "initial reindex-missing",
            preparedVectorDeletes,
          );
          if (saveError) {
            postJobUpdate("indexer.reindex-missing", "errored", {
              trigger: "boot",
              error: `index publication failed: ${saveError}`,
            });
            return;
          }
          postJobUpdate("indexer.reindex-missing", "completed", {
            trigger: "boot",
            stats: {
              indexed: r.indexed,
              errors: r.errors,
              durationMs: Date.now() - rmStart,
            },
          });
          if (r.indexed > 0 || r.errors > 0) {
            log(
              "info",
              "indexer-worker",
              `initial reindex-missing: ${r.indexed} indexed, ${r.errors} errors`,
            );
          }
        } catch (err) {
          postJobUpdate("indexer.reindex-missing", "errored", {
            trigger: "boot",
            error: err instanceof Error ? err.message : String(err),
          });
          log(
            "error",
            "indexer-worker",
            `initial reindex-missing failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // The periodic timer chains are armed after the boot-time cycle +
      // reindex-missing complete, so they can't conflict.

      // Re-seed after initial cycle picked up any newly-ingested docs. Kept
      // separate from the startup seed so stats stay current across the first
      // cycle even if the cycle processes a backlog of tens of thousands.
      try {
        refreshIndexStats(indexDb);
      } catch (err) {
        log(
          "error",
          "indexer-worker",
          `post-initial refreshIndexStats failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Catch-up after a long initial pass. The boot-time gap check (above)
      // resets the watermark BEFORE indexing, but a multi-hour initial pass
      // (e.g. a full from-scratch rebuild) can finish with the corpus larger
      // than when it started — a bootstrap that kept ingesting leaves its
      // late-arriving docs behind the now-advanced watermark, where the
      // periodic `indexUpdated` won't see them and only the hourly
      // `reindexMissing` eventually would. Re-check the gap here and run one
      // catch-up `reindexMissing` now rather than leaving docs unindexed for up
      // to an hour. Skipped when `reindexMissingAtBoot` already ran one above.
      // (Observed after a rebuild left ~52k docs unindexed.)
      if (!init.reindexMissingAtBoot) {
        try {
          const indexedCount = getIndexedDocumentCount(indexDb);
          const gatewayCount =
            (
              gatewayDb.prepare<[], { c: number }>("SELECT COUNT(*) as c FROM documents").get() as
                | { c: number }
                | undefined
            )?.c ?? 0;
          if (gatewayCount > 0 && indexedCount / gatewayCount < 0.99 && diskOkForCycle()) {
            log(
              "info",
              "indexer-worker",
              `initial pass left ${indexedCount}/${gatewayCount} indexed — running catch-up reindex-missing`,
            );
            const prePhasePurgeError = drainPendingSourcePurges();
            if (prePhasePurgeError) {
              throw new Error(`source purge failed: ${prePhasePurgeError}`);
            }
            const preparedVectorDeletes = preparePendingVectorDeletes(indexDb, usearchHandle);
            await indexer.reindexMissing();
            const saveError = persistGraphAfterSourcePurges(
              "catch-up reindex-missing",
              preparedVectorDeletes,
            );
            if (saveError) throw new Error(`index publication failed: ${saveError}`);
            refreshIndexStats(indexDb);
          }
        } catch (err) {
          log(
            "error",
            "indexer-worker",
            `catch-up reindex-missing failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });

    // Wakes received while the boot scan was in flight coalesce behind the
    // exclusivity gate. Run one trailing cycle so documents that landed after
    // the scan's fixed watermark do not wait for the periodic timer.
    drainPendingWake();

    // Self-rescheduling timer chains. Each chain re-arms its next tick
    // ONLY after the current tick settles, so a slow tick can't pile up
    // overlapping invocations. The runExclusive() gate above further
    // guarantees only one of {cycle, reconcile, reindex-missing} runs
    // at a time across all three chains.
    const armCycle = (): void => {
      if (!state || state.shuttingDown) return;
      // Adaptive interval: use the short backlog interval when the
      // previous cycle found work; revert to the normal idle interval
      // when there's nothing to do.
      const delayMs = state.lastCycleHadWork ? init.indexBacklogIntervalMs : init.indexIntervalMs;
      state.cycleTimer = setTimeout(() => {
        void runIndexCycle("timer").finally(armCycle);
      }, delayMs);
    };
    const armReconcile = (): void => {
      if (!state || state.shuttingDown) return;
      state.reconcileTimer = setTimeout(() => {
        void runReconcileCycle("timer").finally(armReconcile);
      }, init.reconcileIntervalMs);
    };
    const armReindexMissing = (): void => {
      if (!state || state.shuttingDown) return;
      state.reindexMissingTimer = setTimeout(() => {
        void runReindexMissingCycle("timer").finally(armReindexMissing);
      }, init.reindexMissingIntervalMs);
    };
    armCycle();
    armReconcile();
    armReindexMissing();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    startupIndexResources = null;
    for (const request of deferredSourceDeletes.splice(0)) {
      post({
        type: "deleteSourceIndexError",
        id: request.id,
        error: `indexer initialization failed: ${msg}`,
      });
    }
    for (const request of deferredDocumentDeletes.splice(0)) {
      post({
        type: "deleteDocumentIndexBatchError",
        id: request.id,
        error: `indexer initialization failed: ${msg}`,
      });
    }
    // Release a model the early mismatch warm-up loaded; nothing else holds it
    // once init fails. Guarded on the live state so a failure that lands after
    // the worker adopted the embedder cannot dispose the one it is using.
    if (warmupEmbedder && state?.embedder !== warmupEmbedder) {
      try {
        await warmupEmbedder.dispose?.();
      } catch {
        /* disposal is best-effort on an already-failed boot */
      }
    }
    log("error", "indexer-worker", `init failed: ${msg}`);
    post({ type: "initError", error: msg });
  }
}

/**
 * Run one indexing cycle, guarding against overlap with reconcile +
 * reindex-missing via the shared `inFlightWork` gate. A cycle skipped
 * because of overlap will retry on the next periodic tick (or the next
 * wake, for `trigger="wake"`).
 *
 * Wakes that arrive while a cycle is in flight set `pendingWake` so a
 * follow-up cycle fires as soon as the inflight work finishes — keeps
 * docs that landed mid-cycle from waiting the full periodic interval.
 */
async function runIndexCycle(trigger: "timer" | "wake"): Promise<void> {
  if (!state || state.shuttingDown) return;
  // Quiesced for a graceful swap (epic #1011): skip so the corpus stays frozen
  // for the swap's catch-up. embedQuery keeps working, so search stays live.
  if (state.paused) return;
  if (state.inFlightWork) {
    if (trigger === "wake") state.pendingWake = true;
    return;
  }
  // Low-disk gate (#15): skip the cycle when free disk on the index.db
  // volume is below the floor. Treat it like an idle (no-work) cycle so
  // the adaptive timer backs off to the long interval; the next wake/tick
  // retries once disk frees.
  if (!diskOkForCycle()) {
    state.lastCycleHadWork = false;
    return;
  }
  const indexDb = state.indexDb;
  const cycleStart = Date.now();
  postJobUpdate("indexer.cycle", "started", { trigger });
  const result = await runExclusive(async () => {
    try {
      const preCyclePurgeError = drainPendingSourcePurges();
      if (preCyclePurgeError) {
        throw new Error(`source purge failed: ${preCyclePurgeError}`);
      }
      const preparedVectorDeletes = preparePendingVectorDeletes(
        state!.indexDb,
        state!.usearchHandle,
        PENDING_VECTOR_DELETE_BATCH,
      );
      const r = await state!.indexer.indexUpdated();
      // Adaptive timer: signal whether this cycle found real work.
      if (state) {
        state.lastCycleHadWork = r.indexed > 0 || r.updated > 0 || r.errors > 0;
      }
      // Save even after a no-work pass. Usearch makes clean saves a no-op, and
      // this retries a prior transient save failure instead of leaving the
      // main-thread read handle stale indefinitely.
      const saveError = persistGraphAfterSourcePurges(
        `${trigger} indexing cycle`,
        preparedVectorDeletes,
      );
      if (saveError) throw new Error(`index publication failed: ${saveError}`);
      if (r.indexed > 0 || r.updated > 0) {
        try {
          refreshIndexStats(indexDb);
        } catch (err) {
          log(
            "error",
            "indexer-worker",
            `post-cycle refreshIndexStats failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      postJobUpdate("indexer.cycle", "completed", {
        trigger,
        stats: {
          indexed: r.indexed,
          updated: r.updated,
          skipped: r.skipped,
          errors: r.errors,
          durationMs: Date.now() - cycleStart,
          indexRatePerSec: recordRateSample(indexDb),
        },
      });
    } catch (err) {
      postJobUpdate("indexer.cycle", "errored", {
        trigger,
        error: err instanceof Error ? err.message : String(err),
      });
      log(
        "error",
        "indexer-worker",
        `indexing cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
  void result;
  drainPendingWake();
}

async function runReconcileCycle(trigger: "timer" | "operator"): Promise<void> {
  if (!state || state.shuttingDown) return;
  if (state.paused) return; // quiesced for a graceful swap (epic #1011)
  if (state.inFlightWork) return;
  const t = Date.now();
  postJobUpdate("indexer.reconcile-deleted", "started", { trigger });
  await runExclusive(async () => {
    try {
      await state!.indexer.reconcileDeletedDocuments();
      postJobUpdate("indexer.reconcile-deleted", "completed", {
        trigger,
        stats: { durationMs: Date.now() - t },
      });
    } catch (err) {
      postJobUpdate("indexer.reconcile-deleted", "errored", {
        trigger,
        error: err instanceof Error ? err.message : String(err),
      });
      log(
        "error",
        "indexer-worker",
        `reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
  drainPendingWake();
}

type ReindexMissingCycleOutcome =
  | { status: "completed"; result: { indexed: number; errors: number } }
  | { status: "failed"; error: string }
  | { status: "busy" };

async function runReindexMissingCycle(
  trigger: "timer" | "boot" | "operator",
): Promise<ReindexMissingCycleOutcome> {
  if (!state || state.shuttingDown) return { status: "busy" };
  if (state.paused) return { status: "busy" }; // quiesced for a graceful swap (epic #1011)
  if (state.inFlightWork) return { status: "busy" };
  // Gated on free disk (#15): reindexMissing writes chunks; skip under low
  // disk and let a later cycle retry once space frees.
  if (!diskOkForCycle()) return { status: "busy" };
  const t = Date.now();
  postJobUpdate("indexer.reindex-missing", "started", { trigger });
  let outcome: ReindexMissingCycleOutcome = { status: "busy" };
  await runExclusive(async () => {
    try {
      const preCyclePurgeError = drainPendingSourcePurges();
      if (preCyclePurgeError) {
        throw new Error(`source purge failed: ${preCyclePurgeError}`);
      }
      const preparedVectorDeletes = preparePendingVectorDeletes(
        state!.indexDb,
        state!.usearchHandle,
        PENDING_VECTOR_DELETE_BATCH,
      );
      const r = await state!.indexer.reindexMissing();
      // reindexMissing writes through the same in-memory HNSW handle as the
      // normal cycle; publish that graph before reporting the repair complete.
      const saveError = persistGraphAfterSourcePurges(
        `${trigger} reindex-missing`,
        preparedVectorDeletes,
      );
      if (saveError) throw new Error(`index publication failed: ${saveError}`);
      outcome = { status: "completed", result: r };
      postJobUpdate("indexer.reindex-missing", "completed", {
        trigger,
        stats: { indexed: r.indexed, errors: r.errors, durationMs: Date.now() - t },
      });
      if (r.indexed > 0 || r.errors > 0) {
        log(
          "info",
          "indexer-worker",
          `${trigger === "operator" ? "manual " : ""}reindex-missing: ${r.indexed} indexed, ${r.errors} errors`,
        );
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcome = { status: "failed", error };
      postJobUpdate("indexer.reindex-missing", "errored", {
        trigger,
        error,
      });
      log("error", "indexer-worker", `reindex-missing failed: ${error}`);
    }
  });
  drainPendingWake();
  return outcome;
}

function handleWake(): void {
  if (!state || state.shuttingDown) return;
  // Debounce + coalesce now live in the main-thread Scheduler
  // (`indexer.wake` WakeableTask). Worker-side responsibility is just:
  // run a cycle, and remember if more arrived mid-cycle.
  void runIndexCycle("wake");
}

async function handleEmbedQuery(id: number, text: string, sentAtMs: number): Promise<void> {
  // Phase-0 instrumentation: split the round-trip into
  //   - ipcInMs: how long the message sat between main calling post()
  //     and the worker actually picking it up. Reflects message-channel
  //     queuing and the worker thread being busy doing something else
  //     (typically a batch embed).
  //   - computeMs: time inside `embedder.embedQuery` doing the actual
  //     Metal/CPU work.
  const recvAtMs = Date.now();
  const ipcInMs = recvAtMs - sentAtMs;
  if (!state) {
    post({ type: "embedQueryError", id, error: "embedder not ready" });
    return;
  }
  try {
    const computeStart = Date.now();
    const vector = await state.embedder.embedQuery(text);
    const computeMs = Date.now() - computeStart;
    post({
      type: "embedQueryResult",
      id,
      vector: Array.from(vector),
      ipcInMs,
      computeMs,
    });
  } catch (err) {
    post({ type: "embedQueryError", id, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Run reindexMissing on-demand (operator trigger via the admin API).
 * Refreshes materialized stats afterwards when anything changed so the
 * /index/stats percentIndexed reflects the repair immediately.
 */
async function handleRunReindexMissing(id: number): Promise<void> {
  if (!state) {
    post({ type: "runReindexMissingError", id, error: "indexer not ready" });
    return;
  }
  // Wait for any in-flight cycle/reconcile/reindex to settle so the
  // operator-triggered run doesn't race with periodic work.
  while (state && state.inFlightWork && !state.shuttingDown) {
    try {
      await state.inFlightWork;
    } catch {
      /* surfaced inside the runner */
    }
  }
  if (!state || state.shuttingDown) {
    post({ type: "runReindexMissingError", id, error: "indexer shutting down" });
    return;
  }
  const outcome = await runReindexMissingCycle("operator");
  if (outcome.status === "busy") {
    post({ type: "runReindexMissingError", id, error: "indexer busy" });
    return;
  }
  if (outcome.status === "failed") {
    post({ type: "runReindexMissingError", id, error: outcome.error });
    return;
  }
  const r = outcome.result;
  if (r.indexed > 0 || r.errors > 0) {
    try {
      refreshIndexStats(state.indexDb);
    } catch (err) {
      log(
        "error",
        "indexer-worker",
        `post-trigger refreshIndexStats failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  post({ type: "runReindexMissingResult", id, indexed: r.indexed, errors: r.errors });
}

/**
 * Delete a source's index data and answer at once.
 *
 * The delete runs here, on the worker thread, rather than on the HTTP thread —
 * the worker owns the live usearch write handle. It does NOT wait for an
 * in-flight indexing job, and it cannot interleave with one: `removeBatch`,
 * `add` and `save` are synchronous native calls, so a message handler only
 * runs when the thread is idle between them.
 *
 * What an in-flight job can do is write chunk / `indexed_documents` rows for
 * documents it read before this delete ran, leaving rows behind for a source
 * that is gone. That is ordered by re-applying the delete once the job stops
 * (see `drainPendingSourcePurges`) rather than by making the caller wait for
 * it — waiting cost minutes on a busy indexer and routinely exceeded the
 * caller's timeout, however small the source being deleted.
 *
 * `save()` and the stats refresh defer to that same pass while a job is
 * running. The reply does not need them: search reaches a vector only through
 * the `chunks` rows this just deleted, and `/index/stats` reads the counters
 * `deleteIndexBySource` already corrected.
 */
function handleDeleteSourceIndex(id: number, sourceId: string): void {
  if (!state) {
    if (!startupIndexResources) {
      deferredSourceDeletes.push({ id, sourceId });
      return;
    }
    try {
      enqueueSourceIndexPurge(startupIndexResources.indexDb, sourceId);
      const deleted = deleteIndexBySource(startupIndexResources.indexDb, sourceId, {
        usearch: startupIndexResources.usearchHandle,
      });
      publishStartupPurges(startupIndexResources);
      post({ type: "deleteSourceIndexResult", id, deleted });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(
        "error",
        "indexer-worker",
        `source-index deletion during startup for ${sourceId} failed: ${msg}`,
      );
      post({ type: "deleteSourceIndexError", id, error: msg });
    }
    return;
  }
  try {
    enqueueSourceIndexPurge(state.indexDb, sourceId);
    state.pendingSourcePurges.add(sourceId);
    const deleted = deleteIndexBySource(state.indexDb, sourceId, {
      usearch: state.usearchHandle,
    });
    if (!state.inFlightWork) {
      // Nothing else is writing, so finish now rather than leaving the vectors
      // unsaved and the counters stale until some later job happens to run.
      const purgeError = drainPendingSourcePurges();
      if (purgeError) throw new Error(purgeError);
    }
    post({ type: "deleteSourceIndexResult", id, deleted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "indexer-worker", `source-index deletion for ${sourceId} failed: ${msg}`);
    post({ type: "deleteSourceIndexError", id, error: msg });
  }
}

function handleDeleteDocumentIndexBatch(
  id: number,
  documentId: string,
  limit: number,
  sourceDeleted: boolean,
): void {
  const resources = state ?? startupIndexResources;
  if (!resources) {
    deferredDocumentDeletes.push({ id, documentId, limit, sourceDeleted });
    return;
  }
  try {
    enqueueDocumentIndexPurge(resources.indexDb, documentId, sourceDeleted);
    const result = deleteChunksByDocumentBatch(
      resources.indexDb,
      documentId,
      limit,
      sourceDeleted,
      {
        usearch: resources.usearchHandle,
      },
    );
    // A job that read this document before the message arrived can write it
    // back afterwards. Keep the durable purge pending and make retention retry
    // rather than unlinking the transcript on a premature "complete".
    if (state?.inFlightWork) {
      post({
        type: "deleteDocumentIndexBatchResult",
        id,
        ...result,
        complete: false,
      });
      return;
    }
    if (sourceDeleted && result.complete) {
      const preparedVectorDeletes = preparePendingVectorDeletes(
        resources.indexDb,
        resources.usearchHandle,
        PENDING_VECTOR_DELETE_BATCH,
      );
      resources.usearchHandle.save();
      refreshIndexStats(resources.indexDb);
      completePendingVectorDeletes(resources.indexDb, preparedVectorDeletes);
      completeDocumentIndexPurges(resources.indexDb, [documentId]);
    }
    post({ type: "deleteDocumentIndexBatchResult", id, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      "error",
      "indexer-worker",
      `document-index batch deletion for ${documentId} failed: ${message}`,
    );
    post({ type: "deleteDocumentIndexBatchError", id, error: message });
  }
}

async function handleShutdown(): Promise<void> {
  if (!state) {
    post({ type: "shutdownComplete" });
    return;
  }
  if (state.shuttingDown) return;
  state.shuttingDown = true;

  if (state.cycleTimer) clearTimeout(state.cycleTimer);
  if (state.reconcileTimer) clearTimeout(state.reconcileTimer);
  if (state.reindexMissingTimer) clearTimeout(state.reindexMissingTimer);
  clearInterval(state.heartbeatInterval);
  state.indexer.stop();

  if (state.inFlightWork) {
    try {
      await state.inFlightWork;
    } catch {
      /* already logged */
    }
  }

  // Retry queued privacy cleanup before the last graph publication. When it
  // still fails, leave the prior snapshot untouched; the durable obligation
  // is replayed before the next worker advertises readiness.
  const purgeError = drainPendingSourcePurges();
  if (purgeError) {
    log(
      "error",
      "indexer-worker",
      `shutdown skipped HNSW publication with source purge pending: ${purgeError}`,
    );
  } else {
    state.usearchHandle?.close();
  }

  try {
    await state.embedder.dispose();
  } catch {
    /* best-effort */
  }
  try {
    state.indexDb.close();
  } catch {
    /* best-effort */
  }
  try {
    state.gatewayDb.close();
  } catch {
    /* best-effort */
  }

  // Main-side proxy terminates the worker after shutdownComplete.
  post({ type: "shutdownComplete" });
}

/**
 * Quiesce indexing for a graceful embedder swap (epic #1011) and ack once the
 * corpus is frozen. Sets `paused` so no NEW cycle starts, then awaits any cycle
 * already in flight so the `chunks` corpus is settled before the ack — the
 * caller (the swap's pre-flip quiesce) relies on the ack meaning "safe to run
 * catch-up against a frozen corpus". The embedder stays loaded throughout, so
 * `embedQuery` keeps serving search under the old model until the atomic flip.
 */
async function handlePauseIndexing(id: number): Promise<void> {
  if (!state) {
    // No worker state yet (pre-init) — nothing is indexing, so it's already
    // "paused" from the caller's perspective. Ack immediately.
    post({ type: "pausedAck", id });
    return;
  }
  state.paused = true;
  try {
    if (state.inFlightWork) await state.inFlightWork;
  } catch {
    // The in-flight job's own handler logged the error; we only care that it
    // settled so the corpus is no longer moving.
  }
  post({ type: "pausedAck", id });
}

/**
 * Freeze indexing and force a final HNSW save so the on-disk plaintext graph
 * (and `usearch_saved_seq`, stamped by the save's `onSaved` hook) reflect the
 * current in-memory graph. The gateway shutdown then encrypts a CURRENT sidecar
 * (and plaintext installs keep a current `index.usearch`), so the next boot
 * RESTORES instead of rebuilding (~18 min for ~800k vectors). This is terminal:
 * stops new cycles and cooperatively stops the current index pass after its
 * pending embedding page settles, leaving the backlog for the next boot.
 * It then saves. `ok` is false if the save
 * threw — the gateway proceeds and the next boot rebuilds (fail-safe).
 */
async function handleFlushSave(id: number): Promise<void> {
  if (!state) {
    // Pre-init: no graph in memory, nothing to save.
    post({ type: "flushSaveComplete", id, ok: true });
    return;
  }
  state.paused = true;
  // Pausing alone prevents new cycles but lets an existing corpus scan consume
  // the save budget. stop() drains already submitted embeddings and preserves
  // their watermark without starting additional pages or retries.
  state.indexer.stop();
  try {
    if (state.inFlightWork) await state.inFlightWork;
  } catch {
    // The in-flight job's own handler logged; we only need it settled so the
    // graph is no longer moving before we save.
  }
  let ok = true;
  const purgeError = drainPendingSourcePurges();
  if (purgeError) {
    ok = false;
    log("error", "indexer-worker", `flush-save deferred with source purge pending: ${purgeError}`);
  } else {
    try {
      state.usearchHandle?.save();
    } catch (err) {
      ok = false;
      log(
        "error",
        "indexer-worker",
        `flush-save on shutdown failed (next boot rebuilds): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  post({ type: "flushSaveComplete", id, ok });
}

/** Un-pause indexing (epic #1011) — used when a newer swap abandons the build,
 *  so the still-active generation keeps ingesting. Kicks one cycle to catch up
 *  on anything that landed while paused. */
function handleResumeIndexing(): void {
  if (!state || state.shuttingDown) return;
  state.paused = false;
  void runIndexCycle("wake");
}

function handleUpdateCutoffs(cutoffs: IndexerCutoffMap): void {
  currentCutoffs = cutoffs;
  log(
    "info",
    "indexer-worker",
    `cutoffs updated: default=${cutoffs.default ?? "none"}, perSource=${Object.keys(cutoffs.perSource).length}`,
  );
}

parentPort.on("message", (msg: MainToIndexer) => {
  switch (msg.type) {
    case "init":
      void handleInit(msg);
      break;
    case "embedQuery":
      void handleEmbedQuery(msg.id, msg.text, msg.sentAtMs);
      break;
    case "runReindexMissing":
      void handleRunReindexMissing(msg.id);
      break;
    case "deleteSourceIndex":
      handleDeleteSourceIndex(msg.id, msg.sourceId);
      break;
    case "deleteDocumentIndexBatch":
      handleDeleteDocumentIndexBatch(msg.id, msg.documentId, msg.limit, msg.sourceDeleted);
      break;
    case "wake":
      handleWake();
      break;
    case "updateCutoffs":
      handleUpdateCutoffs(msg.cutoffs);
      break;
    case "pauseIndexing":
      void handlePauseIndexing(msg.id);
      break;
    case "resumeIndexing":
      handleResumeIndexing();
      break;
    case "flushSave":
      void handleFlushSave(msg.id);
      break;
    case "shutdown":
      void handleShutdown();
      break;
  }
});
