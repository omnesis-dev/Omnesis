// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Main-thread proxy for the indexer worker.
 *
 * Implements the `Embedder` interface so `SearchPipeline` can call
 * `embedQuery(text)` at search time; under the hood it round-trips to the
 * worker via postMessage. A pending-request map resolves promises when
 * the worker posts back an `embedQueryResult`.
 *
 * Also watches the worker's heartbeat so a stuck worker surfaces as a
 * log warning rather than silent search failure.
 */

import { Worker } from "node:worker_threads";
import { createLogger, resolveWorkerEntry } from "@omnesis/core";
import { ambientAnswerProfiler, type AnswerProfiler } from "../privacy/answer-profile.js";
import { PendingRequest } from "./pending-request.js";
import type { BackgroundJob, JobObservation, JobState } from "../background-jobs/types.js";
import type { EmbedderEncoding } from "../indexer/embedder-prefixes.js";
import type { Embedder } from "../indexer/types.js";
import type {
  IndexerCutoffMap,
  IndexerInit,
  IndexerJobUpdate,
  IndexerWorkerJobId,
  MainToIndexer,
  IndexerToMain,
} from "./protocol.js";

const log = createLogger("gateway:indexer-worker");

/**
 * Build the worker's per-source cutoff map from an OmnesisConfig.
 * `default` resolves to sources.default.maxAge ?? dataRetention.maxAge.
 * Per-source entries from `sources.<id>.maxAge`, keyed exactly as the config
 * writes them — a descriptor id or an account-qualified instance id — since
 * the map is built without knowing which sources exist. Which of them applies
 * to a given document is decided by `resolveIndexerCutoffMaxAge`. A `null`
 * value means "explicitly disabled" (currently the schema doesn't allow null,
 * so this stays in sync with absence-as-fallback semantics — only present keys
 * override).
 */
export function buildIndexerCutoffMap(config: {
  dataRetention?: { maxAge?: string };
  sources?: Record<string, { maxAge?: string }>;
}): IndexerCutoffMap {
  const fallback = config.sources?.default?.maxAge ?? config.dataRetention?.maxAge ?? null;
  const perSource: Record<string, string | null> = {};
  for (const [key, val] of Object.entries(config.sources ?? {})) {
    if (key === "default") continue;
    if (val?.maxAge) perSource[key] = val.maxAge;
  }
  return { default: fallback, perSource };
}

export interface IndexerWorkerOptions {
  modelPath: string;
  /** Identity of the embedding model. Used by the worker to detect a
   * swap that bypassed the runtime config-change path. */
  modelName: string;
  embedDim: number;
  gatewayDbPath: string;
  gatewayDbKeyHex?: string;
  indexDbPath: string;
  indexDbKeyHex?: string;
  cutoffs: IndexerCutoffMap;
  indexIntervalMs: number;
  indexBacklogIntervalMs: number;
  dbWriteBatchSize: number;
  reconcileIntervalMs: number;
  reindexMissingIntervalMs: number;
  /** See IndexerInit fields of the same names — resolved at gateway boot. */
  embedConcurrency: number;
  indexerPageSize: number;
  indexerBetweenPageSleepMs: number;
  reindexMissingAtBoot: boolean;
  /** Chunker / embedder tunables. Resolved from `indexer.{chunker,embedder}.*`. */
  chunkerChunkSize: number;
  chunkerOverlap: number;
  embedderContextSize: number;
  embedderTimeoutMs: number;
  embedderMaxInputChars: number;
  /**
   * Low-disk write guard. Free MB on the index.db volume below which
   * the worker skips an indexing cycle. Resolved from `gateway.minFreeDiskMb`.
   */
  minFreeDiskMb: number;
  /**
   * Per-model retrieval encoding: none | text-prefix | api-param.
   * Resolved at gateway boot from `search.embedderPrefixes.enabled` × the
   * embedder family / provider detected from the model id.
   */
  embedderEncoding: EmbedderEncoding;
  /** When set, use HttpEmbedder targeting this URL instead of LlamaCppEmbedder. */
  httpEmbedderUrl?: string;
  /** Model name for the HTTP embedder (auto-discovered if omitted). */
  httpEmbedderModel?: string;
  /** API key for the HTTP embedder backend (Bearer token). */
  httpEmbedderApiKey?: string;
  /** API path prefix for the HTTP embedder backend (default "/v1"). */
  httpEmbedderApiPathPrefix?: string;
  /** Permit non-loopback HTTP inference for the HTTP embedder. */
  httpEmbedderAllowRemoteInference?: boolean;
  /** Path for the usearch HNSW index file. */
  usearchIndexPath: string;
  /** Optional cold-backfill page size; primarily for scheduling tests. */
  usearchBackfillPageSize?: number;
  heartbeatIntervalMs?: number;
  heartbeatWarnGapMs?: number;
}

