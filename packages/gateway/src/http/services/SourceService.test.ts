// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { RowKeyError } from "@omnesis/source-sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AccountId,
  ProviderId,
  SourceId,
  SourceType,
  type DeviceCapability,
  type DeviceId,
  type DocumentInput,
} from "@omnesis/types";
import {
  createDatabase,
  upsertDocuments,
  upsertWithCursor,
  getDocumentCount,
  getWipeEpoch,
} from "../../db.js";
import {
  addSourceMember,
  createSource,
  getSource,
  isSourceMember,
  isSourceCleanupPending,
} from "../../data/repositories/SourceRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import {
  getMobilePermissionHealth,
  replaceMobilePermissionHealth,
} from "../../data/repositories/MobilePermissionHealthRepository.js";
import { directWriteGate, type WriteGate } from "../../write-gate.js";
import { epochScope, type SourceWriteEpochFence } from "../../source-write-epoch-fence.js";
import { purgeCognitiveStateThroughGate } from "../../brain/cognitive-state-cascade.js";
import { createDocAnnotation } from "../../brain/storage/annotations.js";
import { createOpenLoop, getOpenLoop } from "../../brain/storage/open-loops.js";
import { buildOpenLoopDocumentInput } from "../../brain/open-loop-source/document-projection.js";
import { StatusCache } from "./StatusCache.js";
import { SourceService, type SourceServiceDeps } from "./SourceService.js";
import {
  SourceDataRemovalService,
  type SourceDataRemovalDeps,
} from "./SourceDataRemovalService.js";
import type { AnalyticsDb } from "../../analytics-db.js";
import type { IndexWriteGate } from "../../indexer/index-write-gate.js";
import type { DeviceWsServer } from "../../ws.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let dbPath: string;

