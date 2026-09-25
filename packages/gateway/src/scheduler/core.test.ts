// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SchedulerCore concurrency-invariant tests, driven through the public
 * `Scheduler` façade with deterministic test doubles (no wall-clock
 * sleeps, no dispatch-ordering races).
 *
 * These cover the hardest fairness/latency invariants that the broader
 * `scheduler.test.ts` happy-path suite leaves unverified:
 *
 *   - anti-starvation override fires exactly once per
 *     STARVATION_MIN_INTERVAL_MS (an aged background task jumps a queued
 *     user task, but a second aged background task does NOT jump again
 *     inside the rate-limit window);
 *   - coalesced callers ALL settle with the merged entry's outcome —
 *     both the resolve fan-out and the reject fan-out;
 *   - maybePreempt requests a yield iff a strictly-higher-priority task
 *     lands while a lower-priority task is in flight (and is a no-op for
 *     equal/lower priority);
 *   - pauseBackground/resumeBackground gate ONLY the background lane —
 *     user + realtime keep dispatching while paused, and the parked
 *     background work drains on resume.
 *
 * Determinism strategy: a "gated" runner keeps one task in flight on a
 * manually-resolved deferred so we control exactly when the runner frees
 * up (and thus when `dispatch`/`popNext` re-evaluate the queues). Time is
 * driven with vitest fake timers + `setSystemTime`, which mocks
 * `Date.now()` (the only clock `popNext` reads).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Scheduler } from "./scheduler.js";
import { TaskExecutionError } from "./types.js";
import { STARVATION_BUDGET_MS, STARVATION_MIN_INTERVAL_MS } from "./internals.js";
import type { TaskRunner } from "./runner.js";
import type { Priority, RunnerKind, Task, TaskContext, TaskOutcome } from "./types.js";

type ExecCall = { name: string; priority: Priority };

/** A deferred whose settlement we control from the test body. */
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
 * Drain the microtask queue without advancing the (fake) clock.
 *
 * Releasing a gated exec kicks off a `.then → .catch → .finally → dispatch
 * → next exec` chain plus the caller's own continuation — several
 * microtask hops. Microtasks are never faked by vitest's fake timers, so
 * awaiting a fixed number of resolved promises deterministically settles
 * the whole chain. The count is comfortably above the longest hop chain.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

/**
 * Runner test double whose `exec` blocks on a per-invocation gate that
 * the test releases manually. This keeps a task "in flight" for as long
 * as the test wants — without any timer — so queued tasks pile up
 * deterministically behind it and `popNext` is re-evaluated at a known
 * clock value the moment the gate is released.
 */
class GatedRunner implements TaskRunner {
  public readonly kind: RunnerKind;
  public readonly concurrency: number;
  public execLog: ExecCall[] = [];
  public signalPreemptCalls = 0;
  public lastCtx: TaskContext | null = null;
  /** FIFO of gates handed out to in-flight execs, in dispatch order. */
  private readonly gates: Array<{
    name: string;
    deferred: Deferred<TaskOutcome<unknown, unknown>>;
  }> = [];

  constructor(kind: RunnerKind, concurrency = 1) {
    this.kind = kind;
    this.concurrency = concurrency;
  }

  async start(): Promise<void> {}
  async dispose(): Promise<void> {}
  signalPreempt(): void {
    this.signalPreemptCalls += 1;
  }
  /** Runners that support preemption expose this; presence triggers a PreemptBuffer. */
  attachPreemptBuffer(_buf: SharedArrayBuffer): void {}

  async exec<TArgs, TResult>(
    task: Task<TArgs, TResult>,
    _args: TArgs,
    ctx: TaskContext,
  ): Promise<TaskOutcome<TArgs, TResult>> {
    this.execLog.push({ name: task.name, priority: "background" });
    this.lastCtx = ctx;
    const deferred = defer<TaskOutcome<unknown, unknown>>();
    this.gates.push({ name: task.name, deferred });
    return deferred.promise as Promise<TaskOutcome<TArgs, TResult>>;
  }

  /** Number of execs currently blocked on a gate (== in flight). */
  get pending(): number {
    return this.gates.length;
  }

  /** Release the oldest in-flight exec with a done outcome. */
  releaseNext(value: unknown = undefined): void {
    const g = this.gates.shift();
    if (!g) throw new Error("releaseNext: no gated exec in flight");
    g.deferred.resolve({ kind: "done", value });
  }

  /**
   * Reject the oldest in-flight exec — faithfully simulating a runner
   * whose `task.run()` threw (the real writer/io runners propagate the
   * rejection, which the core wraps as TaskExecutionError).
   */
  rejectNext(err: unknown): void {
    const g = this.gates.shift();
    if (!g) throw new Error("rejectNext: no gated exec in flight");
    g.deferred.reject(err);
  }
}

