// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scheduler core types.
 *
 * These define the shape of "an IO task that needs to be done" in the
 * gateway. The Scheduler (scheduler.ts) routes Tasks to TaskRunners
 * (runner.ts), owning priority queues, anti-starvation, preemption,
 * continuation re-enqueue, coalescing, periodic ticks, and wake
 * signals.
 *
 * No runtime exported from this file — types only. The Scheduler and
 * runners pick these up.
 */

import type { Logger } from "@omnesis/core";
import type { Priority } from "../priority.js";

export type { Priority };

/**
 * Where a task executes. The Scheduler maintains an independent queue
 * per (runner, priority); runners are isolated from each other.
 *
 *  - "writer"  — the single-writer SQLite thread (one in-flight at a time).
 *  - "io"      — read-only SQL worker pool (multiple in-flight).
 *  - "main"    — in-process JS, multiple concurrent tasks allowed.
 *  - "indexer" — the indexer worker thread (one in-flight at a time).
 *  - "cpu"     — pure-compute worker pool, no DB handle (multiple in-flight).
 */
export type RunnerKind = "writer" | "io" | "main" | "indexer" | "cpu";

/**
 * The outcome of one task execution.
 *
 *   { kind: "done",  value }      → resolves Scheduler.enqueue() with `value`.
 *   { kind: "yield", resume }     → re-enqueue at the same priority with `resume`
 *                                   as the new args. The original enqueue Promise
 *                                   stays unresolved — only a final "done" wins.
 */
export type TaskOutcome<TArgs, TResult> =
  | { kind: "done"; value: TResult; cpuUserUs?: number; cpuSystemUs?: number }
  | { kind: "yield"; resume: TArgs; cpuUserUs?: number; cpuSystemUs?: number };

/**
 * Per-execution context passed to a Task's run() function.
 *
 * `shouldYield()` is the cooperative-preemption primitive: it polls
 * either (a) a SharedArrayBuffer atomic that the Scheduler sets when
 * a higher-priority op arrives on the same runner, or (b) a budget
 * deadline (elapsed > Task.latencyBudgetMs). Tasks should check it
 * inside loops; if true, they should commit-and-return a yield outcome.
 */
export interface TaskContext {
  /** True if the task should commit-and-yield at the next safe point. */
  shouldYield(): boolean;
  /** ms since the runner started executing this task. */
  elapsedMs(): number;
  /**
   * Aborted on `Scheduler.dispose()`. The reason passed to abort() is
   * the string `"scheduler disposed"`. Tasks that wire `ctx.signal`
   * into abortable IO (`fetch(url, { signal })`, `AbortSignal.timeout`
   * chains) get clean cancellation when shutdown begins.
   *
   * Not aborted on cooperative-yield preemption — for that, poll
   * `shouldYield()` and commit-and-return a `{kind: "yield"}` outcome
   * so the runner can re-enqueue the continuation.
   */
  signal: AbortSignal;
  log: Logger;
}

/**
 * A task definition. Stateless — args carry per-call data, ctx carries
 * per-execution scaffolding.
 *
 * Convention for task names: `<area>.<verb>` lowercase, dot-separated.
 * Examples: `db.upsertDocuments`, `links.reconcile.compute`,
 * `auth.touchTokenUsage`. Names appear in metrics, slow-op logs, and
 * wake signals — keep them stable.
 */
export interface Task<TArgs = unknown, TResult = unknown> {
  /** Stable unique name. */
  readonly name: string;
  /**
   * Default priority if no per-enqueue priority is set. Resolved at
   * enqueue time as: enqueue.priority ?? AsyncLocalStorage priority ?? task.priority.
   */
  readonly priority: Priority;
  /** Which runner executes this task. */
  readonly runner: RunnerKind;
  /**
   * Soft latency target in ms. Exec exceeding this triggers a slow-op
   * log line. Also feeds shouldYield()'s budget deadline. Default 200.
   */
  readonly latencyBudgetMs?: number;
  /**
   * Execute one instance of this task. Must be deterministic w.r.t.
   * args + DB state — the Scheduler may re-execute on yield.
   */
  run(args: TArgs, ctx: TaskContext): Promise<TaskOutcome<TArgs, TResult>>;
  /**
   * Optional: collapse two pending instances of this task into one.
   *   - `pending` is the args of the entry already queued.
   *   - `incoming` is the args of the entry about to be queued.
   * Returns merged args, or `null` to skip merging (queue both).
   *
   * Used for high-frequency low-value writes like `auth.touchTokenUsage`
   * (keep last-seen-per-token wins) and wake debouncing.
   */
  coalesce?: (pending: TArgs, incoming: TArgs) => TArgs | null;
}

/**
 * A task that runs on a fixed schedule. The Scheduler's start() loop
 * registers a timer per PeriodicTask; each tick calls
 * Scheduler.enqueue(task, currentArgs).
 *
 * `idlePeriodMs`: when a tick returns `{kind: "done", value}` whose
 * value satisfies `isIdle?.(value) === true`, the next tick fires
 * after `idlePeriodMs` instead of `periodMs`. Lets drip loops back
 * off when there's nothing to do without writing custom timer code.
 */
export interface PeriodicTask<TArgs = unknown, TResult = unknown> extends Task<TArgs, TResult> {
  readonly periodMs: number;
  readonly idlePeriodMs?: number;
  readonly startDelayMs?: number;
  readonly initialArgs: TArgs;
  /**
   * Predicate identifying "no-work" results, used to switch between
   * `periodMs` and `idlePeriodMs`. If absent, every tick uses periodMs.
   */
  readonly isIdle?: (result: TResult) => boolean;
  /**
   * A delay this tick asks for in place of the period it would otherwise
   * get, when the result itself says when the next work falls due. Returning
   * `undefined` keeps the ordinary idle/active cadence.
   */
  readonly nextDelayMs?: (result: TResult) => number | undefined;
}

/**
 * A task that runs in response to a `wake()` signal, debounced and
 * coalesced. Replaces hand-rolled wake/debounce logic (e.g. indexer's
 * POST-/documents trigger).
 *
 * `coalesceTrailingWake`: if true (default), a wake arriving while a
 * tick is already in flight queues exactly one trailing tick. If
 * false, wakes during in-flight are dropped.
 */
export interface WakeableTask<TArgs = unknown, TResult = unknown> extends Task<TArgs, TResult> {
  readonly debounceMs: number;
  readonly coalesceTrailingWake?: boolean;
  readonly initialArgs: TArgs;
}

/** Thrown by Scheduler.enqueue when the per-priority queue cap is exceeded. */
export class SchedulerQueueFullError extends Error {
  public readonly taskName: string;
  public readonly runner: RunnerKind;
  public readonly priority: Priority;
  public readonly depth: number;
  public readonly cap: number;
  constructor(
    taskName: string,
    runner: RunnerKind,
    priority: Priority,
    depth: number,
    cap: number,
  ) {
    super(
      `scheduler queue full: task="${taskName}" runner=${runner} ` +
        `priority=${priority} depth=${depth} cap=${cap}`,
    );
    this.name = "SchedulerQueueFullError";
    this.taskName = taskName;
    this.runner = runner;
    this.priority = priority;
    this.depth = depth;
    this.cap = cap;
  }
}

/** Thrown when a task throws inside run(). Wraps the original error. */
export class TaskExecutionError extends Error {
  public readonly taskName: string;
  public override readonly cause: unknown;
  constructor(taskName: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`task "${taskName}" failed: ${causeMsg}`);
    this.name = "TaskExecutionError";
    this.taskName = taskName;
    this.cause = cause;
  }
}
