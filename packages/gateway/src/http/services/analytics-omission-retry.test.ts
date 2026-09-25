// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AccountId, DeviceId, SourceId, SourceType, SCOPE_WRITE_ALL } from "@omnesis/types";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { mountAnalyticsRoutes } from "../routes/analytics.js";
import { mountDocumentCoreRoutes } from "../routes/documents.js";
import { strictRoute } from "../scope.js";
import { errorResponse, HttpError } from "../errors.js";
import { AnalyticsDb } from "../../analytics-db.js";
import { createDatabase } from "../../db.js";
import {
  createDevice,
  listDevices,
  updateDeviceCapabilities,
  revokeDevice,
} from "../../data/repositories/DeviceRepository.js";
import { SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import { SyncLeaseRegistry } from "../../sync-lease.js";
import { directWriteGate } from "../../write-gate.js";
import {
  addSourceMember,
  createSource,
  markSourceRemoved,
} from "../../data/repositories/SourceRepository.js";
import {
  analyticsClaimNamespace,
  judgeAnalyticsTombstones,
  listAnalyticsOmissionCandidates,
  recordAnalyticsPresence,
  recordAnalyticsRestorerOmissions,
} from "../../data/repositories/AnalyticsReplicaClaimRepository.js";
import { listClaimedExternalIds } from "../../data/repositories/ReplicaDeletionClaimRepository.js";
import { preparePendingSourcePage } from "../../data/repositories/PendingSourcePageRepository.js";
import { beginSyncAttempt } from "../../data/repositories/SyncStateRepository.js";
import { StatusCache } from "./StatusCache.js";
import { SourceDataRemovalService } from "./SourceDataRemovalService.js";
import { SourceService } from "./SourceService.js";
import { EventService } from "./EventService.js";
import { DocumentService } from "./DocumentService.js";
import { AnalyticsService, type AnalyticsReplicaLedger } from "./AnalyticsService.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { AppEnv } from "../routes/types.js";

const schema: AnalyticsTableSchema = {
  tableName: "example_retry_rows",
  displayName: "Example rows",
  description: "Fictional retry records",
  columns: [{ name: "id", type: "VARCHAR", description: "Stable key" }],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["id"], keyColumns: ["id"] },
};
let dir: string;
let db: ReturnType<typeof createDatabase>;
let analytics: AnalyticsDb;
let service: AnalyticsService;
let ledger: AnalyticsReplicaLedger;
let sourceId: string;
let owner: string;
let restorer: string;
let failure: "before-commit" | "after-commit" | undefined;
let policy: { minObservations: number; minAgeMs: number; maxMarksPerSnapshot: number };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-analytics-retry-"));
  db = createDatabase(join(dir, "state.db"));
  analytics = new AnalyticsDb(join(dir, "rows.duckdb"));
  await analytics.open();
  const first = createDevice(db, { name: "Example owner", kind: "collector" });
  const second = createDevice(db, { name: "Example restorer", kind: "collector" });
  owner = first.id;
  restorer = second.id;
  const source = createSource(db, {
    type: SourceType("example-retry"),
    accountId: AccountId("local"),
    deviceId: first.id,
    multiDeviceMode: "replicated",
  });
  sourceId = source.id;
  addSourceMember(db, source.id, second.id);
  await analytics.ingestPage({
    tableName: schema.tableName,
    schema,
    sourceId,
    records: [{ id: "row" }],
  });
  judgeAnalyticsTombstones(db, {
    sourceId,
    tableName: schema.tableName,
    deviceId: owner,
    existingIds: ["row"],
    deletionAuthority: true,
    now: Date.now(),
  });
  recordAnalyticsPresence(db, {
    sourceId,
    tableName: schema.tableName,
    deviceId: restorer,
    keyValues: ["row"],
    now: Date.now(),
  });
  ledger = {
    cursorRows: () => ["", owner, restorer],
    omissionCandidates: (s, t, d) => listAnalyticsOmissionCandidates(db, s, t, d),
    claimedKeys: (s, t, keys) => listClaimedExternalIds(db, analyticsClaimNamespace(t), s, keys),
    recordPresence: async (args) => recordAnalyticsPresence(db, args),
    recordRestorerOmissions: async (args) => recordAnalyticsRestorerOmissions(db, args),
    judgeTombstones: async (args) => {
      const verdict = judgeAnalyticsTombstones(db, args);
      if (failure === "before-commit") {
        failure = undefined;
        throw new Error("injected after SQLite verdict before DuckDB commit");
      }
      return verdict;
    },
  };
  policy = { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 100 };
  service = new AnalyticsService(
    analytics,
    undefined,
    false,
    undefined,
    undefined,
    () => policy,
    ledger,
  );
  const ingest = analytics.ingestPage.bind(analytics);
  vi.spyOn(analytics, "ingestPage").mockImplementation(async (page) => {
    const result = await ingest(page);
    if (failure === "after-commit") {
      failure = undefined;
      throw new Error("injected lost response after DuckDB commit");
    }
    return result;
  });
});

