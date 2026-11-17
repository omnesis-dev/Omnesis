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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "storage-runtime-"));
  const configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
  await configStore.load();
  cleanups.push(async () => {
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
  const indexer = { setStoragePressure: vi.fn(), storageAccounting: vi.fn(async () => null) };
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
    getIndexer: () => indexer as never,
    setStoragePressure: indexer.setStoragePressure,
  });
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
