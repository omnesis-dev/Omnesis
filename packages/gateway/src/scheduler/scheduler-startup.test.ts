// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { Scheduler } from "./scheduler.js";
import { SchedulerCore } from "./core.js";
import { MainTaskRunner } from "./runners/main.js";
import type { PeriodicTask } from "./types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function periodic(run: PeriodicTask<void, void>["run"]): PeriodicTask<void, void> {
  return {
    name: "startup.lifecycle",
    runner: "main",
    priority: "background",
    initialArgs: undefined,
    periodMs: 1_000,
    run,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Scheduler façade startup lifecycle", () => {
  it("makes every disposal caller await the actual runner cleanup", async () => {
    const scheduler = new Scheduler();
    const runner = new MainTaskRunner();
    const cleanupEntered = deferred();
    const cleanupAllowed = deferred();
    vi.spyOn(runner, "dispose").mockImplementation(async () => {
      cleanupEntered.resolve();
      await cleanupAllowed.promise;
    });
    scheduler.registerRunner(runner);
    await scheduler.start();
    let firstFinished = false;
    let secondFinished = false;
    const first = scheduler.dispose().then(() => {
      firstFinished = true;
    });
    await cleanupEntered.promise;
    const second = scheduler.dispose().then(() => {
      secondFinished = true;
    });
    await Promise.resolve();
    expect(firstFinished).toBe(false);
    expect(secondFinished).toBe(false);
    cleanupAllowed.resolve();
    await Promise.all([first, second]);
    expect(firstFinished).toBe(true);
    expect(secondFinished).toBe(true);
    expect(runner.dispose).toHaveBeenCalledOnce();
  });

  it("rejects startup if disposal wins between core readiness and façade activation", async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler();
    scheduler.registerRunner(new MainTaskRunner());
    const run = vi.fn(async () => ({ kind: "done" as const, value: undefined }));
    scheduler.schedule(periodic(run));
    const startCore = SchedulerCore.prototype.start;
    let disposal: Promise<void> | undefined;
    // Inject disposal at the production core-ready boundary, retaining the
    // actual core and runner initialization rather than mocking their result.
    vi.spyOn(SchedulerCore.prototype, "start").mockImplementation(function (this: SchedulerCore) {
      return startCore.call(this).then(() => {
        disposal = scheduler.dispose();
      });
    });
    await expect(scheduler.start()).rejects.toThrow("disposed during startup");
    await disposal;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(scheduler.start()).rejects.toThrow("scheduler disposed");
  });

  it("activates periodics once when startup callers overlap or startup is requested again", async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler();
    scheduler.registerRunner(new MainTaskRunner());
    const run = vi.fn(async () => ({ kind: "done" as const, value: undefined }));
    scheduler.schedule(periodic(run));
    const first = scheduler.start();
    const second = scheduler.start();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    await scheduler.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps pre-registered periodic work stopped when disposal interrupts runner startup", async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler();
    const runner = new MainTaskRunner();
    const entered = deferred();
    const release = deferred();
    vi.spyOn(runner, "start").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    scheduler.registerRunner(runner);
    const run = vi.fn(async () => ({ kind: "done" as const, value: undefined }));
    scheduler.schedule(periodic(run));
    const starting = scheduler.start();
    const rejected = expect(starting).rejects.toThrow("disposed during startup");
    await entered.promise;
    const disposal = scheduler.dispose();
    release.resolve();
    await Promise.all([rejected, disposal]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans façade wake timers when failed core initialization already disposed the runners", async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler();
    const runner = new MainTaskRunner();
    vi.spyOn(runner, "start").mockRejectedValue(new Error("initialization failed"));
    scheduler.registerRunner(runner);
    const run = vi.fn(async () => ({ kind: "done" as const, value: undefined }));
    scheduler.registerWakeable({
      ...periodic(run),
      name: "startup.wake",
      debounceMs: 1_000,
    });
    scheduler.wake("startup.wake");
    expect(vi.getTimerCount()).toBe(1);
    await expect(scheduler.start()).rejects.toThrow("initialization failed");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run).not.toHaveBeenCalled();
  });
});
