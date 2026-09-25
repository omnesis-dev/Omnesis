// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scheduler unit tests against a FakeTaskRunner test double.
 *
 * The real runners (writer/compute/main/indexer) layer on top of
 * worker_threads + DB connections; testing those belongs in their own
 * integration test files. Here we verify Scheduler logic in isolation:
 * priority dispatch, anti-starvation, continuations, coalescing, wake
 * debouncing, periodic ticks, disposal.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getActivePriority, runWithPriority } from "../priority.js";
import { Scheduler } from "./scheduler.js";
import { SchedulerQueueFullError, TaskExecutionError } from "./types.js";
import type { TaskRunner } from "./runner.js";
import type {
  PeriodicTask,
  Priority,
  RunnerKind,
  Task,
  TaskContext,
  TaskOutcome,
  WakeableTask,
} from "./types.js";

type ExecCall = { name: string; args: unknown; priority: Priority };

class FakeTaskRunner implements TaskRunner {
  public readonly kind: RunnerKind;
  public readonly concurrency: number;
  public execLog: ExecCall[] = [];
  /** Per-task delay in ms; default 0 (synchronous-ish via setTimeout(0)). */
  public delays = new Map<string, number>();
  /** Per-task "force this outcome". If unset, defaults to {kind:"done", value:undefined}. */
  public outcomes = new Map<string, TaskOutcome<unknown, unknown> | "throw">();
  public preemptCalls = 0;
  public lastCtx: TaskContext | null = null;

  constructor(kind: RunnerKind, concurrency = 1) {
    this.kind = kind;
    this.concurrency = concurrency;
  }

  async start(): Promise<void> {}
  async dispose(): Promise<void> {}

  signalPreempt(): void {
    this.preemptCalls += 1;
  }

  async exec<TArgs, TResult>(
    task: Task<TArgs, TResult>,
    args: TArgs,
    ctx: TaskContext,
  ): Promise<TaskOutcome<TArgs, TResult>> {
    this.execLog.push({ name: task.name, args, priority: "background" });
    this.lastCtx = ctx;
    const delay = this.delays.get(task.name) ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const forced = this.outcomes.get(task.name);
    if (forced === "throw") throw new Error(`forced throw: ${task.name}`);
    if (forced) return forced as TaskOutcome<TArgs, TResult>;
    // Default: call task.run() so PeriodicTasks/coalesce/yield tests
    // exercise the actual task definition.
    return task.run(args, ctx);
  }
}

function makeTask<TArgs = void, TResult = void>(
  partial: Partial<Task<TArgs, TResult>> & {
    name: string;
    runner: RunnerKind;
  },
): Task<TArgs, TResult> {
  return {
    priority: partial.priority ?? "realtime",
    latencyBudgetMs: partial.latencyBudgetMs ?? 200,
    run:
      partial.run ??
      (async (): Promise<TaskOutcome<TArgs, TResult>> => ({
        kind: "done",
        value: undefined as TResult,
      })),
    coalesce: partial.coalesce,
    ...partial,
  };
}

describe("Scheduler — basic enqueue", () => {
  let runner: FakeTaskRunner;
  let scheduler: Scheduler;

  beforeEach(async () => {
    runner = new FakeTaskRunner("writer");
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
  });

  test("resolves with the task's done value", async () => {
    runner.outcomes.set("test.echo", { kind: "done", value: 42 });
    const t = makeTask<{ x: number }, number>({
      name: "test.echo",
      runner: "writer",
    });
    const result = await scheduler.enqueue(t, { x: 1 });
    expect(result).toBe(42);
    expect(runner.execLog).toHaveLength(1);
    expect(runner.execLog[0].args).toEqual({ x: 1 });
  });

  test("rejects on no runner registered", async () => {
    const t = makeTask({ name: "no.runner", runner: "indexer" });
    await expect(scheduler.enqueue(t, undefined)).rejects.toThrow("no runner registered");
  });

  test("wraps thrown errors as TaskExecutionError", async () => {
    runner.outcomes.set("test.boom", "throw");
    const t = makeTask({ name: "test.boom", runner: "writer" });
    await expect(scheduler.enqueue(t, undefined)).rejects.toThrow(TaskExecutionError);
  });
});