function makeTask<TArgs = void, TResult = void>(
  partial: Partial<Task<TArgs, TResult>> & { name: string; runner: RunnerKind },
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

describe("SchedulerCore — anti-starvation override", () => {
  let runner: GatedRunner;
  let scheduler: Scheduler;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Anchor the clock well past STARVATION_MIN_INTERVAL_MS so the very
    // first dispatch isn't rate-limited by `lastStarvationDispatchMs = 0`.
    vi.setSystemTime(STARVATION_MIN_INTERVAL_MS * 100);
    runner = new GatedRunner("writer", 1);
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
    vi.useRealTimers();
  });

  test("an aged background task jumps a queued user task exactly once per interval", async () => {
    const settled: string[] = [];
    const bgOld = makeTask({ name: "bg.old", runner: "writer", priority: "background" });
    const bgOld2 = makeTask({ name: "bg.old2", runner: "writer", priority: "background" });
    const user1 = makeTask({ name: "user.1", runner: "writer", priority: "user" });
    const user2 = makeTask({ name: "user.2", runner: "writer", priority: "user" });
    const hold = makeTask({ name: "hold", runner: "writer", priority: "user" });

    // 1) Occupy the runner with a held task so everything else queues.
    void scheduler.enqueue(hold, undefined).catch(() => {});
    await flushMicrotasks();
    expect(runner.pending).toBe(1); // "hold" is in flight

    // 2) Queue two background tasks (these will age) and two user tasks.
    void scheduler.enqueue(bgOld, undefined).then(() => settled.push("bg.old"));
    void scheduler.enqueue(bgOld2, undefined).then(() => settled.push("bg.old2"));
    void scheduler.enqueue(user1, undefined).then(() => settled.push("user.1"));
    void scheduler.enqueue(user2, undefined).then(() => settled.push("user.2"));
    await flushMicrotasks();
    // Nothing else can run yet — the single-concurrency runner is busy.
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold"]);

    // 3) Age the background tasks past STARVATION_BUDGET_MS. Their
    //    enqueueMs is "now"; advance the clock beyond the budget.
    vi.setSystemTime(STARVATION_MIN_INTERVAL_MS * 100 + STARVATION_BUDGET_MS + 5);

    // 4) Free the runner → dispatch re-runs popNext at the aged clock.
    //    The aged background head must jump ahead of the queued user task.
    runner.releaseNext(); // completes "hold", triggers dispatch
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold", "bg.old"]);

    // 5) Release "bg.old". We are still inside the same
    //    STARVATION_MIN_INTERVAL_MS window (clock unchanged), so the
    //    second aged background task must NOT jump again — the user
    //    task wins this dispatch.
    runner.releaseNext();
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold", "bg.old", "user.1"]);

    // Drain the rest so the test completes cleanly.
    runner.releaseNext(); // user.1
    await flushMicrotasks();
    runner.releaseNext(); // user.2
    await flushMicrotasks();
    runner.releaseNext(); // bg.old2
    await flushMicrotasks();

    // The override fired once: bg.old preceded user.1 even though user
    // outranks background; the second aged bg task (bg.old2) did NOT
    // jump and ran only after both user tasks.
    expect(runner.execLog.map((e) => e.name)).toEqual([
      "hold",
      "bg.old",
      "user.1",
      "user.2",
      "bg.old2",
    ]);
    expect(settled.sort()).toEqual(["bg.old", "bg.old2", "user.1", "user.2"]);
  });

  test("a second aged background task jumps once the rate-limit interval elapses", async () => {
    const bgA = makeTask({ name: "bg.a", runner: "writer", priority: "background" });
    const bgB = makeTask({ name: "bg.b", runner: "writer", priority: "background" });
    const userA = makeTask({ name: "user.a", runner: "writer", priority: "user" });
    const userB = makeTask({ name: "user.b", runner: "writer", priority: "user" });
    const hold = makeTask({ name: "hold", runner: "writer", priority: "user" });

    void scheduler.enqueue(hold, undefined).catch(() => {});
    await flushMicrotasks();

    void scheduler.enqueue(bgA, undefined);
    void scheduler.enqueue(bgB, undefined);
    void scheduler.enqueue(userA, undefined);
    void scheduler.enqueue(userB, undefined);
    await flushMicrotasks();

    // Age both background tasks past the budget; first override fires.
    vi.setSystemTime(STARVATION_MIN_INTERVAL_MS * 100 + STARVATION_BUDGET_MS + 5);
    runner.releaseNext(); // hold done → bg.a jumps
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold", "bg.a"]);

    // Advance PAST the rate-limit window before the next dispatch so the
    // second aged background task is eligible to jump again.
    vi.setSystemTime(
      STARVATION_MIN_INTERVAL_MS * 100 + STARVATION_BUDGET_MS + 5 + STARVATION_MIN_INTERVAL_MS + 1,
    );
    runner.releaseNext(); // bg.a done → bg.b jumps the user tasks again
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold", "bg.a", "bg.b"]);

    runner.releaseNext(); // user.a
    await flushMicrotasks();
    runner.releaseNext(); // user.b
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["hold", "bg.a", "bg.b", "user.a", "user.b"]);
  });
});

