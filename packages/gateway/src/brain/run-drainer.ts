// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Agent Run Queue drainer — the worker half of the Cognition Steward's
 * outbox: a periodic drain task
 * claims due runs (atomic `UPDATE … RETURNING`, attempts bumped — a
 * crash mid-run leaves the row `pending` and naturally re-claimable)
 * and executes each through the headless run driver. Operational-history
 * pruning is owned by the gateway-wide activity-retention task so it remains
 * active even when this experimental feature is disabled.
 *
 * Concurrency contract: the per-tick claim size is the configured
 * worker concurrency N (default 1, read live), but **non-`daily` runs
 * are serialized regardless of N** — reconcile-before-create is
 * read-then-write, and two concurrent runs over related datums could
 * both mint a loop. A tick therefore runs its claimed `daily` batch
 * runs in parallel first (per-source batches touch disjoint data),
 * then the rest strictly one at a time.
 *
 * `isEnabled` is read live on every tick (the Briefs feature gate:
 * experimental mode AND an assigned background-agent model). The task is
 * registered once whenever experimental mode is enabled, so assigning or
 * removing the model starts/parks runs without a restart or re-registration.
 */

import { agentFailureScope } from "@omnesis/agent";
import { QueueTracker } from "../background-jobs/trackers.js";
import { periodicJob } from "../background-jobs/scheduler-job.js";
import { runWithPriority } from "../priority.js";
import { documentDerivationState, derivationStageLabels } from "../domain/DocumentDerivation.js";
import {
  countPendingCognitionRuns,
  DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
} from "./storage/run-queue.js";
import {
  breakerIsOpen,
  breakerMirrorChanged,
  newProviderBreakerState,
  recordRunOutcome,
  PROVIDER_BREAKER_ERROR_KEY,
  PROVIDER_BREAKER_FAILURES_KEY,
  PROVIDER_BREAKER_OPEN_UNTIL_KEY,
  type ProviderBreakerState,
} from "./provider-breaker.js";
import { getCognitionEngineState } from "./storage/engine-state.js";
import { cognitionSpendDay } from "./storage/spend.js";
import { countRunArtifacts } from "./storage/sweep-tally.js";
import { newestBriefForRun } from "./storage/briefs.js";
import { cognitiveWorkflowIdForRun, cognitiveWorkflowVersion } from "./cognition/workflows.js";
import { documentSourceId } from "./storage/coverage.js";
import {
  parseCognitionBootstrapRunPayload,
  parseCognitionDataRunPayload,
  parseCognitionDigestRunPayload,
  parseCognitionSweepRunPayload,
} from "./run-payloads.js";
import { systemClock, type Clock, type ClaimedCognitionRun } from "./storage/types.js";
import type { CognitionBudgetVerdict } from "./cognition/budget.js";
import type { Logger } from "@omnesis/core";
import type Database from "better-sqlite3";
import type { BackgroundJob } from "../background-jobs/types.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { PeriodicTask, TaskOutcome } from "../scheduler/types.js";
import type { WriteGate } from "../write-gate.js";
import type { CognitionRunActivity } from "./run-activity.js";
import type { CognitionRunDriver } from "./run-driver.js";
import type { FsCognitionTranscriptStore } from "./transcripts.js";

type Db = Database.Database;

interface IdleResult {
  idle: boolean;
}

const isIdleResult = (r: IdleResult): boolean => r.idle;

/** First-retry delay after a failed attempt; doubles per attempt. */
const DEFAULT_COGNITION_RUN_BASE_BACKOFF_MS = 60_000;
/** Retry-delay ceiling. */
const DEFAULT_COGNITION_RUN_MAX_BACKOFF_MS = 60 * 60_000;

/**
 * The document a run reasoned over, or null for the kinds that name none
 * (daily batches, sweeps, digests). Both the bootstrap marker and the
 * per-source coverage tally hang off it.
 */
function runDocId(run: ClaimedCognitionRun): string | null {
  if (run.kind === "data") return parseCognitionDataRunPayload(run.payload)?.docId ?? null;
  if (run.kind === "bootstrap")
    return parseCognitionBootstrapRunPayload(run.payload)?.docId ?? null;
  return null;
}

