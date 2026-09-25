// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * CpuTaskRunner integration test — spawns real CPU workers and
 * verifies Scheduler + CpuTaskRunner work end-to-end.
 *
 * Validates:
 *   - `cpu.echo` returns its arg unchanged (smoke for envelope).
 *   - Unknown op surfaces as TaskExecutionError.
 *   - Concurrent dispatch across multiple workers (concurrency > 1).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Scheduler } from "../scheduler.js";
import { TaskExecutionError } from "../types.js";
import { CpuTaskRunner } from "./cpu.js";
import type { Task, TaskOutcome } from "../types.js";

const WORKER_URL = new URL("../../workers/cpu-worker.ts", import.meta.url);
const LOADER_URL = new URL("../../workers/register-tsx.mjs", import.meta.url).href;

describe("CpuTaskRunner — end-to-end with Scheduler", () => {
  let scheduler: Scheduler;
  let runner: CpuTaskRunner;

  beforeEach(async () => {
    runner = new CpuTaskRunner({
      concurrency: 2,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    });
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
  });

  test("dispatches `cpu.echo` and resolves with arg", async () => {
    const t: Task<unknown[], unknown> = {
      name: "cpu.echo",
      runner: "cpu",
      priority: "background",
      async run(): Promise<TaskOutcome<unknown[], unknown>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    const value = await scheduler.enqueue(t, ["hello"]);
    expect(value).toBe("hello");
  });

  test("echo handles structured data", async () => {
    const t: Task<unknown[], unknown> = {
      name: "cpu.echo",
      runner: "cpu",
      priority: "background",
      async run(): Promise<TaskOutcome<unknown[], unknown>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    const payload = { numbers: [1, 2, 3], nested: { flag: true } };
    const value = await scheduler.enqueue(t, [payload]);
    expect(value).toEqual(payload);
  });

  test("unknown op surfaces as TaskExecutionError", async () => {
    const t: Task<unknown[], unknown> = {
      name: "not.a.real.cpu.op",
      runner: "cpu",
      priority: "background",
      async run(): Promise<TaskOutcome<unknown[], unknown>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    await expect(scheduler.enqueue(t, [])).rejects.toThrow(TaskExecutionError);
  });

  test("processes multiple tasks concurrently (concurrency=2)", async () => {
    const t: Task<unknown[], unknown> = {
      name: "cpu.echo",
      runner: "cpu",
      priority: "background",
      async run(): Promise<TaskOutcome<unknown[], unknown>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    const results = await Promise.all([
      scheduler.enqueue(t, ["a"]),
      scheduler.enqueue(t, ["b"]),
      scheduler.enqueue(t, ["c"]),
      scheduler.enqueue(t, ["d"]),
    ]);
    expect(results).toEqual(["a", "b", "c", "d"]);
  });
});
