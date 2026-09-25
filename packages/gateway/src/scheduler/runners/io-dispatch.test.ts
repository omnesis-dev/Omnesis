// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * IoTaskRunner dispatch-routing unit test.
 *
 * Uses a fake worker (via the `createWorker` seam) to assert the runner routes
 * each call to an *idle* worker rather than a static `id % N` slot. Under the
 * old static assignment, a worker stuck on a slow op collected every N-th call
 * behind it while its peers idled — the exact way a user read ended up queued
 * behind a minutes-long background reconcile. These tests pin the fix without
 * spawning real worker threads, so they are fully deterministic.
 */

import { EventEmitter } from "node:events";
import { createLogger } from "@omnesis/core";
import { afterEach, describe, expect, test } from "vitest";
import { IoTaskRunner } from "./io.js";
import type { Task, TaskContext, TaskOutcome } from "../types.js";

/** Minimal fake of the main-side `Worker` handle for one io worker thread. */
class FakeWorker extends EventEmitter {
  public readonly calls: Array<{ id: number; op: string; args: unknown[] }> = [];

  postMessage(msg: { type: string; id?: number; op?: string; args?: unknown[] }): void {
    if (msg.type === "init") {
      // Simulate the worker booting and reporting ready.
      queueMicrotask(() => this.emit("message", { type: "ready" }));
    } else if (msg.type === "call") {
      this.calls.push({ id: msg.id!, op: msg.op!, args: msg.args! });
    } else if (msg.type === "shutdown") {
      queueMicrotask(() => this.emit("message", { type: "shutdownComplete" }));
    }
  }

  terminate(): void {}

  /** Test control: settle the call with id `id` successfully. */
  complete(id: number, value: unknown): void {
    this.emit("message", { type: "result", id, ok: true, value });
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeCtx(): TaskContext {
  return {
    shouldYield: () => false,
    elapsedMs: () => 0,
    signal: new AbortController().signal,
    log: createLogger("test"),
  };
}

function makeTask(name: string): Task<unknown[], unknown> {
  return {
    name,
    runner: "io",
    priority: "user",
    async run(): Promise<TaskOutcome<unknown[], unknown>> {
      throw new Error("worker tasks don't run on main");
    },
  };
}

describe("IoTaskRunner — idle-worker routing", () => {
  let runner: IoTaskRunner;

  afterEach(async () => {
    await runner.dispose();
  });

  async function startRunner(concurrency: number): Promise<FakeWorker[]> {
    const fakes: FakeWorker[] = [];
    runner = new IoTaskRunner({
      gatewayDbPath: "/dev/null",
      concurrency,
      workerUrl: new URL("file:///fake-io-worker"),
      createWorker: () => {
        const f = new FakeWorker();
        fakes.push(f);
        return f as unknown as import("node:worker_threads").Worker;
      },
    });
    await runner.start();
    return fakes;
  }

  test("routes a second call to an idle worker, never behind a busy one", async () => {
    const fakes = await startRunner(2);

    // Call A occupies worker 0 and is never completed (simulates a slow op).
    void runner.exec(makeTask("a"), [], makeCtx()).catch(() => {});
    await flushMicrotasks();
    expect(fakes[0].calls.map((c) => c.op)).toEqual(["a"]);
    expect(fakes[1].calls).toEqual([]);

    // Call B must go to the idle worker 1 — not queue behind A on worker 0.
    void runner.exec(makeTask("b"), [], makeCtx()).catch(() => {});
    await flushMicrotasks();
    expect(fakes[0].calls.map((c) => c.op)).toEqual(["a"]);
    expect(fakes[1].calls.map((c) => c.op)).toEqual(["b"]);
  });

  test("a fast call finishes while a slow call still occupies its own worker", async () => {
    const fakes = await startRunner(2);

    void runner.exec(makeTask("slow"), [], makeCtx()).catch(() => {}); // worker 0, never completed
    const fastResult = runner.exec(makeTask("fast"), [], makeCtx()); // worker 1
    await flushMicrotasks();

    const fastId = fakes[1].calls[0]!.id;
    fakes[1].complete(fastId, "done");
    await expect(fastResult).resolves.toMatchObject({ kind: "done", value: "done" });
  });

  test("queues past capacity and drains to whichever worker frees first", async () => {
    const fakes = await startRunner(2);

    // Three calls, two workers: A→w0, B→w1, C waits (both busy).
    void runner.exec(makeTask("a"), [], makeCtx()).catch(() => {});
    void runner.exec(makeTask("b"), [], makeCtx()).catch(() => {});
    void runner.exec(makeTask("c"), [], makeCtx()).catch(() => {});
    await flushMicrotasks();
    expect(fakes[0].calls.map((c) => c.op)).toEqual(["a"]);
    expect(fakes[1].calls.map((c) => c.op)).toEqual(["b"]);

    // Free worker 0 by completing A; the queued C drains onto worker 0.
    const aId = fakes[0].calls[0]!.id;
    fakes[0].complete(aId, null);
    await flushMicrotasks();
    expect(fakes[0].calls.map((c) => c.op)).toEqual(["a", "c"]);
    expect(fakes[1].calls.map((c) => c.op)).toEqual(["b"]);
  });
});