/** Exponential backoff for attempt N (1-based): base·2^(N-1), capped. */
export function cognitionRunBackoffMs(
  attempts: number,
  cfg: { baseBackoffMs: number; maxBackoffMs: number },
): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(cfg.maxBackoffMs, cfg.baseBackoffMs * 2 ** exp);
}

export interface CognitionDrainerOpts {
  db: Db;
  /**
   * The digest push tier, wired when the Briefs feature is active and
   * APNs is available. Read live per completion — the knob flips without
   * a restart.
   */
  digestPush?: {
    getEnabled: () => boolean;
    send: (brief: import("./storage/types.js").BriefRow, day: string) => Promise<void>;
  };
  writeGate: WriteGate;
  driver: CognitionRunDriver;
  transcripts: FsCognitionTranscriptStore;
  log: Logger;
  /** Live kill-switch — the Briefs feature-gate verdict, re-read per tick. */
  isEnabled: () => boolean;
  /**
   * The day's spend ceiling, re-read per tick. Exhausted parks the drain: a
   * parked run resumes tomorrow, where failing it would burn its attempt
   * budget and eventually strand it in the terminal state.
   */
  getBudgetVerdict: () => CognitionBudgetVerdict;
  /**
   * Live-run registry the operator surface reads — marked around each
   * `driver.execute` so `/admin/brain/runs` can flag what is executing
   * right now. Optional: storage-only tests omit it.
   */
  activity?: CognitionRunActivity;
  /** Live worker concurrency N (non-`daily` runs serialize regardless). */
  getWorkerConcurrency: () => number;
  /**
   * Live quiet window (ms) to re-open when an in-flight fold resurrects a
   * `data` run — the debounce a resurrected hot thread must re-clear before it
   * fires again (the primary spend-safety window). A single generic value: a
   * resurrected run's doc type isn't known here without coupling to the
   * payload, and resurrects are dominated by hot conversation threads, so the
   * wiring passes the conversation debounce. Other run kinds re-fire ASAP.
   */
  getResurrectDebounceMs: () => number;
  clock?: Clock;
  /** Retry tunables. */
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Drain active cadence. Default 3s. */
  drainIntervalMs?: number;
  /** Drain idle backoff. Default 30s. */
  drainIdleMs?: number;
  /** Drain first-tick delay after scheduler start. Default 8s. */
  drainStartDelayMs?: number;
}

export interface CognitionDrainerBundle {
  tasks: PeriodicTask<unknown, IdleResult>[];
  jobs: BackgroundJob[];
}

/** Cadence env override (test harnesses drive the drain faster than prod). */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * Report `data` runs claimed with their datum's derivation still unfinished —
 * the readiness barrier's ceiling was reached before the deterministic
 * pipeline caught up.
 *
 * This is the operator-facing half of the barrier. The run still goes ahead
 * (an indefinite wait would be worse) and its prompt states which stages were
 * missing, but a breach means some background stage is running slower than the
 * barrier allows and is worth investigating on its own — so it is logged as a
 * warning rather than folded silently into the run.
 */
function reportUnreadyDataRuns(db: Db, claimed: readonly ClaimedCognitionRun[], log: Logger): void {
  for (const run of claimed) {
    if (run.kind !== "data") continue;
    const payload = parseCognitionDataRunPayload(run.payload);
    // Only a run the barrier actually held can exceed it. Runs that opted out
    // (content addressed to the assistant), ran with the barrier disabled, or
    // were scheduled by another producer entirely never made the promise this
    // warning reports on breaking.
    if (payload === null || payload.barrierUntil === undefined) continue;
    const state = documentDerivationState(db, payload.docId);
    if (!state.exists || state.complete) continue;
    log.warn(
      `readiness barrier exceeded: data run ${run.id} claimed for ${payload.docId} with derivation incomplete (${derivationStageLabels(state.pending).join(", ")}) — the graph context handed to this run is partial`,
    );
  }
}