/**
 * Per-worker-job state held on the main thread, hydrated from
 * `IndexerJobUpdate` messages. The BackgroundJob adapters built by
 * `createBackgroundJobs()` read from this state — pure in-memory; no
 * postMessage round-trip on observe.
 */
interface WorkerJobState {
  /** Wall-clock of the most recent phase=started message. */
  lastStartedAt?: number;
  /** Wall-clock of the most recent phase=completed message. */
  lastCompletedAt?: number;
  /** Wall-clock of the most recent phase=errored message. */
  lastErroredAt?: number;
  /** Set true between started and completed/errored. */
  inFlight: boolean;
  /** Most recent run's stats payload. */
  lastStats?: IndexerJobUpdate["stats"];
  /** Most recent error message + when it landed. */
  lastError?: { message: string; at: number };
  /** Most recent trigger reason. */
  lastTrigger?: IndexerJobUpdate["trigger"];
  /** Cumulative run count since boot. */
  runs: number;
  /** Cumulative error count since boot. */
  errors: number;
  /**
   * Ring buffer of recent durations (ms). Used for avg/p99 in the
   * observation. Capacity 100 — covers an hour of cycles at 1/min and
   * is well below 10KB total even at maximum cardinality.
   */
  durations: number[];
}

const WORKER_JOB_DURATION_RING = 100;

const EMBED_QUERY_TIMEOUT_MS = 30_000;
// reindexMissing does a full gateway-vs-index diff + re-indexes the gap.
// On a large backlog with many failing docs this can take minutes — the
// operator-triggered call is inherently batch-sized, so the timeout
// exists to bound "forever" (wedged worker) rather than to cap duration.
const REINDEX_MISSING_TIMEOUT_MS = 15 * 60_000;

/**
 * A source-index deletion never waits for an in-flight indexing job, so it no
 * longer needs the batch-reindex budget of fifteen minutes — a caller that hung
 * that long could not usefully retry.
 *
 * It is not instant either. When no job is running the worker finishes the
 * whole thing on the spot: remove every vector, rewrite the usearch graph
 * (`FLUSH_SAVE_TIMEOUT_MS` budgets 20s for that same save on a large index) and
 * recompute the per-source stats. This is sized to clear that worst case with
 * room, while still failing fast enough for the caller's retry to be useful.
 */
const DELETE_SOURCE_INDEX_TIMEOUT_MS = 60_000;
// A final HNSW save rewrites the whole ~GB graph (usearch has no incremental
// save), so it can exceed the 5s dispose ack. Bound generously: a legitimate
// save finishes in a few seconds; the timeout only fires on a genuine hang, in
// which case the gateway proceeds and the next boot rebuilds (fail-safe). Kept
// well under the gateway's 30s SHUTDOWN_TIMEOUT_MS so dispose + encrypt still fit.
const FLUSH_SAVE_TIMEOUT_MS = 20_000;

export class IndexerWorkerProxy implements Embedder {
  private worker: Worker;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private readySettled = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest<Float32Array>>();
  /**
   * Profilers captured at embedQuery enqueue time, keyed by request id.
   * The reply lands in a `message` handler outside any request's async
   * context, so the ambient lookup would always miss — the reference
   * travels alongside the pending entry instead.
   */
  private pendingProfilers = new Map<number, AnswerProfiler>();
  private pendingReindex = new Map<number, PendingRequest<{ indexed: number; errors: number }>>();
  private pendingDeleteSource = new Map<number, PendingRequest<number>>();
  private pendingDeleteDocument = new Map<
    number,
    PendingRequest<{
      deletedChunks: number;
      complete: boolean;
      readyForSourceDelete: boolean;
    }>
  >();
  private pendingPause = new Map<number, PendingRequest<void>>();
  private pendingFlushSave = new Map<number, PendingRequest<boolean>>();
  private lastHeartbeat = 0;
  private heartbeatCheck: ReturnType<typeof setInterval> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private workerExit: Promise<void>;
  private resolveWorkerExit!: () => void;
  private workerExited = false;
  private workerJobs: Map<IndexerWorkerJobId, WorkerJobState> = new Map();
  /**
   * Latest docs/sec throughput reported by the worker on an
   * `indexer.cycle` completion. null until the worker's rolling window
   * has enough signal (≥2 samples spanning a few seconds with positive
   * progress). Read by `/index/stats` via `indexerControl.getIndexRate()`
   * to serve a server-side ETA on first page load — no client warm-up.
   */
  private _indexRatePerSec: number | null = null;
  private _bootProgress: {
    stage: "hnsw-backfill" | "loading-model" | "warmup" | "initial-cycle";
    progress: number;
  } | null = null;

  constructor(private opts: IndexerWorkerOptions) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.workerExit = new Promise<void>((resolve) => {
      this.resolveWorkerExit = resolve;
    });

