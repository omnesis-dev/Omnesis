// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * TaskRunner interface.
 *
 * A runner is an environment that executes Tasks. Runners are isolated:
 * each owns its own queue of in-flight work from the Scheduler's
 * perspective. The Scheduler is the brain (priority, dispatch,
 * preemption, continuations); runners are dumb executors.
 *
 * Single-task-in-flight runners (writer, compute, indexer):
 *   - Scheduler guarantees exec() is not called again until the
 *     previous Promise settles.
 *   - signalPreempt() is a hint that a higher-priority task is waiting;
 *     the runner sets its preempt atomic so the in-flight task's
 *     ctx.shouldYield() returns true.
 *
 * Concurrent runners (main):
 *   - Scheduler may call exec() up to mainRunnerConcurrency times in
 *     parallel. Each call gets its own TaskContext.
 *   - signalPreempt() is a no-op (main-thread tasks shouldn't be doing
 *     work long enough to need preemption).
 */

import type { RunnerKind, Task, TaskContext, TaskOutcome } from "./types.js";

export interface TaskRunner {
  readonly kind: RunnerKind;

  /**
   * Maximum tasks the Scheduler may have in flight on this runner at
   * once. 1 for writer/compute/indexer; >1 for main.
   */
  readonly concurrency: number;

  /**
   * Execute a single task. Returns its outcome. Must not throw — wrap
   * caller errors as `{kind: "done"}` of an error-shaped value if the
   * task elects to handle them, or let them propagate as rejections
   * which the Scheduler converts to TaskExecutionError.
   */
  exec<TArgs, TResult>(
    task: Task<TArgs, TResult>,
    args: TArgs,
    ctx: TaskContext,
  ): Promise<TaskOutcome<TArgs, TResult>>;

  /**
   * Optional preempt hint. Default no-op. Single-in-flight runners
   * with cooperative-yield support implement this to flip the shared
   * atomic that ctx.shouldYield() polls.
   */
  signalPreempt?(): void;

  /**
   * Optional: attach a shared preempt buffer. Called by Scheduler at
   * registerRunner-time when preemption is enabled. Runners that wrap
   * a worker thread should forward this buffer to the worker via init,
   * so the worker-side handler can construct a PreemptToken view and
   * cooperatively yield.
   *
   * Without this, a Scheduler-side `requestYield()` flips a flag the
   * worker can't see — preemption becomes silent. With it, the same
   * SharedArrayBuffer instance lives in both threads.
   */
  attachPreemptBuffer?(buffer: SharedArrayBuffer): void;

  /** Called once at Scheduler.start(). Runner brings up workers, etc. */
  start(): Promise<void>;

  /** Called at Scheduler.dispose(). Runner drains in-flight + tears down. */
  dispose(): Promise<void>;
}