describe("Scheduler — priority dispatch", () => {
  let runner: FakeTaskRunner;
  let scheduler: Scheduler;

  beforeEach(async () => {
    runner = new FakeTaskRunner("writer");
    runner.delays.set("a", 10); // hold the first task long enough to queue more
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
  });

  test("user > realtime > background", async () => {
    const a = makeTask({ name: "a", runner: "writer", priority: "background" });
    const b = makeTask({ name: "b", runner: "writer", priority: "background" });
    const c = makeTask({ name: "c", runner: "writer", priority: "realtime" });
    const d = makeTask({ name: "d", runner: "writer", priority: "user" });

    // Enqueue all four — first one starts immediately and holds 10ms.
    const promises = [
      scheduler.enqueue(a, undefined),
      scheduler.enqueue(b, undefined),
      scheduler.enqueue(c, undefined),
      scheduler.enqueue(d, undefined),
    ];
    await Promise.all(promises);

    // Order: a (already in-flight) → d (user) → c (realtime) → b (background).
    expect(runner.execLog.map((e) => e.name)).toEqual(["a", "d", "c", "b"]);
  });
});

describe("Scheduler — continuations", () => {
  let runner: FakeTaskRunner;
  let scheduler: Scheduler;

  beforeEach(async () => {
    runner = new FakeTaskRunner("writer");
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
  });

  test("yield re-enqueues with new args; final done resolves the original Promise", async () => {
    let calls = 0;
    const t: Task<{ remaining: number }, string> = {
      name: "yield.test",
      runner: "writer",
      priority: "background",
      latencyBudgetMs: 200,
      async run({ remaining }): Promise<TaskOutcome<{ remaining: number }, string>> {
        calls += 1;
        if (remaining > 0) {
          return { kind: "yield", resume: { remaining: remaining - 1 } };
        }
        return { kind: "done", value: "finished" };
      },
    };
    const result = await scheduler.enqueue(t, { remaining: 3 });
    expect(result).toBe("finished");
    expect(calls).toBe(4);
  });
});

describe("Scheduler — coalesce", () => {
  let runner: FakeTaskRunner;
  let scheduler: Scheduler;

  beforeEach(async () => {
    runner = new FakeTaskRunner("writer");
    runner.delays.set("first", 30);
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
  });

  test("merges two pending tasks of the same name into one", async () => {
    // Coalescing task: keep the latest `value`.
    const t: Task<{ value: number }, void> = {
      name: "coalesce.test",
      runner: "writer",
      priority: "background",
      coalesce(_pending, incoming) {
        return incoming;
      },
      async run() {
        return { kind: "done", value: undefined };
      },
    };
    // Enqueue the holding "first" task to occupy the runner.
    const blocker = makeTask({
      name: "first",
      runner: "writer",
      priority: "background",
    });
    const blockerP = scheduler.enqueue(blocker, undefined);

    // Now stack three coalesce.test tasks — they should merge into one.
    const p1 = scheduler.enqueue(t, { value: 1 });
    const p2 = scheduler.enqueue(t, { value: 2 });
    const p3 = scheduler.enqueue(t, { value: 3 });

    await Promise.all([blockerP, p1, p2, p3]);
    const coalesceCalls = runner.execLog.filter((e) => e.name === "coalesce.test");
    expect(coalesceCalls).toHaveLength(1);
    expect(coalesceCalls[0].args).toEqual({ value: 3 });
  });
});