export function createCognitionDrainerTasks(
  opts: CognitionDrainerOpts,
  scheduler: Scheduler,
): CognitionDrainerBundle {
  const clock = opts.clock ?? systemClock;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_COGNITION_RUN_MAX_ATTEMPTS;
  // Lives for the drainer's lifetime, not the tick's: the whole point is to
  // carry a verdict about the backend across ticks. Starting closed on every
  // boot is deliberate — a restart is the operator's most likely response to
  // an outage, and it should always buy an immediate retry.
  let breaker: ProviderBreakerState = newProviderBreakerState();
  /**
   * Fold one settle into the breaker, mirroring the open/closed edge to engine
   * state so a paused brain is visible to an operator rather than only to the
   * log. A mirror write must never fail the run that triggered it: the run has
   * already settled, and losing a display value is not worth re-running work.
   */
  const foldIntoBreaker = async (
    outcome: { providerScoped: boolean; error?: string },
    now: number,
  ): Promise<void> => {
    const before = breaker;
    breaker = recordRunOutcome(before, outcome, now);
    if (!breakerMirrorChanged(before, breaker)) return;
    try {
      await opts.writeGate.setCognitionEngineState(
        PROVIDER_BREAKER_OPEN_UNTIL_KEY,
        String(breaker.openUntil),
      );
      await opts.writeGate.setCognitionEngineState(PROVIDER_BREAKER_ERROR_KEY, breaker.lastError);
      await opts.writeGate.setCognitionEngineState(
        PROVIDER_BREAKER_FAILURES_KEY,
        String(breaker.consecutiveFailures),
      );
    } catch (err) {
      log.warn(`breaker state mirror failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  /**
   * Bring a mirror left open by a previous process back in line with the
   * breaker this one actually holds.
   *
   * The breaker is in-memory and starts closed on every boot, but the mirror
   * is written only on the open/closed edge — so a process that ended while
   * open leaves a row describing a verdict nobody holds any more, and no edge
   * will ever come along to clear it. That row is precisely what an operator
   * who topped up an account and restarted the gateway would be reading: runs
   * completing behind a panel that still says the backend is failing, for the
   * rest of a cooldown that expired with the old process. Reconciled once per
   * boot, at the first tick, before anything is claimed.
   */
  let mirrorReconciled = false;
  const reconcileBreakerMirror = async (): Promise<void> => {
    if (mirrorReconciled) return;
    try {
      const stored = getCognitionEngineState(opts.db, PROVIDER_BREAKER_OPEN_UNTIL_KEY);
      if (stored !== null && Number(stored) !== 0) {
        await opts.writeGate.setCognitionEngineState(PROVIDER_BREAKER_OPEN_UNTIL_KEY, "0");
        await opts.writeGate.setCognitionEngineState(PROVIDER_BREAKER_ERROR_KEY, "");
        await opts.writeGate.setCognitionEngineState(PROVIDER_BREAKER_FAILURES_KEY, "0");
        log.info("cleared a provider-breaker mirror left open by a previous process");
      }
      mirrorReconciled = true;
    } catch (err) {
      // Left unreconciled so the next tick retries: a stale outage banner is
      // not worth failing a drain over, but it should not survive a working
      // writer either.
      log.warn(
        `breaker state reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const backoffCfg = {
    baseBackoffMs: opts.baseBackoffMs ?? DEFAULT_COGNITION_RUN_BASE_BACKOFF_MS,
    maxBackoffMs: opts.maxBackoffMs ?? DEFAULT_COGNITION_RUN_MAX_BACKOFF_MS,
  };
  const log = opts.log;

  const tracker = new QueueTracker({
    initialRemaining: safeCount(opts.db, maxAttempts, log),
  });

  /** Execute one claimed run and settle its row + spend. Never throws. */
  async function processOne(
    run: ClaimedCognitionRun,
    signal: AbortSignal,
  ): Promise<"completed" | "retry" | "failed"> {
    let outcome;
    opts.activity?.start(run.id, clock());
    try {
      outcome = await opts.driver.execute(run, { signal });
    } catch (err) {
      // The driver contract is never-throw; this is a second net.
      outcome = {
        ok: false as const,
        errorMessage: err instanceof Error ? err.message : String(err),
        modelId: null,
        usage: null,
        finalText: "",
        citations: [],
        openedDocIds: [],
      };
    } finally {
      opts.activity?.settle(run.id);
    }
    const now = clock();
    const day = cognitionSpendDay(now);
    // Spend is attributed to the semantic workflow, not the queue kind that
    // carried it — several kinds multiplex procedures with very different cost
    // profiles, and a model-assignment decision is made per workflow. Derived
    // from the CLAIMED payload, before settle wipes its transient fields.
    const mechanism = cognitiveWorkflowIdForRun(run.kind, run.payload);
    // A `data` run that folded in-flight re-enters its debounce window on
    // resurrect (not fires immediately); other kinds have no debounce and
    // re-fire ASAP. Read live so a config reload is picked up.
    //
    // Except when the datum is addressed to the assistant. That marker's whole
    // contract is that nothing downstream delays the run, and the cycle never
    // had a quiet window to re-enter in the first place — it was enqueued with
    // zero debounce and zero defer ceiling. Making its resurrect wait would
    // park content the user deliberately handed over for the full
    // conversation window.
    const isImmediateData =
      run.kind === "data" && parseCognitionDataRunPayload(run.payload)?.immediate === true;
    const debounceMs = run.kind === "data" && !isImmediateData ? opts.getResurrectDebounceMs() : 0;
    const docId = runDocId(run);
    /**
     * Tally this settle against the source of the document it reasoned over.
     * Reporting only — no selection path reads it (see storage/coverage.ts) —
     * so a settle whose document has since been deleted simply records
     * nothing rather than holding up the run.
     */
    const recordCoverage = async (result: "processed" | "skipped"): Promise<void> => {
      if (docId === null) return;
      const sourceId = documentSourceId(opts.db, docId);
      if (sourceId === null) return;
      await opts.writeGate.recordCognitionCoverage(
        [
          {
            sourceId,
            workflowId: mechanism,
            workflowVersion: cognitiveWorkflowVersion(mechanism),
            processed: result === "processed" ? 1 : 0,
            skipped: result === "skipped" ? 1 : 0,
            promptTokens: outcome.usage?.promptTokens ?? 0,
            completionTokens: outcome.usage?.completionTokens ?? 0,
          },
        ],
        now,
      );
    };
    /**
     * Tally a settled sweep run against its sweep id — the durable per-sweep
     * record the authoring page reports from. Kept separate from coverage
     * because coverage is keyed on the source of a document and a sweep reads
     * no single document. Counted from `created_by_run` rather than
     * accumulated during the run, so a retry cannot double-count.
     */
    const recordSweepTally = async (failed: boolean): Promise<void> => {
      const sweep = parseCognitionSweepRunPayload(run.payload);
      if (!sweep) return;
      await opts.writeGate.recordSweepTally(
        {
          sweepId: sweep.sweepId,
          ...(failed ? { failedRuns: 1 } : { runs: 1 }),
          promptTokens: outcome.usage?.promptTokens ?? 0,
          completionTokens: outcome.usage?.completionTokens ?? 0,
          ...countRunArtifacts(opts.db, run.id),
        },
        now,
      );
    };
    if (outcome.ok) {
      await opts.writeGate.finalizeCognitionRun({
        runId: run.id,
        now,
        day,
        mechanism,
        modelId: outcome.modelId,
        usage: outcome.usage,
        claimedPayloadJson: run.payloadJson,
        debounceMs,
        outcome: { kind: "completed" },
      });
      // Bootstrap markers, both sides of the boundary:
      //  - the cross-arc skip — a completed bootstrap run that opened older
      //    documents to resolve an arc marks them, so they never earn a run;
      //  - the live datum a `data` run just reasoned over. Its own date can
      //    later carry it out of the waker's recency window and into the
      //    bootstrap work-list; the marker is what stops the retrospective
      //    lane buying a second full run for a document already covered.
      const marked = [
        ...(run.kind === "bootstrap" ? outcome.openedDocIds : []),
        ...(run.kind === "data" && docId !== null ? [docId] : []),
      ];
      if (marked.length > 0) {
        await opts.writeGate.markDocsBootstrapProcessed(marked, new Date(now).toISOString());
      }
      await recordCoverage("processed");
      await recordSweepTally(false);
      // The push tier: a completed digest run that minted its card sends
      // the day's one notification. Never throws (sendDigestPush's
      // contract); a push failure must not fail the run.
      if (opts.digestPush) {
        const digest = parseCognitionDigestRunPayload(run.payload);
        if (digest && opts.digestPush.getEnabled()) {
          const brief = newestBriefForRun(opts.db, run.id);
          if (brief) await opts.digestPush.send(brief, digest.date);
          else log.info(`digest run ${run.id} completed without a brief — no push`);
        }
      }
      await foldIntoBreaker({ providerScoped: false }, now);
      return "completed";
    }
    // Two orthogonal questions decide how a failure settles: does the payload
    // stand a chance on a later attempt, and was the payload even the thing
    // that failed?
    //
    // `retryable === false` answers the first: a deterministic model-limit
    // failure cannot recover while the claimed payload is unchanged, so it
    // settles after this exact attempt rather than burning the transient
    // budget.
    //
    // The scope answers the second, and governs the attempt budget. A
    // `provider`-scope failure — no credit, a rejected key, a rate limit, an
    // unreachable backend — never adjudicated the payload at all. Spending
    // retries on it, and then retiring the run when they run out, discards
    // work for an environment fault that a human clears on a timescale of
    // hours. So the attempt is refunded and the run stays claimable: it waits
    // out the outage instead of being consumed by it. That is deliberately
    // unbounded, because the alternative to waiting is losing the work; the
    // breaker below is what stops the waiting from becoming a hot loop.
    //
    // A failure with no structured detail is our own code throwing, not a
    // provider verdict, so it counts as `request`: it must be able to retire.
    // Treating it as an outage would let one reliably-throwing run hold the
    // breaker open and stall every lane behind it. The marker re-admission on
    // terminal bootstrap failure is what keeps that default from costing a
    // document outright.
    const scope = outcome.failure ? agentFailureScope(outcome.failure) : "request";
    const providerScoped = scope === "provider";
    const terminal =
      outcome.failure?.retryable === false || (!providerScoped && run.attempts >= maxAttempts);
    await opts.writeGate.finalizeCognitionRun({
      runId: run.id,
      now,
      day,
      mechanism,
      modelId: outcome.modelId,
      usage: outcome.usage,
      claimedPayloadJson: run.payloadJson,
      debounceMs,
      outcome: {
        kind: "failed",
        errorMessage: outcome.errorMessage ?? "unknown error",
        ...(outcome.failure ? { failureCode: outcome.failure.code } : {}),
        terminal,
        // This is the retry pacing for a `request`-scope failure only, and it
        // ramps because `attempts` climbs. A refunded attempt does not climb,
        // so for a `provider`-scope failure this stays flat at the base delay
        // — deliberately, because per-run backoff is the wrong instrument for
        // a backend-wide fault. Three thousand queued runs each backing off on
        // their own still arrive as three thousand requests; what has to be
        // paced is the drainer, not the run. The breaker does that globally,
        // and it gates claiming before this due-time is ever consulted.
        nextAttemptAt: now + cognitionRunBackoffMs(run.attempts, backoffCfg),
        ...(providerScoped && !terminal ? { refundAttempt: true } : {}),
      },
    });
    // A run still due for another attempt has not settled, so it counts as
    // neither covered nor given up on; only the terminal give-up does.
    if (terminal) {
      await recordCoverage("skipped");
      await recordSweepTally(true);
      // The document was marked processed when it was enqueued, so retiring
      // the run here would leave it marked without ever having been reasoned
      // over — a hole the enqueuer can never revisit, because it selects on
      // the marker being absent. Lift it so the lane picks the document up
      // again, bounded per document so one that fails on its own content
      // cannot cycle forever.
      if (run.kind === "bootstrap" && docId !== null) {
        const readmitted = await opts.writeGate.readmitFailedBootstrapDoc(docId);
        log.info(
          readmitted
            ? `bootstrap doc ${docId} re-admitted after a terminal run failure`
            : `bootstrap doc ${docId} left marked — re-admission budget spent`,
        );
      }
    }
    await foldIntoBreaker(
      { providerScoped, ...(outcome.errorMessage ? { error: outcome.errorMessage } : {}) },
      now,
    );
    return terminal ? "failed" : "retry";
  }

  const drainTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.drain",
    runner: "main",
    priority: "background",
    periodMs: opts.drainIntervalMs ?? envInt("OMNESIS_COGNITION_DRAIN_INTERVAL_MS") ?? 3_000,
    idlePeriodMs: opts.drainIdleMs ?? envInt("OMNESIS_COGNITION_DRAIN_IDLE_MS") ?? 30_000,
    startDelayMs:
      opts.drainStartDelayMs ?? envInt("OMNESIS_COGNITION_DRAIN_START_DELAY_MS") ?? 8_000,
    // A tick awaits up to N full agent runs; a healthy run can take
    // minutes of model round-trips. Budget generously.
    latencyBudgetMs: 10 * 60_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(_args, ctx): Promise<TaskOutcome<unknown, IdleResult>> {
      if (!opts.isEnabled()) return { kind: "done", value: { idle: true } };
      await reconcileBreakerMirror();
      // The day's ceiling, checked before claiming rather than before
      // executing: an already-claimed run has burned an attempt, so parking at
      // the claim boundary leaves the queue exactly where it was. Read fresh so
      // raising the limit resumes work without a restart.
      const budget = opts.getBudgetVerdict();
      if (budget.exhausted) {
        log.info(`cognition paused — ${budget.reason}`);
        return { kind: "done", value: { idle: true } };
      }
      // Checked at the same boundary as the budget, and for the same reason:
      // an already-claimed run has burned an attempt, so declining to claim is
      // the only pause that leaves the queue exactly where it was.
      if (breakerIsOpen(breaker, clock())) {
        log.info(
          `cognition paused — model backend failing (${breaker.consecutiveFailures} consecutive): ${breaker.lastError}`,
        );
        return { kind: "done", value: { idle: true } };
      }
      try {
        const limit = Math.max(1, opts.getWorkerConcurrency());
        const claimed = await runWithPriority("background", () =>
          opts.writeGate.claimDueCognitionRuns({ now: clock(), limit, maxAttempts }),
        );
        if (claimed.length === 0) return { kind: "done", value: { idle: true } };
        reportUnreadyDataRuns(opts.db, claimed, log);

        // Per-source daily batches may use the full N in parallel (they
        // touch disjoint data); everything else — including the digest,
        // which reconciles against the whole brief store — runs strictly
        // one at a time (see the module docstring). ctx.signal aborts
        // in-flight model turns on scheduler dispose.
        const isParallelDaily = (r: ClaimedCognitionRun): boolean =>
          r.kind === "daily" && parseCognitionDigestRunPayload(r.payload) === null;
        const daily = claimed.filter(isParallelDaily);
        const serial = claimed.filter((r) => !isParallelDaily(r));
        const outcomes = await Promise.all(daily.map((r) => processOne(r, ctx.signal)));
        for (const run of serial) outcomes.push(await processOne(run, ctx.signal));

        tracker.recordTick(outcomes.filter((o) => o !== "retry").length);
        tracker.setRemaining(safeCount(opts.db, maxAttempts, log));
        log.info(
          `steward drain: claimed=${claimed.length} completed=${outcomes.filter((o) => o === "completed").length} failed=${outcomes.filter((o) => o === "failed").length} retrying=${outcomes.filter((o) => o === "retry").length}`,
        );
        return { kind: "done", value: { idle: false } };
      } catch (err) {
        log.warn(`steward drain failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  const tasks = [drainTask];
  const jobs: BackgroundJob[] = [
    periodicJob(drainTask, {
      scheduler,
      displayName: "Cognition Steward run drain",
      description:
        "Claims due Cognition Steward runs from the agent run queue and executes them headlessly, with exponential backoff and per-day spend accounting.",
      category: "briefs",
      tracker,
      isDisabled: () => !opts.isEnabled(),
    }),
  ];

  return { tasks, jobs };
}

function safeCount(db: Db, maxAttempts: number, log: Logger): number {
  try {
    return countPendingCognitionRuns(db, maxAttempts);
  } catch (err) {
    log.debug(
      `steward ground-truth refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}
