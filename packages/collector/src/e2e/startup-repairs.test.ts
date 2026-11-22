// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { StartupManager } from "@omnesis/gateway/src/startup/manager.js";
import { DeferredStartupTasks } from "@omnesis/gateway/src/startup/deferred-tasks.js";
import { BackgroundJobsRegistry } from "@omnesis/gateway/src/background-jobs/registry.js";
import { PeriodicScheduler } from "@omnesis/gateway/src/scheduler/periodic-scheduler.js";
import { waitForStartupRepairs, type StartupRepairsSnapshot } from "./startup-repairs.js";
import type { PeriodicTask } from "@omnesis/gateway/src/scheduler/types.js";

const groups: DeferredStartupTasks[] = [];
const schedulers: PeriodicScheduler[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const group of groups.splice(0)) group.stop();
  for (const scheduler of schedulers.splice(0)) scheduler.stopAll();
  vi.useRealTimers();
});

function repairStartup() {
  const startup = new StartupManager();
  for (const step of startup.snapshot().steps) {
    if (step.id === "repairs") break;
    startup.start(step.id);
    startup.succeed(step.id);
  }
  startup.ready();
  startup.start("repairs");
  return startup;
}

describe("background readiness after startup repairs", () => {
  it("does not kick a catalog-visible periodic until the actual repair barrier releases it", async () => {
    const startup = repairStartup();
    const group = new DeferredStartupTasks();
    groups.push(group);
    const enqueue = vi.fn(async () => true as never);
    const periodic = new PeriodicScheduler(enqueue);
    schedulers.push(periodic);
    const task: PeriodicTask<void, boolean> = {
      name: "absence.sweep",
      runner: "io",
      priority: "background",
      initialArgs: undefined,
      periodMs: 60_000,
      startDelayMs: 60_000,
      async run() {
        return { kind: "done", value: true };
      },
    };
    group.defer(() => periodic.schedule(task, true));
    const catalog = new BackgroundJobsRegistry({ log: createLogger("test:startup") });
    catalog.register({
      id: task.name,
      displayName: "Absence sweep",
      description: "Example periodic",
      category: "infra",
      cadence: { mode: "periodic", intervalMs: 60_000 },
      observe: () => ({
        state: "idle",
        inFlight: false,
        ticksLastHour: 0,
        avgTickMs: 0,
        p99TickMs: 0,
        progress: { kind: "stateless" },
      }),
    });
    expect(startup.snapshot().state).toBe("ready");
    expect(catalog.snapshot().jobs.some((job) => job.id === task.name)).toBe(true);
    await expect(periodic.kickAndWait(task.name, 1000)).rejects.toThrow("no live periodic");

    const read = vi.fn(async (path: string): Promise<StartupRepairsSnapshot> => {
      if (path === "/.well-known/omnesis-startup") return startup.snapshot();
      if (path === "/admin/background-jobs")
        return catalog.snapshot() as unknown as StartupRepairsSnapshot;
      throw new Error("Unexpected readiness endpoint");
    });
    let settled = false;
    const result = waitForStartupRepairs(read).then(() => periodic.kickAndWait(task.name, 1000));
    const observed = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    void observed.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();

    startup.succeed("repairs");
    group.start();
    await vi.advanceTimersByTimeAsync(101);
    expect(await observed).toEqual({ value: true });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith("/.well-known/omnesis-startup");
  });

  it("fails on an explicit repair failure instead of masking it as a task timeout", async () => {
    const startup = repairStartup();
    startup.fail("repairs");
    await expect(waitForStartupRepairs(async () => startup.snapshot())).rejects.toThrow(
      "startup repairs failed",
    );
  });

  it("propagates a genuine transport failure without retrying it", async () => {
    const read = vi.fn(async () => {
      throw new Error("Invented transport failure");
    });
    await expect(waitForStartupRepairs(read)).rejects.toThrow("Invented transport failure");
    expect(read).toHaveBeenCalledOnce();
  });

  it("retains the bounded wait when repairs never finish", async () => {
    const startup = repairStartup();
    const waiting = waitForStartupRepairs(async () => startup.snapshot(), 200);
    const assertion = expect(waiting).rejects.toThrow("Timeout waiting for");
    void assertion.catch(() => {});
    await vi.advanceTimersByTimeAsync(201);
    await assertion;
  });
});
