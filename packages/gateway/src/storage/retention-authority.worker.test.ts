// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AccountId, ProviderId, SourceId, SourceType } from "@omnesis/types";
import { createSource } from "../data/repositories/SourceRepository.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { ConfigStore } from "../config-store.js";
import { createDatabase, openReadOnlyDatabase, upsertDocuments } from "../db.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { WriterTaskRunner } from "../scheduler/runners/writer.js";
import { writeGateFromScheduler } from "../scheduler/write-ops.js";
import { SourceWriteEpochFence } from "../source-write-epoch-fence.js";
import {
  bindStorageRetentionPolicy,
  readBoundStorageRetentionPolicies,
  readStorageSourceIncarnation,
} from "./retention-bindings.js";
import { StorageRetentionService } from "./retention.js";

const WORKER_URL = new URL("../workers/writer-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

test("raw config revocation cancels rolling cleanup queued for the real writer; manual commands stay independent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-retention-authority-"));
  const dbPath = join(dir, "gateway.db");
  const sourceId = "fictional-notes:archive";
  const seed = createDatabase(dbPath);
  const device = createDevice(seed, { name: "Fictional collector", kind: "collector" });
  createSource(seed, {
    type: SourceType("fictional-notes"),
    accountId: AccountId("archive"),
    deviceId: device.id,
  });
  bindStorageRetentionPolicy(seed, {
    sourceId,
    maxAgeDays: 365,
    sourceIncarnation: readStorageSourceIncarnation(seed, sourceId)!,
  });
  upsertDocuments(seed, [
    {
      providerId: ProviderId("fictional-provider"),
      sourceId: SourceId(sourceId),
      externalId: "old-entry",
      title: "Invented archive entry",
      content: "Invented reference text.",
      contentHash: "fictional-hash",
      metadata: {},
      sourceCreatedAt: "2020-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2020-01-01T00:00:00.000Z",
    },
  ]);
  seed.close();
  const configStore = new ConfigStore({ filePath: join(dir, "omnesis.json") });
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new WriterTaskRunner({
      gatewayDbPath: dbPath,
      journalMode: "WAL",
      heartbeatIntervalMs: 1000,
      heartbeatWarnGapMs: 10000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  const db = openReadOnlyDatabase(dbPath);
  try {
    await configStore.load();
    await configStore.patch({
      gateway: { storage: { retention: [{ sourceId, maxAgeDays: 365 }] } },
    });
    await scheduler.start();
    scheduler.pauseBackground();
    const writer = writeGateFromScheduler(scheduler);
    let markQueued!: () => void;
    const queued = new Promise<void>((resolve) => {
      markQueued = resolve;
    });
    const service = new StorageRetentionService({
      db,
      sourceWriteEpochFence: new SourceWriteEpochFence(),
      captureAuthority: () => configStore.captureRevisionFence(),
      writeGate: {
        ...writer,
        applyStorageTrimPage: (batch) => {
          const pending = writer.applyStorageTrimPage(batch);
          markQueued();
          return pending;
        },
      },
      finishCascade: async () => {},
    });
    const cleanup = service.sweep(() =>
      readBoundStorageRetentionPolicies(db, configStore.get().gateway?.storage?.retention ?? []),
    );
    // Register rejection before unblocking worker execution.
    const stopped = expect(cleanup).resolves.toMatchObject({ deleted: 0 });
    await queued;
    expect((await configStore.patch({ gateway: { storage: { retention: [] } } })).ok).toBe(true);
    scheduler.resumeBackground();
    await stopped;
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM documents").get()!.count,
    ).toBe(1);
    expect(db.prepare("SELECT 1 FROM snapshot_absence_cascade_outbox").get()).toBeUndefined();

    await service.startTrim(sourceId, "2025-01-01T00:00:00.000Z");
    await configStore.patch({ indexer: { cycleInterval: "10m" } });
    expect(await service.sweep([])).toEqual({ deleted: 1, hasMore: false });
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM documents").get()!.count,
    ).toBe(0);
  } finally {
    db.close();
    configStore.stop();
    await scheduler.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