    // Source mode runs the .ts entry under tsx (preloading register-tsx.mjs
    // so the worker's `.js` specifiers resolve back to `.ts` source);
    // compiled mode runs the emitted dist sibling directly.
    const entry = resolveWorkerEntry("./indexer-worker.ts", import.meta.url, "./register-tsx.mjs");
    this.worker = new Worker(entry.url, { execArgv: entry.execArgv });
    this.worker.on("message", (msg: IndexerToMain) => this.handleMessage(msg));
    this.worker.on("error", (err) => {
      log.error(`worker error: ${err.message ?? String(err)}`);
      if (!this.readySettled) {
        this.readySettled = true;
        this.rejectReady(err instanceof Error ? err : new Error(String(err)));
      }
    });
    this.worker.on("exit", (code) => {
      this.workerExited = true;
      if (!this.readySettled) {
        this.readySettled = true;
        this.rejectReady(
          new Error(`indexer worker exited before becoming ready (exit code ${code})`),
        );
      }
      this.resolveWorkerExit();
    });

    const init: IndexerInit = {
      type: "init",
      modelPath: opts.modelPath,
      modelName: opts.modelName,
      embedDim: opts.embedDim,
      gatewayDbPath: opts.gatewayDbPath,
      indexDbPath: opts.indexDbPath,
      cutoffs: opts.cutoffs,
      indexIntervalMs: opts.indexIntervalMs,
      indexBacklogIntervalMs: opts.indexBacklogIntervalMs,
      dbWriteBatchSize: opts.dbWriteBatchSize,
      reconcileIntervalMs: opts.reconcileIntervalMs,
      reindexMissingIntervalMs: opts.reindexMissingIntervalMs,
      embedConcurrency: opts.embedConcurrency,
      indexerPageSize: opts.indexerPageSize,
      indexerBetweenPageSleepMs: opts.indexerBetweenPageSleepMs,
      reindexMissingAtBoot: opts.reindexMissingAtBoot,
      chunkerChunkSize: opts.chunkerChunkSize,
      chunkerOverlap: opts.chunkerOverlap,
      embedderContextSize: opts.embedderContextSize,
      embedderTimeoutMs: opts.embedderTimeoutMs,
      embedderMaxInputChars: opts.embedderMaxInputChars,
      minFreeDiskMb: opts.minFreeDiskMb,
      embedderEncoding: opts.embedderEncoding,
      httpEmbedderUrl: opts.httpEmbedderUrl,
      httpEmbedderModel: opts.httpEmbedderModel,
      httpEmbedderApiKey: opts.httpEmbedderApiKey,
      httpEmbedderApiPathPrefix: opts.httpEmbedderApiPathPrefix,
      httpEmbedderAllowRemoteInference: opts.httpEmbedderAllowRemoteInference,
      usearchIndexPath: opts.usearchIndexPath,
      usearchBackfillPageSize: opts.usearchBackfillPageSize,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 30_000,
      ...(opts.gatewayDbKeyHex ? { gatewayDbKeyHex: opts.gatewayDbKeyHex } : {}),
      ...(opts.indexDbKeyHex ? { indexDbKeyHex: opts.indexDbKeyHex } : {}),
    };
    this.post(init);

