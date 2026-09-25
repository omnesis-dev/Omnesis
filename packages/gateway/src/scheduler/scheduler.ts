// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scheduler.
 *
 * The single brain that decides "what runs next, where, and when" in
 * the gateway. Replaces hand-rolled queueing in WriterWorkerProxy,
 * BackfillWorker drip loops, IndexerWorker wake/debounce, and the
 * server.ts touchTokenUsage coalesce.
 *
 * `Scheduler` is now a thin façade over five collaborating sub-classes
 * (split):
 *
 * - `SchedulerCore` (`core.ts`) — per-(runner, priority) FIFO queues,
 *   dispatch hot path, anti-starvation override, coalesce, preempt.
 * - `MetricsCollector` (`metrics-collector.ts`) — sliding-window
 *   per-task exec samples + SLA samples + slow-op log line + snapshot.
 * - `PeriodicScheduler` (`periodic-scheduler.ts`) — periodic-task
 *   registry + idle/active duty cycle.
 * - `WakeableScheduler` (`wakeable-scheduler.ts`) — wakeable-task
 *   registry + debounce + trailing-tick coalescing.
 * - `WriterQueueInspector` (`writer-queue-inspector.ts`) — live
 *   writer-runner queue depth introspection (`pendingCount`,
 *   `queueDepthByPriority`, `queueDepthByOp`).
 *
 * Public method signatures are unchanged from the pre-split monolith
 * so every call site (the server bootstrap, the trigger orchestrator,
 * the indexer wake hooks, the e2e tests) keeps working without churn.
 *
 * Responsibilities (and only these):
 *   - Per-(runner, priority) FIFO queues with anti-starvation.
 *   - Dispatch to the right runner, respecting per-runner concurrency.
 *   - Continuation re-enqueue on `{kind: "yield"}` outcomes.
 *   - Coalesce redundant queued tasks via `Task.coalesce`.
 *   - Periodic ticks (PeriodicTask) with idle/active duty cycle.
 *   - Wake debounce + trailing-tick coalescing (WakeableTask).
 *   - Preempt-signal the in-flight task when a higher-priority op lands.
 *   - Per-task / per-runner / SLA metrics ring buffers + snapshot.
 *   - Lifecycle: start/dispose; cancel pending on dispose.
 *
 * Not its responsibilities:
 *   - Executing tasks (runners do that).
 *   - Owning DB handles or worker threads (runners own those).
 *   - Authentication / HTTP routing.
 */

import { SchedulerCore } from "./core.js";
import { MetricsCollector, type RunnerSnapshotInput } from "./metrics-collector.js";
import { PeriodicScheduler } from "./periodic-scheduler.js";
import { WakeableScheduler } from "./wakeable-scheduler.js";
import { WriterQueueInspector } from "./writer-queue-inspector.js";
import { DEFAULT_USER_SLA_BUDGET_MS } from "./internals.js";
import {
  AdmissionController,
  DEFAULT_ADMISSION,
  type AdmissionControllerOptions,
  type AdmissionHold,
} from "./admission.js";
import type { SchedulerMetricsSnapshot } from "./metrics.js";
import type { Priority, PeriodicTask, RunnerKind, Task, WakeableTask } from "./types.js";
import type { PreemptBuffer } from "./preempt.js";
import type { TaskRunner } from "./runner.js";

export interface SchedulerOptions {
  /** Override per-priority caps for a specific runner. */
  capsByRunner?: Partial<Record<RunnerKind, Record<Priority, number>>>;
  /** ms; user-priority requests exceeding (queueMs+execMs) trigger SLA violation. */
  userSlaBudgetMs?: number;
  /**
   * If true (default), Scheduler creates a PreemptBuffer per
   * single-in-flight runner and exposes it to the runner via start().
   * Tests with deterministic ordering set this false.
   */
  enablePreemption?: boolean;
  /** Automatic admission control (defer background while a user is present). */
  admission?: Partial<AdmissionControllerOptions>;
  /**
   * Slots to keep free of background work per runner, so an interactive
   * (user/realtime) task never waits behind in-flight background. Merged with
   * the per-kind defaults and clamped to `[0, concurrency − 1]` at
   * registration; the io pool defaults to 1, others to 0.
   */
  reservedUserSlotsByRunner?: Partial<Record<RunnerKind, number>>;
}

