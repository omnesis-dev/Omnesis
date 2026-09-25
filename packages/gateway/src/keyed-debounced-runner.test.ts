// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach } from "vitest";

import { KeyedDebouncedRunner } from "./keyed-debounced-runner.js";

/**
 * Drain pending microtasks so the runner's `startRun` chain
 * (Promise.catch().then().catch().finally()) finishes posting to the
 * mocks before assertions.
 */
async function drainMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

class FakeScheduler {
  private nextHandle = 1;
  readonly timers = new Map<number, { fn: () => void; ms: number }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const handle = this.nextHandle++;
    this.timers.set(handle, { fn, ms });
    return handle;
  };
  clearTimeout = (h: unknown): void => {
    this.timers.delete(h as number);
  };
  /** Fire every pending timer in insertion order. */
  fireAll(): void {
    const handles = [...this.timers.keys()];
    for (const h of handles) {
      const t = this.timers.get(h);
      if (!t) continue;
      this.timers.delete(h);
      t.fn();
    }
  }
  size(): number {
    return this.timers.size;
  }
}

interface Harness {
  runner: KeyedDebouncedRunner;
  runs: string[];
  errors: Array<{ key: string; err: unknown }>;
}

function makeHarness(
  sched: FakeScheduler,
  opts: { run?: (key: string) => Promise<void>; debounceMs?: number } = {},
): Harness {
  const runs: string[] = [];
  const errors: Array<{ key: string; err: unknown }> = [];
  const runner = new KeyedDebouncedRunner({
    debounceMs: opts.debounceMs ?? 3_000,
    scheduler: { setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout },
    run:
      opts.run ??
      (async (key) => {
        runs.push(key);
      }),
    onError: (key, err) => errors.push({ key, err }),
  });
  return { runner, runs, errors };
}

describe("KeyedDebouncedRunner", () => {
  let sched: FakeScheduler;
  beforeEach(() => {
    sched = new FakeScheduler();
  });

  test("enqueue installs a timer; firing invokes run for the key", async () => {
    const h = makeHarness(sched);
    h.runner.enqueue("k1");
    expect(sched.size()).toBe(1);
    expect(h.runs).toHaveLength(0);

    sched.fireAll();
    await drainMicrotasks();
    expect(h.runs).toEqual(["k1"]);
  });

  test("repeated enqueue for the same key coalesces into one timer", () => {
    const h = makeHarness(sched);
    h.runner.enqueue("k1");
    h.runner.enqueue("k1");
    h.runner.enqueue("k1");
    expect(sched.size()).toBe(1);
    expect(h.runner.pendingCount()).toBe(1);
  });

  test("distinct keys debounce independently", () => {
    const h = makeHarness(sched);
    h.runner.enqueue("k1");
    h.runner.enqueue("k2");
    expect(sched.size()).toBe(2);
    expect(h.runner.pendingCount()).toBe(2);
  });

  test("flush runs the pending work immediately and removes the timer", async () => {
    const h = makeHarness(sched);
    h.runner.enqueue("k1");
    await h.runner.flush("k1");
    expect(h.runs).toEqual(["k1"]);
    expect(sched.size()).toBe(0);
    expect(h.runner.pendingCount()).toBe(0);
  });

  test("flush with nothing pending and nothing in flight is a no-op", async () => {
    const h = makeHarness(sched);
    await h.runner.flush("k1");
    expect(h.runs).toHaveLength(0);
  });

  test("cancelPending drops a key's timer without running it", async () => {
    const h = makeHarness(sched);
    h.runner.enqueue("k1");
    h.runner.enqueue("k2");
    await h.runner.cancelPending("k1");
    expect(h.runner.pendingCount()).toBe(1);
    sched.fireAll();
    await drainMicrotasks();
    expect(h.runs).toEqual(["k2"]);
  });

  test("cancelPending awaits an already-running run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runs: string[] = [];
    const h = makeHarness(sched, {
      run: async (key) => {
        runs.push(key);
        await gate;
      },
    });
    h.runner.enqueue("k1");
    sched.fireAll();
    await drainMicrotasks();
    expect(runs).toHaveLength(1);
    expect(h.runner.inflightCount()).toBe(1);

    let cancelResolved = false;
    const cancelPromise = h.runner.cancelPending("k1").then(() => {
      cancelResolved = true;
    });
    await drainMicrotasks();
    expect(cancelResolved).toBe(false);

    release();
    await cancelPromise;
    expect(cancelResolved).toBe(true);
    expect(h.runner.inflightCount()).toBe(0);
  });

  test("two enqueues for the same key serialize through the inflight chain", async () => {
    const releaseGates: Array<() => void> = [];
    const runs: string[] = [];
    const h = makeHarness(sched, {
      run: async (key) => {
        runs.push(key);
        await new Promise<void>((r) => releaseGates.push(r));
      },
    });
    h.runner.enqueue("k1");
    sched.fireAll();
    await drainMicrotasks();
    expect(runs).toHaveLength(1);

    // Second enqueue while the first run is blocked: it must chain,
    // not run concurrently.
    h.runner.enqueue("k1");
    sched.fireAll();
    await drainMicrotasks();
    expect(runs).toHaveLength(1);

    releaseGates[0]?.();
    await drainMicrotasks();
    expect(runs).toHaveLength(2);
    releaseGates[1]?.();
  });

  test("flushAll flushes every pending key and awaits in-flight runs", async () => {
    const h = makeHarness(sched);
    h.runner.enqueue("k1");
    h.runner.enqueue("k2");
    await h.runner.flushAll();
    expect(h.runs.sort()).toEqual(["k1", "k2"]);
    expect(h.runner.pendingCount()).toBe(0);
    expect(h.runner.inflightCount()).toBe(0);
  });

  test("dispose refuses subsequent enqueues", () => {
    const h = makeHarness(sched);
    h.runner.dispose();
    h.runner.enqueue("k1");
    expect(h.runner.pendingCount()).toBe(0);
    expect(sched.size()).toBe(0);
  });

  test("a rejecting run reaches onError and the key's chain survives", async () => {
    let calls = 0;
    const h = makeHarness(sched, {
      run: async (key) => {
        calls += 1;
        if (calls === 1) throw new Error("ingest exploded");
        void key;
      },
    });
    h.runner.enqueue("k1");
    await h.runner.flush("k1");
    expect(h.errors).toHaveLength(1);
    expect((h.errors[0]!.err as Error).message).toBe("ingest exploded");

    // A subsequent enqueue for the same key still runs.
    h.runner.enqueue("k1");
    await h.runner.flush("k1");
    expect(calls).toBe(2);
    expect(h.errors).toHaveLength(1);
    expect(h.runner.inflightCount()).toBe(0);
  });
});