afterEach(async () => {
  failure = undefined;
  await analytics.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const snapshot = (presentIds: string[] = []) =>
  service.ingest({
    sourceId,
    tableName: schema.tableName,
    records: [],
    presentIds,
    replicaClaimDeviceId: restorer,
    deletionAuthority: false,
  });
const rowCount = async () => {
  const result = await analytics.executeQuery(`SELECT id FROM ${schema.tableName}`);
  return result.rows.length;
};

function leaseServices() {
  const fence = new SourceWriteEpochFence();
  const leases = new SyncLeaseRegistry({ ttlMs: () => 60_000, isOnline: () => true });
  const writeGate = directWriteGate(db);
  for (const deviceId of [owner, restorer])
    updateDeviceCapabilities(db, DeviceId(deviceId), {
      hostableSourceTypes: [SourceType("example-retry")],
      multiDeviceModes: { "example-retry": "replicated" },
      syncLease: true,
    });
  const sources = new SourceService({
    db,
    writeGate,
    sourceWriteEpochFence: fence,
    syncLease: leases,
    statusCache: new StatusCache(db),
    listDevices: () => listDevices(db),
    notifySourceChange: () => {},
    syncSourceSettingsToConfig: async () => {},
    sourceDataRemoval: new SourceDataRemovalService({
      db,
      writeGate,
      sourceWriteEpochFence: fence,
      purgeAnnotationsFor: async () => {},
    }),
  });
  const guarded = new AnalyticsService(
    analytics,
    undefined,
    false,
    undefined,
    fence,
    () => policy,
    ledger,
  );
  return { sources, fence, leases, guarded };
}

test("a queued replica deletion cannot retain authority after lease handover", async () => {
  const { sources, fence, guarded } = leaseServices();
  await analytics.ingestPage({ sourceId, tableName: schema.tableName, records: [{ id: "fresh" }] });
  expect((await sources.claimLease(sourceId, { deviceId: DeviceId(owner) })).granted).toBe(true);
  // HTTP currently captures this decision before AnalyticsService acquires
  // the source fence. Hold that fence across an explicit lease handover.
  const gate = await sources.pageLeaseGate(sourceId, { deviceId: DeviceId(owner) });
  expect(gate).toMatchObject({ resetReplicaCursors: true });
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocker = fence.runSourceExclusive(sourceId, async () => {
    entered();
    await held;
  });
  await started;
  // Queue the authority transfer before the already-admitted HTTP page's
  // actual write. Both wait behind the same source barrier.
  const releasing = sources.releaseLease(sourceId, { deviceId: DeviceId(owner) });
  const claiming = sources.claimLease(sourceId, { deviceId: DeviceId(restorer) });
  const deletion = guarded.ingest(
    {
      sourceId,
      tableName: schema.tableName,
      records: [],
      deletedIds: ["fresh"],
      replicaClaimDeviceId: owner,
      deletionAuthority: !gate.rejected && !!gate.resetReplicaCursors,
    },
    sources.sourceWireAuthority([sourceId], { deviceId: DeviceId(owner) }),
    sources.pageWriteAuthority(sourceId, { deviceId: DeviceId(owner) }),
  );
  release();
  await blocker;
  expect(await releasing).toBe(true);
  expect((await claiming).granted).toBe(true);
  const result = await deletion;
  expect(
    (await analytics.executeQuery(`SELECT id FROM ${schema.tableName} WHERE id = 'fresh'`)).rows,
  ).toHaveLength(1);
  expect(result.deletionDeferred).toBe(true);
});

test("HTTP analytics admission rechecks its captured lease before deleting", async () => {
  const { sources, guarded } = leaseServices();
  await analytics.ingestPage({ sourceId, tableName: schema.tableName, records: [{ id: "fresh" }] });
  await sources.claimLease(sourceId, { deviceId: DeviceId(owner) });
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const ingest = guarded.ingest.bind(guarded);
  vi.spyOn(guarded, "ingest").mockImplementation(async (...args) => {
    reached();
    await paused;
    return ingest(...args);
  });
  const app = strictRoute(new Hono<AppEnv>());
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      scopes: [SCOPE_WRITE_ALL],
      tokenId: null,
      deviceId: DeviceId(owner),
    });
    await next();
  });
  const readDb = new Database(db.name, { readonly: true });
  mountAnalyticsRoutes(app, { db: readDb, analyticsService: guarded, sourceService: sources });
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  try {
    const response = app.request("/analytics/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceId,
        tableName: schema.tableName,
        records: [],
        deletedIds: ["fresh"],
      }),
    });
    await admitted;
    expect(await sources.releaseLease(sourceId, { deviceId: DeviceId(owner) })).toBe(true);
    expect((await sources.claimLease(sourceId, { deviceId: DeviceId(restorer) })).granted).toBe(
      true,
    );
    resume();
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ deletionDeferred: true });
    expect(
      (await analytics.executeQuery(`SELECT id FROM ${schema.tableName} WHERE id = 'fresh'`)).rows,
    ).toHaveLength(1);
  } finally {
    resume();
    readDb.close();
  }
});

