// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * MainTaskRunner — runs Tasks in-process on the main thread.
 *
 * Used for:
 *   - Pure-JS tasks that don't touch the DB (e.g. metrics heartbeat).
 *   - Coalescer flushes that aggregate state and then enqueue a writer
 *     task (e.g. `auth.flushTokenUsage` reads a Map and ships a batch
 *     to the writer).
 *   - Any "hosted" task we want to track via the Scheduler's metrics
 *     surface but that doesn't need its own worker.
 *
 * Concurrency: configurable, default 16. Multiple async tasks can be
 * in flight simultaneously — the Scheduler dispatches up to
 * `concurrency` in parallel. Per-task work is just JS event-loop work,
 * so concurrency overhead is microseconds.
 *
 * No preempt support: main-thread tasks shouldn't be doing work long
 * enough to need cooperative yielding. If you find yourself wanting
 * `signalPreempt()` on the main runner, that's a sign the work belongs
 * on a worker (writer or compute) instead.
 *
 * Disposal: tracks every in-flight `exec()` Promise in a Set and
 * `Promise.allSettled`s them on dispose, with a wallclock cap so a
 * hung task can't stall shutdown. Tasks that respect `ctx.signal`
 * (aborted by Scheduler.dispose before runner.dispose runs) short-
 * circuit cleanly; the rest hit the cap and the runner returns anyway.
 */

import type { TaskRunner } from "../runner.js";
import type { Task, TaskContext, TaskOutcome } from "../types.js";

export interface MainTaskRunnerOptions {
  /** Max parallel main-thread tasks. Default 16. */
  concurrency?: number;
  /**
   * Wallclock cap for awaiting in-flight tasks at dispose. Default 5_000ms.
   * Mirrors the WriterTaskRunner / IndexerWorkerProxy fallbacks.
   */
  disposeTimeoutMs?: number;
}

export class MainTaskRunner implements TaskRunner {
  public readonly kind = "main" as const;
  public readonly concurrency: number;
  private readonly disposeTimeoutMs: number;
  private inflight = new Set<Promise<unknown>>();

  constructor(opts: MainTaskRunnerOptions = {}) {
    this.concurrency = opts.concurrency ?? 16;
    this.disposeTimeoutMs = opts.disposeTimeoutMs ?? 5_000;
  }

  async exec<TArgs, TResult>(
    task: Task<TArgs, TResult>,
    args: TArgs,
    ctx: TaskContext,
  ): Promise<TaskOutcome<TArgs, TResult>> {
    const p = task.run(args, ctx);
    this.inflight.add(p);
    try {
      return await p;
    } finally {
      this.inflight.delete(p);
    }
  }

  async start(): Promise<void> {
    /* nothing to bring up */
  }

  async dispose(): Promise<void> {
    if (this.inflight.size === 0) return;
    const drain = Promise.allSettled(Array.from(this.inflight));
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.disposeTimeoutMs);
      t.unref?.();
    });
    await Promise.race([drain, timeout]);
  }
}
