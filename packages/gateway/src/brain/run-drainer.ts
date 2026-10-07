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
 * Region-fenced knowledge maintenance shares a bounded worker pool. Root and
 * legacy runs execute exclusively. One coordinator claims each run at most
 * once per tick, refills freed slots, and awaits every admitted task before
 * returning, including after abort or admission failure.
 *
 * `isEnabled` is read live on every tick (the Briefs feature gate:
 * experimental mode AND an assigned background-agent model). The task is
 * registered once whenever experimental mode is enabled, so assigning or
 * removing the model starts/parks runs without a restart or re-registration.
 */

import { randomUUID } from "node:crypto";
import { agentFailureScope } from "@omnesis/agent";
import { QueueTracker } from "../background-jobs/trackers.js";
import { periodicJob } from "../background-jobs/scheduler-job.js";
import { runWithPriority } from "../priority.js";
import { documentDerivationState, derivationStageLabels } from "../domain/DocumentDerivation.js";
import { knowledgeContinuationProgress } from "./knowledge/continuation.js";
import {
  countPendingCognitionRuns,
  DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
  getCognitionRun,
  isParallelKnowledgeRun,
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
import {
  getCognitionEngineState,
  cognitionBootstrapEnqueuedKey,
  COGNITION_BOOTSTRAP_TOTAL_KEY,
} from "./storage/engine-state.js";
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
import type { CognitionRunDriver, CognitionRunOutcome } from "./run-driver.js";
import type { WorthGate } from "./worth-gate/gate.js";
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
  /**
   * The worth gate: asks the decision model, per claimed bootstrap/data run,
   * whether its email is worth an agent turn. Absent (or inactive) means
   * every claimed run executes.
   */
  worthGate?: WorthGate;
  /** Live maintenance worker cap (1–32); unfenced and root work stays exclusive. */
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

  /**
   * Ask the worth gate about a claimed bootstrap/data run. On a skip, settle
   * the run as completed with no agent turn: the document is marked covered so
   * no lane selects it again, coverage tallies it as skipped, and a bootstrap
   * run hands its slot back to the lane's daily and lifetime pace counters —
   * a gated document costs a decision, not an agent run, so it must not use
   * up the agent-run budget. Returns null when the run should execute.
   */
  async function settleIfGatedOut(
    run: ClaimedCognitionRun,
    signal: AbortSignal,
  ): Promise<"completed" | null> {
    if (!opts.worthGate || (run.kind !== "data" && run.kind !== "bootstrap")) return null;
    const gate = await opts.worthGate.evaluate(run, signal);
    if (gate?.verdict !== "skip") return null;
    const now = clock();
    const enqueuedAt = getCognitionRun(opts.db, run.id)?.enqueuedAt ?? now;
    const mechanism = cognitiveWorkflowIdForRun(run.kind, run.payload);
    await opts.writeGate.finalizeCognitionRun({
      runId: run.id,
      now,
      day: cognitionSpendDay(now),
      mechanism,
      // Attributed to the decision model that settled it, so a gated run is
      // never mistaken for an agent run of its workflow.
      modelId: gate.modelId,
      usage: null,
      claimedPayloadJson: run.payloadJson,
      debounceMs: 0,
      outcome: { kind: "completed" },
    });
    // The run is settled; what follows is bookkeeping, and a failure there is
    // logged rather than unwinding a settle that already happened.
    try {
      await settleGatedBookkeeping(run, mechanism, now, enqueuedAt);
    } catch (err) {
      log.warn(
        `run ${run.id} gated out, but its bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    log.info(
      `run ${run.id} (${run.kind}) gated out: worth score ${gate.score?.toFixed(2) ?? "?"} < ${gate.threshold}`,
    );
    return "completed";
  }

  /** Coverage, the covered marker and the pace refund for a run the gate settled. */
  async function settleGatedBookkeeping(
    run: ClaimedCognitionRun,
    mechanism: ReturnType<typeof cognitiveWorkflowIdForRun>,
    now: number,
    enqueuedAt: number,
  ): Promise<void> {
    const docId = runDocId(run);
    if (docId !== null) {
      await opts.writeGate.markDocsBootstrapProcessed([docId], new Date(now).toISOString());
      const sourceId = documentSourceId(opts.db, docId);
      if (sourceId !== null) {
        await opts.writeGate.recordCognitionCoverage(
          [
            {
              sourceId,
              workflowId: mechanism,
              workflowVersion: cognitiveWorkflowVersion(mechanism),
              processed: 0,
              skipped: 1,
              promptTokens: 0,
              completionTokens: 0,
            },
          ],
          now,
        );
      }
    }
    if (run.kind === "bootstrap") {
      // Handed back to the day that counted it, and never below zero.
      for (const key of [
        cognitionBootstrapEnqueuedKey(cognitionSpendDay(enqueuedAt)),
        COGNITION_BOOTSTRAP_TOTAL_KEY,
      ]) {
        if ((Number(getCognitionEngineState(opts.db, key) ?? "0") || 0) > 0) {
          await opts.writeGate.addToCognitionEngineCounter(key, -1);
        }
      }
    }
  }

  /** Execute one claimed run and settle its row + spend. Never throws. */
  async function processOne(
    run: ClaimedCognitionRun,
    signal: AbortSignal,
  ): Promise<"completed" | "retry" | "failed"> {
    let gated: "completed" | null = null;
    try {
      gated = await settleIfGatedOut(run, signal);
    } catch (err) {
      // The gate could not settle the run; it runs as if ungated.
      log.warn(
        `worth gate could not settle run ${run.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (gated) return gated;
    let outcome: CognitionRunOutcome;
    const progress = knowledgeContinuationProgress(opts.db, run);
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
    if (
      progress &&
      !outcome.ok &&
      (outcome.failure?.code === "tool_iteration_cap" || outcome.toolLimitReached)
    ) {
      const successorId = `cog_${randomUUID()}`;
      if (
        await opts.writeGate["knowledge.continueRun"]({
          progress,
          successorId,
          settlement: {
            runId: run.id,
            now,
            day,
            mechanism,
            modelId: outcome.modelId,
            usage: outcome.usage,
            claimedPayloadJson: run.payloadJson,
          },
        })
      ) {
        log.info(
          `knowledge run ${run.id} reached its tool limit after durable progress; continuing in ${successorId}`,
        );
        return "completed";
      }
    }
    if (outcome.deferredUntil !== undefined) {
      await opts.writeGate.finalizeCognitionRun({
        runId: run.id,
        now,
        day,
        mechanism,
        modelId: null,
        usage: null,
        claimedPayloadJson: run.payloadJson,
        outcome: {
          kind: "failed",
          errorMessage: outcome.errorMessage ?? "Awaiting maintenance inputs",
          terminal: false,
          nextAttemptAt: outcome.continuation ? now : Math.max(now + 1000, outcome.deferredUntil),
          refundAttempt: true,
        },
      });
      return "retry";
    }
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

  let drainRunning = false;
  const drainTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.drain",
    runner: "main",
    priority: "background",
    periodMs: opts.drainIntervalMs ?? envInt("OMNESIS_COGNITION_DRAIN_INTERVAL_MS") ?? 3_000,
    idlePeriodMs: opts.drainIdleMs ?? envInt("OMNESIS_COGNITION_DRAIN_IDLE_MS") ?? 30_000,
    startDelayMs:
      opts.drainStartDelayMs ?? envInt("OMNESIS_COGNITION_DRAIN_START_DELAY_MS") ?? 8_000,
    // Admissions are count-bounded, but admitted runs may need minutes of
    // model round-trips to finish or abort before the task can return.
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
      if (drainRunning) return { kind: "done", value: { idle: true } };
      drainRunning = true;
      const active = new Map<string, { parallel: boolean; task: Promise<void> }>();
      const visited = new Set<string>();
      const outcomes: Array<"completed" | "retry" | "failed"> = [];
      let admissionError: unknown;
      let failedAdmission = false;
      let wakeAdmission: (() => void) | undefined;
      const waitForArrival = (): Promise<void> =>
        new Promise((resolve) => {
          // The planner may enqueue work while every admitted run is still busy.
          // Poll only vacant capacity, and cancel the timer on completion/abort.
          const wake = (): void => {
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", wake);
            if (wakeAdmission === wake) wakeAdmission = undefined;
            resolve();
          };
          const timer = setTimeout(wake, 250);
          wakeAdmission = wake;
          ctx.signal.addEventListener("abort", wake, { once: true });
          if (ctx.signal.aborted) wake();
        });
      try {
        const configured = opts.getWorkerConcurrency();
        const limit = Number.isFinite(configured)
          ? Math.max(1, Math.min(32, Math.trunc(configured)))
          : 4;
        // Bound each scheduler invocation even when cheap runs refill instantly.
        const admissionLimit = limit * 4;
        while (visited.size < admissionLimit) {
          if (
            ctx.signal.aborted ||
            ctx.shouldYield() ||
            failedAdmission ||
            !opts.isEnabled() ||
            opts.getBudgetVerdict().exhausted ||
            breakerIsOpen(breaker, clock())
          )
            break;
          if (active.size >= limit || [...active.values()].some((entry) => !entry.parallel)) {
            await Promise.race([...active.values()].map((entry) => entry.task));
            continue;
          }
          const claimed = await runWithPriority("background", () =>
            opts.writeGate.claimDueCognitionRuns({
              now: clock(),
              limit: 1,
              maxAttempts,
              excludeIds: [...new Set([...visited, ...active.keys()])],
              parallelOnly: active.size > 0,
            }),
          );
          const run = claimed[0];
          if (!run) {
            if (active.size === 0) break;
            await waitForArrival();
            continue;
          }
          visited.add(run.id);
          reportUnreadyDataRuns(opts.db, claimed, log);
          const parallel = isParallelKnowledgeRun(opts.db, run.id);
          // A batch can lose parallel eligibility while its writer claim returns.
          if (!parallel && active.size > 0)
            await Promise.allSettled([...active.values()].map((entry) => entry.task));
          const task = processOne(run, ctx.signal)
            .then((outcome) => {
              outcomes.push(outcome);
            })
            .catch((error: unknown) => {
              admissionError = error;
              failedAdmission = true;
            })
            .finally(() => {
              active.delete(run.id);
              wakeAdmission?.();
            });
          active.set(run.id, { parallel, task });
        }
      } catch (error) {
        admissionError = error;
        failedAdmission = true;
      } finally {
        // Never return a scheduler context while one of its admitted runs lives.
        await Promise.allSettled([...active.values()].map((entry) => entry.task));
        drainRunning = false;
      }
      if (failedAdmission)
        log.warn(
          `steward drain failed: ${admissionError instanceof Error ? admissionError.message : String(admissionError)}`,
        );
      tracker.recordTick(outcomes.filter((outcome) => outcome !== "retry").length);
      tracker.setRemaining(safeCount(opts.db, maxAttempts, log));
      if (visited.size)
        log.info(
          `steward drain: claimed=${visited.size} completed=${outcomes.filter((o) => o === "completed").length} failed=${outcomes.filter((o) => o === "failed").length} retrying=${outcomes.filter((o) => o === "retry").length}`,
        );
      return { kind: "done", value: { idle: visited.size === 0 && !failedAdmission } };
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
