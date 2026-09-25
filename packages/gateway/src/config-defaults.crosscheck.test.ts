// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Cross-check: the display defaults in `@omnesis/config` (CONFIG_DEFAULTS,
// shown on the portal /config form) must match what the live gateway resolvers
// actually apply for an empty config. CONFIG_DEFAULTS is a display mirror, not
// the runtime authority — this test is what keeps the mirror honest. If a
// runtime default changes here without CONFIG_DEFAULTS being updated (or vice
// versa), this fails and names the offending knob.
//
// Resolver outputs use their own (often flat, ms-based) field names; the maps
// below translate config-path → resolved value. Duration knobs are compared in
// milliseconds via parseDuration.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAX_SIZE_BYTES,
  DEFAULT_MAX_TEXT_LENGTH,
  DEFAULT_SYNC_INTERVAL_MS,
  parseDuration,
} from "@omnesis/core";
import { CONFIG_DEFAULTS, configDefaultAt, configUnsetDescriptionAt } from "@omnesis/config";
import { DEFAULT_MAX_TOOL_ITERATIONS } from "@omnesis/agent";
import { resolveRuntimeSettings } from "./runtime-settings.js";
import { resolveNearDupConfig } from "./near-dupes/config.js";
import { DATE_ENRICHMENT_DEFAULTS } from "./enrichment/dates/config.js";
import {
  DEFAULT_VECTOR_CONFIG,
  DEFAULT_DIVERSITY_BUCKET_BY,
  DEFAULT_SEARCH_BOOSTS,
  DEFAULT_SEARCH_PARAMS,
  DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
  DEFAULT_SEARCH_READ_MMAP_BYTES,
  DEFAULT_SEARCH_READ_CACHE_BYTES,
  resolveDiversityConfig,
  resolveSearchSettings,
  resolveVectorConfig,
} from "./search/search-config.js";
import {
  DEFAULT_SHARED_ADDRESS_NAME_THRESHOLD,
  DEFAULT_SHARED_ADDRESS_MAX_EMAILS,
} from "./domain/SharedAddressDemotion.js";
import {
  DEFAULT_REAUTH_REMINDER_INITIAL_DELAY,
  DEFAULT_REAUTH_REMINDER_MULTIPLIER,
  DEFAULT_REAUTH_REMINDER_MAX_DELAY,
} from "./push/reauth-reminder-policy.js";
import {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_ALLOW_CREDENTIALS,
  DEFAULT_ALLOWED_HEADERS,
  DEFAULT_ALLOWED_METHODS,
  DEFAULT_MAX_AGE_SECONDS,
} from "./http/middleware/cors.js";
import {
  DEFAULT_AUDIT_ENABLED,
  DEFAULT_AUDIT_INCLUDE_UNAUTHENTICATED,
} from "./http/middleware/audit.js";
import { DEFAULT_MDNS_ENABLED, DEFAULT_MDNS_HOSTNAME } from "./mdns-advertiser.js";
import { DEFAULT_AUTO_ISF_STRENGTH } from "./search/source-isf-prior.js";
import { DEFAULT_PRE_UPDATE_BACKUP_COUNT } from "./http/services/BackupService.js";
import { DEFAULT_RELEASE_CHECK_ENABLED } from "./release-check/service.js";

function defAt(path: string): unknown {
  return configDefaultAt(path.split("/").filter(Boolean));
}
function defMs(path: string): number {
  return parseDuration(defAt(path) as string);
}

