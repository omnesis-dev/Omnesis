// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { SchedulerCore } from "./core.js";
import type { TaskRunner } from "./runner.js";
import type { RunnerKind } from "./types.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

function runner(kind: RunnerKind, gate = deferred()) {
  const entered = deferred();
  const instance = {
    kind,
    concurrency: 1,
    start: vi.fn(async () => {
      entered.resolve();
      await gate.promise;
    }),
    dispose: vi.fn(async () => {}),
    async exec() {
      throw new Error("Task execution is not part of this startup fixture");
    },
  } satisfies TaskRunner;
  return { instance, entered: entered.promise, gate };
}

function core() {
  return new SchedulerCore({ capsByRunner: {}, enablePreemption: false }, () => {});
}

describe("SchedulerCore startup", () => {
  it("starts the writer before any readers, overlaps independent pools and shares start completion", async () => {
    const scheduler = core();
    const writer = runner("writer");
    const main = runner("main");
    const io = runner("io");
    const cpu = runner("cpu");
    // Registration order must not put readers ahead of the writer.
    for (const item of [io, cpu, main, writer]) scheduler.registerRunner(item.instance);
    const first = scheduler.start();
    expect(scheduler.start()).toBe(first);
    await writer.entered;
    expect(scheduler.isStarted()).toBe(false);
    expect(io.instance.start).not.toHaveBeenCalled();
    expect(main.instance.start).not.toHaveBeenCalled();
    writer.gate.resolve();
    await main.entered;
    expect(io.instance.start).not.toHaveBeenCalled();
    main.gate.resolve();
    await Promise.all([io.entered, cpu.entered]);
    expect(scheduler.isStarted()).toBe(false);
    io.gate.resolve();
    cpu.gate.resolve();
    await first;
    expect(scheduler.isStarted()).toBe(true);
    await scheduler.start();
    for (const item of [writer, main, io, cpu]) expect(item.instance.start).toHaveBeenCalledOnce();
    await scheduler.dispose();
  });

  it("bounds independent pool starts to two even with an additional runner", async () => {
    const scheduler = core();
    const io = runner("io");
    const cpu = runner("cpu");
    const indexer = runner("indexer");
    for (const item of [io, cpu, indexer]) scheduler.registerRunner(item.instance);
    const starting = scheduler.start();
    await Promise.all([io.entered, cpu.entered]);
    expect(indexer.instance.start).not.toHaveBeenCalled();
    io.gate.resolve();
    await Promise.resolve();
    expect(indexer.instance.start).not.toHaveBeenCalled();
    cpu.gate.resolve();
    await indexer.entered;
    indexer.gate.resolve();
    await starting;
    await scheduler.dispose();
  });

  it("awaits a slow sibling before cleaning partially started pools after failure", async () => {
    const scheduler = core();
    const io = runner("io");
    const cpu = runner("cpu");
    const indexer = runner("indexer");
    for (const item of [io, cpu, indexer]) scheduler.registerRunner(item.instance);
    const starting = scheduler.start();
    const failed = expect(starting).rejects.toThrow("reader initialization failed");
    await Promise.all([io.entered, cpu.entered]);
    io.gate.reject(new Error("reader initialization failed"));
    await Promise.resolve();
    expect(io.instance.dispose).not.toHaveBeenCalled();
    expect(cpu.instance.dispose).not.toHaveBeenCalled();
    expect(indexer.instance.start).not.toHaveBeenCalled();
    cpu.gate.resolve();
    await failed;
    for (const item of [io, cpu, indexer]) expect(item.instance.dispose).toHaveBeenCalledOnce();
    expect(scheduler.disposed).toBe(true);
    expect(scheduler.isStarted()).toBe(false);
    await expect(scheduler.start()).rejects.toThrow("scheduler disposed");
  });

  it("cleans up after writer initialization fails without starting later runners", async () => {
    const scheduler = core();
    const writer = runner("writer");
    const io = runner("io");
    scheduler.registerRunner(io.instance);
    scheduler.registerRunner(writer.instance);
    const starting = scheduler.start();
    const failed = expect(starting).rejects.toThrow("writer failed");
    await writer.entered;
    writer.gate.reject(new Error("writer failed"));
    await failed;
    expect(io.instance.start).not.toHaveBeenCalled();
    expect(writer.instance.dispose).toHaveBeenCalledOnce();
    expect(io.instance.dispose).toHaveBeenCalledOnce();
  });

  it("shares real disposal completion and prevents late writer completion from starting siblings", async () => {
    const scheduler = core();
    const writer = runner("writer");
    const io = runner("io");
    const disposedGate = deferred();
    writer.instance.dispose.mockImplementation(() => disposedGate.promise);
    scheduler.registerRunner(writer.instance);
    scheduler.registerRunner(io.instance);
    const starting = scheduler.start();
    const interrupted = expect(starting).rejects.toThrow("disposed during startup");
    await writer.entered;
    const disposal = scheduler.dispose();
    expect(scheduler.dispose()).toBe(disposal);
    expect(scheduler.disposed).toBe(true);
    expect(writer.instance.dispose).not.toHaveBeenCalled();
    writer.gate.resolve();
    // Wait for the cleanup operation rather than a timer or approximate delay.
    const cleanupEntered = deferred();
    writer.instance.dispose.mockImplementation(async () => {
      cleanupEntered.resolve();
      await disposedGate.promise;
    });
    await cleanupEntered.promise;
    expect(io.instance.start).not.toHaveBeenCalled();
    expect(io.instance.dispose).not.toHaveBeenCalled();
    disposedGate.resolve();
    await disposal;
    await interrupted;
    expect(writer.instance.dispose).toHaveBeenCalledOnce();
    expect(io.instance.dispose).toHaveBeenCalledOnce();
    expect(scheduler.isStarted()).toBe(false);
  });

  it("settles concurrent pool starts before disposal and does not revive the scheduler", async () => {
    const scheduler = core();
    const io = runner("io");
    const cpu = runner("cpu");
    scheduler.registerRunner(io.instance);
    scheduler.registerRunner(cpu.instance);
    const starting = scheduler.start();
    const interrupted = expect(starting).rejects.toThrow("disposed during startup");
    await Promise.all([io.entered, cpu.entered]);
    const disposal = scheduler.dispose();
    io.gate.resolve();
    await Promise.resolve();
    expect(cpu.instance.dispose).not.toHaveBeenCalled();
    cpu.gate.resolve();
    await disposal;
    await interrupted;
    expect(io.instance.dispose).toHaveBeenCalledOnce();
    expect(cpu.instance.dispose).toHaveBeenCalledOnce();
    expect(scheduler.isStarted()).toBe(false);
  });

  it("cleans every runner even when one cleanup fails", async () => {
    const scheduler = core();
    const writer = runner("writer");
    const io = runner("io");
    writer.instance.dispose.mockRejectedValue(new Error("writer cleanup failed"));
    scheduler.registerRunner(writer.instance);
    scheduler.registerRunner(io.instance);
    // Registered resources are owned even if startup was never requested.
    await expect(scheduler.dispose()).rejects.toThrow("scheduler runner cleanup failed");
    expect(writer.instance.dispose).toHaveBeenCalledOnce();
    expect(io.instance.dispose).toHaveBeenCalledOnce();
    await expect(scheduler.dispose()).rejects.toThrow("scheduler runner cleanup failed");
    expect(writer.instance.dispose).toHaveBeenCalledOnce();
  });

  it("does not construct resources when disposal wins before the startup microtask", async () => {
    const scheduler = core();
    const writer = runner("writer");
    scheduler.registerRunner(writer.instance);
    const starting = scheduler.start();
    const interrupted = expect(starting).rejects.toThrow("disposed during startup");
    await scheduler.dispose();
    await interrupted;
    expect(writer.instance.start).not.toHaveBeenCalled();
    expect(writer.instance.dispose).toHaveBeenCalledOnce();
  });

  it("refuses registration during startup or disposal but preserves late registration", async () => {
    const scheduler = core();
    const writer = runner("writer");
    scheduler.registerRunner(writer.instance);
    const starting = scheduler.start();
    expect(() => scheduler.registerRunner(runner("io").instance)).toThrow(
      "during scheduler startup or disposal",
    );
    writer.gate.resolve();
    await starting;
    const late = runner("io");
    scheduler.registerRunner(late.instance);
    await scheduler.dispose();
    expect(late.instance.dispose).toHaveBeenCalledOnce();
    expect(() => scheduler.registerRunner(runner("io").instance)).toThrow(
      "during scheduler startup or disposal",
    );
  });
});
