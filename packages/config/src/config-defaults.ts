// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Effective default for each fixed-shape config knob.
 *
 * Every field in `omnesisConfigSchema` is `.optional()` — the real defaults
 * are applied at runtime by resolvers scattered across the gateway
 * (`runtime-settings.ts`, `near-dupes/config.ts`, `search/search-config.ts`, …).
 * This table mirrors those values in config-path shape so the portal's
 * `/config` form can show what an *unset* knob actually does (e.g. that
 * near-duplicate detection is on by default) and distinguish "unset"
 * (inherit this default) from an explicit value.
 *
 * This is a display source of truth. It does NOT feed runtime resolution —
 * the gateway resolvers remain authoritative. The two are kept in lockstep by
 * a cross-check test (`packages/gateway/src/config-defaults.crosscheck.test.ts`)
 * that asserts every value here equals what the live resolver produces for an
 * empty config; a `.test.ts` here asserts every renderable fixed-shape leaf
 * has an entry (or is explicitly listed as having no static default).
 *
 * Record-template leaves (paths with a `*` segment — `sources.<id>.*`, the
 * `search.sourcePriors.weights` / `search.boosts.typeBoosts` value maps) carry
 * a prose description instead: their unset behavior is per-key and contextual
 * rather than one literal value.
 */

/** Nested, config-path-shaped defaults. Only fixed-shape (non-record) knobs appear. */
import { DEFAULT_PUSH_WAKE_RETRY_SETTINGS, DEFAULT_SYNC_LEASE_TTL } from "./config-schema.js";