test("a detached replica cannot reuse captured page authority as an ungated writer", async () => {
  const { sources, guarded } = leaseServices();
  await analytics.ingestPage({ sourceId, tableName: schema.tableName, records: [{ id: "fresh" }] });
  await sources.claimLease(sourceId, { deviceId: DeviceId(owner) });
  const authority = sources.pageWriteAuthority(sourceId, { deviceId: DeviceId(owner) });
  expect(authority().deletionAuthority).toBe(true);
  await sources.detachSource(SourceId(sourceId), DeviceId(owner));
  await expect(
    guarded.ingest(
      {
        sourceId,
        tableName: schema.tableName,
        records: [],
        deletedIds: ["fresh"],
        replicaClaimDeviceId: owner,
        deletionAuthority: true,
      },
      undefined,
      authority,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (await analytics.executeQuery(`SELECT id FROM ${schema.tableName} WHERE id = 'fresh'`)).rows,
  ).toHaveLength(1);
});

test("a request authenticated before revocation cannot reclaim or spend a released lease", async () => {
  const { sources, leases } = leaseServices();
  const auth = { deviceId: DeviceId(owner) };
  await sources.claimLease(sourceId, auth);
  const authority = sources.pageWriteAuthority(sourceId, auth);
  expect(authority().deletionAuthority).toBe(true);
  revokeDevice(db, DeviceId(owner));
  await sources.releaseDeviceLeases(DeviceId(owner));
  await expect(sources.claimLease(sourceId, auth)).rejects.toMatchObject({ status: 403 });
  await expect(sources.pageLeaseGate(sourceId, auth)).rejects.toMatchObject({ status: 403 });
  expect(authority).toThrow(/revoked/);
  expect(leases.holderOf(sourceId)).toBeNull();
});

test("a legacy schema-only page cannot recreate a removed source after admission", async () => {
  const { sources, fence, guarded } = leaseServices();
  const authority = sources.pageWriteAuthority(sourceId, { deviceId: DeviceId(owner) });
  authority();
  await fence.runSourceExclusive(sourceId, async () => {
    markSourceRemoved(db, SourceId(sourceId));
  });
  const ingest = vi.spyOn(analytics, "ingestPage");
  ingest.mockClear();
  await expect(
    guarded.ingest(
      { sourceId, tableName: schema.tableName, records: [], schema },
      undefined,
      authority,
    ),
  ).rejects.toMatchObject({ code: "SOURCE_REMOVED" });
  expect(ingest).not.toHaveBeenCalled();
});

test("a lease successor waits until an admitted DuckDB transaction commits", async () => {
  const { sources, leases, guarded } = leaseServices();
  await analytics.ingestPage({ sourceId, tableName: schema.tableName, records: [{ id: "fresh" }] });
  await sources.claimLease(sourceId, { deviceId: DeviceId(owner) });
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const judging = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const judge = ledger.judgeTombstones;
  vi.spyOn(ledger, "judgeTombstones").mockImplementation(async (args) => {
    reached();
    await paused;
    return judge(args);
  });
  const deletion = guarded.ingest(
    {
      sourceId,
      tableName: schema.tableName,
      records: [],
      deletedIds: ["fresh"],
      replicaClaimDeviceId: owner,
      deletionAuthority: true,
    },
    undefined,
    sources.pageWriteAuthority(sourceId, { deviceId: DeviceId(owner) }),
  );
  await judging;
  let transferred = false;
  const releasing = sources.releaseLease(sourceId, { deviceId: DeviceId(owner) });
  const claiming = sources
    .claimLease(sourceId, { deviceId: DeviceId(restorer) })
    .then((decision) => {
      transferred = true;
      return decision;
    });
  // An event-loop turn lets an unfenced transfer finish; the real barrier must wait.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(transferred).toBe(false);
  expect(leases.holderOf(sourceId)?.deviceId).toBe(owner);
  resume();
  await deletion;
  expect(await releasing).toBe(true);
  expect((await claiming).granted).toBe(true);
  expect(
    (await analytics.executeQuery(`SELECT id FROM ${schema.tableName} WHERE id = 'fresh'`)).rows,
  ).toHaveLength(0);
});

test("HTTP document handoff cannot advance a cursor after its lease changes", async () => {
  const { sources, fence } = leaseServices();
  db.prepare("UPDATE sources SET multi_device_mode = 'handoff' WHERE id = ?").run(sourceId);
  for (const deviceId of [owner, restorer])
    updateDeviceCapabilities(db, DeviceId(deviceId), {
      hostableSourceTypes: [SourceType("example-retry")],
      multiDeviceModes: { "example-retry": "handoff" },
      syncLease: true,
    });
  const writeGate = directWriteGate(db);
  const documents = new DocumentService({
    db,
    writeGate,
    sourceWriteEpochFence: fence,
    events: new EventService(db, undefined, false),
    sourceDataRemoval: new SourceDataRemovalService({
      db,
      writeGate,
      sourceWriteEpochFence: fence,
      purgeAnnotationsFor: async () => {},
    }),
  });
  await sources.claimLease(sourceId, { deviceId: DeviceId(owner) });
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const upsert = documents.upsertWithCursor.bind(documents);
  vi.spyOn(documents, "upsertWithCursor").mockImplementation(async (args) => {
    reached();
    await paused;
    return upsert(args);
  });
  const app = strictRoute(new Hono<AppEnv>());
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      scopes: [SCOPE_WRITE_ALL],
      tokenId: null,
      deviceId: DeviceId(owner),
    });
    await next();
  });
  mountDocumentCoreRoutes(app, {
    db,
    writeGate,
    documentService: documents,
    sourceService: sources,
  });
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  const response = app.request("/documents/with-cursor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId: "example",
      sourceId,
      documents: [],
      cursor: { position: "stale" },
      hasMore: false,
    }),
  });
  await admitted;
  try {
    await sources.releaseLease(sourceId, { deviceId: DeviceId(owner) });
    await sources.claimLease(sourceId, { deviceId: DeviceId(restorer) });
  } finally {
    resume();
  }
  const result = await response;
  expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject({ code: "SYNC_LEASE_CHANGED" });
  expect(db.prepare("SELECT cursor FROM sync_state WHERE source_id = ?").all(sourceId)).toEqual([
    { cursor: "{}" },
  ]);
});