describe("SchedulerCore — coalesce fan-out", () => {
  let runner: GatedRunner;
  let scheduler: Scheduler;

  beforeEach(async () => {
    runner = new GatedRunner("writer", 1);
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
  });

  test("every coalesced caller resolves with the merged entry's value", async () => {
    const t: Task<{ value: number }, string> = {
      name: "coalesce.resolve",
      runner: "writer",
      priority: "background",
      latencyBudgetMs: 200,
      coalesce(_pending, incoming) {
        return incoming; // last-write-wins merge
      },
      // GatedRunner intercepts exec; the resolved value is injected via
      // releaseNext() to mimic the runner returning a single outcome.
      async run() {
        return { kind: "done", value: "unreachable" };
      },
    };

    // Hold the runner so the three coalescing enqueues pile up behind it
    // and actually merge (coalesce only fires against a queued tail).
    const blocker = makeTask({ name: "blocker", runner: "writer", priority: "background" });
    void scheduler.enqueue(blocker, undefined);
    await flushMicrotasks();
    expect(runner.pending).toBe(1);

    const p1 = scheduler.enqueue(t, { value: 1 });
    const p2 = scheduler.enqueue(t, { value: 2 });
    const p3 = scheduler.enqueue(t, { value: 3 });
    await flushMicrotasks();

    // Free the runner; the single merged entry runs, then resolves once.
    runner.releaseNext(); // blocker done → merged entry dispatched
    await flushMicrotasks();
    runner.releaseNext("MERGED"); // merged entry done with a single outcome
    await flushMicrotasks();

    // All three coalesced callers must settle with the SAME value — the
    // promise fan-out chains one resolve into every queued caller.
    await expect(p1).resolves.toBe("MERGED");
    await expect(p2).resolves.toBe("MERGED");
    await expect(p3).resolves.toBe("MERGED");

    // The merge collapsed three enqueues into a single exec.
    expect(runner.execLog.filter((e) => e.name === "coalesce.resolve")).toHaveLength(1);
  });

  test("every coalesced caller rejects with the same merged-entry error", async () => {
    const t: Task<{ value: number }, string> = {
      name: "coalesce.reject",
      runner: "writer",
      priority: "background",
      latencyBudgetMs: 200,
      coalesce(_pending, incoming) {
        return incoming;
      },
      // The GatedRunner intercepts exec, so run() is never invoked; the
      // failure is injected via rejectNext() to mimic a throwing runner.
      async run(): Promise<TaskOutcome<{ value: number }, string>> {
        return { kind: "done", value: "unreachable" };
      },
    };

    const blocker = makeTask({ name: "blocker", runner: "writer", priority: "background" });
    void scheduler.enqueue(blocker, undefined);
    await flushMicrotasks();

    const p1 = scheduler.enqueue(t, { value: 1 });
    const p2 = scheduler.enqueue(t, { value: 2 });
    const p3 = scheduler.enqueue(t, { value: 3 });
    // Attach rejection handlers immediately so a settled-before-awaited
    // rejection isn't reported as unhandled.
    const caught = Promise.allSettled([p1, p2, p3]);
    await flushMicrotasks();

    runner.releaseNext(); // blocker done → merged entry dispatched
    await flushMicrotasks();
    // The merged entry is now in flight; fail it like a throwing runner.
    runner.rejectNext(new Error("merged-entry boom"));
    await flushMicrotasks();

    const results = await caught;
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    for (const r of results) {
      if (r.status !== "rejected") throw new Error("expected rejection");
      expect(r.reason).toBeInstanceOf(TaskExecutionError);
      expect((r.reason as TaskExecutionError).taskName).toBe("coalesce.reject");
    }
    // All three callers share the identical wrapped error instance —
    // the fan-out chains a single reject, it does not re-wrap per caller.
    const reasons = results.map((r) => (r as PromiseRejectedResult).reason);
    expect(reasons[0]).toBe(reasons[1]);
    expect(reasons[1]).toBe(reasons[2]);
  });
});

