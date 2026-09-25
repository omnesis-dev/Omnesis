// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Omnesis contributors

import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AccountId,
  ProviderId,
  SCOPE_WRITE_ALL,
  SourceId,
  SourceType,
  type DeviceId,
  type DocumentInput,
} from "@omnesis/types";
import { AnalyticsDb } from "../../analytics-db.js";
import { createDatabase, getDocumentCount, getSyncState, getWipeEpoch } from "../../db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { addSourceMember, createSource } from "../../data/repositories/SourceRepository.js";
import { directWriteGate, type WriteGate } from "../../write-gate.js";
import { epochScope, SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import { SourceDataRemovalService } from "./SourceDataRemovalService.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { DocumentService } from "./DocumentService.js";
import { EventService } from "./EventService.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { IndexWriteGate } from "../../indexer/index-write-gate.js";
import type Database from "better-sqlite3";

const schema: AnalyticsTableSchema = {
  tableName: "wipe_race_events",
  displayName: "Wipe race events",
  description: "Invented events for multi-store wipe concurrency tests",
  columns: [
    { name: "id", type: "VARCHAR", description: "Stable event id" },
    { name: "title", type: "VARCHAR", description: "Event title" },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Event start" },
    { name: "end_time", type: "TIMESTAMPTZ", description: "Event end" },
    { name: "all_day", type: "BOOLEAN", description: "Whether the event is all day" },
    { name: "eligible", type: "BOOLEAN", description: "Projection eligibility" },
    { name: "status", type: "VARCHAR", description: "Event status" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "start_time",
  record: { titleColumns: ["title"], keyColumns: ["id"] },
  boundDocument: { externalIdColumns: ["id"] },
  temporalProjection: {
    slot: "calendar",
    start: "$semanticTime",
    end: "end_time",
    label: "title",
    kind: "appointment",
    modality: "scheduled",
    status: { from: "status", map: { cancelled: "cancelled" }, default: "active" },
    allDay: "all_day",
    eligibility: "eligible",
  },
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function document(sourceId: string, id: string): DocumentInput {
  return {
    providerId: ProviderId("fictional-calendar"),
    sourceId: SourceId(sourceId),
    externalId: id,
    title: `Planning ${id}`,
    content: `Invented planning event ${id}`,
    contentHash: `hash-${id}`,
    metadata: { documentType: "event" },
    sourceCreatedAt: "2026-08-01T09:00:00.000Z",
    sourceUpdatedAt: "2026-08-01T09:00:00.000Z",
  };
}

function record(id: string): Record<string, unknown> {
  return {
    id,
    title: `Planning ${id}`,
    start_time: "2026-08-01T09:00:00.000Z",
    end_time: "2026-08-01T10:00:00.000Z",
    all_day: false,
    eligible: true,
    status: "confirmed",
  };
}

describe("SourceDataRemovalService wipe barriers", () => {
  let sqlite: Database.Database;
  let analytics: AnalyticsDb;
  let gate: WriteGate;
  let fence: SourceWriteEpochFence;
  let sqlitePath: string;
  let analyticsPath: string;

  beforeEach(async () => {
    sqlitePath = `/tmp/omnesis-wipe-race-${crypto.randomUUID()}.db`;
    analyticsPath = `/tmp/omnesis-wipe-race-${crypto.randomUUID()}.duckdb`;
    sqlite = createDatabase(sqlitePath);
    analytics = new AnalyticsDb(analyticsPath);
    await analytics.open();
    gate = directWriteGate(sqlite);
    fence = new SourceWriteEpochFence();
  });

  afterEach(async () => {
    await analytics.close();
    sqlite.close();
    for (const path of [
      sqlitePath,
      `${sqlitePath}-wal`,
      `${sqlitePath}-shm`,
      analyticsPath,
      `${analyticsPath}.wal`,
    ]) {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  function createTestSource(account: string): { id: string; deviceId: DeviceId } {
    const device = createDevice(sqlite, { name: `Collector ${account}`, kind: "collector" });
    const source = createSource(sqlite, {
      type: SourceType("fictional-calendar"),
      accountId: AccountId(account),
      deviceId: device.id,
    });
    if (!source) throw new Error("test source was not created");
    return { id: source.id, deviceId: device.id };
  }

  async function seedHybrid(
    sourceId: string,
    id: string,
    cursorRow = "",
    streamId = "",
  ): Promise<void> {
    const writeEpoch = await gate.beginSyncAttempt(sourceId, cursorRow);
    await analytics.ingestPage({
      tableName: schema.tableName,
      records: [record(id)],
      schema,
      sourceId,
      streamId,
    });
    const result = await gate.upsertWithCursor({
      providerId: "fictional-calendar",
      sourceId,
      cursorDeviceId: cursorRow,
      streamId,
      documents: [document(sourceId, id)],
      hasMore: false,
      cursor: { page: id },
      wipeEpoch: writeEpoch,
    });
    expect(result.rejected).not.toBe(true);
  }

  function makeRemoval(indexWriteGate: IndexWriteGate): SourceDataRemovalService {
    return new SourceDataRemovalService({
      db: sqlite,
      writeGate: gate,
      indexWriteGate,
      analyticsDb: analytics,
      sourceWriteEpochFence: fence,
      purgeAnnotationsFor: async () => {},
    });
  }

  async function writeHybridPage(
    removal: SourceDataRemovalService,
    sourceId: string,
    id: string,
    writeEpoch: number,
    cursorRow = "",
    streamId = "",
  ): Promise<void> {
    const analyticsService = new AnalyticsService(
      analytics,
      undefined,
      false,
      (currentSourceId, currentCursorRow) =>
        getWipeEpoch(sqlite, currentSourceId, currentCursorRow),
      fence,
    );
    const documentService = new DocumentService({
      db: sqlite,
      writeGate: gate,
      events: new EventService(sqlite, undefined, false),
      analyticsDb: analytics,
      sourceWriteEpochFence: fence,
      sourceDataRemoval: removal,
    });
    expect(
      await analyticsService.ingest({
        tableName: schema.tableName,
        records: [record(id)],
        schema,
        sourceId,
        writeEpoch,
        cursorRow,
        streamId,
      }),
    ).toEqual({ ingested: 1, deleted: 0 });
    expect(
      await documentService.upsertWithCursor({
        callerScopes: [SCOPE_WRITE_ALL],
        cursorDeviceId: cursorRow,
        streamId,
        body: {
          providerId: "fictional-calendar",
          sourceId,
          documents: [document(sourceId, id)],
          hasMore: false,
          cursor: { page: id },
          wipeEpoch: writeEpoch,
        },
      }),
    ).toMatchObject({ ingested: 1 });
  }

  async function observedPending<T>(promise: Promise<T>): Promise<boolean> {
    let settled = false;
    void promise.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return !settled;
  }

  test("source wipe blocks a new attempt until every store is empty", async () => {
    const source = createTestSource("maya.reeves@example.com");
    await seedHybrid(source.id, "old-event");
    const indexEntered = deferred();
    const releaseIndex = deferred();
    const removal = makeRemoval({
      deleteIndexBySource: async () => {
        indexEntered.resolve();
        await releaseIndex.promise;
        return 1;
      },
    } as unknown as IndexWriteGate);

    const wipe = removal.deleteSource(source.id);
    await indexEntered.promise;
    expect(getDocumentCount(sqlite, source.id)).toBe(0);

    const claim = fence.beginAttempt(epochScope(source.id), "post-wipe-bootstrap", () =>
      gate.beginSyncAttempt(source.id),
    );
    const blocked = await observedPending(claim);
    releaseIndex.resolve();
    await wipe;
    const epoch = await claim;
    expect(blocked).toBe(true);
    expect(epoch).toBeDefined();

    await writeHybridPage(removal, source.id, "new-event", epoch!);
    expect(getDocumentCount(sqlite, source.id)).toBe(1);
    expect(JSON.parse(getSyncState(sqlite, source.id)?.cursor ?? "null")).toEqual({
      page: "new-event",
    });
    expect(await analytics.executeQuery(`SELECT id FROM ${schema.tableName}`)).toMatchObject({
      rows: [["new-event"]],
    });
  });

  test("stream wipe blocks its device but not a sibling member", async () => {
    const source = createTestSource("jamie.lopez@example.com");
    const sibling = createDevice(sqlite, { name: "Sibling collector", kind: "collector" });
    addSourceMember(sqlite, source.id as never, sibling.id);
    await seedHybrid(source.id, "old-event", source.deviceId, source.deviceId);
    const indexEntered = deferred();
    const releaseIndex = deferred();
    const removal = makeRemoval({
      deleteChunksByDocuments: async () => {
        indexEntered.resolve();
        await releaseIndex.promise;
        return 1;
      },
    } as unknown as IndexWriteGate);

    const wipe = removal.deleteStream(source.id, source.deviceId, { resetCursor: true });
    await indexEntered.promise;
    const ownClaim = fence.beginAttempt(
      epochScope(source.id, source.deviceId),
      "own-bootstrap",
      () => gate.beginSyncAttempt(source.id, source.deviceId),
    );
    const siblingClaim = fence.beginAttempt(
      epochScope(source.id, sibling.id),
      "sibling-bootstrap",
      () => gate.beginSyncAttempt(source.id, sibling.id),
    );
    const ownBlocked = await observedPending(ownClaim);
    const siblingBlocked = await observedPending(siblingClaim);
    releaseIndex.resolve();
    await wipe;
    expect(await ownClaim).toBeDefined();
    expect(await siblingClaim).toBeDefined();
    expect(ownBlocked).toBe(true);
    expect(siblingBlocked).toBe(false);
    expect(getSyncState(sqlite, source.id, source.deviceId)).toMatchObject({
      cursor: "{}",
      last_synced_at: null,
    });
  });

  test("provider wipe blocks a first attempt for a newly-created source", async () => {
    const source = createTestSource("david.lin@example.com");
    await seedHybrid(source.id, "old-event");
    const indexEntered = deferred();
    const releaseIndex = deferred();
    const removal = makeRemoval({
      deleteIndexBySource: async () => {
        indexEntered.resolve();
        await releaseIndex.promise;
        return 1;
      },
    } as unknown as IndexWriteGate);

    const wipe = removal.deleteProvider("fictional-calendar");
    await indexEntered.promise;
    const newcomer = createTestSource("sarah.mendez@example.com");
    const claim = fence.beginAttempt(epochScope(newcomer.id), "new-provider-source", () =>
      gate.beginSyncAttempt(newcomer.id),
    );
    const blocked = await observedPending(claim);
    releaseIndex.resolve();
    await wipe;
    expect(await claim).toBeDefined();
    expect(blocked).toBe(true);
  });
});
