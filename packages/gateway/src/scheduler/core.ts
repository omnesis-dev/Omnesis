// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `SchedulerCore` — per-(runner, priority) FIFO queues, dispatch hot
 * path, anti-starvation override, coalesce, preempt signaling, and the
 * `enqueue()` entrypoint. The lifecycle (`start`/`dispose`) of every
 * registered runner is owned here; the periodic and wakeable
 * registries each take a `SchedulerCore` reference and route their
 * ticks back through `enqueue()`.
 *
 * Pulled out of the original 878-line `Scheduler` class.
 * Public method signatures are preserved verbatim so the façade in
 * `scheduler.ts` is a thin pass-through.
 */

import { createLogger } from "@omnesis/core";
import { getActivePriority, runWithPriority } from "../priority.js";
import { getRequestTiming, recordWriterCall, type RequestTiming } from "../request-timing.js";
import { getDispatchingTask, runAsTask } from "./running-task.js";
import { PreemptBuffer } from "./preempt.js";
import { SchedulerQueueFullError, TaskExecutionError } from "./types.js";
import {
  DEFAULT_LATENCY_BUDGET_MS,
  DEFAULT_QUEUE_CAP,
  DEFAULT_RESERVED_USER_SLOTS,
  PRIORITIES,
  STARVATION_BUDGET_MS,
  STARVATION_MIN_INTERVAL_MS,
  outcomeKind,
  priorityRank,
  type PendingTask,
  type RunnerState,
} from "./internals.js";
import type { TaskRunner } from "./runner.js";
import type { Priority, RunnerKind, Task, TaskContext, TaskOutcome } from "./types.js";
import type { TaskExecOutcome } from "./metrics.js";

const log = createLogger("gateway:scheduler");

export interface SchedulerCoreOptions {
  capsByRunner: Partial<Record<RunnerKind, Record<Priority, number>>>;
  enablePreemption: boolean;
  /**
   * Slots to keep free of background work per runner, so an interactive
   * (user/realtime) task never waits behind in-flight background. Merged with
   * {@link DEFAULT_RESERVED_USER_SLOTS} and clamped to `[0, concurrency − 1]`
   * at registration. Omitted / 0 for a runner leaves its dispatch unchanged.
   */
  reservedUserSlotsByRunner?: Partial<Record<RunnerKind, number>>;
}

/**
 * Callback invoked by the core after every task completion so the
 * façade's metrics collector can record the sample. The callback
 * receives the task name, latency budget, queue + exec timings,
 * resolved priority, and the outcome kind. Decoupled from the
 * `MetricsCollector` import so `core.ts` doesn't know about the
 * collector's storage shape.
 */
export type RecordSampleFn = (
  taskName: string,
  taskBudgetMs: number | undefined,
  runner: RunnerKind,
  queueMs: number,
  execMs: number,
  priority: Priority,
  outcome: TaskExecOutcome,
  cpuUserUs?: number,
  cpuSystemUs?: number,
  /** The task this one was dispatched from, if any. */
  dispatchedBy?: string | null,
) => void;

export class SchedulerCore {
  readonly runners = new Map<RunnerKind, RunnerState>();
  private nextTaskId = 1;
  disposed = false;
  private started = false;

  /**
   * When true, `popNext` refuses to dispatch background-priority tasks.
   * User + realtime priorities continue to dispatch normally so live
   * traffic (HTTP requests, collector ingestion, etc.) isn't impacted.
   * Used by the benchmark workflow via `POST /admin/background/pause`
   * to remove backfill churn from search-latency measurements.
   *
   * Tasks enqueued while paused still queue up; they drain when
   * `resumeBackground()` flips the flag back.
   */
  private backgroundPaused = false;

  /**
   * Soft admission pause: engaged (refcounted) while ≥1 user-priority
   * request is in flight, via {@link AdmissionController}. Unlike
   * {@link backgroundPaused}, this does NOT disable anti-starvation — aged
   * background tasks still drain at the starvation floor, so continuous user
   * traffic can defer but never permanently starve background work.
   */
  private admissionPaused = false;

  /** DEBUG: how many times maybePreempt fired requestYield. */
  preemptRequestCount = 0;

  /** How many times an aged background task was released while a soft
   *  admission pause was active — lets QA verify the starvation floor is
   *  actually firing under sustained user presence, not just assumed. */
  starvationReleasesWhilePaused = 0;