describe("SchedulerCore — maybePreempt", () => {
  let runner: GatedRunner;
  let scheduler: Scheduler;

  beforeEach(async () => {
    // enablePreemption + concurrency 1 + signalPreempt present ⇒
    // the core allocates a PreemptBuffer for this runner.
    runner = new GatedRunner("writer", 1);
    scheduler = new Scheduler({ enablePreemption: true });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
  });

  test("a strictly-higher-priority arrival requests a yield exactly once", async () => {
    const buffer = scheduler.getPreemptBuffer("writer");
    expect(buffer).not.toBeNull();
    expect(buffer!.isRequested()).toBe(false);

    // Put a background task in flight.
    const bg = makeTask({ name: "bg.inflight", runner: "writer", priority: "background" });
    void scheduler.enqueue(bg, undefined);
    await flushMicrotasks();
    expect(runner.pending).toBe(1);
    // dispatch() reset the flag at task start.
    expect(buffer!.isRequested()).toBe(false);

    // An equal-priority arrival must NOT request a yield.
    const bg2 = makeTask({ name: "bg.equal", runner: "writer", priority: "background" });
    void scheduler.enqueue(bg2, undefined);
    await flushMicrotasks();
    expect(buffer!.isRequested()).toBe(false);
    expect(runner.signalPreemptCalls).toBe(0);
    expect(scheduler.preemptRequestCount).toBe(0);

    // A strictly-higher-priority (user) arrival flips the flag once.
    const user = makeTask({ name: "user.hot", runner: "writer", priority: "user" });
    void scheduler.enqueue(user, undefined);
    await flushMicrotasks();
    expect(buffer!.isRequested()).toBe(true);
    expect(runner.signalPreemptCalls).toBe(1);
    expect(scheduler.preemptRequestCount).toBe(1);

    // Drain.
    runner.releaseNext(); // bg.inflight done; flag reset at next start
    await flushMicrotasks();
    while (runner.pending > 0) {
      runner.releaseNext();
      await flushMicrotasks();
    }
  });

  test("a lower-priority arrival never requests a yield", async () => {
    const buffer = scheduler.getPreemptBuffer("writer");
    expect(buffer).not.toBeNull();

    // Put a user task in flight (highest priority).
    const user = makeTask({ name: "user.inflight", runner: "writer", priority: "user" });
    void scheduler.enqueue(user, undefined);
    await flushMicrotasks();
    expect(runner.pending).toBe(1);

    // Background + realtime arrivals are both lower than the in-flight
    // user task — neither may request a yield.
    const bg = makeTask({ name: "bg.late", runner: "writer", priority: "background" });
    const rt = makeTask({ name: "rt.late", runner: "writer", priority: "realtime" });
    void scheduler.enqueue(bg, undefined);
    void scheduler.enqueue(rt, undefined);
    await flushMicrotasks();

    expect(buffer!.isRequested()).toBe(false);
    expect(runner.signalPreemptCalls).toBe(0);
    expect(scheduler.preemptRequestCount).toBe(0);

    runner.releaseNext(); // user.inflight done
    await flushMicrotasks();
    while (runner.pending > 0) {
      runner.releaseNext();
      await flushMicrotasks();
    }
  });
});

describe("SchedulerCore — pauseBackground / resumeBackground", () => {
  let runner: GatedRunner;
  let scheduler: Scheduler;

  beforeEach(async () => {
    runner = new GatedRunner("writer", 1);
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
  });

  test("pause gates only the background lane; user + realtime still dispatch and parked background drains on resume", async () => {
    expect(scheduler.isBackgroundPaused()).toBe(false);
    scheduler.pauseBackground();
    expect(scheduler.isBackgroundPaused()).toBe(true);

    const settled: string[] = [];
    const bg = makeTask({ name: "bg.parked", runner: "writer", priority: "background" });
    const user = makeTask({ name: "user.live", runner: "writer", priority: "user" });
    const rt = makeTask({ name: "rt.live", runner: "writer", priority: "realtime" });

    // Enqueue background first so, absent the pause gate, it would be the
    // only thing dispatchable when the runner is idle.
    void scheduler.enqueue(bg, undefined).then(() => settled.push("bg.parked"));
    await flushMicrotasks();
    // Background is paused → nothing dispatched, runner idle.
    expect(runner.pending).toBe(0);
    expect(runner.execLog).toHaveLength(0);

    // User + realtime keep flowing while paused.
    void scheduler.enqueue(user, undefined).then(() => settled.push("user.live"));
    void scheduler.enqueue(rt, undefined).then(() => settled.push("rt.live"));
    await flushMicrotasks();
    // The user task dispatched (single-concurrency runner picked the
    // highest priority); background is still parked.
    expect(runner.execLog.map((e) => e.name)).toEqual(["user.live"]);

    runner.releaseNext(); // user.live done → realtime next, background still gated
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["user.live", "rt.live"]);

    runner.releaseNext(); // rt.live done → runner idle, background STILL parked
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["user.live", "rt.live"]);
    expect(runner.pending).toBe(0);
    expect(settled.sort()).toEqual(["rt.live", "user.live"]);

    // Resume → the parked background task drains without a fresh enqueue.
    scheduler.resumeBackground();
    expect(scheduler.isBackgroundPaused()).toBe(false);
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["user.live", "rt.live", "bg.parked"]);

    runner.releaseNext(); // bg.parked done
    await flushMicrotasks();
    expect(settled.sort()).toEqual(["bg.parked", "rt.live", "user.live"]);
  });
});