test.each(["before-commit", "after-commit"] as const)(
  "settled omission retries after %s failure",
  async (point) => {
    failure = point;
    await expect(snapshot()).rejects.toThrow("injected");
    expect(await rowCount()).toBe(point === "before-commit" ? 1 : 0);
    await snapshot();
    expect(await rowCount()).toBe(0);
  },
);

test("a retained snapshot retry never spends another spaced omission observation", async () => {
  policy = { minObservations: 3, minAgeMs: 100, maxMarksPerSnapshot: 100 };
  const id = "00000000-0000-4000-8000-000000000001";
  preparePendingSourcePage(db, {
    sourceId,
    cursorRow: restorer,
    deviceId: restorer,
    writeEpoch: beginSyncAttempt(db, sourceId, restorer),
    id,
    payload: { result: { cursor: {}, hasMore: false } },
  });
  const clock = vi.spyOn(Date, "now");
  try {
    for (const now of [10_000, 100_000, 200_000]) {
      clock.mockReturnValue(now);
      await service.ingest({
        sourceId,
        tableName: schema.tableName,
        records: [],
        presentIds: [],
        replicaClaimDeviceId: restorer,
        deletionAuthority: false,
        pendingPageId: id,
        writeOrdinal: 1,
      });
    }
    expect(await rowCount()).toBe(1);
    expect(
      db
        .prepare(
          "SELECT omissions FROM replica_deletion_claims WHERE source_id = ? AND device_id = ?",
        )
        .get(sourceId, restorer),
    ).toMatchObject({ omissions: 1 });
  } finally {
    clock.mockRestore();
  }
});

