// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Runtime-settings resolver for the gateway.
 *
 * These knobs grew out of the #192 crash investigation — the original
 * "mitigations on/off" master flag has been broken apart into individual
 * config fields so each one is independently tunable via
 * `omnesis.json` (config file, CLI `config set`, or portal).
 *
 * Precedence for each knob, highest to lowest:
 *   1. `OMNESIS_*` environment variable (where one exists).
 *   2. Explicit value in `omnesis.json`.
 *   3. The hardcoded default in this module.
 *
 * Defaults reflect the post-2026-04-28 architecture:
 *   - `journalMode = WAL` is the default. The single-writer
 *     architecture from #192 (writer worker owns the only writable
 *     handle, all other handles read-only) is what made WAL safe;
 *     ~73 cumulative minutes of chaos pressure with 800+ explicit
 *     `wal_checkpoint(TRUNCATE)` ops produced zero new SIGBUS
 *     reports. WAL gives MVCC-style concurrent reads, which is
 *     a 30-50× win on read-path latency under writer load.
 *     If you do hit a SIGBUS, opt out with
 *     `OMNESIS_JOURNAL_MODE=TRUNCATE` or
 *     `gateway.journalMode: "TRUNCATE"` in `omnesis.json` —
 *     no code change needed.
 *   - Indexer knobs lean stability-conservative; tighten them in
 *     `omnesis.json` if you accept the responsiveness/reliability
 *     trade.
 */

import { availableParallelism } from "node:os";
import { createLogger, parseDuration } from "@omnesis/core";
import {
  isSafeHttpsOrigin,
  isSafeMcpResourceUrl,
  isSafePublicBaseUrl,
  type OmnesisConfig,
} from "@omnesis/config";
import { resolveBackgroundWorkerNice } from "./workers/worker-priority.js";
import { DEFAULT_INGEST_YIELD_BATCH } from "./async-yield.js";
import { DEFAULT_ANALYTICS_STREAM_REKEY_MAX_ROWS } from "./analytics/settings.js";
import { DEFAULT_ADMISSION } from "./scheduler/admission.js";
import { STARVATION_MIN_INTERVAL_MS } from "./scheduler/internals.js";

const log = createLogger("gateway:settings");

