// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The server's read ports — the status cache's refresh and an analytics page's
 * replica ledger reads — run on the real io worker against a temp database:
 * each returns exactly what the same read returns on a direct handle, so moving
 * it off the main event loop changes nothing a caller sees.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AccountId, ProviderId, SourceId, SourceType } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { Scheduler } from "../../scheduler/scheduler.js";
import { IoTaskRunner } from "../../scheduler/runners/io.js";
import { ioGateFromScheduler, type IoGate } from "../../scheduler/io-ops.js";
import { directReadPort } from "../../scheduler/read-port.js";
import { createDevice, revokeDevice } from "../../data/repositories/DeviceRepository.js";
import { addSourceMember, createSource } from "../../data/repositories/SourceRepository.js";
import { setSyncError, setSyncState } from "../../data/repositories/SyncStateRepository.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import {
  judgeAnalyticsTombstones,
  recordAnalyticsPresence,
} from "../../data/repositories/AnalyticsReplicaClaimRepository.js";
import { STATUS_CACHE_READS, type StatusCacheReads } from "./status-cache-reads.js";
import { ANALYTICS_REPLICA_READS, type AnalyticsReplicaReads } from "./analytics-replica-reads.js";
import type Database from "better-sqlite3";

const WORKER_URL = new URL("../../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../../workers/register-tsx.mjs", import.meta.url).href;

let dbPath: string;
let db: Database.Database;
let scheduler: Scheduler;
let worker: IoGate;
let direct: StatusCacheReads & AnalyticsReplicaReads;

beforeEach(async () => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath) as unknown as Database.Database;
  direct = {
    ...directReadPort(STATUS_CACHE_READS, db),
    ...directReadPort(ANALYTICS_REPLICA_READS, db),
  };
  scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: dbPath,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  worker = ioGateFromScheduler(scheduler);
});

afterEach(async () => {
  await scheduler.dispose();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

it("reads the same status cache snapshot on the worker as on the handle", async () => {
  expect(await worker.statusCacheSnapshot()).toStrictEqual(await direct.statusCacheSnapshot());

  const collector = createDevice(db, { name: "Example laptop", kind: "collector" });
  const phone = createDevice(db, { name: "Example phone", kind: "ios" });
  const retired = createDevice(db, { name: "Example tablet", kind: "collector" });
  revokeDevice(db, retired.id);
  const notes = createSource(db, {
    type: SourceType("example-notes"),
    accountId: AccountId("local"),
    deviceId: collector.id,
    config: { folder: "Field notes" },
  });
  const health = createSource(db, {
    type: SourceType("example-health"),
    accountId: AccountId("local"),
    deviceId: phone.id,
    multiDeviceMode: "replicated",
  });
  addSourceMember(db, health.id, collector.id);
  setSyncState(db, notes.id, { page: 3, token: "x".repeat(20_000) });
  setSyncError(db, health.id, "permission denied");
  upsertDocuments(db, [
    {
      providerId: ProviderId("example"),
      sourceId: SourceId(notes.id),
      externalId: "note-1",
      title: "Survey crew schedule",
      content: "The crew meets at the north station.",
      contentHash: "hash-note-1",
      sourceCreatedAt: "2027-02-01T09:00:00.000Z",
      sourceUpdatedAt: "2027-02-01T09:00:00.000Z",
      metadata: {},
    },
  ]);

  const expected = await direct.statusCacheSnapshot();
  expect(expected.sources.map((s) => s.id).sort()).toEqual([health.id, notes.id].sort());
  expect(expected.devices).toHaveLength(3);
  expect(expected.syncStates.map((s) => s.source_id).sort()).toEqual([health.id, notes.id].sort());
  expect(Object.keys(expected.latestActivity)).toEqual([notes.id]);
  expect([...expected.sourceHostingDeviceIds].sort()).toEqual([collector.id, phone.id].sort());
  expect(await worker.statusCacheSnapshot()).toStrictEqual(expected);
});

it("reads the same replica ledger keys on the worker as on the handle", async () => {
  const owner = createDevice(db, { name: "Example owner", kind: "collector" });
  const restorer = createDevice(db, { name: "Example restorer", kind: "collector" });
  const source = createSource(db, {
    type: SourceType("example-health"),
    accountId: AccountId("local"),
    deviceId: owner.id,
    multiDeviceMode: "replicated",
  });
  addSourceMember(db, source.id, restorer.id);
  const table = "example_heart_rate";
  const keys = ["sample-1", "sample-2", "sample-3"];
  // Nothing in the ledger yet: both reads find nothing, on either handle.
  expect(await worker.analyticsClaimedKeys(source.id, table, keys)).toStrictEqual([]);
  expect(await worker.analyticsOmissionCandidates(source.id, table, restorer.id)).toStrictEqual([]);

  judgeAnalyticsTombstones(db, {
    sourceId: source.id,
    tableName: table,
    deviceId: owner.id,
    existingIds: ["sample-1", "sample-2"],
    deletionAuthority: true,
    now: Date.now(),
  });
  recordAnalyticsPresence(db, {
    sourceId: source.id,
    tableName: table,
    deviceId: restorer.id,
    keyValues: ["sample-1"],
    now: Date.now(),
  });

  const claimed = await direct.analyticsClaimedKeys(source.id, table, keys);
  expect([...claimed].sort()).toEqual(["sample-1", "sample-2"]);
  expect(await worker.analyticsClaimedKeys(source.id, table, keys)).toStrictEqual(claimed);
  for (const device of [owner.id, restorer.id]) {
    const expected = await direct.analyticsOmissionCandidates(source.id, table, device);
    expect(await worker.analyticsOmissionCandidates(source.id, table, device)).toStrictEqual(
      expected,
    );
  }
  expect(await worker.analyticsOmissionCandidates(source.id, table, restorer.id)).toContain(
    "sample-1",
  );
  // Another table's ledger is its own.
  expect(await worker.analyticsClaimedKeys(source.id, "example_steps", keys)).toStrictEqual([]);
});
