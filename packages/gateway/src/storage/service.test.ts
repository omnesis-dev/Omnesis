// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConfigStore } from "../config-store.js";
import { createDatabase } from "../db.js";
import { SourceWriteEpochFence } from "../source-write-epoch-fence.js";
import { resolveStoragePolicy, StoragePressureManager } from "./pressure.js";
import { StorageRetentionService } from "./retention.js";
import { deleteStorageRetentionBatch } from "./retention-store.js";
import { StorageService } from "./service.js";

let dir: string;
let configStore: ConfigStore;
let db: ReturnType<typeof createDatabase>;
let service: StorageService;
let fence: SourceWriteEpochFence;
let sourceCreatedAt: number | null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-storage-service-"));
  configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
  await configStore.load();
  db = createDatabase(":memory:");
  fence = new SourceWriteEpochFence();
  sourceCreatedAt = 1;
  const pressure = new StoragePressureManager({
    getPolicy: () => resolveStoragePolicy(configStore.get().gateway?.storage, 0),
    measure: async () => ({
      usageBytes: 0,
      measuredAt: Date.now(),
      volumes: [{ id: "fictional", totalBytes: 10000, availableBytes: 9000 }],
    }),
  });
  await pressure.refresh();
  service = new StorageService({
    pressure,
    configStore,
    physical: () => null,
    logical: () => null,
    index: () => null,
    refresh: async () => {},
    sourceCreatedAt: () => sourceCreatedAt,
    sourceExists: () => sourceCreatedAt !== null,
    sourceWriteEpochFence: fence,
    retention: new StorageRetentionService({
      db,
      writeGate: {
        deleteStorageRetentionBatch: async (batch) => deleteStorageRetentionBatch(db, batch),
      },
      sourceWriteEpochFence: fence,
      finishCascade: async () => {},
    }),
  });
});
afterEach(() => {
  configStore.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("concurrent retention edits preserve siblings and quota settings on disk", async () => {
  await service.setPolicy({ maxBytes: 30000, maxDiskUsedPercent: 90 });
  await Promise.all([
    service.setRetention("fictional-notes:first", 365),
    service.setRetention("fictional-notes:second", 730),
  ]);
  const onDisk = JSON.parse(readFileSync(join(dir, "omnesis.json"), "utf8"));
  expect(onDisk.gateway.storage).toMatchObject({
    maxBytes: 30000,
    maxDiskUsedPercent: 90,
    retention: [
      { sourceId: "fictional-notes:first", maxAgeDays: 365, sourceCreatedAt: 1 },
      { sourceId: "fictional-notes:second", maxAgeDays: 730, sourceCreatedAt: 1 },
    ],
  });
  await service.setPolicy({ maxDiskUsedPercent: 95 });
  expect(configStore.get().gateway?.storage?.retention).toHaveLength(2);
});

test("opt-out waits for source-exclusive work and removes only that source's policy", async () => {
  await service.setRetention("fictional-notes:first", 365);
  await service.setRetention("fictional-notes:second", 730);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const active = fence.runSourceExclusive("fictional-notes:first", async () => {
    entered();
    await held;
  });
  await started;
  let optedOut = false;
  const optOut = service.setRetention("fictional-notes:first", null).then(() => {
    optedOut = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(optedOut).toBe(false);
  expect(configStore.get().gateway?.storage?.retention).toHaveLength(2);
  release();
  await active;
  await optOut;
  expect(configStore.get().gateway?.storage?.retention).toEqual([
    { sourceId: "fictional-notes:second", maxAgeDays: 730, sourceCreatedAt: 1 },
  ]);
});

test("invalid policy rejects without discarding the last valid configuration", async () => {
  await service.setRetention("fictional-notes:first", 365);
  await expect(service.setRetention("fictional-notes:first", 0)).rejects.toThrow();
  expect(configStore.get().gateway?.storage?.retention).toEqual([
    { sourceId: "fictional-notes:first", maxAgeDays: 365, sourceCreatedAt: 1 },
  ]);
});

test("expired approvals map to a safe conflict response", async () => {
  await expect(service.trim("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
    status: 409,
  });
});

test("a removed source policy remains removable and never trims a replacement", async () => {
  await service.setRetention("fictional-notes:first", 365);
  sourceCreatedAt = null;
  await expect(service.sweep()).resolves.toEqual({ deleted: 0 });
  await service.setRetention("fictional-notes:first", null);
  expect(configStore.get().gateway?.storage?.retention).toEqual([]);
  await expect(service.setRetention("fictional-notes:first", 365)).rejects.toMatchObject({
    status: 404,
  });
});