  /** How many times the anti-starvation floor released an aged background
   *  task, for any reason (queued higher-priority work or the soft pause). A
   *  general counter; {@link starvationReleasesWhilePaused} counts only the
   *  soft-paused subset. */
  starvationReleases = 0;

  constructor(
    private readonly opts: SchedulerCoreOptions,
    private readonly recordSample: RecordSampleFn,
  ) {}

  registerRunner(runner: TaskRunner): void {
    if (this.runners.has(runner.kind)) {
      throw new Error(`runner already registered: ${runner.kind}`);
    }
    const cap = {
      ...DEFAULT_QUEUE_CAP,
      ...(this.opts.capsByRunner[runner.kind] ?? {}),
    };
    const preempt =
      this.opts.enablePreemption && runner.concurrency === 1 && runner.signalPreempt
        ? new PreemptBuffer()
        : null;
    // Share the underlying SharedArrayBuffer with the runner so the
    // runner can forward it to its worker. Scheduler-side
    // `requestYield()` writes to the same memory; the worker's
    // PreemptToken sees the flip atomically. Without this the
    // Scheduler's flag is invisible to the worker.
    if (preempt && runner.attachPreemptBuffer) {
      runner.attachPreemptBuffer(preempt.share());
    }
    const reservedRaw =
      this.opts.reservedUserSlotsByRunner?.[runner.kind] ??
      DEFAULT_RESERVED_USER_SLOTS[runner.kind] ??
      0;
    // Never reserve so many slots that background can't run at all outside the
    // starvation floor: keep at least one slot reachable by background.
    const reservedUserSlots = Math.min(
      Math.max(0, reservedRaw),
      Math.max(0, runner.concurrency - 1),
    );
    this.runners.set(runner.kind, {
      runner,
      queues: { user: [], realtime: [], background: [] },
      inflight: new Map(),
      cap,
      lastStarvationDispatchMs: 0,
      preempt,
      reservedUserSlots,
    });
  }