export class Scheduler {
  private readonly core: SchedulerCore;
  private readonly metrics: MetricsCollector;
  private readonly periodic: PeriodicScheduler;
  private readonly wakeable: WakeableScheduler;
  private readonly writerInspector: WriterQueueInspector;
  private readonly admission: AdmissionController;

  constructor(options: SchedulerOptions = {}) {
    const userSlaBudgetMs = options.userSlaBudgetMs ?? DEFAULT_USER_SLA_BUDGET_MS;
    this.metrics = new MetricsCollector(userSlaBudgetMs);
    this.core = new SchedulerCore(
      {
        capsByRunner: options.capsByRunner ?? {},
        enablePreemption: options.enablePreemption ?? true,
        reservedUserSlotsByRunner: options.reservedUserSlotsByRunner ?? {},
      },
      (
        taskName,
        taskBudgetMs,
        runner,
        queueMs,
        execMs,
        priority,
        outcome,
        cpuUserUs,
        cpuSystemUs,
        dispatchedBy,
      ) =>
        this.metrics.record(
          taskName,
          taskBudgetMs,
          runner,
          queueMs,
          execMs,
          priority,
          outcome,
          cpuUserUs,
          cpuSystemUs,
          dispatchedBy,
        ),
    );
    // Periodic + wakeable schedulers route their fires back through the
    // core's `enqueue` so the same dispatch + metrics path covers them.
    const enqueue = this.core.enqueue.bind(this.core);
    this.periodic = new PeriodicScheduler(enqueue);
    this.wakeable = new WakeableScheduler(enqueue);
    this.writerInspector = new WriterQueueInspector(this.core.runners);
    this.admission = new AdmissionController(
      {
        setAdmissionPaused: (paused) => this.core.setAdmissionPaused(paused),
        pumpBackground: () => this.core.pumpBackground(),
      },
      {
        enabled: options.admission?.enabled ?? DEFAULT_ADMISSION.enabled,
        maxHoldMs: options.admission?.maxHoldMs ?? DEFAULT_ADMISSION.maxHoldMs,
        // Strictly below STARVATION_MIN_INTERVAL_MS (1_000) so a pump tick
        // can't phase-alias with the once-per-interval starvation release.
        pumpIntervalMs: options.admission?.pumpIntervalMs ?? DEFAULT_ADMISSION.pumpIntervalMs,
      },
    );
  }

  registerRunner(runner: TaskRunner): void {
    this.core.registerRunner(runner);
  }

  getPreemptBuffer(kind: RunnerKind): PreemptBuffer | null {
    return this.core.getPreemptBuffer(kind);
  }

  async start(): Promise<void> {
    await this.core.start();
    // Kick off any periodics registered before start().
    this.periodic.startAll();
  }

  async dispose(): Promise<void> {
    if (this.core.disposed) return;
    // Stop periodics + wakeables before tearing down the core so their
    // already-scheduled enqueue() calls don't race with disposal.
    this.periodic.stopAll();
    this.wakeable.stopAll();
    this.admission.dispose();
    await this.core.dispose();
  }

  enqueue<TArgs, TResult>(
    task: Task<TArgs, TResult>,
    args: TArgs,
    options: { priority?: Priority } = {},
  ): Promise<TResult> {
    return this.core.enqueue(task, args, options);
  }

  schedule<TArgs, TResult>(task: PeriodicTask<TArgs, TResult>): { stop(): void } {
    return this.periodic.schedule(task, this.core.isStarted());
  }

  registerWakeable<TArgs, TResult>(
    task: WakeableTask<TArgs, TResult>,
  ): { wake(): void; stop(): void } {
    return this.wakeable.registerWakeable(task);
  }

  wake(taskName: string): void {
    this.wakeable.wake(taskName);
  }

  /**
   * Fire a periodic task's next tick now instead of waiting out its
   * current period. Unlike `wake()` (which enqueues a separate
   * WakeableTask), this reuses the periodic's own timer chain, so the
   * task never overlaps itself; a kick landing mid-tick coalesces
   * into one trailing tick. Used to reflect user-issued mutations
   * (e.g. merge rules) without waiting out the idle backoff.
   */
  kickPeriodic(taskName: string): void {
    this.periodic.kick(taskName);
  }

  /** Await the exact periodic generation caused by this kick. */
  kickPeriodicAndWait(taskName: string, timeoutMs?: number): Promise<unknown> {
    return this.periodic.kickAndWait(taskName, timeoutMs);
  }