export interface ResolvedRuntimeSettings {
  /** `omnesis.db` journal mode on the writer handle. */
  journalMode: "WAL" | "TRUNCATE";
  /** Indexer wake-up period, ms. */
  indexCycleIntervalMs: number;
  /** Shortened cycle interval when the previous cycle found work, ms. */
  indexCycleBacklogIntervalMs: number;
  /** Docs per batch transaction in the indexer DB write phase. */
  dbWriteBatchSize: number;
  /** `reconcileDeletedDocuments` period, ms. */
  reconcileIntervalMs: number;
  /** `reindexMissing` period, ms. */
  reindexMissingIntervalMs: number;
  /** Total embedder slots (1 query + (N-1) indexer). */
  embedConcurrency: number;
  /** Docs per `listDocuments` call during an indexer cycle. */
  indexerPageSize: number;
  /** Sleep between indexer pages under backlog, ms. */
  indexerBetweenPageSleepMs: number;
  /** Whether to run `reindexMissing` at gateway boot. */
  reindexMissingAtBoot: boolean;
  /** Chunker max chunk length, characters. */
  chunkerChunkSize: number;
  /** Chunker per-chunk overlap, characters. */
  chunkerOverlap: number;
  /** Embedder per-slot context size, tokens. */
  embedderContextSize: number;
  /** Embedder per-call wall-clock timeout, ms. */
  embedderTimeoutMs: number;
  /** Embedder hard cap on input length, characters. */
  embedderMaxInputChars: number;
  /** Compute runner worker count (read-only SQLite handles). */
  ioConcurrency: number;
  /** Page-cache budget (bytes) for the main-thread compute/read handle. */
  readCacheSizeBytes: number;
  /** Page-cache budget (bytes) for each io-worker's read handle. */
  ioReadCacheSizeBytes: number;
  /**
   * Dedicated search-worker pool (Slice 3B). `searchWorkerConcurrency` worker
   * threads run candidate generation off the main event loop; 0 disables the
   * pool (pure main-thread candidate-gen). Above `searchWorkerMaxInflight`
   * concurrent calls the pipeline runs inline on main rather than queueing.
   */
  searchWorkerConcurrency: number;
  searchWorkerMaxInflight: number;
  /** Page-cache budget (bytes) for each search-worker read handle. */
  searchWorkerCacheSizeBytes: number;
  /**
   * Read-worker slots kept free of background compute so an interactive read
   * (browsePeople, lookupPeople, merge-candidates, doc-search) never waits
   * behind in-flight background. Clamped to `ioConcurrency − 1`; 0 disables.
   */
  ioReservedUserSlots: number;
  /** Automatic admission control (defer background while a user is present). */
  admission: { enabled: boolean; maxHoldMs: number; pumpIntervalMs: number };
  /** CPU pool worker count (no database handle, pure compute). */
  cpuConcurrency: number;
  /** OS nice for the background compute worker threads (Linux only). */
  backgroundWorkerNice: number;
  ingestYieldBatch: number;
  /** Largest DuckDB table admitted to the atomic online stream-key rebuild. */
  analyticsStreamRekeyMaxRows: number;
  /** Absent means the analytics pool picks its machine-dependent default. */
  analyticsMemoryLimitMb: number | undefined;
  analyticsThreads: number | undefined;
  /**
   * Minimum free disk (megabytes) on the DB volume below which ingestion
   * (507) + indexing pause. See #15 / `gateway.minFreeDiskMb`.
   */
  minFreeDiskMb: number;
  /**
   * Snapshots that must all omit a document before its absence counts as a
   * deletion. See `gateway.snapshotAbsence.minObservations`.
   */
  snapshotAbsenceMinObservations: number;
  /**
   * How long a document must be continuously absent from a source's snapshots
   * before it is deleted, ms. See `gateway.snapshotAbsence.minAge`.
   */
  snapshotAbsenceMinAgeMs: number;
  /**
   * Ceiling on absences recorded from one snapshot. See
   * `gateway.snapshotAbsence.maxMarksPerSnapshot`.
   */
  snapshotAbsenceMaxMarksPerSnapshot: number;
  /** Startup grace before due absences may be deleted, ms. */
  snapshotAbsenceDeletionGraceMs: number;
  // ── Gateway-process timing budgets (gateway.timings.* in config) ──
  /** Slow-request log/metrics threshold, ms. 0 disables the warn line. */
  slowRequestMs: number;
  /** WebSocket heartbeat interval, ms. */
  wsHeartbeatIntervalMs: number;
  /** WS hello-handshake deadline, ms. */
  wsAuthTimeoutMs: number;
  /** WS command response timeout, ms. */
  wsCommandTimeoutMs: number;
  /** `AuthFlowRegistry` entry TTL, ms. */
  authFlowTtlMs: number;
  /** Pairing-code default TTL, ms. */
  pairingTtlMs: number;
  /** Portal session TTL, ms. */
  sessionTtlMs: number;
  /** Minimum interval between active portal-session refresh writes, ms. */
  sessionRefreshThrottleMs: number;
  /**
   * Externally-reachable HTTPS base URL of this gateway (no trailing slash),
   * or `undefined` when unset. MCP OAuth derives its canonical issuer and
   * resource origin from it; remote MCP access is disabled without it. OAuth
   * / aggregator sources also build `${publicBaseUrl}/oauth/callback`; when
   * unset they fall back to the local-only `localhost:3003` callback. See
   * `gateway.publicBaseUrl` in the config schema.
   */
  publicBaseUrl: string | undefined;
  /** Exact HTTPS origins the installer proved use platform-trusted TLS. */
  pairingSystemTrustOrigins: readonly string[];
  /** Exact OAuth protected-resource identifiers served by this gateway. */
  mcpResourceUrls: readonly string[];
  // ── Backfill periodic tasks (gateway.backfill.* in config) ──
  //
  // Flat field-per-knob shape: each `*Ms` / `*Size` field flows into
  // the matching `BackfillTaskOpts` field on `createBackfillTasks`.
  // The config schema groups these under nested sub-blocks
  // (`backfill.links`, `backfill.people`, …) for operator readability;
  // the flatness here mirrors the existing opts interface and keeps
  // wiring at the call site a plain field-to-field copy.
  //
  /** Link-extraction backfill drip cadence, ms. */
  linkBackfillIntervalMs: number;
  /** Link-extraction idle backoff, ms. */
  linkIdleDelayMs: number;
  /** URL reconcile tick cadence, ms. */
  linkReconcileIntervalMs: number;
  /** URL rows scanned per tick by the reconcile pass. */
  linkReconcileBatchSize: number;
  /** People-resolution active drip cadence, ms. */
  peopleBatchIntervalMs: number;
  /** People-resolution idle backoff, ms. */
  peopleIdleDelayMs: number;
  /** Docs per people-resolution tick. */
  peopleBatchSize: number;
  /** People-counts refresh cadence, ms. */
  peopleCountsRefreshIntervalMs: number;
  /** Source-stats refresh cadence, ms. */
  statsRefreshIntervalMs: number;
  /** Catalog-stats refresh cadence, ms. */
  catalogRefreshIntervalMs: number;
  /** `/links/stats` materialization active cadence, ms. */
  linkStatsRefreshIntervalMs: number;
  /** `/links/stats` idle backoff, ms. */
  linkStatsIdleDelayMs: number;
  /** Interaction-score refresh active cadence, ms. */
  interactionScoresRefreshIntervalMs: number;
  /** Interaction-score idle backoff, ms. */
  interactionScoresIdleDelayMs: number;
  /** Merge-rules eval active cadence, ms. */
  mergeRulesEvalIntervalMs: number;
  /** Merge-rules eval idle backoff, ms. */
  mergeRulesEvalIdleDelayMs: number;
  /** Auto-detect cadence, ms. */
  autoDetectIntervalMs: number;
  /** Fuzzy merge-candidate detector active cadence, ms. */
  mergeCandidatesDetectIntervalMs: number;
  /** Fuzzy merge-candidate detector idle backoff, ms. */
  mergeCandidatesDetectIdleDelayMs: number;
}