describe("CONFIG_DEFAULTS cross-check against live resolvers", () => {
  it("matches the passive release-check default", () => {
    expect(defAt("/releaseCheck")).toBe(DEFAULT_RELEASE_CHECK_ENABLED);
  });

  it("matches the automatic pre-update backup retention default", () => {
    expect(defAt("/backupRetention/preUpdateCount")).toBe(DEFAULT_PRE_UPDATE_BACKUP_COUNT);
  });

  it("matches resolveRuntimeSettings(undefined) — indexer, gateway, backfill", () => {
    const rt = resolveRuntimeSettings(undefined);

    // journal + concurrency
    expect(defAt("/gateway/journalMode")).toBe(rt.journalMode);
    expect(defAt("/gateway/ioConcurrency")).toBe(rt.ioConcurrency);
    // ioReservedUserSlots is hand-copied between CONFIG_DEFAULTS and the runtime
    // DEFAULTS (config can't import from gateway); pin the two together.
    expect(defAt("/gateway/ioReservedUserSlots")).toBe(rt.ioReservedUserSlots);
    // Guards the "keep the two in sync" invariant between CONFIG_DEFAULTS's
    // backgroundWorkerNice and the gateway's DEFAULT_BACKGROUND_WORKER_NICE
    // (config can't import gateway, so only this cross-check enforces it), and
    // in doing so also pins the resolveRuntimeSettings → backgroundWorkerNice wiring.
    expect(defAt("/gateway/backgroundWorkerNice")).toBe(rt.backgroundWorkerNice);
    expect(defAt("/gateway/ingestYieldBatch")).toBe(rt.ingestYieldBatch);
    expect(defAt("/gateway/analyticsStreamRekeyMaxRows")).toBe(rt.analyticsStreamRekeyMaxRows);
    expect(defAt("/gateway/minFreeDiskMb")).toBe(rt.minFreeDiskMb);
    // The snapshot-absence thresholds are hand-copied between CONFIG_DEFAULTS
    // and the runtime DEFAULTS (config can't import from gateway); pin the
    // four together so a floor under an irreversible delete can't drift.
    expect(defAt("/gateway/snapshotAbsence/minObservations")).toBe(
      rt.snapshotAbsenceMinObservations,
    );
    expect(defMs("/gateway/snapshotAbsence/minAge")).toBe(rt.snapshotAbsenceMinAgeMs);
    expect(defAt("/gateway/snapshotAbsence/maxMarksPerSnapshot")).toBe(
      rt.snapshotAbsenceMaxMarksPerSnapshot,
    );
    expect(defMs("/gateway/snapshotAbsence/deletionGrace")).toBe(rt.snapshotAbsenceDeletionGraceMs);
    // readHandle caches are hand-copied between CONFIG_DEFAULTS and the runtime
    // DEFAULTS (config can't import from gateway); pin the two together.
    expect(defAt("/gateway/readHandle/cacheSizeBytes")).toBe(rt.readCacheSizeBytes);
    expect(defAt("/gateway/readHandle/ioCacheSizeBytes")).toBe(rt.ioReadCacheSizeBytes);
    // searchWorker knobs are hand-copied between CONFIG_DEFAULTS and the runtime
    // DEFAULTS (config can't import from gateway); pin the two together.
    expect(defAt("/gateway/searchWorker/concurrency")).toBe(rt.searchWorkerConcurrency);
    expect(defAt("/gateway/searchWorker/maxInflightBeforeFallback")).toBe(
      rt.searchWorkerMaxInflight,
    );
    expect(defAt("/gateway/searchWorker/cacheSizeBytes")).toBe(rt.searchWorkerCacheSizeBytes);

    // indexer scalars
    expect(defAt("/indexer/dbWriteBatchSize")).toBe(rt.dbWriteBatchSize);
    expect(defAt("/indexer/reindexMissingAtBoot")).toBe(rt.reindexMissingAtBoot);
    expect(defAt("/indexer/embedConcurrency")).toBe(rt.embedConcurrency);
    expect(defAt("/indexer/pageSize")).toBe(rt.indexerPageSize);
    expect(defAt("/indexer/chunker/chunkSize")).toBe(rt.chunkerChunkSize);
    expect(defAt("/indexer/chunker/overlap")).toBe(rt.chunkerOverlap);
    expect(defAt("/indexer/embedder/contextSize")).toBe(rt.embedderContextSize);
    expect(defAt("/indexer/embedder/timeoutMs")).toBe(rt.embedderTimeoutMs);
    expect(defAt("/indexer/embedder/maxInputChars")).toBe(rt.embedderMaxInputChars);

    // indexer durations (CONFIG_DEFAULTS holds strings; resolver holds ms)
    expect(defMs("/indexer/cycleInterval")).toBe(rt.indexCycleIntervalMs);
    expect(defMs("/indexer/cycleBacklogInterval")).toBe(rt.indexCycleBacklogIntervalMs);
    expect(defMs("/indexer/reconcileInterval")).toBe(rt.reconcileIntervalMs);
    expect(defMs("/indexer/reindexMissingInterval")).toBe(rt.reindexMissingIntervalMs);
    expect(defMs("/indexer/betweenPageSleep")).toBe(rt.indexerBetweenPageSleepMs);

    // gateway timings
    expect(defMs("/gateway/timings/slowRequest")).toBe(rt.slowRequestMs);
    expect(defMs("/gateway/timings/wsHeartbeatInterval")).toBe(rt.wsHeartbeatIntervalMs);
    expect(defMs("/gateway/timings/wsAuthTimeout")).toBe(rt.wsAuthTimeoutMs);
    expect(defMs("/gateway/timings/wsCommandTimeout")).toBe(rt.wsCommandTimeoutMs);
    expect(defMs("/gateway/timings/authFlowTtl")).toBe(rt.authFlowTtlMs);
    expect(defMs("/gateway/timings/pairingTtl")).toBe(rt.pairingTtlMs);
    expect(defMs("/gateway/timings/sessionTtl")).toBe(rt.sessionTtlMs);
    expect(defMs("/gateway/timings/sessionRefreshThrottle")).toBe(rt.sessionRefreshThrottleMs);

    // backfill cadences + batch sizes
    expect(defMs("/gateway/backfill/links/interval")).toBe(rt.linkBackfillIntervalMs);
    expect(defMs("/gateway/backfill/links/idleDelay")).toBe(rt.linkIdleDelayMs);
    expect(defMs("/gateway/backfill/linkReconcile/interval")).toBe(rt.linkReconcileIntervalMs);
    expect(defAt("/gateway/backfill/linkReconcile/batchSize")).toBe(rt.linkReconcileBatchSize);
    expect(defMs("/gateway/backfill/people/interval")).toBe(rt.peopleBatchIntervalMs);
    expect(defMs("/gateway/backfill/people/idleDelay")).toBe(rt.peopleIdleDelayMs);
    expect(defAt("/gateway/backfill/people/batchSize")).toBe(rt.peopleBatchSize);
    expect(defMs("/gateway/backfill/peopleCounts/interval")).toBe(rt.peopleCountsRefreshIntervalMs);
    expect(defMs("/gateway/backfill/sourceStats/interval")).toBe(rt.statsRefreshIntervalMs);
    expect(defMs("/gateway/backfill/catalog/interval")).toBe(rt.catalogRefreshIntervalMs);
    expect(defMs("/gateway/backfill/linkStats/interval")).toBe(rt.linkStatsRefreshIntervalMs);
    expect(defMs("/gateway/backfill/linkStats/idleDelay")).toBe(rt.linkStatsIdleDelayMs);
    expect(defMs("/gateway/backfill/interactionScores/interval")).toBe(
      rt.interactionScoresRefreshIntervalMs,
    );
    expect(defMs("/gateway/backfill/interactionScores/idleDelay")).toBe(
      rt.interactionScoresIdleDelayMs,
    );
    expect(defMs("/gateway/backfill/mergeRulesEval/interval")).toBe(rt.mergeRulesEvalIntervalMs);
    expect(defMs("/gateway/backfill/mergeRulesEval/idleDelay")).toBe(rt.mergeRulesEvalIdleDelayMs);
    expect(defMs("/gateway/backfill/autoDetect/interval")).toBe(rt.autoDetectIntervalMs);
    expect(defMs("/gateway/backfill/mergeCandidates/interval")).toBe(
      rt.mergeCandidatesDetectIntervalMs,
    );
    expect(defMs("/gateway/backfill/mergeCandidates/idleDelay")).toBe(
      rt.mergeCandidatesDetectIdleDelayMs,
    );
  });

  it("matches resolveNearDupConfig(undefined) — enabled, content bounds, algorithm, gate, scheduler", () => {
    const nd = resolveNearDupConfig(undefined);

    expect(defAt("/nearDuplicates/enabled")).toBe(nd.enabled);
    expect(defAt("/nearDuplicates/minContentLength")).toBe(nd.minContentLength);
    expect(defAt("/nearDuplicates/maxContentLength")).toBe(nd.maxContentLength);
    expect(defAt("/nearDuplicates/eligibleDocTypes")).toEqual([...nd.eligibleDocTypes]);
    expect(defAt("/nearDuplicates/fileLikeDocTypes")).toEqual([...nd.fileLikeDocTypes]);

    // algorithm
    expect(defAt("/nearDuplicates/algorithm/shingleSize")).toBe(nd.algorithm.shingleSize);
    expect(defAt("/nearDuplicates/algorithm/numHashes")).toBe(nd.algorithm.numHashes);
    expect(defAt("/nearDuplicates/algorithm/bands")).toBe(nd.algorithm.bands);
    expect(defAt("/nearDuplicates/algorithm/rows")).toBe(nd.algorithm.rows);
    expect(defAt("/nearDuplicates/algorithm/hashSeed")).toBe(nd.algorithm.hashSeed);
    expect(defAt("/nearDuplicates/algorithm/stripQuotes")).toBe(nd.algorithm.stripQuotes);
    expect(defAt("/nearDuplicates/algorithm/maxIdfWeight")).toBe(nd.algorithm.maxIdfWeight);
    // recordThreshold lives under `algorithm` in the schema but resolves into `gate`.
    expect(defAt("/nearDuplicates/algorithm/recordThreshold")).toBe(nd.gate.recordThreshold);

    // gate
    expect(defAt("/nearDuplicates/gate/emailJaccardMin")).toBe(nd.gate.emailJaccardMin);
    expect(defAt("/nearDuplicates/gate/emailPairUniqueDf2Min")).toBe(nd.gate.emailPairUniqueDf2Min);
    expect(defAt("/nearDuplicates/gate/fileLikeJaccardMin")).toBe(nd.gate.fileLikeJaccardMin);
    expect(defAt("/nearDuplicates/gate/fileLikePairUniqueDf2Min")).toBe(
      nd.gate.fileLikePairUniqueDf2Min,
    );
    expect(defAt("/nearDuplicates/gate/fileLikeContainmentMin")).toBe(
      nd.gate.fileLikeContainmentMin,
    );
    expect(defAt("/nearDuplicates/gate/automatedSenderPrefixes")).toEqual(
      nd.gate.automatedSenderPrefixes,
    );

    // scheduler
    expect(defAt("/nearDuplicates/scheduler/computePeriodMs")).toBe(nd.scheduler.computePeriodMs);
    expect(defAt("/nearDuplicates/scheduler/computeIdlePeriodMs")).toBe(
      nd.scheduler.computeIdlePeriodMs,
    );
    expect(defAt("/nearDuplicates/scheduler/computeBatchSize")).toBe(nd.scheduler.computeBatchSize);
    expect(defAt("/nearDuplicates/scheduler/maxCandidatesPerDoc")).toBe(
      nd.scheduler.maxCandidatesPerDoc,
    );
    expect(defAt("/nearDuplicates/scheduler/dfRefreshPeriodMs")).toBe(
      nd.scheduler.dfRefreshPeriodMs,
    );
    expect(defAt("/nearDuplicates/scheduler/dfMaxAgeMs")).toBe(nd.scheduler.dfMaxAgeMs);
    expect(defAt("/nearDuplicates/scheduler/dfQuietHourLocal")).toBe(nd.scheduler.dfQuietHourLocal);
    expect(defAt("/nearDuplicates/scheduler/dfRefreshIdlePeriodMs")).toBe(
      nd.scheduler.dfRefreshIdlePeriodMs,
    );
    expect(defAt("/nearDuplicates/scheduler/sweepPeriodMs")).toBe(nd.scheduler.sweepPeriodMs);
    expect(defAt("/nearDuplicates/scheduler/sweepIdlePeriodMs")).toBe(
      nd.scheduler.sweepIdlePeriodMs,
    );
    expect(defAt("/nearDuplicates/scheduler/sweepChunkSize")).toBe(nd.scheduler.sweepChunkSize);
    expect(defAt("/nearDuplicates/scheduler/algoSweepStepsPerTick")).toBe(
      nd.scheduler.algoSweepStepsPerTick,
    );
    expect(defAt("/nearDuplicates/scheduler/algoSweepChunkSize")).toBe(
      nd.scheduler.algoSweepChunkSize,
    );
  });

  it("matches the date-enrichment runtime defaults", () => {
    expect(defAt("/enrichment/dates/enabled")).toBe(DATE_ENRICHMENT_DEFAULTS.enabled);
    expect(defAt("/enrichment/dates/batchSize")).toBe(DATE_ENRICHMENT_DEFAULTS.batchSize);
    expect(defAt("/enrichment/dates/maxCharsPerDoc")).toBe(DATE_ENRICHMENT_DEFAULTS.maxCharsPerDoc);
    expect(defAt("/enrichment/dates/scanBudgetMs")).toBe(DATE_ENRICHMENT_DEFAULTS.scanBudgetMs);
    expect(defAt("/enrichment/dates/periodMs")).toBe(DATE_ENRICHMENT_DEFAULTS.periodMs);
    expect(defAt("/enrichment/dates/idlePeriodMs")).toBe(DATE_ENRICHMENT_DEFAULTS.idlePeriodMs);
  });

  it("matches the exported search default constants", () => {
    expect(defAt("/search/vector/hnswOverFetch")).toBe(DEFAULT_VECTOR_CONFIG.hnswOverFetch);
    expect(defAt("/search/sourcePriors/bm25BypassRank")).toBe(
      DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
    );
    expect(defAt("/search/readHandle/mmapBytes")).toBe(DEFAULT_SEARCH_READ_MMAP_BYTES);
    expect(defAt("/search/readHandle/cacheSizeBytes")).toBe(DEFAULT_SEARCH_READ_CACHE_BYTES);
    expect(defAt("/search/sourcePriors/autoInverseFrequency/strength")).toBe(
      DEFAULT_AUTO_ISF_STRENGTH,
    );
  });

  it("matches the resolved search defaults for an empty config (vector over-fetch + diversity)", () => {
    // The display defaults must equal what the resolvers produce for an empty
    // config. These ship ON by default (the measured recall@10 wins): vector
    // over-fetch on every query, and diversity via MMR (lambda 0.7).
    const vector = resolveVectorConfig(undefined);
    expect(defAt("/search/vector/alwaysOverFetch")).toBe(vector.alwaysOverFetch);
    expect(vector.alwaysOverFetch).toBe(true);

    const diversity = resolveDiversityConfig(undefined);
    expect(defAt("/search/diversity/enabled")).toBe(diversity.enabled);
    expect(defAt("/search/diversity/bucketBy")).toBe(diversity.bucketBy);
    expect(defAt("/search/diversity/lambda")).toBe(diversity.lambda);
    expect(diversity).toEqual({
      enabled: true,
      bucketBy: DEFAULT_DIVERSITY_BUCKET_BY,
      topK: undefined,
      maxPerSourceInTopK: undefined,
      lambda: 0.7,
    });
  });

  it("matches the inline search defaults applied at their call sites", () => {
    // These defaults are applied inline (no exported const). Kept in sync by
    // assertion — update both sides together if a call site changes.
    //   pipeline.ts: `bm25?.commonTokenThreshold ?? 0.1`
    //   index.ts:    `snapshot?.enabled ?? true`, `refreshIntervalMs ?? 600_000`,
    //                `readHandle?.prewarm ?? true`
    expect(defAt("/search/bm25/commonTokenThreshold")).toBe(0.1);
    expect(defAt("/search/snapshot/enabled")).toBe(true);
    expect(defAt("/search/snapshot/refreshIntervalMs")).toBe(600_000);
    expect(defAt("/search/readHandle/prewarm")).toBe(true);
  });

  it("matches CORS, audit, mDNS, and agent runtime defaults", () => {
    expect(defAt("/gateway/cors/allowedOrigins")).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(defAt("/gateway/cors/allowCredentials")).toBe(DEFAULT_ALLOW_CREDENTIALS);
    expect(defAt("/gateway/cors/allowedHeaders")).toEqual(DEFAULT_ALLOWED_HEADERS);
    expect(defAt("/gateway/cors/allowedMethods")).toEqual(DEFAULT_ALLOWED_METHODS);
    expect(defAt("/gateway/cors/maxAgeSeconds")).toBe(DEFAULT_MAX_AGE_SECONDS);
    expect(defAt("/gateway/audit/enabled")).toBe(DEFAULT_AUDIT_ENABLED);
    expect(defAt("/gateway/audit/includeUnauthenticated")).toBe(
      DEFAULT_AUDIT_INCLUDE_UNAUTHENTICATED,
    );
    expect(defAt("/gateway/mdns/enabled")).toBe(DEFAULT_MDNS_ENABLED);
    expect(defAt("/gateway/mdns/hostname")).toBe(DEFAULT_MDNS_HOSTNAME);
    expect(defAt("/agent/maxToolIterations")).toBe(DEFAULT_MAX_TOOL_ITERATIONS);
  });

  it("keeps contextual source fallback copy aligned with runtime constants", () => {
    const sync = configUnsetDescriptionAt(["sources", "*", "syncInterval"]);
    const maxSize = configUnsetDescriptionAt(["sources", "*", "attachmentMaxSizeBytes"]);
    const maxText = configUnsetDescriptionAt(["sources", "*", "attachmentMaxTextLength"]);
    expect(sync).toContain(`${DEFAULT_SYNC_INTERVAL_MS / 60_000} minutes`);
    expect(maxSize).toContain(String(DEFAULT_MAX_SIZE_BYTES));
    expect(maxText).toContain(String(DEFAULT_MAX_TEXT_LENGTH));
  });

  it("matches resolveSearchSettings(undefined) — the fusion + limit params", () => {
    // `search.params` / `search.boosts` are the operator's handle on the one
    // search configuration; CONFIG_DEFAULTS mirrors DEFAULT_SEARCH_PARAMS and
    // DEFAULT_SEARCH_BOOSTS for the portal form.
    const settings = resolveSearchSettings(undefined);
    const params = settings.params;
    expect(params).toEqual(DEFAULT_SEARCH_PARAMS);
    expect(defAt("/search/params/candidateLimit")).toBe(params.candidateLimit);
    expect(defAt("/search/params/resultLimit")).toBe(params.resultLimit);
    expect(defAt("/search/params/rrfK")).toBe(params.rrfK);
    expect(defAt("/search/params/bm25Weight")).toBe(params.bm25Weight);
    expect(defAt("/search/params/vectorWeight")).toBe(params.vectorWeight);
    expect(defAt("/search/params/topRankBonus")).toBe(params.topRankBonus);
    expect(defAt("/search/params/nearTopRankBonus")).toBe(params.nearTopRankBonus);

    const boosts = settings.boosts;
    expect(boosts).toEqual(DEFAULT_SEARCH_BOOSTS);
    expect(defAt("/search/boosts/relevanceBoostWeight")).toBe(boosts.relevanceBoostWeight);
  });

  it("shared-address demotion display defaults match the domain constants", () => {
    // Applied at the boot call site (index.ts → runBootDataMigrations →
    // writeGate.demoteSharedAddresses), which falls back to these constants
    // when the config knobs are unset.
    expect(defAt("/gateway/sharedAddressDemotion/nameThreshold")).toBe(
      DEFAULT_SHARED_ADDRESS_NAME_THRESHOLD,
    );
    expect(defAt("/gateway/sharedAddressDemotion/maxEmails")).toBe(
      DEFAULT_SHARED_ADDRESS_MAX_EMAILS,
    );
  });

  it("re-auth reminder display defaults match the policy constants", () => {
    // Applied at the index.ts wiring (resolveReauthBackoffConfig), which
    // falls back to these policy constants when the config knobs are unset.
    expect(defAt("/gateway/reauthReminders/initialDelay")).toBe(
      DEFAULT_REAUTH_REMINDER_INITIAL_DELAY,
    );
    expect(defAt("/gateway/reauthReminders/multiplier")).toBe(DEFAULT_REAUTH_REMINDER_MULTIPLIER);
    expect(defAt("/gateway/reauthReminders/maxDelay")).toBe(DEFAULT_REAUTH_REMINDER_MAX_DELAY);
    expect(defAt("/gateway/reauthReminders/reservationTtl")).toBe("5m");
  });

  it("mobile permission reminder defaults are fully described", () => {
    expect(defAt("/gateway/mobilePermissionReminders/initialDelay")).toBe("1d");
    expect(defAt("/gateway/mobilePermissionReminders/multiplier")).toBe(2);
    expect(defAt("/gateway/mobilePermissionReminders/maxDelay")).toBe("7d");
    expect(defAt("/gateway/mobilePermissionReminders/maxStaleNotifications")).toBe(4);
    expect(defAt("/gateway/mobilePermissionReminders/reservationTtl")).toBe("5m");
    expect(defAt("/gateway/mobilePermissionReminders/scanInterval")).toBe("15m");
  });

  it("CONFIG_DEFAULTS is reachable (guards against an empty/broken import)", () => {
    expect(Object.keys(CONFIG_DEFAULTS).length).toBeGreaterThan(0);
  });
});