describe("SchedulerCore — soft admission pause", () => {
  let runner: GatedRunner;
  let scheduler: Scheduler;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Anchor the clock past STARVATION_MIN_INTERVAL_MS so the first
    // starvation check isn't rate-limited by `lastStarvationDispatchMs = 0`.
    vi.setSystemTime(STARVATION_MIN_INTERVAL_MS * 100);
    runner = new GatedRunner("writer", 1);
    // A very large maxHoldMs keeps the admission hold engaged across the
    // multi-second aging we drive by hand; a short pump keeps the watchdog
    // firing under fake timers.
    scheduler = new Scheduler({
      enablePreemption: false,
      admission: { enabled: true, maxHoldMs: 10_000_000, pumpIntervalMs: 900 },
    });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
    vi.useRealTimers();
  });

  test("soft pause defers fresh background while user + realtime flow; release drains it", async () => {
    const hold = scheduler.beginUserAdmission();
    expect(scheduler.isAdmissionPaused()).toBe(true);
    expect(scheduler.admissionHolds()).toBe(1);

    const settled: string[] = [];
    const bg = makeTask({ name: "bg.parked", runner: "writer", priority: "background" });
    const user = makeTask({ name: "user.live", runner: "writer", priority: "user" });
    const rt = makeTask({ name: "rt.live", runner: "writer", priority: "realtime" });

    // Enqueue background first: absent the soft pause it would be the only
    // dispatchable task on the idle runner.
    void scheduler.enqueue(bg, undefined).then(() => settled.push("bg.parked"));
    await flushMicrotasks();
    expect(runner.execLog).toHaveLength(0); // parked

    void scheduler.enqueue(user, undefined).then(() => settled.push("user.live"));
    void scheduler.enqueue(rt, undefined).then(() => settled.push("rt.live"));
    await flushMicrotasks();
    // User + realtime still flow under the soft pause; background stays parked.
    expect(runner.execLog.map((e) => e.name)).toEqual(["user.live"]);

    runner.releaseNext(); // user.live done → realtime next
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["user.live", "rt.live"]);

    runner.releaseNext(); // rt.live done → runner idle, background STILL parked
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["user.live", "rt.live"]);

    // Release the last hold → soft pause lifts and the parked background
    // drains without a fresh enqueue (setAdmissionPaused pumps on release).
    hold.release();
    expect(scheduler.isAdmissionPaused()).toBe(false);
    expect(scheduler.admissionHolds()).toBe(0);
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["user.live", "rt.live", "bg.parked"]);

    runner.releaseNext(); // bg.parked done
    await flushMicrotasks();
    expect(settled.sort()).toEqual(["bg.parked", "rt.live", "user.live"]);
  });

  test("starvation floor still drains an aged background task while soft-paused with an idle runner", async () => {
    // A long-lived user request holds the soft pause; the runner is otherwise
    // idle. The pump watchdog must still give the anti-starvation floor a
    // chance to release aged background work — otherwise a continuously
    // present user would starve background forever.
    const hold = scheduler.beginUserAdmission();
    expect(scheduler.isAdmissionPaused()).toBe(true);

    const settled: string[] = [];
    const bg = makeTask({ name: "bg.aged", runner: "writer", priority: "background" });
    void scheduler.enqueue(bg, undefined).then(() => settled.push("bg.aged"));
    await flushMicrotasks();
    expect(runner.execLog).toHaveLength(0); // parked: not yet aged

    // No natural dispatch trigger fires (idle runner, no completions). Advance
    // past the starvation budget by more than one pump interval so a watchdog
    // tick lands with the task aged.
    await vi.advanceTimersByTimeAsync(STARVATION_BUDGET_MS + 900);
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg.aged"]);
    // The floor fired specifically under the soft pause — the observable proof
    // that a continuously-present user can't starve background.
    expect(scheduler.starvationReleasesWhilePaused).toBeGreaterThanOrEqual(1);

    runner.releaseNext();
    await flushMicrotasks();
    expect(settled).toEqual(["bg.aged"]);

    hold.release();
  });
});

