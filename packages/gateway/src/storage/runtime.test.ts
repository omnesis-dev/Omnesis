// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ConfigStore } from "../config-store.js";
import { StorageRuntime } from "./runtime.js";
import type { PeriodicTask } from "../scheduler/types.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { StorageReads } from "./reads.js";
import type { IndexStorageAccounting } from "./index-accounting.js";
import type { StorageRuntimeDeps } from "./runtime.js";
import type { StorageAllocationSnapshot } from "./physical-accounting.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(
  options: Pick<StorageRuntimeDeps, "allocations" | "canMeasureAllocations"> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "storage-runtime-"));
  const configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
  const lifecycle: { dispose?: () => Promise<void> } = {};
  await configStore.load();
  cleanups.push(async () => {
    await lifecycle.dispose?.();
    configStore.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await configStore.patch({
    gateway: { storage: { maxDiskUsedPercent: 99, measurementIntervalMs: 1000 } },
  });
  const tasks = new Map<string, PeriodicTask<undefined, void>>();
  const scheduler = {
    schedule: (task: PeriodicTask<undefined, void>) => {
      tasks.set(task.name, task);
    },
    kickPeriodic: vi.fn(),
  } as unknown as Scheduler;
  const indexer = {
    setStoragePressure: vi.fn(),
    storageAccounting: vi.fn<() => Promise<IndexStorageAccounting | null>>(async () => null),
  };
  const accounting = vi.fn(async () => ({
    sourceIds: [],
    upperRowid: 0,
    database: { allocatedBytes: 0, reusableBytes: 0, tables: null },
  }));
  const runtime = new StorageRuntime({
    layout: {
      configDir: dir,
      dbPath: join(dir, "documents.db"),
      indexDbPath: join(dir, "index.db"),
      analyticsDbPath: join(dir, "analytics.db"),
      watchDbPath: join(dir, "watch.db"),
      transcriptsDir: join(dir, "transcripts"),
      conversationsDir: join(dir, "conversations"),
      modelsDir: join(dir, "models"),
      backupsDir: join(dir, "backups"),
    },
    configStore,
    scheduler,
    reads: {
      storageAccountingMetadata: accounting,
      storageAccountingPage: async () => [],
    } as unknown as StorageReads,
    getMinFreeDiskMb: () => 0,
    measureIndex: indexer.storageAccounting,
    setStoragePressure: indexer.setStoragePressure,
    ...options,
  });
  lifecycle.dispose = () => runtime.dispose();
  return { runtime, tasks, indexer, configStore, accounting, dir };
}

async function tick(task: PeriodicTask<undefined, void>) {
  return task.run(undefined, {} as never);
}

test("periodic capacity publishes quota blocking and automatic recovery while accounting is unavailable", async () => {
  const f = await fixture();
  f.runtime.start();
  await f.runtime.pressure.refresh();
  const capacity = f.tasks.get("storage.capacity.tick")!;
  // Infrastructure admission must keep running when ordinary background work is paused.
  expect(capacity.priority).toBe("realtime");
  await f.configStore.patch({ gateway: { storage: { maxBytes: 1 } } });
  await tick(capacity);
  expect(f.indexer.setStoragePressure.mock.lastCall?.[0]).toBe(true);
  expect(() => f.runtime.pressure.assertCanGrow()).toThrow();
  f.accounting.mockRejectedValueOnce(new Error("accounting unavailable"));
  await expect(tick(f.tasks.get("storage.accounting.tick")!)).rejects.toThrow(
    "accounting unavailable",
  );
  await f.configStore.patch({ gateway: { storage: { maxBytes: null } } });
  await tick(capacity);
  expect(f.indexer.setStoragePressure.mock.lastCall?.[0]).toBe(false);
  expect(() => f.runtime.pressure.assertCanGrow()).not.toThrow();
});

test("a refresh publishes safety independently of a failed logical scan", async () => {
  const f = await fixture();
  await writeFile(join(f.dir, "documents.db"), Buffer.alloc(1024));
  await f.configStore.patch({ gateway: { storage: { maxBytes: 100 } } });
  f.accounting.mockRejectedValueOnce(new Error("read pool unavailable"));
  await expect(f.runtime.refresh()).rejects.toThrow("read pool unavailable");
  // Promise.all may reject before the independent filesystem inventory completes.
  await f.runtime.pressure.refresh();
  await Promise.resolve();
  expect(f.runtime.pressure.snapshot().state).toBe("blocked");
  expect(f.indexer.setStoragePressure.mock.lastCall?.[0]).toBe(true);
});

test("portal reads coalesce stale measurement work and retain the last complete inventory", async () => {
  const f = await fixture();
  await f.runtime.refresh();
  const previous = f.runtime.logical;
  expect(previous).not.toBeNull();
  const calls = f.accounting.mock.calls.length;
  f.runtime.refreshIfStale();
  f.runtime.refreshIfStale();
  expect(f.accounting).toHaveBeenCalledTimes(calls);
  f.accounting.mockRejectedValueOnce(new Error("read worker unavailable"));
  await expect(f.runtime.refresh()).rejects.toThrow("read worker unavailable");
  expect(f.runtime.logical).toBe(previous);
  expect(f.runtime.accountingStatus()).toMatchObject({
    refreshing: false,
    error: expect.any(String),
  });
  // Polling must not hammer a failed read worker; an explicit retry can recover.
  f.runtime.refreshIfStale();
  expect(f.accounting).toHaveBeenCalledTimes(calls + 1);
  await f.runtime.refresh();
  expect(f.runtime.accountingStatus().error).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function indexInventory(measuredAt = "2025-04-01T00:00:00.000Z"): IndexStorageAccounting {
  return { measuredAt, tables: null, lexicalBytes: null, embeddingBytes: 0, sources: [] };
}

test("publishes document totals while index measurement is pending and keeps them after its failure", async () => {
  const f = await fixture();
  const index = deferred<IndexStorageAccounting>();
  f.indexer.storageAccounting.mockReturnValueOnce(index.promise);
  const refresh = f.runtime.refresh();
  await vi.waitFor(() => expect(f.runtime.logical).not.toBeNull());
  const logical = f.runtime.logical;
  expect(f.runtime.accountingStatus()).toMatchObject({
    refreshing: true,
    logical: { state: "ready", error: null },
    index: { state: "refreshing", measuredAt: null },
  });
  index.reject(new Error("index reader unavailable"));
  await expect(refresh).rejects.toThrow("index reader unavailable");
  expect(f.runtime.logical).toBe(logical);
  expect(f.runtime.accountingStatus()).toMatchObject({
    refreshing: false,
    logical: { state: "ready", error: null },
    index: { state: "failed", error: expect.any(String) },
  });
  f.indexer.storageAccounting.mockResolvedValueOnce(indexInventory());
  await f.runtime.refresh();
  expect(f.runtime.accountingStatus()).toMatchObject({
    error: null,
    logical: { state: "ready" },
    index: { state: "ready", error: null },
  });
});

test("publishes index totals independently when the document measurement fails", async () => {
  const f = await fixture();
  const metadata = deferred<Awaited<ReturnType<typeof f.accounting>>>();
  f.accounting.mockReturnValueOnce(metadata.promise);
  const index = indexInventory();
  f.indexer.storageAccounting.mockResolvedValueOnce(index);
  const refresh = f.runtime.refresh();
  await vi.waitFor(() => expect(f.runtime.index).toBe(index));
  expect(f.runtime.logical).toBeNull();
  expect(f.runtime.accountingStatus()).toMatchObject({
    logical: { state: "refreshing" },
    index: { state: "ready" },
  });
  metadata.reject(new Error("document reader unavailable"));
  await expect(refresh).rejects.toThrow("document reader unavailable");
  expect(f.runtime.index).toBe(index);
  expect(f.runtime.accountingStatus()).toMatchObject({
    logical: { state: "failed" },
    index: { state: "ready", error: null },
  });
});

test("a failed document refresh retains its dated totals while a new index measurement publishes", async () => {
  const f = await fixture();
  f.indexer.storageAccounting.mockResolvedValueOnce(indexInventory());
  await f.runtime.refresh();
  const logical = f.runtime.logical;
  const newIndex = indexInventory("2025-04-02T00:00:00.000Z");
  f.accounting.mockRejectedValueOnce(new Error("document read failed"));
  f.indexer.storageAccounting.mockResolvedValueOnce(newIndex);
  await expect(f.runtime.refresh()).rejects.toThrow("document read failed");
  expect(f.runtime.logical).toBe(logical);
  expect(f.runtime.index).toBe(newIndex);
  expect(f.runtime.accountingStatus()).toMatchObject({
    logical: { state: "failed", measuredAt: logical!.measuredAt },
    index: { state: "ready", measuredAt: newIndex.measuredAt },
  });
});

test("polling a long measurement logs its failure once instead of once per poll", async () => {
  const f = await fixture();
  const index = deferred<IndexStorageAccounting>();
  f.indexer.storageAccounting.mockReturnValueOnce(index.promise);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    f.runtime.refreshIfStale();
    await vi.waitFor(() => expect(f.indexer.storageAccounting).toHaveBeenCalledTimes(1));
    clock.mockReturnValue(Date.now() + 60_000);
    for (let i = 0; i < 100; i++) f.runtime.refreshIfStale();
    index.reject(new Error("index read failed"));
    await vi.waitFor(() => expect(f.runtime.accountingStatus().refreshing).toBe(false));
    expect(f.accounting).toHaveBeenCalledTimes(1);
    expect(
      warning.mock.calls.filter((args) =>
        args.some((v) => String(v).includes("Storage measurement failed")),
      ),
    ).toHaveLength(1);
  } finally {
    clock.mockRestore();
    warning.mockRestore();
  }
});

function allocationSnapshot(name: string, bytes: number): StorageAllocationSnapshot {
  return {
    state: "ready",
    measuredAt: "2025-04-01T00:00:00.000Z",
    tables: [{ name, bytes }],
    completed: [{ name, bytes }],
    scannedPages: 1,
    error: null,
  };
}

test("allocation waits for startup and publishes each completed store without blocking safety or source totals", async () => {
  const documents = deferred<StorageAllocationSnapshot>();
  const index = deferred<StorageAllocationSnapshot>();
  const allocations = {
    measure: vi.fn().mockReturnValueOnce(documents.promise).mockReturnValueOnce(index.promise),
    dispose: vi.fn(async () => {}),
  };
  const canMeasureAllocations = vi.fn(() => false);
  const f = await fixture({ allocations, canMeasureAllocations });
  f.runtime.start();
  await f.runtime.pressure.refresh();
  const allocationTick = f.tasks.get("storage.allocations.tick")!;
  await tick(allocationTick);
  expect(allocations.measure).not.toHaveBeenCalled();
  f.indexer.storageAccounting.mockResolvedValueOnce(indexInventory());
  await f.runtime.refresh();
  await tick(allocationTick);
  expect(allocations.measure).not.toHaveBeenCalled();
  canMeasureAllocations.mockReturnValue(true);
  const measuring = tick(allocationTick);
  await vi.waitFor(() =>
    expect(allocations.measure).toHaveBeenCalledWith("documents", { force: true }),
  );
  expect(f.runtime.accountingStatus()).toMatchObject({
    logical: { state: "ready" },
    index: { state: "ready" },
    allocations: { state: "refreshing" },
  });
  f.runtime.observeAllocation("documents", {
    state: "running",
    measuredAt: null,
    tables: null,
    completed: [{ name: "completed-tree", bytes: 1024 }],
    scannedPages: 7,
    scannedBytes: 28_672,
    error: null,
  });
  expect(f.runtime.accountingStatus().allocations?.progress).toEqual({
    store: "documents",
    scannedPages: 7,
    scannedBytes: 28_672,
    completedTables: 1,
  });
  expect(f.runtime.logical!.database.tables).toBeNull();
  await f.configStore.patch({ gateway: { storage: { maxBytes: 1 } } });
  await tick(f.tasks.get("storage.capacity.tick")!);
  expect(f.runtime.pressure.snapshot().state).toBe("blocked");
  documents.resolve(allocationSnapshot("documents", 100));
  await vi.waitFor(() =>
    expect(allocations.measure).toHaveBeenCalledWith("index", { force: true }),
  );
  expect(f.runtime.logical!.database.tables).toEqual([{ name: "documents", bytes: 100 }]);
  expect(f.runtime.index!.tables).toBeNull();
  index.resolve(allocationSnapshot("chunks_fts_data", 30));
  await measuring;
  expect(f.runtime.index!.lexicalBytes).toBe(30);
  expect(f.runtime.accountingStatus().allocations).toMatchObject({ state: "ready", error: null });
  await f.runtime.dispose();
});

test("partial allocation retains complete tables and cannot replace source measurements with a partial tree", async () => {
  const allocations = { measure: vi.fn(), dispose: vi.fn(async () => {}) };
  const f = await fixture({ allocations });
  f.runtime.start();
  await f.runtime.pressure.refresh();
  f.indexer.storageAccounting.mockResolvedValueOnce(indexInventory());
  allocations.measure.mockResolvedValueOnce(allocationSnapshot("documents", 100));
  allocations.measure.mockResolvedValueOnce(allocationSnapshot("chunks_fts_data", 30));
  await f.runtime.refresh();
  const allocationTick = f.tasks.get("storage.allocations.tick")!;
  await tick(allocationTick);
  const tables = f.runtime.logical!.database.tables;
  const partial: StorageAllocationSnapshot = {
    state: "partial",
    measuredAt: null,
    tables: null,
    completed: [{ name: "incomplete", bytes: 1 }],
    scannedPages: 2,
    error: "snapshot cap",
  };
  allocations.measure.mockResolvedValueOnce(partial).mockResolvedValueOnce(partial);
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
  try {
    await tick(allocationTick);
    expect(f.runtime.logical!.database.tables).toBe(tables);
    expect(f.runtime.index!.lexicalBytes).toBe(30);
    expect(f.runtime.accountingStatus()).toMatchObject({
      error: null,
      logical: { state: "ready" },
      index: { state: "ready" },
      allocations: { state: "failed", error: expect.any(String) },
    });
    // A capped read backs off rather than repeatedly taking another snapshot.
    await tick(allocationTick);
    expect(allocations.measure).toHaveBeenCalledTimes(4);
    allocations.measure.mockResolvedValueOnce(allocationSnapshot("documents", 200));
    allocations.measure.mockResolvedValueOnce(allocationSnapshot("chunks_fts_data", 40));
    f.indexer.storageAccounting.mockResolvedValueOnce(indexInventory());
    // An explicit operator retry bypasses terminal backoff, never an active scan.
    await f.runtime.refresh();
    await tick(allocationTick);
    expect(allocations.measure).toHaveBeenCalledTimes(6);
    expect(allocations.measure.mock.lastCall).toEqual(["index", { force: true }]);
    expect(f.runtime.index!.lexicalBytes).toBe(40);
    expect(f.runtime.accountingStatus().allocations?.state).toBe("ready");
  } finally {
    now.mockRestore();
  }
  await f.runtime.dispose();
});

test("disposal cancels its allocation owner once and suppresses late publication and new scans", async () => {
  const pending = deferred<StorageAllocationSnapshot>();
  const allocations = {
    measure: vi.fn(() => pending.promise),
    dispose: vi.fn(async () => {
      pending.resolve(allocationSnapshot("documents", 100));
    }),
  };
  const f = await fixture({ allocations });
  f.runtime.start();
  await f.runtime.pressure.refresh();
  f.indexer.storageAccounting.mockResolvedValueOnce(indexInventory());
  await f.runtime.refresh();
  const allocationTick = f.tasks.get("storage.allocations.tick")!;
  const measuring = tick(allocationTick);
  await vi.waitFor(() => expect(allocations.measure).toHaveBeenCalledTimes(1));
  await Promise.all([f.runtime.dispose(), f.runtime.dispose()]);
  await measuring;
  expect(allocations.dispose).toHaveBeenCalledTimes(1);
  expect(f.runtime.logical!.database.tables).toBeNull();
  const calls = f.accounting.mock.calls.length;
  await tick(allocationTick);
  await f.runtime.refresh();
  f.runtime.refreshIfStale();
  expect(allocations.measure).toHaveBeenCalledTimes(1);
  expect(f.accounting).toHaveBeenCalledTimes(calls);
});

test("an initial capacity refresh finishing after disposal never messages an indexer owner", async () => {
  const f = await fixture();
  const pending = deferred<void>();
  vi.spyOn(f.runtime.pressure, "refresh").mockReturnValueOnce(pending.promise);
  f.runtime.start();
  await f.runtime.dispose();
  pending.resolve();
  await Promise.resolve();
  expect(f.indexer.setStoragePressure).not.toHaveBeenCalled();
});
