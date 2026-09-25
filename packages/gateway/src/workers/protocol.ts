// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Message types for gateway worker threads.
 *
 * Three workers, all driven by the Scheduler (see `scheduler/`):
 *   - indexer-worker: owns the embedding model + indexer cycle; proxies
 *     embedQuery() back to main for search.
 *   - writer-worker:  single writable better-sqlite3 handle on
 *                     omnesis.db; runs every mutation.
 *   - compute-worker: read-only sibling of the writer worker; runs
 *                     SELECT-side halves of compute/upsert splits.
 *
 * The historical backfill-worker (which had its own bespoke loop
 * scaffolding) is gone — its work now lives as PeriodicTasks on the
 * Scheduler, dispatched to the compute + writer runners.
 */

import { sourceSettingKeys } from "@omnesis/config";
import type { EmbedderEncoding } from "../indexer/embedder-prefixes.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type WorkerLogMessage = {
  type: "log";
  level: LogLevel;
  component: string;
  message: string;
};

// ── Indexer worker ────────────────────────────────────────────────────

/**
 * Resolved per-source maxAge map shipped to the indexer worker.
 * `default` = global fallback (sources.default.maxAge ?? dataRetention.maxAge).
 * Other keys = per-source overrides keyed by full sourceId.
 * Values are duration strings; null = no cutoff.
 *
 * Worker computes ISO cutoffs lazily at filter time so a long-running cycle
 * doesn't carry a stale cutoff relative to wall-clock.
 */
export type IndexerCutoffMap = {
  default: string | null;
  perSource: Record<string, string | null>;
};

/**
 * The `maxAge` that applies to `sourceId` under a cutoff map: the most
 * specific `sources.*` key that addresses it wins — an account-qualified
 * instance id over the bare source type — then the map's default. `null`
 * means no cutoff.
 */
export function resolveIndexerCutoffMaxAge(
  cutoffs: IndexerCutoffMap,
  sourceId: string,
): string | null {
  const keys = sourceSettingKeys(sourceId);
  for (let i = keys.length - 1; i >= 0; i--) {
    const override = cutoffs.perSource[keys[i]];
    if (override !== undefined) return override;
  }
  return cutoffs.default;
}

export type IndexerInit = {
  type: "init";
  modelPath: string;
  /**
   * Canonical embed-model identity used to detect a swap that bypassed the
   * runtime config-change path. Produced by `canonicalEmbedIdentity` — the
   * SAME function the swap path stamps with — so the value the worker
   * compares against `index_meta` is byte-identical to what the swap wrote
   * (no backend-prefixed-vs-bare drift; see #698). It is an identity string
   * only, NOT the embedder's served model id (HTTP uses `httpEmbedderModel`;
   * local loads from `modelPath`). The worker compares `(modelName, embedDim)`
   * against the stamp and runs a `wipeAndRecreateVectorIndex` before the
   * first cycle on mismatch. Without this, three real cases bypass the
   * configStore-only detection: env-override edits while the gateway is down,
   * a model file replaced with a same-name file at a different dimension, and
   * fresh installs whose stamp is missing.
   */
  modelName: string;
  embedDim: number;
  gatewayDbPath: string;
  gatewayDbKeyHex?: string;
  indexDbPath: string;
  indexDbKeyHex?: string;
  cutoffs: IndexerCutoffMap;
  indexIntervalMs: number;
  /** Shortened cycle interval when the previous cycle found work, ms. */
  indexBacklogIntervalMs: number;
  /** Docs per batch transaction in the indexer DB write phase. */
  dbWriteBatchSize: number;
  reconcileIntervalMs: number;
  reindexMissingIntervalMs: number;
  heartbeatIntervalMs: number;
  /** Resolved from config/env at gateway boot. */
  embedConcurrency: number;
  /** Docs per listDocuments page during indexer cycles. */
  indexerPageSize: number;
  /** Sleep between indexer pages under backlog, ms. */
  indexerBetweenPageSleepMs: number;
  /** Whether to run the heavy reindexMissing scan once at boot. */
  reindexMissingAtBoot: boolean;
  /** Chunker max chunk length, chars. See `indexer.chunker.chunkSize`. */
  chunkerChunkSize: number;
  /** Chunker per-chunk overlap, chars. See `indexer.chunker.overlap`. */
  chunkerOverlap: number;
  /** Embedder per-slot context size, tokens. See `indexer.embedder.contextSize`. */
  embedderContextSize: number;
  /** Embedder per-call wall-clock timeout, ms. See `indexer.embedder.timeoutMs`. */
  embedderTimeoutMs: number;
  /** Embedder hard cap on input length, chars. See `indexer.embedder.maxInputChars`. */
  embedderMaxInputChars: number;
  /**
   * Low-disk write guard (#15). Free megabytes on the index.db volume below
   * which the worker SKIPS an indexing cycle (no embed/write) rather than
   * risk a partial usearch/SQLite flush under low disk. Unindexed docs stay
   * pending; the next wake retries once disk frees. Resolved at boot from
   * `gateway.minFreeDiskMb` (default 500).
   */
  minFreeDiskMb: number;
  /**
   * Per-model retrieval encoding (#718): none | text-prefix | api-param.
   * Resolved at boot from `search.embedderPrefixes.enabled` × the family /
   * provider detected from the embedder model. A plain discriminated union of
   * primitives — structured-clone carries it losslessly over postMessage.
   */
  embedderEncoding: EmbedderEncoding;
  /** Path for the usearch HNSW index file. */
  usearchIndexPath: string;
  /** Optional cold-backfill page size; production uses the write handle default. */
  usearchBackfillPageSize?: number;
  /** When set, use HttpEmbedder instead of LlamaCppEmbedder. */
  httpEmbedderUrl?: string;
  /** Model name for the HTTP embedder (auto-discovered if omitted). */
  httpEmbedderModel?: string;
  /** API key for the HTTP embedder backend (Bearer token). */
  httpEmbedderApiKey?: string;
  /** API path prefix for the HTTP embedder backend (default "/v1"). */
  httpEmbedderApiPathPrefix?: string;
  /** Permit non-loopback HTTP inference for the HTTP embedder. */
  httpEmbedderAllowRemoteInference?: boolean;
};

