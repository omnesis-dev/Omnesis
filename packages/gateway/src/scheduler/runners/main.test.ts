// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * MainTaskRunner integration test — verifies the Scheduler + a real
 * runner work together end-to-end on the main thread (no worker).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Scheduler } from "../scheduler.js";
import { MainTaskRunner } from "./main.js";
import type { Task, TaskOutcome } from "../types.js";

describe("MainTaskRunner — end-to-end with Scheduler", () => {
  let scheduler: Scheduler;

  beforeEach(async () => {
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(new MainTaskRunner({ concurrency: 4 }));
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
  });

  test("runs a task to completion and returns its value", async () => {
    const t: Task<{ n: number }, number> = {
      name: "main.double",
      runner: "main",
      priority: "user",
      async run({ n }): Promise<TaskOutcome<{ n: number }, number>> {
        return { kind: "done", value: n * 2 };
      },
    };
    expect(await scheduler.enqueue(t, { n: 21 })).toBe(42);
  });

  test("runs up to concurrency tasks in parallel", async () => {
    const startedAt: number[] = [];
    const completed: number[] = [];

    const t: Task<{ id: number; holdMs: number }, number> = {
      name: "main.parallel",
      runner: "main",
      priority: "user",
      async run({ id, holdMs }) {
        startedAt.push(Date.now());
        await new Promise((r) => setTimeout(r, holdMs));
        completed.push(id);
        return { kind: "done", value: id };
      },
    };
    const start = Date.now();
    const promises = [1, 2, 3, 4].map((id) => scheduler.enqueue(t, { id, holdMs: 50 }));
    const results = await Promise.all(promises);
    const totalMs = Date.now() - start;
    // Concurrency=4 + holdMs=50: all four ran in ~50ms, not 200ms.
    expect(totalMs).toBeLessThan(150);
    expect(results).toEqual([1, 2, 3, 4]);
  });

  test("propagates errors as TaskExecutionError", async () => {
    const t: Task<void, void> = {
      name: "main.boom",
      runner: "main",
      priority: "user",
      async run() {
        throw new Error("nope");
      },
    };
    await expect(scheduler.enqueue(t, undefined)).rejects.toThrow("nope");
  });
});

describe("MainTaskRunner — dispose drains in-flight tasks", () => {
  test("aborts ctx.signal on dispose; tasks that respect the signal short-circuit", async () => {
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(new MainTaskRunner({ concurrency: 4 }));
    await scheduler.start();

    let aborted = false;
    const t: Task<void, void> = {
      name: "main.respectful",
      runner: "main",
      priority: "user",
      async run(_args, ctx) {
        await new Promise<void>((resolve, reject) => {
          if (ctx.signal.aborted) {
            aborted = true;
            return reject(new Error("aborted"));
          }
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
          // never settle on its own — only abort can resolve us.
        });
        return { kind: "done", value: undefined };
      },
    };
    const p = scheduler.enqueue(t, undefined).catch(() => undefined);
    // Yield once so exec() actually starts the task.
    await new Promise((r) => setImmediate(r));
    await scheduler.dispose();
    await p;
    expect(aborted).toBe(true);
  });

  test("dispose awaits in-flight tasks up to the timeout cap", async () => {
    const scheduler = new Scheduler({ enablePreemption: false });
    // Tiny cap so the test finishes fast even with hung tasks.
    scheduler.registerRunner(new MainTaskRunner({ concurrency: 4, disposeTimeoutMs: 50 }));
    await scheduler.start();

    const t: Task<void, void> = {
      name: "main.stubborn",
      runner: "main",
      priority: "user",
      async run() {
        // Ignore ctx.signal — the dispose path must not hang on this.
        await new Promise((r) => setTimeout(r, 5_000));
        return { kind: "done", value: undefined };
      },
    };
    void scheduler.enqueue(t, undefined).catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    const start = Date.now();
    await scheduler.dispose();
    // Cap is 50ms; allow generous slack for CI noise.
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});