export const CONFIG_DEFAULTS = {
  agent: {
    // How long a client's "I am showing this conversation" mark is believed
    // without a refresh. Long enough that a client rendering a quiet
    // conversation is not constantly re-marking, short enough that one which
    // died mid-view stops suppressing the unread marker within a couple of
    // minutes.
    conversationViewingTtl: "90s",
    // Sub-agent fan-out caps. subagentTreeTokenBudget has no static
    // default (see NO_STATIC_DEFAULT_PATHS — unset = unbounded).
    subagentDepthCap: 2,
    subagentConcurrencyCap: 4,
    maxToolIterations: 50,
  },
  backupRetention: {
    preUpdateCount: 2,
  },
  releaseCheck: true,
  brain: {
    // Omnesis Brain / Cognition Steward (experimental). Runtime resolution lives in
    // packages/gateway/src/brain/config.ts; a cross-check test there keeps
    // these display mirrors honest.
    workerConcurrency: 1,
    conversationDebounce: "1h",
    conversationMaxDefer: "6h",
    documentUpdateDebounce: "30m",
    documentMaxDefer: "4h",
    derivationBarrier: "30m",
    recencyWindow: "7d",
    decay: {
      backoffBase: "1d",
      backoffCap: "30d",
      datedFloor: "12h",
      datedFraction: 0.5,
    },
    dailyRunHour: 5,
    notesMaxBytes: 8192,
    // The proactive lane — every producer on, all of it still behind the brain
    // gate (experimental mode + an assigned background-agent model).
    awarenessAxis: true,
    synthesis: { enabled: true, cadenceHours: 24, maxPerDay: 1 },
    collision: {
      enabled: true,
      cadenceHours: 24,
      maxPerSweep: 3,
      timeHorizonDays: 60,
      annotationContradictions: { enabled: true, maxPerSweep: 2 },
    },
    digest: { enabled: true, hour: 7, graceMinutes: 45, push: true },
    // Graduated: durable doc/person annotations are on by default under
    // experimental mode. The knob still lets an operator turn them off.
    // Per-basis ceilings tighten confidence the further a claim reasons from
    // its evidence; the floor refuses claims too weak to persist.
    annotations: {
      enabled: true,
      basisCeilings: { quoted: 0.9, inferred: 0.7, synthesized: 0.55 },
      confidenceFloor: 0.25,
    },
    reverification: { enabled: true, intervalDays: 14, maxPerSweep: 12, batchSize: 6 },
    provenanceRecheck: { enabled: true },
    judge: { enabled: true },
    // Bounded: one run per candidate, re-run only on re-detection. Like every
    // producer here it needs the brain gate to run at all.
    mergeAdjudication: { enabled: true },
    bootstrap: {
      enabled: true,
      direction: "recent-first",
      backlogTarget: 200,
      maxRunsPerDay: 200,
      maxRuns: 1000000,
      batchSize: 100,
    },
    sweepsEnabled: true,
  },
  enrichment: {
    // Omnesis-derived enrichment signals (experimental). Runtime resolution
    // lives in packages/gateway/src/enrichment/dates/config.ts. The pass is
    // gated by experimental mode; `enabled` defaults ON there so turning on
    // experimental is the only step needed, and this knob is the off-switch.
    dates: {
      enabled: true,
      batchSize: 50,
      maxCharsPerDoc: 50_000,
      scanBudgetMs: 3_000,
      periodMs: 1_500,
      idlePeriodMs: 300_000,
    },
  },
  search: {
    // Mirrors DEFAULT_SEARCH_PARAMS in the gateway's search-config (config
    // can't import from gateway); the cross-check test pins the two together.
    params: {
      candidateLimit: 50,
      resultLimit: 10,
      rrfK: 60,
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      topRankBonus: 0.05,
      nearTopRankBonus: 0.02,
    },
    // Mirrors DEFAULT_SEARCH_BOOSTS in the gateway's search-config.
    boosts: {
      relevanceBoostWeight: 0.3,
    },
    vector: {
      hnswOverFetch: 10,
      alwaysOverFetch: true,
    },
    diversity: {
      enabled: true,
      bucketBy: "type",
      lambda: 0.7,
    },
    bm25: {
      commonTokenThreshold: 0.1,
    },
    snapshot: {
      enabled: true,
      refreshIntervalMs: 600_000,
    },
    readHandle: {
      mmapBytes: 0,
      cacheSizeBytes: 3 * 1024 * 1024 * 1024,
      prewarm: true,
    },
    sourcePriors: {
      bm25BypassRank: 3,
      autoInverseFrequency: {
        enabled: true,
        strength: 1,
      },
    },
    embedderPrefixes: {
      enabled: false,
    },
  },
  gateway: {
    journalMode: "WAL",
    // `enabled` is retained only so existing config remains valid; consent is per device.
    pushRelay: { enabled: false, url: "https://push.omnesis.app" },
    pushWakeRetry: DEFAULT_PUSH_WAKE_RETRY_SETTINGS,
    ioConcurrency: 6,
    // Mirrors DEFAULTS.ioReservedUserSlots in the gateway's runtime-settings.
    ioReservedUserSlots: 1,
    // Mirrors DEFAULTS.readCacheSizeBytes / ioReadCacheSizeBytes in the
    // gateway's runtime-settings (config can't import from gateway).
    readHandle: {
      cacheSizeBytes: 256 * 1024 * 1024,
      ioCacheSizeBytes: 64 * 1024 * 1024,
    },
    // Mirrors DEFAULTS.searchWorker* in the gateway's runtime-settings (config
    // can't import from gateway); the cross-check test pins the two together.
    searchWorker: {
      concurrency: 3,
      maxInflightBeforeFallback: 6,
      cacheSizeBytes: 64 * 1024 * 1024,
    },
    minFreeDiskMb: 500,
    // Mirrors DEFAULTS.snapshotAbsence* in the gateway's runtime-settings
    // (config can't import from gateway); the cross-check test pins the two
    // together.
    snapshotAbsence: {
      minObservations: 3,
      minAge: "24h",
      maxMarksPerSnapshot: 200,
      deletionGrace: "5m",
    },
    // Mirrors DEFAULT_BACKGROUND_WORKER_NICE in the gateway's worker-priority
    // module (config can't import from gateway); keep the two in sync.
    backgroundWorkerNice: 10,
    // Mirrors DEFAULT_INGEST_YIELD_BATCH in the gateway's async-yield module
    // (config can't import from gateway); keep the two in sync.
    ingestYieldBatch: 250,
    // Mirrors DEFAULT_ANALYTICS_STREAM_REKEY_MAX_ROWS. DuckDB must replace a
    // table atomically to add the stream column to its primary key.
    analyticsStreamRekeyMaxRows: 100_000,
    // cpuConcurrency has a machine-dependent default (max(1, cores - 5)); see
    // NO_STATIC_DEFAULT_PATHS — it carries no static value here.
    timings: {
      slowRequest: "500ms",
      wsHeartbeatInterval: "30s",
      wsAuthTimeout: "5s",
      wsCommandTimeout: "30s",
      authFlowTtl: "15m",
      pairingTtl: "10m",
      sessionTtl: "30d",
      sessionRefreshThrottle: "1h",
    },
    backfill: {
      links: { interval: "1s", idleDelay: "30s" },
      linkReconcile: { interval: "5m", batchSize: 500 },
      people: { interval: "200ms", idleDelay: "30s", batchSize: 500 },
      peopleCounts: { interval: "10m" },
      sourceStats: { interval: "30s" },
      catalog: { interval: "5m" },
      linkStats: { interval: "1h", idleDelay: "6h" },
      interactionScores: { interval: "60s", idleDelay: "5m" },
      mergeRulesEval: { interval: "60s", idleDelay: "5m" },
      autoDetect: { interval: "5m" },
      mergeCandidates: { interval: "5m", idleDelay: "30m" },
    },
    sharedAddressDemotion: { nameThreshold: 15, maxEmails: 5 },
    reauthReminders: {
      initialDelay: "1d",
      multiplier: 2,
      maxDelay: "7d",
      reservationTtl: "5m",
    },
    mobilePermissionReminders: {
      initialDelay: "1d",
      multiplier: 2,
      maxDelay: "7d",
      maxStaleNotifications: 4,
      scanInterval: "15m",
      reservationTtl: "5m",
    },
    subscriptions: {
      semanticMinimumScore: 0.35,
      maxDeliveryAttempts: 8,
      deliveryBaseBackoffMs: 5_000,
      deliveryMaxBackoffMs: 300_000,
    },
    watch: {
      drainIntervalMs: 2_000,
      idleIntervalMs: 15_000,
      batchSize: 500,
      queueCapacity: 50_000,
      evaluateIntervalMs: 5_000,
      idleEvaluateIntervalMs: 30_000,
      eventsPerWatch: 200,
      traceRetained: 2_000,
      promptPeople: 200,
      compileTimeoutMs: 180_000,
      judge: {
        dailyCap: 200,
        perWatchDailyCap: 50,
      },
      delivery: {
        dailyCap: 20,
        perWatchDailyCap: 5,
      },
      wake: {
        dailyCap: 25,
        perWatchDailyCap: 10,
      },
    },
    cors: {
      allowedOrigins: [],
      allowCredentials: false,
      allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
      allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      maxAgeSeconds: 600,
    },
    audit: {
      enabled: false,
      includeUnauthenticated: false,
    },
    mdns: {
      enabled: true,
      hostname: "omnesis.local",
    },
    tls: {
      autoRenew: true,
      renewBeforeDays: 30,
    },
  },
  indexer: {
    cycleInterval: "5m",
    cycleBacklogInterval: "1s",
    dbWriteBatchSize: 50,
    reconcileInterval: "1h",
    reindexMissingInterval: "1h",
    reindexMissingAtBoot: false,
    embedConcurrency: 2,
    pageSize: 200,
    betweenPageSleep: "500ms",
    chunker: {
      chunkSize: 2048,
      overlap: 512,
    },
    embedder: {
      contextSize: 2048,
      timeoutMs: 30_000,
      maxInputChars: 2048 * 3,
    },
  },
  multiDevice: {
    leaseTtl: DEFAULT_SYNC_LEASE_TTL,
  },
  nearDuplicates: {
    enabled: true,
    eligibleDocTypes: ["email", "attachment", "file", "document", "note", "conversation"],
    fileLikeDocTypes: ["attachment", "file", "document"],
    minContentLength: 200,
    maxContentLength: 2_000_000,
    algorithm: {
      shingleSize: 5,
      numHashes: 128,
      bands: 16,
      rows: 8,
      hashSeed: 0xc0ffee,
      stripQuotes: true,
      maxIdfWeight: 8.0,
      recordThreshold: 0.5,
    },
    gate: {
      emailJaccardMin: 0.85,
      emailPairUniqueDf2Min: 5,
      fileLikeJaccardMin: 0.75,
      fileLikePairUniqueDf2Min: 1,
      fileLikeContainmentMin: 0.95,
      automatedSenderPrefixes: [
        "noreply",
        "no-reply",
        "no_reply",
        "donotreply",
        "do-not-reply",
        "do_not_reply",
        "mailer-daemon",
        "mailerdaemon",
        "postmaster",
        "bounce",
        "bounces",
        "notification",
        "notifications",
        "news",
        "newsletter",
        "alerts",
        "alert",
        "support",
        "info",
        "hello",
        "auto-confirm",
        "automated",
      ],
    },
    scheduler: {
      computePeriodMs: 2_000,
      computeIdlePeriodMs: 30_000,
      computeBatchSize: 100,
      maxCandidatesPerDoc: 200,
      dfRefreshPeriodMs: 6 * 60 * 60 * 1000,
      dfMaxAgeMs: 24 * 60 * 60 * 1000,
      dfQuietHourLocal: 3,
      dfRefreshIdlePeriodMs: 60 * 60 * 1000,
      sweepPeriodMs: 10 * 60 * 1000,
      sweepIdlePeriodMs: 60 * 60 * 1000,
      sweepChunkSize: 2_000,
      algoSweepStepsPerTick: 8,
      algoSweepChunkSize: 5_000,
    },
  },
} as const;