export type MainToIndexer =
  | IndexerInit
  | { type: "embedQuery"; id: number; text: string; sentAtMs: number }
  | { type: "runReindexMissing"; id: number }
  // Remove all index data for a source (chunks, indexed_documents,
  // index_totals, HNSW vectors), serialized against indexing cycles inside
  // the worker so a source deletion can't race an in-flight backfill and
  // leave orphan index rows / a corrupt usearch sidecar. Owns the write
  // handle, so it removes vectors directly and saves — no enqueue-and-drain.
  | { type: "deleteSourceIndex"; id: number; sourceId: string }
  | {
      type: "deleteDocumentIndexBatch";
      id: number;
      documentId: string;
      limit: number;
      sourceDeleted: boolean;
    }
  // Fire-and-forget wake. Sent when fresh documents land via POST /documents
  // so the indexer can pick them up without waiting for the next periodic
  // tick. Worker debounces bursts and coalesces while a cycle is in flight.
  | { type: "wake" }
  // Hot-reload of per-source maxAge map. Sent on every config.changed where
  // dataRetention or sources.<id>.maxAge moved. Worker swaps the map atomically.
  | { type: "updateCutoffs"; cutoffs: IndexerCutoffMap }
  // Quiesce-but-stay-alive for the graceful embedder swap (epic #1011). When the
  // OLD model is a LOCAL in-process embedder it lives inside THIS worker, which
  // is therefore also the search query embedder. A graceful swap must freeze the
  // `chunks` corpus before its catch-up + flip, but must NOT take query embedding
  // offline. `pauseIndexing` stops the indexing cycle (the next ack confirms any
  // in-flight cycle has drained) yet keeps the model loaded and `embedQuery`
  // answering, so search stays live under the old model right up to the atomic
  // flip. `resumeIndexing` un-pauses (used when a newer swap abandons the build).
  | { type: "pauseIndexing"; id: number }
  | { type: "resumeIndexing" }
  // Freeze indexing and force a final HNSW save so the on-disk plaintext graph
  // (and `usearch_saved_seq`) reflect the current in-memory graph. Sent by the
  // gateway shutdown BEFORE `shutdown`, on its own generous timeout, so a large
  // save can't be cut short by the 5s dispose ack — otherwise the next boot
  // rebuilds (~18 min) instead of restoring from the sidecar / plaintext file.
  | { type: "flushSave"; id: number }
  | { type: "shutdown" };

/** Stable IDs for the worker-hosted background jobs surfaced to /admin/background-jobs. */
export type IndexerWorkerJobId =
  | "indexer.cycle"
  | "indexer.reconcile-deleted"
  | "indexer.reindex-missing";

/**
 * Worker → main update on a worker-hosted background job. Sent at each
 * phase transition so the proxy can keep a precise observation without
 * polling the worker.
 *
 *   - `phase: "started"`  — fresh run begins; observers see inFlight=true
 *   - `phase: "completed"`— run finished successfully; `stats` carries
 *                           the post-run counts and `durationMs`
 *   - `phase: "errored"`  — run threw; `error` carries the message
 *
 * `trigger` records *why* a cycle ran so observers can tell apart a
 * timer tick from a wake-driven catch-up. Only meaningful for the
 * cycle job; reconcile / reindex-missing always tick on a timer.
 */
