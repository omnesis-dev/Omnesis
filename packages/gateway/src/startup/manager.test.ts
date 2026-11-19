// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { StartupInterruptedError, StartupManager, type StartupStepId } from "./manager.js";

function completeThrough(manager: StartupManager, last: StartupStepId): void {
  for (const step of manager.snapshot().steps) {
    if (step.state === "pending") {
      expect(manager.start(step.id)).toBe(true);
      expect(manager.succeed(step.id)).toBe(true);
    }
    if (step.id === last) break;
  }
}

function step(manager: StartupManager, id: StartupStepId) {
  return manager.snapshot().steps.find((candidate) => candidate.id === id)!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

describe("StartupManager", () => {
  it("starts with a complete public plan and independent boot identity", () => {
    const manager = new StartupManager({ now: () => 100 });
    const initial = manager.snapshot();
    expect(initial).toMatchObject({ sequence: 0, startedAt: 100, state: "starting" });
    expect(initial.steps).toHaveLength(15);
    expect(initial.steps.every((entry) => entry.state === "pending")).toBe(true);
    expect(initial.steps.filter((entry) => entry.optional).map((entry) => entry.id)).toEqual([
      "repairs",
      "indexer",
    ]);
    expect(new StartupManager().snapshot().bootId).not.toBe(initial.bootId);
  });

  it("requires prerequisite completion and never starts an operation twice", async () => {
    const manager = new StartupManager();
    const execute = vi.fn(async () => "unexpected");
    await expect(manager.run("storage", execute)).rejects.toThrow("unfinished dependencies");
    expect(execute).not.toHaveBeenCalled();
    expect(manager.snapshot().sequence).toBe(0);
    expect(() => manager.succeed("launcher")).toThrow("not running");
    manager.start("launcher");
    expect(() => manager.start("launcher")).toThrow("cannot start twice");
    expect(() => manager.start("ownership")).toThrow("unfinished dependencies");
    manager.succeed("launcher");
    expect(() => manager.start("launcher")).toThrow("cannot start twice");
    manager.start("ownership");
    manager.succeed("ownership");
    expect(step(manager, "ownership").state).toBe("succeeded");
  });

  it("records operation boundaries and returns the original result", async () => {
    let now = 100;
    const manager = new StartupManager({ now: () => now });
    const result = { count: 3 };
    expect(
      await manager.run("launcher", async () => {
        expect(step(manager, "launcher")).toMatchObject({ state: "running", startedAt: 100 });
        now = 155;
        return result;
      }),
    ).toBe(result);
    expect(step(manager, "launcher")).toMatchObject({
      state: "succeeded",
      startedAt: 100,
      finishedAt: 155,
    });
    expect(manager.snapshot().sequence).toBe(2);
  });

  it("allows independent branches to overlap and blocks their dependent until both finish", async () => {
    const manager = new StartupManager();
    completeThrough(manager, "search");
    const analytics = deferred<string>();
    const inventory = deferred<number>();
    const analyticsRun = manager.run("analytics", () => analytics.promise);
    const inventoryRun = manager.run("models", () => inventory.promise);
    expect(step(manager, "analytics").state).toBe("running");
    expect(step(manager, "models").state).toBe("running");
    expect(() => manager.start("agent")).toThrow("unfinished dependencies");
    analytics.resolve("analytics open");
    expect(await analyticsRun).toBe("analytics open");
    manager.start("agent");
    manager.succeed("agent");
    expect(() => manager.start("services")).toThrow("unfinished dependencies");
    inventory.resolve(2);
    expect(await inventoryRun).toBe(2);
    manager.start("services");
    manager.succeed("services");
  });

  it("never marks the portal ready before required barriers finish", () => {
    const manager = new StartupManager();
    expect(() => manager.ready()).toThrow("unfinished");
    completeThrough(manager, "services");
    manager.start("portal");
    expect(() => manager.ready()).toThrow("unfinished");
    manager.succeed("portal");
    expect(manager.snapshot().state).toBe("starting");
    expect(manager.ready()).toBe(true);
    const readySequence = manager.snapshot().sequence;
    expect(manager.ready()).toBe(true);
    expect(manager.snapshot().sequence).toBe(readySequence);
    expect(manager.snapshot().state).toBe("ready");
    expect(step(manager, "repairs").state).toBe("pending");
    expect(step(manager, "indexer").state).toBe("pending");
  });

  it("only skips optional steps and explicitly skipped optional dependencies are satisfied", () => {
    const manager = new StartupManager();
    expect(() => manager.skip("storage")).toThrow("cannot be skipped");
    completeThrough(manager, "portal");
    manager.ready();
    expect(manager.skip("repairs")).toBe(true);
    expect(() => manager.skip("repairs")).toThrow("cannot be skipped");
    expect(manager.start("indexer")).toBe(true);
    expect(() => manager.skip("indexer")).toThrow("cannot be skipped");
    manager.succeed("indexer");
    expect(manager.snapshot().state).toBe("ready");
  });

  it("retains the actual required failure without publishing arbitrary exception text", async () => {
    const manager = new StartupManager();
    const original = new Error("Private path /tmp/example and an invented secret");
    await expect(
      manager.run("launcher", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    const snapshot = manager.snapshot();
    expect(snapshot.state).toBe("failed");
    expect(step(manager, "launcher")).toMatchObject({
      state: "failed",
      code: "STARTUP_STEP_FAILED",
    });
    expect(snapshot.steps.slice(1).every((entry) => entry.state === "blocked")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("Private path");
    expect(JSON.stringify(snapshot)).not.toContain("invented secret");
    expect(manager.start("ownership")).toBe(false);
    expect(manager.succeed("launcher")).toBe(false);
    expect(manager.ready()).toBe(false);
  });

  it("does not let a concurrent late completion overwrite a required failure", async () => {
    const manager = new StartupManager();
    completeThrough(manager, "search");
    const analytics = deferred<void>();
    const inventory = deferred<void>();
    const analyticsRun = manager.run("analytics", () => analytics.promise);
    const inventoryRun = manager.run("models", () => inventory.promise);
    const failure = new Error("inventory failed");
    inventory.reject(failure);
    await expect(inventoryRun).rejects.toBe(failure);
    expect(step(manager, "analytics").state).toBe("blocked");
    const sequence = manager.snapshot().sequence;
    analytics.resolve();
    await expect(analyticsRun).rejects.toBeInstanceOf(StartupInterruptedError);
    expect(step(manager, "analytics").state).toBe("blocked");
    expect(manager.snapshot().sequence).toBe(sequence);
  });

  it("keeps core readiness after optional failure and blocks only its descendants", async () => {
    const manager = new StartupManager();
    completeThrough(manager, "portal");
    manager.ready();
    const failure = new Error("maintenance failed");
    await expect(
      manager.run("repairs", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(manager.snapshot().state).toBe("ready");
    expect(step(manager, "repairs").state).toBe("failed");
    expect(step(manager, "indexer").state).toBe("blocked");
    expect(step(manager, "portal").state).toBe("succeeded");
  });

  it("stops admission and ignores late progress/completions without rewriting completed history", async () => {
    const manager = new StartupManager();
    completeThrough(manager, "configuration");
    const migration = deferred<void>();
    const run = manager.run("storage", () => migration.promise);
    manager.migration({ phase: "started", current: 1, total: 2, completed: 0 });
    manager.stop();
    const stopped = manager.snapshot();
    expect(stopped.state).toBe("stopping");
    expect(step(manager, "configuration").state).toBe("succeeded");
    expect(step(manager, "storage").state).toBe("blocked");
    manager.stop();
    manager.migration({ phase: "committed", current: 1, total: 2, completed: 1 });
    expect(manager.snapshot()).toEqual(stopped);
    migration.resolve();
    await expect(run).rejects.toBeInstanceOf(StartupInterruptedError);
    expect(manager.snapshot()).toEqual(stopped);
    const execute = vi.fn(async () => undefined);
    await expect(manager.run("workers", execute)).rejects.toBeInstanceOf(StartupInterruptedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns independent snapshots including nested dependencies and migration counters", () => {
    const manager = new StartupManager();
    completeThrough(manager, "configuration");
    manager.start("storage");
    manager.migration({ phase: "started", current: 1, total: 2, completed: 0 });
    const snapshot = manager.snapshot();
    snapshot.state = "ready";
    snapshot.steps[0]!.label = "edited label";
    snapshot.steps[1]!.dependsOn.length = 0;
    snapshot.steps.find((entry) => entry.id === "storage")!.progress!.completed = 2;
    snapshot.steps.length = 0;
    expect(manager.snapshot().state).toBe("starting");
    expect(step(manager, "ownership").dependsOn).toEqual(["launcher"]);
    expect(step(manager, "launcher").label).not.toBe("edited label");
    expect(step(manager, "storage").progress).toEqual({ current: 1, total: 2, completed: 0 });
    expect(manager.snapshot().steps).toHaveLength(15);
  });

  it("reports committed migration counts without exposing descriptions or schema versions", () => {
    const manager = new StartupManager();
    completeThrough(manager, "configuration");
    manager.start("storage");
    manager.migration({ phase: "planned", current: 0, total: 2, completed: 0 });
    manager.migration({ phase: "started", current: 1, total: 2, completed: 0, version: 100 });
    expect(step(manager, "storage").progress).toEqual({ current: 1, total: 2, completed: 0 });
    manager.migration({ phase: "committed", current: 1, total: 2, completed: 1, version: 100 });
    manager.migration({ phase: "started", current: 2, total: 2, completed: 1, version: 101 });
    manager.migration({ phase: "failed", current: 2, total: 2, completed: 1, version: 101 });
    expect(step(manager, "storage").progress).toEqual({ current: 2, total: 2, completed: 1 });
    expect(JSON.stringify(manager.snapshot())).not.toContain('"version"');
    manager.fail("storage");
    manager.migration({ phase: "committed", current: 2, total: 2, completed: 2 });
    expect(step(manager, "storage").progress?.completed).toBe(1);
  });

  it("rejects invalid or backwards migration counters and ignores progress outside storage preparation", () => {
    const manager = new StartupManager();
    const event = { phase: "started", current: 1, total: 2, completed: 0 } as const;
    manager.migration(event);
    expect(step(manager, "storage").progress).toBeUndefined();
    completeThrough(manager, "configuration");
    manager.start("storage");
    manager.migration(event);
    expect(() => manager.migration({ ...event, current: 3 })).toThrow("Invalid");
    expect(() => manager.migration({ ...event, total: Number.NaN })).toThrow("Invalid");
    expect(() => manager.migration({ ...event, completed: -1 })).toThrow("Invalid");
    expect(() => manager.migration({ ...event, current: 1.5 })).toThrow("Invalid");
    expect(() => manager.migration({ ...event, phase: "committed" })).toThrow("Invalid");
    expect(() => manager.migration({ ...event, total: 3 })).toThrow("backwards");
    manager.migration({ ...event, phase: "committed", completed: 1 });
    expect(() => manager.migration(event)).toThrow("backwards");
    manager.succeed("storage");
    const sequence = manager.snapshot().sequence;
    manager.migration({ phase: "committed", current: 2, total: 2, completed: 2 });
    expect(manager.snapshot().sequence).toBe(sequence);
  });
});