  /** Permanently stop periodic roots while allowing already-enqueued work to drain. */
  quiescePeriodics(): void {
    this.periodic.stopAll();
  }

  /** DEBUG: how many times maybePreempt fired requestYield. */
  get preemptRequestCount(): number {
    return this.core.preemptRequestCount;
  }

  /**
   * DEBUG: how many aged background tasks the anti-starvation floor released
   * *while the soft admission pause was engaged*. A non-zero value confirms the
   * floor keeps draining background under sustained user presence rather than
   * starving it — the safety property that distinguishes the soft admission
   * pause from the benchmark hard pause.
   */
  get starvationReleasesWhilePaused(): number {
    return this.core.starvationReleasesWhilePaused;
  }

  /**
   * DEBUG: total aged background tasks the anti-starvation floor released, for
   * any reason (queued higher-priority work or the soft pause).
   * {@link starvationReleasesWhilePaused} counts only the soft-paused subset.
   */
  get starvationReleases(): number {
    return this.core.starvationReleases;
  }

  /**
   * Pause/resume dispatch of background-priority tasks. User + realtime
   * tasks continue to flow when paused. Used by the benchmark workflow
   * (POST /admin/background/pause) to remove backfill churn from
   * search-latency measurements.
   */
  pauseBackground(): void {
    this.core.pauseBackground();
  }

  resumeBackground(): void {
    this.core.resumeBackground();
  }

  isBackgroundPaused(): boolean {
    return this.core.isBackgroundPaused();
  }

  /** Engage automatic admission control for a user-priority request.
   *  Refcounted; the returned hold must be released in a `finally`. */
  beginUserAdmission(): AdmissionHold {
    return this.admission.begin();
  }

  isAdmissionPaused(): boolean {
    return this.core.isAdmissionPaused();
  }

  admissionHolds(): number {
    return this.admission.activeHolds();
  }

  /**
   * Lightweight introspection of in-flight tasks per runner. Used by
   * slow-search logging in `searchPipeline.search()` to correlate a
   * stall with whatever background / writer work was concurrent. Does
   * not walk metrics rings — just reads the inflight Map of every
   * runner.
   */
  inflightSummary(): Array<{
    runner: RunnerKind;
    tasks: Array<{ name: string; priority: Priority; ageMs: number }>;
  }> {
    const now = Date.now();
    const out: Array<{
      runner: RunnerKind;
      tasks: Array<{ name: string; priority: Priority; ageMs: number }>;
    }> = [];
    for (const state of this.core.runners.values()) {
      const tasks: Array<{ name: string; priority: Priority; ageMs: number }> = [];
      for (const pending of state.inflight.values()) {
        tasks.push({
          name: pending.task.name,
          priority: pending.priority,
          ageMs: now - pending.enqueueMs,
        });
      }
      if (tasks.length > 0) {
        out.push({ runner: state.runner.kind, tasks });
      }
    }
    return out;
  }

  /** Build a metrics snapshot for the given window. */
  snapshot(windowSeconds: number): SchedulerMetricsSnapshot {
    const runnerInputs: RunnerSnapshotInput[] = [];
    for (const state of this.core.runners.values()) {
      runnerInputs.push({
        runner: state.runner.kind,
        queueDepthByPriority: {
          user: state.queues.user.length,
          realtime: state.queues.realtime.length,
          background: state.queues.background.length,
        },
        inFlight: state.inflight.size,
      });
    }
    return this.metrics.snapshot(
      windowSeconds,
      runnerInputs,
      (name) => this.findTaskDefinition(name),
      this.core.preemptRequestCount,
    );
  }

  /** Walk the periodic + wakeable registries to enrich a metrics row. */
  private findTaskDefinition(name: string): Task<unknown, unknown> | null {
    return this.periodic.findTaskDefinition(name) ?? this.wakeable.findTaskDefinition(name);
  }

  getLastTickInfo(name: string): { ts: number; execMs: number } | undefined {
    return this.metrics.getLastTickInfo(name);
  }

  // ── Writer-runner introspection (delegate to WriterQueueInspector) ─

  pendingCount(): number {
    return this.writerInspector.pendingCount();
  }

  queueDepthByPriority(): { user: number; realtime: number; background: number } {
    return this.writerInspector.queueDepthByPriority();
  }

  queueDepthByOp(): Array<{ op: string; count: number; priority: Priority }> {
    return this.writerInspector.queueDepthByOp();
  }
}