beforeEach(() => {
  dbPath = `/tmp/omnesis-sourceservice-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function seedSourceWithDocs(): string {
  const device = createDevice(db, { name: "test-collector", kind: "collector" });
  const source = createSource(db, {
    type: SourceType("gmail"),
    accountId: AccountId("indexer-test@example.com"),
    deviceId: device.id as unknown as DeviceId,
  });
  if (!source) throw new Error("fixture source was not created");
  const docs: DocumentInput[] = [1, 2, 3].map((n) => ({
    providerId: "google",
    sourceId: source.id,
    externalId: `ext-${n}`,
    title: `Doc ${n}`,
    content: `body ${n}`,
    contentHash: `hash-${n}`,
    metadata: { documentType: "email" },
    sourceCreatedAt: "2026-01-01T00:00:00Z",
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
  }));
  upsertDocuments(db, docs);
  return source.id;
}

/** IndexWriteGate stub that only records the one method deleteSource calls. */
function spyIndexGate(): {
  gate: IndexWriteGate;
  deleteIndexBySource: ReturnType<typeof vi.fn>;
} {
  const deleteIndexBySource = vi.fn(async (_sourceId: string) => 0);
  return { gate: { deleteIndexBySource } as unknown as IndexWriteGate, deleteIndexBySource };
}

/** The removal service over the real cognition cascade; the other stores are the caller's stubs. */
function makeRemoval(
  overrides: Partial<SourceDataRemovalDeps> & { writeGate?: WriteGate } = {},
): SourceDataRemovalService {
  const writeGate = overrides.writeGate ?? directWriteGate(db);
  return new SourceDataRemovalService({
    db,
    writeGate,
    purgeAnnotationsFor: (ids) => purgeCognitiveStateThroughGate(db, writeGate, ids),
    ...overrides,
    analyticsDb: overrides.analyticsDb
      ? ({ prepareSourceRemoval: async () => {}, ...overrides.analyticsDb } as AnalyticsDb)
      : undefined,
  });
}

function makeService(overrides: Partial<SourceServiceDeps> = {}): SourceService {
  const writeGate = overrides.writeGate ?? directWriteGate(db);
  return new SourceService({
    db,
    writeGate,
    statusCache: new StatusCache(db),
    sourceDataRemoval: makeRemoval({ writeGate }),
    listDevices: () => [],
    notifySourceChange: () => {},
    syncSourceSettingsToConfig: async () => {},
    ...overrides,
  });
}

describe("SourceService.createSource", () => {
  test("a removal queued after the precheck still wins atomically", async () => {
    const device = createDevice(db, { name: "test-collector", kind: "collector" });
    const input = {
      type: SourceType("gmail"),
      accountId: AccountId("race@example.com"),
      deviceId: device.id,
    };
    const base = directWriteGate(db);
    const existing = await base.createSource(input);
    if (!existing) throw new Error("fixture source was not created");
    const service = makeService({
      writeGate: {
        ...base,
        createSource: async (nextInput) => {
          await base.removeSource(existing.id);
          return base.createSource(nextInput);
        },
      },
    });

    await expect(service.createSource(input)).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_REMOVAL_IN_PROGRESS",
    });
    expect(getSource(db, existing.id)).toBeNull();
    expect(isSourceCleanupPending(db, existing.id)).toBe(true);
  });
});

describe("SourceService.deleteSource", () => {
  test("partitioned detach refuses unresolved ownership before retiring the member", async () => {
    const owner = createDevice(db, { name: "owner-collector", kind: "collector" }).id;
    const sibling = createDevice(db, { name: "sibling-collector", kind: "collector" }).id;
    const source = createSource(db, {
      type: SourceType("visits-synth"),
      accountId: AccountId("ownership-fixture"),
      deviceId: owner,
      multiDeviceMode: "partitioned",
    })!;
    addSourceMember(db, source.id, sibling);
    const removal = makeRemoval();
    const prepare = vi
      .spyOn(removal, "prepareSourceRemoval")
      .mockRejectedValue(new Error("Unresolved owner"));
    const writeGate = directWriteGate(db);
    const removeMember = vi.spyOn(writeGate, "removeSourceMember");
    const service = makeService({ writeGate, sourceDataRemoval: removal });
    await expect(service.detachSource(source.id, owner)).rejects.toThrow("Unresolved owner");
    expect(prepare).toHaveBeenCalledWith(source.id, owner);
    expect(removeMember).not.toHaveBeenCalled();
    expect(getSource(db, source.id)?.deviceId).toBe(owner);
    expect(isSourceMember(db, source.id, owner)).toBe(true);
    expect(isSourceMember(db, source.id, sibling)).toBe(true);
    service.dispose();
  });

  test("ownership refusal keeps the source mounted and every data plane intact", async () => {
    const id = SourceId(seedSourceWithDocs());
    let insideFence = false;
    const prepareSourceRemoval = vi.fn(async () => {
      expect(insideFence).toBe(true);
      throw new RowKeyError("Restore the missing parent before removing this source");
    });
    const purgeAnnotationsFor = vi.fn(async () => {});
    const syncSourceSettingsToConfig = vi.fn(async () => {});
    const sourceDataRemoval = makeRemoval({
      analyticsDb: { prepareSourceRemoval } as unknown as AnalyticsDb,
      purgeAnnotationsFor,
    });
    const service = makeService({
      sourceDataRemoval,
      syncSourceSettingsToConfig,
      sourceWriteEpochFence: {
        runSourceExclusive: async (_id: string, operation: () => Promise<unknown>) => {
          insideFence = true;
          try {
            return await operation();
          } finally {
            insideFence = false;
          }
        },
      } as unknown as SourceWriteEpochFence,
    });
    await expect(service.deleteSource(id)).rejects.toMatchObject({
      status: 409,
      code: "ANALYTICS_OWNERSHIP_UNRESOLVED",
    });
    expect(getSource(db, id)).not.toBeNull();
    expect(isSourceCleanupPending(db, id)).toBe(false);
    expect(getDocumentCount(db, id)).toBe(3);
    expect(purgeAnnotationsFor).not.toHaveBeenCalled();
    expect(syncSourceSettingsToConfig).not.toHaveBeenCalled();
    expect(prepareSourceRemoval).toHaveBeenCalledWith(id, undefined);
    service.dispose();
  });

  test.each(["source", "provider"] as const)(
    "%s wipe preflights ownership before deleting documents or annotations",
    async (scope) => {
      const sourceId = seedSourceWithDocs();
      const purgeAnnotationsFor = vi.fn(async () => {});
      const deleteAnalyticsForSource = vi.fn(async () => []);
      const prepareSourceRemoval = vi.fn(async () => {
        throw new RowKeyError("Ownership recovery is incomplete");
      });
      const removal = makeRemoval({
        purgeAnnotationsFor,
        analyticsDb: { prepareSourceRemoval, deleteAnalyticsForSource } as unknown as AnalyticsDb,
      });
      await expect(
        scope === "source" ? removal.deleteSource(sourceId) : removal.deleteProvider("google"),
      ).rejects.toMatchObject({ status: 409, code: "ANALYTICS_OWNERSHIP_UNRESOLVED" });
      expect(getDocumentCount(db, sourceId)).toBe(3);
      expect(purgeAnnotationsFor).not.toHaveBeenCalled();
      expect(deleteAnalyticsForSource).not.toHaveBeenCalled();
    },
  );

  test("captures a member joining before the writer removes the source and isolates dispatch failures", async () => {
    const id = SourceId(seedSourceWithDocs());
    const owner = getSource(db, id)!.deviceId;
    const sibling = createDevice(db, { name: "sibling-collector", kind: "collector" }).id;
    const lateMember = createDevice(db, { name: "joining-collector", kind: "collector" }).id;
    addSourceMember(db, id, sibling);
    const base = directWriteGate(db);
    const sendCommand = vi.fn((deviceId: DeviceId) => {
      if (deviceId === sibling) throw new Error("not connected");
      return Promise.resolve({});
    });
    const service = makeService({
      writeGate: {
        ...base,
        removeSource: async (...args) => {
          // The join commits after the service entered, before its queued write.
          await Promise.resolve();
          addSourceMember(db, id, lateMember);
          return base.removeSource(...args);
        },
      },
      wsServer: { sendCommand } as unknown as DeviceWsServer,
    });

    await service.deleteSource(id);

    expect(sendCommand.mock.calls.map(([deviceId]) => deviceId)).toEqual([
      owner,
      sibling,
      lateMember,
    ]);
    await vi.waitFor(() => expect(getDocumentCount(db, id)).toBe(0));
    await vi.waitFor(() => expect(isSourceCleanupPending(db, id)).toBe(false));
  });

  test("clears documents AND index rows even when no WS server is wired", async () => {
    const sourceId = seedSourceWithDocs();
    expect(getDocumentCount(db, sourceId)).toBe(3);
    const { gate, deleteIndexBySource } = spyIndexGate();

    // wsServer intentionally omitted — the sweep + index cleanup must still
    // run (regression guard for the fix that moved them out of the
    // `if (wsServer)` block).
    const svc = makeService({ indexWriteGate: gate, wsServer: undefined });
    const result = await svc.deleteSource(sourceId as never);

    expect(result?.source.id).toBe(sourceId);
    expect(getSource(db, sourceId as never)).toBeNull(); // source row gone
    // The purge outlives the call, so it is awaited rather than asserted
    // inline. That it eventually happens is the guarantee; that the caller
    // waits for it is deliberately not.
    await vi.waitFor(() => expect(getDocumentCount(db, sourceId)).toBe(0));
    await vi.waitFor(() => expect(deleteIndexBySource).toHaveBeenCalledWith(sourceId));
  });

  test("retracts the cognitive state grounded on the removed source's documents", async () => {
    // Removing a source used to delete its documents wholesale and stop
    // there — annotations quoting the removed content survived, dangling.
    // Their evidence quote IS the document's text, so leaving them behind
    // keeps a copy of what the operator asked to be gone.
    const sourceId = seedSourceWithDocs();
    const docId = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE source_id = ? LIMIT 1")
      .get(sourceId)!.id;

    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId,
        claimType: "fact",
        claimText: "the venue holds 80 people",
        evidenceDocId: docId,
        evidenceQuote: "body 1",
        confidence: 0.9,
        claimBasis: "stated",
        createdByRun: "run_1",
      },
      Date.now(),
    );
    // Assert against the TABLE, not the read helper: the reads already skip a
    // row whose evidence document is gone, so they would mask a surviving row
    // — and the row is where `evidence_quote` keeps its copy of the text.
    const storedRows = (): number =>
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM doc_annotations").get()!.n;
    const storedQuotes = (): number =>
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM doc_annotation_evidence").get()!.n;
    expect(storedRows()).toBe(1);
    expect(storedQuotes()).toBeGreaterThan(0);

    const { gate } = spyIndexGate();
    await makeService({ indexWriteGate: gate, wsServer: undefined }).deleteSource(
      sourceId as never,
    );

    await vi.waitFor(() => expect(getDocumentCount(db, sourceId)).toBe(0));
    expect(storedRows()).toBe(0);
    expect(storedQuotes()).toBe(0);
  });

  test("rejects a new annotation after source removal is established", async () => {
    const sourceId = seedSourceWithDocs();
    const docId = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE source_id = ? LIMIT 1")
      .get(sourceId)!.id;
    await directWriteGate(db).removeSource(sourceId as never);

    await expect(
      directWriteGate(db).createDocAnnotation(
        {
          id: "anno_race",
          docId,
          claimType: "fact",
          claimText: "late private claim",
          evidenceDocId: docId,
          evidenceQuote: "body 1",
          confidence: 0.9,
          claimBasis: "stated",
          createdByRun: "run_race",
        },
        Date.now(),
      ),
    ).rejects.toThrow("source is being removed");
  });

  test("keeps documents and removal pending when cognitive purge fails", async () => {
    const sourceId = seedSourceWithDocs();
    const docId = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE source_id = ? LIMIT 1")
      .get(sourceId)!.id;
    createDocAnnotation(
      db,
      {
        id: "anno_failure",
        docId,
        claimType: "fact",
        claimText: "private derived claim",
        evidenceDocId: docId,
        evidenceQuote: "body 1",
        confidence: 0.9,
        claimBasis: "stated",
        createdByRun: "run_failure",
      },
      Date.now(),
    );
    const base = directWriteGate(db);
    const cascadeAnnotationPrivacyDelete = vi.fn(async () => {
      throw new Error("cognition store unavailable");
    });
    const service = makeService({
      writeGate: { ...base, cascadeAnnotationPrivacyDelete },
    });

    await service.deleteSource(sourceId as never);
    await vi.waitFor(() => expect(cascadeAnnotationPrivacyDelete).toHaveBeenCalled());

    expect(getDocumentCount(db, sourceId)).toBe(3);
    expect(isSourceCleanupPending(db, sourceId as never)).toBe(true);
    service.dispose();
  });

  test("retracts cognitive state when a source's data is deleted without removing it", async () => {
    // `POST /documents/delete-all/source/:id` empties a source in place — the
    // resync path. The cascade has to run here too, not only on removal, or
    // annotations outlive the evidence they quote.
    const sourceId = seedSourceWithDocs();
    const docId = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE source_id = ? LIMIT 1")
      .get(sourceId)!.id;
    createDocAnnotation(
      db,
      {
        id: "anno_cli",
        docId,
        claimType: "fact",
        claimText: "the quote expires on the 14th",
        evidenceDocId: docId,
        evidenceQuote: "body 1",
        confidence: 0.9,
        claimBasis: "stated",
        createdByRun: "run_1",
      },
      Date.now(),
    );
    const storedRows = (): number =>
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM doc_annotations").get()!.n;
    expect(storedRows()).toBe(1);

    const { gate } = spyIndexGate();
    const removal = makeRemoval({ indexWriteGate: gate });

    // Step 1 — the data sweep the clients issue first.
    await removal.deleteSource(sourceId);
    expect(getDocumentCount(db, sourceId)).toBe(0);
    expect(storedRows(), "purged by the data sweep, not by source removal").toBe(0);

    // Step 2 — removing the source row then finds nothing left to cascade.
    await makeService({ indexWriteGate: gate, wsServer: undefined }).deleteSource(
      sourceId as never,
    );
    expect(getSource(db, sourceId as never)).toBeNull();
  });

  test("source data wipe fails loudly when analytics cleanup fails", async () => {
    const sourceId = seedSourceWithDocs();
    const removal = makeRemoval({
      analyticsDb: {
        deleteAnalyticsForSource: async () => {
          throw new Error("analytics unavailable");
        },
      } as unknown as AnalyticsDb,
    });

    await expect(removal.deleteSource(sourceId)).rejects.toThrow("analytics unavailable");
  });

  test("source and provider wipes acquire their umbrella barriers before cleanup", async () => {
    const sourceId = seedSourceWithDocs();
    const member = createDevice(db, { name: "second-collector", kind: "collector" }).id;
    addSourceMember(db, sourceId as SourceId, member);
    const runSourceExclusive = vi.fn((_sourceId: string, op: () => Promise<unknown>) => op());
    const runGlobalExclusive = vi.fn((op: () => Promise<unknown>) => op());
    const deleteAnalyticsForSource = vi.fn(async () => []);
    const removal = makeRemoval({
      analyticsDb: { deleteAnalyticsForSource } as unknown as AnalyticsDb,
      sourceWriteEpochFence: {
        runSourceExclusive,
        runGlobalExclusive,
      } as unknown as SourceWriteEpochFence,
    });

    await removal.deleteProvider("google");
    expect(runGlobalExclusive).toHaveBeenCalledWith(expect.any(Function));
    expect(deleteAnalyticsForSource).toHaveBeenCalledWith(sourceId);

    await removal.deleteSource(sourceId);
    expect(runSourceExclusive).toHaveBeenCalledWith(sourceId, expect.any(Function));
  });

  test("provider wipe clears index and analytics for every affected source", async () => {
    const sourceId = seedSourceWithDocs();
    const deleteIndexBySource = vi.fn(async () => 0);
    const deleteAnalyticsForSource = vi.fn(async () => []);
    const removal = makeRemoval({
      indexWriteGate: { deleteIndexBySource } as unknown as IndexWriteGate,
      analyticsDb: { deleteAnalyticsForSource } as unknown as AnalyticsDb,
    });

    await removal.deleteProvider("google");

    expect(deleteIndexBySource).toHaveBeenCalledWith(sourceId);
    expect(deleteAnalyticsForSource).toHaveBeenCalledWith(sourceId);
  });

  test("retracts the open loops built on a removed source, and their mirrors", async () => {
    // The loop cascade ran only on single-document privacy delete. A bulk
    // sweep left loops citing documents that no longer exist — and their
    // mirror documents, which carry the loop's title and description.
    const sourceId = seedSourceWithDocs();
    const docId = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE source_id = ? LIMIT 1")
      .get(sourceId)!.id;
    createOpenLoop(
      db,
      {
        id: "loop_swept",
        createdByRun: "run_1",
        title: "Chase the flooring quote",
        description: "Grounded on a document that is about to go.",
        confidence: 0.8,
        importance: 0.6,
        docs: [docId],
      },
      Date.now(),
    );
    upsertDocuments(db, [buildOpenLoopDocumentInput(getOpenLoop(db, "loop_swept")!, [])]);
    expect(getOpenLoop(db, "loop_swept")).not.toBeNull();
    const mirrorCount = (): number =>
      db
        .prepare<
          [],
          { n: number }
        >("SELECT COUNT(*) AS n FROM documents WHERE external_id = 'loop_swept'")
        .get()!.n;
    expect(mirrorCount()).toBe(1);

    const { gate } = spyIndexGate();
    await makeRemoval({ indexWriteGate: gate }).deleteSource(sourceId);

    expect(getOpenLoop(db, "loop_swept"), "loop retracted").toBeNull();
    expect(mirrorCount(), "mirror document removed with it").toBe(0);
  });

  test("also notifies the collector when a WS server is present", async () => {
    const sourceId = seedSourceWithDocs();
    const { gate, deleteIndexBySource } = spyIndexGate();
    const sendCommand = vi.fn(async () => ({}));
    const wsServer = { sendCommand } as unknown as DeviceWsServer;

    const svc = makeService({ indexWriteGate: gate, wsServer });
    await svc.deleteSource(sourceId as never);

    expect(sendCommand).toHaveBeenCalled(); // source.removed dispatched
    await vi.waitFor(() => expect(getDocumentCount(db, sourceId)).toBe(0)); // sweep still runs
    await vi.waitFor(() => expect(deleteIndexBySource).toHaveBeenCalledWith(sourceId));
  });

  test("a failed config mirror cannot strand durable removal before dispatch and cleanup", async () => {
    const id = SourceId(seedSourceWithDocs());
    const sendCommand = vi.fn(async () => ({}));
    const svc = makeService({
      wsServer: { sendCommand } as unknown as DeviceWsServer,
      syncSourceSettingsToConfig: async () => {
        throw new Error("config unavailable");
      },
    });

    await expect(svc.deleteSource(id)).resolves.toMatchObject({ source: { id } });
    expect(sendCommand).toHaveBeenCalledWith(
      expect.any(String),
      "source.removed",
      { sourceId: id },
      5_000,
    );
    await vi.waitFor(() => expect(isSourceCleanupPending(db, id)).toBe(false));
    expect(getDocumentCount(db, id)).toBe(0);
  });

  test("returns null for an unknown source", async () => {
    const { gate } = spyIndexGate();
    const svc = makeService({ indexWriteGate: gate, wsServer: undefined });
    expect(await svc.deleteSource("gmail:missing@example.com" as never)).toBeNull();
  });
});

describe("SourceDataRemovalService.deleteStream", () => {
  /** A partitioned source with one page per device stream and one on the shared stream. */
  function seedStreams(): { sourceId: string; idsOf: (streamId: string) => string[] } {
    const sourceId = SourceId("visits-synth:local");
    const page = (streamId: string, externalIds: string[]) =>
      upsertWithCursor(db, {
        providerId: "visits-synth",
        sourceId,
        documents: externalIds.map((externalId) => ({
          providerId: ProviderId("visits-synth"),
          sourceId,
          externalId,
          title: externalId,
          content: `${streamId} ${externalId}`,
          contentHash: `${streamId}-${externalId}`,
          metadata: {},
          sourceCreatedAt: "2026-01-01T00:00:00Z",
          sourceUpdatedAt: "2026-01-01T00:00:00Z",
        })),
        hasMore: false,
        cursor: { page: 1 },
        cursorDeviceId: streamId,
        streamId,
        wipeEpoch: getWipeEpoch(db, sourceId, streamId),
      });
    page("device-a", ["day-1", "day-2"]);
    page("device-b", ["day-1", "day-2"]);
    page("", ["old-1"]);
    const idsOf = (streamId: string): string[] =>
      db
        .prepare<[string, string], { id: string }>(
          "SELECT id FROM documents WHERE source_id = ? AND stream_id = ? ORDER BY id",
        )
        .all(sourceId, streamId)
        .map((r) => r.id);
    return { sourceId, idsOf };
  }

  test("unresolved stream ownership leaves documents and its cursor unchanged", async () => {
    const { sourceId, idsOf } = seedStreams();
    const before = idsOf("device-a");
    const cursorBefore = db
      .prepare("SELECT * FROM sync_state WHERE source_id = ? ORDER BY device_id")
      .all(sourceId);
    const purgeAnnotationsFor = vi.fn(async () => {});
    const prepareSourceRemoval = vi.fn(async () => {
      throw new RowKeyError("Ownership recovery is incomplete");
    });
    await expect(
      makeRemoval({
        purgeAnnotationsFor,
        analyticsDb: { prepareSourceRemoval } as unknown as AnalyticsDb,
      }).deleteStream(sourceId, "device-a", { resetCursor: true }),
    ).rejects.toMatchObject({
      status: 409,
      code: "ANALYTICS_OWNERSHIP_UNRESOLVED",
    });
    expect(prepareSourceRemoval).toHaveBeenCalledWith(sourceId, "device-a");
    expect(idsOf("device-a")).toEqual(before);
    expect(
      db.prepare("SELECT * FROM sync_state WHERE source_id = ? ORDER BY device_id").all(sourceId),
    ).toEqual(cursorBefore);
    expect(purgeAnnotationsFor).not.toHaveBeenCalled();
  });

  test("runs the cognition, index and analytics arms over the stream's ids, fenced on the device's row", async () => {
    const { sourceId, idsOf } = seedStreams();
    const doomed = idsOf("device-a");
    const purgeAnnotationsFor = vi.fn(async (_ids: readonly string[]) => {});
    const deleteChunksByDocuments = vi.fn(async (ids: readonly string[]) => ids.length);
    const deleteAnalyticsStream = vi.fn(async (_s: string, _d: string) => ["visit_days"]);
    const run = vi.fn((_scope: string, op: () => Promise<unknown>) => op());
    const removal = makeRemoval({
      purgeAnnotationsFor,
      indexWriteGate: { deleteChunksByDocuments } as unknown as IndexWriteGate,
      analyticsDb: { deleteAnalyticsStream } as unknown as AnalyticsDb,
      sourceWriteEpochFence: { run } as unknown as SourceWriteEpochFence,
    });

    const result = await removal.deleteStream(sourceId, "device-a");

    expect(result).toEqual({ deleted: 2, analyticsCleaned: ["visit_days"] });
    expect(purgeAnnotationsFor).toHaveBeenCalledTimes(2);
    for (const [ids] of purgeAnnotationsFor.mock.calls) expect([...ids].sort()).toEqual(doomed);
    expect(deleteChunksByDocuments).toHaveBeenCalledTimes(1);
    expect([...deleteChunksByDocuments.mock.calls[0]![0]].sort()).toEqual(doomed);
    expect(deleteAnalyticsStream).toHaveBeenCalledWith(sourceId, "device-a");
    expect(run).toHaveBeenCalledWith(epochScope(sourceId, "device-a"), expect.any(Function));
    expect(idsOf("device-a")).toEqual([]);
    expect(idsOf("device-b")).toHaveLength(2);
    expect(idsOf("")).toHaveLength(1);
  });

  test("retracts the cognitive state grounded on the stream's documents only, and keeps the source's coverage", async () => {
    const { sourceId, idsOf } = seedStreams();
    createDevice(db, { name: "phone-a", kind: "android" });
    const annotate = (id: string, docId: string) =>
      createDocAnnotation(
        db,
        {
          id,
          docId,
          claimType: "fact",
          claimText: "a claim about the day",
          evidenceDocId: docId,
          evidenceQuote: "day",
          confidence: 0.9,
          claimBasis: "stated",
          createdByRun: "run_1",
        },
        Date.now(),
      );
    annotate("anno_a", idsOf("device-a")[0]!);
    annotate("anno_b", idsOf("device-b")[0]!);
    db.prepare(
      `INSERT INTO cognition_coverage (source_id, workflow_id, workflow_version, eligible, processed, skipped, prompt_tokens, completion_tokens, last_progress_at, status)
       VALUES (?, 'wf', 1, 4, 4, 0, 0, 0, 1, 'live')`,
    ).run(sourceId);
    const annotationIds = (): string[] =>
      db
        .prepare<[], { id: string }>("SELECT id FROM doc_annotations ORDER BY id")
        .all()
        .map((r) => r.id);

    await makeRemoval().deleteStream(sourceId, "device-a");

    expect(annotationIds()).toEqual(["anno_b"]);
    expect(
      db
        .prepare<
          [string],
          { n: number }
        >("SELECT COUNT(*) AS n FROM cognition_coverage WHERE source_id = ?")
        .get(sourceId)!.n,
    ).toBe(1);
  });

  test("fails loudly when a store's cleanup fails, after the documents are gone", async () => {
    const { sourceId, idsOf } = seedStreams();
    const removal = makeRemoval({
      analyticsDb: {
        deleteAnalyticsStream: async () => {
          throw new Error("analytics unavailable");
        },
      } as unknown as AnalyticsDb,
    });

    await expect(removal.deleteStream(sourceId, "device-a")).rejects.toThrow(
      "analytics unavailable",
    );
    expect(idsOf("device-a")).toEqual([]);
    await expect(removal.deleteStream(sourceId, "")).rejects.toThrow(/shared stream/);
  });

  test("reports every failing store at once, naming the stream", async () => {
    const { sourceId } = seedStreams();
    const removal = makeRemoval({
      indexWriteGate: {
        deleteChunksByDocuments: async () => {
          throw new Error("index unavailable");
        },
      } as unknown as IndexWriteGate,
      analyticsDb: {
        deleteAnalyticsStream: async () => {
          throw new Error("analytics unavailable");
        },
      } as unknown as AnalyticsDb,
    });

    const failure: unknown = await removal.deleteStream(sourceId, "device-a").catch((e) => e);

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toBe(`Stream cleanup incomplete for ${sourceId} (device device-a)`);
    expect(aggregate.errors.map((e) => (e as Error).message)).toEqual([
      "index unavailable",
      "analytics unavailable",
    ]);
  });
});

describe("SourceService permission-health invalidation", () => {
  function phoneSource() {
    const phone = createDevice(db, { name: "Fictional phone", kind: "ios" });
    const source = createSource(db, {
      type: SourceType("photos"),
      accountId: AccountId("local"),
      deviceId: phone.id,
    });
    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: phone.id,
      report: {
        checkedAt: 1_000,
        validForMs: 60_000,
        capabilities: [
          {
            id: "background",
            label: "Background access",
            state: "background-access-missing",
            requirement: "required",
            impact: "Background collection stops.",
            remediation: "Enable background access.",
            repairAction: "open-system-settings",
          },
        ],
      },
      receivedAt: 1_000,
    });
    return { phone, source };
  }

  test("clears health when a source is disabled", async () => {
    const { source } = phoneSource();
    const service = makeService();

    await service.updateSource(source.id, { enabled: false });

    expect(getMobilePermissionHealth(db, source.id)).toBeNull();
  });

  test("bulk enabled=false also invalidates permission health", async () => {
    const { phone, source } = phoneSource();
    const service = makeService();

    await service.bulkUpsertForDevice(phone.id, [
      {
        id: source.id,
        type: "photos",
        accountId: "local",
        enabled: false,
      },
    ]);

    expect(getMobilePermissionHealth(db, source.id)).toBeNull();
  });

  test("bulk upsert collects a malformed explicit id as an entry error", async () => {
    const phone = createDevice(db, { name: "Fictional phone", kind: "ios" });
    const service = makeService();

    const result = await service.bulkUpsertForDevice(phone.id, [
      {
        id: "invalid\0source",
        type: "photos",
        accountId: "local",
      } as never,
    ]);

    expect(result.sources).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  test("re-homing and removal invalidate permission health", async () => {
    const { source } = phoneSource();
    const nextPhone = createDevice(db, { name: "Fictional replacement phone", kind: "android" });
    const service = makeService();

    await service.updateSource(source.id, { deviceId: nextPhone.id });
    expect(getMobilePermissionHealth(db, source.id)).toBeNull();

    replaceMobilePermissionHealth(db, {
      sourceId: source.id,
      deviceId: nextPhone.id,
      report: { checkedAt: 2_000, validForMs: 60_000, capabilities: [] },
      receivedAt: 2_000,
    });
    await service.deleteSource(source.id);
    expect(getMobilePermissionHealth(db, source.id)).toBeNull();
  });
});

describe("SourceService.resync", () => {
  /** A collector-hosted source with documents, and a WS server answering `source.sync` as told. */
  function collectorSource(
    answer: unknown,
    opts: { capabilities?: DeviceCapability; account?: string } = {},
  ) {
    const account = opts.account ?? "maya@example.com";
    const device = createDevice(db, {
      name: `Collector of ${account}`,
      kind: "collector",
      capabilities: opts.capabilities ?? {},
    });
    const source = createSource(db, {
      type: SourceType("mail-synth"),
      accountId: AccountId(account),
      deviceId: device.id,
    });
    if (!source) throw new Error("fixture source was not created");
    upsertDocuments(db, [
      {
        providerId: "mail-synth",
        sourceId: source.id,
        externalId: "ext-1",
        title: "Doc 1",
        content: "body 1",
        contentHash: "hash-1",
        metadata: {},
        sourceCreatedAt: "2026-01-01T00:00:00Z",
        sourceUpdatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    const sendCommand = vi.fn(() => Promise.resolve(answer));
    const { gate } = spyIndexGate();
    const service = makeService({
      sourceDataRemoval: makeRemoval({ indexWriteGate: gate }),
      wsServer: { sendCommand, isConnected: () => true } as unknown as DeviceWsServer,
    });
    return { device, source, sendCommand, service };
  }

  test("a member that answers skipped is reported as skipped, not as sent", async () => {
    const { device, source, service } = collectorSource({ ok: true, triggered: 0, skipped: 1 });

    const result = await service.resync(source.id);

    expect(result.deviceIds).toEqual([]);
    expect(result.skipped).toEqual([device.id]);
    expect(result.restarting).toEqual([]);
    expect(result.disabled).toEqual([]);
    expect(getDocumentCount(db, source.id), "the wipe still happened").toBe(0);
    service.dispose();
  });

  test("a member on which the source is paused is reported as paused, not as already syncing", async () => {
    const { device, source, service } = collectorSource({
      ok: true,
      triggered: 0,
      skipped: 0,
      disabled: 1,
    });

    const result = await service.resync(source.id);

    expect(result).toMatchObject({
      deviceIds: [],
      restarting: [],
      skipped: [],
      disabled: [device.id],
    });
    expect(getDocumentCount(db, source.id), "the wipe still happened").toBe(0);
    service.dispose();
  });

  test("a resync asks the member to restart, and reports a restart the member took", async () => {
    const { device, source, sendCommand, service } = collectorSource({
      ok: true,
      triggered: 0,
      skipped: 0,
      restarting: 1,
    });

    const result = await service.resync(source.id);

    expect(sendCommand).toHaveBeenCalledWith(device.id, "source.sync", {
      sourceId: source.id,
      restart: true,
    });
    expect(result.restarting).toEqual([device.id]);
    expect(result.deviceIds).toEqual([]);
    expect(result.skipped).toEqual([]);
    service.dispose();
  });

  test("a member that started the sync is reported under deviceIds, as an answer without counts is", async () => {
    const started = collectorSource({ ok: true, triggered: 1, skipped: 0 });
    expect(await started.service.resync(started.source.id)).toMatchObject({
      deviceIds: [started.device.id],
      restarting: [],
      skipped: [],
    });
    started.service.dispose();

    const uncounted = collectorSource({ ok: true }, { account: "jamie@example.com" });
    expect(await uncounted.service.resync(uncounted.source.id)).toMatchObject({
      deviceIds: [uncounted.device.id],
      restarting: [],
      skipped: [],
    });
    uncounted.service.dispose();
  });

  test("a source whose data only arrives by push is refused, and nothing is deleted", async () => {
    // A browser extension holds no archive of the pages it captured.
    const browser = createDevice(db, { name: "Maya-Chrome", kind: "browser" });
    const captured = createSource(db, {
      type: SourceType("web"),
      accountId: AccountId("local"),
      deviceId: browser.id,
    });
    if (!captured) throw new Error("fixture source was not created");
    // A collector-hosted push source has an inert sync(); an external
    // runtime pushes its data.
    const hosted = collectorSource(
      { ok: true, triggered: 1 },
      { capabilities: { pushBasedSourceTypes: [SourceType("mail-synth")] } },
    );
    const docs = (id: string) => getDocumentCount(db, id);
    upsertDocuments(db, [
      {
        providerId: "web",
        sourceId: captured.id,
        externalId: "page-1",
        title: "Captured page",
        content: "captured body",
        contentHash: "page-hash-1",
        metadata: {},
        sourceCreatedAt: "2026-01-01T00:00:00Z",
        sourceUpdatedAt: "2026-01-01T00:00:00Z",
      },
    ]);

    for (const id of [captured.id, hosted.source.id]) {
      const before = docs(id);
      await expect(hosted.service.resync(id)).rejects.toMatchObject({
        status: 400,
        code: "RESYNC_PUSH_ONLY",
      });
      expect(docs(id), "nothing was deleted").toBe(before);
    }
    expect(hosted.sendCommand).not.toHaveBeenCalled();
    hosted.service.dispose();
  });

  test("a per-device resync names the member, so a member that only pushes is refused while the owner is not", async () => {
    const owner = createDevice(db, { name: "Maya-Laptop", kind: "collector", capabilities: {} });
    const pusher = createDevice(db, {
      name: "Studio-Mini",
      kind: "collector",
      capabilities: { pushBasedSourceTypes: [SourceType("tasks-synth")] },
    });
    const source = createSource(db, {
      type: SourceType("tasks-synth"),
      accountId: AccountId("local"),
      deviceId: owner.id,
      multiDeviceMode: "replicated",
    });
    if (!source) throw new Error("fixture source was not created");
    addSourceMember(db, source.id, pusher.id);
    const sendCommand = vi.fn(() => Promise.resolve({ ok: true, triggered: 1 }));
    const resetMemberCursor = vi.fn(async () => {});
    const service = makeService({
      writeGate: { ...directWriteGate(db), resetMemberCursor },
      wsServer: { sendCommand, isConnected: () => true } as unknown as DeviceWsServer,
    });

    await expect(service.resync(source.id, pusher.id)).rejects.toMatchObject({
      status: 400,
      code: "RESYNC_PUSH_ONLY",
    });
    expect(resetMemberCursor, "nothing was reset").not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();

    await expect(service.resync(source.id, owner.id)).resolves.toMatchObject({
      scope: "cursor",
      deviceIds: [owner.id],
    });
    expect(resetMemberCursor).toHaveBeenCalledWith(source.id, owner.id);
    service.dispose();
  });

  test("a phone-hosted source is not push-only: the phone re-reads its own store when told to sync", async () => {
    const phone = createDevice(db, {
      name: "Maya-Phone",
      kind: "ios",
      capabilities: {
        hostableSourceTypes: [SourceType("health-synth")],
        pushBasedSourceTypes: [SourceType("health-synth")],
      },
    });
    const source = createSource(db, {
      type: SourceType("health-synth"),
      accountId: AccountId("me"),
      deviceId: phone.id,
    });
    if (!source) throw new Error("fixture source was not created");
    const sendCommand = vi.fn(() => Promise.resolve({ ok: true, triggered: 1, skipped: 0 }));
    const { gate } = spyIndexGate();
    const service = makeService({
      sourceDataRemoval: makeRemoval({ indexWriteGate: gate }),
      wsServer: { sendCommand, isConnected: () => true } as unknown as DeviceWsServer,
    });

    await expect(service.resync(source.id)).resolves.toMatchObject({
      scope: "source",
      deviceIds: [phone.id],
    });
    service.dispose();
  });
});
