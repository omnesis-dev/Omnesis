// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SchedulerCore anti-starvation BOUNDARY tests.
 *
 * These pin the two exact inequalities in `popNext`'s anti-starvation
 * override that interior/margin fixtures leave unverified:
 *
 *   1. The aging threshold `now - head.enqueueMs >= STARVATION_BUDGET_MS`.
 *      A background task aged EXACTLY STARVATION_BUDGET_MS (not a millisecond
 *      more) must still be allowed to jump. A strict-greater (`>`) mutant
 *      would refuse the override at this exact age — these tests catch that.
 *
 *   2. The rate-limit window `now - lastStarvationDispatchMs >=
 *      STARVATION_MIN_INTERVAL_MS`. A second aged background task becoming
 *      eligible EXACTLY STARVATION_MIN_INTERVAL_MS after the previous
 *      override must be allowed to jump again. A strict-greater (`>`)
 *      mutant would make it wait one more millisecond — these tests catch
 *      that.
 *
 * Determinism: a "gated" runner keeps a single task in flight on a
 * manually-resolved deferred so the test controls exactly when the runner
 * frees up (and thus the clock value at which `popNext` re-evaluates the
 * queues). Time is driven with vitest fake timers + `setSystemTime`, which
 * mocks the `Date.now()` that `popNext` reads. No wall-clock sleeps, no
 * dispatch-ordering races.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Scheduler } from "./scheduler.js";
import { STARVATION_BUDGET_MS, STARVATION_MIN_INTERVAL_MS } from "./internals.js";
import type { TaskRunner } from "./runner.js";
import type { Priority, RunnerKind, Task, TaskContext, TaskOutcome } from "./types.js";

type ExecCall = { name: string };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drain the microtask queue without advancing the (fake) clock. Releasing
 * a gated exec kicks off a `.then → .finally → dispatch → next exec` chain
 * plus the caller's continuation — several microtask hops. Microtasks are
 * never faked by vitest's fake timers, so awaiting a fixed number of
 * resolved promises deterministically settles the whole chain.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

/**
 * Runner test double whose `exec` blocks on a per-invocation gate that the
 * test releases manually. Keeps a task "in flight" without any timer so
 * queued tasks pile up deterministically behind it, and `popNext` is
 * re-evaluated at a known clock value the moment the gate is released.
 */
class GatedRunner implements TaskRunner {
  public readonly kind: RunnerKind;
  public readonly concurrency: number;
  public execLog: ExecCall[] = [];
  private readonly gates: Array<Deferred<TaskOutcome<unknown, unknown>>> = [];

  constructor(kind: RunnerKind, concurrency = 1) {
    this.kind = kind;
    this.concurrency = concurrency;
  }

  async start(): Promise<void> {}
  async dispose(): Promise<void> {}
  signalPreempt(): void {}

  async exec<TArgs, TResult>(
    task: Task<TArgs, TResult>,
    _args: TArgs,
    _ctx: TaskContext,
  ): Promise<TaskOutcome<TArgs, TResult>> {
    this.execLog.push({ name: task.name });
    const d = defer<TaskOutcome<unknown, unknown>>();
    this.gates.push(d);
    return d.promise as Promise<TaskOutcome<TArgs, TResult>>;
  }

  /** Number of execs currently blocked on a gate (== in flight). */
  get pending(): number {
    return this.gates.length;
  }

  /** Release the oldest in-flight exec with a done outcome. */
  releaseNext(): void {
    const g = this.gates.shift();
    if (!g) throw new Error("releaseNext: no gated exec in flight");
    g.resolve({ kind: "done", value: undefined });
  }
}

function makeTask(partial: { name: string; runner: RunnerKind; priority: Priority }): Task {
  return {
    name: partial.name,
    runner: partial.runner,
    priority: partial.priority,
    latencyBudgetMs: 200,
    async run(): Promise<TaskOutcome<unknown, unknown>> {
      return { kind: "done", value: undefined };
    },
  };
}