    // Watchdog: if we don't see a heartbeat within the warn gap, log a
    // warning so the wedge is visible without needing to tail the worker.
    // Indexer heartbeats are timer-driven and get pushed back during long
    // runs of native embedder calls, so the threshold is generous — the
    // goal is to flag genuine wedges (no progress at all), not to moan
    // every time the 4-slot pool saturates.
    const warnGap = opts.heartbeatWarnGapMs ?? 5 * 60_000;
    this.lastHeartbeat = Date.now();
    this.heartbeatCheck = setInterval(
      () => {
        const gap = Date.now() - this.lastHeartbeat;
        if (gap > warnGap) {
          log.warn(`indexer worker heartbeat gap: ${gap}ms (threshold ${warnGap}ms)`);
        }
      },
      Math.max(warnGap / 2, 5_000),
    );
    this.heartbeatCheck.unref?.();
  }

  /** Wait for the embedder to finish loading. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /**
   * Latest docs/sec indexing throughput reported by the worker, or null
   * before enough signal has accumulated. Cached from `indexer.cycle`
   * `jobUpdate` stats; no postMessage round-trip on read.
   */
  get indexRatePerSec(): number | null {
    return this._indexRatePerSec;
  }

  /** Boot-phase progress from the worker. null before first report. */
  get bootProgress(): {
    stage: "hnsw-backfill" | "loading-model" | "warmup" | "initial-cycle";
    progress: number;
  } | null {
    return this._bootProgress;
  }

  async embed(_texts: string[]): Promise<Float32Array[]> {
    // Batch embedding is only used by the indexer cycle itself — which
    // lives inside the worker. Main-thread callers should only use
    // embedQuery(). Surface misuse clearly instead of silently serialising.
    throw new Error(
      "IndexerWorkerProxy.embed() is not available on the main thread — call embedQuery() for search",
    );
  }

  async embedQuery(query: string): Promise<Float32Array> {
    // Phase-0 instrumentation: if `OMNESIS_SEARCH_EMBED_STUB=1`,
    // bypass the indexer worker entirely and return a deterministic
    // unit vector. Lets us measure search latency with the embedder
    // path eliminated — the canonical "is the embedder the cause?"
    // experiment from the Phase-0 plan (E7). The stub still returns
    // a valid 768-dim Float32 so HNSW search runs against real data.
    if (process.env.OMNESIS_SEARCH_EMBED_STUB === "1") {
      return stubQueryEmbedding(query);
    }
    const id = this.nextId++;
    const req = new PendingRequest<Float32Array>(EMBED_QUERY_TIMEOUT_MS, () => {
      const p = this.pending.get(id);
      if (p && this.pending.delete(id)) {
        this.pendingProfilers.delete(id);
        p.fail(new Error(`embedQuery timed out after ${EMBED_QUERY_TIMEOUT_MS}ms`));
      }
    });
    this.pending.set(id, req);
    // Captured here, in the caller's async chain (see pendingProfilers).
    const profiler = ambientAnswerProfiler();
    if (profiler) this.pendingProfilers.set(id, profiler);
    // Send the raw query — the worker-side embedder owns the task
    // prefix (family-aware, gated by `search.embedderPrefixes.enabled`),
    // so prefixing here would double up under the flag.
    //
    // Phase-0 instrumentation: tag the message with main-side send
    // time so the worker can report `ipcInMs` (queue wait on the
    // message channel) and `computeMs` (actual embed time) separately
    // on its result. The proxy logs the split on slow embeds.
    this.post({ type: "embedQuery", id, text: query, sentAtMs: Date.now() });
    return req.promise;
  }

  /**
   * Wake the indexer. Fire-and-forget signal that a fresh document just
   * landed in the gateway DB, so the worker should run a cycle now instead
   * of waiting for the next periodic tick. The main-thread scheduler debounces
   * bursts; the worker coalesces wakes that arrive while a cycle is in flight.
   *
   * Safe to call before `whenReady()` resolves — the worker may drop wakes
   * before its state exists. IndexerLifecycle sends one reconciliation wake
   * after publishing the ready proxy, closing that startup window.
   */
  wake(): void {
    this.post({ type: "wake" });
  }

  /**
   * Hot-reload the per-source maxAge map. Fire-and-forget; the worker swaps
   * its current map atomically. Safe to call before `whenReady()` resolves
   * — the worker buffers updateCutoffs until init completes... actually no,
   * the worker stores `currentCutoffs` at module scope so this is safe even
   * pre-init: the next cycle will read whatever was last set.
   */
  updateCutoffs(cutoffs: IndexerCutoffMap): void {
    this.post({ type: "updateCutoffs", cutoffs });
  }

  /**
   * Operator-triggered reindexMissing. Round-trips to the worker so the
   * scan + re-index runs off the main thread (same as the timer-driven
   * path). Wrapped in the standard pending-request pattern; rejects on
   * timeout so a wedged worker doesn't leak a promise.
   */
  async reindexMissing(): Promise<{ indexed: number; errors: number }> {
    const id = this.nextId++;
    const req = new PendingRequest<{ indexed: number; errors: number }>(
      REINDEX_MISSING_TIMEOUT_MS,
      () => {
        const p = this.pendingReindex.get(id);
        if (p && this.pendingReindex.delete(id)) {
          p.fail(new Error(`reindexMissing timed out after ${REINDEX_MISSING_TIMEOUT_MS}ms`));
        }
      },
    );
    this.pendingReindex.set(id, req);
    this.post({ type: "runReindexMissing", id });
    return req.promise;
  }

  /**
   * Delete all index data for a source through the worker so it's serialized
   * against indexing cycles (owning the live usearch write handle). Callers
   * use this instead of the HTTP-thread `deleteIndexBySource` so a source
   * deletion can't race an in-flight backfill — see {@link IndexWriteGate}
   * and the worker's `handleDeleteSourceIndex`. Resolves with the number of
   * indexed documents removed. Rejects on timeout so a wedged worker doesn't
   * leak a promise.
   */
  async deleteSourceIndex(sourceId: string): Promise<number> {
    const id = this.nextId++;
    const req = new PendingRequest<number>(DELETE_SOURCE_INDEX_TIMEOUT_MS, () => {
      const p = this.pendingDeleteSource.get(id);
      if (p && this.pendingDeleteSource.delete(id)) {
        p.fail(new Error(`deleteSourceIndex timed out after ${DELETE_SOURCE_INDEX_TIMEOUT_MS}ms`));
      }
    });
    this.pendingDeleteSource.set(id, req);
    this.post({ type: "deleteSourceIndex", id, sourceId });
    return req.promise;
  }

  async deleteDocumentIndexBatch(
    documentId: string,
    limit: number,
    sourceDeleted: boolean,
  ): Promise<{ deletedChunks: number; complete: boolean; readyForSourceDelete: boolean }> {
    const id = this.nextId++;
    const request = new PendingRequest<{
      deletedChunks: number;
      complete: boolean;
      readyForSourceDelete: boolean;
    }>(DELETE_SOURCE_INDEX_TIMEOUT_MS, () => {
      const pending = this.pendingDeleteDocument.get(id);
      if (pending && this.pendingDeleteDocument.delete(id)) {
        pending.fail(
          new Error(`deleteDocumentIndexBatch timed out after ${DELETE_SOURCE_INDEX_TIMEOUT_MS}ms`),
        );
      }
    });
    this.pendingDeleteDocument.set(id, request);
    this.post({ type: "deleteDocumentIndexBatch", id, documentId, limit, sourceDeleted });
    return request.promise;
  }

  /**
   * Quiesce the worker's indexing for a graceful embedder swap and
   * resolve once the worker confirms the corpus is frozen (its `pausedAck`,
   * sent after any in-flight cycle drains). The model stays loaded and
   * `embedQuery` keeps answering throughout, so when this worker is also the
   * search query embedder (a LOCAL old model) search stays live under the old
   * model right up to the swap's atomic flip. Reuses the standard pending-request
   * pattern so a wedged worker rejects on timeout rather than leaking a promise.
   */
  async pauseIndexing(): Promise<void> {
    const id = this.nextId++;
    const req = new PendingRequest<void>(REINDEX_MISSING_TIMEOUT_MS, () => {
      const p = this.pendingPause.get(id);
      if (p && this.pendingPause.delete(id)) {
        p.fail(new Error(`pauseIndexing timed out after ${REINDEX_MISSING_TIMEOUT_MS}ms`));
      }
    });
    this.pendingPause.set(id, req);
    this.post({ type: "pauseIndexing", id });
    return req.promise;
  }

  /**
   * Terminally stop indexing and force a final HNSW save so the on-disk graph (and
   * `usearch_saved_seq`) reflect the current in-memory graph. Called by the
   * gateway shutdown BEFORE {@link dispose} so the save — which can exceed the
   * 5s dispose ack for a large graph — runs on its own generous budget. Resolves
   * `true` if the graph was saved, `false` if the save threw (the gateway
   * proceeds either way; a false just means the next boot rebuilds). On a genuine
   * hang it rejects on timeout, and the caller treats that like a false.
   */
  async flushSave(): Promise<boolean> {
    const id = this.nextId++;
    const req = new PendingRequest<boolean>(FLUSH_SAVE_TIMEOUT_MS, () => {
      const p = this.pendingFlushSave.get(id);
      if (p && this.pendingFlushSave.delete(id)) {
        p.fail(new Error(`flushSave timed out after ${FLUSH_SAVE_TIMEOUT_MS}ms`));
      }
    });
    this.pendingFlushSave.set(id, req);
    this.post({ type: "flushSave", id });
    return req.promise;
  }

  /**
   * Un-pause indexing after {@link pauseIndexing}. Fire-and-forget:
   * used when a newer swap abandons the in-flight build, so the still-active
   * generation's worker resumes ingesting rather than being left quiesced.
   */
  resumeIndexing(): void {
    this.post({ type: "resumeIndexing" });
  }

  async dispose(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(new Error("indexer worker shut down before becoming ready"));
    }
    this.shutdownPromise = (async () => {
      if (this.heartbeatCheck) clearInterval(this.heartbeatCheck);
      try {
        if (!this.workerExited) this.post({ type: "shutdown" });
      } catch {
        // An already-exited worker is handled by workerExit below.
      }

      // Fallback: if the worker doesn't ack shutdown within 5s, terminate it
      // ourselves so gateway shutdown isn't blocked by a wedged embedder.
      const fallback = setTimeout(() => {
        log.warn("indexer worker shutdown timed out — terminating");
        void this.worker.terminate().catch(() => {});
      }, 5_000);
      fallback.unref?.();

      // A shutdownComplete message only means the worker posted its ack. Wait
      // for the actual exit so callers may safely encrypt/remove sidecars.
      await this.workerExit;
      clearTimeout(fallback);

      // Reject any still-pending requests only after the worker can no longer
      // post a successful result for them.
      for (const [, p] of this.pending) {
        p.fail(new Error("indexer worker shut down"));
      }
      this.pending.clear();
      for (const [, p] of this.pendingReindex) {
        p.fail(new Error("indexer worker shut down"));
      }
      this.pendingReindex.clear();
      for (const [, p] of this.pendingDeleteSource) {
        p.fail(new Error("indexer worker shut down"));
      }
      this.pendingDeleteSource.clear();
      for (const [, p] of this.pendingDeleteDocument) {
        p.fail(new Error("indexer worker shut down"));
      }
      this.pendingDeleteDocument.clear();
      for (const [, p] of this.pendingPause) {
        p.fail(new Error("indexer worker shut down"));
      }
      this.pendingPause.clear();
      for (const [, p] of this.pendingFlushSave) {
        p.fail(new Error("indexer worker shut down"));
      }
      this.pendingFlushSave.clear();
    })();
    return this.shutdownPromise;
  }

  private post(msg: MainToIndexer): void {
    this.worker.postMessage(msg);
  }

  private handleMessage(msg: IndexerToMain): void {
    switch (msg.type) {
      case "ready":
        this.lastHeartbeat = Date.now();
        if (!this.readySettled) {
          this.readySettled = true;
          this.resolveReady();
        }
        log.info("indexer worker ready");
        break;
      case "initError":
        if (!this.readySettled) {
          this.readySettled = true;
          this.rejectReady(new Error(msg.error));
        }
        break;
      case "heartbeat":
        this.lastHeartbeat = msg.ts;
        break;
      case "log": {
        const child = createLogger(msg.component);
        child[msg.level](msg.message);
        break;
      }
      case "embedQueryResult": {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          // Phase-0 instrumentation: log slow embeds with their
          // IPC / compute split. A long `ipcInMs` means the worker
          // was busy when our message arrived (e.g. a batch embed
          // is in flight) — that's the embedder-contention
          // hypothesis fingerprint. A long `computeMs` means the
          // embed itself is slow (e.g. cold Metal slot).
          const totalMs = msg.ipcInMs + msg.computeMs;
          if (totalMs > 200) {
            log.warn(
              `Slow embedQuery ${totalMs}ms (ipcIn=${msg.ipcInMs}ms compute=${msg.computeMs}ms)`,
            );
          }
          // The profiler rode in on the pending entry (see embedQuery):
          // the ambient store is unreachable from this handler.
          const profiler = this.pendingProfilers.get(msg.id);
          this.pendingProfilers.delete(msg.id);
          profiler?.recordQueueSpan("embedder", msg.ipcInMs, msg.computeMs);
          pending.settle(new Float32Array(msg.vector));
        }
        break;
      }
      case "embedQueryError": {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          pending.fail(new Error(msg.error));
        }
        break;
      }
      case "runReindexMissingResult": {
        const pending = this.pendingReindex.get(msg.id);
        if (pending) {
          this.pendingReindex.delete(msg.id);
          pending.settle({ indexed: msg.indexed, errors: msg.errors });
        }
        break;
      }
      case "runReindexMissingError": {
        const pending = this.pendingReindex.get(msg.id);
        if (pending) {
          this.pendingReindex.delete(msg.id);
          pending.fail(new Error(msg.error));
        }
        break;
      }
      case "deleteSourceIndexResult": {
        const pending = this.pendingDeleteSource.get(msg.id);
        if (pending) {
          this.pendingDeleteSource.delete(msg.id);
          pending.settle(msg.deleted);
        }
        break;
      }
      case "deleteSourceIndexError": {
        const pending = this.pendingDeleteSource.get(msg.id);
        if (pending) {
          this.pendingDeleteSource.delete(msg.id);
          pending.fail(new Error(msg.error));
        }
        break;
      }
      case "deleteDocumentIndexBatchResult": {
        const pending = this.pendingDeleteDocument.get(msg.id);
        if (pending) {
          this.pendingDeleteDocument.delete(msg.id);
          pending.settle({
            deletedChunks: msg.deletedChunks,
            complete: msg.complete,
            readyForSourceDelete: msg.readyForSourceDelete,
          });
        }
        break;
      }
      case "deleteDocumentIndexBatchError": {
        const pending = this.pendingDeleteDocument.get(msg.id);
        if (pending) {
          this.pendingDeleteDocument.delete(msg.id);
          pending.fail(new Error(msg.error));
        }
        break;
      }
      case "pausedAck": {
        const pending = this.pendingPause.get(msg.id);
        if (pending) {
          this.pendingPause.delete(msg.id);
          pending.settle(undefined);
        }
        break;
      }
      case "flushSaveComplete": {
        const pending = this.pendingFlushSave.get(msg.id);
        if (pending) {
          this.pendingFlushSave.delete(msg.id);
          pending.settle(msg.ok);
        }
        break;
      }
      case "bootProgress":
        this._bootProgress = { stage: msg.stage, progress: msg.progress };
        break;
      case "jobUpdate":
        this.handleJobUpdate(msg);
        break;
      case "shutdownComplete":
        void this.worker.terminate().catch(() => {});
        break;
    }
  }

  /**
   * Hydrate the per-job state from a worker `jobUpdate` message. The
   * BackgroundJob adapters returned by `createBackgroundJobs()` close
   * over the proxy and read from this state on every `observe()` —
   * pure in-memory; no DB hit, no postMessage round-trip.
   */
  private handleJobUpdate(msg: IndexerJobUpdate): void {
    const existing = this.workerJobs.get(msg.jobId);
    const j: WorkerJobState = existing ?? {
      inFlight: false,
      runs: 0,
      errors: 0,
      durations: [],
    };
    j.lastTrigger = msg.trigger;
    if (msg.phase === "started") {
      j.lastStartedAt = msg.ts;
      j.inFlight = true;
    } else if (msg.phase === "completed") {
      j.lastCompletedAt = msg.ts;
      j.inFlight = false;
      j.runs += 1;
      if (msg.stats) {
        j.lastStats = msg.stats;
        if (typeof msg.stats.durationMs === "number") {
          j.durations.push(msg.stats.durationMs);
          if (j.durations.length > WORKER_JOB_DURATION_RING) {
            j.durations.shift();
          }
        }
        // The cycle job is the only one that carries throughput; cache
        // the latest figure (undefined when the worker's window lacks
        // signal — leave the previous rate untouched in that case so a
        // brief idle cycle doesn't blank a known-good ETA).
        if (msg.jobId === "indexer.cycle" && typeof msg.stats.indexRatePerSec === "number") {
          this._indexRatePerSec = msg.stats.indexRatePerSec;
        }
      }
    } else if (msg.phase === "errored") {
      j.lastErroredAt = msg.ts;
      j.inFlight = false;
      j.errors += 1;
      if (msg.error) {
        j.lastError = { message: msg.error, at: msg.ts };
      }
    }
    this.workerJobs.set(msg.jobId, j);
  }

  /**
   * Build the three worker-hosted `BackgroundJob` instances that the
   * registry should track. Called once at boot; the returned objects
   * close over the proxy so they pick up live updates without further
   * wiring.
   *
   * Pre-seeds an empty `WorkerJobState` per id so the registry's first
   * `observe()` returns the proper progress shape (`scan` with
   * coverage=1) immediately, rather than the fallback `stateless` row
   * that would render as "no progress concept" until the first
   * worker `jobUpdate` arrives — that's >0s for the cycle and up to
   * 1 hour for reconcile-deleted / reindex-missing.
   */
  createBackgroundJobs(): BackgroundJob[] {
    const ids: IndexerWorkerJobId[] = [
      "indexer.cycle",
      "indexer.reconcile-deleted",
      "indexer.reindex-missing",
    ];
    for (const id of ids) {
      if (!this.workerJobs.has(id)) {
        this.workerJobs.set(id, {
          inFlight: false,
          runs: 0,
          errors: 0,
          durations: [],
        });
      }
    }
    return [
      this.makeWorkerJob("indexer.cycle", {
        displayName: "Indexer cycle",
        description:
          "Embeds new and updated documents into the vector index. Driven by a periodic timer plus wake signals from POST /documents.",
        cadence: { mode: "continuous", nominalIntervalMs: this.opts.indexIntervalMs },
      }),
      this.makeWorkerJob("indexer.reconcile-deleted", {
        displayName: "Indexer reconcile-deleted",
        description:
          "Sweeps the index for chunks whose documents were deleted from the gateway DB and removes them.",
        cadence: { mode: "periodic", intervalMs: this.opts.reconcileIntervalMs },
      }),
      this.makeWorkerJob("indexer.reindex-missing", {
        displayName: "Indexer reindex-missing",
        description:
          "Hourly double-scan that re-embeds documents which slipped through prior cycles (e.g. transient errors).",
        cadence: {
          mode: "periodic",
          intervalMs: this.opts.reindexMissingIntervalMs,
        },
      }),
    ];
  }

  private makeWorkerJob(
    id: IndexerWorkerJobId,
    meta: {
      displayName: string;
      description: string;
      cadence: BackgroundJob["cadence"];
    },
  ): BackgroundJob {
    const proxy = this;
    return {
      id,
      displayName: meta.displayName,
      description: meta.description,
      category: "indexer",
      cadence: meta.cadence,
      observe(): JobObservation {
        const j = proxy.workerJobs.get(id);
        if (!j) {
          return {
            state: "unknown",
            inFlight: false,
            ticksLastHour: 0,
            avgTickMs: 0,
            p99TickMs: 0,
            progress: { kind: "stateless" },
          };
        }
        const state: JobState = j.inFlight
          ? "running"
          : j.lastErroredAt && (!j.lastCompletedAt || j.lastErroredAt > j.lastCompletedAt)
            ? "erroring"
            : j.runs === 0
              ? "unknown"
              : recencyState(j, meta.cadence);
        const sortedDurations = [...j.durations].sort((a, b) => a - b);
        const avgTickMs =
          sortedDurations.length > 0
            ? Math.round(
                (sortedDurations.reduce((a, b) => a + b, 0) / sortedDurations.length) * 100,
              ) / 100
            : 0;
        const p99TickMs =
          sortedDurations.length > 0
            ? sortedDurations[
                Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * 0.99))
              ]
            : 0;
        return {
          state,
          inFlight: j.inFlight,
          lastTickAt: j.lastCompletedAt ?? j.lastErroredAt ?? j.lastStartedAt,
          lastTickElapsedMs: j.lastStats?.durationMs,
          lastError: j.lastError,
          // Ring buffer is 100 entries; for a hard "last hour" cap we'd
          // need timestamps per duration. For Phase 1 the ring serves as
          // a soft window — at 1 cycle/min that's ~100 mins coverage.
          ticksLastHour: j.runs,
          avgTickMs,
          p99TickMs,
          progress: buildWorkerProgress(id, j),
        };
      },
    };
  }
}