const DEFAULTS = {
  journalMode: "WAL" as const,
  indexCycleInterval: "5m",
  indexCycleBacklogInterval: "1s",
  dbWriteBatchSize: 50,
  reconcileInterval: "1h",
  reindexMissingInterval: "1h",
  embedConcurrency: 2,
  ioConcurrency: 6,
  // Read-handle page caches. Larger than SQLite's ~2 MiB default so hot pages
  // stay resident and, under storage encryption, don't re-decrypt on every
  // read. The main compute handle gets more (it serves interactive reads); each
  // io worker gets 64 MiB (× ioConcurrency).
  readCacheSizeBytes: 256 * 1024 * 1024,
  ioReadCacheSizeBytes: 64 * 1024 * 1024,
  // Search-worker pool (Slice 3B). One worker de-blocks the main event loop for
  // candidate generation; the inflight ceiling of 2 keeps a slow query from
  // queueing behind another on the single-worker FIFO (excess runs inline).
  // 64 MiB per handle matches the io-worker's read-handle budget. Mirrored as
  // gateway.searchWorker.* in CONFIG_DEFAULTS.
  // 3 workers so an agent's parallel search burst (typically 3–4 calls per
  // reasoning step) runs concurrently off the main loop instead of serializing
  // through one worker or spilling onto the event loop via the inline fallback.
  searchWorkerConcurrency: 3,
  // Keep a burst on the pool (3 running + up to 3 queued) before the inline
  // main-thread fallback engages as a last-resort safety valve.
  searchWorkerMaxInflight: 6,
  searchWorkerCacheSizeBytes: 64 * 1024 * 1024,
  // Keep 1 of the io pool's workers free of background compute (see
  // gateway.ioReservedUserSlots) so an interactive read always has a worker to
  // land on without waiting for an in-flight background scan to drain.
  ioReservedUserSlots: 1,
  admission: DEFAULT_ADMISSION,
  // The cpu pool is bursty background batch compute (near-dup signing/DF,
  // chunking, link extraction). Size it to roughly half the cores minus a
  // margin so that when it's fully saturated it still leaves headroom for
  // the io pool, the writer, and — critically — the latency-sensitive main
  // and indexer threads (which serve interactive search query-embeds). The
  // previous `cores - 5` ignored the 6-worker io pool and could oversubscribe
  // the box, starving query-embeds during a heavy resync. Override via
  // gateway.cpuConcurrency / OMNESIS_CPU_CONCURRENCY.
  cpuConcurrency: Math.max(2, Math.floor(availableParallelism() / 2) - 2),
  // Low-disk write guard (#15). Below this many MB free on the DB volume,
  // ingestion is rejected with 507 and indexing cycles are skipped so the
  // gateway never writes under low disk. 500 MB is a comfortable floor for
  // a WAL checkpoint + an indexer batch flush on a typical corpus.
  minFreeDiskMb: 500,
  // Floor under snapshot-driven deletion (see `gateway.snapshotAbsence`). An
  // omission has to be corroborated by three separate snapshots AND stand for
  // a full day: three alone lets a source syncing every 30s burn the window in
  // an afternoon, a day alone ages documents out of a source that stopped
  // syncing while nothing was watching. The mark ceiling keeps a wholesale
  // absence from fanning out into an unbounded write on the single writer.
  snapshotAbsenceMinObservations: 3,
  snapshotAbsenceMinAge: "24h",
  snapshotAbsenceMaxMarksPerSnapshot: 200,
  snapshotAbsenceDeletionGrace: "5m",
  analyticsStreamRekeyMaxRows: DEFAULT_ANALYTICS_STREAM_REKEY_MAX_ROWS,
  pageSize: 200,
  betweenPageSleep: "500ms",
  reindexMissingAtBoot: false,
  // Gateway-process timing budgets — moved out of inline magic
  // numbers (ws.ts, auth-flows.ts, DeviceRepository.ts pairing,
  // TokenRepository.ts session, portal.ts cookie, server.ts slow-
  // request) so operators can tune via `omnesis.json` without code
  // edits. See `gateway.timings.*` in the config schema.
  slowRequest: "500ms",
  wsHeartbeatInterval: "30s",
  wsAuthTimeout: "5s",
  wsCommandTimeout: "30s",
  authFlowTtl: "15m",
  pairingTtl: "10m",
  sessionTtl: "30d",
  sessionRefreshThrottle: "1h",
  // Indexer chunker / embedder tunables. Defaults mirror the built-in
  // fallbacks in `indexer/chunker.ts` (DEFAULT_CHUNK_SIZE / DEFAULT_OVERLAP)
  // and `indexer/embedder.ts` (DEFAULT_CONTEXT_SIZE / EMBED_TIMEOUT_MS /
  // MAX_INPUT_CHARS). Operators tune via `indexer.chunker.*` and
  // `indexer.embedder.*` in `omnesis.json`.
  chunkerChunkSize: 2048,
  chunkerOverlap: 512,
  embedderContextSize: 2048,
  embedderTimeoutMs: 30_000,
  embedderMaxInputChars: 2048 * 3,
  // Backfill periodic tasks. Each default is the active drip cadence
  // (or idle backoff, or batch size) the corresponding task runs at
  // when no `gateway.backfill.*` override is set. Rationale for each
  // value is in the per-knob comments below.
  //
  // Link extraction is bursty (one tick per upsert event); the 1s
  // active cadence drains a fresh inbox quickly, the 30s idle keeps
  // the scheduler quiet when there's nothing to do.
  linkBackfillInterval: "1s",
  linkIdleDelay: "30s",
  // URL reconcile: 500 rows per 5-minute tick drains a ~150k-row
  // backlog in ~24h. Crank both for a one-shot drain after a code
  // change that opens up previously-stuck rows.
  linkReconcileInterval: "5m",
  linkReconcileBatchSize: 500,
  // People resolution is the per-doc fanout that populates
  // `document_people`. 200ms active cadence + 500 docs per tick
  // keeps a fresh-deploy backfill draining at ~2.5k docs/sec.
  peopleBatchInterval: "200ms",
  peopleIdleDelay: "30s",
  peopleBatchSize: 500,
  // Merge-pass is the people-graph closure; 10 min is the floor
  // for "user-issued merges become visible within a coffee".
  peopleCountsRefreshInterval: "10m",
  // Source-stats refresh is a cheap dirty-flag scan; 30s is the
  // upper bound on how stale the portal's source list can be.
  statsRefreshInterval: "30s",
  // Catalog stats are purely periodic (no work to backlog), 5 min
  // is fine for the per-source aggregate the portal reads.
  catalogRefreshInterval: "5m",
  // /links/stats materialization: 30s active poll; when nothing is
  // mutating `document_links` the refresh short-circuits on the
  // `needs_refresh=0` PK lookup so the idle backoff just paces the
  // noop. Idle is kept short (30s) because /links/stats reads the
  // materialized snapshot from the HTTP read-only handle, which
  // Link stats reads hit trigger-maintained counters (< 1ms).
  // This task reconciles those counters against a full table scan
  // as insurance against drift. Hourly active / 6h idle is plenty.
  linkStatsRefreshInterval: "1h",
  linkStatsIdleDelay: "6h",
  // Per-person interaction-score refresh: 60s active = recompute
  // ~once a minute when `document_people` / merges are moving;
  // 5-minute idle when caught up. The meta-row poll is cheap (one
  // PK lookup) but the full join is heavier than link_stats so we
  // don't want to fire it more often than necessary.
  interactionScoresRefreshInterval: "60s",
  interactionScoresIdleDelay: "5m",
  // Merge-rules eval: user-issued rule mutations kick the task
  // directly (Scheduler.kickPeriodic), so merges materialize within
  // seconds regardless of cadence. The 60s active / 5m idle cycle
  // covers system rules and repair. Auto-detect is less frequent
  // (5 min) — the alias graph changes mostly during heavy backfill
  // which only happens early in a fresh deploy.
  mergeRulesEvalInterval: "60s",
  mergeRulesEvalIdleDelay: "5m",
  autoDetectInterval: "5m",
  // Fuzzy candidate detection is gated on merge-rules eval being
  // current AND interaction-scores being current — so it only runs
  // against a steady-state graph. Active 5-min poll is the upper
  // bound; the gating typically pushes us into the 30-min idle.
  mergeCandidatesDetectInterval: "5m",
  mergeCandidatesDetectIdleDelay: "30m",
};

