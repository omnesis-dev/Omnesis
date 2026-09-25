// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Backfill PeriodicTasks — the Scheduler-driven replacement for the
 * six hand-rolled loops in `workers/backfill-worker.ts`.
 *
 * Each task runs on the **main** runner (its body is just async
 * orchestration — it doesn't touch the DB directly). Heavy SQL work is
 * routed to:
 *   - the `compute` runner for read-heavy compute (peopleCounts,
 *     mergeCandidates, sourceStatsRow, …);
 *   - the `writer` runner for the actual mutations.
 *
 * The legacy backfill worker owned all of this in its own thread with
 * bespoke `setTimeout` / `setInterval` scaffolding. The new shape:
 *   - "drip" loops use `idlePeriodMs` to back off when there's no work;
 *   - cross-runner orchestration is just `await` chains in the run body;
 *   - backpressure (writer queue full) surfaces as a thrown
 *     `SchedulerQueueFullError` — the orchestrator catches it and lets
 *     the next periodic tick retry, same semantics as today's
 *     `isBackpressure` skip.
 *
 * Each task is `idle`-aware: returning `{ idle: true }` makes the
 * Scheduler use `idlePeriodMs` for the next tick. Returning
 * `{ idle: false }` keeps the active `periodMs`. Drip loops cycle
 * between active (work to do) and idle (caught up).
 */

import { QueueTracker, ScanTracker, StatelessTracker } from "../../background-jobs/trackers.js";
import { periodicJob } from "../../background-jobs/scheduler-job.js";
import { type IdleResult } from "./backfill-helpers.js";
import {
  linkBackfillTask,
  linkReconcileTask,
  peopleBackfillTask,
  peopleCountsRefreshTask,
  sourceStatsRefreshTask,
  linkStatsRefreshTask,
  interactionScoresRefreshTask,
  mergeRulesEvalTask,
  autoDetectTask,
  mergeCandidatesDetectTask,
  tokenIdentityClassifyTask,
  catalogRefreshTask,
  nearDupComputeTask,
  nearDupDfRefreshTask,
  nearDupAlgoSweepTask,
} from "./backfill-tasks.js";
import type { CompleteCapability, Logger } from "@omnesis/core";
import type { BackgroundJob } from "../../background-jobs/types.js";
import type { IoGate } from "../io-ops.js";
import type { CpuGate } from "../cpu-ops.js";
import type { Scheduler } from "../scheduler.js";
import type { WriteGate } from "../../write-gate.js";
import type { PeriodicTask } from "../types.js";
import type { ResolvedNearDupConfig } from "../../near-dupes/config.js";
import type Database from "better-sqlite3";

/**
 * Per-task trackers, paired 1:1 with the backfill PeriodicTasks. Each
 * task body updates its tracker as work progresses; the matching
 * BackgroundJob reads the tracker via `observe()`. Trackers are pure
 * in-memory state — never touch the DB from inside `observe()`.
 */
interface BackfillTrackers {
  /** Decrements as link-extraction batches complete. */
  linkBackfill: QueueTracker;
  /** Decrements as link-resolution passes complete. */
  linkReconcile: QueueTracker;
  /** Decrements as people-backfill batches complete. */
  peopleBackfill: QueueTracker;
  /** Periodic people-counts refresh — coverage style (sweep). */
  peopleCountsRefresh: ScanTracker;
  /** Decrements as dirty source rows refresh. */
  sourceStatsRefresh: QueueTracker;
  /** OCC-driven; modeled as a sweep that completes fast. */
  linkStatsRefresh: ScanTracker;
  /** Catalog refresh — purely periodic, no progress. */
  catalogRefresh: StatelessTracker;
  /**
   * Per-person interaction-score refresh — sweep style. Coverage =
   * 1 once the snapshot has been computed AND applied for the
   * current dirty version, 0 when a bump is pending.
   */
  interactionScoresRefresh: ScanTracker;
  /**
   * Merge-rules eval — sweep style. Coverage = 1 when active-rule
   * equivalences are fully reflected in `people.merged_into`.
   */
  mergeRulesEval: ScanTracker;
  /**
   * Fuzzy candidate detector — sweep style. Coverage = 1 once the
   * detector has run successfully against a steady-state graph.
   */
  mergeCandidatesDetect: ScanTracker;
  /** Token-identity classifier — sweep style; coverage flips to 1 once all
   *  high-spread tokens are labeled. */
  tokenIdentityClassify: ScanTracker;
  /** Near-dup compute drip — decrements as inbox rows drain. */
  nearDupCompute: QueueTracker;
  /** Periodic full DF rebuild — sweep style. */
  nearDupDfRefresh: ScanTracker;
  /** Algo-bump sweep — coverage flips to 1 when no non-active rows remain. */
  nearDupAlgoSweep: ScanTracker;
}

/** Mutable holder for the DF cache shared between nearDupCompute and nearDupDfRefresh. */
interface DfCacheRef {
  current: { algoVersion: string; data: SharedArrayBuffer } | null;
}

/** Per-task opts after trackers are attached internally. */
export interface BackfillTaskOptsInternal extends BackfillTaskOpts {
  trackers: BackfillTrackers;
  dfCacheRef: DfCacheRef;
  /**
   * Fire another periodic task's next tick now (Scheduler.kickPeriodic).
   * Lets a task chain its downstream refreshes — e.g. the merge-rules
   * eval kicks interaction scores + the counts sweep after equivalences
   * move — instead of leaving them to their idle backoff.
   */
  kickPeriodic: (taskName: string) => void;
}

export interface BackfillTaskOpts {
  writeGate: WriteGate;
  ioGate: IoGate;
  cpuGate: CpuGate;
  log: Logger;
  /** Active drip cadence (ms). */
  linkBackfillIntervalMs: number;
  /** Drip cadence when there's no work to do. */
  linkIdleDelayMs: number;
  /** Cadence for the link reconcile pass. */
  linkReconcileIntervalMs: number;
  /** URL rows scanned per link-reconcile tick. */
  linkReconcileBatchSize: number;
  /** Max docs per people-backfill tick. */
  peopleBatchSize: number;
  peopleBatchIntervalMs: number;
  peopleIdleDelayMs: number;
  /** Cadence for the people-counts refresh. */
  peopleCountsRefreshIntervalMs: number;
  /** Cadence for source-stats refresh check. */
  statsRefreshIntervalMs: number;
  /** Cadence for catalog refresh (longer; piggybacks on stats idle). */
  catalogRefreshIntervalMs: number;
  /** Cadence for link_stats refresh check (active poll). */
  linkStatsRefreshIntervalMs: number;
  /** Cadence when link_stats is up to date (no work). */
  linkStatsIdleDelayMs: number;
  /**
   * Cadence for the interaction-score refresh task when the meta row
   * shows a pending dirty bump. Should be a few minutes — this work
   * is not user-facing latency-critical, but slow enough that a
   * tighter loop would waste compute.
   */
  interactionScoresRefreshIntervalMs: number;
  /**
   * Cadence when interaction scores are up to date (no dirty bump
   * pending). The poll is cheap (one PK lookup on a singleton row)
   * so we can afford to check every minute or so.
   */
  interactionScoresIdleDelayMs: number;
  /**
   * Cadence for the merge-rules eval task. Active when rules / aliases
   * have moved since the last evaluation; idle when caught up. The
   * eval pass is the source-of-truth for `people.merged_into` —
   * lower active cadence = faster reflection of user-issued merges
   * in the portal.
   */
  mergeRulesEvalIntervalMs: number;
  /**
   * Cadence when merge-rule eval is caught up. Cheap poll on a
   * singleton meta row; 5 min is comfortable.
   */
  mergeRulesEvalIdleDelayMs: number;
  /**
   * Cadence for the auto-detect pass. Less frequent than the eval
   * (the alias graph changes less often than rules + the eval will
   * pick up any new system rules immediately).
   */
  autoDetectIntervalMs: number;
  /**
   * Cadence for the fuzzy merge-candidate detection pass. The
   * detector is gated on (a) merge-rules eval being current, (b)
   * interaction-scores being current — so it only runs against a
   * steady-state graph. Active cadence is the upper bound of how
   * often we attempt; gating typically pushes us into the idle
   * cadence.
   */
  mergeCandidatesDetectIntervalMs: number;
  mergeCandidatesDetectIdleDelayMs: number;
  /**
   * Near-dup configuration — drives the four periodic tasks plus the
   * inbox/sweep/algo-bump glue. Per-tunable defaults live in
   * `near-dupes/config.ts`; the runtime config block in
   * `omnesis.json -> nearDuplicates` overrides individual knobs.
   *
   * Held as a getter so a config-change reload picks up new tunables
   * without re-spawning the task graph.
   */
  getNearDupConfig: () => ResolvedNearDupConfig;
  /**
   * Build a single-shot completion provider for the token-identity
   * classifier from the current `agent` assignment. Called per sweep so a
   * reassignment is picked up without re-spawning the task graph; the caller
   * disposes what it returns. Null when no generative model is configured or
   * available — the classifier then no-ops and role-mailbox suppression
   * degrades safely.
   */
  getCompletionProvider: () => CompleteCapability | null;
  /**
   * Read-only `omnesis.db` handle for the cheap inbox-count poll that
   * drives the `nearDupCompute` BackgroundJob tracker. The compute
   * pass runs on the compute worker; this poll is for the UI surface.
   */
  readDb: Database.Database;
  /**
   * Key for stores this gateway derives from the corpus, when the install
   * encrypts them. The near-duplicate DF build stages document text on
   * disk; absent on an install that keeps its stores in the clear.
   */
  derivedStoreKey?: Buffer;
  /** OS nice applied to the short-lived DF staging worker. */
  backgroundWorkerNice?: number;
}

/** Result of `createBackfillTasks`: tasks to schedule + jobs to register. */
export interface BackfillBundle {
  tasks: PeriodicTask<unknown, IdleResult>[];
  jobs: BackgroundJob[];
  /**
   * A subset of the internal trackers that boot code may want to
   * prime before the first periodic tick fires. Today: the near-dup
   * compute tracker, which the post-boot algo-bump can prime with
   * the actual inbox depth so the BackgroundJob UI doesn't briefly
   * show "0 remaining" while 13k+ docs are queued waiting for DF.
   */
  primeTrackers: {
    nearDupCompute: QueueTracker;
  };
}

/**
 * Build the seven backfill PeriodicTasks plus their matching
 * BackgroundJob observations. Caller schedules tasks via
 * `scheduler.schedule(t)` and registers jobs via
 * `registry.registerAll(jobs)`. Trackers are created internally and
 * captured by both task closures (for updates) and BackgroundJobs
 * (for reads).
 */
export function createBackfillTasks(opts: BackfillTaskOpts, scheduler: Scheduler): BackfillBundle {
  const trackers: BackfillTrackers = {
    linkBackfill: new QueueTracker({ initialRemaining: 0 }),
    linkReconcile: new QueueTracker({ initialRemaining: 0 }),
    peopleBackfill: new QueueTracker({ initialRemaining: 0 }),
    peopleCountsRefresh: new ScanTracker(),
    sourceStatsRefresh: new QueueTracker({ initialRemaining: 0 }),
    linkStatsRefresh: new ScanTracker(),
    catalogRefresh: new StatelessTracker(),
    interactionScoresRefresh: new ScanTracker(),
    mergeRulesEval: new ScanTracker(),
    mergeCandidatesDetect: new ScanTracker(),
    tokenIdentityClassify: new ScanTracker(),
    nearDupCompute: new QueueTracker({ initialRemaining: 0 }),
    nearDupDfRefresh: new ScanTracker(),
    nearDupAlgoSweep: new ScanTracker(),
  };
  const dfCacheRef: DfCacheRef = { current: null };
  const internal: BackfillTaskOptsInternal = {
    ...opts,
    trackers,
    dfCacheRef,
    kickPeriodic: (taskName) => scheduler.kickPeriodic(taskName),
  };
  const linkBackfill = linkBackfillTask(internal);
  const linkReconcile = linkReconcileTask(internal);
  const peopleBackfill = peopleBackfillTask(internal);
  const peopleCountsRefresh = peopleCountsRefreshTask(internal);
  const sourceStats = sourceStatsRefreshTask(internal);
  const catalog = catalogRefreshTask(internal);
  const linkStats = linkStatsRefreshTask(internal);
  const interactionScores = interactionScoresRefreshTask(internal);
  const mergeRulesEval = mergeRulesEvalTask(internal);
  const autoDetect = autoDetectTask(internal);
  const mergeCandidatesDetect = mergeCandidatesDetectTask(internal);
  const tokenIdentityClassify = tokenIdentityClassifyTask(internal);
  const nearDupCompute = nearDupComputeTask(internal);
  const nearDupDfRefresh = nearDupDfRefreshTask(internal);
  const nearDupAlgoSweep = nearDupAlgoSweepTask(internal);

  const tasks = [
    linkBackfill,
    linkReconcile,
    peopleBackfill,
    peopleCountsRefresh,
    sourceStats,
    catalog,
    linkStats,
    interactionScores,
    mergeRulesEval,
    autoDetect,
    mergeCandidatesDetect,
    tokenIdentityClassify,
    nearDupCompute,
    nearDupDfRefresh,
    nearDupAlgoSweep,
  ];

  const jobs: BackgroundJob[] = [
    periodicJob(linkBackfill, {
      scheduler,
      displayName: "Link extraction",
      description: "Extracts URLs and document links from new documents into document_links.",
      category: "graph",
      tracker: trackers.linkBackfill,
    }),
    periodicJob(linkReconcile, {
      scheduler,
      displayName: "Link reconciliation",
      description: "Resolves outbound document_links to target document IDs in periodic batches.",
      category: "graph",
      tracker: trackers.linkReconcile,
    }),
    periodicJob(peopleBackfill, {
      scheduler,
      displayName: "People backfill",
      description:
        "Resolves person mentions into the people graph for documents that haven't been processed yet.",
      category: "people",
      tracker: trackers.peopleBackfill,
    }),
    periodicJob(peopleCountsRefresh, {
      scheduler,
      displayName: "People counts refresh",
      description:
        "Collapses redirect chains, then refreshes each person's document and alias counts and primary name.",
      category: "people",
      tracker: trackers.peopleCountsRefresh,
    }),
    periodicJob(sourceStats, {
      scheduler,
      displayName: "Source stats refresh",
      description:
        "Drips through dirty source_stats rows (one per tick) recomputing per-source aggregates.",
      category: "stats",
      tracker: trackers.sourceStatsRefresh,
    }),
    periodicJob(catalog, {
      scheduler,
      displayName: "SQLite catalog refresh",
      description:
        "Rebuilds sqlite_table_stats so the query planner has fresh row-count estimates.",
      category: "infra",
      tracker: trackers.catalogRefresh,
    }),
    periodicJob(linkStats, {
      scheduler,
      displayName: "Link stats refresh",
      description:
        "Maintains the materialized link_stats row (total/resolved/broken counts) when its OCC dirty version moves.",
      category: "stats",
      tracker: trackers.linkStatsRefresh,
    }),
    periodicJob(interactionScores, {
      scheduler,
      displayName: "Interaction scores refresh",
      description:
        "Recomputes per-person inbound / outbound / interaction scores (lifetime + 1y-decayed) when document_people / people / merges move.",
      category: "people",
      tracker: trackers.interactionScoresRefresh,
    }),
    periodicJob(mergeRulesEval, {
      scheduler,
      displayName: "Merge rules eval",
      description:
        "Re-derives people.merged_into from active merge_rules. Picks up user-issued merges + system auto-detect rules, applies them via person_equivalences. Idempotent + reversible.",
      category: "people",
      tracker: trackers.mergeRulesEval,
    }),
    periodicJob(autoDetect, {
      scheduler,
      displayName: "Merge auto-detect",
      description:
        "Scans for shared-identifier and contact-name merge candidates, inserts kind='system' rules. Skips pairs that already carry a rule.",
      category: "people",
      tracker: trackers.mergeRulesEval,
    }),
    periodicJob(mergeCandidatesDetect, {
      scheduler,
      displayName: "Merge candidates detect",
      description:
        "Fuzzy detection of probable identity matches via name-token IDF scoring. Surfaces candidates to the operator portal; runs only when merge_rules + interaction_scores are caught up so it sees a steady-state graph.",
      category: "people",
      tracker: trackers.mergeCandidatesDetect,
    }),
    periodicJob(tokenIdentityClassify, {
      scheduler,
      displayName: "Token identity classify",
      description:
        "Labels high-spread email-local tokens (personal_name / role_generic / ambiguous) via the configured model, feeding merge-candidate role-mailbox suppression. No-ops when no model is available.",
      category: "people",
      tracker: trackers.tokenIdentityClassify,
    }),
    periodicJob(nearDupCompute, {
      scheduler,
      displayName: "Near-duplicate compute",
      description:
        "Drains documents from near_dup_inbox, signs each doc (weighted MinHash + LSH), runs candidate verify + source-family gate, and writes near_dup_edges. Surfaces the 'Similar' section in the document inspector.",
      category: "graph",
      tracker: trackers.nearDupCompute,
    }),
    periodicJob(nearDupDfRefresh, {
      scheduler,
      displayName: "Near-duplicate DF refresh",
      description:
        "Rebuilds the per-shingle document-frequency snapshot near_dup_df that drives IDF-weighted MinHash. Runs every few hours; small drift between rebuilds is tolerated.",
      category: "graph",
      tracker: trackers.nearDupDfRefresh,
    }),
    periodicJob(nearDupAlgoSweep, {
      scheduler,
      displayName: "Near-duplicate algo sweep",
      description:
        "Deletes near-dup rows (signatures, LSH buckets, edges, DF) tagged with non-active algorithm versions. Idle once no stale rows remain.",
      category: "graph",
      tracker: trackers.nearDupAlgoSweep,
    }),
  ];

  return {
    tasks,
    jobs,
    primeTrackers: { nearDupCompute: trackers.nearDupCompute },
  };
}