/**
 * Heuristic state for a worker job that's not currently running or
 * erroring. Looks at how recent the last run was relative to the
 * cadence. Same shape as `deriveState` in scheduler-job.ts but adapted
 * for the worker's continuous mode.
 */
function recencyState(j: WorkerJobState, cadence: BackgroundJob["cadence"]): JobState {
  const last = j.lastCompletedAt ?? j.lastErroredAt ?? j.lastStartedAt;
  if (!last) return "unknown";
  const ageMs = Date.now() - last;
  const expectedMs =
    cadence.mode === "periodic"
      ? cadence.intervalMs
      : cadence.mode === "continuous"
        ? (cadence.nominalIntervalMs ?? 60_000)
        : 60_000;
  // If we've gone 3× the cadence with no run, mark idle (loop is alive
  // but has nothing to do or is not being woken). Any sooner = running.
  return ageMs < expectedMs * 3 ? "running" : "idle";
}

/**
 * Build the `progress` field for a worker job. All three indexer jobs
 * are sweep-shaped: each run walks documents and reports how many it
 * touched. We don't push the actual watermark cursor from the worker
 * (it lives in index.db; would need its own message), so we surface
 * `kind: "scan"` with `lastSweepCompletedAt` + `itemsAffectedLastSweep`
 * — honest about what we know, doesn't fabricate a fake percentage.
 *
 * For the indexer cycle specifically `itemsAffectedLastSweep` =
 * indexed + updated from the last cycle (the meaningful "what
 * changed" metric); for reconcile-deleted there's no per-run count
 * yet so we leave it undefined; for reindex-missing it's the
 * `indexed` count from the last pass.
 */
