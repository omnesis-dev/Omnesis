// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Cognition Steward's time-driven background tasks, on the same
 * `PeriodicTask` shape as the run drainer:
 *
 *   - `cognition.dailyRhythm` — a coarse tick whose due-gate fires the
 *     daily enqueuer once per local day at the configured hour (the
 *     per-source batches over the previous day's structured data);
 *   - `cognition.decaySweep` — the dirty-gated decay sweep scheduling
 *     status-checks on stale loops.
 *
 * Both re-read `isEnabled` (the Briefs feature gate) every tick, so
 * removing the background-agent model assignment quiesces them without
 * a restart. Both tasks only enqueue queue rows — the drainer executes
 * them — so their latency budget is small.
 */

import { QueueTracker, StatelessTracker } from "../../background-jobs/trackers.js";
import { periodicJob } from "../../background-jobs/scheduler-job.js";
import { runWithPriority } from "../../priority.js";
import { systemClock, type Clock } from "../storage/types.js";
import { runMergeAdjudicationEnqueuePass } from "../merge-adjudication.js";
import { runDailyEnqueuePass, type DailyEnqueuerWriteOps } from "./daily-enqueuer.js";
import { runDigestEnqueuePass } from "./digest-enqueuer.js";
import {
  runDecaySweepPass,
  type DecaySweepWriteOps,
  type DecayBackoffConfig,
} from "./decay-sweep.js";
import { runSynthesisEnqueuePass } from "./synthesis-enqueuer.js";
import {
  runBootstrapEnqueuePass,
  type BootstrapEnqueuerWriteOps,
  type BootstrapSettings,
} from "./bootstrap-enqueuer.js";
import { runCollisionSweepPass } from "./collision-sweep-enqueuer.js";
import {
  reanchorProvenanceRecheckWatermark,
  runProvenanceRecheckSweepPass,
  type ProvenanceRecheckSettings,
} from "./provenance-recheck-sweep.js";
import { runReverificationSweepPass, type ReverificationSettings } from "./reverification-sweep.js";
import { runSweepEnqueuePass } from "./sweep-enqueuer.js";
import type { SweepDef } from "../sweeps/types.js";
import type { Logger } from "@omnesis/core";
import type Database from "better-sqlite3";
import type { BackgroundJob } from "../../background-jobs/types.js";
import type { Scheduler } from "../../scheduler/scheduler.js";
import type { PeriodicTask, TaskOutcome } from "../../scheduler/types.js";

type Db = Database.Database;

interface IdleResult {
  idle: boolean;
}

const isIdleResult = (r: IdleResult): boolean => r.idle;

/** The write-gate slice the snooze-resurface pass mutates through. */
export interface SnoozeResurfaceWriteOps {
  resurfaceDueSnoozedBriefs(now: number): Promise<number>;
}

/** Cadence env override (test harnesses drive the ticks faster than prod). */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

export interface CognitionRhythmOpts {
  db: Db;
  writeGate: DailyEnqueuerWriteOps &
    DecaySweepWriteOps &
    SnoozeResurfaceWriteOps &
    BootstrapEnqueuerWriteOps;
  log: Logger;
  /** Live kill-switch — the Briefs feature-gate verdict, re-read per tick. */
  isEnabled: () => boolean;
  /** Live settings slices (config is hot-reloadable). */
  getDailyRunHour: () => number;
  getDecayBackoff: () => DecayBackoffConfig;
  /**
   * Proactive-lane knobs — read live per tick. Optional: absent (as in
   * the pure-composition unit tests) leaves both generative producers off.
   */
  getSynthesisEnabled?: () => boolean;
  getSynthesisCadenceHours?: () => number;
  getSynthesisMaxPerDay?: () => number;
  getCollisionEnabled?: () => boolean;
  getCollisionCadenceHours?: () => number;
  getCollisionMaxPerSweep?: () => number;
  /** Self person id, excluded from the collision person-signal. */
  getSelfPersonId?: () => string | null;
  getCollisionTimeHorizonDays?: () => number;
  /** Annotation-contradiction arm of the collision sweep (its own gate + budget). */
  getAnnotationContradictionsEnabled?: () => boolean;
  getAnnotationContradictionsMaxPerSweep?: () => number;
  /** Master switch + the declared themes for the scheduled sweep registry. */
  getSweepsEnabled?: () => boolean;
  /**
   * Merge-adjudication knob — read live per tick. Absent (pure-composition
   * tests) leaves the pass off.
   */
  getMergeAdjudicationEnabled?: () => boolean;
  getDigestEnabled?: () => boolean;
  getDigestHour?: () => number;
  getDigestGraceMinutes?: () => number;
  /** Runs executing right now — the digest readiness barrier's live word. */
  getActiveRunCount?: () => number;
  getSweeps?: () => readonly SweepDef[];
  /**
   * Retrospective bootstrap knobs — read live per tick. Absent (pure-
   * composition tests) leaves the bootstrap off.
   */
  getBootstrapSettings?: () => BootstrapSettings;
  /**
   * Re-verification sweep knobs — read live per tick. Absent (pure-
   * composition tests) leaves the sweep off.
   */
  getReverificationSettings?: () => ReverificationSettings;
  /**
   * Provenance-recheck sweep knob — read live per tick. Absent (pure-
   * composition tests) leaves the sweep off.
   */
  getProvenanceRecheckSettings?: () => ProvenanceRecheckSettings;
  /**
   * Discover sources whose ONLY output in a boundary-to-boundary day was
   * analytics samples (health, financial samples) — rows in the analytics
   * store, not `documents`. Unioned with the document-derived sources so
   * an analytics-only source still gets its daily batch. Omitted in tests
   * that exercise only the document path.
   */
  listAnalyticsSampleSourceIds?: (fromMs: number, toMs: number) => Promise<string[]>;
  clock?: Clock;
  idGen?: () => string;
  /** Tick cadence. Default 60s — coarse is fine; the gates do the timing. */
  intervalMs?: number;
  /** Idle backoff. Default 5 min. */
  idleMs?: number;
  /** First-tick delay after scheduler start. Default 12s. */
  startDelayMs?: number;
}

export interface CognitionRhythmBundle {
  tasks: PeriodicTask<unknown, IdleResult>[];
  jobs: BackgroundJob[];
}

export function createCognitionRhythmTasks(
  opts: CognitionRhythmOpts,
  scheduler: Scheduler,
): CognitionRhythmBundle {
  const clock = opts.clock ?? systemClock;
  const log = opts.log;
  const intervalMs = opts.intervalMs ?? envInt("OMNESIS_COGNITION_RHYTHM_INTERVAL_MS") ?? 60_000;
  const idleMs = opts.idleMs ?? envInt("OMNESIS_COGNITION_RHYTHM_IDLE_MS") ?? 5 * 60_000;
  const startDelayMs =
    opts.startDelayMs ?? envInt("OMNESIS_COGNITION_RHYTHM_START_DELAY_MS") ?? 12_000;
  // When these tasks were composed — process start, for practical purposes.
  // The bootstrap lane holds every pass until the boot window has passed,
  // when the backfill workers have stopped competing for the read handle.
  const startedAt = clock();

  const dailyTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.dailyRhythm",
    runner: "main",
    priority: "background",
    periodMs: intervalMs,
    idlePeriodMs: idleMs,
    startDelayMs,
    latencyBudgetMs: 30_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      if (!opts.isEnabled()) return { kind: "done", value: { idle: true } };
      try {
        const result = await runWithPriority("background", () =>
          runDailyEnqueuePass({
            db: opts.db,
            writeGate: opts.writeGate,
            clock,
            getDailyRunHour: opts.getDailyRunHour,
            log,
            ...(opts.listAnalyticsSampleSourceIds
              ? { listAnalyticsSampleSourceIds: opts.listAnalyticsSampleSourceIds }
              : {}),
            ...(opts.idGen ? { idGen: opts.idGen } : {}),
          }),
        );
        return { kind: "done", value: { idle: !result.fired } };
      } catch (err) {
        log.warn(`daily rhythm failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  const digestTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.digest",
    runner: "main",
    priority: "background",
    periodMs: intervalMs,
    idlePeriodMs: idleMs,
    startDelayMs,
    latencyBudgetMs: 30_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      if (!opts.isEnabled() || !(opts.getDigestEnabled?.() ?? false)) {
        return { kind: "done", value: { idle: true } };
      }
      try {
        const result = await runWithPriority("background", () =>
          runDigestEnqueuePass({
            db: opts.db,
            writeGate: opts.writeGate,
            clock,
            getDigestHour: opts.getDigestHour ?? (() => 7),
            getGraceMinutes: opts.getDigestGraceMinutes ?? (() => 45),
            getActiveRunCount: opts.getActiveRunCount ?? (() => 0),
            // The digest is an editorial pass over the overnight work, so it
            // waits for the sweeps that declare themselves part of it — read
            // from the same resolved set the sweep enqueuer fires, and only
            // while that enqueuer is actually running. With the lane off no
            // sweep will ever fire, and waiting on one would hold every
            // digest to its grace deadline forever.
            getDigestPrerequisiteSweeps: () =>
              opts.getSweepsEnabled?.()
                ? (opts.getSweeps?.() ?? [])
                    .filter((s) => s.enabled && s.expectedBeforeDigest)
                    .map((s) => ({ id: s.id, anchorMinutes: s.anchorMinutes }))
                : [],
            log,
            ...(opts.idGen ? { idGen: opts.idGen } : {}),
          }),
        );
        return { kind: "done", value: { idle: !result.fired } };
      } catch (err) {
        log.warn(`digest rhythm failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  const decayTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.decaySweep",
    runner: "main",
    priority: "background",
    periodMs: intervalMs,
    idlePeriodMs: idleMs,
    startDelayMs,
    latencyBudgetMs: 30_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      if (!opts.isEnabled()) return { kind: "done", value: { idle: true } };
      try {
        const result = await runWithPriority("background", () =>
          runDecaySweepPass({
            db: opts.db,
            writeGate: opts.writeGate,
            clock,
            getBackoff: opts.getDecayBackoff,
            log,
            ...(opts.idGen ? { idGen: opts.idGen } : {}),
          }),
        );
        return { kind: "done", value: { idle: !result.swept } };
      } catch (err) {
        log.warn(`decay sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  const snoozeResurfaceTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.snoozeResurface",
    runner: "main",
    priority: "background",
    periodMs: intervalMs,
    idlePeriodMs: idleMs,
    startDelayMs,
    latencyBudgetMs: 30_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      if (!opts.isEnabled()) return { kind: "done", value: { idle: true } };
      try {
        const resurfaced = await runWithPriority("background", () =>
          opts.writeGate.resurfaceDueSnoozedBriefs(clock()),
        );
        if (resurfaced > 0)
          log.info(`snooze resurface: ${resurfaced} brief(s) returned to the feed`);
        return { kind: "done", value: { idle: resurfaced === 0 } };
      } catch (err) {
        log.warn(`snooze resurface failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  const synthesisTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.synthesis",
    runner: "main",
    priority: "background",
    periodMs: intervalMs,
    idlePeriodMs: idleMs,
    startDelayMs,
    latencyBudgetMs: 30_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      if (!opts.isEnabled() || !(opts.getSynthesisEnabled?.() ?? false)) {
        return { kind: "done", value: { idle: true } };
      }
      try {
        const result = await runWithPriority("background", () =>
          runSynthesisEnqueuePass({
            db: opts.db,
            writeGate: opts.writeGate,
            clock,
            getCadenceHours: opts.getSynthesisCadenceHours ?? (() => 24),
            getMaxPerDay: opts.getSynthesisMaxPerDay ?? (() => 1),
            log,
            ...(opts.idGen ? { idGen: opts.idGen } : {}),
          }),
        );
        return { kind: "done", value: { idle: !result.fired } };
      } catch (err) {
        log.warn(`synthesis rhythm failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  const collisionTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.collisionSweep",
    runner: "main",
    priority: "background",
    periodMs: intervalMs,
    idlePeriodMs: idleMs,
    startDelayMs,
    latencyBudgetMs: 30_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      // The pass fires when EITHER arm family is on; per-arm gating lives in
      // the pass itself (loop/time arms vs. the annotation-contradiction arm).
      const collisionsOn = opts.getCollisionEnabled?.() ?? false;
      const annoContradictionsOn = opts.getAnnotationContradictionsEnabled?.() ?? false;
      if (!opts.isEnabled() || (!collisionsOn && !annoContradictionsOn)) {
        return { kind: "done", value: { idle: true } };
      }
      try {
        const result = await runWithPriority("background", () =>
          runCollisionSweepPass({
            db: opts.db,
            writeGate: opts.writeGate,
            clock,
            getCadenceHours: opts.getCollisionCadenceHours ?? (() => 24),
            getMaxPerSweep: opts.getCollisionMaxPerSweep ?? (() => 3),
            getSelfPersonId: opts.getSelfPersonId ?? (() => null),
            getTimeHorizonDays: opts.getCollisionTimeHorizonDays ?? (() => 60),
            getLoopCollisionsEnabled: () => opts.getCollisionEnabled?.() ?? false,
            getAnnotationContradictionsEnabled: () =>
              opts.getAnnotationContradictionsEnabled?.() ?? false,
            getAnnotationContradictionsMaxPerSweep:
              opts.getAnnotationContradictionsMaxPerSweep ?? (() => 2),
            log,
            ...(opts.idGen ? { idGen: opts.idGen } : {}),
          }),
        );
        return { kind: "done", value: { idle: !result.fired } };
      } catch (err) {
        log.warn(`collision sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  const sweepTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.sweeps",
    runner: "main",
    priority: "background",
    periodMs: intervalMs,
    idlePeriodMs: idleMs,
    startDelayMs,
    latencyBudgetMs: 30_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      if (!opts.isEnabled() || !(opts.getSweepsEnabled?.() ?? false)) {
        return { kind: "done", value: { idle: true } };
      }
      try {
        const result = await runWithPriority("background", () =>
          runSweepEnqueuePass({
            db: opts.db,
            writeGate: opts.writeGate,
            clock,
            getSweeps: opts.getSweeps ?? (() => []),
            log,
            ...(opts.idGen ? { idGen: opts.idGen } : {}),
          }),
        );
        return { kind: "done", value: { idle: result.fired === 0 } };
      } catch (err) {
        log.warn(`sweep rhythm failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  /**
   * The lane's progress gauge.
   *
   * A `QueueTracker` rather than the stateless one every other rhythm task
   * uses, because this lane is the one with a finite, knowable amount of work
   * left — and it was the only long-running job whose Progress column read as
   * an em-dash while it spent for days.
   *
   * Fed from the enqueue pass, which already counts what remains for its own
   * log line, so the gauge costs no query of its own. `observe()` is
   * contractually barred from touching the database; this stays on the right
   * side of that by pushing a number the task has already computed rather than
   * pulling one.
   */
  const bootstrapTracker = new QueueTracker({ initialRemaining: 0 });

  const bootstrapTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.bootstrap",
    runner: "main",
    priority: "background",
    periodMs: intervalMs,
    idlePeriodMs: idleMs,
    startDelayMs,
    latencyBudgetMs: 30_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      const settings = opts.getBootstrapSettings?.();
      if (!opts.isEnabled() || !settings?.enabled) {
        return { kind: "done", value: { idle: true } };
      }
      try {
        const result = await runWithPriority("background", () =>
          runBootstrapEnqueuePass({
            db: opts.db,
            writeGate: opts.writeGate,
            clock,
            getSettings: () => settings,
            log,
            startedAt,
            ...(opts.idGen ? { idGen: opts.idGen } : {}),
          }),
        );
        // Only a pass that actually probed the corpus knows what is left. A
        // pass that returned early — boot hold, shut window, parked or quiet
        // lane — reports nothing rather than zero, so the gauge holds its last
        // real figure instead of claiming the backfill finished.
        if (result.remaining !== undefined) bootstrapTracker.setRemaining(result.remaining);
        if (result.enqueued > 0) bootstrapTracker.recordTick(result.enqueued);
        // Idle once the backlog is topped up or the lane is quiet — the drainer
        // consumes the queue at its own (lowest-priority) pace.
        return { kind: "done", value: { idle: result.enqueued === 0 } };
      } catch (err) {
        log.warn(`bootstrap rhythm failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  const reverificationTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.reverificationSweep",
    runner: "main",
    priority: "background",
    periodMs: intervalMs,
    idlePeriodMs: idleMs,
    startDelayMs,
    latencyBudgetMs: 30_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      const settings = opts.getReverificationSettings?.();
      if (!opts.isEnabled() || !settings?.enabled) {
        return { kind: "done", value: { idle: true } };
      }
      try {
        const result = await runWithPriority("background", () =>
          runReverificationSweepPass({
            db: opts.db,
            writeGate: opts.writeGate,
            clock,
            getSettings: () => settings,
            log,
            ...(opts.idGen ? { idGen: opts.idGen } : {}),
          }),
        );
        return { kind: "done", value: { idle: !result.fired } };
      } catch (err) {
        log.warn(
          `re-verification sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  const provenanceRecheckTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.provenanceRecheck",
    runner: "main",
    priority: "background",
    periodMs: intervalMs,
    idlePeriodMs: idleMs,
    startDelayMs,
    latencyBudgetMs: 30_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      const settings = opts.getProvenanceRecheckSettings?.();
      if (!opts.isEnabled() || !settings?.enabled) {
        // Disabled tick: keep an existing watermark anchored at "now" so
        // deaths landing while the knob is off are never back-processed on
        // re-enable (the sweep's no-backfill invariant).
        try {
          await reanchorProvenanceRecheckWatermark({
            db: opts.db,
            writeGate: opts.writeGate,
            clock,
          });
        } catch (err) {
          log.warn(
            `provenance-recheck watermark re-anchor failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return { kind: "done", value: { idle: true } };
      }
      try {
        const result = await runWithPriority("background", () =>
          runProvenanceRecheckSweepPass({
            db: opts.db,
            writeGate: opts.writeGate,
            clock,
            log,
            ...(opts.idGen ? { idGen: opts.idGen } : {}),
          }),
        );
        return { kind: "done", value: { idle: !result.fired } };
      } catch (err) {
        log.warn(
          `provenance-recheck sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  const mergeAdjudicationTask: PeriodicTask<unknown, IdleResult> = {
    name: "cognition.mergeAdjudication",
    runner: "main",
    priority: "background",
    periodMs: intervalMs,
    idlePeriodMs: idleMs,
    startDelayMs,
    latencyBudgetMs: 30_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      if (!opts.isEnabled() || !(opts.getMergeAdjudicationEnabled?.() ?? false)) {
        return { kind: "done", value: { idle: true } };
      }
      try {
        const result = await runWithPriority("background", () =>
          runMergeAdjudicationEnqueuePass({
            db: opts.db,
            writeGate: opts.writeGate,
            clock,
            log,
            ...(opts.idGen ? { idGen: opts.idGen } : {}),
          }),
        );
        return { kind: "done", value: { idle: result.fired === 0 } };
      } catch (err) {
        log.warn(
          `merge-adjudication rhythm failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: "done", value: { idle: false } };
      }
    },
  };

  const tasks = [
    dailyTask,
    digestTask,
    decayTask,
    snoozeResurfaceTask,
    synthesisTask,
    collisionTask,
    sweepTask,
    mergeAdjudicationTask,
    bootstrapTask,
    reverificationTask,
    provenanceRecheckTask,
  ];
  const jobs: BackgroundJob[] = [
    periodicJob(dailyTask, {
      scheduler,
      displayName: "Cognition Steward daily rhythm",
      description:
        "Enqueues the once-per-day Cognition Steward runs at the configured hour: one batch review per source that produced high-throughput structured data during the previous day.",
      category: "briefs",
      tracker: new StatelessTracker(),
      isDisabled: () => !opts.isEnabled(),
    }),
    periodicJob(decayTask, {
      scheduler,
      displayName: "Cognition Steward decay sweep",
      description:
        "Schedules status-check runs on stale open loops with exponential back-off, so the agent revisits, demotes, and eventually deletes loops no new data has touched.",
      category: "briefs",
      tracker: new StatelessTracker(),
      isDisabled: () => !opts.isEnabled(),
    }),
    periodicJob(snoozeResurfaceTask, {
      scheduler,
      displayName: "Cognition Steward snooze resurface",
      description:
        "Returns snoozed briefs to the feed when their user-picked re-surface time arrives — durable even if the async feedback run never runs.",
      category: "briefs",
      tracker: new StatelessTracker(),
      isDisabled: () => !opts.isEnabled(),
    }),
    periodicJob(digestTask, {
      scheduler,
      displayName: "Cognition Steward morning digest",
      description:
        "Composes the once-a-morning digest brief after the overnight batches settle (readiness barrier + grace deadline). Off unless brain.digest.enabled.",
      category: "briefs",
      tracker: new StatelessTracker(),
      isDisabled: () => !opts.isEnabled() || !(opts.getDigestEnabled?.() ?? false),
    }),
    periodicJob(synthesisTask, {
      scheduler,
      displayName: "Cognition Steward synthesis (Noticing)",
      description:
        "Fires the periodic generative 'Noticing' pass — ranges over the whole corpus to originate a non-obligation connection, trend, or gap. Off unless brain.synthesis.enabled.",
      category: "briefs",
      tracker: new StatelessTracker(),
      isDisabled: () => !opts.isEnabled() || !(opts.getSynthesisEnabled?.() ?? false),
    }),
    periodicJob(collisionTask, {
      scheduler,
      displayName: "Cognition Steward collision sweep",
      description:
        "Finds distinct loops sharing a person, document, or deadline day — and live annotations disagreeing on one subject + claim type — and seeds synthesis runs to judge them. Off unless brain.collision.enabled or brain.collision.annotationContradictions.enabled.",
      category: "briefs",
      tracker: new StatelessTracker(),
      isDisabled: () =>
        !opts.isEnabled() ||
        !(
          (opts.getCollisionEnabled?.() ?? false) ||
          (opts.getAnnotationContradictionsEnabled?.() ?? false)
        ),
    }),
    periodicJob(sweepTask, {
      scheduler,
      displayName: "Cognition Steward scheduled sweeps",
      description:
        "Fires the built-in prompt-steered sweep themes (finances, waiting-on-others, relationships, health, horizon, subscriptions) on their cadences. Off unless brain.sweepsEnabled.",
      category: "briefs",
      tracker: new StatelessTracker(),
      isDisabled: () => !opts.isEnabled() || !(opts.getSweepsEnabled?.() ?? false),
    }),
    periodicJob(mergeAdjudicationTask, {
      scheduler,
      displayName: "Cognition Steward merge adjudication",
      description:
        "Enqueues a merge_adjudication run for each pending person-merge candidate the deterministic auto-approve tier left undecided — the background agent then records merge / distinct / unsure with a user-visible reason. Self-touching candidates are never enqueued. Off unless brain.mergeAdjudication.enabled.",
      category: "briefs",
      tracker: new StatelessTracker(),
      isDisabled: () => !opts.isEnabled() || !(opts.getMergeAdjudicationEnabled?.() ?? false),
    }),
    periodicJob(bootstrapTask, {
      scheduler,
      displayName: "Cognition Steward bootstrap",
      description:
        "Retrospective lane: reviews PAST documents that still carry a future-dated semantic time (recent→oldest), seeding temporal annotations and open loops from history. Goes quiet when nothing is left and reopens when a source is added or a new day begins. Lowest queue priority; off unless brain.bootstrap.enabled.",
      category: "briefs",
      tracker: bootstrapTracker,
      isDisabled: () => !opts.isEnabled() || !(opts.getBootstrapSettings?.().enabled ?? false),
    }),
    periodicJob(reverificationTask, {
      scheduler,
      displayName: "Cognition Steward re-verification sweep",
      description:
        "Once a day, enqueues verification runs that re-ground the stalest live annotations against their cited evidence (self-person facts first) — re-affirming, weakening, superseding, or retracting each. Off unless brain.reverification.enabled and the annotations layer it re-grounds (brain.annotations.enabled).",
      category: "briefs",
      tracker: new StatelessTracker(),
      isDisabled: () => !opts.isEnabled() || !(opts.getReverificationSettings?.().enabled ?? false),
    }),
    periodicJob(provenanceRecheckTask, {
      scheduler,
      displayName: "Cognition Steward provenance recheck",
      description:
        "When an annotation prior is invalidated or superseded, enqueues a re-examination of each brief/loop that was built on it (one folded run per dependent). Kept to a small per-pass budget because the rechecks execute strictly serialized in the run drainer; the budget is a soft cap — dependents of priors that died at the same instant always enqueue together, overshooting by at most that one group. Off unless brain.provenanceRecheck.enabled and the annotations layer (brain.annotations.enabled).",
      category: "briefs",
      tracker: new StatelessTracker(),
      isDisabled: () =>
        !opts.isEnabled() || !(opts.getProvenanceRecheckSettings?.().enabled ?? false),
    }),
  ];

  return { tasks, jobs };
}