describe("Scheduler — queue cap", () => {
  test("rejects with SchedulerQueueFullError when cap exceeded", async () => {
    const runner = new FakeTaskRunner("writer");
    runner.delays.set("blocker", 50);
    const scheduler = new Scheduler({
      enablePreemption: false,
      capsByRunner: {
        writer: { user: 200, realtime: 1000, background: 2 },
      },
    });
    scheduler.registerRunner(runner);
    await scheduler.start();

    const t = makeTask({
      name: "fill",
      runner: "writer",
      priority: "background",
    });
    // Cap is 2, so the queue can hold 2 background tasks before rejecting.
    // Use a realtime blocker so it doesn't itself sit in the background lane.
    const blocker = makeTask({
      name: "blocker",
      runner: "writer",
      priority: "realtime",
    });
    scheduler.enqueue(blocker, undefined).catch(() => {});
    scheduler.enqueue(t, undefined).catch(() => {}); // background depth 1
    scheduler.enqueue(t, undefined).catch(() => {}); // background depth 2 (== cap)

    // Third background enqueue exceeds the cap and must reject.
    await expect(scheduler.enqueue(t, undefined)).rejects.toThrow(SchedulerQueueFullError);
    await scheduler.dispose();
  });
});

describe("Scheduler — wakeable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("debounces multiple wakes into one tick", async () => {
    const runner = new FakeTaskRunner("indexer");
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    const w: WakeableTask<{ tag: string }, void> = {
      name: "wake.test",
      runner: "indexer",
      priority: "background",
      debounceMs: 100,
      coalesceTrailingWake: true,
      initialArgs: { tag: "init" },
      async run() {
        return { kind: "done", value: undefined };
      },
    };
    const handle = scheduler.registerWakeable(w);

    handle.wake();
    handle.wake();
    handle.wake();

    await vi.advanceTimersByTimeAsync(100);
    // Only one fired.
    expect(runner.execLog.filter((e) => e.name === "wake.test")).toHaveLength(1);
    handle.stop();
    await scheduler.dispose();
  });
});

describe("Scheduler — periodic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a tick that names its next due moment is re-armed for it", async () => {
    // Idle would wait 500ms; the result says the next work is 120ms out, and
    // that is what the re-arm honours. A tick that names nothing falls back
    // to the ordinary idle period.
    const runner = new FakeTaskRunner("compute");
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    let tickCount = 0;
    const p: PeriodicTask<void, { idle: boolean; dueInMs?: number }> = {
      name: "periodic.due",
      runner: "compute",
      priority: "background",
      periodMs: 50,
      idlePeriodMs: 500,
      startDelayMs: 0,
      initialArgs: undefined,
      isIdle: (r) => r.idle,
      nextDelayMs: (r) => r.dueInMs,
      async run() {
        tickCount += 1;
        return {
          kind: "done",
          value: tickCount === 1 ? { idle: true, dueInMs: 120 } : { idle: true },
        };
      },
    };
    scheduler.schedule(p);

    await vi.advanceTimersByTimeAsync(1);
    expect(tickCount).toBe(1);
    // 120ms after the first tick, not 500.
    await vi.advanceTimersByTimeAsync(110);
    expect(tickCount).toBe(1);
    await vi.advanceTimersByTimeAsync(15);
    expect(tickCount).toBe(2);
    // The second tick named nothing: idle period again.
    await vi.advanceTimersByTimeAsync(400);
    expect(tickCount).toBe(2);
    await vi.advanceTimersByTimeAsync(110);
    expect(tickCount).toBe(3);

    await scheduler.dispose();
  });

  test("idle period kicks in when isIdle returns true", async () => {
    const runner = new FakeTaskRunner("compute");
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    let tickCount = 0;
    const p: PeriodicTask<void, { idle: boolean }> = {
      name: "periodic.test",
      runner: "compute",
      priority: "background",
      periodMs: 50,
      idlePeriodMs: 500,
      startDelayMs: 0,
      initialArgs: undefined,
      isIdle: (r) => r.idle,
      async run() {
        tickCount += 1;
        return { kind: "done", value: { idle: true } };
      },
    };
    scheduler.schedule(p);

    // First tick fires immediately.
    await vi.advanceTimersByTimeAsync(1);
    expect(tickCount).toBe(1);

    // 50ms later — periodMs would have fired, but isIdle=true → wait idlePeriodMs.
    await vi.advanceTimersByTimeAsync(60);
    expect(tickCount).toBe(1);

    // 500ms total → next tick.
    await vi.advanceTimersByTimeAsync(450);
    expect(tickCount).toBe(2);

    await scheduler.dispose();
  });
});