function buildWorkerProgress(
  id: IndexerWorkerJobId,
  j: WorkerJobState,
): JobObservation["progress"] {
  let affected: number | undefined;
  if (id === "indexer.cycle" && j.lastStats) {
    const indexed = j.lastStats.indexed ?? 0;
    const updated = j.lastStats.updated ?? 0;
    affected = indexed + updated;
  } else if (typeof j.lastStats?.indexed === "number") {
    affected = j.lastStats.indexed;
  }
  // Coverage reflects sweep history, not transient in-flight status.
  // Once a sweep has ever completed we report 100% — "we have an
  // up-to-date view" — even if a fresh sweep is currently in flight.
  // Mid-flight is conveyed separately via JobObservation.inFlight
  // and the state pill, so doubling up here just makes coverage
  // flip 100% → 0% → 100% on every cycle (jarring noise).
  const coverage = j.lastCompletedAt ? 1 : 0;
  return {
    kind: "scan",
    coverage,
    lastSweepCompletedAt: j.lastCompletedAt,
    itemsAffectedLastSweep: affected,
  };
}

const STUB_DIM = 768;
/**
 * Phase-0 instrumentation. Returns a deterministic 768-dim unit
 * vector derived from a hash of the query text. The stub keeps HNSW
 * search driven by query content (different queries → different
 * candidates) while eliminating the indexer-worker IPC + Metal
 * compute from the latency budget. Gated by
 * `OMNESIS_SEARCH_EMBED_STUB=1`.
 */
function stubQueryEmbedding(query: string): Float32Array {
  let h = 0;
  for (let i = 0; i < query.length; i++) {
    h = Math.imul(h ^ query.charCodeAt(i), 0x01000193) >>> 0;
  }
  const v = new Float32Array(STUB_DIM);
  for (let i = 0; i < STUB_DIM; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    v[i] = ((h & 0xffff) / 0x10000) * 2 - 1;
  }
  let norm = 0;
  for (let i = 0; i < STUB_DIM; i++) norm += v[i] * v[i];
  const inv = 1 / Math.sqrt(norm || 1);
  for (let i = 0; i < STUB_DIM; i++) v[i] *= inv;
  return v;
}
