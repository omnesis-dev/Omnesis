// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Adapter that exposes a Scheduler-backed PeriodicTask or WakeableTask
 * as a `BackgroundJob`.
 *
 * The Scheduler already tracks per-task execution metrics (sample ring,
 * outcomes, latencies). This adapter:
 *   1. reads the Scheduler's latest stats for the task,
 *   2. combines them with the task-owned `ProgressTracker`,
 *   3. derives a high-level `state` (running / idle / erroring / unknown).
 *
 * Lives outside the Scheduler module so the Scheduler stays unaware of
 * the BackgroundJob abstraction — clean dependency direction
 * (background-jobs → scheduler, never the other way).
 */

import type { Scheduler } from "../scheduler/scheduler.js";
import type { PeriodicTask, WakeableTask } from "../scheduler/types.js";
import type {
  BackgroundJob,
  JobCadence,
  JobCategory,
  JobObservation,
  JobState,
  ProgressTracker,
} from "./types.js";

export interface SchedulerBackedJobOpts {
  scheduler: Scheduler;
  /** Display metadata. */
  displayName: string;
  description: string;
  category: JobCategory;
  /**
   * Pre-instantiated tracker for the task's progress. Updated by the
   * task body during run(); read by `observe()` from the registry.
   */
  tracker: ProgressTracker;
  /**
   * Window over which to compute ticksLastHour / avgTickMs / p99TickMs
   * via `Scheduler.snapshot(window)`. Default 3600 (1 hour).
   */
  windowSeconds?: number;
  /**
   * Optional override for the cadence shape. If absent, derived from
   * the task's periodMs / idlePeriodMs (PeriodicTask) or debounceMs
   * (WakeableTask).
   */
  cadence?: JobCadence;
  /**
   * Predicate that returns true when the job is administratively
   * disabled (e.g. config flag). Drives the "disabled" state in the UI.
   * If absent, the job is never marked disabled.
   */
  isDisabled?: () => boolean;
}

/**
 * Wrap a PeriodicTask as a BackgroundJob.
 *
 * Generic over TArgs/TResult so callers don't have to widen their
 * concrete `PeriodicTask<…, IdleResult>` to `PeriodicTask<unknown,
 * unknown>` first — TypeScript's variance rules block that widen
 * because PeriodicTask.isIdle is contravariant on TResult.
 */
export function periodicJob<TArgs, TResult>(
  task: PeriodicTask<TArgs, TResult>,
  opts: SchedulerBackedJobOpts,
): BackgroundJob {
  const cadence: JobCadence = opts.cadence ?? deriveCadenceFromPeriodic(task);
  return makeJob(task.name, task, cadence, opts);
}

/**
 * Wrap a WakeableTask as a BackgroundJob. Generic for the same reason
 * as `periodicJob` — see its docstring.
 */
export function wakeableJob<TArgs, TResult>(
  task: WakeableTask<TArgs, TResult>,
  opts: SchedulerBackedJobOpts,
): BackgroundJob {
  const cadence: JobCadence = opts.cadence ?? { mode: "wake-driven", debounceMs: task.debounceMs };
  return makeJob(task.name, task, cadence, opts);
}

function deriveCadenceFromPeriodic<TArgs, TResult>(task: PeriodicTask<TArgs, TResult>): JobCadence {
  if (task.idlePeriodMs && task.idlePeriodMs !== task.periodMs) {
    return {
      mode: "drip",
      activeMs: task.periodMs,
      idleMs: task.idlePeriodMs,
      startDelayMs: task.startDelayMs,
    };
  }
  return { mode: "periodic", intervalMs: task.periodMs, startDelayMs: task.startDelayMs };
}

interface PeriodicLikeTask {
  readonly name: string;
  readonly periodMs?: number;
  readonly idlePeriodMs?: number;
  readonly debounceMs?: number;
}

function makeJob(
  id: string,
  task: PeriodicLikeTask,
  cadence: JobCadence,
  opts: SchedulerBackedJobOpts,
): BackgroundJob {
  const windowSeconds = opts.windowSeconds ?? 3600;
  return {
    id,
    displayName: opts.displayName,
    description: opts.description,
    category: opts.category,
    cadence,
    observe(): JobObservation {
      const snap = opts.scheduler.snapshot(windowSeconds);
      const stats = snap.perTask.find((t) => t.name === id);
      const tickCount = stats?.count ?? 0;
      const errorCount = stats?.errorCount ?? 0;
      const avgTickMs =
        tickCount > 0 ? Math.round((stats!.totalExecMs / tickCount) * 100) / 100 : 0;
      const p99TickMs = stats?.p99 ?? 0;

      const isDisabled = opts.isDisabled?.() ?? false;
      const state = deriveState({
        isDisabled,
        tickCount,
        errorCount,
        cadence,
      });
      const lastTick = opts.scheduler.getLastTickInfo(id);
      return {
        state,
        // Scheduler doesn't currently expose per-task in-flight; we
        // can't tell apart "running right now" from "ran 100ms ago".
        // Phase 4 (worker mid-cycle progress) will fix this; for now,
        // leave false and rely on `state` to convey activity.
        inFlight: false,
        lastTickAt: lastTick?.ts,
        lastTickElapsedMs: lastTick?.execMs,
        lastError:
          errorCount > 0
            ? {
                // Scheduler doesn't capture error messages in the
                // sample buffer (just outcome="error"). We can convey
                // "X errors in window" but not the message text. UI
                // links to log search for the actual message.
                message: `${errorCount} error${errorCount === 1 ? "" : "s"} in last ${Math.round(windowSeconds / 60)}m — see logs`,
                at: Date.now(),
              }
            : undefined,
        ticksLastHour: tickCount,
        avgTickMs,
        p99TickMs,
        progress: opts.tracker.observe(),
      };
    },
  };
}

interface DeriveStateOpts {
  isDisabled: boolean;
  tickCount: number;
  errorCount: number;
  cadence: JobCadence;
}

function deriveState(opts: DeriveStateOpts): JobState {
  if (opts.isDisabled) return "disabled";
  // Erroring: more than 25% of recent ticks failed (and at least one).
  if (opts.errorCount > 0 && opts.errorCount * 4 >= opts.tickCount) {
    return "erroring";
  }
  if (opts.tickCount === 0) {
    // No ticks observed in the window. Could be: just registered, or
    // wake-driven and never woken, or genuinely idle for >1h. UI
    // renders as "unknown" — operator should check whether work
    // exists to do.
    return "unknown";
  }
  // Tick frequency check: a healthy drip / periodic should have at
  // least one tick within ~2× its idle period. If not, mark idle —
  // the loop is running but has no work.
  return classifyByCadence(opts.cadence, opts.tickCount);
}

function classifyByCadence(cadence: JobCadence, tickCount: number): JobState {
  // For wake-driven: any tick in the window means it's been used; "running" is fine.
  if (cadence.mode === "wake-driven") return "running";
  // For drip: tickCount > 0 over a 1h window. If high, running; if low, idle.
  if (cadence.mode === "drip") {
    const expectedActiveTicks = 3600 / Math.max(1, cadence.activeMs / 1000);
    return tickCount > expectedActiveTicks * 0.1 ? "running" : "idle";
  }
  // For periodic: same idea.
  if (cadence.mode === "periodic") {
    const expectedTicks = 3600 / Math.max(1, cadence.intervalMs / 1000);
    return tickCount >= expectedTicks * 0.5 ? "running" : "idle";
  }
  return "running";
}