describe("SchedulerCore — hard pause suppresses starvation", () => {
  let runner: GatedRunner;
  let scheduler: Scheduler;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(STARVATION_MIN_INTERVAL_MS * 100);
    runner = new GatedRunner("writer", 1);
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
    vi.useRealTimers();
  });

  test("an aged background head does NOT jump ahead under the benchmark hard pause", async () => {
    scheduler.pauseBackground();
    const settled: string[] = [];
    const bg = makeTask({ name: "bg.aged", runner: "writer", priority: "background" });
    const user = makeTask({ name: "user.live", runner: "writer", priority: "user" });

    void scheduler.enqueue(bg, undefined).then(() => settled.push("bg.aged"));
    await flushMicrotasks();
    expect(runner.execLog).toHaveLength(0);

    // Age the background task well past the starvation budget.
    vi.setSystemTime(STARVATION_MIN_INTERVAL_MS * 100 + STARVATION_BUDGET_MS + 5);

    // A fresh dispatch pass (triggered by enqueueing a user task) must NOT
    // promote the aged background head — the hard pause disables starvation.
    void scheduler.enqueue(user, undefined).then(() => settled.push("user.live"));
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["user.live"]);

    runner.releaseNext(); // user done → runner idle, aged bg STILL gated
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["user.live"]);

    // Resume → the parked background drains.
    scheduler.resumeBackground();
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["user.live", "bg.aged"]);
    runner.releaseNext();
    await flushMicrotasks();
    expect(settled.sort()).toEqual(["bg.aged", "user.live"]);
  });
});