test("a retained snapshot keeps its receipt identity across a lease handover", async () => {
  const id = "00000000-0000-4000-8000-000000000002";
  preparePendingSourcePage(db, {
    sourceId,
    cursorRow: restorer,
    deviceId: restorer,
    writeEpoch: beginSyncAttempt(db, sourceId, restorer),
    id,
    payload: { result: { cursor: {}, hasMore: false } },
  });
  const page = {
    sourceId,
    tableName: schema.tableName,
    records: [],
    presentIds: ["row"],
    replicaClaimDeviceId: restorer,
    pendingPageId: id,
    writeOrdinal: 1,
  };
  await service.ingest({ ...page, deletionAuthority: false });
  await expect(service.ingest({ ...page, deletionAuthority: true })).resolves.toMatchObject({
    ingested: 0,
  });
  expect(await rowCount()).toBe(1);
});

test.each(["same-member", "sibling", "named-snapshot"] as const)(
  "positive evidence %s invalidates or disputes a failed deletion",
  async (evidence) => {
    failure = "before-commit";
    await expect(snapshot()).rejects.toThrow("injected");
    if (evidence === "named-snapshot") {
      await snapshot(["row"]);
      // After naming, one omission must spend the policy again, not replay
      // the previously settled verdict immediately.
    } else {
      await service.ingest({
        sourceId,
        tableName: schema.tableName,
        records: [{ id: "row" }],
        replicaClaimDeviceId: evidence === "sibling" ? owner : restorer,
        deletionAuthority: false,
      });
    }
    policy = { minObservations: 3, minAgeMs: 60_000, maxMarksPerSnapshot: 100 };
    await snapshot();
    expect(await rowCount()).toBe(1);
  },
);
