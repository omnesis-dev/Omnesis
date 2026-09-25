// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { IDF_EXCL_CONFIG, type NearDupeConfig } from "@omnesis/near-dupes";
import { DEFAULT_ELIGIBLE_DOC_TYPES, DEFAULT_FILE_LIKE_DOC_TYPES } from "./eligibility.js";
import type { NearDuplicatesSettings } from "@omnesis/config";

/**
 * Resolved near-duplicate configuration — the union of the runtime
 * config (from `omnesis.json -> nearDuplicates`) and the
 * code-baked defaults. Every tunable is configurable; an empty
 * config block yields all defaults.
 *
 * The algorithm-side `algorithm` config compiles down to a
 * `NearDupeConfig` from `@omnesis/near-dupes` — that is the contract
 * the pure sketcher consumes.
 */
export interface ResolvedNearDupConfig {
  enabled: boolean;
  eligibleDocTypes: ReadonlySet<string>;
  /** Types whose arrival makes the DF weighting worth rebuilding. */
  fileLikeDocTypes: ReadonlySet<string>;
  minContentLength: number;
  maxContentLength: number;
  algorithm: NearDupeConfig;
  gate: ResolvedGateConfig;
  scheduler: ResolvedSchedulerConfig;
}

export interface ResolvedGateConfig {
  /** Verified-Jaccard floor below which pairs are never recorded. */
  recordThreshold: number;
  emailJaccardMin: number;
  emailPairUniqueDf2Min: number;
  fileLikeJaccardMin: number;
  fileLikePairUniqueDf2Min: number;
  fileLikeContainmentMin: number;
  /** Sender local-part prefixes that mark an email as automated. */
  automatedSenderPrefixes: readonly string[];
}

export interface ResolvedSchedulerConfig {
  computePeriodMs: number;
  computeIdlePeriodMs: number;
  computeBatchSize: number;
  /** Hard cap on candidates verified per drained doc. */
  maxCandidatesPerDoc: number;
  /**
   * Minimum age the DF table must reach before a newly-arrived file may
   * trigger a rebuild — i.e. at most one file-triggered rebuild per period.
   */
  dfRefreshPeriodMs: number;
  /** Age at which the DF table rebuilds with no new file, in the quiet hour. */
  dfMaxAgeMs: number;
  /** Local hour (0-23) the no-new-file rebuild runs in. */
  dfQuietHourLocal: number;
  dfRefreshIdlePeriodMs: number;
  sweepPeriodMs: number;
  sweepIdlePeriodMs: number;
  sweepChunkSize: number;
  /**
   * How many chunks of a superseded DF generation one sweep tick reclaims.
   *
   * One per tick fixes the rate at chunk-size per tick interval, and a
   * rebuild hands the sweep a whole generation at once — on a large corpus
   * that arrives faster than one chunk retires it. A few clears it
   * comfortably. It stays small on purpose: every chunk is a writer op on
   * the background lane, and a tick that filled that lane would stall the
   * writer's heartbeat and starve the indexer sharing it.
   *
   * It bounds only the generation reclaim. The stale-algo pass reads the
   * table and runs once per tick regardless.
   */
  algoSweepStepsPerTick: number;
  algoSweepChunkSize: number;
}

const DEFAULT_AUTOMATED_SENDER_PREFIXES: readonly string[] = [
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
];