describe("SchedulerCore — anti-starvation boundaries", () => {
  let runner: GatedRunner;
  let scheduler: Scheduler;
  // Anchor the clock well past STARVATION_MIN_INTERVAL_MS so the very
  // first dispatch isn't blocked by the rate-limit guard against the
  // initial `lastStarvationDispatchMs = 0`.
  const T0 = STARVATION_MIN_INTERVAL_MS * 100;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    runner = new GatedRunner("writer", 1);
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
    vi.useRealTimers();
  });

  // Kills gateway-scheduler-m2: `>= STARVATION_BUDGET_MS` → `> STARVATION_BUDGET_MS`.
  // A background head aged EXACTLY the budget must still jump the queued
  // user task. With strict-greater it would not, and the user task would
  // run first.
  test("a background task aged EXACTLY STARVATION_BUDGET_MS jumps the queued user task", async () => {
    const hold = makeTask({ name: "hold", runner: "writer", priority: "user" });
    const bg = makeTask({ name: "bg", runner: "writer", priority: "background" });
    const user = makeTask({ name: "user", runner: "writer", priority: "user" });

    // Occupy the runner so the rest queue.
    void scheduler.enqueue(hold, undefined).catch(() => {});
    await flushMicrotasks();
    expect(runner.pending).toBe(1);

    // Queue the background task (will age) and a user task. Both enqueue
    // at exactly T0.
    void scheduler.enqueue(bg, undefined);
    void scheduler.enqueue(user, undefined);
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold"]);

    // Advance the clock so the background task's age is EXACTLY the budget
    // (not a millisecond more). popNext will read this clock when the
    // runner frees up.
    vi.setSystemTime(T0 + STARVATION_BUDGET_MS);

    // Free the runner → dispatch re-runs popNext at the boundary clock.
    runner.releaseNext(); // hold done
    await flushMicrotasks();

    // On the correct `>=` budget guard, the exactly-aged background head
    // jumps ahead of the queued user task. A `>` mutant would not fire the
    // override here, so "user" would run before "bg".
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold", "bg"]);

    // Drain.
    runner.releaseNext(); // bg
    await flushMicrotasks();
    runner.releaseNext(); // user
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold", "bg", "user"]);
  });

  // Kills gateway-scheduler-m1: `>= STARVATION_MIN_INTERVAL_MS` →
  // `> STARVATION_MIN_INTERVAL_MS`. A second aged background task becoming
  // eligible EXACTLY STARVATION_MIN_INTERVAL_MS after the previous override
  // must jump again. With strict-greater it would wait one more millisecond
  // and the queued user task would win that dispatch.
  test("a second aged background task jumps EXACTLY one interval after the previous override", async () => {
    const hold = makeTask({ name: "hold", runner: "writer", priority: "user" });
    const bgA = makeTask({ name: "bg.a", runner: "writer", priority: "background" });
    const bgB = makeTask({ name: "bg.b", runner: "writer", priority: "background" });
    const userA = makeTask({ name: "user.a", runner: "writer", priority: "user" });
    const userB = makeTask({ name: "user.b", runner: "writer", priority: "user" });

    void scheduler.enqueue(hold, undefined).catch(() => {});
    await flushMicrotasks();
    expect(runner.pending).toBe(1);

    // Both background tasks (and both user tasks) enqueue at T0.
    void scheduler.enqueue(bgA, undefined);
    void scheduler.enqueue(bgB, undefined);
    void scheduler.enqueue(userA, undefined);
    void scheduler.enqueue(userB, undefined);
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold"]);

    // Age both background tasks comfortably past the budget. The first
    // override fires here and stamps lastStarvationDispatchMs = T1.
    const T1 = T0 + STARVATION_BUDGET_MS + 5;
    vi.setSystemTime(T1);
    runner.releaseNext(); // hold done → bg.a jumps (first override)
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold", "bg.a"]);

    // Advance to EXACTLY one rate-limit interval after the first override.
    // bg.b is still aged past the budget, so only the rate-limit window
    // gates the second override.
    vi.setSystemTime(T1 + STARVATION_MIN_INTERVAL_MS);
    runner.releaseNext(); // bg.a done → popNext at the boundary clock
    await flushMicrotasks();

    // On the correct `>=` rate-limit guard, the window has elapsed exactly,
    // so the second aged background task jumps again. A `>` mutant would
    // require one more millisecond, so "user.a" would win this dispatch.
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold", "bg.a", "bg.b"]);

    // Drain.
    runner.releaseNext(); // bg.b
    await flushMicrotasks();
    runner.releaseNext(); // user.a
    await flushMicrotasks();
    runner.releaseNext(); // user.b
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold", "bg.a", "bg.b", "user.a", "user.b"]);
  });
});