export type IndexerJobUpdate = {
  type: "jobUpdate";
  jobId: IndexerWorkerJobId;
  ts: number;
  phase: "started" | "completed" | "errored";
  trigger?: "timer" | "wake" | "boot" | "operator";
  stats?: {
    indexed?: number;
    updated?: number;
    skipped?: number;
    errors?: number;
    durationMs?: number;
    /**
     * Docs-per-second throughput derived from a rolling window of recent
     * cycles (see `indexer-rate.ts`). Only set on `indexer.cycle`
     * `completed` updates, and only once the window has enough signal
     * (≥2 samples spanning a few seconds with positive progress);
     * undefined otherwise. The main-thread proxy caches the latest value
     * so `/index/stats` can serve a server-side ETA on first load.
     */
    indexRatePerSec?: number;
  };
  error?: string;
};

export type IndexerToMain =
  | { type: "ready" }
  | { type: "initError"; error: string }
  | { type: "heartbeat"; ts: number }
  | WorkerLogMessage
  | {
      type: "embedQueryResult";
      id: number;
      vector: number[];
      /** ms between main's `sentAtMs` (sent on the request) and worker recv */
      ipcInMs: number;
      /** ms spent inside the worker actually doing the embed compute */
      computeMs: number;
    }
  | { type: "embedQueryError"; id: number; error: string }
  | { type: "runReindexMissingResult"; id: number; indexed: number; errors: number }
  | { type: "runReindexMissingError"; id: number; error: string }
  | { type: "deleteSourceIndexResult"; id: number; deleted: number }
  | { type: "deleteSourceIndexError"; id: number; error: string }
  | {
      type: "deleteDocumentIndexBatchResult";
      id: number;
      deletedChunks: number;
      complete: boolean;
      readyForSourceDelete: boolean;
    }
  | { type: "deleteDocumentIndexBatchError"; id: number; error: string }
  // Confirms a `pauseIndexing` request: indexing is paused AND any cycle that
  // was in flight when the pause arrived has fully drained, so the `chunks`
  // corpus is now frozen for the graceful swap's catch-up (epic #1011).
  | { type: "pausedAck"; id: number }
  // Confirms a `flushSave` request: indexing is frozen, any in-flight cycle has
  // drained, and the HNSW graph has been saved to disk (stamping
  // `usearch_saved_seq`). `ok` is false if the save itself threw (the gateway
  // then proceeds; the next boot rebuilds, fail-safe).
  | { type: "flushSaveComplete"; id: number; ok: boolean }
  | IndexerJobUpdate
  | { type: "shutdownComplete" }
  | {
      /**
       * Boot-phase progress. Covers model weight loading (from
       * node-llama-cpp's onLoadProgress), HNSW backfill, and warmup.
       * `progress` is 0–1 within the current `stage`.
       */
      type: "bootProgress";
      stage: "hnsw-backfill" | "loading-model" | "warmup" | "initial-cycle";
      progress: number;
    };

// ── Writer worker ─────────────────────────────────────────────────────
// Generic call protocol: every write op is dispatched via {type:"call",
// op, args}. Typed methods on WriteGate map 1:1 to ops registered in
// the worker's dispatch table. Keeping the wire format generic avoids
// 35+ per-op message types; type safety lives on the runner + WriteOps
// registry side.

export type WriterInit = {
  type: "init";
  gatewayDbPath: string;
  gatewayDbKeyHex?: string;
  heartbeatIntervalMs: number;
  /** SQLite journal mode for omnesis.db. Resolved from config at boot. */
  journalMode: "WAL" | "TRUNCATE";
  /**
   * Shared atomic flag the worker polls inside yieldable ops. Scheduler
   * sets it via `PreemptBuffer.requestYield()` when a higher-priority
   * task arrives; worker-side `PreemptToken.requested()` returns true on
   * the same memory. When omitted, no preemption — `requested()` is
   * always false.
   */
  preemptBuffer?: SharedArrayBuffer;
};

export type WriterCall = {
  type: "call";
  id: number;
  op: string;
  args: unknown[];
  /**
   * Wall-clock ms (Date.now()) when the proxy called postMessage. The
   * worker subtracts its own dequeue time to compute queue wait — the
   * fairness signal we expose in the slow-log + /admin/metrics.
   */
  enqueueMs: number;
};

export type MainToWriter = WriterInit | WriterCall | { type: "shutdown" };