export const DEFAULT_NEAR_DUP_CONFIG: ResolvedNearDupConfig = Object.freeze({
  enabled: true,
  eligibleDocTypes: new Set(DEFAULT_ELIGIBLE_DOC_TYPES),
  fileLikeDocTypes: new Set(DEFAULT_FILE_LIKE_DOC_TYPES),
  minContentLength: 200,
  maxContentLength: 2_000_000,
  algorithm: IDF_EXCL_CONFIG,
  gate: {
    recordThreshold: 0.5,
    emailJaccardMin: 0.85,
    emailPairUniqueDf2Min: 5,
    fileLikeJaccardMin: 0.75,
    fileLikePairUniqueDf2Min: 1,
    fileLikeContainmentMin: 0.95,
    automatedSenderPrefixes: DEFAULT_AUTOMATED_SENDER_PREFIXES,
  },
  scheduler: {
    computePeriodMs: 2_000,
    computeIdlePeriodMs: 30_000,
    // Docs signed per compute cycle. Each cycle transfers the DF table to a
    // CPU worker once and signs the whole batch against it, so a larger batch
    // amortizes that fixed per-cycle cost over more docs (important when the
    // inbox is deep, e.g. after a large source resync). 5 was far too small
    // once the per-doc DF re-transfer was removed.
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
});

/**
 * Merge the (validated) runtime settings into the defaults. Each
 * tunable is independent — providing one knob doesn't blank out the
 * siblings. The shape is intentionally flat so future agents can
 * experiment by setting only the knob they care about.
 */
export function resolveNearDupConfig(
  settings: NearDuplicatesSettings | undefined,
): ResolvedNearDupConfig {
  if (settings === undefined) return DEFAULT_NEAR_DUP_CONFIG;

  const algoCfg = settings.algorithm ?? {};
  const algorithm: NearDupeConfig = Object.freeze({
    algoVersion: DEFAULT_NEAR_DUP_CONFIG.algorithm.algoVersion,
    shingleSize: algoCfg.shingleSize ?? DEFAULT_NEAR_DUP_CONFIG.algorithm.shingleSize,
    numHashes: algoCfg.numHashes ?? DEFAULT_NEAR_DUP_CONFIG.algorithm.numHashes,
    bands: algoCfg.bands ?? DEFAULT_NEAR_DUP_CONFIG.algorithm.bands,
    rows: algoCfg.rows ?? DEFAULT_NEAR_DUP_CONFIG.algorithm.rows,
    hashSeed: algoCfg.hashSeed ?? DEFAULT_NEAR_DUP_CONFIG.algorithm.hashSeed,
    stripQuotes: algoCfg.stripQuotes ?? DEFAULT_NEAR_DUP_CONFIG.algorithm.stripQuotes,
    weighting: DEFAULT_NEAR_DUP_CONFIG.algorithm.weighting,
    maxIdfWeight: algoCfg.maxIdfWeight ?? DEFAULT_NEAR_DUP_CONFIG.algorithm.maxIdfWeight,
  });

  const gateCfg = settings.gate ?? {};
  const gate: ResolvedGateConfig = {
    recordThreshold: algoCfg.recordThreshold ?? DEFAULT_NEAR_DUP_CONFIG.gate.recordThreshold,
    emailJaccardMin: gateCfg.emailJaccardMin ?? DEFAULT_NEAR_DUP_CONFIG.gate.emailJaccardMin,
    emailPairUniqueDf2Min:
      gateCfg.emailPairUniqueDf2Min ?? DEFAULT_NEAR_DUP_CONFIG.gate.emailPairUniqueDf2Min,
    fileLikeJaccardMin:
      gateCfg.fileLikeJaccardMin ?? DEFAULT_NEAR_DUP_CONFIG.gate.fileLikeJaccardMin,
    fileLikePairUniqueDf2Min:
      gateCfg.fileLikePairUniqueDf2Min ?? DEFAULT_NEAR_DUP_CONFIG.gate.fileLikePairUniqueDf2Min,
    fileLikeContainmentMin:
      gateCfg.fileLikeContainmentMin ?? DEFAULT_NEAR_DUP_CONFIG.gate.fileLikeContainmentMin,
    automatedSenderPrefixes:
      gateCfg.automatedSenderPrefixes ?? DEFAULT_NEAR_DUP_CONFIG.gate.automatedSenderPrefixes,
  };

  const schCfg = settings.scheduler ?? {};
  const scheduler: ResolvedSchedulerConfig = {
    computePeriodMs: schCfg.computePeriodMs ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.computePeriodMs,
    computeIdlePeriodMs:
      schCfg.computeIdlePeriodMs ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.computeIdlePeriodMs,
    computeBatchSize: schCfg.computeBatchSize ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.computeBatchSize,
    maxCandidatesPerDoc:
      schCfg.maxCandidatesPerDoc ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.maxCandidatesPerDoc,
    dfRefreshPeriodMs:
      schCfg.dfRefreshPeriodMs ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.dfRefreshPeriodMs,
    dfMaxAgeMs: schCfg.dfMaxAgeMs ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.dfMaxAgeMs,
    dfQuietHourLocal: schCfg.dfQuietHourLocal ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.dfQuietHourLocal,
    dfRefreshIdlePeriodMs:
      schCfg.dfRefreshIdlePeriodMs ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.dfRefreshIdlePeriodMs,
    sweepPeriodMs: schCfg.sweepPeriodMs ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.sweepPeriodMs,
    sweepIdlePeriodMs:
      schCfg.sweepIdlePeriodMs ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.sweepIdlePeriodMs,
    sweepChunkSize: schCfg.sweepChunkSize ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.sweepChunkSize,
    algoSweepStepsPerTick:
      schCfg.algoSweepStepsPerTick ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.algoSweepStepsPerTick,
    algoSweepChunkSize:
      schCfg.algoSweepChunkSize ?? DEFAULT_NEAR_DUP_CONFIG.scheduler.algoSweepChunkSize,
  };

  return {
    enabled: settings.enabled ?? DEFAULT_NEAR_DUP_CONFIG.enabled,
    eligibleDocTypes:
      settings.eligibleDocTypes !== undefined
        ? new Set(settings.eligibleDocTypes)
        : DEFAULT_NEAR_DUP_CONFIG.eligibleDocTypes,
    fileLikeDocTypes:
      settings.fileLikeDocTypes !== undefined
        ? new Set(settings.fileLikeDocTypes)
        : DEFAULT_NEAR_DUP_CONFIG.fileLikeDocTypes,
    minContentLength: settings.minContentLength ?? DEFAULT_NEAR_DUP_CONFIG.minContentLength,
    maxContentLength: settings.maxContentLength ?? DEFAULT_NEAR_DUP_CONFIG.maxContentLength,
    algorithm,
    gate,
    scheduler,
  };
}