function envString(key: string): string | undefined {
  const v = process.env[key];
  return v !== undefined && v.length > 0 ? v : undefined;
}

function envIntPositive(key: string): number | undefined {
  const raw = envString(key);
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Like {@link envIntPositive} but admits 0 — for knobs where 0 means "disable". */
function envIntNonNeg(key: string): number | undefined {
  const raw = envString(key);
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Bound the admission pump interval strictly below STARVATION_MIN_INTERVAL_MS.
 * A pump tick at or above the starvation interval phase-aliases with the
 * once-per-interval starvation release and undercuts the anti-starvation floor,
 * so a too-large operator value is clamped (and logged) rather than honored.
 */
function clampPumpInterval(ms: number): number {
  const ceiling = STARVATION_MIN_INTERVAL_MS - 1;
  if (ms > ceiling) {
    log.warn(
      `OMNESIS_ADMISSION_PUMP_INTERVAL_MS=${ms} >= starvation interval ${STARVATION_MIN_INTERVAL_MS}ms; clamped to ${ceiling}ms to preserve the anti-starvation floor`,
    );
    return ceiling;
  }
  return ms;
}

/** Parse a boolean env flag (1/true/yes/on = true, 0/false/no/off = false). */
function envBool(key: string): boolean | undefined {
  const raw = envString(key)?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return undefined;
}

function resolveJournalMode(config: OmnesisConfig | undefined): "WAL" | "TRUNCATE" {
  const envVal = envString("OMNESIS_JOURNAL_MODE");
  if (envVal === "WAL" || envVal === "TRUNCATE") return envVal;
  return config?.gateway?.journalMode ?? DEFAULTS.journalMode;
}

function resolveDuration(
  envKey: string,
  configValue: string | undefined,
  fallback: string,
): number {
  const raw = envString(envKey) ?? configValue ?? fallback;
  return parseDuration(raw);
}

export function resolveRuntimeSettings(config: OmnesisConfig | undefined): ResolvedRuntimeSettings {
  const indexer = config?.indexer;
  const timings = config?.gateway?.timings;
  const publicBaseUrl = resolvePublicBaseUrl(config);
  // Slow-request keeps a back-compat env override
  // (`OMNESIS_SLOW_REQUEST_MS`) — env wants ms, the schema wants a
  // duration string, so resolve them separately. A 0 in env disables
  // the warn line entirely (matches the prior server.ts behaviour).
  const slowRequestEnv = envString("OMNESIS_SLOW_REQUEST_MS");
  const slowRequestMs =
    slowRequestEnv !== undefined && Number.isFinite(Number(slowRequestEnv))
      ? Math.max(0, Number(slowRequestEnv))
      : timings?.slowRequest !== undefined
        ? parseDuration(timings.slowRequest)
        : parseDuration(DEFAULTS.slowRequest);
  return {
    journalMode: resolveJournalMode(config),
    indexCycleIntervalMs: resolveDuration(
      "OMNESIS_INDEX_INTERVAL",
      indexer?.cycleInterval,
      DEFAULTS.indexCycleInterval,
    ),
    indexCycleBacklogIntervalMs: resolveDuration(
      "OMNESIS_INDEX_BACKLOG_INTERVAL",
      indexer?.cycleBacklogInterval,
      DEFAULTS.indexCycleBacklogInterval,
    ),
    dbWriteBatchSize:
      envIntPositive("OMNESIS_INDEXER_DB_WRITE_BATCH_SIZE") ??
      indexer?.dbWriteBatchSize ??
      DEFAULTS.dbWriteBatchSize,
    reconcileIntervalMs: resolveDuration(
      "OMNESIS_RECONCILE_INTERVAL",
      indexer?.reconcileInterval,
      DEFAULTS.reconcileInterval,
    ),
    reindexMissingIntervalMs: resolveDuration(
      "OMNESIS_REINDEX_MISSING_INTERVAL",
      indexer?.reindexMissingInterval,
      DEFAULTS.reindexMissingInterval,
    ),
    embedConcurrency:
      envIntPositive("OMNESIS_EMBED_CONCURRENCY") ??
      indexer?.embedConcurrency ??
      DEFAULTS.embedConcurrency,
    ioConcurrency:
      envIntPositive("OMNESIS_IO_CONCURRENCY") ??
      config?.gateway?.ioConcurrency ??
      DEFAULTS.ioConcurrency,
    readCacheSizeBytes: config?.gateway?.readHandle?.cacheSizeBytes ?? DEFAULTS.readCacheSizeBytes,
    ioReadCacheSizeBytes:
      config?.gateway?.readHandle?.ioCacheSizeBytes ?? DEFAULTS.ioReadCacheSizeBytes,
    ioReservedUserSlots: config?.gateway?.ioReservedUserSlots ?? DEFAULTS.ioReservedUserSlots,
    searchWorkerConcurrency:
      envIntNonNeg("OMNESIS_SEARCH_WORKER_CONCURRENCY") ??
      config?.gateway?.searchWorker?.concurrency ??
      DEFAULTS.searchWorkerConcurrency,
    searchWorkerMaxInflight:
      envIntPositive("OMNESIS_SEARCH_WORKER_MAX_INFLIGHT") ??
      config?.gateway?.searchWorker?.maxInflightBeforeFallback ??
      DEFAULTS.searchWorkerMaxInflight,
    searchWorkerCacheSizeBytes:
      config?.gateway?.searchWorker?.cacheSizeBytes ?? DEFAULTS.searchWorkerCacheSizeBytes,
    admission: {
      enabled: envBool("OMNESIS_ADMISSION_ENABLED") ?? DEFAULTS.admission.enabled,
      maxHoldMs: envIntPositive("OMNESIS_ADMISSION_MAX_HOLD_MS") ?? DEFAULTS.admission.maxHoldMs,
      // The pump cadence must stay strictly below STARVATION_MIN_INTERVAL_MS so
      // a pump tick can't phase-alias with the once-per-interval starvation
      // release and halve the anti-starvation floor. Clamp a misconfiguration
      // rather than silently degrade it, and tell the operator.
      pumpIntervalMs: clampPumpInterval(
        envIntPositive("OMNESIS_ADMISSION_PUMP_INTERVAL_MS") ?? DEFAULTS.admission.pumpIntervalMs,
      ),
    },
    cpuConcurrency:
      envIntPositive("OMNESIS_CPU_CONCURRENCY") ??
      config?.gateway?.cpuConcurrency ??
      DEFAULTS.cpuConcurrency,
    // env > config > default + clamp all live in resolveBackgroundWorkerNice,
    // so the same tested resolver serves both here and its own unit tests.
    backgroundWorkerNice: resolveBackgroundWorkerNice(config?.gateway?.backgroundWorkerNice),
    ingestYieldBatch: config?.gateway?.ingestYieldBatch ?? DEFAULT_INGEST_YIELD_BATCH,
    analyticsStreamRekeyMaxRows:
      config?.gateway?.analyticsStreamRekeyMaxRows ?? DEFAULTS.analyticsStreamRekeyMaxRows,
    analyticsMemoryLimitMb:
      envIntPositive("OMNESIS_ANALYTICS_MEMORY_LIMIT_MB") ??
      config?.gateway?.analyticsMemoryLimitMb,
    analyticsThreads:
      envIntPositive("OMNESIS_ANALYTICS_THREADS") ?? config?.gateway?.analyticsThreads,
    minFreeDiskMb:
      envIntPositive("OMNESIS_MIN_FREE_DISK_MB") ??
      config?.gateway?.minFreeDiskMb ??
      DEFAULTS.minFreeDiskMb,
    snapshotAbsenceMinObservations:
      config?.gateway?.snapshotAbsence?.minObservations ?? DEFAULTS.snapshotAbsenceMinObservations,
    snapshotAbsenceMinAgeMs: parseDuration(
      config?.gateway?.snapshotAbsence?.minAge ?? DEFAULTS.snapshotAbsenceMinAge,
    ),
    snapshotAbsenceMaxMarksPerSnapshot:
      config?.gateway?.snapshotAbsence?.maxMarksPerSnapshot ??
      DEFAULTS.snapshotAbsenceMaxMarksPerSnapshot,
    snapshotAbsenceDeletionGraceMs: parseDuration(
      config?.gateway?.snapshotAbsence?.deletionGrace ?? DEFAULTS.snapshotAbsenceDeletionGrace,
    ),
    indexerPageSize:
      envIntPositive("OMNESIS_INDEXER_PAGE_SIZE") ?? indexer?.pageSize ?? DEFAULTS.pageSize,
    indexerBetweenPageSleepMs: resolveDuration(
      "OMNESIS_INDEXER_BETWEEN_PAGE_SLEEP",
      indexer?.betweenPageSleep,
      DEFAULTS.betweenPageSleep,
    ),
    reindexMissingAtBoot: indexer?.reindexMissingAtBoot ?? DEFAULTS.reindexMissingAtBoot,
    chunkerChunkSize: indexer?.chunker?.chunkSize ?? DEFAULTS.chunkerChunkSize,
    chunkerOverlap: indexer?.chunker?.overlap ?? DEFAULTS.chunkerOverlap,
    embedderContextSize: indexer?.embedder?.contextSize ?? DEFAULTS.embedderContextSize,
    embedderTimeoutMs: indexer?.embedder?.timeoutMs ?? DEFAULTS.embedderTimeoutMs,
    embedderMaxInputChars: indexer?.embedder?.maxInputChars ?? DEFAULTS.embedderMaxInputChars,
    slowRequestMs,
    wsHeartbeatIntervalMs: parseDuration(
      timings?.wsHeartbeatInterval ?? DEFAULTS.wsHeartbeatInterval,
    ),
    wsAuthTimeoutMs: parseDuration(timings?.wsAuthTimeout ?? DEFAULTS.wsAuthTimeout),
    wsCommandTimeoutMs: parseDuration(timings?.wsCommandTimeout ?? DEFAULTS.wsCommandTimeout),
    authFlowTtlMs: parseDuration(timings?.authFlowTtl ?? DEFAULTS.authFlowTtl),
    pairingTtlMs: parseDuration(timings?.pairingTtl ?? DEFAULTS.pairingTtl),
    sessionTtlMs: parseDuration(timings?.sessionTtl ?? DEFAULTS.sessionTtl),
    sessionRefreshThrottleMs: parseDuration(
      timings?.sessionRefreshThrottle ?? DEFAULTS.sessionRefreshThrottle,
    ),
    publicBaseUrl,
    pairingSystemTrustOrigins: resolvePairingSystemTrustOrigins(),
    mcpResourceUrls: resolveMcpResourceUrls(config, publicBaseUrl),
    ...resolveBackfill(config),
  };
}

function resolvePairingSystemTrustOrigins(): readonly string[] {
  const origin = envString("OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN");
  if (origin === undefined) return [];
  if (isSafeHttpsOrigin(origin)) return [origin];
  log.warn(
    "Ignoring invalid OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN: expected one exact HTTPS origin without credentials, a path, query parameters, a fragment, or a trailing slash",
  );
  return [];
}

function resolveMcpResourceUrls(
  config: OmnesisConfig | undefined,
  publicBaseUrl: string | undefined,
): readonly string[] {
  const configuredResources = config?.gateway?.mcpResourceUrls ?? [];
  if (!publicBaseUrl) {
    if (configuredResources.length > 0) {
      throw new Error(
        "gateway.mcpResourceUrls requires gateway.publicBaseUrl or OMNESIS_PUBLIC_BASE_URL",
      );
    }
    return [];
  }
  const canonical = `${publicBaseUrl}/mcp`;
  const resources = new Set([canonical]);
  const origins = new Set([new URL(canonical).origin]);
  for (const configured of configuredResources) {
    if (!isSafeMcpResourceUrl(configured)) continue;
    const resource = new URL(configured).toString();
    const origin = new URL(resource).origin;
    if (origins.has(origin)) {
      throw new Error(
        "Each gateway MCP resource URL must have a distinct origin after applying OMNESIS_PUBLIC_BASE_URL",
      );
    }
    origins.add(origin);
    resources.add(resource);
  }
  return [...resources];
}

/**
 * Resolve the gateway's externally-reachable HTTPS base URL. Env
 * (`OMNESIS_PUBLIC_BASE_URL`) wins over `gateway.publicBaseUrl` in config.
 * An env value is held to the same shape the config schema enforces
 * (valid HTTPS, no credentials/query/fragment); a malformed value is rejected
 * without echoing it into logs, since it may itself contain credentials.
 */
function resolvePublicBaseUrl(config: OmnesisConfig | undefined): string | undefined {
  const fromEnv = envString("OMNESIS_PUBLIC_BASE_URL");
  if (fromEnv !== undefined) {
    const trimmed = fromEnv.replace(/\/+$/, "");
    if (!isSafePublicBaseUrl(trimmed)) {
      log.warn(
        "Ignoring invalid OMNESIS_PUBLIC_BASE_URL: expected HTTPS without credentials, query parameters, or a fragment — falling back to config / localhost callback",
      );
    } else {
      return trimmed;
    }
  }
  const configured = config?.gateway?.publicBaseUrl;
  if (configured === undefined || isSafePublicBaseUrl(configured)) return configured;
  log.warn(
    "Ignoring invalid gateway.publicBaseUrl: expected HTTPS without credentials, query parameters, or a fragment — using the localhost callback fallback",
  );
  return undefined;
}

function resolveBackfill(config: OmnesisConfig | undefined) {
  const bf = config?.gateway?.backfill;
  return {
    linkBackfillIntervalMs: parseDuration(bf?.links?.interval ?? DEFAULTS.linkBackfillInterval),
    linkIdleDelayMs: parseDuration(bf?.links?.idleDelay ?? DEFAULTS.linkIdleDelay),
    linkReconcileIntervalMs: parseDuration(
      bf?.linkReconcile?.interval ?? DEFAULTS.linkReconcileInterval,
    ),
    linkReconcileBatchSize: bf?.linkReconcile?.batchSize ?? DEFAULTS.linkReconcileBatchSize,
    peopleBatchIntervalMs: parseDuration(bf?.people?.interval ?? DEFAULTS.peopleBatchInterval),
    peopleIdleDelayMs: parseDuration(bf?.people?.idleDelay ?? DEFAULTS.peopleIdleDelay),
    peopleBatchSize: bf?.people?.batchSize ?? DEFAULTS.peopleBatchSize,
    // `mergePass` is the former name of this knob and is still honoured.
    peopleCountsRefreshIntervalMs: parseDuration(
      bf?.peopleCounts?.interval ?? bf?.mergePass?.interval ?? DEFAULTS.peopleCountsRefreshInterval,
    ),
    statsRefreshIntervalMs: parseDuration(
      bf?.sourceStats?.interval ?? DEFAULTS.statsRefreshInterval,
    ),
    catalogRefreshIntervalMs: parseDuration(
      bf?.catalog?.interval ?? DEFAULTS.catalogRefreshInterval,
    ),
    linkStatsRefreshIntervalMs: parseDuration(
      bf?.linkStats?.interval ?? DEFAULTS.linkStatsRefreshInterval,
    ),
    linkStatsIdleDelayMs: parseDuration(bf?.linkStats?.idleDelay ?? DEFAULTS.linkStatsIdleDelay),
    interactionScoresRefreshIntervalMs: parseDuration(
      bf?.interactionScores?.interval ?? DEFAULTS.interactionScoresRefreshInterval,
    ),
    interactionScoresIdleDelayMs: parseDuration(
      bf?.interactionScores?.idleDelay ?? DEFAULTS.interactionScoresIdleDelay,
    ),
    mergeRulesEvalIntervalMs: parseDuration(
      bf?.mergeRulesEval?.interval ?? DEFAULTS.mergeRulesEvalInterval,
    ),
    mergeRulesEvalIdleDelayMs: parseDuration(
      bf?.mergeRulesEval?.idleDelay ?? DEFAULTS.mergeRulesEvalIdleDelay,
    ),
    autoDetectIntervalMs: parseDuration(bf?.autoDetect?.interval ?? DEFAULTS.autoDetectInterval),
    mergeCandidatesDetectIntervalMs: parseDuration(
      bf?.mergeCandidates?.interval ?? DEFAULTS.mergeCandidatesDetectInterval,
    ),
    mergeCandidatesDetectIdleDelayMs: parseDuration(
      bf?.mergeCandidates?.idleDelay ?? DEFAULTS.mergeCandidatesDetectIdleDelay,
    ),
  };
}

/**
 * Log the resolved knob values at boot so the operator can see what's
 * in effect without having to inspect the config + env themselves.
 */
export function announceRuntimeSettings(s: ResolvedRuntimeSettings): void {
  log.info(
    `gateway: journal_mode=${s.journalMode}, ioConcurrency=${s.ioConcurrency}, ioReservedUserSlots=${s.ioReservedUserSlots}, cpuConcurrency=${s.cpuConcurrency}, ` +
      `bgWorkerNice=${s.backgroundWorkerNice}, ingestYieldBatch=${s.ingestYieldBatch}, ` +
      `analyticsStreamRekeyMaxRows=${s.analyticsStreamRekeyMaxRows}, ` +
      `admission=${s.admission.enabled ? `on(maxHold=${s.admission.maxHoldMs}ms,pump=${s.admission.pumpIntervalMs}ms)` : "off"}, ` +
      `minFreeDisk=${s.minFreeDiskMb}MB, ` +
      `snapshotAbsence={observations=${s.snapshotAbsenceMinObservations},minAge=${s.snapshotAbsenceMinAgeMs}ms,maxMarks=${s.snapshotAbsenceMaxMarksPerSnapshot}}; ` +
      `indexer: cycle=${s.indexCycleIntervalMs}ms, cycleBacklog=${s.indexCycleBacklogIntervalMs}ms, ` +
      `dbWriteBatch=${s.dbWriteBatchSize}, reconcile=${s.reconcileIntervalMs}ms, ` +
      `reindexMissing=${s.reindexMissingIntervalMs}ms, reindexMissingAtBoot=${s.reindexMissingAtBoot}, ` +
      `embedConcurrency=${s.embedConcurrency}, pageSize=${s.indexerPageSize}, ` +
      `betweenPageSleep=${s.indexerBetweenPageSleepMs}ms, ` +
      `chunker={size=${s.chunkerChunkSize},overlap=${s.chunkerOverlap}}, ` +
      `embedder={ctx=${s.embedderContextSize},timeout=${s.embedderTimeoutMs}ms,maxInput=${s.embedderMaxInputChars}}; ` +
      `timings: slowRequest=${s.slowRequestMs}ms, ` +
      `wsHeartbeat=${s.wsHeartbeatIntervalMs}ms, ` +
      `wsAuthTimeout=${s.wsAuthTimeoutMs}ms, ` +
      `wsCommandTimeout=${s.wsCommandTimeoutMs}ms, ` +
      `authFlowTtl=${s.authFlowTtlMs}ms, ` +
      `pairingTtl=${s.pairingTtlMs}ms, ` +
      `sessionTtl=${s.sessionTtlMs}ms, ` +
      `sessionRefreshThrottle=${s.sessionRefreshThrottleMs}ms; ` +
      `publicBaseUrl=${s.publicBaseUrl ?? "(unset — loopback OAuth/callback fallback only)"}; ` +
      `backfill: ` +
      `links={interval=${s.linkBackfillIntervalMs}ms,idle=${s.linkIdleDelayMs}ms}, ` +
      `linkReconcile={interval=${s.linkReconcileIntervalMs}ms,batch=${s.linkReconcileBatchSize}}, ` +
      `people={interval=${s.peopleBatchIntervalMs}ms,idle=${s.peopleIdleDelayMs}ms,batch=${s.peopleBatchSize}}, ` +
      `peopleCounts={interval=${s.peopleCountsRefreshIntervalMs}ms}, ` +
      `sourceStats={interval=${s.statsRefreshIntervalMs}ms}, ` +
      `catalog={interval=${s.catalogRefreshIntervalMs}ms}, ` +
      `linkStats={interval=${s.linkStatsRefreshIntervalMs}ms,idle=${s.linkStatsIdleDelayMs}ms}, ` +
      `interactionScores={interval=${s.interactionScoresRefreshIntervalMs}ms,idle=${s.interactionScoresIdleDelayMs}ms}, ` +
      `mergeRulesEval={interval=${s.mergeRulesEvalIntervalMs}ms,idle=${s.mergeRulesEvalIdleDelayMs}ms}, ` +
      `autoDetect={interval=${s.autoDetectIntervalMs}ms}, ` +
      `mergeCandidates={interval=${s.mergeCandidatesDetectIntervalMs}ms,idle=${s.mergeCandidatesDetectIdleDelayMs}ms}`,
  );
}

/**
 * The exact subset of `ResolvedRuntimeSettings` that configures the backfill
 * tasks. Listed once as `BACKFILL_RUNTIME_KEYS`, which is the single source of
 * truth: the `satisfies` clause makes a key that isn't on `ResolvedRuntimeSettings`
 * a compile error, the `BackfillRuntimeOpts` type is `Pick`ed from it (so it
 * can't drift from the source shape), and `backfillOptsFromRuntime` projects
 * through it (so two same-typed fields can't be silently transposed the way a
 * hand-written `{ a: s.b }` object allows). Caller composes the full
 * `BackfillTaskOpts` by spreading this plus the non-config fields (`writeGate`,
 * `ioGate`, `log`, `getNearDupConfig`, `readDb`).
 */
const BACKFILL_RUNTIME_KEYS = [
  "linkBackfillIntervalMs",
  "linkIdleDelayMs",
  "linkReconcileIntervalMs",
  "linkReconcileBatchSize",
  "peopleBatchSize",
  "peopleBatchIntervalMs",
  "peopleIdleDelayMs",
  "peopleCountsRefreshIntervalMs",
  "statsRefreshIntervalMs",
  "catalogRefreshIntervalMs",
  "linkStatsRefreshIntervalMs",
  "linkStatsIdleDelayMs",
  "interactionScoresRefreshIntervalMs",
  "interactionScoresIdleDelayMs",
  "mergeRulesEvalIntervalMs",
  "mergeRulesEvalIdleDelayMs",
  "autoDetectIntervalMs",
  "mergeCandidatesDetectIntervalMs",
  "mergeCandidatesDetectIdleDelayMs",
] as const satisfies readonly (keyof ResolvedRuntimeSettings)[];

export type BackfillRuntimeOpts = Pick<
  ResolvedRuntimeSettings,
  (typeof BACKFILL_RUNTIME_KEYS)[number]
>;

function pick<T, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = obj[k];
  return out;
}

export function backfillOptsFromRuntime(s: ResolvedRuntimeSettings): BackfillRuntimeOpts {
  return pick(s, BACKFILL_RUNTIME_KEYS);
}