/**
 * Renderable fixed-shape leaves that legitimately have NO single static
 * default — globally optional knobs, inherited values, and machine-dependent
 * values. The completeness test treats these as "covered"; contextual
 * descriptions below explain their behavior instead of inventing a literal.
 */
export const NO_STATIC_DEFAULT_PATHS: readonly string[] = [
  // The retrospective lane's off-peak window. Absent means the lane may buy
  // work at any hour — the ABSENCE of a window, not a window with wide bounds,
  // which is the distinction that lets a surface say "no restriction" rather
  // than printing "00:00-00:00" as though the operator had chosen it.
  "/brain/bootstrap/activeHours/from",
  "/brain/bootstrap/activeHours/to",
  // A compile turn's reasoning ceiling. Deliberately without a static default:
  // unset leaves the compile exactly as the assigned backend runs it, and
  // setting it swaps the model's own judgement about how long to think for a
  // fixed budget. That is a trade to measure, not to default someone into.
  "/gateway/watch/compileReasoningTokens",
  // The former spelling of `/gateway/backfill/peopleCounts`. No default of
  // its own: unset means "whatever `peopleCounts` says", and it is read only
  // so a rename does not quietly drop tuning somebody already wrote.
  "/gateway/backfill/mergePass/interval",
  // The deprecated spelling of `/gateway/watch`. It has no defaults of its own:
  // unset means "whatever `watch` says", and it is read only so that a rename
  // does not quietly drop tuning somebody already wrote.
  "/gateway/watchV2/drainIntervalMs",
  "/gateway/watchV2/idleIntervalMs",
  "/gateway/watchV2/batchSize",
  "/gateway/watchV2/queueCapacity",
  "/gateway/watchV2/evaluateIntervalMs",
  "/gateway/watchV2/idleEvaluateIntervalMs",
  "/gateway/watchV2/eventsPerWatch",
  "/gateway/watchV2/traceRetained",
  "/gateway/watchV2/compileTimeoutMs",
  "/gateway/watchV2/promptPeople",
  "/gateway/watchV2/compileReasoningTokens",
  "/gateway/watchV2/judge/dailyCap",
  "/gateway/watchV2/judge/perWatchDailyCap",
  "/gateway/watchV2/delivery/dailyCap",
  "/gateway/watchV2/delivery/perWatchDailyCap",
  "/gateway/watchV2/wake/dailyCap",
  "/gateway/watchV2/wake/perWatchDailyCap",
  // No default budget: a ceiling nobody chose would stop the operator's Brain
  // at an arbitrary number. Absent means unlimited, deliberately.
  "/brain/budget/dailyTokens",
  "/brain/budget/dailyRuns",
  "/search/diversity/topK", // unset = window falls back to search.params.candidateLimit
  "/search/diversity/maxPerSourceInTopK", // unset = no per-source cap (uses MMR instead)
  // Filters applied to every query. Unset means "no filter" — there is no
  // sensible scalar default for which sources / types / dates to always narrow to.
  "/search/defaultFilters/sourceIds",
  "/search/defaultFilters/documentTypes",
  "/search/defaultFilters/dateFrom",
  "/search/defaultFilters/dateTo",
  "/search/defaultFilters/tags",
  "/dataRetention/maxAge", // globally optional; no fallback
  "/activityRetention/maxAge", // globally optional; absent keeps activity forever
  "/brain/transcriptRetention", // legacy per-cognition override; absent inherits activity retention
  "/gateway/cpuConcurrency", // machine-dependent: max(2, floor(availableParallelism / 2) - 2)
  "/gateway/analyticsMemoryLimitMb", // machine-dependent: clamp(totalmem / 4, 512 MiB, 4 GiB)
  "/gateway/analyticsThreads", // machine-dependent: clamp(cores / 2, 2, 8)
  "/gateway/mdns/serviceName", // defaults to the OS hostname in gateway boot code
  "/agent/subagentTreeTokenBudget", // unset = unbounded tree budget (a warning is logged)
  "/gateway/publicBaseUrl", // unset = loopback-only MCP OAuth + localhost source callback fallback
  "/gateway/pairingSystemTrustOrigins", // unset = installer-proven origin plus origin-shaped publicBaseUrl
  "/gateway/mcpResourceUrls", // unset = only the canonical publicBaseUrl/mcp resource
  "/self/name", // operator identity; no sensible default — set via `omnesis self` / Config tab
  "/self/emails", // operator identity; empty when unset
  "/self/phones", // operator identity; empty when unset
];