describe("SchedulerCore — reserved user slots", () => {
  // Concurrency 2 with 1 reserved slot ⇒ non-user cap = 1, one slot always
  // held free for user reads — the cleanest arithmetic to exercise the gate.
  // Mirrors the production io pool (concurrency 6, reserved 1) at smaller scale.
  let runner: GatedRunner;
  let scheduler: Scheduler;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Anchor past STARVATION_MIN_INTERVAL_MS so the first dispatch isn't
    // rate-limited, but do NOT advance the clock in the non-starvation tests —
    // freshly-enqueued background never ages, so the floor stays dormant and
    // only the reservation gate is under test.
    vi.setSystemTime(STARVATION_MIN_INTERVAL_MS * 100);
    runner = new GatedRunner("io", 2);
    scheduler = new Scheduler({ enablePreemption: false, reservedUserSlotsByRunner: { io: 1 } });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
    vi.useRealTimers();
  });

  /** Release in-flight execs until the runner's queues and inflight both drain. */
  async function drain(): Promise<void> {
    while (runner.pending > 0) {
      runner.releaseNext();
      await flushMicrotasks();
    }
  }

  test("caps background at concurrency − reserved; a user read then lands in the reserved slot without waiting for queued background", async () => {
    const bg1 = makeTask({ name: "bg1", runner: "io", priority: "background" });
    const bg2 = makeTask({ name: "bg2", runner: "io", priority: "background" });
    const userA = makeTask({ name: "userA", runner: "io", priority: "user" });

    void scheduler.enqueue(bg1, undefined).catch(() => {});
    void scheduler.enqueue(bg2, undefined).catch(() => {});
    await flushMicrotasks();
    // Only 1 background runs (cap = concurrency 2 − reserved 1); bg2 is held so
    // the reserved slot stays free.
    expect(runner.pending).toBe(1);
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg1"]);

    // The user read takes the reserved slot immediately — it does NOT wait for
    // the in-flight bg1 to finish, which is the whole point of the reservation.
    void scheduler.enqueue(userA, undefined).catch(() => {});
    await flushMicrotasks();
    expect(runner.pending).toBe(2);
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg1", "userA"]);

    // Releasing bg1 frees the non-reserved slot; bg2 dispatches into it.
    runner.releaseNext();
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg1", "userA", "bg2"]);

    await drain();
  });

  test("holds the reserved slot against realtime too — a user read lands even when realtime wants every worker", async () => {
    // Realtime work can occupy an IO worker for minutes. The non-user gate caps
    // realtime and background work at concurrency − reserved, so user reads
    // always retain the capacity reserved for them.
    const rt1 = makeTask({ name: "rt1", runner: "io", priority: "realtime" });
    const rt2 = makeTask({ name: "rt2", runner: "io", priority: "realtime" });
    const userA = makeTask({ name: "userA", runner: "io", priority: "user" });

    void scheduler.enqueue(rt1, undefined).catch(() => {});
    void scheduler.enqueue(rt2, undefined).catch(() => {});
    await flushMicrotasks();
    // Only 1 realtime task runs (non-user cap = concurrency 2 − reserved 1);
    // rt2 is held so the reserved slot stays free.
    expect(runner.pending).toBe(1);
    expect(runner.execLog.map((e) => e.name)).toEqual(["rt1"]);

    // The user read lands in the reserved slot immediately — it does NOT wait
    // for the in-flight rt1 to finish.
    void scheduler.enqueue(userA, undefined).catch(() => {});
    await flushMicrotasks();
    expect(runner.pending).toBe(2);
    expect(runner.execLog.map((e) => e.name)).toEqual(["rt1", "userA"]);

    // Releasing rt1 frees the non-reserved slot; rt2 dispatches into it.
    runner.releaseNext();
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["rt1", "userA", "rt2"]);

    await drain();
  });

  test("background and realtime both count against the non-user allotment; a user read jumps a queued realtime into the reserved slot", async () => {
    const bg = makeTask({ name: "bg", runner: "io", priority: "background" });
    const rt = makeTask({ name: "rt", runner: "io", priority: "realtime" });
    const userA = makeTask({ name: "userA", runner: "io", priority: "user" });

    // bg dispatches on arrival, filling the single non-user slot. rt then
    // arrives but the allotment is full, so the reserved slot stays available
    // to user work.
    void scheduler.enqueue(bg, undefined).catch(() => {});
    void scheduler.enqueue(rt, undefined).catch(() => {});
    await flushMicrotasks();
    expect(runner.pending).toBe(1);
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg"]);

    // A user read lands in the reserved slot immediately — ahead of the queued
    // realtime, and without waiting for the in-flight bg to finish.
    void scheduler.enqueue(userA, undefined).catch(() => {});
    await flushMicrotasks();
    expect(runner.pending).toBe(2);
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg", "userA"]);

    // The held realtime only runs once a non-reserved slot frees.
    runner.releaseNext();
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toContain("rt");

    await drain();
  });

  test("with only background work, all tasks drain in order through the non-reserved slot (no deadlock)", async () => {
    const settled: string[] = [];
    for (const name of ["bg1", "bg2", "bg3", "bg4"]) {
      const t = makeTask({ name, runner: "io", priority: "background" });
      void scheduler.enqueue(t, undefined).then(() => settled.push(name));
    }
    await flushMicrotasks();
    // cap = 1: one runs, three queue, the reserved slot sits idle. Background is
    // throttled, never blocked — the reservation must not wedge a pool that has
    // only background work and no user to fill the reserved slot.
    expect(runner.pending).toBe(1);
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg1"]);

    runner.releaseNext();
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg1", "bg2"]);
    runner.releaseNext();
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg1", "bg2", "bg3"]);
    runner.releaseNext();
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg1", "bg2", "bg3", "bg4"]);
    runner.releaseNext();
    await flushMicrotasks();
    expect(settled).toEqual(["bg1", "bg2", "bg3", "bg4"]);
  });

  test("an aged background head waits for a non-reserved slot — it never borrows a reserved one", async () => {
    // Background is hard-capped at concurrency − reserved: there is no
    // preemption to evict it from a reserved slot, so the reserved slots stay
    // strictly interactive-only. Even aged past the budget, with the reserved
    // slot idle and no user present, the head must NOT borrow it — it drains
    // only when the non-reserved slot frees.
    const holdBg = makeTask({ name: "bg.hold", runner: "io", priority: "background" });
    const agedBg = makeTask({ name: "bg.aged", runner: "io", priority: "background" });

    void scheduler.enqueue(holdBg, undefined).catch(() => {});
    void scheduler.enqueue(agedBg, undefined).catch(() => {});
    await flushMicrotasks();
    expect(runner.pending).toBe(1); // bg.hold at allotment; bg.aged queued
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg.hold"]);

    // Age bg.aged past the budget and re-fire dispatch (throwaway enqueue).
    // With the reserved slot idle and no user, the floor must still leave it
    // alone — the reserved slot is not background's to take.
    vi.setSystemTime(STARVATION_MIN_INTERVAL_MS * 100 + STARVATION_BUDGET_MS + 5);
    const trigger = makeTask({ name: "bg.trigger", runner: "io", priority: "background" });
    void scheduler.enqueue(trigger, undefined).catch(() => {});
    await flushMicrotasks();
    expect(runner.pending).toBe(1); // still just bg.hold; the reserved slot stays idle
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg.hold"]);
    expect(scheduler.starvationReleases).toBe(0);

    // Freeing the non-reserved slot lets bg.aged drain into it (never a reserved one).
    runner.releaseNext();
    await flushMicrotasks();
    expect(runner.execLog.map((e) => e.name)).toContain("bg.aged");

    await drain();
  });

  test("inflightSummary and snapshot report accurate priorities and queue depth under reservation", async () => {
    const bg1 = makeTask({ name: "bg1", runner: "io", priority: "background" });
    const bg2 = makeTask({ name: "bg2", runner: "io", priority: "background" });
    const userA = makeTask({ name: "userA", runner: "io", priority: "user" });

    void scheduler.enqueue(bg1, undefined).catch(() => {});
    void scheduler.enqueue(bg2, undefined).catch(() => {});
    await flushMicrotasks();
    // One background in flight, one queued (reservation holds it), reserved slot free.
    let io = scheduler.inflightSummary().find((r) => r.runner === "io");
    expect(io?.tasks).toHaveLength(1);
    expect(io?.tasks[0]).toMatchObject({ name: "bg1", priority: "background" });
    let snap = scheduler.snapshot(60).perRunner.find((r) => r.runner === "io");
    expect(snap?.inFlight).toBe(1);
    expect(snap?.queueDepthByPriority.background).toBe(1);

    void scheduler.enqueue(userA, undefined).catch(() => {});
    await flushMicrotasks();
    io = scheduler.inflightSummary().find((r) => r.runner === "io");
    expect(io?.tasks).toHaveLength(2);
    // The counting stays honest across priorities — bg1 background, userA user.
    const byName = Object.fromEntries((io?.tasks ?? []).map((t) => [t.name, t.priority]));
    expect(byName).toEqual({ bg1: "background", userA: "user" });
    snap = scheduler.snapshot(60).perRunner.find((r) => r.runner === "io");
    expect(snap?.inFlight).toBe(2);
    expect(snap?.queueDepthByPriority.background).toBe(1); // bg2 still queued

    await drain();
  });

  test("a runner with no reservation runs background at full width (reserved = 0 short-circuit)", async () => {
    // The scheduler reserves only for io; a writer pool gets no reservation, so
    // its dispatch path must be entirely unchanged — both background tasks run
    // concurrently on the 2-wide pool.
    const writer = new GatedRunner("writer", 2);
    scheduler.registerRunner(writer);
    const w1 = makeTask({ name: "w1", runner: "writer", priority: "background" });
    const w2 = makeTask({ name: "w2", runner: "writer", priority: "background" });
    void scheduler.enqueue(w1, undefined).catch(() => {});
    void scheduler.enqueue(w2, undefined).catch(() => {});
    await flushMicrotasks();
    expect(writer.pending).toBe(2);
    writer.releaseNext();
    writer.releaseNext();
    await flushMicrotasks();
  });

  test("an aged background head does NOT steal the reserved slot from an arriving user", async () => {
    // The sharp case: the anti-starvation floor runs BEFORE the priority loop
    // and can return a background task. Without care it would promote an aged
    // background head into the idle reserved slot ahead of a just-arrived user,
    // defeating the reservation in exactly the sustained-heavy-background
    // scenario it exists for. Background here is AT its allotment (not starved),
    // so the floor must yield the reserved slot to the user.
    const bg1 = makeTask({ name: "bg1", runner: "io", priority: "background" });
    const bgAged = makeTask({ name: "bg.aged", runner: "io", priority: "background" });
    const userA = makeTask({ name: "userA", runner: "io", priority: "user" });

    void scheduler.enqueue(bg1, undefined).catch(() => {});
    void scheduler.enqueue(bgAged, undefined).catch(() => {});
    await flushMicrotasks();
    expect(runner.pending).toBe(1); // bg1 at allotment; bg.aged queued
    expect(runner.execLog.map((e) => e.name)).toEqual(["bg1"]);

    // Age the queued head past the budget so the floor is eligible to fire.
    vi.setSystemTime(STARVATION_MIN_INTERVAL_MS * 100 + STARVATION_BUDGET_MS + 5);

    // A user read arrives. The floor is eligible (aged head, interval elapsed),
    // but background is at allotment — the reserved slot is the user's, not the
    // aged head's.
    void scheduler.enqueue(userA, undefined).catch(() => {});
    await flushMicrotasks();

    expect(runner.execLog.map((e) => e.name)).toEqual(["bg1", "userA"]);
    expect(runner.execLog.map((e) => e.name)).not.toContain("bg.aged");
    expect(scheduler.starvationReleases).toBe(0); // floor yielded to the user
    const snap = scheduler.snapshot(60).perRunner.find((r) => r.runner === "io");
    expect(snap?.queueDepthByPriority.background).toBe(1); // bg.aged still queued

    await drain();
  });

  test("over-reservation is clamped to concurrency − 1 so background always has a slot", async () => {
    // An operator sets ioReservedUserSlots absurdly high (5 on a 2-wide pool).
    // The registration clamp must cap it at concurrency − 1 = 1, leaving one
    // slot for background — never wedging the pool to only the starvation drip.
    const s = new Scheduler({ enablePreemption: false, reservedUserSlotsByRunner: { io: 5 } });
    const r = new GatedRunner("io", 2);
    s.registerRunner(r);
    await s.start();
    const bg1 = makeTask({ name: "bg1", runner: "io", priority: "background" });
    const bg2 = makeTask({ name: "bg2", runner: "io", priority: "background" });
    void s.enqueue(bg1, undefined).catch(() => {});
    void s.enqueue(bg2, undefined).catch(() => {});
    await flushMicrotasks();
    // Clamped to 1 ⇒ background cap = 2 − 1 = 1: bg1 runs, bg2 queues. Without
    // the clamp, reserved=5 would make reservationBlocksNonUser always true
    // and NO fresh background could dispatch (pending would be 0).
    expect(r.pending).toBe(1);
    expect(r.execLog.map((e) => e.name)).toEqual(["bg1"]);
    r.releaseNext();
    await flushMicrotasks();
    expect(r.execLog.map((e) => e.name)).toEqual(["bg1", "bg2"]);
    r.releaseNext();
    await flushMicrotasks();
    await s.dispose();
  });
});