describe("Scheduler — periodic priority is the task's own", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A background periodic that reports the priority it actually ran at.
   * Reading it from inside `run` is the honest observation: it is the
   * context every nested io/writer call the task makes will inherit.
   */
  function makeObservedPeriodic(
    name: string,
    seen: Array<Priority | null>,
  ): PeriodicTask<void, { idle: boolean }> {
    return {
      name,
      runner: "compute",
      priority: "background",
      periodMs: 50,
      idlePeriodMs: 10_000,
      startDelayMs: 0,
      initialArgs: undefined,
      isIdle: (r) => r.idle,
      async run() {
        seen.push(getActivePriority());
        return { kind: "done", value: { idle: true } };
      },
    };
  }

  // A user action that wants a background sweep to run sooner says so by
  // kicking it. That must not turn the sweep — or its children, or every
  // later tick of its timer — into user work competing for the capacity
  // reserved for interactive reads.
  for (const callerPriority of ["user", "realtime"] as const) {
    test(`a background periodic kicked from ${callerPriority} work stays background across generations`, async () => {
      const runner = new FakeTaskRunner("compute");
      const scheduler = new Scheduler({ enablePreemption: false });
      scheduler.registerRunner(runner);
      await scheduler.start();

      const seen: Array<Priority | null> = [];
      scheduler.schedule(makeObservedPeriodic(`prio.${callerPriority}`, seen));
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toEqual(["background"]);

      // The kick happens inside the caller's priority scope, exactly as a
      // request handler would issue it.
      await runWithPriority(callerPriority, async () => {
        scheduler.kickPeriodic(`prio.${callerPriority}`);
      });
      await vi.advanceTimersByTimeAsync(1);

      // And the generations after it: the timer the kicked tick re-armed
      // must not still be carrying the caller's context.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(seen.length).toBeGreaterThanOrEqual(3);
      expect(seen.every((p) => p === "background")).toBe(true);

      await scheduler.dispose();
    });
  }

  test("a trailing kick issued while the tick is in flight stays background", async () => {
    const runner = new FakeTaskRunner("compute");
    runner.delays.set("prio.trailing", 20);
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    const seen: Array<Priority | null> = [];
    scheduler.schedule(makeObservedPeriodic("prio.trailing", seen));
    // Kick while the first tick is still running: the re-arm takes the
    // pending-kick branch, which is a second way the context can be caught.
    await vi.advanceTimersByTimeAsync(1);
    await runWithPriority("user", async () => {
      scheduler.kickPeriodic("prio.trailing");
    });
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((p) => p === "background")).toBe(true);

    await scheduler.dispose();
  });

  test("work a background task dispatches runs as background too", async () => {
    const compute = new FakeTaskRunner("compute");
    const writer = new FakeTaskRunner("writer");
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(compute);
    scheduler.registerRunner(writer);
    await scheduler.start();

    const nestedSeen: Array<Priority | null> = [];
    const nested = makeTask<void, void>({
      name: "prio.nested",
      runner: "writer",
      // Declared realtime, like the io/writer ops a sweep calls into: the
      // point is that the *dispatching* task's priority is what governs,
      // not whichever request context happened to be active.
      priority: "realtime",
      run: async () => {
        nestedSeen.push(getActivePriority());
        return { kind: "done", value: undefined };
      },
    });

    let nestedCall: Promise<unknown> | null = null;
    scheduler.schedule({
      name: "prio.parent",
      runner: "compute",
      priority: "background",
      periodMs: 50,
      idlePeriodMs: 10_000,
      startDelayMs: 0,
      initialArgs: undefined,
      isIdle: () => true,
      async run() {
        nestedCall = scheduler.enqueue(nested, undefined);
        return { kind: "done", value: undefined };
      },
    } as PeriodicTask<void, void>);

    await runWithPriority("user", async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await vi.advanceTimersByTimeAsync(50);
    await nestedCall;

    expect(nestedSeen).toEqual(["background"]);

    await scheduler.dispose();
  });
});