/**
 * Human-readable meaning for an absent knob that has no single literal
 * default. The schema descriptor carries this to the portal so a blank field
 * never leaves the operator guessing whether absence means unlimited,
 * inherited, automatic, or simply not configured.
 */
const CONFIG_UNSET_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "/self/name": "No display name is configured.",
  "/self/emails": "No self email addresses are configured.",
  "/self/phones": "No self phone numbers are configured.",
  "/dataRetention/maxAge": "No age limit; ingested and indexed data is kept indefinitely.",
  "/activityRetention/maxAge": "No age limit; activity is kept indefinitely.",
  "/search/boosts/typeBoosts/*": "No boost is configured for this key.",
  "/search/defaultFilters/sourceIds": "No source filter is applied.",
  "/search/defaultFilters/documentTypes": "No document-type filter is applied.",
  "/search/defaultFilters/dateFrom": "No earliest-date filter is applied.",
  "/search/defaultFilters/dateTo": "No latest-date filter is applied.",
  "/search/defaultFilters/tags": "No tag filter is applied.",
  "/search/sourcePriors/weights/*": "No source-prior weight is configured for this key.",
  "/search/diversity/topK": "Uses search.params.candidateLimit.",
  "/search/diversity/maxPerSourceInTopK": "No per-source cap; MMR diversity still applies.",
  "/gateway/cpuConcurrency": "Chosen automatically from the machine's available CPU cores.",
  "/gateway/analyticsMemoryLimitMb": "Chosen automatically from the machine's physical memory.",
  "/gateway/analyticsThreads": "Chosen automatically from the machine's available CPU cores.",
  "/gateway/backfill/mergePass/interval": "Uses gateway.backfill.peopleCounts.interval.",
  "/gateway/watch/compileReasoningTokens": "The assigned backend chooses its reasoning budget.",
  "/gateway/publicBaseUrl":
    "MCP OAuth stays loopback-only; source callbacks use the local localhost fallback.",
  "/gateway/pairingSystemTrustOrigins":
    "Only an installer-proven origin or an origin-shaped gateway.publicBaseUrl is eligible for mobile system trust.",
  "/gateway/mcpResourceUrls":
    "Only the canonical MCP resource derived from gateway.publicBaseUrl is trusted.",
  "/gateway/mdns/serviceName": "Uses the operating system hostname.",
  "/agent/subagentTreeTokenBudget": "Unlimited; a warning is logged when sub-agents fan out.",
  "/brain/transcriptRetention": "Uses activityRetention.maxAge.",
  "/brain/bootstrap/activeHours/from": "No active-hours restriction is applied.",
  "/brain/bootstrap/activeHours/to": "No active-hours restriction is applied.",
  "/brain/budget/dailyTokens": "Unlimited daily token budget.",
  "/brain/budget/dailyRuns": "Unlimited daily run budget.",
};

