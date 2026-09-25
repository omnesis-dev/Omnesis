// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import {
  resolveModelDisplay,
  retry,
  type createLogger,
  type ResolvedAssignment,
} from "@omnesis/core";
import { IndexerWorkerProxy, buildIndexerCutoffMap } from "../workers/indexer-worker-proxy.js";
import { canonicalEmbedIdentity } from "./embed-identity.js";
import {
  cleanupStaleBuildingState,
  createBuildingIndexVersion,
  flipActiveIndexVersion,
  getActiveIndexVersion,
  getBuildableDocumentCount,
  getBuildingIndexVersion,
  getChunkCount,
  enqueueDocumentIndexPurge,
  enqueueSourceIndexPurge,
  nextIndexVersion,
  usearchPathForVersion,
} from "./db.js";
import { BuildAbortedError, GenerationBuilder } from "./generation-builder.js";
import { directIndexWriteGate, withFreshIndexWriteGate } from "./index-write-gate.js";
import { resolveEmbedderEncoding, type EmbedderEncoding } from "./embedder-prefixes.js";
import type { Embedder } from "./types.js";
import type { IndexerStatusReporter } from "./indexer-status.js";
import type { InferenceRegistry } from "../inference/registry.js";
import type { ConfigStore } from "../config-store.js";
import type { SearchPipeline } from "../search/pipeline.js";
import type { BackgroundJobsRegistry } from "../background-jobs/index.js";
import type { ResolvedRuntimeSettings } from "../runtime-settings.js";

/**
 * How an embedder swap transitions from the old model to the new one (#1011):
 *
 *   - `graceful` (default): the active index keeps serving every query under the
 *     old model while a second index is rebuilt under the new model in the
 *     background, then atomically flipped. Zero vector-search downtime, for ALL
 *     four {local,http}-old × {local,http}-new transitions: an HTTP target is
 *     re-embedded on the main thread via a non-blocking HTTP client, a LOCAL
 *     target via a short-lived off-main-thread build worker, and a LOCAL old
 *     model's query embedder is kept alive (paused) through the pre-flip
 *     quiesce. Falls back to the destructive path only when graceful is
 *     genuinely impossible: a first build with no active generation, or an empty
 *     corpus.
 *   - `hard`: a deliberate immediate cutover. Stop using the old model RIGHT NOW
 *     for both indexing and query embedding, then wipe-and-resync under the new
 *     model. Vector search drops to BM25-only for the rebuild's duration — the
 *     accepted trade-off when the point is to stop paying a cloud embedder (or
 *     drop a now-unwanted model) the instant the switch is confirmed.
 */
export type EmbedSwapMode = "graceful" | "hard";

const HTTP_EMBEDDER_PROBE_BASE_BACKOFF_MS = 10_000;
const HTTP_EMBEDDER_PROBE_MAX_BACKOFF_MS = 30_000;

function isTransientHttpEmbedderProbeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  if (err.name === "TimeoutError" || err instanceof TypeError) return true;

  const statusMatch = /\bHTTP (\d{3})\b/.exec(err.message);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  return /\b(?:ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|ETIMEDOUT)\b|fetch failed|network|socket|timed? ?out/i.test(
    err.message,
  );
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Indexer startup aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Indexer startup aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortableWait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Indexer startup aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new Error("Indexer startup aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * The mutable `/index/stats` snapshot of the active embed model. Held by
 * reference: `createServer` captures it as `indexerModel`, `ModelManager`'s
 * onBroadcast flips `.present` after an install, and `startIndexer` rewrites
 * `.name`/`.path`/`.present` once the embedder resolves. All three must alias
 * the SAME object — `IndexerLifecycle.modelInfo` returns the stored instance.
 */
export interface IndexerModelInfo {
  name: string;
  path: string;
  present: boolean;
  modelsDir: string;
}

/**
 * Collaborators the indexer lifecycle drives. Every entry is a long-lived
 * singleton constructed once in index.ts; pass the SAME instance — none of
 * these are re-created inside the lifecycle.
 */
export interface IndexerLifecycleDeps {
  /** Capability→backend resolver. loadConfig/resolve('embedder')/getBackendApiKey. */
  inferenceRegistry: InferenceRegistry;
  /** Live config store. .get() is read on every startIndexer/runEmbedSwap. */
  configStore: ConfigStore;
  /** The indexer readiness reporter. */
  indexerStatus: IndexerStatusReporter;
  /** Search pipeline; setEmbedder is driven from boot/swap. */
  searchPipeline: SearchPipeline;
  /** Background-jobs registry; registerAll(proxy.createBackgroundJobs()) after the worker is ready. */
  backgroundJobs: BackgroundJobsRegistry;
  /** Resolved runtime knobs (IndexerWorkerProxy opts + HttpEmbedder maxInputChars). */
  runtime: ResolvedRuntimeSettings;
  /**
   * The in-flight boot probe (inferenceRegistry.probeBackends().catch(...)).
   * startIndexer awaits THIS promise before resolving the embedder — pass the
   * shared promise, do not re-create probeBackends inside the lifecycle.
   */
  initialProbe: Promise<void>;
  /** Gateway logger (or a child). All moved log lines emit through it verbatim. */
  log: ReturnType<typeof createLogger>;
  /** Gateway DB path → IndexerWorkerProxy.gatewayDbPath. */
  gatewayDbPath: string;
  /** Hex-encoded gateway DB storage key, when live storage encryption is enabled. */
  gatewayDbKeyHex?: string;
  /** Index DB path → IndexerWorkerProxy.indexDbPath + withFreshIndexWriteGate target. */
  indexDbPath: string;
  /** Hex-encoded index DB storage key, when live storage encryption is enabled. */
  indexDbKeyHex?: string;
  /**
   * The shared writable `index.db` handle (the same one the read registry
   * reads from). Used on the main thread — never while the indexer worker is
   * the active writer — to resolve the active index generation's usearch path
   * at boot and to drive the graceful double-buffered embedder swap (#1011).
   */
  indexDb: import("better-sqlite3").Database;
  /** Config dir → `usearchPathForVersion(configDir, …)`. */
  configDir: string;
  /**
   * Boot-time seed for the mutable model-info snapshot. The lifecycle copies
   * these into its own stable internal object exposed by `modelInfo`; that
   * object is then mutated in place (never replaced) — its identity is
   * load-bearing because createServer captures it by reference.
   */
  initialModelInfo: IndexerModelInfo;
}

/**
 * Owns the embedding-indexer worker lifecycle: boot, model/embed swaps, and
 * shutdown. Holding it here keeps the boot file to wiring collaborators: the
 * few consumers that need the live proxy / model-info snapshot read it back
 * through getters rather than capturing an instance that a swap invalidates.
 *
 * Indexer runs in a dedicated worker so node-llama-cpp's CPU-bound native
 * inference can't starve the HTTP event loop. The worker owns the embedder +
 * indexer cycle + index.db writes; the gateway thread only round-trips
 * embedQuery() calls for interactive search.
 */
export class IndexerLifecycle {
  private readonly deps: IndexerLifecycleDeps;
  private readonly statusReporter: IndexerStatusReporter;
  private readonly log: ReturnType<typeof createLogger>;

  // Live worker proxy. Null until startIndexer() resolves, null again after a
  // swap or shutdown. Exposed via the `indexerProxy` getter; consumers read it
  // through a thunk so they always see the current value.
  private _indexerProxy: IndexerWorkerProxy | null = null;

  // Worker that currently owns index.db + the live usearch write handle.
  // Unlike `_indexerProxy`, this is published immediately after spawn, before
  // model warmup/readiness, so privacy deletes and shutdown never fall back to
  // a competing main-thread writer while a starting worker owns the files.
  private _indexerOwner: IndexerWorkerProxy | null = null;
  /** Disposal barrier that prevents a direct writer racing a draining worker. */
  private ownerDisposalInFlight: Promise<void> | null = null;

  // The /index/stats model snapshot — same object across the lifetime; mutated
  // in place by startIndexer and by ModelManager.onBroadcast.
  private readonly _modelInfo: IndexerModelInfo;

  // Handle for the indexer's shutdown function — populated asynchronously once
  // the embedder finishes loading. Null when startIndexer bailed early
  // (embedder disabled/unresolved/missing), which makes shutdownIndexer a no-op.
  private indexerShutdownHandle: (() => Promise<void>) | null = null;

  // Startup is single-flight so a concurrent config/model event cannot create
  // two index writers. The abort handle also lets shutdown cancel an HTTP
  // backend retry before any worker takes ownership of index.db.
  private startupInFlight: Promise<void> | null = null;
  private startupAbort: AbortController | null = null;
  private swapTransitionPending = false;
  private shuttingDown = false;

  // The swap currently executing, or null when idle. Both entry points
  // (ConfigChangeOrchestrator's embed-swap detection and POST
  // /admin/index/rebuild) funnel through applyEmbedSwap; a swap arriving while
  // one runs abandons the in-flight build and starts a fresh one for the newest
  // model rather than racing or being rejected (epic #1011, bounded-to-two).
  private embedSwapInFlight: Promise<void> | null = null;

  // Abort handle for the in-flight graceful build, or null when no build is
  // running. Aborting it makes the GenerationBuilder stop at the next safe
  // point and abandon its half-built generation (the active one keeps serving),
  // so a newer embedder swap can start fresh — the mechanism that bounds the
  // index to two generations under rapid back-to-back swaps.
  private buildAbort: AbortController | null = null;

  // A single follow-up swap queued behind the running one. A burst of swaps
  // arriving during a build all coalesce onto this one promise — runEmbedSwap
  // re-reads the live config when it finally runs, so the coalesced run always
  // targets the NEWEST model. Cleared once it promotes to the in-flight swap.
  private queuedSwap: Promise<void> | null = null;

  // Whether the live search QUERY embedder is the indexer worker itself (a
  // LOCAL in-process embedder) rather than an independent main-thread client (an
  // HTTP embedder). Set on every startIndexer. The graceful swap reads it to
  // decide its pre-flip quiesce: when the old query embedder lives in the worker,
  // the worker is PAUSED (kept alive, still answering embedQuery) instead of
  // disposed, so search stays live under the old model through the quiesce +
  // catch-up + flip (epic #1011, graceful-for-local). When the old query
  // embedder is an independent HTTP client, the worker is simply disposed — query
  // embedding is unaffected by the worker's lifecycle.
  private _queryEmbedderIsWorker = false;

  // The mode the coalesced follow-up swap will run with. Newest-wins: every
  // applyEmbedSwap that lands while a swap is in flight overwrites this, so a
  // hard cutover arriving after a graceful config-change (the portal/CLI
  // "switch then hard-cutover" sequence) wins, and vice-versa. Read by the
  // queued runner when it finally launches.
  private queuedMode: EmbedSwapMode = "graceful";

  constructor(deps: IndexerLifecycleDeps) {
    this.deps = deps;
    this.statusReporter = deps.indexerStatus;
    this.log = deps.log;
    this._modelInfo = {
      name: deps.initialModelInfo.name,
      path: deps.initialModelInfo.path,
      present: deps.initialModelInfo.present,
      modelsDir: deps.initialModelInfo.modelsDir,
    };
  }

  /** Live worker proxy, or null while not ready / mid-swap / shut down. */
  get indexerProxy(): IndexerWorkerProxy | null {
    return this._indexerProxy;
  }

  private async waitForIndexerWriteTransition(): Promise<void> {
    if (this.ownerDisposalInFlight) await this.ownerDisposalInFlight.catch(() => {});
    while (!this._indexerOwner && this.swapTransitionPending) {
      const transition = this.queuedSwap ?? this.embedSwapInFlight;
      if (!transition) {
        await Promise.resolve();
        continue;
      }
      await transition.catch(() => {});
    }
    if (this.shuttingDown) {
      throw new Error("index writer is shutting down; retry the deletion after restart");
    }
  }

  /**
   * Delete through the worker that owns index.db, including while it is still
   * starting. A caller arriving during disposal waits for the old worker to
   * exit before taking the durable direct fallback.
   */
  async deleteSourceIndex(sourceId: string): Promise<number> {
    const owner = this._indexerOwner;
    if (owner && !this.ownerDisposalInFlight) return owner.deleteSourceIndex(sourceId);
    await this.waitForIndexerWriteTransition();
    const replacement = this._indexerOwner;
    if (replacement) return replacement.deleteSourceIndex(sourceId);
    enqueueSourceIndexPurge(this.deps.indexDb, sourceId);
    return directIndexWriteGate(this.deps.indexDb).deleteIndexBySource(sourceId);
  }

  /** Bounded, durable per-document cleanup through the current index writer. */
  async deleteDocumentIndexBatch(
    documentId: string,
    limit: number,
    sourceDeleted: boolean,
  ): Promise<{ deletedChunks: number; complete: boolean; readyForSourceDelete: boolean }> {
    const owner = this._indexerOwner;
    if (owner && !this.ownerDisposalInFlight) {
      return owner.deleteDocumentIndexBatch(documentId, limit, sourceDeleted);
    }
    await this.waitForIndexerWriteTransition();
    const replacement = this._indexerOwner;
    if (replacement) {
      return replacement.deleteDocumentIndexBatch(documentId, limit, sourceDeleted);
    }
    enqueueDocumentIndexPurge(this.deps.indexDb, documentId, sourceDeleted);
    return directIndexWriteGate(this.deps.indexDb).deleteChunksByDocumentBatch(
      documentId,
      limit,
      sourceDeleted,
    );
  }

  /** The stable /index/stats model snapshot (same reference every call). */
  get modelInfo(): IndexerModelInfo {
    return this._modelInfo;
  }

  private indexDbEncryptionKey(): Buffer | null {
    return this.deps.indexDbKeyHex ? Buffer.from(this.deps.indexDbKeyHex, "hex") : null;
  }

  /**
   * Resolve the per-model retrieval encoding (#718) for an embedder. Single
   * producer used by both the boot path (`startIndexer`) and the graceful
   * swap's generation builder so the new generation is embedded with the same
   * document-side encoding the steady-state worker will use after the flip.
   * Gated on `search.embedderPrefixes.enabled`; OFF (default) keeps the legacy
   * nomic-style text prefixes so already-indexed installs keep matching.
   */
  private resolveEmbedderEncodingFor(
    embedResolved: ResolvedAssignment,
    embedId: string,
  ): EmbedderEncoding {
    const enabled = this.deps.configStore.get().search?.embedderPrefixes?.enabled ?? false;
    if (!enabled) {
      return { kind: "text-prefix", query: "search_query: ", document: "search_document: " };
    }
    const providerId =
      embedResolved.kind === "http" ? resolveModelDisplay(embedResolved).providerId : undefined;
    return resolveEmbedderEncoding({ modelId: embedId, providerId });
  }

  private async probeHttpEmbedderWithRecovery(
    resolved: Extract<ResolvedAssignment, { kind: "http" }>,
    apiKey: string | undefined,
    signal: AbortSignal,
    phase: "startup" | "model swap",
  ): Promise<{ model: string; dim: number }> {
    const { probeHttpEmbedder } = await import("./http-embedder.js");
    return retry(
      () =>
        probeHttpEmbedder(
          resolved.url,
          resolved.model || undefined,
          apiKey,
          resolved.apiPathPrefix,
          resolved.allowRemoteInference,
          { signal, timeoutMs: this.deps.runtime.embedderTimeoutMs },
        ),
      {
        // A configured local inference service is a persistent dependency,
        // not a one-shot boot condition. Keep probing transient failures
        // until it is ready or the lifecycle is cancelled; permanent HTTP
        // and model-selection errors still fail immediately.
        maxAttempts: Number.POSITIVE_INFINITY,
        baseBackoffMs: HTTP_EMBEDDER_PROBE_BASE_BACKOFF_MS,
        maxBackoffMs: HTTP_EMBEDDER_PROBE_MAX_BACKOFF_MS,
        shouldRetry: (err) => !signal.aborted && isTransientHttpEmbedderProbeError(err),
        onRetry: (err, attempt, delayMs) => {
          const reason = err instanceof Error ? err.message : String(err);
          this.statusReporter.setReadiness({
            status: "spawning",
            message:
              phase === "startup"
                ? `Waiting for HTTP embedder after probe attempt ${attempt}; retrying in ${delayMs}ms.`
                : `Waiting for replacement HTTP embedder; current search remains available.`,
          });
          this.log.warn(
            `HTTP embedder ${phase} probe attempt ${attempt} failed: ${reason}; retrying in ${delayMs}ms`,
          );
        },
        sleep: (ms) => abortableDelay(ms, signal),
      },
    );
  }

  private async retireStaleBootAfterSwapValidation(): Promise<void> {
    const startup = this.startupInFlight;
    if (!startup) return;

    this.startupAbort?.abort();
    if (!this.indexerShutdownHandle) {
      // Before worker ownership, join cancellation so no delayed retry can
      // construct a worker after the validated replacement starts building.
      await startup;
    }
    // Once the boot worker owns index.db it is the old generation's worker.
    // Keep it serving through a graceful build; the swap's normal quiesce/stop
    // path disposes it before the replacement steady-state worker starts.
  }

  startIndexer(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    if (this.startupInFlight) return this.startupInFlight;
    if (this.swapTransitionPending) {
      return this.queuedSwap ?? this.embedSwapInFlight ?? Promise.resolve();
    }

    const abort = new AbortController();
    this.startupAbort = abort;
    const run = this.startIndexerAttempt(abort.signal).finally(() => {
      if (this.startupInFlight === run) this.startupInFlight = null;
      if (this.startupAbort === abort) this.startupAbort = null;
    });
    this.startupInFlight = run;
    return run;
  }

  private async startIndexerAttempt(signal: AbortSignal): Promise<void> {
    // Indexer runs in a dedicated Bun Worker so node-llama-cpp's CPU-bound
    // native inference can't starve the HTTP event loop. The worker owns
    // the embedder + indexer cycle + index.db writes; this thread only
    // round-trips embedQuery() calls for interactive search.
    // Set OMNESIS_INDEXER_ENABLED=false to run without indexing (useful
    // for diagnostics). Documents still ingest and search still answers on
    // keyword matching alone.
    if (process.env.OMNESIS_INDEXER_ENABLED === "false") {
      this.log.warn(
        "Indexer disabled via OMNESIS_INDEXER_ENABLED=false — vector search unavailable; search runs on keywords alone",
      );
      this.statusReporter.setReadiness({
        status: "disabled",
        reason: "OMNESIS_INDEXER_ENABLED=false",
      });
      return;
    }

    // Wait for the initial HTTP backend probe so the registry has
    // up-to-date status (discovered models, reachability) before we
    // resolve assignments.
    try {
      await abortableWait(this.deps.initialProbe, signal);
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }
    if (signal.aborted) return;
    this.deps.inferenceRegistry.loadConfig(this.deps.configStore.get());
    const embedResolved = this.deps.inferenceRegistry.resolve("embedder");

    if (embedResolved.kind === "disabled") {
      this.log.info("Embedder disabled — vector search unavailable; search runs on keywords alone");
      this.statusReporter.setReadiness({
        status: "disabled",
        reason: "Embedder assignment disabled",
      });
      return;
    }
    if (embedResolved.kind === "unresolved") {
      this.log.warn(`Embedder unresolved: ${embedResolved.reason}`);
      this.statusReporter.setReadiness({ status: "disabled", reason: embedResolved.reason });
      return;
    }

    // HTTP embedder: probe the server to discover model name + dimension.
    let httpEmbedderUrl: string | undefined;
    let httpEmbedderApiKey: string | undefined;
    let httpEmbedderApiPathPrefix: string | undefined;
    let httpEmbedderAllowRemoteInference = false;
    let httpProbeResult: { model: string; dim: number } | undefined;
    let modelPath: string;

    if (embedResolved.kind === "http") {
      httpEmbedderUrl = embedResolved.url;
      httpEmbedderApiKey = this.deps.inferenceRegistry.getBackendApiKey(embedResolved.backendKey);
      httpEmbedderApiPathPrefix = embedResolved.apiPathPrefix;
      httpEmbedderAllowRemoteInference = embedResolved.allowRemoteInference;
      try {
        httpProbeResult = await this.probeHttpEmbedderWithRecovery(
          embedResolved,
          httpEmbedderApiKey,
          signal,
          "startup",
        );
        if (signal.aborted) return;
        this.log.info(
          `HTTP embedder: ${httpEmbedderUrl} → model=${httpProbeResult.model} dim=${httpProbeResult.dim}`,
        );
      } catch (err) {
        if (signal.aborted) return;
        const reason = err instanceof Error ? err.message : String(err);
        this.log.error(`HTTP embedder probe failed: ${reason}`);
        this.statusReporter.setReadiness({
          status: "failed",
          reason: `HTTP embedder probe failed: ${reason}`,
        });
        return;
      }
      modelPath = "(http)";
    } else if (embedResolved.kind === "local") {
      if (!embedResolved.available) {
        this.log.warn(`Indexer paused — embedding model not found at ${embedResolved.modelPath}`);
        this.log.warn(
          `Semantic search disabled. Documents still ingest and stay searchable by keyword.`,
        );
        this.statusReporter.setReadiness({
          status: "disabled",
          reason: `Embedding model not found at ${embedResolved.modelPath}`,
        });
        return;
      }
      modelPath = embedResolved.modelPath;
    } else {
      // Anthropic embedder is not supported for the indexer pipeline.
      this.log.warn("Anthropic embedder is not supported for the indexing pipeline");
      this.statusReporter.setReadiness({
        status: "disabled",
        reason: "Anthropic models cannot be used for embedding",
      });
      return;
    }

    // Canonical embed-model identity + effective dimension. Computed by the
    // SINGLE shared producer (`canonicalEmbedIdentity`) so the stamp the
    // worker writes here matches, byte-for-byte, the one the swap path
    // (`runEmbedSwap`) writes — no backend-prefixed-vs-bare or
    // native-vs-effective drift that would trigger a spurious re-wipe (#698).
    const { name: modelName, dim: embedDim } = canonicalEmbedIdentity(embedResolved, {
      httpServedModel: httpProbeResult?.model,
      httpNativeDim: httpProbeResult?.dim,
    });

    // Update the model info snapshot so /index/stats reports the correct
    // model name and doesn't show "model-missing" for HTTP backends.
    this._modelInfo.name = modelName;
    this._modelInfo.path = modelPath;
    this._modelInfo.present = embedResolved.kind === "http" || existsSync(modelPath);

    // Crash-safe resume (epic #1011). A `building` generation present at boot
    // means a graceful rebuild was in flight when the gateway last stopped. The
    // active generation is untouched and the read registry is already serving it
    // (search is live), so instead of abandoning the half-built generation and
    // re-embedding from zero we RESUME it from its durable progress, then flip —
    // exactly the graceful path, minus the work already done.
    //
    // Resume only when the building generation's recorded model still matches the
    // configured embedder (the common crash-during-swap case: active = old model,
    // building = new model = current config). An HTTP target also requires a
    // reachable backend (the probe above); a LOCAL target is rebuilt via the
    // off-main-thread build worker. If the config changed AGAIN while the gateway
    // was down, or an HTTP embedder is no longer reachable, the recorded build
    // can't be continued — abandon it (drop its file + staging) and fall through
    // to a normal boot, which reconciles the active generation against the
    // current config.
    const building = getBuildingIndexVersion(this.deps.indexDb);
    if (building) {
      const activeVersion = getActiveIndexVersion(this.deps.indexDb);
      const targetResumable =
        embedResolved.kind === "http" ? httpProbeResult != null : embedResolved.kind === "local";
      const resumable =
        targetResumable &&
        activeVersion != null &&
        building.version !== activeVersion &&
        building.embed_model === modelName &&
        building.embed_dim === embedDim;
      if (
        resumable &&
        activeVersion != null &&
        (embedResolved.kind === "http" || embedResolved.kind === "local")
      ) {
        this.log.info(
          `Found in-flight building generation ${building.version} at boot — resuming its rebuild (active generation ${activeVersion} keeps serving).`,
        );
        await this.launchResume(
          embedResolved,
          embedResolved.kind === "http" ? httpProbeResult : undefined,
          modelName,
          embedDim,
          activeVersion,
          building.version,
        );
        return;
      }
      this.log.warn(
        `In-flight building generation ${building.version} (${building.embed_model}, dim ${building.embed_dim}) is not resumable under the current embedder (${modelName}, dim ${embedDim}) — abandoning it and booting normally.`,
      );
      cleanupStaleBuildingState(this.deps.indexDb, this.deps.indexDbPath);
    }

    const cutoffs = buildIndexerCutoffMap(this.deps.configStore.get());

    // The encoding resolver keys off the bare model id (HTTP served id, or
    // local catalog id) — distinct from the stamp identity above.
    const embedId = httpProbeResult
      ? httpProbeResult.model
      : embedResolved.kind === "local"
        ? embedResolved.catalogId
        : "";

    // Resolve the per-model retrieval encoding (#718). Gated on
    // `search.embedderPrefixes.enabled`:
    //   - ON  → resolve per-model (family text-prefix, provider api-param, or
    //           symmetric `none`) via `resolveEmbedderEncoding`.
    //   - OFF (default) → keep the legacy nomic-style text prefixes
    //     (`search_query: ` / `search_document: `) regardless of model family,
    //     so already-indexed installs that were built under that default keep
    //     matching their corpus until they reindex.
    const encoding = this.resolveEmbedderEncodingFor(embedResolved, embedId);
    if (encoding.kind === "text-prefix" && encoding.query === "search_query: ") {
      this.log.info(
        `Embedder encoding DISABLED — using legacy nomic-style text-prefix query="search_query: " document="search_document: "`,
      );
    } else {
      this.log.info(
        `Embedder encoding RESOLVED (#718): model=${embedId || modelName} kind=${encoding.kind} ${describeEncoding(encoding)}`,
      );
    }

    const proxy = new IndexerWorkerProxy({
      modelPath,
      modelName,
      embedDim,
      gatewayDbPath: this.deps.gatewayDbPath,
      indexDbPath: this.deps.indexDbPath,
      cutoffs,
      indexIntervalMs: this.deps.runtime.indexCycleIntervalMs,
      indexBacklogIntervalMs: this.deps.runtime.indexCycleBacklogIntervalMs,
      dbWriteBatchSize: this.deps.runtime.dbWriteBatchSize,
      reconcileIntervalMs: this.deps.runtime.reconcileIntervalMs,
      reindexMissingIntervalMs: this.deps.runtime.reindexMissingIntervalMs,
      embedConcurrency: this.deps.runtime.embedConcurrency,
      indexerPageSize: this.deps.runtime.indexerPageSize,
      indexerBetweenPageSleepMs: this.deps.runtime.indexerBetweenPageSleepMs,
      reindexMissingAtBoot: this.deps.runtime.reindexMissingAtBoot,
      chunkerChunkSize: this.deps.runtime.chunkerChunkSize,
      chunkerOverlap: this.deps.runtime.chunkerOverlap,
      embedderContextSize: this.deps.runtime.embedderContextSize,
      embedderTimeoutMs: this.deps.runtime.embedderTimeoutMs,
      embedderMaxInputChars: this.deps.runtime.embedderMaxInputChars,
      minFreeDiskMb: this.deps.runtime.minFreeDiskMb,
      embedderEncoding: encoding,
      httpEmbedderUrl,
      httpEmbedderModel: httpProbeResult?.model,
      httpEmbedderApiKey,
      httpEmbedderApiPathPrefix,
      httpEmbedderAllowRemoteInference,
      // Version-aware: the worker writes the ACTIVE generation's own file. For
      // version 1 (and the pre-versioning fallback) that is the legacy
      // `index.usearch`; after a double-buffered swap flips to generation N it
      // is `index-N.usearch` (epic #1011). The read registry serves the same
      // active generation, so writer and reader always agree on the file.
      usearchIndexPath: usearchPathForVersion(
        this.deps.configDir,
        getActiveIndexVersion(this.deps.indexDb),
      ),
      ...(this.deps.gatewayDbKeyHex ? { gatewayDbKeyHex: this.deps.gatewayDbKeyHex } : {}),
      ...(this.deps.indexDbKeyHex ? { indexDbKeyHex: this.deps.indexDbKeyHex } : {}),
    });

    // Ownership begins in the constructor: it has already spawned the worker
    // and posted init, so no main-thread index.db mutation may race it from
    // here onward. Install shutdown immediately as well; SIGTERM during HNSW
    // restore/model warmup must dispose this worker before sidecar encryption.
    this._indexerOwner = proxy;
    let shutdownInFlight: Promise<void> | null = null;
    const shutdownHandle = (): Promise<void> => {
      if (shutdownInFlight) return shutdownInFlight;
      if (this._indexerProxy === proxy) this._indexerProxy = null;
      if (this.indexerShutdownHandle === shutdownHandle) this.indexerShutdownHandle = null;
      const disposal = proxy.dispose();
      if (this._indexerOwner === proxy) this.ownerDisposalInFlight = disposal;
      shutdownInFlight = (async () => {
        try {
          await disposal;
        } finally {
          if (this._indexerOwner === proxy) this._indexerOwner = null;
          if (this.ownerDisposalInFlight === disposal) this.ownerDisposalInFlight = null;
        }
      })();
      return shutdownInFlight;
    };
    this.indexerShutdownHandle = shutdownHandle;

    this.log.info(
      `Indexer worker spawning: model=${modelName}, interval=${this.deps.runtime.indexCycleIntervalMs}ms, reconcile=${this.deps.runtime.reconcileIntervalMs}ms, reindex-missing=${this.deps.runtime.reindexMissingIntervalMs}ms`,
    );
    this.statusReporter.setReadiness(
      {
        status: "loading-model",
        message: `Loading ${modelName} — cold start takes ~15s.`,
      },
      proxy,
    );

    try {
      await proxy.whenReady();
    } catch (err) {
      // An intentional shutdown may reject readiness while disposal is still
      // draining. Join it without publishing a false startup failure.
      if (this.ownerDisposalInFlight) {
        await shutdownHandle().catch(() => {});
        return;
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.log.error(`Indexer worker failed to start: ${reason}`);
      this.statusReporter.setReadiness({ status: "failed", reason });
      try {
        await shutdownHandle();
      } catch (disposeErr) {
        this.log.warn(
          `Indexer worker cleanup after failed startup failed: ${
            disposeErr instanceof Error ? disposeErr.message : String(disposeErr)
          }`,
        );
      }
      return;
    }
    // Shutdown can detach a starting worker just as its ready message lands.
    // Never publish or wire a proxy that is already being disposed.
    if (this._indexerOwner !== proxy) return;

    // When using an HTTP embedder, create a direct main-thread client for
    // search queries. This avoids routing embedQuery through the indexer
    // worker — the worker can be blocked by boot-time backfill tasks for
    // minutes, causing 30-second timeouts on interactive search. The main-
    // thread embedder calls the HTTP endpoint directly (~130ms), completely
    // independent of worker contention. For local (llama.cpp) embedders
    // the model is loaded inside the worker, so we still use the proxy.
    if (httpEmbedderUrl) {
      const { HttpEmbedder } = await import("./http-embedder.js");
      // Shutdown may detach the worker while the module loader is awaiting
      // filesystem I/O. Re-check ownership before creating or publishing any
      // main-thread search resource.
      if (this._indexerOwner !== proxy) return;
      const searchEmbedder = new HttpEmbedder({
        baseUrl: httpEmbedderUrl,
        apiPathPrefix: httpEmbedderApiPathPrefix,
        model: httpProbeResult?.model ?? "",
        outputDim: embedDim,
        maxInputChars: this.deps.runtime.embedderMaxInputChars,
        encoding,
        apiKey: httpEmbedderApiKey,
        allowRemoteInference: httpEmbedderAllowRemoteInference,
        // Interactive search must never throttle itself — single small
        // requests, latency-critical. The bulk indexer's separate embedder
        // is the one that's bounded so it can't starve these at the server.
        maxConcurrentRequests: Infinity,
      });
      this.deps.searchPipeline.setEmbedder(searchEmbedder);
      this._queryEmbedderIsWorker = false;
      this.log.info(`search embedder: direct HTTP client (bypasses indexer worker)`);
    } else {
      this.deps.searchPipeline.setEmbedder(proxy);
      this._queryEmbedderIsWorker = true;
    }
    // Publish to the live ref so POST /admin/index/reindex-missing
    // (and any future operator triggers) can drive the worker.
    this._indexerProxy = proxy;
    // Writes can land after HTTP starts but before the scheduler has a live
    // proxy to wake. Reconcile once after publication; if the worker is still
    // in its exclusive boot scan this coalesces into one trailing cycle.
    proxy.wake();
    // Register the three worker-hosted background jobs (cycle / reconcile
    // / reindex-missing) into the registry. The proxy holds the live
    // observation state hydrated from `jobUpdate` messages — adapters
    // close over the proxy so they pick up updates without further wiring.
    this.deps.backgroundJobs.registerAll(proxy.createBackgroundJobs());
    // Replay the current cutoffs in case the config moved during the model
    // load — config.changed listeners that fired before this assignment saw
    // a null indexerProxy and skipped. Re-reading from the live store closes
    // the race.
    proxy.updateCutoffs(buildIndexerCutoffMap(this.deps.configStore.get()));
    this.statusReporter.setReadiness({ status: "ready" });
  }

  /**
   * Apply an embedding-model switch (or a same-model rebuild). Sequence:
   *
   *   1. Stop the current indexer worker.
   *   2. Open a writable handle on index.db, wipe the vector index
   *      at the new dimension, then close the handle. The disposed
   *      worker was the only writer so this is safe.
   *   3. Spawn a fresh indexer worker; it loads the configured model and
   *      naturally re-embeds every document because indexed_documents
   *      is empty.
   *
   * Two callers:
   *   - ConfigChangeOrchestrator on `/indexer/model` change (model swap).
   *   - POST /admin/index/rebuild via indexerControl.rebuild (manual
   *     bug-recovery rebuild under the current model).
   *
   * Two modes, graceful by default (epic #1011). `graceful` keeps the active
   * generation serving every query under the old model while a new generation
   * is built under the new model and atomically flipped (zero downtime).
   * `hard` is a deliberate immediate cutover: stop using the old model for both
   * indexing and query embedding right now, accept BM25-only vector search, and
   * wipe-and-resync under the new model. Config-change-triggered swaps always
   * pass `graceful` (a declarative config edit can't carry a downtime choice);
   * `hard` arrives only through `POST /admin/index/rebuild { mode: "hard" }`,
   * driven by the portal/CLI swap-confirm flow.
   *
   * Newest-wins, bounded to two (epic #1011): a swap arriving while one is
   * already in flight ABANDONS the in-flight build (the active generation keeps
   * serving throughout) and starts a fresh build for the newest model AND its
   * newest mode. A burst of overlapping swaps coalesces onto a single follow-up
   * run — runEmbedSwap re-reads the live config when it executes, so the
   * coalesced run targets the latest model, the latest mode, and at most two
   * index generations ever exist on disk. This is what makes the portal/CLI
   * "switch the model (→ graceful config-change), then hard-cutover" sequence
   * resolve to a hard cutover: the hard request lands second and supersedes.
   */
  async applyEmbedSwap(mode: EmbedSwapMode = "graceful"): Promise<void> {
    if (this.shuttingDown) return;
    // Public auto-bootstrap calls must not start a separate worker while the
    // replacement assignment is being validated or built.
    this.swapTransitionPending = true;
    if (!this.embedSwapInFlight) {
      return this.launchSwap(mode);
    }
    // A swap is already running. Abandon its in-flight graceful build so the
    // newest model+mode wins, and coalesce concurrent requests onto one
    // follow-up. Record the newest mode so the queued runner picks it up.
    this.queuedMode = mode;
    this.buildAbort?.abort();
    if (this.queuedSwap) return this.queuedSwap;
    const running = this.embedSwapInFlight;
    const queued = (async () => {
      // Wait for the abandoned swap to fully unwind — its cleanup deletes the
      // half-built generation's file + staging rows — BEFORE starting the fresh
      // build, so the abandoned file is gone before the new one is created and
      // at most two generation files ever exist on disk.
      try {
        await running;
      } catch {
        /* the abandoned swap's own handler logged + cleaned up */
      }
      this.queuedSwap = null;
      if (this.shuttingDown) return;
      await this.launchSwap(this.queuedMode);
    })();
    this.queuedSwap = queued;
    return queued;
  }

  /**
   * Start a single swap run, tracking it as the in-flight swap with a fresh
   * abort handle. The run self-clears `embedSwapInFlight` on settle so the next
   * `applyEmbedSwap` sees an idle lifecycle. The two assignments at the end run
   * synchronously (no intervening await) so no concurrent caller can observe a
   * half-updated state.
   */
  private launchSwap(mode: EmbedSwapMode): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    const abort = new AbortController();
    this.buildAbort = abort;
    const run = this.runEmbedSwap(abort.signal, mode).finally(() => {
      if (this.buildAbort === abort) this.buildAbort = null;
      if (this.embedSwapInFlight === run) this.embedSwapInFlight = null;
      if (!this.embedSwapInFlight && !this.queuedSwap) this.swapTransitionPending = false;
    });
    this.embedSwapInFlight = run;
    return run;
  }

  /**
   * Launch a crash-safe resume of an interrupted graceful build (epic #1011) as
   * the in-flight swap, with a fresh abort handle — mirroring {@link launchSwap}
   * so a newer embedder swap arriving mid-resume aborts it and coalesces a
   * follow-up through the SAME bounded-to-two / newest-wins path as any other
   * in-flight build. Called once at boot when a resumable `building` generation
   * is found.
   */
  private launchResume(
    resolved: Extract<ResolvedAssignment, { kind: "http" | "local" }>,
    httpProbe: { model: string; dim: number } | undefined,
    modelLabel: string,
    newDim: number,
    activeVersion: number,
    resumeVersion: number,
  ): Promise<void> {
    const abort = new AbortController();
    this.buildAbort = abort;
    const run = this.runGracefulEmbedSwap(
      resolved,
      httpProbe,
      modelLabel,
      newDim,
      activeVersion,
      abort.signal,
      { resumeVersion },
    ).finally(() => {
      if (this.buildAbort === abort) this.buildAbort = null;
      if (this.embedSwapInFlight === run) this.embedSwapInFlight = null;
    });
    this.embedSwapInFlight = run;
    return run;
  }

  /**
   * Stop the steady-state indexer worker and drop the live proxy ref. Shared
   * by both the hard wipe-and-resync path and the graceful swap's pre-flip
   * quiesce. Idempotent — a no-op when no worker is running.
   */
  private async stopWorker(): Promise<void> {
    if (this.indexerShutdownHandle) {
      try {
        await this.indexerShutdownHandle();
      } catch (err) {
        this.log.warn(
          `shutdown of previous indexer threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.indexerShutdownHandle = null;
    }
    this._indexerProxy = null;
  }

  private async runEmbedSwap(signal: AbortSignal, mode: EmbedSwapMode): Promise<void> {
    // Re-resolve the embedder from the registry with the live config.
    this.deps.inferenceRegistry.loadConfig(this.deps.configStore.get());
    const resolved = this.deps.inferenceRegistry.resolve("embedder");

    if (resolved.kind === "disabled" || resolved.kind === "unresolved") {
      this.log.error(
        `Embed-switch requested but embedder is ${resolved.kind} — leaving previous indexer running`,
      );
      return;
    }

    if (resolved.kind === "local" && !resolved.available) {
      this.log.error(
        `Embed-switch requested for ${resolved.catalogId} but file not found at ${resolved.modelPath} — leaving previous indexer running`,
      );
      return;
    }

    // For HTTP, probe the server first to discover the served model id and
    // native dimension — both feed the canonical stamp identity below. The
    // probe runs BEFORE the old worker is torn down so a failure leaves the
    // previous index serving rather than killing search on an unreachable
    // backend.
    let httpProbe: { model: string; dim: number } | undefined;
    if (resolved.kind === "http") {
      try {
        const swapApiKey = this.deps.inferenceRegistry.getBackendApiKey(resolved.backendKey);
        httpProbe = await this.probeHttpEmbedderWithRecovery(
          resolved,
          swapApiKey,
          signal,
          "model swap",
        );
      } catch (err) {
        if (signal.aborted) return;
        this.log.error(
          `HTTP embedder probe failed during swap: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.statusReporter.setReadiness({
          status: "failed",
          reason: "HTTP embedder unreachable during model swap",
        });
        return;
      }
    }

    // Canonical identity + dimension — the SAME producer the fresh worker
    // uses in startIndexer. Stamping with these values means the worker's
    // boot-time mismatch check sees an exact match and does NOT trigger a
    // spurious second wipe (#698 B1/B2).
    const { name: modelLabel, dim: newDim } = canonicalEmbedIdentity(resolved, {
      httpServedModel: httpProbe?.model,
      httpNativeDim: httpProbe?.dim,
    });

    // Validation succeeded while the previous boot/worker remained available.
    // Retire only a pre-ownership stale boot here; an owned worker is the old
    // generation's live worker and remains until the swap's normal quiesce.
    await this.retireStaleBootAfterSwapValidation();
    if (signal.aborted) return;

    // Graceful (double-buffered) swap (epic #1011): build a new generation
    // while the active one keeps serving, then atomically flip. Eligible when
    // this is a graceful-mode swap, there IS a complete active generation to keep
    // serving, the corpus is non-empty, and the NEW (target) embedder is HTTP or
    // LOCAL. The build re-embeds the corpus off the gateway event loop — an HTTP
    // target via a non-blocking main-thread HTTP client, a LOCAL target via a
    // short-lived off-main-thread build worker (mechanism 1) — so interactive
    // search stays responsive throughout, regardless of the target's kind. The
    // OLD embedder's kind does NOT gate this either: a LOCAL old model keeps its
    // in-worker query embedder alive (paused, not disposed) through the pre-flip
    // quiesce so search stays live under the old model (mechanism 2). All four
    // {local,http}-old × {local,http}-new transitions are therefore graceful. A
    // `hard` cutover deliberately opts OUT and takes the destructive path below
    // (immediate stop + downtime). Only a first build (no active generation yet)
    // and an empty corpus still fall through to the destructive wipe-and-resync —
    // there is no live index to keep serving, so there is nothing to protect.
    const activeVersion = getActiveIndexVersion(this.deps.indexDb);
    const corpusChunks = getChunkCount(this.deps.indexDb);
    const targetGracefulEligible =
      resolved.kind === "http" ? httpProbe != null : resolved.kind === "local";
    const canGraceful =
      mode === "graceful" && targetGracefulEligible && activeVersion != null && corpusChunks > 0;

    if (
      canGraceful &&
      activeVersion != null &&
      (resolved.kind === "http" || resolved.kind === "local")
    ) {
      await this.runGracefulEmbedSwap(
        resolved,
        resolved.kind === "http" ? httpProbe : undefined,
        modelLabel,
        newDim,
        activeVersion,
        signal,
      );
      return;
    }

    // A newer swap already arrived and abandoned this one (it always queues a
    // follow-up). Skip the destructive wipe entirely — the active index stays
    // intact and the queued run re-resolves the newest model and rebuilds.
    if (signal.aborted) {
      this.log.info(
        `Embed switch → ${modelLabel} abandoned before wipe — newer swap supersedes it.`,
      );
      return;
    }

    // Destructive wipe-and-resync. This takes vector search offline until the
    // new index is rebuilt, so stop using the OLD model immediately for BOTH
    // indexing (stopWorker, below) and query embedding (clear it now). For a
    // hard cutover that immediacy is the whole point — stop paying the old
    // cloud embedder the instant the switch is confirmed; for the graceful
    // fall-through (first build / empty corpus, where there is no live index to
    // protect) clearing it is still correct, since leaving the old-dimension
    // embedder pointed at a wiped/new-dimension index would return 0/mismatched
    // results (#698-class). Search degrades to BM25-only for the documented
    // downtime; the fresh worker re-attaches the new-model query embedder at the
    // new dimension.
    this.deps.searchPipeline.setEmbedder(undefined);

    if (mode === "hard") {
      this.log.info(
        `Hard cutover → ${modelLabel}: stopped using the old embedder immediately for indexing and query embedding; vector search is BM25-only until the rebuild completes under the new model.`,
      );
    } else {
      this.log.info(`Embed switch → ${modelLabel}. Wiping vector index and reindexing.`);
    }
    this.statusReporter.setReadiness({
      status: "spawning",
      message:
        mode === "hard"
          ? `Hard cutover to ${modelLabel} — rebuilding vector index; keyword search only until complete.`
          : "Wiping vector index for re-embedding…",
    });

    await this.stopWorker();

    // Delete the stale on-disk usearch file. It was built at the OLD model's
    // dimension; leaving it in place lets the fresh worker `load()` an
    // old-dim index and lets the main-thread read handle `view()` a
    // stale-dimension file, returning zero/mismatched results until a restart
    // (#698 B3). Removing it forces the worker to start an empty index at the
    // new dimension and the reader to re-view only once a new-dim file exists.
    const usearchPath = usearchPathForVersion(
      this.deps.configDir,
      getActiveIndexVersion(this.deps.indexDb),
    );
    // Also drop the encrypted sidecar: after a model/dim wipe it belongs to the
    // OLD embedder and must not survive; the fresh worker re-embeds and writes a
    // new consistent `.enc`.
    for (const p of [usearchPath, `${usearchPath}.tmp`, `${usearchPath}.enc`]) {
      try {
        unlinkSync(p);
      } catch {
        // File may not exist (first build, or already cleared) — fine.
      }
    }

    await withFreshIndexWriteGate(
      this.deps.indexDbPath,
      (gate) => gate.wipeAndRecreateVectorIndex(newDim, modelLabel),
      { encryptionKey: this.indexDbEncryptionKey() },
    );
    this.log.info("Vector index wiped — indexer will re-embed every chunk under the new model.");

    await this.startIndexerAttempt(signal);
  }

  /**
   * Graceful double-buffered embedder swap (epic #1011) — the headline
   * capability. The currently-active generation keeps serving every vector
   * search unchanged while a second generation is rebuilt under the new model;
   * a single atomic flip then makes the new generation serve, with no gateway
   * restart and no degradation to BM25-only at any point.
   *
   * Sequence:
   *   1. Register a new `building` generation and re-embed the existing
   *      `chunks` corpus under the new model into its OWN usearch file +
   *      the `chunk_embeddings_building` scratch table — never touching the
   *      active generation's file, `chunks.embedding`, or content. The
   *      steady-state worker KEEPS RUNNING throughout this (long) main pass, so
   *      documents ingested mid-rebuild keep flowing into the active generation
   *      and vector search keeps returning the active generation's candidates.
   *   2. Quiesce: stop the steady-state worker so the `chunks` corpus stops
   *      moving, then run the fan-out catch-up — embed the documents ingested
   *      during the main pass (which the worker chunked into the active
   *      generation) into the building generation too, and drop any deleted
   *      mid-rebuild. After this the building generation covers exactly the
   *      live corpus, so the flip has no post-flip gap. Reads stay live during
   *      the (short) quiesce: the registry serves the active file directly and
   *      the search query-embedder stays answering (an HTTP main-thread client,
   *      or a LOCAL old model's worker kept alive paused — mechanism 2).
   *   3. Atomically flip (`flipActiveIndexVersion`): promote the new vectors
   *      into `chunks.embedding`, re-stamp the model, move `active_version`,
   *      and — synchronously, with no intervening await — repoint the search
   *      query-embedder to the new model so query and index dimensions stay
   *      matched at the instant the registry follows the pointer.
   *   4. Delete the retired generation's file and restart the steady-state
   *      worker on the new active generation for ongoing ingest.
   *
   * Embedder-kind-agnostic on the TARGET side: the new generation is re-embedded
   * off the gateway event loop either way. An HTTP target is driven by a non-
   * blocking main-thread `HttpEmbedder`; a LOCAL target is driven by a short-
   * lived off-main-thread {@link BuildWorkerEmbedder} (mechanism 1) so the
   * CPU/GPU-bound local model never freezes live search. For a LOCAL target the
   * build worker also serves as the new-model query-embedder bridge across the
   * flip — its `embedQuery` answers on the new index until the fresh steady-state
   * worker takes over — and is disposed only after that handover.
   *
   * On a build failure — or an abandon, when a newer embedder swap arrives mid-
   * build and aborts `signal` (epic #1011, bounded-to-two) — the building
   * generation is dropped (no flip), the untouched active generation keeps
   * serving, and the steady-state worker is restarted on it (or simply left
   * running if the failure preceded the quiesce). The abort is checked only in
   * the builder's loops, never mid-flip: the flip is one synchronous
   * transaction, so a swap landing in the window around it resolves
   * deterministically — either the build is abandoned before the pointer move,
   * or the flip commits and the newer swap then rebuilds on top of it. There is
   * never a half-flip.
   *
   * Doubles as the crash-safe RESUME path (epic #1011): with `opts.resumeVersion`
   * set the method continues an existing `building` generation found at boot
   * instead of allocating a fresh one — it skips the row creation and, instead of
   * the build → quiesce → catch-up dance, runs a single {@link
   * GenerationBuilder.resume} pass (rebuild the usearch file from the durable
   * staging + embed only the chunks not yet done) before the identical flip.
   */
  private async runGracefulEmbedSwap(
    resolved: Extract<ResolvedAssignment, { kind: "http" | "local" }>,
    httpProbe: { model: string; dim: number } | undefined,
    modelLabel: string,
    newDim: number,
    activeVersion: number,
    signal: AbortSignal,
    opts: { resumeVersion?: number } = {},
  ): Promise<void> {
    const db = this.deps.indexDb;
    // Whether the NEW (target) model runs in-process (local GGUF). A local
    // target builds via the off-main-thread build worker (mechanism 1) and
    // reuses that worker as the post-flip query-embedder bridge; an HTTP target
    // builds + queries via main-thread HTTP clients.
    const localTarget = resolved.kind === "local";
    const embedId = resolved.kind === "http" ? httpProbe!.model : resolved.catalogId;
    const encoding = this.resolveEmbedderEncodingFor(resolved, embedId);
    // Whether the OLD search query embedder lives in the indexer worker (a LOCAL
    // old model). Captured now, before any await: it decides whether the pre-flip
    // quiesce pauses the worker (keeping it alive as the query embedder so search
    // stays live under the old model) or disposes it (HTTP old model — query
    // embedding is an independent main-thread client). `pausedForQuiesce` records
    // that we took the pause branch so the abandon/failure path can resume it.
    const oldQueryViaWorker = this._queryEmbedderIsWorker;
    let pausedForQuiesce = false;
    // Crash-safe resume (epic #1011): when `resumeVersion` is set we continue an
    // existing `building` generation that was in flight at the last shutdown,
    // re-using its row + its durably-staged vectors — never creating a fresh
    // generation and never re-embedding the chunks already done. Otherwise this
    // is a fresh graceful swap that allocates the next generation id.
    const resuming = opts.resumeVersion != null;
    const newVersion = opts.resumeVersion ?? nextIndexVersion(db);

    this.log.info(
      resuming
        ? `Resuming interrupted graceful embed swap → ${modelLabel} (dim ${newDim}): generation ${newVersion} continues building while generation ${activeVersion} keeps serving.`
        : `Graceful embed swap → ${modelLabel} (dim ${newDim}): building generation ${newVersion} while generation ${activeVersion} keeps serving.`,
    );
    this.statusReporter.setReadiness({
      status: "spawning",
      message: `Migrating to ${modelLabel} in the background — current search unaffected.`,
    });

    // 1. Register + build the new generation. The steady-state worker keeps
    //    RUNNING during the main pass so mid-rebuild ingest keeps flowing into
    //    the active generation (the constraint: new docs land in every live
    //    index). The builder uses its OWN main-thread connection + the building
    //    generation's own file, disjoint from the worker's active file. On a
    //    RESUME the building row + its staged vectors already exist, so we skip
    //    both the cleanup (it would drop the partial we mean to continue) and
    //    the row creation.
    if (!resuming) {
      cleanupStaleBuildingState(db, this.deps.indexDbPath);
      createBuildingIndexVersion(db, {
        version: newVersion,
        embedModel: modelLabel,
        embedDim: newDim,
        docsTotal: getBuildableDocumentCount(db),
      });
    }

    // Build embedder: HTTP target → throttled main-thread HTTP client; LOCAL
    // target → off-main-thread build worker hosting the new GGUF (mechanism 1),
    // so the (CPU/GPU-bound) re-embed never blocks the event loop and live search
    // stays responsive on the active generation throughout the build.
    const buildEmbedder = await this.createBuildEmbedder(resolved, httpProbe, newDim, encoding);

    const builder = new GenerationBuilder(
      db,
      this.deps.configDir,
      newVersion,
      buildEmbedder,
      newDim,
      {
        signal,
      },
    );
    try {
      if (resuming) {
        // Resume runs at boot BEFORE the steady-state worker starts, so the
        // corpus is frozen: a single resume pass (rebuild the usearch file from
        // the durable staging + embed only the remaining un-staged chunks +
        // drop orphans) fully converges. No worker to quiesce.
        await builder.resume();
      } else {
        await builder.build();
        // 2. Quiesce ingest, then fan-out catch-up (#1025). Freezing the
        //    `chunks` corpus lets the single catch-up pass fully converge so the
        //    flip is gap-free. This MUST happen before the pointer move (atomic
        //    flip / no blending) — never after.
        //
        //    When the OLD query embedder lives in the worker (a LOCAL old model)
        //    we PAUSE it rather than dispose it: pause stops the indexing cycle
        //    (corpus frozen) but keeps the model loaded and embedQuery answering,
        //    so search stays live under the old model through the catch-up + flip
        //    (epic #1011, graceful-for-local). The paused worker is disposed only
        //    AFTER the flip repoints query embedding to the new model. For an HTTP
        //    old model query embedding is an independent main-thread client, so
        //    the worker can just be disposed here.
        if (oldQueryViaWorker && this._indexerProxy) {
          await this._indexerProxy.pauseIndexing();
          pausedForQuiesce = true;
        } else {
          await this.stopWorker();
        }
        await builder.catchUp();
      }
    } catch (err) {
      const abandoned = signal.aborted || err instanceof BuildAbortedError;
      if (abandoned) {
        this.log.info(
          `Graceful build of generation ${newVersion} abandoned — newer embedder swap supersedes it; generation ${activeVersion} keeps serving.`,
        );
      } else {
        this.log.error(
          `Graceful build of generation ${newVersion} failed — abandoning, generation ${activeVersion} keeps serving: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      cleanupStaleBuildingState(db, this.deps.indexDbPath);
      await buildEmbedder.dispose().catch(() => {});
      // Leave the UNCHANGED active generation serving. If the worker was paused
      // for the quiesce (a LOCAL old model) it is still alive — un-pause it so the
      // active generation keeps ingesting. If it was disposed (HTTP old model) or
      // never reached the quiesce, restart it only when no worker is running.
      if (pausedForQuiesce && this._indexerProxy) {
        this._indexerProxy.resumeIndexing();
      }
      if (this.indexerShutdownHandle == null) await this.startIndexerAttempt(signal);
      return;
    }
    // 3. Atomic flip + repoint query embedding. Build the new search embedder
    //    first so steps 3a/3b run back-to-back with NO await between them — a
    //    search either runs entirely before (old index + old query model) or
    //    entirely after (new index + new query model); never a mixed pair.
    //
    //    For an HTTP target the search embedder is a fresh un-throttled HTTP
    //    client and the build embedder is now done — dispose it. For a LOCAL
    //    target the build worker (model loaded, idle after catch-up) IS the new-
    //    model query embedder: reuse it as the bridge across the flip and dispose
    //    it only after the fresh steady-state worker takes over query embedding
    //    (step 4) — so semantic search never loses its query embedder.
    let searchEmbedder: Embedder;
    if (resolved.kind === "local") {
      searchEmbedder = buildEmbedder;
    } else {
      await buildEmbedder.dispose().catch(() => {});
      const { HttpEmbedder } = await import("./http-embedder.js");
      const apiKey = this.deps.inferenceRegistry.getBackendApiKey(resolved.backendKey);
      searchEmbedder = new HttpEmbedder({
        baseUrl: resolved.url,
        apiPathPrefix: resolved.apiPathPrefix,
        model: httpProbe!.model,
        outputDim: newDim,
        maxInputChars: this.deps.runtime.embedderMaxInputChars,
        encoding,
        apiKey,
        // Interactive search must never throttle itself.
        maxConcurrentRequests: Infinity,
      });
    }
    flipActiveIndexVersion(db, {
      newVersion,
      oldVersion: activeVersion,
      embedModel: modelLabel,
      embedDim: newDim,
    });
    this.deps.searchPipeline.setEmbedder(searchEmbedder);
    this.log.info(
      `Atomic flip complete: generation ${newVersion} now serving vector search; generation ${activeVersion} retired.`,
    );

    // 4. Delete the retired generation's file (bounded to two on disk → one),
    //    then dispose the old steady-state worker and start a fresh one on the
    //    new active generation. The old worker was either disposed at the quiesce
    //    (HTTP old model) or kept alive paused as the old query embedder (LOCAL
    //    old model); now that query embedding is repointed to the new model it can
    //    go. stopWorker is idempotent, so this is a no-op in the already-disposed
    //    case.
    const retiredFile = usearchPathForVersion(this.deps.configDir, activeVersion);
    // Include the retired generation's encrypted sidecar — it belongs to the
    // old generation and would otherwise linger.
    for (const p of [retiredFile, `${retiredFile}.tmp`, `${retiredFile}.enc`]) {
      try {
        unlinkSync(p);
      } catch {
        // already gone — fine
      }
    }

    await this.stopWorker();
    await this.startIndexerAttempt(signal);

    // For a LOCAL target the build worker was the query-embedder bridge across
    // the flip; startIndexer has now re-attached the fresh steady-state worker as
    // the query embedder, so the bridge can be torn down (frees the extra model
    // copy). For an HTTP target it was already disposed before the flip.
    if (localTarget) {
      await buildEmbedder.dispose().catch(() => {});
    }
  }

  /**
   * Construct the embedder that re-embeds the corpus into the new generation,
   * chosen by the TARGET model's kind (epic #1011, mechanism 1):
   *
   *   - HTTP target → a throttled main-thread {@link HttpEmbedder} (non-blocking
   *     network I/O; bounded so the bulk re-embed can't starve interactive search
   *     at the server).
   *   - LOCAL target → a {@link BuildWorkerEmbedder} hosting the new GGUF in a
   *     short-lived worker thread, so the CPU/GPU-bound embed runs off the gateway
   *     event loop. Its `embed()` awaits the worker's model load internally, so a
   *     load failure surfaces on the first build batch — inside the build's
   *     try/catch, which disposes the worker — never as a leak from construction.
   *
   * Both implement the `Embedder` interface, so {@link GenerationBuilder} is
   * oblivious to which one it drives.
   */
  private async createBuildEmbedder(
    resolved: Extract<ResolvedAssignment, { kind: "http" | "local" }>,
    httpProbe: { model: string; dim: number } | undefined,
    newDim: number,
    encoding: EmbedderEncoding,
  ): Promise<Embedder> {
    if (resolved.kind === "local") {
      const { BuildWorkerEmbedder } = await import("../workers/build-embedder-proxy.js");
      return new BuildWorkerEmbedder({
        modelPath: resolved.modelPath,
        embedDim: newDim,
        encoding,
        embedConcurrency: this.deps.runtime.embedConcurrency,
        embedderContextSize: this.deps.runtime.embedderContextSize,
        embedderTimeoutMs: this.deps.runtime.embedderTimeoutMs,
        embedderMaxInputChars: this.deps.runtime.embedderMaxInputChars,
      });
    }
    const { HttpEmbedder } = await import("./http-embedder.js");
    const apiKey = this.deps.inferenceRegistry.getBackendApiKey(resolved.backendKey);
    return new HttpEmbedder({
      baseUrl: resolved.url,
      apiPathPrefix: resolved.apiPathPrefix,
      model: httpProbe!.model,
      outputDim: newDim,
      maxInputChars: this.deps.runtime.embedderMaxInputChars,
      encoding,
      apiKey,
      maxConcurrentRequests: this.deps.runtime.embedConcurrency,
    });
  }

  /**
   * Force a final HNSW save in the indexer worker before {@link shutdownIndexer}
   * disposes it, so the on-disk graph (and `usearch_saved_seq`) reflect the
   * current in-memory graph and the next boot RESTORES instead of rebuilding.
   * The save can exceed the worker's 5s dispose ack for a large graph, so it
   * runs on its own generous timeout. No-op if the indexer never started.
   * Returns whether the graph was saved (false → next boot rebuilds; the caller
   * proceeds either way — fail-safe).
   */
  async flushIndexerSave(): Promise<boolean> {
    const proxy = this._indexerOwner;
    if (!proxy) return false;
    return proxy.flushSave();
  }

  /**
   * Tear down the indexer worker (drains any in-flight cycle and flushes the
   * plaintext graph via the worker's close()) and join any in-flight startup or
   * swap. A no-op when the worker never came online (embedder
   * disabled/unresolved/missing), so doShutdown can call it unconditionally.
   */
  async shutdownIndexer(): Promise<void> {
    this.shuttingDown = true;
    const startup = this.startupInFlight;
    const swap = this.queuedSwap ?? this.embedSwapInFlight;
    this.startupAbort?.abort();
    this.buildAbort?.abort();
    if (this.indexerShutdownHandle) {
      await this.indexerShutdownHandle();
    } else if (startup) {
      // Before worker ownership, cancellation must settle so a delayed retry
      // cannot spawn after shutdown. Once a worker owns index.db, disposing its
      // shutdown handle is the authoritative stop path; whenReady may still be
      // unwinding and must not hold shutdown open.
      await startup;
    }
    // Graceful swaps own main-thread DB/build resources even before their
    // steady-state worker starts. Join their abort cleanup before the gateway
    // closes DB handles or encrypts sidecars.
    if (swap) await swap;
  }
}

/** Human-readable one-liner of an `EmbedderEncoding` for the boot log. */
function describeEncoding(encoding: EmbedderEncoding): string {
  switch (encoding.kind) {
    case "none":
      return "(symmetric)";
    case "text-prefix":
      return `query="${encoding.query}" document="${encoding.document}"`;
    case "api-param":
      return `param=${encoding.param} query="${encoding.queryValue}" document="${encoding.documentValue}"`;
  }
}