describe("Scheduler — periodic kick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makePeriodic(name: string, onTick: () => void): PeriodicTask<void, { idle: boolean }> {
    return {
      name,
      runner: "compute",
      priority: "background",
      periodMs: 50,
      idlePeriodMs: 10_000,
      startDelayMs: 0,
      initialArgs: undefined,
      isIdle: (r) => r.idle,
      async run() {
        onTick();
        return { kind: "done", value: { idle: true } };
      },
    };
  }

  test("kick fires an idle-parked periodic immediately, then normal re-arm resumes", async () => {
    const runner = new FakeTaskRunner("compute");
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    let tickCount = 0;
    scheduler.schedule(makePeriodic("kick.test", () => (tickCount += 1)));

    await vi.advanceTimersByTimeAsync(1);
    expect(tickCount).toBe(1);

    // Parked on the 10s idle delay — a kick fires the next tick now.
    scheduler.kickPeriodic("kick.test");
    await vi.advanceTimersByTimeAsync(1);
    expect(tickCount).toBe(2);

    // The kicked tick re-armed the idle cycle, not a tight loop.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tickCount).toBe(2);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(tickCount).toBe(3);

    await scheduler.dispose();
  });

  test("kicks during an in-flight tick coalesce into exactly one trailing tick", async () => {
    const runner = new FakeTaskRunner("compute");
    runner.delays.set("kick.inflight", 50);
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    let tickCount = 0;
    scheduler.schedule(makePeriodic("kick.inflight", () => (tickCount += 1)));

    // First tick starts at t≈0 and holds 50ms inside the runner.
    await vi.advanceTimersByTimeAsync(5);
    expect(runner.execLog).toHaveLength(1);
    expect(tickCount).toBe(0);

    scheduler.kickPeriodic("kick.inflight");
    scheduler.kickPeriodic("kick.inflight");

    // First tick completes at t≈50; the coalesced trailing tick fires
    // immediately and holds until t≈100.
    await vi.advanceTimersByTimeAsync(100);
    expect(tickCount).toBe(2);
    expect(runner.execLog).toHaveLength(2);

    // Back to the idle cycle — no third tick from the double kick.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tickCount).toBe(2);

    await scheduler.dispose();
  });

  test("kickPeriodicAndWait returns the exact kicked generation", async () => {
    const runner = new FakeTaskRunner("compute");
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    let tickCount = 0;
    scheduler.schedule({
      ...makePeriodic("kick.awaited", () => undefined),
      async run() {
        tickCount += 1;
        return { kind: "done", value: { idle: true, tickCount } };
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(tickCount).toBe(1);

    const resultPromise = scheduler.kickPeriodicAndWait("kick.awaited");
    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toEqual({ idle: true, tickCount: 2 });
    await scheduler.dispose();
  });

  test("kickPeriodicAndWait targets the trailing generation when a tick is in flight", async () => {
    const runner = new FakeTaskRunner("compute");
    runner.delays.set("kick.awaited-inflight", 50);
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    let tickCount = 0;
    scheduler.schedule({
      ...makePeriodic("kick.awaited-inflight", () => undefined),
      async run() {
        tickCount += 1;
        return { kind: "done", value: { idle: true, tickCount } };
      },
    });
    await vi.advanceTimersByTimeAsync(5);

    const resultPromise = scheduler.kickPeriodicAndWait("kick.awaited-inflight");
    await vi.advanceTimersByTimeAsync(55);
    expect(tickCount).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    await expect(resultPromise).resolves.toEqual({ idle: true, tickCount: 2 });
    await scheduler.dispose();
  });

  test("concurrent awaited kicks coalesce onto the same trailing generation", async () => {
    const runner = new FakeTaskRunner("compute");
    runner.delays.set("kick.awaited-coalesced", 50);
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    let tickCount = 0;
    scheduler.schedule({
      ...makePeriodic("kick.awaited-coalesced", () => undefined),
      async run() {
        tickCount += 1;
        return { kind: "done", value: { idle: true, tickCount } };
      },
    });
    await vi.advanceTimersByTimeAsync(5);
    const first = scheduler.kickPeriodicAndWait("kick.awaited-coalesced");
    const second = scheduler.kickPeriodicAndWait("kick.awaited-coalesced");

    await vi.advanceTimersByTimeAsync(105);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { idle: true, tickCount: 2 },
      { idle: true, tickCount: 2 },
    ]);
    expect(runner.execLog).toHaveLength(2);
    await scheduler.dispose();
  });

  test("an old in-flight rejection does not replace the awaited trailing result", async () => {
    const runner = new FakeTaskRunner("compute");
    runner.delays.set("kick.awaited-after-error", 50);
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    let tickCount = 0;
    scheduler.schedule({
      ...makePeriodic("kick.awaited-after-error", () => undefined),
      async run() {
        tickCount += 1;
        if (tickCount === 1) throw new Error("old generation failed");
        return { kind: "done", value: { idle: true, tickCount } };
      },
    });
    await vi.advanceTimersByTimeAsync(5);
    const resultPromise = scheduler.kickPeriodicAndWait("kick.awaited-after-error");

    await vi.advanceTimersByTimeAsync(105);
    await expect(resultPromise).resolves.toEqual({ idle: true, tickCount: 2 });
    await scheduler.dispose();
  });

  test("a trailing generation rejection rejects its waiter", async () => {
    const runner = new FakeTaskRunner("compute");
    runner.delays.set("kick.awaited-error", 50);
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    let tickCount = 0;
    scheduler.schedule({
      ...makePeriodic("kick.awaited-error", () => undefined),
      async run() {
        tickCount += 1;
        if (tickCount === 2) throw new Error("trailing generation failed");
        return { kind: "done", value: { idle: true, tickCount } };
      },
    });
    await vi.advanceTimersByTimeAsync(5);
    const resultPromise = scheduler.kickPeriodicAndWait("kick.awaited-error");
    const assertion = expect(resultPromise).rejects.toThrow("trailing generation failed");

    await vi.advanceTimersByTimeAsync(105);
    await assertion;
    await scheduler.dispose();
  });

  test("dispose and timeout both reject pending periodic waiters", async () => {
    const runner = new FakeTaskRunner("compute");
    runner.delays.set("kick.awaited-stop", 10_000);
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
    scheduler.schedule(makePeriodic("kick.awaited-stop", () => undefined));
    await vi.advanceTimersByTimeAsync(5);

    const timed = scheduler.kickPeriodicAndWait("kick.awaited-stop", 25);
    const timeoutAssertion = expect(timed).rejects.toThrow("did not complete within 25ms");
    await vi.advanceTimersByTimeAsync(25);
    await timeoutAssertion;

    const stopped = scheduler.kickPeriodicAndWait("kick.awaited-stop");
    const stopAssertion = expect(stopped).rejects.toThrow('periodic "kick.awaited-stop" stopped');
    await scheduler.dispose();
    await stopAssertion;
  });

  test("quiescing stops new periodic roots while an in-flight root drains nested work", async () => {
    const computeRunner = new FakeTaskRunner("compute");
    const writerRunner = new FakeTaskRunner("writer");
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(computeRunner);
    scheduler.registerRunner(writerRunner);
    await scheduler.start();

    let releaseRoot!: () => void;
    const rootBlocked = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    let childRuns = 0;
    const child = makeTask({
      name: "quiesce.child",
      runner: "writer",
      priority: "background",
      async run() {
        childRuns += 1;
        return { kind: "done", value: undefined };
      },
    });
    scheduler.schedule({
      ...makePeriodic("quiesce.root", () => undefined),
      async run() {
        await rootBlocked;
        await scheduler.enqueue(child, undefined, { priority: "background" });
        return { kind: "done", value: { idle: true } };
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(computeRunner.execLog).toHaveLength(1);

    scheduler.quiescePeriodics();
    expect(scheduler.isBackgroundPaused()).toBe(false);
    releaseRoot();
    await vi.advanceTimersByTimeAsync(1);
    expect(childRuns).toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(computeRunner.execLog).toHaveLength(1);
    await scheduler.dispose();
  });

  test("kickPeriodicAndWait rejects unknown task names", async () => {
    const scheduler = new Scheduler({ enablePreemption: false });
    await expect(scheduler.kickPeriodicAndWait("kick.missing")).rejects.toThrow(
      'no live periodic registered as "kick.missing"',
    );
  });

  test("kick on an unknown task name is a no-op", async () => {
    const runner = new FakeTaskRunner("compute");
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
    expect(() => scheduler.kickPeriodic("kick.unregistered")).not.toThrow();
    await scheduler.dispose();
  });

  test("kick after dispose neither throws nor produces a tick", async () => {
    const runner = new FakeTaskRunner("compute");
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    let tickCount = 0;
    scheduler.schedule(makePeriodic("kick.disposed", () => (tickCount += 1)));
    await vi.advanceTimersByTimeAsync(1);
    expect(tickCount).toBe(1);

    await scheduler.dispose();
    expect(() => scheduler.kickPeriodic("kick.disposed")).not.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tickCount).toBe(1);
  });

  test("kick before start() is dropped and does not double-arm the timer chain", async () => {
    const runner = new FakeTaskRunner("compute");
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);

    let tickCount = 0;
    scheduler.schedule(makePeriodic("kick.prestart", () => (tickCount += 1)));
    scheduler.kickPeriodic("kick.prestart");
    await vi.advanceTimersByTimeAsync(100);
    expect(tickCount).toBe(0);

    // start() arms the one and only timer chain; exactly one tick fires.
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(tickCount).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(tickCount).toBe(1);

    await scheduler.dispose();
  });
});