const SOURCE_UNSET_DESCRIPTIONS: Readonly<Record<string, string>> = {
  syncInterval:
    "Effective precedence: account setting, source-type setting, sources.default.syncInterval, OMNESIS_SYNC_INTERVAL, then 5 minutes.",
  extractAttachments:
    "Effective precedence: account setting, source-type setting, sources.default.extractAttachments, then the source's built-in attachment behavior.",
  attachmentMaxSizeBytes:
    "Effective precedence: account setting, source-type setting, sources.default.attachmentMaxSizeBytes, then 26214400 bytes (25 MiB).",
  attachmentTypes:
    "Effective precedence: account setting, source-type setting, sources.default.attachmentTypes, then the extractor's built-in document and image types (plus audio when transcription is enabled).",
  attachmentMaxTextLength:
    "Effective precedence: account setting, source-type setting, sources.default.attachmentMaxTextLength, then 512000 characters.",
  maxAge:
    "Effective precedence: account setting, source-type setting, sources.default.maxAge, then dataRetention.maxAge; without any of them, there is no age limit.",
};

export function configUnsetDescriptionAt(path: readonly string[]): string | undefined {
  const pointer = "/" + path.join("/");
  const exact = CONFIG_UNSET_DESCRIPTIONS[pointer];
  if (exact) return exact;

  if (path[0] === "gateway" && path[1] === "watchV2" && path.length >= 3) {
    return `Uses the matching gateway.watch.${path.slice(2).join(".")} setting.`;
  }

  if (path[0] === "sources" && path[1] === "*" && path.length === 3) {
    return SOURCE_UNSET_DESCRIPTIONS[path[2]];
  }

  return undefined;
}

/** Look up the default for a config path (segments). Returns undefined if none. */
export function configDefaultAt(path: readonly string[]): unknown {
  let cur: unknown = CONFIG_DEFAULTS;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