export type WriterResult =
  | {
      type: "result";
      id: number;
      ok: true;
      value: unknown;
      /** Time (ms) the call sat in the worker's FIFO before running. */
      queueMs: number;
      /** Time (ms) the worker actually spent inside the op handler. */
      execMs: number;
      /** CPU time (µs) the op consumed in user-space JS. */
      cpuUserUs: number;
      /** CPU time (µs) the op consumed in kernel syscalls. */
      cpuSystemUs: number;
    }
  | {
      type: "result";
      id: number;
      ok: false;
      /** Full remote stack when available; retained for diagnostics. */
      error: string;
      /** Structured identity used to restore trusted domain errors at their boundary. */
      errorName?: string;
      errorMessage?: string;
      errorCode?: string;
      queueMs: number;
      execMs: number;
      cpuUserUs: number;
      cpuSystemUs: number;
    };

export type WriterToMain =
  | { type: "ready" }
  | { type: "initError"; error: string }
  | { type: "heartbeat"; ts: number }
  | WorkerLogMessage
  | WriterResult
  | { type: "shutdownComplete" };

// ── Compute worker ────────────────────────────────────────────────────
// Read-only sibling of the writer worker. Owns a read-only handle on
// omnesis.db (and later analytics.db) and runs compute-heavy SELECT-side
// halves of compute/upsert splits (e.g. computePeopleCounts,
// computeLinkResolutions, selectMergeCandidates). Wire format mirrors
// the writer's generic call protocol — keep it boring; type safety
// lives on the runner side.

export type IoInit = {
  type: "init";
  gatewayDbPath: string;
  gatewayDbKeyHex?: string;
  heartbeatIntervalMs: number;
  /** OS nice for this background compute thread (resolved on the main thread). */
  backgroundWorkerNice: number;
  /** Page-cache budget in bytes for the read handle (defaults to 64 MiB). */
  cacheSizeBytes?: number;
};

// Compute call/result reuse the writer's shapes: same dispatch envelope
// (id, op, args, enqueueMs) and same reply shape. Aliasing avoids
// duplicating identical types and keeps the runner's asOutcome / queue
// metrics handling uniform across writer + compute.
export type IoCall = WriterCall;
export type IoResult = WriterResult;

export type MainToIo = IoInit | IoCall | { type: "shutdown" };

export type IoToMain =
  | { type: "ready" }
  | { type: "initError"; error: string }
  | { type: "heartbeat"; ts: number }
  | WorkerLogMessage
  | IoResult
  | { type: "shutdownComplete" };

// ── CPU worker ────────────────────────────────────────────────────────
// Pure-compute sibling of the io worker. No database handle —
// receives data via postMessage, returns results.

export type CpuInit = {
  type: "init";
  heartbeatIntervalMs: number;
  /** OS nice for this background compute thread (resolved on the main thread). */
  backgroundWorkerNice: number;
};

export type CpuCall = WriterCall;
export type CpuResult = WriterResult;

export type MainToCpu = CpuInit | CpuCall | { type: "shutdown" };

export type CpuToMain =
  | { type: "ready" }
  | { type: "initError"; error: string }
  | { type: "heartbeat"; ts: number }
  | WorkerLogMessage
  | CpuResult
  | { type: "shutdownComplete" };

// ── Build-embedder worker (epic #1011, graceful swap for a LOCAL target) ──
// Short-lived worker that hosts a single LOCAL (node-llama-cpp) embedder for
// the duration of a graceful double-buffered build whose TARGET model is local.
// The main-thread GenerationBuilder drives it through the BuildWorkerEmbedder
// proxy (which implements the indexer `Embedder` interface), so the CPU/GPU-
// bound re-embed of the corpus runs OFF the event loop and live search keeps
// serving the active generation throughout. Unlike the steady-state indexer
// worker this worker owns no DB handle and runs no indexing cycle — it is a
// pure embed service that is spawned at build start and torn down right after
// the atomic flip hands query embedding to the fresh steady-state worker.

export type BuildEmbedderInit = {
  type: "init";
  /** Path to the GGUF model file to host. */
  modelPath: string;
  /** Effective output dimension (MRL truncation target, when applicable). */
  embedDim: number;
  /** Per-model retrieval encoding (#718). Only the text-prefix branch applies locally. */
  embedderEncoding: EmbedderEncoding;
  /** Embedding-context pool size. */
  embedConcurrency: number;
  embedderContextSize: number;
  embedderTimeoutMs: number;
  embedderMaxInputChars: number;
};

export type MainToBuildEmbedder =
  | BuildEmbedderInit
  | { type: "embed"; id: number; texts: string[] }
  | { type: "embedQuery"; id: number; text: string }
  | { type: "shutdown" };

export type BuildEmbedderToMain =
  | { type: "ready" }
  | { type: "initError"; error: string }
  | WorkerLogMessage
  | { type: "embedResult"; id: number; vectors: number[][] }
  | { type: "embedError"; id: number; error: string }
  | { type: "embedQueryResult"; id: number; vector: number[] }
  | { type: "embedQueryError"; id: number; error: string }
  | { type: "shutdownComplete" };
