// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyMergePatch } from "@omnesis/config";
import { AccountId, SourceType } from "@omnesis/types";
import { ConfigStore } from "../config-store.js";
import { createSource } from "../data/repositories/SourceRepository.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { directWriteGate } from "../write-gate.js";
import { createDatabase } from "../db.js";
import { SourceWriteEpochFence } from "../source-write-epoch-fence.js";
import { readStorageSourceIncarnation } from "./retention-bindings.js";
import { resolveStoragePolicy, StoragePressureManager } from "./pressure.js";
import { StorageRetentionService } from "./retention.js";
import { StorageService } from "./service.js";

let dir: string;
let configStore: ConfigStore;
let db: ReturnType<typeof createDatabase>;
let service: StorageService;
let fence: SourceWriteEpochFence;
let writer: ReturnType<typeof directWriteGate>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-storage-service-"));
  configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
  await configStore.load();
  db = createDatabase(":memory:");
  fence = new SourceWriteEpochFence();
  const device = createDevice(db, { name: "Fictional storage collector", kind: "collector" });
  for (const accountId of ["first", "second"])
    createSource(db, {
      type: SourceType("fictional-notes"),
      accountId: AccountId(accountId),
      deviceId: device.id,
    });
  const pressure = new StoragePressureManager({
    getPolicy: () => resolveStoragePolicy(configStore.get().gateway?.storage, 0),
    measure: async () => ({
      usageBytes: 0,
      measuredAt: Date.now(),
      volumes: [{ id: "fictional", totalBytes: 10000, availableBytes: 9000 }],
    }),
  });
  await pressure.refresh();
  writer = directWriteGate(db);
  service = new StorageService({
    pressure,
    configStore,
    physical: () => null,
    logical: () => null,
    index: () => null,
    refresh: async () => {},
    db,
    writeGate: writer,
    sourceExists: (id) => readStorageSourceIncarnation(db, id) !== null,
    sourceWriteEpochFence: fence,
    retention: new StorageRetentionService({
      db,
      writeGate: writer,
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
      { sourceId: "fictional-notes:first", maxAgeDays: 365 },
      { sourceId: "fictional-notes:second", maxAgeDays: 730 },
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
    { sourceId: "fictional-notes:second", maxAgeDays: 730 },
  ]);
});

test("invalid policy rejects without discarding the last valid configuration", async () => {
  await service.setRetention("fictional-notes:first", 365);
  await expect(service.setRetention("fictional-notes:first", 0)).rejects.toThrow();
  expect(configStore.get().gateway?.storage?.retention).toEqual([
    { sourceId: "fictional-notes:first", maxAgeDays: 365 },
  ]);
});

test("an invalid cutoff cannot create a destructive command", async () => {
  await expect(service.startTrim("fictional-notes:first", "not-a-date")).rejects.toMatchObject({
    status: 400,
  });
  expect(service.snapshot().trimJobs).toEqual([]);
});

test("a removed source policy remains removable and never trims a replacement", async () => {
  await service.setRetention("fictional-notes:first", 365);
  db.prepare("DELETE FROM sources WHERE id = ?").run("fictional-notes:first");
  await expect(service.sweep()).resolves.toMatchObject({ deleted: 0 });
  await service.setRetention("fictional-notes:first", null);
  expect(configStore.get().gateway?.storage?.retention).toEqual([]);
  await expect(service.setRetention("fictional-notes:first", 365)).rejects.toMatchObject({
    status: 404,
  });
});

test("raw retention edits between config update and explicit binding do not acquire stale authority", async () => {
  const update = configStore.update.bind(configStore);
  const intercepted = vi.spyOn(configStore, "update").mockImplementation(async (mutation) => {
    const result = await update(mutation);
    await update((current) =>
      applyMergePatch(current, { gateway: { storage: { retention: [] } } }),
    );
    return result;
  });
  try {
    await expect(service.setRetention("fictional-notes:first", 365)).rejects.toMatchObject({
      status: 409,
    });
    expect(configStore.get().gateway?.storage?.retention).toEqual([]);
    expect(service.snapshot().retention).toEqual([]);
  } finally {
    intercepted.mockRestore();
  }
});

test("raw revocation after binding is queued rejects at the writer fence", async () => {
  const bind = writer.bindStorageRetentionPolicy;
  let arrived!: () => void;
  let release!: () => void;
  const queued = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const intercepted = vi
    .spyOn(writer, "bindStorageRetentionPolicy")
    .mockImplementation(async (input) => {
      arrived();
      await held;
      return bind(input);
    });
  const pending = service.setRetention("fictional-notes:first", 365);
  const rejected = expect(pending).rejects.toMatchObject({ status: 409 });
  try {
    await queued;
    await configStore.patch({ gateway: { storage: { retention: [] } } });
    release();
    await rejected;
    expect(service.snapshot().retention).toEqual([]);
  } finally {
    release();
    intercepted.mockRestore();
  }
});