  /** Expose the preempt buffer for a runner (the runner itself reads it via PreemptToken). */
  getPreemptBuffer(kind: RunnerKind): PreemptBuffer | null {
    return this.runners.get(kind)?.preempt ?? null;
  }

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const state of this.runners.values()) {
      await state.runner.start();
    }
  }

  /**
   * Tear down every registered runner. Periodics and wakeables stop
   * themselves before this runs (the façade calls them first). All
   * pending + in-flight tasks are rejected; abort controllers fire so
   * anything wired to `ctx.signal` sees the shutdown.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.runners.values()) {
      for (const prio of PRIORITIES) {
        for (const p of state.queues[prio]) {
          p.reject(new Error("scheduler disposed"));
        }
        state.queues[prio].length = 0;
      }
      // Abort in-flight tasks' AbortControllers so anything wired to
      // `ctx.signal` (HTTP fetch, abortable IO) sees the shutdown.
      // The runner.dispose() path then drains worker-backed runners;
      // MainTaskRunner awaits its in-flight Set.
      for (const p of state.inflight.values()) {
        p.abortController?.abort(new Error("scheduler disposed"));
      }
      await state.runner.dispose();
    }
  }

  /**
   * Enqueue a task instance. Returns a Promise that resolves with the
   * final outcome's value (continuations are transparent; only a
   * `{kind: "done"}` resolves it).
   */
  enqueue<TArgs, TResult>(
    task: Task<TArgs, TResult>,
    args: TArgs,
    options: { priority?: Priority } = {},
  ): Promise<TResult> {
    if (this.disposed) {
      return Promise.reject(new Error("scheduler disposed"));
    }
    const state = this.runners.get(task.runner);
    if (!state) {
      return Promise.reject(new Error(`no runner registered for kind=${task.runner}`));
    }
    // Effective priority: explicit override > ALS (if runWithPriority is
    // active) > task default. A bare "realtime" fallback would hide the
    // task default, so we read getActivePriority() (null when untagged).
    const prio: Priority = options.priority ?? getActivePriority() ?? task.priority;
    const queue = state.queues[prio];

    // Coalesce check (skip for continuations, which have committed state).
    if (task.coalesce && queue.length > 0) {
      const tail = queue[queue.length - 1];
      if (tail.task.name === task.name && !tail.isContinuation) {
        const merged = (task.coalesce as (p: unknown, i: unknown) => unknown | null)(
          tail.args,
          args,
        );
        if (merged !== null) {
          tail.args = merged;
          // Coalesced into the existing entry — share its Promise so the
          // caller awaits the same outcome. We deliberately do NOT
          // resolve the new caller separately; they get whatever the
          // pre-existing entry produces.
          return new Promise<TResult>((resolve, reject) => {
            // Hook our resolve/reject into the existing entry by chaining.
            const origResolve = tail.resolve;
            const origReject = tail.reject;
            tail.resolve = (v: unknown) => {
              origResolve(v);
              resolve(v as TResult);
            };
            tail.reject = (err: Error) => {
              origReject(err);
              reject(err);
            };
          });
        }
      }
    }

    // Cap check.
    const cap = state.cap[prio];
    if (queue.length >= cap) {
      return Promise.reject(
        new SchedulerQueueFullError(task.name, task.runner, prio, queue.length, cap),
      );
    }

    // Snapshot the active RequestTiming reference here. The completion
    // handler runs in a postMessage callback, outside the request's
    // AsyncLocalStorage context — capturing the reference now lets us
    // accumulate the writer-call cost into the right request afterward.
    const timing: RequestTiming | null = getRequestTiming();
    return new Promise<TResult>((resolve, reject) => {
      const pending: PendingTask = {
        id: this.nextTaskId++,
        task: task as Task<unknown, unknown>,
        args,
        priority: prio,
        enqueueMs: Date.now(),
        resolve: (v) => resolve(v as TResult),
        reject,
        isContinuation: false,
        // Captured here, not at execution: by the time this runs, the
        // dispatching task's context is long gone.
        dispatchedBy: getDispatchingTask(),
        timing,
        abortController: null,
      };
      queue.push(pending);
      this.maybePreempt(state, prio);
      this.dispatch(state);
    });
  }

  /**
   * Pop the highest-priority pending task from a runner's queue,
   * applying the anti-starvation override (background tasks aged
   * past STARVATION_BUDGET_MS jump higher-priority queues, rate-
   * limited to once per STARVATION_MIN_INTERVAL_MS).
   *
   * When `backgroundPaused` is set (via `pauseBackground()`),
   * background-priority tasks are skipped entirely. User and realtime
   * tasks still flow. Anti-starvation is also disabled so an aged
   * background task can't sneak through.
   */
  private popNext(state: RunnerState): PendingTask | null {
    const now = Date.now();
    const softPaused = this.admissionPaused;
    // Background dispatch is gated by either pause. Starvation promotion,
    // however, is disabled ONLY by the hard benchmark pause — it stays live
    // under the soft admission pause so background always makes eventual
    // progress even while a user is continuously present.
    const blocked = this.backgroundPaused || softPaused;
    if (
      !this.backgroundPaused &&
      now - state.lastStarvationDispatchMs >= STARVATION_MIN_INTERVAL_MS
    ) {
      const head = state.queues.background[0];
      if (head && now - head.enqueueMs >= STARVATION_BUDGET_MS) {
        // The floor only ensures background REACHES its allotment under
        // pressure — it never pushes background past it, so the reserved slots
        // stay strictly interactive-only (there is no preemption to evict
        // background from them, so a hard reservation is the only way to keep
        // interactive latency bounded). Both arms therefore require
        // `!reservationBlocks` — background running BELOW its allotment
        // (`concurrency − reserved`), i.e. a slot it is entitled to is being
        // held by interactive work (arm 1) or by the soft pause blocking it in
        // the loop below (arm 2). When background is AT its allotment the only
        // free slots are reserved ones; the aged head waits for a non-reserved
        // slot to free rather than borrowing a reserved one. For a runner with
        // no reservation `reservationBlocks` is always false, reducing this to
        // the original `softPaused || interactive-waiting`.
        const reservationBlocks = this.reservationBlocksNonUser(state);
        const interactiveWaiting = state.queues.user.length > 0 || state.queues.realtime.length > 0;
        if (!reservationBlocks && (interactiveWaiting || softPaused)) {
          state.queues.background.shift();
          state.lastStarvationDispatchMs = now;
          this.starvationReleases += 1;
          if (softPaused) this.starvationReleasesWhilePaused += 1;
          return head;
        }
      }
    }
    for (const prio of PRIORITIES) {
      if (blocked && prio === "background") continue;
      // Reserved-user-slot gate: hold NON-user work (background AND realtime)
      // back once the pool is running its non-user allotment
      // (concurrency − reservedUserSlots), keeping the remaining slots free for
      // user-priority reads. Realtime is gated too: it is not latency-sensitive
      // from the human's view (sync reconcile, deletion diff) yet can otherwise
      // camp the reserved slot for minutes and starve an interactive read. The
      // anti-starvation floor above is the only bypass; `reservedUserSlots === 0`
      // makes this a no-op.
      if (prio !== "user" && this.reservationBlocksNonUser(state)) continue;
      const q = state.queues[prio];
      if (q.length > 0) return q.shift()!;
    }
    return null;
  }

  /** Count of in-flight NON-user tasks (background + realtime) on a runner. */
  private nonUserInflight(state: RunnerState): number {
    let n = 0;
    for (const p of state.inflight.values()) if (p.priority !== "user") n += 1;
    return n;
  }

  /**
   * True when the reserved-user-slot gate should hold new non-user work: the
   * runner is already running its full non-user allotment
   * (`concurrency − reservedUserSlots`), so the remaining slots stay free for
   * user-priority reads. Always false when `reservedUserSlots` is 0, leaving
   * non-reserving runners' dispatch untouched.
   */
  private reservationBlocksNonUser(state: RunnerState): boolean {
    const reserved = state.reservedUserSlots;
    if (reserved <= 0) return false;
    return this.nonUserInflight(state) >= state.runner.concurrency - reserved;
  }

  /**
   * Soft admission pause: refuse to dispatch NON-starved background work
   * (starvation promotion still fires, unlike {@link pauseBackground}). Set
   * by {@link AdmissionController} while a user request is in flight so a
   * present human gets the machine; released work drains on release.
   */
  setAdmissionPaused(paused: boolean): void {
    if (this.admissionPaused === paused) return;
    this.admissionPaused = paused;
    if (!paused) this.pumpBackground();
  }

  isAdmissionPaused(): boolean {
    return this.admissionPaused;
  }

  /**
   * Give every runner a dispatch opportunity. The admission watchdog calls
   * this so the starvation floor can release an aged background task even
   * when no natural dispatch trigger (enqueue/completion) occurs — e.g. a
   * long-lived user request holding the soft pause with otherwise-idle
   * runners.
   */
  pumpBackground(): void {
    if (this.disposed) return;
    for (const state of this.runners.values()) this.dispatch(state);
  }

  /**
   * Pause dispatch of background-priority tasks. User + realtime
   * continue to dispatch. Used by the benchmark workflow to take
   * search-latency measurements without backfill churn affecting the
   * OS page cache or the writer queue.
   *
   * Tasks enqueued during the pause stay in their queues; they drain
   * when `resumeBackground()` is called. After a long pause the
   * background queue may exceed its cap and start rejecting new
   * enqueues with `SchedulerQueueFullError` — that's the operator's
   * signal to resume.
   */
  pauseBackground(): void {
    this.backgroundPaused = true;
  }

  resumeBackground(): void {
    if (!this.backgroundPaused) return;
    this.backgroundPaused = false;
    // Kick-start dispatch on every runner so any background tasks
    // that piled up during the pause have a chance to run without
    // waiting for the next enqueue or tick.
    for (const state of this.runners.values()) {
      this.dispatch(state);
    }
  }

  isBackgroundPaused(): boolean {
    return this.backgroundPaused;
  }

  /**
   * If a freshly-enqueued task strictly outranks any task in flight on
   * the same runner, request a yield from the runner.
   */
  private maybePreempt(state: RunnerState, newPriority: Priority): void {
    if (!state.preempt || state.inflight.size === 0) return;
    let lowest: Priority = "user";
    for (const inflight of state.inflight.values()) {
      if (priorityRank(inflight.priority) > priorityRank(lowest)) {
        lowest = inflight.priority;
      }
    }
    if (priorityRank(newPriority) < priorityRank(lowest)) {
      state.preempt.requestYield();
      state.runner.signalPreempt?.();
      // DEBUG: count preempt requests so we can correlate with worker yields
      log.debug(`preempt ${state.runner.kind}: new=${newPriority} > inflight=${lowest}`);
      this.preemptRequestCount += 1;
    }
  }

  private dispatch(state: RunnerState): void {
    while (state.inflight.size < state.runner.concurrency) {
      const next = this.popNext(state);
      if (!next) return;
      state.inflight.set(next.id, next);
      // Reset preempt flag at the start of a fresh task — the
      // previous task's yield (if any) is now consumed.
      if (state.inflight.size === 1) state.preempt?.reset();
      this.execOne(state, next);
    }
  }

  private execOne(state: RunnerState, pending: PendingTask): void {
    const startMs = Date.now();
    const queueMs = startMs - pending.enqueueMs;
    const budget = pending.task.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS;
    const ctx = this.makeContext(state, pending, startMs, budget);

    // Run the task inside its own resolved priority. Everything the task
    // dispatches while it runs — nested io, cpu and writer calls that carry
    // no explicit priority of their own — then reads that, instead of
    // whichever caller's context happened to be active when this dispatch
    // was triggered. Without it a background sweep's children can execute
    // as user work and take the io slot reserved for interactive reads.
    Promise.resolve(
      runWithPriority(pending.priority, () =>
        runAsTask(pending.task.name, () => state.runner.exec(pending.task, pending.args, ctx)),
      ),
    )
      .then((outcome: TaskOutcome<unknown, unknown>) => {
        const execMs = Date.now() - startMs;
        this.recordSample(
          pending.task.name,
          pending.task.latencyBudgetMs,
          pending.task.runner,
          queueMs,
          execMs,
          pending.priority,
          outcomeKind(outcome),
          outcome.cpuUserUs,
          outcome.cpuSystemUs,
          pending.dispatchedBy,
        );
        // Drop the controller reference now that exec has settled; a
        // continuation gets a fresh AbortController on its next execOne.
        pending.abortController = null;
        // Accumulate writer wq/wx into the originating request's
        // RequestTiming so /admin/metrics + slow-request log keep
        // working when consumers move off the legacy proxy. Only
        // "writer" runner ops contribute (matching the existing
        // semantics of writerQueueMs/writerExecMs).
        if (pending.task.runner === "writer") {
          recordWriterCall(pending.timing, queueMs, execMs);
        }
        if (outcome.kind === "yield") {
          // Re-enqueue at the back of the same priority lane.
          const cont: PendingTask = {
            ...pending,
            args: outcome.resume,
            enqueueMs: Date.now(),
            isContinuation: true,
          };
          state.queues[pending.priority].push(cont);
        } else {
          pending.resolve(outcome.value);
        }
      })
      .catch((err: unknown) => {
        const execMs = Date.now() - startMs;
        this.recordSample(
          pending.task.name,
          pending.task.latencyBudgetMs,
          pending.task.runner,
          queueMs,
          execMs,
          pending.priority,
          "error",
          undefined,
          undefined,
          pending.dispatchedBy,
        );
        pending.abortController = null;
        if (pending.task.runner === "writer") {
          recordWriterCall(pending.timing, queueMs, execMs);
        }
        const wrapped =
          err instanceof TaskExecutionError ? err : new TaskExecutionError(pending.task.name, err);
        pending.reject(wrapped);
      })
      .finally(() => {
        state.inflight.delete(pending.id);
        // After every completion, clear preempt flag — the next task
        // starts fresh. (For concurrency > 1 runners this is a no-op
        // because preempt is null.)
        state.preempt?.reset();
        if (!this.disposed) this.dispatch(state);
      });
  }

  private makeContext(
    state: RunnerState,
    pending: PendingTask,
    startMs: number,
    budgetMs: number,
  ): TaskContext {
    const ac = new AbortController();
    // If dispose() already started while this task was being prepped
    // (rare but possible since enqueue + dispose are independent
    // entrypoints), honour the shutdown immediately.
    if (this.disposed) ac.abort(new Error("scheduler disposed"));
    pending.abortController = ac;
    const taskLog = log.child(pending.task.name);
    const preempt = state.preempt;
    return {
      shouldYield(): boolean {
        if (preempt?.isRequested()) return true;
        return Date.now() - startMs > budgetMs;
      },
      elapsedMs(): number {
        return Date.now() - startMs;
      },
      signal: ac.signal,
      log: taskLog,
    };
  }
}