describe("Scheduler — disposal", () => {
  test("rejects all pending tasks", async () => {
    const runner = new FakeTaskRunner("writer");
    runner.delays.set("blocker", 1000);
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    const blocker = makeTask({ name: "blocker", runner: "writer" });
    const t = makeTask({ name: "queued", runner: "writer" });
    // Blocker may also reject during dispose since its exec hasn't completed
    // — silence it to avoid an unhandled-rejection warning.
    scheduler.enqueue(blocker, undefined).catch(() => {});
    const p = scheduler.enqueue(t, undefined);

    await scheduler.dispose();
    await expect(p).rejects.toThrow("scheduler disposed");
  });

  test("aborts in-flight ctx.signal so tasks wired to AbortSignal can short-circuit", async () => {
    const runner = new FakeTaskRunner("writer");
    runner.delays.set("hold", 1_000);
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    const t = makeTask({ name: "hold", runner: "writer" });
    void scheduler.enqueue(t, undefined).catch(() => undefined);

    // Yield once so execOne actually runs and lastCtx is populated.
    await new Promise((r) => setImmediate(r));
    const ctx = runner.lastCtx;
    expect(ctx).not.toBeNull();
    expect(ctx!.signal.aborted).toBe(false);

    await scheduler.dispose();
    expect(ctx!.signal.aborted).toBe(true);
  });
});

describe("Scheduler — snapshot", () => {
  test("perTask reports count + percentiles after executions", async () => {
    const runner = new FakeTaskRunner("writer");
    runner.delays.set("metric.test", 5);
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();

    const t = makeTask({
      name: "metric.test",
      runner: "writer",
      priority: "user",
    });
    await scheduler.enqueue(t, undefined);
    await scheduler.enqueue(t, undefined);
    await scheduler.enqueue(t, undefined);

    const snap = scheduler.snapshot(60);
    const stats = snap.perTask.find((p) => p.name === "metric.test");
    expect(stats).toBeDefined();
    expect(stats!.count).toBe(3);
    expect(stats!.countByPriority).toEqual({ user: 3, realtime: 0, background: 0 });

    expect(snap.userSla.count).toBe(3);

    await scheduler.dispose();
  });
});
