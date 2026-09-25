// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { LogLevel, setLogLevel } from "@omnesis/core";
import { SyncError, SourceId, type DocumentInput, type ProviderId } from "@omnesis/types";
import { SourceSyncRunner } from "./source-sync-runner.js";
import { SourceRegistry } from "./source-registry.js";
import { SyncScheduler } from "./sync-scheduler.js";
import { FileWatcherManager } from "./file-watcher-manager.js";
import { FreshnessProbe } from "./freshness-probe.js";
import { FeedProcessSupervisor } from "./feed-process-supervisor.js";
import type {
  RegisteredProvider,
  RegisteredSource,
  StatusChangeEvent,
} from "./sync-engine-types.js";
import type {
  GatewayClient,
  SyncCursor,
  SyncOptions,
  SyncState,
  SyncResult,
  SourceWatermark,
  StructuredSyncResult,
  AnalyticsTableSchema,
  DocumentTemporalProjectionSpec,
  SourceFreshness,
  UpsertWithCursorResponse,
  SnapshotAbsenceOutcome,
  SnapshotClaim,
  IngestAnalyticsResponse,
  AnalyticsPageIngest,
  PendingStructuredPage,
  PrepareStructuredPage,
} from "@omnesis/source-sdk";

/**
 * Direct unit harness for `SourceSyncRunner`.
 *
 * Unlike the `SyncEngine`-driven tests, these construct the runner against
 * a deliberately *dumb* gateway mock that records calls but does NOT
 * reimplement any gateway-side guard (e.g. the `!hasMore` reconcile gate).
 * That is the whole point: a runner regression — passing `presentExternalIds`
 * through on a partial page, losing analytics ordering, or failing to flip a
 * stuck source to `error` — must surface here even though the production
 * gateway would also catch the mass-delete case defence-in-depth.
 */

/** Records every call the runner makes, without any gateway-side gating logic. */
class RecordingGateway implements Partial<GatewayClient> {
  /** Ordered log of every gateway interaction, for cross-call ordering asserts. */
  calls: Array<
    | {
        kind: "ingestAnalytics";
        tableName: string;
        records: Record<string, unknown>[];
        schema?: AnalyticsTableSchema;
        deletedIds?: string[];
        deletedKeys?: Record<string, unknown>[];
        deleteKeyColumn?: string;
        presentIds?: string[];
        presentKeys?: Record<string, unknown>[];
        writeEpoch?: number;
        observationId?: string;
      }
    | {
        kind: "upsertWithCursor";
        documents?: DocumentInput[];
        documentTemporalProjections?: DocumentTemporalProjectionSpec[];
        presentExternalIds?: string[];
        presentClaims?: SnapshotClaim[];
        observationId?: string;
        hasMore: boolean;
        cursor: SyncCursor;
        wipeEpoch?: number;
        watermark?: SourceWatermark;
      }
  > = [];

  syncStates = new Map<string, SyncState>();
  writeEpochs = new Map<string, number>();
  begunEpochs: number[] = [];
  revokedEpochs: number[] = [];
  beginBlocks: Array<Promise<void> | undefined> = [];
  beginAttemptIds: Array<string | undefined> = [];
  beginCalls = 0;
  rejectWrites = false;
  rejectAsRemoved = false;
  /** Absence outcome the next with-cursor page reports back. */
  absence: SnapshotAbsenceOutcome | undefined = undefined;
  /** Actual explicit-tombstone count the next with-cursor page reports. */
  tombstonedDeleted: number | undefined = undefined;
  /** Absence outcome the next analytics page reports back. */
  analyticsAbsence: SnapshotAbsenceOutcome | undefined = undefined;
  /** Explicit response used to exercise whole-page analytics rejection. */
  analyticsResponse: IngestAnalyticsResponse | undefined = undefined;
  /** Ordered responses used when one structured page makes two analytics calls. */
  analyticsResponses: IngestAnalyticsResponse[] = [];
  upsertBlock?: Promise<void>;
  revokeBlock?: Promise<void>;

  async getSyncState(sourceId: SourceId): Promise<SyncState | null> {
    return this.syncStates.get(sourceId) ?? null;
  }

  async getWipeEpoch(sourceId: SourceId): Promise<number | undefined> {
    return this.writeEpochs.get(sourceId) ?? this.syncStates.get(sourceId)?.wipeEpoch;
  }

  async beginSyncAttempt(
    sourceId: SourceId,
    options: { attemptId?: string } = {},
  ): Promise<number> {
    const call = this.beginCalls++;
    this.beginAttemptIds.push(options.attemptId);
    await this.beginBlocks[call];
    const epoch = (this.writeEpochs.get(sourceId) ?? 0) + 1;
    this.writeEpochs.set(sourceId, epoch);
    this.begunEpochs.push(epoch);
    return epoch;
  }

  async revokeSyncAttempt(
    sourceId: SourceId,
    writeEpoch?: number,
    _attemptId?: string,
  ): Promise<boolean> {
    await this.revokeBlock;
    if (writeEpoch === undefined) return false;
    if (this.writeEpochs.get(sourceId) !== writeEpoch) return false;
    this.writeEpochs.set(sourceId, writeEpoch + 1);
    this.revokedEpochs.push(writeEpoch);
    return true;
  }

  async ingestAnalyticsPage(page: AnalyticsPageIngest) {
    this.calls.push({
      kind: "ingestAnalytics",
      tableName: page.tableName,
      records: page.records,
      schema: page.schema,
      deletedIds: page.deletedIds,
      deletedKeys: page.deletedKeys,
      deleteKeyColumn: page.deleteKeyColumn,
      presentIds: page.presentIds,
      presentKeys: page.presentKeys,
      writeEpoch: page.writeEpoch,
      observationId: page.observationId,
    });
    return (
      this.analyticsResponses.shift() ??
      this.analyticsResponse ?? {
        ingested: page.records.length,
        ...(this.analyticsAbsence ? { absence: this.analyticsAbsence } : {}),
      }
    );
  }

  async upsertWithCursor(args: {
    providerId: ProviderId;
    sourceId: SourceId;
    documents?: DocumentInput[];
    documentTemporalProjections?: DocumentTemporalProjectionSpec[];
    deletedExternalIds?: string[];
    presentExternalIds?: string[];
    presentClaims?: SnapshotClaim[];
    observationId?: string;
    hasMore: boolean;
    cursor: SyncCursor;
    wipeEpoch?: number;
    watermark?: SourceWatermark;
  }): Promise<UpsertWithCursorResponse> {
    this.calls.push({
      kind: "upsertWithCursor",
      documents: args.documents,
      documentTemporalProjections: args.documentTemporalProjections,
      presentExternalIds: args.presentExternalIds,
      presentClaims: args.presentClaims,
      observationId: args.observationId,
      hasMore: args.hasMore,
      cursor: args.cursor,
      wipeEpoch: args.wipeEpoch,
      watermark: args.watermark,
    });
    await this.upsertBlock;
    this.syncStates.set(args.sourceId, {
      sourceId: args.sourceId,
      cursor: args.cursor,
      lastSyncedAt: new Date().toISOString(),
      wipeEpoch: args.wipeEpoch,
    });
    // No reconcile here: the gateway-side gate is intentionally NOT
    // reimplemented, so any reconcile the runner *requests* (by passing
    // presentExternalIds) is visible in the call log unfiltered.
    return {
      ingested: this.rejectWrites ? 0 : (args.documents?.length ?? 0),
      reconciledDeleted: 0,
      ...(this.tombstonedDeleted === undefined
        ? {}
        : { tombstonedDeleted: this.tombstonedDeleted }),
      indexCleanedRows: 0,
      ...(this.absence ? { absence: this.absence } : {}),
      ...(this.rejectWrites ? { rejected: true as const } : {}),
      ...(this.rejectAsRemoved ? { rejectedAsRemoved: true as const } : {}),
    };
  }
}

const ANALYTICS_SCHEMA: AnalyticsTableSchema = {
  tableName: "step_counts",
  displayName: "Step Counts",
  description: "Daily step totals.",
  columns: [
    { name: "day", type: "DATE", description: "Calendar day." },
    { name: "steps", type: "INTEGER", description: "Steps walked." },
  ],
  primaryKey: ["day"],
  semanticTimeColumn: "day",
  record: { titleColumns: ["day"], keyColumns: ["day", "steps"] },
};

function makeStructuredSource(
  id: string,
  syncStructured: (cursor: SyncCursor | null, opts?: SyncOptions) => Promise<StructuredSyncResult>,
  schemas: AnalyticsTableSchema[] = [ANALYTICS_SCHEMA],
): RegisteredSource {
  return {
    id: id as SourceId,
    name: id,
    providerId: id as ProviderId,
    family: { name: id },
    instance: {
      // A structured source still satisfies the SourceInstance contract's
      // required `sync` — the runner routes to `syncStructured` when both it
      // and `analyticsSchemas` are present, so this never gets called here.
      sync: async () => {
        throw new Error("sync() should not be called for a structured source");
      },
      syncStructured,
      analyticsSchemas: schemas,
    },
  };
}

function makeDocumentSource(
  id: string,
  sync: (cursor: SyncCursor | null, opts?: SyncOptions) => Promise<SyncResult>,
): RegisteredSource {
  return {
    id: id as SourceId,
    name: id,
    providerId: id as ProviderId,
    family: { name: id },
    instance: { sync },
  };
}

function makeProvider(source: RegisteredSource): RegisteredProvider {
  return {
    id: source.providerId,
    name: source.providerId,
    credentialState: () => Promise.resolve({ status: "connected" as const }),
    renewableCredential: true,
    sources: [source],
  };
}

/** Build a registry with no real timers/watchers armed (nothing is scheduled). */
function makeRegistry(): { registry: SourceRegistry; events: StatusChangeEvent[] } {
  const scheduler = new SyncScheduler();
  const fileWatchers = new FileWatcherManager(() => {});
  const registry = new SourceRegistry(scheduler, fileWatchers);
  const events: StatusChangeEvent[] = [];
  registry.onStatusChange((e) => events.push(e));
  return { registry, events };
}

function makeDoc(externalId: string, sourceId: string): DocumentInput {
  return {
    providerId: sourceId as ProviderId,
    sourceId: sourceId as SourceId,
    externalId,
    title: `Doc ${externalId}`,
    content: `Content of ${externalId}`,
    contentHash: `hash-${externalId}`,
    metadata: {},
    sourceCreatedAt: "2024-01-01T00:00:00Z",
    sourceUpdatedAt: "2024-01-01T00:00:00Z",
  };
}

describe("SourceSyncRunner — structured branch", () => {
  let gateway: RecordingGateway;

  beforeEach(() => {
    gateway = new RecordingGateway();
  });

  function withJournal() {
    let pending: PendingStructuredPage | null = null;
    const client = Object.assign(gateway, {
      getPendingStructuredPage: vi.fn(async () => structuredClone(pending)),
      prepareStructuredPage: vi.fn(async (_sourceId: SourceId, page: PrepareStructuredPage) => {
        if (!pending) {
          const { writeEpoch: _epoch, ...stored } = page;
          pending = structuredClone({ ...stored, cursorCommitted: false });
        }
        return structuredClone(pending);
      }),
      acknowledgeStructuredPage: vi.fn(async (_sourceId: SourceId, page: { id: string }) => {
        if (pending?.id !== page.id || !pending.cursorCommitted) return { acknowledged: false };
        pending = null;
        return { acknowledged: true };
      }),
    });
    const upsert = client.upsertWithCursor.bind(client);
    vi.spyOn(client, "upsertWithCursor").mockImplementation(async (args) => {
      const response = await upsert(args);
      if (pending && !response.rejected) pending.cursorCommitted = true;
      return response;
    });
    return { client, pending: () => pending };
  }

  test("durable preparation failure sends neither analytics nor documents", async () => {
    const { client } = withJournal();
    client.prepareStructuredPage.mockRejectedValueOnce(new Error("journal unavailable"));
    const source = makeStructuredSource("prepare-failure", async () => ({
      analytics: { tableName: "step_counts", records: [{ day: "2024-01-01", steps: 1 }] },
      cursor: { page: 1 },
      hasMore: false,
    }));
    const { registry } = makeRegistry();
    registry.registerProvider(makeProvider(source));
    await new SourceSyncRunner(client as unknown as GatewayClient, registry, 60_000).runOne(source);
    expect(client.calls).toEqual([]);
    expect(registry.getStatus(source.id)?.state).toBe("error");
  });

  test.each([false, true])(
    "replay awaits ownership schema prerequisites (cursor committed: %s)",
    async (cursorCommitted) => {
      const { client, pending } = withJournal();
      const frozenSchema = { ...ANALYTICS_SCHEMA, deleteKey: ["day"] };
      const original = await client.prepareStructuredPage(SourceId("schema-replay"), {
        id: "00000000-0000-4000-8000-000000000001",
        writeEpoch: 1,
        result: {
          analytics: [
            {
              tableName: "step_counts",
              schema: frozenSchema,
              records: [{ day: "2024-01-01", steps: 1 }],
            },
            {
              tableName: "step_counts",
              schema: frozenSchema,
              presentIds: ["2024-01-01"],
              deleteKeyColumn: "day",
            },
          ],
          cursor: { page: 1 },
          hasMore: false,
        },
      });
      pending()!.cursorCommitted = cursorCommitted;
      original.cursorCommitted = cursorCommitted;
      const current: AnalyticsTableSchema = {
        ...ANALYTICS_SCHEMA,
        primaryKey: ["owner", "day"],
        deleteKey: ["owner", "day"],
        sharedDiscriminatorColumn: "owner",
        dynamicColumns: true,
        columns: [
          ...ANALYTICS_SCHEMA.columns,
          { name: "owner", type: "VARCHAR", nullable: true, description: "Owning account." },
          { name: "unrelated", type: "VARCHAR", description: "Unrelated future field." },
        ],
      };
      const sync = vi.fn(async (): Promise<StructuredSyncResult> => {
        throw new Error("must replay");
      });
      const source = makeStructuredSource("schema-replay", sync, [current]);
      const { registry } = makeRegistry();
      registry.registerProvider(makeProvider(source));
      const ingest = client.ingestAnalyticsPage.bind(client);
      const ingests = vi
        .spyOn(client, "ingestAnalyticsPage")
        .mockRejectedValueOnce(new Error("schema unavailable"));
      const runner = () =>
        new SourceSyncRunner(client as unknown as GatewayClient, registry, 60_000);
      await runner().runOne(source);
      expect(pending()).toEqual(original);
      expect(client.upsertWithCursor).not.toHaveBeenCalled();
      expect(client.acknowledgeStructuredPage).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(ingests).toHaveBeenCalledTimes(1);
      const prerequisite = ingests.mock.calls[0][0];
      expect(prerequisite).toMatchObject({
        records: [],
        sourceId: source.id,
        writeEpoch: 1,
        schema: {
          ...frozenSchema,
          sharedDiscriminatorColumn: "owner",
          columns: [...frozenSchema.columns, current.columns[2]],
        },
      });
      expect(prerequisite.schema?.dynamicColumns).toBeUndefined();
      expect(prerequisite.pendingPageId).toBeUndefined();
      expect(prerequisite.writeOrdinal).toBeUndefined();
      ingests.mockClear().mockImplementation(ingest);
      await runner().runOne(source);
      expect(ingests.mock.calls.filter(([page]) => page.pendingPageId === undefined)).toHaveLength(
        1,
      );
      const replay = ingests.mock.calls.filter(([page]) => page.pendingPageId !== undefined);
      expect(replay.length).toBeGreaterThan(0);
      expect(replay.every(([page]) => page.pendingPageId === original.id)).toBe(true);
      if (!cursorCommitted)
        expect(replay[0][0]).toMatchObject({ schema: frozenSchema, writeOrdinal: 0 });
      expect(sync).not.toHaveBeenCalled();
      expect(pending()).toBeNull();
    },
  );

  test.each(["both", "child-only", "already-declared", "dynamic-parent", "cycle"])(
    "registers static parent ownership before child replay (%s)",
    async (scenario) => {
      const childOnly = scenario !== "both";
      const { client, pending } = withJournal();
      const child = { ...ANALYTICS_SCHEMA, tableName: "step_details" };
      const writes = [
        { tableName: child.tableName, schema: child, records: [] },
        ...(childOnly
          ? []
          : [{ tableName: ANALYTICS_SCHEMA.tableName, schema: ANALYTICS_SCHEMA, records: [] }]),
      ];
      const original = await client.prepareStructuredPage(SourceId("related-replay"), {
        id: "00000000-0000-4000-8000-000000000003",
        writeEpoch: 1,
        result: { analytics: writes, cursor: { page: 1 }, hasMore: false },
      });
      const owner = {
        name: "owner",
        type: "VARCHAR" as const,
        nullable: true,
        description: "Owning account.",
      };
      const parentRelation = { table: "step_counts", column: "day", parentColumn: "day" };
      const current: AnalyticsTableSchema[] = [
        {
          ...child,
          columns: [...child.columns, owner],
          sharedDiscriminatorColumn: "owner",
          sharedDiscriminatorParent: parentRelation,
        },
        {
          ...ANALYTICS_SCHEMA,
          columns: [...ANALYTICS_SCHEMA.columns, owner],
          sharedDiscriminatorColumn: "owner",
          ...(scenario === "dynamic-parent" ? { dynamicColumns: true as const } : {}),
          ...(scenario === "cycle"
            ? {
                sharedDiscriminatorParent: {
                  table: "step_details",
                  column: "day",
                  parentColumn: "day",
                },
              }
            : {}),
        },
      ];
      if (scenario === "already-declared") {
        pending()!.result.analytics = [{ ...writes[0], schema: current[0] }];
        original.result.analytics = structuredClone(pending()!.result.analytics);
        writes[0].schema = current[0];
      }
      const sync = vi.fn(async (): Promise<StructuredSyncResult> => {
        throw new Error("must replay");
      });
      const source = makeStructuredSource("related-replay", sync, current);
      const { registry } = makeRegistry();
      registry.registerProvider(makeProvider(source));
      const ingest = client.ingestAnalyticsPage.bind(client);
      const ingests = vi.spyOn(client, "ingestAnalyticsPage").mockImplementation(async (page) => {
        expect(pending()?.result).toEqual(original.result);
        return ingest(page);
      });
      await new SourceSyncRunner(client as unknown as GatewayClient, registry, 60_000).runOne(
        source,
      );
      if (scenario === "dynamic-parent" || scenario === "cycle") {
        expect(ingests).not.toHaveBeenCalled();
        expect(client.upsertWithCursor).not.toHaveBeenCalled();
        expect(pending()).toEqual(original);
        expect(registry.getStatus(source.id)?.state).toBe("error");
        return;
      }
      const prerequisites = ingests.mock.calls.filter(([page]) => !page.pendingPageId);
      expect(prerequisites.map(([page]) => page.tableName)).toEqual([
        "step_counts",
        "step_details",
      ]);
      expect(prerequisites.at(-1)?.[0].schema?.sharedDiscriminatorParent).toEqual(parentRelation);
      expect(
        ingests.mock.calls.filter(([page]) => page.pendingPageId).map(([page]) => page.schema),
      ).toEqual(writes.map((write) => write.schema));
      expect(sync).not.toHaveBeenCalled();
      expect(pending()).toBeNull();
    },
  );

  test.each(["dynamic", "legacy-dynamic", "different-owner", "different-type", "missing-schema"])(
    "refuses unsafe %s ownership prerequisites without touching the journal",
    async (reason) => {
      const { client, pending } = withJournal();
      const frozen: AnalyticsTableSchema = {
        ...ANALYTICS_SCHEMA,
        ...(reason === "legacy-dynamic"
          ? {
              columns: ANALYTICS_SCHEMA.columns.map((column) => ({
                ...column,
                sourceColumnId: `upstream-${column.name}`,
              })),
            }
          : {}),
        ...(reason === "dynamic" ? { dynamicColumns: true as const } : {}),
        ...(reason === "different-owner" ? { sharedDiscriminatorColumn: "day" } : {}),
      };
      const original = await client.prepareStructuredPage(SourceId("unsafe-replay"), {
        id: "00000000-0000-4000-8000-000000000002",
        writeEpoch: 1,
        result: {
          analytics: {
            tableName: "step_counts",
            schema: reason === "missing-schema" ? undefined : frozen,
            deletedIds: ["2024-01-01"],
            deleteKeyColumn: "day",
          },
          cursor: { page: 1 },
          hasMore: false,
        },
      });
      const current: AnalyticsTableSchema = {
        ...ANALYTICS_SCHEMA,
        sharedDiscriminatorColumn: reason === "different-type" ? "day" : "owner",
        columns: [
          { name: "day", type: "VARCHAR", description: "Changed type." },
          { name: "owner", type: "VARCHAR", description: "Owning account." },
        ],
      };
      const sync = vi.fn(async (): Promise<StructuredSyncResult> => {
        throw new Error("must replay");
      });
      const source = makeStructuredSource("unsafe-replay", sync, [current]);
      const { registry } = makeRegistry();
      registry.registerProvider(makeProvider(source));
      await new SourceSyncRunner(client as unknown as GatewayClient, registry, 60_000).runOne(
        source,
      );
      expect(pending()).toEqual(original);
      expect(client.calls).toEqual([]);
      expect(sync).not.toHaveBeenCalled();
      expect(client.acknowledgeStructuredPage).not.toHaveBeenCalled();
      expect(registry.getStatus(source.id)?.state).toBe("error");
    },
  );

  test("restart replays the exact prepared page before asking mutable upstream for another result", async () => {
    const { client, pending } = withJournal();
    const pageSchema = { ...ANALYTICS_SCHEMA, description: "Runtime-discovered schema" };
    const sync = vi.fn(async () => ({
      analytics: [
        {
          tableName: "step_counts",
          deletedIds: ["old"],
          deleteKeyColumn: "day",
          schema: pageSchema,
        },
        { tableName: "step_counts", records: [{ day: "2024-01-01", steps: 1 }] },
      ],
      documents: [makeDoc("original", "durable-page")],
      cursor: { page: 1 },
      hasMore: false,
    }));
    const source = makeStructuredSource("durable-page", sync);
    const { registry } = makeRegistry();
    registry.registerProvider(makeProvider(source));
    const ingest = client.ingestAnalyticsPage.bind(client);
    const ingests = vi
      .spyOn(client, "ingestAnalyticsPage")
      .mockImplementationOnce(ingest)
      .mockRejectedValueOnce(new Error("second write failed"));
    await new SourceSyncRunner(client as unknown as GatewayClient, registry, 60_000).runOne(source);
    expect(pending()?.cursorCommitted).toBe(false);
    expect(pending()?.result.analytics).toEqual([
      expect.objectContaining({ schema: pageSchema }),
      expect.objectContaining({ schema: pageSchema }),
    ]);
    const id = pending()!.id;
    // A restart may load new provider code/schema, but the old page is immutable.
    source.instance.analyticsSchemas = [];
    sync.mockRejectedValue(new Error("must not fetch upstream again"));
    ingests.mockImplementation(ingest);
    await new SourceSyncRunner(client as unknown as GatewayClient, registry, 60_000).runOne(source);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(ingests.mock.calls.map(([page]) => [page.pendingPageId, page.writeOrdinal])).toEqual([
      [id, 0],
      [id, 1],
      [id, 0],
      [id, 1],
    ]);
    expect(client.calls.at(-1)).toMatchObject({
      documents: [expect.objectContaining({ externalId: "original" })],
    });
    expect(pending()).toBeNull();
    expect(registry.getStatus(source.id)?.state).toBe("idle");
  });

  test("a cursor-committed restart finishes failed snapshots without rewriting data or refetching", async () => {
    const { client, pending } = withJournal();
    const sync = vi.fn(async () => ({
      analytics: {
        tableName: "step_counts",
        records: [{ day: "2024-01-01", steps: 1 }],
        presentIds: ["2024-01-01"],
        deleteKeyColumn: "day",
      },
      cursor: { page: 1 },
      hasMore: false,
    }));
    const source = makeStructuredSource("snapshot-retry", sync);
    const { registry } = makeRegistry();
    registry.registerProvider(makeProvider(source));
    const ingest = client.ingestAnalyticsPage.bind(client);
    const ingests = vi
      .spyOn(client, "ingestAnalyticsPage")
      .mockImplementationOnce(ingest)
      .mockRejectedValueOnce(new Error("snapshot response lost"));
    await new SourceSyncRunner(client as unknown as GatewayClient, registry, 60_000).runOne(source);
    expect(pending()?.cursorCommitted).toBe(true);
    const id = pending()!.id;
    ingests.mockImplementation(ingest);
    client.calls = [];
    await new SourceSyncRunner(client as unknown as GatewayClient, registry, 60_000).runOne(source);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(client.calls).toEqual([
      expect.objectContaining({
        kind: "ingestAnalytics",
        records: [],
        presentIds: ["2024-01-01"],
        observationId: id,
      }),
    ]);
    expect(ingests.mock.calls.at(-1)?.[0]).toMatchObject({ pendingPageId: id, writeOrdinal: 1 });
    expect(pending()).toBeNull();
  });

  test("failed acknowledgement retains the committed journal and repeats only its snapshot receipt", async () => {
    const { client, pending } = withJournal();
    client.acknowledgeStructuredPage.mockRejectedValueOnce(
      new Error("acknowledgement unavailable"),
    );
    const sync = vi.fn(async () => ({
      analytics: { tableName: "step_counts", presentIds: [], deleteKeyColumn: "day" },
      cursor: { page: 1 },
      hasMore: false,
    }));
    const source = makeStructuredSource("ack-retry", sync);
    const { registry } = makeRegistry();
    registry.registerProvider(makeProvider(source));
    const runner = () => new SourceSyncRunner(client as unknown as GatewayClient, registry, 60_000);
    await runner().runOne(source);
    expect(pending()?.cursorCommitted).toBe(true);
    const id = pending()!.id;
    client.calls = [];
    await runner().runOne(source);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(client.calls).toEqual([
      expect.objectContaining({ kind: "ingestAnalytics", presentIds: [], observationId: id }),
    ]);
    expect(client.acknowledgeStructuredPage).toHaveBeenCalledTimes(2);
    expect(pending()).toBeNull();
  });

  test.each([1, 2, 3, "documents"] as const)(
    "replays every mixed-page write after failure at %s without advancing the cursor",
    async (failAt) => {
      const { registry } = makeRegistry();
      const cursors: Array<SyncCursor | null> = [];
      const source = makeStructuredSource("mixed-replay", async (cursor) => {
        cursors.push(cursor);
        return {
          analytics: ["first", "second", "third"].map((tableName) => ({
            tableName,
            records: [{ day: "2024-01-01", steps: 1 }],
          })),
          documents: [makeDoc("doc-a", "mixed-replay")],
          cursor: { page: 1 },
          hasMore: false,
        };
      });
      registry.registerProvider(makeProvider(source));
      const ingest = gateway.ingestAnalyticsPage.bind(gateway);
      let writes = 0;
      const ingestSpy = vi
        .spyOn(gateway, "ingestAnalyticsPage")
        .mockImplementation(async (args) => {
          writes++;
          if (writes === failAt) throw new Error("injected table failure");
          return ingest(args);
        });
      const upsertSpy = vi.spyOn(gateway, "upsertWithCursor");
      if (failAt === "documents")
        upsertSpy.mockRejectedValueOnce(new Error("injected SQLite failure"));
      const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
      await runner.runOne(source);
      expect(await gateway.getSyncState(source.id)).toBeNull();
      expect(registry.getStatus(source.id)?.state).toBe("error");
      ingestSpy.mockRestore();
      upsertSpy.mockRestore();
      gateway.calls = [];
      await runner.runOne(source);
      expect(cursors).toEqual([null, null]);
      expect(
        gateway.calls.map((call) =>
          call.kind === "ingestAnalytics" ? call.tableName : "documents",
        ),
      ).toEqual(["first", "second", "third", "documents"]);
      expect(await gateway.getSyncState(source.id)).toMatchObject({ cursor: { page: 1 } });
      expect(gateway.calls.at(-1)).toMatchObject({
        documents: [expect.objectContaining({ externalId: "doc-a" })],
      });
    },
  );

  test.each(["delete", "snapshot"])(
    "attaches the static schema to the first %s-only write",
    async (kind) => {
      const { registry } = makeRegistry();
      const source = makeStructuredSource("empty-write", async () => ({
        analytics: [
          {
            tableName: "step_counts",
            ...(kind === "delete" ? { deletedKeys: [{ day: "2024-01-01" }] } : { presentKeys: [] }),
          },
        ],
        cursor: {},
        hasMore: false,
      }));
      registry.registerProvider(makeProvider(source));
      await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
        source,
      );
      expect(gateway.calls[0]).toMatchObject({ kind: "ingestAnalytics", schema: ANALYTICS_SCHEMA });
    },
  );

  test("reports each structured page issue once", async () => {
    const { registry } = makeRegistry();
    const issue = {
      scope: "partition" as const,
      kind: "permission" as const,
      count: 1,
      subject: "Archive",
      message: "Archive unreadable",
    };
    const source = makeStructuredSource("one-issue", async () => ({
      cursor: {},
      hasMore: false,
      issues: [issue],
    }));
    registry.registerProvider(makeProvider(source));
    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );
    expect(registry.getStatus(source.id)?.issues).toEqual([issue]);
  });

  test("distinguishes unassessed incremental ticks from explicit issue recovery", async () => {
    const { registry } = makeRegistry();
    let tick = 0;
    const issue = {
      code: "snapshot-withheld",
      scope: "partition" as const,
      kind: "unknown" as const,
      count: 1,
      message: "Enumeration incomplete",
    };
    const source = makeStructuredSource("issue-recovery", async () => ({
      cursor: {},
      hasMore: false,
      ...(tick === 0 ? { issues: [issue] } : tick === 2 ? { issues: [] } : {}),
    }));
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);
    expect(registry.getStatus(source.id)?.issues).toEqual([issue]);
    tick = 1;
    await runner.runOne(source);
    expect(registry.getStatus(source.id)?.issues).toBeUndefined();
    tick = 2;
    await runner.runOne(source);
    expect(registry.getStatus(source.id)?.issues).toEqual([]);
  });

  test("bounds diagnostic aggregation across many issues without failing the sync", async () => {
    const { registry } = makeRegistry();
    const source = makeStructuredSource("many-issues", async () => ({
      cursor: {},
      hasMore: false,
      issues: Array.from({ length: 150_000 }, (_, i) => ({
        scope: "partition" as const,
        kind: "unknown" as const,
        count: 1,
        subject: `Example ${i % 100}`,
        message: "Example partition incomplete",
      })),
    }));
    registry.registerProvider(makeProvider(source));
    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );
    const status = registry.getStatus(source.id)!;
    expect(status.state).toBe("idle");
    expect(status.issues).toHaveLength(50);
    expect(status.issues?.at(-1)?.code).toBe("additional-sync-issues");
    expect(status.issues?.reduce((sum, issue) => sum + issue.count, 0)).toBe(150_000);
  });

  test("only sends a coverage claim on the terminal page", async () => {
    const { registry } = makeRegistry();
    let page = 0;
    const source = makeStructuredSource("watermark", async () => {
      page += 1;
      return {
        cursor: { page },
        hasMore: page === 1,
        watermark: { guarantee: "change-cut", upstreamCut: "opaque-cut" },
      };
    });
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );
    const writes = gateway.calls.filter((call) => call.kind === "upsertWithCursor");
    expect(writes).toHaveLength(2);
    expect(writes[0]?.watermark).toBeUndefined();
    expect(writes[1]?.watermark).toEqual({ guarantee: "change-cut", upstreamCut: "opaque-cut" });
  });

  test("uses an observation watermark when a terminal source result makes no stronger claim", async () => {
    const { registry } = makeRegistry();
    const source = makeStructuredSource("observed", async () => ({
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );
    const write = gateway.calls.find((call) => call.kind === "upsertWithCursor");
    expect(write?.watermark).toEqual({ guarantee: "observation" });
  });

  test("ingests analytics before advancing the cursor on every page (ordering)", async () => {
    const { registry } = makeRegistry();
    const cursors: Array<SyncCursor | null> = [];
    const source = makeStructuredSource("step-counter", async (cursor) => {
      cursors.push(cursor);
      const page = cursors.length;
      if (page === 1) {
        return {
          analytics: { tableName: "step_counts", records: [{ day: "2024-01-01", steps: 4200 }] },
          cursor: { page: 1 },
          hasMore: true,
        };
      }
      return {
        analytics: { tableName: "step_counts", records: [{ day: "2024-01-02", steps: 5100 }] },
        cursor: { page: 2 },
        hasMore: false,
      };
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    // For each page the analytics ingest MUST land before the cursor-advancing
    // upsert (analytics is a separate DB and can't ride the SQLite txn). If
    // the order flipped, a crash between the two would leave the cursor past
    // un-ingested analytics rows — silent data loss.
    expect(gateway.calls.map((c) => c.kind)).toEqual([
      "ingestAnalytics",
      "upsertWithCursor",
      "ingestAnalytics",
      "upsertWithCursor",
    ]);

    // Cursor lands on the final page's cursor.
    const finalState = await gateway.getSyncState("step-counter" as SourceId);
    expect(finalState?.cursor).toEqual({ page: 2 });

    // Second page received the first page's persisted cursor.
    expect(cursors).toEqual([null, { page: 1 }]);
  });

  test("does not advance a structured cursor when the analytics page loses its lease", async () => {
    const { registry } = makeRegistry();
    const cursors: Array<SyncCursor | null> = [];
    const source = makeStructuredSource("lease-fenced-steps", async (cursor) => {
      cursors.push(cursor);
      return {
        analytics: { tableName: "step_counts", records: [{ day: "2024-01-01", steps: 4200 }] },
        cursor: { page: 1 },
        hasMore: false,
      };
    });
    registry.registerProvider(makeProvider(source));
    gateway.analyticsResponse = {
      ingested: 0,
      rejected: true,
      reason: "lease",
      holder: "dev-alpha",
    };

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);
    await runner.runOne(source);

    expect(gateway.calls.filter((call) => call.kind === "ingestAnalytics")).toHaveLength(2);
    expect(gateway.calls.filter((call) => call.kind === "upsertWithCursor")).toHaveLength(0);
    expect(await gateway.getSyncState(source.id)).toBeNull();
    expect(cursors).toEqual([null, null]);
  });

  test("forwards document temporal projection declarations for hybrid structured sources", async () => {
    const { registry } = makeRegistry();
    const source = makeStructuredSource("hybrid-calendar", async () => ({
      records: [{ day: "2024-01-01", steps: 1 }],
      documents: [makeDoc("event-1", "hybrid-calendar")],
      tableName: "step_counts",
      cursor: {},
      hasMore: false,
    }));
    source.documentTemporalProjections = [
      {
        slot: "event",
        start: "$semanticTime",
        kind: "event",
        modality: "asserted",
      },
    ];
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const write = gateway.calls.find((call) => call.kind === "upsertWithCursor");
    expect(write?.kind).toBe("upsertWithCursor");
    if (write?.kind === "upsertWithCursor") {
      expect(write.documentTemporalProjections).toEqual(source.documentTemporalProjections);
    }
  });

  test("a page's analytics rows are not counted as documents", async () => {
    // Folding rows into the document count reported a source whose documents
    // each carry a row at twice its size, and a page of child rows as that
    // many of the source's own units.
    const { registry } = makeRegistry();
    const source = makeStructuredSource("rows-and-docs", async () => ({
      analytics: {
        tableName: "step_counts",
        records: [
          { day: "2024-01-01", steps: 1 },
          { day: "2024-01-02", steps: 2 },
          { day: "2024-01-03", steps: 3 },
        ],
      },
      documents: [makeDoc("event-1", "rows-and-docs")],
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    const ingested = gateway.calls.filter((call) => call.kind === "ingestAnalytics");
    expect(ingested).toHaveLength(1);
    expect(registry.getStatus(source.id)?.lastSyncStats?.documents).toBe(1);
  });

  test("passes the static schema only on first sight of a table (seenTables dedup)", async () => {
    const { registry } = makeRegistry();
    let page = 0;
    const source = makeStructuredSource("step-counter", async () => {
      page += 1;
      return {
        analytics: {
          tableName: "step_counts",
          records: [{ day: `2024-01-0${page}`, steps: page * 1000 }],
        },
        cursor: { page },
        hasMore: page < 3,
      };
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const ingests = gateway.calls.filter(
      (c): c is Extract<(typeof gateway.calls)[number], { kind: "ingestAnalytics" }> =>
        c.kind === "ingestAnalytics",
    );
    expect(ingests).toHaveLength(3);
    // Schema travels on the first page only; subsequent pages omit it so the
    // gateway doesn't re-evolve the table on every page.
    expect(ingests[0].schema).toBe(ANALYTICS_SCHEMA);
    expect(ingests[1].schema).toBeUndefined();
    expect(ingests[2].schema).toBeUndefined();
  });

  test("prefers the dynamic per-page schema from the result over the static lookup", async () => {
    const { registry } = makeRegistry();
    const dynamicSchema: AnalyticsTableSchema = {
      ...ANALYTICS_SCHEMA,
      tableName: "notion_db_42",
      displayName: "Notion DB 42",
    };
    const source = makeStructuredSource("notion-db", async () => ({
      analytics: {
        tableName: "notion_db_42",
        records: [{ day: "2024-01-01", steps: 1 }],
        schema: dynamicSchema,
      },
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const ingest = gateway.calls.find((c) => c.kind === "ingestAnalytics");
    expect(ingest?.kind).toBe("ingestAnalytics");
    if (ingest?.kind === "ingestAnalytics") {
      // Dynamic schema wins; the static `analyticsSchemas` (table "step_counts")
      // is never consulted for a table the result already described.
      expect(ingest.schema).toBe(dynamicSchema);
    }
  });

  test("forwards per-page deletedIds + deleteKeyColumn alongside records (#619)", async () => {
    const { registry } = makeRegistry();
    const source = makeStructuredSource("finance-txns", async () => ({
      analytics: {
        tableName: "step_counts",
        records: [{ day: "2024-01-01", steps: 1 }],
        deletedIds: ["tx-removed-1", "tx-removed-2"],
        deleteKeyColumn: "external_id",
      },
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const ingest = gateway.calls.find((c) => c.kind === "ingestAnalytics");
    expect(ingest?.kind).toBe("ingestAnalytics");
    if (ingest?.kind === "ingestAnalytics") {
      expect(ingest.deletedIds).toEqual(["tx-removed-1", "tx-removed-2"]);
      expect(ingest.deleteKeyColumn).toBe("external_id");
    }
  });

  test("a deletes-only page (no records) still ingests so the tombstone propagates (#619)", async () => {
    const { registry } = makeRegistry();
    const source = makeStructuredSource("finance-txns", async () => ({
      analytics: { tableName: "step_counts", deletedIds: ["tx-removed-1"] },
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    // Before #619 a records-empty page short-circuited and the deletion was
    // silently dropped. Now the ingest call still fires with the deletedIds.
    const ingest = gateway.calls.find((c) => c.kind === "ingestAnalytics");
    expect(ingest?.kind).toBe("ingestAnalytics");
    if (ingest?.kind === "ingestAnalytics") {
      expect(ingest.records).toEqual([]);
      expect(ingest.deletedIds).toEqual(["tx-removed-1"]);
    }
  });

  const KUDOS_SCHEMA: AnalyticsTableSchema = {
    tableName: "step_kudos",
    displayName: "Step kudos",
    description: "Who cheered a day's steps.",
    columns: [
      { name: "day", type: "DATE", description: "Calendar day." },
      { name: "position", type: "INTEGER", description: "Rank in the current list." },
    ],
    primaryKey: ["day", "position"],
    semanticTimeColumn: "day",
    record: { titleColumns: ["day"], keyColumns: ["day", "position"] },
  };

  test("writes every table a page names, in the order the page named them", async () => {
    // A source whose upstream record fans out has to be able to fill its child
    // tables from the same page as the parent. Order is part of the contract:
    // a source that must write a parent before its children relies on it.
    const { registry } = makeRegistry();
    const source = makeStructuredSource(
      "fan-out",
      async () => ({
        analytics: [
          { tableName: "step_counts", records: [{ day: "2024-01-01", steps: 4200 }] },
          { tableName: "step_kudos", records: [{ day: "2024-01-01", position: 1 }] },
        ],
        cursor: { page: 1 },
        hasMore: false,
      }),
      [ANALYTICS_SCHEMA, KUDOS_SCHEMA],
    );
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    // Both tables land, in order, and only then does the cursor advance — so a
    // crash between them cannot leave a cursor claiming rows nobody wrote.
    expect(gateway.calls.map((c) => c.kind)).toEqual([
      "ingestAnalytics",
      "ingestAnalytics",
      "upsertWithCursor",
    ]);
    const ingests = gateway.calls.filter((c) => c.kind === "ingestAnalytics");
    expect(ingests.map((c) => (c.kind === "ingestAnalytics" ? c.tableName : ""))).toEqual([
      "step_counts",
      "step_kudos",
    ]);
    // Each table gets its own schema on first sight, never the other's.
    expect(ingests[0]!.kind === "ingestAnalytics" && ingests[0].schema).toBe(ANALYTICS_SCHEMA);
    expect(ingests[1]!.kind === "ingestAnalytics" && ingests[1].schema).toBe(KUDOS_SCHEMA);
  });

  test("a table named twice stays two writes, so a clear can precede its rewrite", async () => {
    // The host deletes after it upserts within one write, so a source
    // replacing a keyed set spells it as two: the clear, then the rows. Merging
    // them would delete what the same call had just written.
    const { registry } = makeRegistry();
    const source = makeStructuredSource(
      "replace-kudos",
      async () => ({
        analytics: [
          { tableName: "step_kudos", deletedIds: ["2024-01-01"], deleteKeyColumn: "day" },
          { tableName: "step_kudos", records: [{ day: "2024-01-01", position: 1 }] },
        ],
        cursor: { page: 1 },
        hasMore: false,
      }),
      [ANALYTICS_SCHEMA, KUDOS_SCHEMA],
    );
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    const ingests = gateway.calls.filter((c) => c.kind === "ingestAnalytics");
    expect(ingests).toHaveLength(2);
    if (ingests[0]!.kind === "ingestAnalytics" && ingests[1]!.kind === "ingestAnalytics") {
      expect(ingests[0].deletedIds).toEqual(["2024-01-01"]);
      expect(ingests[0].records).toEqual([]);
      expect(ingests[1].deletedIds).toBeUndefined();
      expect(ingests[1].records).toEqual([{ day: "2024-01-01", position: 1 }]);
    }
  });

  test("a page that names no table still advances the cursor", async () => {
    // A phase handing over to the next, or one deferring on a spent rate-limit
    // window, writes nothing. It must still checkpoint, or the source restarts
    // that phase forever.
    const { registry } = makeRegistry();
    const source = makeStructuredSource("empty-page", async () => ({
      cursor: { page: 7 },
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    expect(gateway.calls.map((c) => c.kind)).toEqual(["upsertWithCursor"]);
    expect((await gateway.getSyncState(source.id))?.cursor).toEqual({ page: 7 });
  });

  test("a write asking for nothing costs no round trip", async () => {
    // A source composing its page from optional parts should not have to
    // filter its own list, and an empty write would spend a request to say so.
    const { registry } = makeRegistry();
    const source = makeStructuredSource(
      "sparse-fan-out",
      async () => ({
        analytics: [
          { tableName: "step_counts", records: [{ day: "2024-01-01", steps: 1 }] },
          { tableName: "step_kudos", records: [] },
        ],
        cursor: {},
        hasMore: false,
      }),
      [ANALYTICS_SCHEMA, KUDOS_SCHEMA],
    );
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    const ingests = gateway.calls.filter((c) => c.kind === "ingestAnalytics");
    expect(ingests).toHaveLength(1);
    expect(ingests[0]!.kind === "ingestAnalytics" && ingests[0].tableName).toBe("step_counts");
  });

  test("each table's snapshot is submitted for that table, after the cursor commits", async () => {
    // Snapshots are per table: a source that finished walking one table and
    // not another must be able to say so without the host reading the claim
    // across both. And absence is evidence only once the cursor is committed.
    const { registry } = makeRegistry();
    const source = makeStructuredSource(
      "two-snapshots",
      async () => ({
        analytics: [
          {
            tableName: "step_counts",
            records: [{ day: "2024-01-01", steps: 1 }],
            presentIds: ["2024-01-01"],
          },
          {
            tableName: "step_kudos",
            records: [{ day: "2024-01-01", position: 1 }],
            presentIds: ["2024-01-01"],
            deleteKeyColumn: "day",
          },
        ],
        cursor: { page: 1 },
        hasMore: false,
      }),
      [ANALYTICS_SCHEMA, KUDOS_SCHEMA],
    );
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    // Rows for both tables, then the cursor, then a snapshot per table.
    expect(gateway.calls.map((c) => c.kind)).toEqual([
      "ingestAnalytics",
      "ingestAnalytics",
      "upsertWithCursor",
      "ingestAnalytics",
      "ingestAnalytics",
    ]);
    const rowWrites = gateway.calls.slice(0, 2);
    for (const call of rowWrites) {
      // Absence travels only after the commit, never with the rows.
      expect(call.kind === "ingestAnalytics" && call.presentIds).toBeUndefined();
    }
    const snapshots = gateway.calls.slice(3);
    expect(snapshots.map((c) => (c.kind === "ingestAnalytics" ? c.tableName : ""))).toEqual([
      "step_counts",
      "step_kudos",
    ]);
    for (const call of snapshots) {
      expect(call.kind === "ingestAnalytics" && call.presentIds).toEqual(["2024-01-01"]);
      // One observation id per attempt: the receipt that makes a retry of this
      // post-commit request idempotent is scoped by table as well as by source,
      // so the two snapshots may share it.
      expect(call.kind === "ingestAnalytics" && call.observationId).toBeTruthy();
    }
    expect(snapshots[1]!.kind === "ingestAnalytics" && snapshots[1].deleteKeyColumn).toBe("day");
  });

  test("a snapshot on a partial page is refused for every table, not just the first", async () => {
    const { registry } = makeRegistry();
    let page = 0;
    const source = makeStructuredSource(
      "partial-snapshot",
      async () => {
        page += 1;
        return {
          analytics: [
            {
              tableName: "step_counts",
              records: [{ day: "2024-01-01", steps: 1 }],
              presentIds: [],
            },
            { tableName: "step_kudos", records: [], presentIds: [] },
          ],
          cursor: { page },
          hasMore: page < 2,
        };
      },
      [ANALYTICS_SCHEMA, KUDOS_SCHEMA],
    );
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    // Page one is partial: neither table's emptied snapshot may be acted on,
    // or a mid-walk page would delete everything it had not reached yet.
    const withSnapshot = gateway.calls.filter(
      (c) => c.kind === "ingestAnalytics" && c.presentIds !== undefined,
    );
    expect(withSnapshot).toHaveLength(2);
    expect(withSnapshot.map((c) => (c.kind === "ingestAnalytics" ? c.tableName : ""))).toEqual([
      "step_counts",
      "step_kudos",
    ]);
    expect(registry.getStatus(source.id)?.issues).toMatchObject([
      { code: "invalid-snapshot", subject: "step_counts", count: 1 },
      { code: "invalid-snapshot", subject: "step_kudos", count: 1 },
    ]);
    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );
    expect(registry.getStatus(source.id)?.issues).toEqual([]);
    expect(registry.getStatus(source.id)?.issueAssessments).toEqual(
      expect.arrayContaining([
        { code: "invalid-snapshot", scope: "partition", subject: "step_counts" },
        { code: "invalid-snapshot", scope: "partition", subject: "step_kudos" },
      ]),
    );
  });

  test("a valid table snapshot assesses only that table, not document or sibling warnings", async () => {
    const { registry } = makeRegistry();
    const source = makeStructuredSource("one-assessment", async () => ({
      analytics: { tableName: "step_counts", presentIds: [] },
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));
    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );
    expect(registry.getStatus(source.id)?.issues).toEqual([]);
    expect(registry.getStatus(source.id)?.issueAssessments).toEqual([
      { code: "invalid-snapshot", scope: "partition", subject: "step_counts" },
      { code: "additional-runtime-snapshot-issues", scope: "partition" },
    ]);
  });

  test("a partial page's snapshot is refused in either spelling", async () => {
    // The guard reads the field, so a source moving to keys would otherwise
    // walk straight past it — and a mid-walk page vouching for what a table
    // holds asks the gateway to delete everything the walk has not reached.
    const { registry } = makeRegistry();
    let page = 0;
    const source = makeStructuredSource(
      "partial-snapshot-keys",
      async () => {
        page += 1;
        return {
          analytics: [{ tableName: "step_counts", records: [], presentKeys: [] }],
          cursor: { page },
          hasMore: page < 2,
        };
      },
      [ANALYTICS_SCHEMA],
    );
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    // One snapshot reaches the gateway: the final page's. The partial page's
    // is refused before it is sent.
    const withSnapshot = gateway.calls.filter(
      (c) => c.kind === "ingestAnalytics" && c.presentKeys !== undefined,
    );
    expect(withSnapshot).toHaveLength(1);
  });

  test("a deferred deletion mid-list stops the tick with the cursor where it was", async () => {
    // The tables before it in the page were already written, which is safe —
    // every row write is a primary-key upsert, so the replay rewrites them.
    // What must not happen is the cursor moving past a deletion nobody led.
    const { registry } = makeRegistry();
    const leaseGateway = new LeaseGateway();
    leaseGateway.analyticsResponses = [
      { ingested: 1 },
      { ingested: 0, deleted: 0, deletionDeferred: true, holder: "dev-alpha" },
    ];
    const source = {
      ...makeStructuredSource(
        "deferred-mid-list",
        async () => ({
          analytics: [
            { tableName: "step_counts", records: [{ day: "2024-01-01", steps: 1 }] },
            { tableName: "step_kudos", deletedIds: ["2024-01-01"], deleteKeyColumn: "day" },
          ],
          cursor: { page: 1 },
          hasMore: false,
        }),
        [ANALYTICS_SCHEMA, KUDOS_SCHEMA],
      ),
      multiDeviceMode: "replicated" as const,
    };
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(leaseGateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    expect(await leaseGateway.getSyncState(source.id)).toBeNull();
    expect(registry.getStatus(source.id)?.state).toBe("idle");
  });
});

describe("SourceSyncRunner — document branch watermarks", () => {
  test("reports only explicit tombstones the gateway actually applied", async () => {
    const { registry, events } = makeRegistry();
    const gateway = new RecordingGateway();
    gateway.tombstonedDeleted = 0;
    const source = makeDocumentSource("replicated-notes", async () => ({
      documents: [],
      deletedExternalIds: ["note-a", "note-b"],
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    expect(
      events.find((event) => event.event === "sync.completed")?.status.lastSyncStats?.deleted,
    ).toBe(0);
  });

  test("stamps source-device parsing context without mutating the provider document", async () => {
    const { registry } = makeRegistry();
    const gateway = new RecordingGateway();
    const original = makeDoc("regional", "gmail:test");
    const source = makeDocumentSource("regional", async () => ({
      documents: [original],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000, undefined, {
      locale: "en-GB",
      phoneRegion: "GB",
      phoneRegionSource: "os",
    }).runOne(source);

    const write = gateway.calls.find((call) => call.kind === "upsertWithCursor");
    expect(write?.documents?.[0].metadata.ingestionContext).toEqual({
      locale: "en-GB",
      phoneRegion: "GB",
      phoneRegionSource: "os",
    });
    expect(original.metadata.ingestionContext).toBeUndefined();
  });

  test("forwards a stronger claim only with the terminal document page", async () => {
    const { registry } = makeRegistry();
    const gateway = new RecordingGateway();
    let page = 0;
    const source = makeDocumentSource("document-watermark", async () => {
      page += 1;
      return {
        documents: [],
        deletedExternalIds: [],
        cursor: { page },
        hasMore: page === 1,
        watermark: { guarantee: "best-effort-scan", observedAt: "2026-08-01T12:00:00.000Z" },
      };
    });
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    const writes = gateway.calls.filter((call) => call.kind === "upsertWithCursor");
    expect(writes.map((write) => write.watermark)).toEqual([
      undefined,
      { guarantee: "best-effort-scan", observedAt: "2026-08-01T12:00:00.000Z" },
    ]);
  });
});

describe("SourceSyncRunner — document temporal projection declarations", () => {
  test("forwards declared coverage on an empty document page", async () => {
    const { registry } = makeRegistry();
    const gateway = new RecordingGateway();
    const source = makeDocumentSource("dated-source", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    source.documentTemporalProjections = [
      {
        slot: "due",
        start: "dueAt",
        kind: "deadline",
        modality: "asserted",
      },
    ];
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const write = gateway.calls.find((call) => call.kind === "upsertWithCursor");
    expect(write?.kind).toBe("upsertWithCursor");
    if (write?.kind === "upsertWithCursor") {
      expect(write.documents).toEqual([]);
      expect(write.documentTemporalProjections).toEqual(source.documentTemporalProjections);
    }
  });

  test("sends an explicit empty declaration for a source that owns no projections", async () => {
    const { registry } = makeRegistry();
    const gateway = new RecordingGateway();
    const source = makeDocumentSource("timeless-source", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    source.documentTemporalProjections = [];
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const write = gateway.calls.find((call) => call.kind === "upsertWithCursor");
    expect(write?.kind).toBe("upsertWithCursor");
    if (write?.kind === "upsertWithCursor") {
      expect(write.documentTemporalProjections).toEqual([]);
    }
  });

  test("omits the declaration for a source that has never owned projections", async () => {
    const { registry } = makeRegistry();
    const gateway = new RecordingGateway();
    const source = makeDocumentSource("undeclared-source", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const write = gateway.calls.find((call) => call.kind === "upsertWithCursor");
    expect(write?.kind).toBe("upsertWithCursor");
    if (write?.kind === "upsertWithCursor") {
      expect(write.documentTemporalProjections).toBeUndefined();
    }
  });
});

describe("SourceSyncRunner — reconcile mass-delete guard", () => {
  let gateway: RecordingGateway;

  beforeEach(() => {
    gateway = new RecordingGateway();
  });

  test("document source: REFUSES to forward presentExternalIds on a partial page (hasMore=true)", async () => {
    const { registry } = makeRegistry();
    let page = 0;
    const source = makeDocumentSource("snapshot-src", async () => {
      page += 1;
      if (page === 1) {
        // Misbehaving source emits a snapshot while more pages remain.
        return {
          documents: [makeDoc("a", "snapshot-src")],
          deletedExternalIds: [],
          presentExternalIds: ["a"],
          cursor: { page: 1 },
          hasMore: true,
        };
      }
      // Final page: a complete snapshot enumeration, safe to reconcile.
      return {
        documents: [makeDoc("b", "snapshot-src")],
        deletedExternalIds: [],
        presentExternalIds: ["a", "b"],
        cursor: { page: 2 },
        hasMore: false,
      };
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const upserts = gateway.calls.filter(
      (c): c is Extract<(typeof gateway.calls)[number], { kind: "upsertWithCursor" }> =>
        c.kind === "upsertWithCursor",
    );
    expect(upserts).toHaveLength(2);
    // Partial page: the runner strips presentExternalIds so the gateway never
    // sees a snapshot it could mass-delete against. This is the runner's OWN
    // guard, asserted independently of any gateway-side gate.
    expect(upserts[0].hasMore).toBe(true);
    expect(upserts[0].presentExternalIds).toBeUndefined();
    // Final page: the complete snapshot IS forwarded for reconcile.
    expect(upserts[1].hasMore).toBe(false);
    expect(upserts[1].presentExternalIds).toEqual(["a", "b"]);
    expect(upserts[1].observationId).toMatch(/^\d+:\S+$/);
  });

  test("structured source: REFUSES to forward presentExternalIds on a partial page (hasMore=true)", async () => {
    const { registry } = makeRegistry();
    let page = 0;
    const source = makeStructuredSource("snapshot-structured", async () => {
      page += 1;
      if (page === 1) {
        return {
          analytics: { tableName: "step_counts", records: [{ day: "2024-01-01", steps: 1 }] },
          presentExternalIds: ["x"],
          cursor: { page: 1 },
          hasMore: true,
        };
      }
      return {
        analytics: { tableName: "step_counts", records: [{ day: "2024-01-02", steps: 2 }] },
        presentExternalIds: ["x", "y"],
        cursor: { page: 2 },
        hasMore: false,
      };
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const upserts = gateway.calls.filter(
      (c): c is Extract<(typeof gateway.calls)[number], { kind: "upsertWithCursor" }> =>
        c.kind === "upsertWithCursor",
    );
    expect(upserts).toHaveLength(2);
    expect(upserts[0].hasMore).toBe(true);
    expect(upserts[0].presentExternalIds).toBeUndefined();
    expect(upserts[1].hasMore).toBe(false);
    expect(upserts[1].presentExternalIds).toEqual(["x", "y"]);
    expect(upserts[1].observationId).toMatch(/^\d+:\S+$/);
  });

  test("structured source: forwards presentClaims, and refuses them on a partial page", async () => {
    // The structured branch reaches the same guard as the document branch, but
    // through its own call site. A hybrid source that reads its stores one at a
    // time — a Notion database, a repository, a mailbox — vouches for the ones
    // it finished and says nothing about the one it could not open, and that
    // narrower assertion has to survive the hop the runner owns.
    const { registry } = makeRegistry();
    const claims: SnapshotClaim[] = [{ partition: "db-1", ids: ["row-a", "row-b"] }];
    let page = 0;
    const source = makeStructuredSource("claims-structured", async () => {
      page += 1;
      if (page === 1) {
        return {
          documents: [{ ...makeDoc("row-a", "claims-structured"), partitionKey: "db-1" }],
          presentClaims: claims,
          cursor: { page: 1 },
          hasMore: true,
        };
      }
      return {
        documents: [{ ...makeDoc("row-b", "claims-structured"), partitionKey: "db-1" }],
        presentClaims: claims,
        cursor: { page: 2 },
        hasMore: false,
      };
    });
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    const upserts = gateway.calls.filter(
      (c): c is Extract<(typeof gateway.calls)[number], { kind: "upsertWithCursor" }> =>
        c.kind === "upsertWithCursor",
    );
    expect(upserts).toHaveLength(2);
    // A partial page names a fraction of what exists; acting on it would delete
    // the rest of the partition it claims.
    expect(upserts[0].presentClaims).toBeUndefined();
    expect(upserts[1].presentClaims).toEqual(claims);
    // A claim is an assertion about what exists, so it earns an observation id
    // exactly as the whole-source form does.
    expect(upserts[1].observationId).toMatch(/^\d+:\S+$/);
  });

  test("structured-only snapshot absences are surfaced in collector logs", async () => {
    const { registry } = makeRegistry();
    gateway.analyticsAbsence = {
      marked: 2,
      cleared: 0,
      absent: 2,
      deferred: 0,
      missing: 0,
      stored: 2,
      snapshot: 0,
    };
    const source = makeStructuredSource("analytics-only", async () => ({
      analytics: { tableName: "step_counts", presentIds: [] },
      cursor: { done: true },
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));
    setLogLevel(LogLevel.INFO);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
        source,
      );
      const analyticsCalls = gateway.calls.filter((call) => call.kind === "ingestAnalytics");
      expect(analyticsCalls).toHaveLength(2);
      expect(analyticsCalls[0]).toMatchObject({ presentIds: undefined });
      expect(analyticsCalls[1]).toMatchObject({
        records: [],
        presentIds: [],
        observationId: expect.any(String),
      });
      expect(gateway.calls.map((call) => call.kind)).toEqual([
        "ingestAnalytics",
        "upsertWithCursor",
        "ingestAnalytics",
      ]);
      expect(warning.mock.calls.flat().join(" ")).toContain(
        "the snapshot omits every stored item the gateway holds",
      );
    } finally {
      warning.mockRestore();
    }
  });

  test("a failed SQLite cursor commit records no analytics absence evidence", async () => {
    const { registry } = makeRegistry();
    gateway.rejectWrites = true;
    const source = makeStructuredSource("analytics-cursor-failure", async () => ({
      analytics: {
        tableName: "step_counts",
        records: [{ day: "2024-01-01", steps: 4200 }],
        presentIds: [],
      },
      cursor: { done: true },
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    const analyticsCalls = gateway.calls.filter((call) => call.kind === "ingestAnalytics");
    expect(analyticsCalls).toHaveLength(1);
    expect(analyticsCalls[0]).toMatchObject({
      records: [{ day: "2024-01-01", steps: 4200 }],
      presentIds: undefined,
    });
  });

  test("empty presentExternalIds on the FINAL page is forwarded (means 'nothing is present')", async () => {
    const { registry } = makeRegistry();
    const source = makeDocumentSource("empty-snapshot", async () => ({
      documents: [],
      deletedExternalIds: [],
      presentExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const upserts = gateway.calls.filter((c) => c.kind === "upsertWithCursor");
    expect(upserts).toHaveLength(1);
    if (upserts[0].kind === "upsertWithCursor") {
      // The empty array is meaningful and distinct from `undefined` — it must
      // survive to the gateway as a real "mark everything absent" snapshot.
      expect(upserts[0].presentExternalIds).toEqual([]);
    }
  });
});

describe("SourceSyncRunner — wall-clock timeout", () => {
  let gateway: RecordingGateway;

  beforeEach(() => {
    gateway = new RecordingGateway();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a stuck sync hits the timeout, flips to error, emits sync.error, and is retriable", async () => {
    const { registry, events } = makeRegistry();
    // A source whose sync never resolves — simulates a wedged provider.
    const source = makeDocumentSource("wedged", () => new Promise<SyncResult>(() => {}));
    registry.registerProvider(makeProvider(source));

    const SYNC_TIMEOUT_MS = 30_000;
    const runner = new SourceSyncRunner(
      gateway as unknown as GatewayClient,
      registry,
      SYNC_TIMEOUT_MS,
    );

    const run = runner.runOne(source);
    // Surface the eventual rejection synchronously to vitest so the
    // unhandled-rejection check stays clean while we advance the clock.
    const settled = run.then(
      () => ({ rejected: false as const }),
      (err: unknown) => ({ rejected: true as const, err }),
    );

    // Mid-flight: still syncing, before the wall clock elapses.
    expect(registry.getStatus("wedged")?.state).toBe("syncing");

    // Drive the wall-clock timeout deterministically — no real sleep.
    await vi.advanceTimersByTimeAsync(SYNC_TIMEOUT_MS + 1);

    const outcome = await settled;
    // The timeout race rejects `runOne` so the caller can record the failure.
    expect(outcome.rejected).toBe(true);

    // The source is no longer pinned in `syncing` — it flipped to `error`, so
    // the next scheduler tick is eligible to retry it.
    const status = registry.getStatus("wedged");
    expect(status?.state).toBe("error");
    expect(status?.lastError).toContain("timed out");

    // Exactly one sync.error event was emitted for the timeout (plus the
    // earlier sync.started).
    const errorEvents = events.filter((e) => e.event === "sync.error");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].sourceId).toBe("wedged");
    expect(events.some((e) => e.event === "sync.started")).toBe(true);
    // Epoch 1 belonged to the timed-out loop; epoch 2 revokes late direct writes.
    expect(gateway.begunEpochs).toEqual([1]);
    expect(gateway.revokedEpochs).toEqual([1]);
  });

  test("a timed-out old instance cannot mark its replacement errored", async () => {
    const { registry, events } = makeRegistry();
    const id = "replaced-before-timeout";
    let oldCalls = 0;
    const oldSource = makeDocumentSource(id, () => {
      oldCalls += 1;
      return new Promise<SyncResult>(() => {});
    });
    const replacement = makeDocumentSource(id, async () => emptyPage());
    registry.registerProvider(makeProvider(oldSource));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 30_000);
    const oldRun = runner.runOne(oldSource).catch(() => undefined);
    await vi.waitFor(() => expect(oldCalls).toBe(1));
    expect(registry.getStatus(id)?.state).toBe("syncing");

    // Re-registration fences the old run AND heals its now-stale `syncing`
    // claim — the fenced run can never write status again, so leaving the
    // claim would make every future tick skip the source as in-flight.
    registry.registerProvider(makeProvider(replacement));
    expect(registry.getStatus(id)?.state).toBe("idle");
    await vi.advanceTimersByTimeAsync(30_001);
    await oldRun;

    // The old instance's timeout still cannot touch the replacement's status.
    expect(registry.getStatus(id)?.state).toBe("idle");
    expect(events.filter((event) => event.event === "sync.error")).toEqual([]);
  });

  test("a retry supersedes a timed-out page loop before it can write", async () => {
    const { registry } = makeRegistry();
    let invocation = 0;
    let resolveFirst: ((result: SyncResult) => void) | undefined;
    const source = makeDocumentSource("overlap", async () => {
      invocation += 1;
      if (invocation === 1) {
        return new Promise<SyncResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return {
        documents: [makeDoc("fresh", "overlap")],
        deletedExternalIds: [],
        presentExternalIds: ["fresh"],
        cursor: { revision: 2 },
        hasMore: false,
      };
    });
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 30_000);

    const first = runner.runOne(source).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_001);
    await first;
    await runner.runOne(source);

    resolveFirst?.({
      documents: [],
      deletedExternalIds: [],
      presentExternalIds: [],
      cursor: { revision: 1 },
      hasMore: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(gateway.begunEpochs).toEqual([1, 3]);
    expect(gateway.revokedEpochs).toEqual([1]);
    const upserts = gateway.calls.filter((call) => call.kind === "upsertWithCursor");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ wipeEpoch: 3, presentExternalIds: ["fresh"] });
  });

  test("a delayed timeout revocation cannot clobber a newer local run", async () => {
    const { registry, events } = makeRegistry();
    let releaseUpsert!: () => void;
    gateway.upsertBlock = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    let releaseRevoke!: () => void;
    gateway.revokeBlock = new Promise<void>((resolve) => {
      releaseRevoke = resolve;
    });
    const source = makeDocumentSource("timeout-overlap", async () => ({
      documents: [makeDoc("fresh", "timeout-overlap")],
      deletedExternalIds: [],
      presentExternalIds: ["fresh"],
      cursor: { revision: 1 },
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 30_000);

    const first = runner.runOne(source).catch(() => undefined);
    await vi.waitFor(() =>
      expect(gateway.calls.filter((call) => call.kind === "upsertWithCursor")).toHaveLength(1),
    );
    await vi.advanceTimersByTimeAsync(30_001);
    expect(registry.getStatus("timeout-overlap")?.state).toBe("error");

    releaseUpsert();
    await Promise.resolve();
    await runner.runOne(source);
    expect(registry.getStatus("timeout-overlap")?.state).toBe("idle");

    releaseRevoke();
    await first;
    expect(gateway.begunEpochs).toEqual([1, 2]);
    expect(gateway.revokedEpochs).toEqual([]);
    expect(events.filter((event) => event.event === "sync.completed")).toHaveLength(1);
    expect(registry.getStatus("timeout-overlap")?.state).toBe("idle");
  });

  test("local authority follows gateway claim order when begin responses cross", async () => {
    const { registry, events } = makeRegistry();
    let releaseFirstBegin!: () => void;
    gateway.beginBlocks = [
      new Promise<void>((resolve) => {
        releaseFirstBegin = resolve;
      }),
      undefined,
    ];
    let releaseFirstUpsert!: () => void;
    const firstUpsertBlocked = new Promise<void>((resolve) => {
      releaseFirstUpsert = resolve;
    });
    const originalUpsert = gateway.upsertWithCursor.bind(gateway);
    let upsertCalls = 0;
    gateway.upsertWithCursor = async (args) => {
      const call = upsertCalls++;
      if (call === 0) await firstUpsertBlocked;
      if (args.wipeEpoch !== gateway.writeEpochs.get(args.sourceId)) {
        return { ingested: 0, reconciledDeleted: 0, indexCleanedRows: 0, rejected: true };
      }
      return originalUpsert(args);
    };
    let page = 0;
    const source = makeDocumentSource("crossed-begin", async () => {
      page += 1;
      return {
        documents: [makeDoc(`page-${page}`, "crossed-begin")],
        deletedExternalIds: [],
        cursor: { page },
        hasMore: false,
      };
    });
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 30_000);

    const first = runner.runOne(source);
    await vi.waitFor(() => expect(gateway.beginCalls).toBe(1));
    const second = runner.runOne(source);
    await vi.waitFor(() => expect(upsertCalls).toBe(1));

    releaseFirstBegin();
    await first;
    releaseFirstUpsert();
    await second;

    expect(gateway.begunEpochs).toEqual([1, 2]);
    expect(registry.getStatus("crossed-begin")?.state).toBe("idle");
    expect(
      events.filter((event) => event.event === "sync.completed" && event.status.state === "idle"),
    ).toHaveLength(1);
  });

  test("a snapshot that omits everything is one page, not a delete loop", async () => {
    // The gateway records the omissions and returns; there is no bounded-victim
    // round trip to re-run, so the source is read once and the sync completes.
    const { registry } = makeRegistry();
    gateway.absence = {
      marked: 3,
      cleared: 0,
      absent: 3,
      deferred: 0,
      missing: 0,
      stored: 3,
      snapshot: 0,
    };
    const cursors: unknown[] = [];
    const source = makeDocumentSource("bounded-snapshot", async (cursor) => {
      cursors.push(cursor);
      return {
        documents: [],
        deletedExternalIds: [],
        presentExternalIds: [],
        cursor: { done: true },
        hasMore: false,
      };
    });
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 30_000).runOne(
      source,
    );

    expect(cursors).toEqual([null]);
    expect(gateway.calls.filter((call) => call.kind === "upsertWithCursor")).toHaveLength(1);
    expect(registry.getStatus("bounded-snapshot")?.state).toBe("idle");
  });

  test("a removed-source rejection stops later pages and disables the local source", async () => {
    const { registry, events } = makeRegistry();
    gateway.rejectAsRemoved = true;
    let pages = 0;
    const source = makeDocumentSource("removed-source", async () => {
      pages += 1;
      return {
        documents: [],
        deletedExternalIds: [],
        cursor: { page: pages },
        hasMore: true,
      };
    });
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 30_000).runOne(
      source,
    );

    expect(pages).toBe(1);
    expect(registry.getStatus("removed-source")?.state).toBe("disabled");
    expect(
      events.some((event) => event.event === "sync.completed" && event.status.state === "idle"),
    ).toBe(false);
  });

  test("a rejected current attempt leaves the source retriable", async () => {
    const { registry } = makeRegistry();
    gateway.rejectWrites = true;
    const source = makeDocumentSource("superseded", async () => ({
      documents: [],
      deletedExternalIds: [],
      presentExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 30_000).runOne(
      source,
    );

    expect(registry.getStatus("superseded")?.state).toBe("error");
    expect(registry.getStatus("superseded")?.lastError).toContain("superseded");
  });

  test("a sync that finishes WELL within the timeout does not flip to error", async () => {
    const { registry } = makeRegistry();
    const source = makeDocumentSource("prompt", async () => ({
      documents: [makeDoc("d1", "prompt")],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 30_000);
    await runner.runOne(source);
    // Flush any pending microtasks/macrotasks the completion path scheduled.
    await vi.runAllTimersAsync();

    const status = registry.getStatus("prompt");
    expect(status?.state).toBe("idle");
    expect(status?.lastSyncStats?.documents).toBe(1);
  });
});

describe("SourceSyncRunner — what a run reports it wrote", () => {
  test("a document rewritten later in the same run is counted once", async () => {
    // A mailbox that stores headers on one pass and bodies on the next writes
    // each message twice in one run; a page count reported every one twice.
    const gateway = new RecordingGateway();
    const { registry } = makeRegistry();
    let page = 0;
    const source = makeDocumentSource("two-pass", async () => {
      page += 1;
      return page === 1
        ? {
            documents: [makeDoc("m1", "two-pass"), makeDoc("m2", "two-pass")],
            deletedExternalIds: [],
            cursor: { page },
            hasMore: true,
          }
        : {
            documents: [makeDoc("m1", "two-pass"), makeDoc("m2", "two-pass")],
            deletedExternalIds: [],
            cursor: { page },
            hasMore: false,
          };
    });
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    expect(page).toBe(2);
    expect(registry.getStatus(source.id)?.lastSyncStats?.documents).toBe(2);
  });
});

describe("SourceSyncRunner — rate-limit deferral (#616)", () => {
  let gateway: RecordingGateway;

  beforeEach(() => {
    gateway = new RecordingGateway();
  });

  /** Two sources of one provider, on different accounts, in one registry. */
  function registerTwo(
    registry: ReturnType<typeof makeRegistry>["registry"],
    failing: RegisteredSource,
    siblingId: string,
  ): RegisteredSource {
    const sibling = makeDocumentSource(siblingId, async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider({
      ...makeProvider(failing),
      id: failing.providerId,
      sources: [failing, { ...sibling, providerId: failing.providerId }],
    });
    return sibling;
  }

  test("an app-wide limit parks the siblings that share the budget", async () => {
    // One registered application serves every account, so a sibling on another
    // account is already over the same limit. Letting it find out costs one
    // more request against the very budget it is waiting for.
    const { registry } = makeRegistry();
    const failing = makeDocumentSource("quota:acct-a", async () => {
      throw new SyncError("rate-limit", "daily application quota exhausted", {
        retryAfterMs: 3_600_000,
        quota: { kind: "app" },
      });
    });
    registerTwo(registry, failing, "quota:acct-b");

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      failing,
    );

    expect(registry.getStatus("quota:acct-a")?.state).toBe("rate-limited");
    const sibling = registry.getStatus("quota:acct-b");
    expect(sibling?.state, "the sibling shares the application budget").toBe("rate-limited");
    expect(sibling?.retryAfterMs).toBe(3_600_000);
  });

  test("an account-wide limit leaves another account alone", async () => {
    // The narrower bucket is the point of naming one: a per-account limit says
    // nothing about a different account, and parking it would be inventing an
    // outage.
    const { registry } = makeRegistry();
    const failing = makeDocumentSource("quota:acct-a", async () => {
      throw new SyncError("rate-limit", "per-account limit", {
        retryAfterMs: 60_000,
        quota: { kind: "account" },
      });
    });
    registerTwo(registry, failing, "quota:acct-b");

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      failing,
    );

    expect(registry.getStatus("quota:acct-a")?.state).toBe("rate-limited");
    expect(registry.getStatus("quota:acct-b")?.state).not.toBe("rate-limited");
  });

  test("a limit that names no budget parks only the source that hit it", async () => {
    // Most providers do not say what a 429 was counted against. Guessing would
    // stop sources that were working.
    const { registry } = makeRegistry();
    const failing = makeDocumentSource("quota:acct-a", async () => {
      throw new SyncError("rate-limit", "429", { retryAfterMs: 60_000 });
    });
    registerTwo(registry, failing, "quota:acct-b");

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      failing,
    );

    expect(registry.getStatus("quota:acct-a")?.state).toBe("rate-limited");
    expect(registry.getStatus("quota:acct-b")?.state).not.toBe("rate-limited");
  });

  test("a typed rate-limit SyncError with retryAfterMs parks the source in `rate-limited` (NOT error) and returns a deferral", async () => {
    const { registry, events } = makeRegistry();
    const source = makeDocumentSource("eb:acct1", async () => {
      throw new SyncError("rate-limit", "ASPSP unattended-access cap reached", {
        retryAfterMs: 6 * 60 * 60 * 1000,
      });
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    const outcome = await runner.runOne(source);

    // The runner hands the scheduler a structured deferral carrying the
    // provider's retry hint — not a thrown error.
    expect(outcome).toEqual({ retryAfterMs: 6 * 60 * 60 * 1000 });

    // Source is parked in the deferred `rate-limited` state, NOT `error`.
    const status = registry.getStatus("eb:acct1");
    expect(status?.state).toBe("rate-limited");
    expect(status?.retryAfterMs).toBe(6 * 60 * 60 * 1000);
    // The hint carries the wire prefix the gateway recognises + the provider msg.
    expect(status?.lastError).toContain("rate-limited: ");
    expect(status?.lastError).toContain("ASPSP unattended-access cap reached");

    // A `sync.error` event is emitted (the same channel needs-auth uses) but
    // the discriminating status.state is `rate-limited`.
    const errEvents = events.filter((e) => e.event === "sync.error");
    expect(errEvents).toHaveLength(1);
    expect(errEvents[0].status.state).toBe("rate-limited");
  });

  test("a rate-limit SyncError WITHOUT retryAfterMs falls back to generic `error` (no deferral)", async () => {
    const { registry } = makeRegistry();
    const source = makeDocumentSource("rl:noretry", async () => {
      throw new SyncError("rate-limit", "rate limited, no Retry-After header");
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    const outcome = await runner.runOne(source);

    // No retry hint → no deferral; behaviour is exactly the legacy error path.
    expect(outcome).toBeUndefined();
    const status = registry.getStatus("rl:noretry");
    expect(status?.state).toBe("error");
    expect(status?.retryAfterMs).toBeUndefined();
    expect(status?.lastError).toBe("rate limited, no Retry-After header");
  });

  test("an untyped error whose message merely looks like a rate limit still goes to `error`", async () => {
    // Regression guard: the deferral must only fire for the typed SyncError
    // shape carrying retryAfterMs, never for a bare Error matched by message.
    const { registry } = makeRegistry();
    const source = makeDocumentSource("rl:untyped", async () => {
      throw new Error("rate limited (429)");
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    const outcome = await runner.runOne(source);

    expect(outcome).toBeUndefined();
    const status = registry.getStatus("rl:untyped");
    expect(status?.state).toBe("error");
    expect(status?.lastError).toBe("rate limited (429)");
  });

  test("a rate-limit mid-bootstrap preserves progress (a back-off is not a failure)", async () => {
    const { registry } = makeRegistry();
    let page = 0;
    const source = makeDocumentSource("rl:midboot", async () => {
      page += 1;
      if (page === 1) {
        return {
          documents: [makeDoc("d1", "rl:midboot")],
          deletedExternalIds: [],
          cursor: { page: 1 },
          hasMore: true,
          progress: { phase: "bootstrap", total: 100, processed: 10 },
        };
      }
      throw new SyncError("rate-limit", "throttled", { retryAfterMs: 60_000 });
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const status = registry.getStatus("rl:midboot");
    expect(status?.state).toBe("rate-limited");
    // Progress from the first page is intact — unlike `error`/`needs-auth`
    // which clear it. The bootstrap bar should not reset on a transient.
    // `processed` is the running doc total (1 doc landed on page 1); `total`
    // is the cycle's queue size reported by the source.
    expect(status?.progress).toBeDefined();
    expect(status?.progress?.processed).toBe(1);
    expect(status?.progress?.total).toBe(100);
  });

  test("a non-rate-limit error still flips to `error` exactly as before (regression guard)", async () => {
    const { registry } = makeRegistry();
    const source = makeDocumentSource("rl:other", async () => {
      throw new Error("disk on fire");
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    const outcome = await runner.runOne(source);

    expect(outcome).toBeUndefined();
    expect(registry.getStatus("rl:other")?.state).toBe("error");
    expect(registry.getStatus("rl:other")?.lastError).toBe("disk on fire");
  });
});

describe("SourceSyncRunner — mid-page disable", () => {
  test("ignores a provider error caused by disabling the in-flight source", async () => {
    const gateway = new RecordingGateway();
    const { registry, events } = makeRegistry();
    const id = "imap:paused@example.com";
    const source = makeDocumentSource(id, async () => {
      await registry.disableSource(id);
      throw new Error("socket closed during suspend");
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await expect(runner.runOne(source)).resolves.toBeUndefined();

    expect(registry.getStatus(id)?.state).toBe("disabled");
    expect(events.some((event) => event.event === "sync.error")).toBe(false);
  });

  test("ignores a provider error caused by removing the in-flight source", async () => {
    const gateway = new RecordingGateway();
    const { registry, events } = makeRegistry();
    const id = "imap:removed@example.com";
    const source = makeDocumentSource(id, async () => {
      await registry.unregisterSource(id);
      throw new Error("socket closed during removal");
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await expect(runner.runOne(source)).resolves.toBeUndefined();

    expect(registry.getStatus(id)).toBeUndefined();
    expect(events.some((event) => event.event === "sync.error")).toBe(false);
  });

  test("aborts the page loop and does not resurrect a source disabled between pages", async () => {
    const gateway = new RecordingGateway();
    const { registry, events } = makeRegistry();
    let page = 0;
    const source = makeDocumentSource("disable-mid", async () => {
      page += 1;
      // After the first page, the source is disabled out from under us; the
      // loop must re-read status and bail before page 2.
      if (page === 1) registry.disableSource("disable-mid");
      return {
        documents: [makeDoc(`p${page}`, "disable-mid")],
        deletedExternalIds: [],
        cursor: { page },
        hasMore: true, // would loop forever if the disable guard didn't fire
      };
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    // Only the first page ran; the loop bailed on the disabled re-read instead
    // of continuing to page 2 (which would have hung the test).
    expect(page).toBe(1);
    // The disable transition is preserved — the runner did NOT clobber it back
    // to idle/error.
    expect(registry.getStatus("disable-mid")?.state).toBe("disabled");
    // No completion event resurrects the source after the disable.
    expect(events.some((e) => e.event === "sync.completed" && e.status.state === "idle")).toBe(
      false,
    );
  });
});

// Freshness is what lets the gateway tell a stalled local feed from a quiet
// one. The runner is where the reading is taken, and the registry is where the
// declaration is captured — neither was observable from the outside before
// these, so deleting either line reddened nothing.
describe("SourceSyncRunner — freshness probe", () => {
  let gateway: RecordingGateway;

  beforeEach(() => {
    gateway = new RecordingGateway();
  });

  const declared: SourceFreshness = {
    quietPeriodMs: 1000,
    hint: "Open the app to resume syncing.",
    requiresProcess: { processName: "ExampleApp" },
  };

  function sourceWithFreshness(id: string, freshness?: SourceFreshness): RegisteredSource {
    const source = makeDocumentSource(id, async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: { done: true },
      hasMore: false,
    }));
    source.instance.freshness = freshness;
    return source;
  }

  test("attaches the probe reading to the completed status", async () => {
    const { registry, events } = makeRegistry();
    const source = sourceWithFreshness("example:local", declared);
    registry.registerProvider(makeProvider(source));

    const probe = new FreshnessProbe(
      () => 0,
      async () => false,
    );
    const runner = new SourceSyncRunner(
      gateway as unknown as GatewayClient,
      registry,
      60_000,
      new FeedProcessSupervisor(
        probe,
        () => 0,
        async () => {},
        false,
      ),
    );
    await runner.runOne(source);

    const completed = events.find((e) => e.event === "sync.completed");
    expect(completed?.status.feedProcessRunning).toBe(false);
    expect(completed?.status.feedProcessLaunchFailing).toBe(false);
    expect(completed?.status.freshness).toEqual(declared);
  });

  test("attaches the supervisor's launch verdict to the completed status", async () => {
    const { registry, events } = makeRegistry();
    const source = sourceWithFreshness("example:local", declared);
    registry.registerProvider(makeProvider(source));

    const failing = {
      observe: async () => ({ running: false, launchFailing: true }),
    } as unknown as FeedProcessSupervisor;
    const runner = new SourceSyncRunner(
      gateway as unknown as GatewayClient,
      registry,
      60_000,
      failing,
    );
    await runner.runOne(source);

    const completed = events.find((e) => e.event === "sync.completed");
    expect(completed?.status.feedProcessRunning).toBe(false);
    expect(completed?.status.feedProcessLaunchFailing).toBe(true);
  });

  test("leaves the reading undefined for a source that declares nothing", async () => {
    const { registry, events } = makeRegistry();
    const source = sourceWithFreshness("plain:local", undefined);
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    const completed = events.find((e) => e.event === "sync.completed");
    expect(completed?.status.feedProcessRunning).toBeUndefined();
    expect(completed?.status.freshness).toBeUndefined();
  });

  // The cursor is already committed by the time the probe runs. An advisory
  // signal must never be able to turn a successful sync into an errored one.
  test("a throwing probe does not fail the sync", async () => {
    const { registry, events } = makeRegistry();
    const source = sourceWithFreshness("example:local", declared);
    registry.registerProvider(makeProvider(source));

    const exploding = {
      observe: async () => {
        throw new Error("probe exploded");
      },
    } as unknown as FeedProcessSupervisor;
    const runner = new SourceSyncRunner(
      gateway as unknown as GatewayClient,
      registry,
      60_000,
      exploding,
    );
    await runner.runOne(source);

    expect(events.some((e) => e.event === "sync.error")).toBe(false);
    const completed = events.find((e) => e.event === "sync.completed");
    expect(completed).toBeDefined();
    expect(completed?.status.feedProcessRunning).toBeUndefined();
    expect(completed?.status.feedProcessLaunchFailing).toBeUndefined();
  });
});

describe("SourceRegistry — freshness on (re-)register", () => {
  const declared: SourceFreshness = {
    quietPeriodMs: 1000,
    hint: "Open the app to resume syncing.",
    requiresProcess: { processName: "ExampleApp" },
  };

  function build(id: string, freshness?: SourceFreshness): RegisteredSource {
    const source = makeDocumentSource(id, async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    source.instance.freshness = freshness;
    return source;
  }

  test("captures the declaration on first register", () => {
    const { registry } = makeRegistry();
    registry.registerProvider(makeProvider(build("example:local", declared)));
    expect(registry.getStatus("example:local")?.freshness).toEqual(declared);
  });

  // A re-register rebuilds the instance from current config. If a reconfigured
  // source no longer names a process to watch, keeping the old declaration
  // would leave it warning forever about something that no longer applies.
  test("a re-register that drops the declaration clears it", () => {
    const { registry } = makeRegistry();
    registry.registerProvider(makeProvider(build("example:local", declared)));
    registry.registerProvider(makeProvider(build("example:local", undefined)));
    expect(registry.getStatus("example:local")?.freshness).toBeUndefined();
  });

  test("a re-register with a changed declaration picks up the new one", () => {
    const { registry } = makeRegistry();
    registry.registerProvider(makeProvider(build("example:local", declared)));
    const changed: SourceFreshness = { ...declared, quietPeriodMs: 999_000 };
    registry.registerProvider(makeProvider(build("example:local", changed)));
    expect(registry.getStatus("example:local")?.freshness?.quietPeriodMs).toBe(999_000);
  });
});

function emptyPage(): SyncResult {
  return { documents: [], deletedExternalIds: [], hasMore: false, cursor: {} };
}

describe("SourceSyncRunner — a source stopped mid-sync", () => {
  let gateway: RecordingGateway;

  beforeEach(() => {
    gateway = new RecordingGateway();
  });

  test("discards a page that was already in flight when the source was removed", async () => {
    // The incident this guards: the operator removes a source, the gateway
    // purges it, and the page the collector was fetching at that moment lands
    // afterwards — re-creating documents for a source that no longer exists,
    // with no sources row and nothing that would ever reclaim them.
    //
    // Checking the signal only BEFORE the fetch is not enough. The fetch is
    // the long part, so that is exactly when a removal lands.
    const { registry } = makeRegistry();
    const source = makeDocumentSource("gmail:maya.reeves@example.com", async () => {
      // Removed while this page is being fetched.
      await registry.unregisterSource("gmail:maya.reeves@example.com");
      return {
        documents: [makeDoc("m-1", "gmail:maya.reeves@example.com")],
        deletedExternalIds: [],
        hasMore: false,
        cursor: { page: 1 },
      };
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    expect(gateway.calls.map((c) => c.kind)).toEqual([]);
  });

  test("a sync starting during unregister's dispose await is refused a signal", async () => {
    // `unregisterSource` aborts, then AWAITS `dispose()` before the source is
    // actually gone. A sync entering in that window used to be handed a fresh,
    // un-aborted signal — the source was still registered and its status still
    // present — and wrote its page. WhatsApp is the shape that hits it: a slow
    // Baileys flush in dispose, and push-triggered syncs that survive
    // `stopSource`.
    //
    // A signal is now armed only by registration, so the window hands out an
    // aborted one instead of minting.
    const { registry } = makeRegistry();
    const id = "whatsapp:+15550100199";
    let signalDuringDispose: AbortSignal | undefined;

    const source = makeDocumentSource(id, async () => emptyPage());
    source.instance.dispose = async () => {
      // Mid-teardown: exactly where a racing sync would read its signal.
      signalDuringDispose = registry.syncSignal(id);
    };
    registry.registerProvider(makeProvider(source));

    await registry.unregisterSource(id);

    expect(signalDuringDispose?.aborted).toBe(true);
  });

  test("the structured branch discards its in-flight page too", async () => {
    // The two branches carry a hand-copied guard; without a test on this one an
    // edit to the document branch leaves analytics sources leaking pages.
    const { registry } = makeRegistry();
    const id = "step-counter";
    const source = makeStructuredSource(id, async () => {
      await registry.unregisterSource(id);
      return {
        analytics: { tableName: "step_counts", records: [{ day: "2026-03-10", steps: 1 }] },
        cursor: { page: 1 },
        hasMore: false,
      };
    });
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    expect(gateway.calls.map((c) => c.kind)).toEqual([]);
  });

  test("disabling a source aborts its sync as well as removing it", async () => {
    // Both teardown paths call abortSync directly; only one was covered.
    const { registry } = makeRegistry();
    const id = "gmail:paused@example.com";
    registry.registerProvider(makeProvider(makeDocumentSource(id, async () => emptyPage())));
    const signal = registry.syncSignal(id);
    await registry.disableSource(id);
    expect(signal.aborted).toBe(true);
  });

  test("and a source that is gone gets an aborted signal, not a new one", async () => {
    const { registry } = makeRegistry();
    expect(registry.syncSignal("gmail:never-registered@example.com").aborted).toBe(true);
  });

  test("stops before fetching the next page", async () => {
    // The cheaper half: once stopped, no further page is even requested.
    const { registry } = makeRegistry();
    let pages = 0;
    const source = makeDocumentSource("gmail:jamie.lopez@example.org", async () => {
      pages += 1;
      if (pages === 1) {
        return {
          documents: [makeDoc("j-1", "gmail:jamie.lopez@example.org")],
          deletedExternalIds: [],
          hasMore: true,
          cursor: { page: 1 },
        };
      }
      throw new Error("a second page must not be fetched after the source stopped");
    });
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

    // Stop it after the first page is written.
    const original = gateway.upsertWithCursor.bind(gateway);
    gateway.upsertWithCursor = async (args: Parameters<typeof gateway.upsertWithCursor>[0]) => {
      const r = await original(args);
      await registry.unregisterSource("gmail:jamie.lopez@example.org");
      return r;
    };

    await runner.runOne(source);
    expect(pages).toBe(1);
  });

  test("the abort reaches a loop whose registry status has been put back", async () => {
    // A status re-inserted for an unregistered id (markNeedsAuth used to do
    // this) restores the between-pages check's permission. The signal is
    // captured per run and cannot be handed back that way.
    const { registry } = makeRegistry();
    const id = "gmail:david.lin@example.com";
    registry.registerProvider(makeProvider(makeDocumentSource(id, async () => emptyPage())));
    const signal = registry.syncSignal(id);
    expect(signal.aborted).toBe(false);
    await registry.unregisterSource(id);
    expect(signal.aborted).toBe(true);
  });

  test("a connection error does not abort — the source is still here", async () => {
    // `stopSource` also runs when a live-socket source reports a connection
    // error. A WhatsApp socket blip can fire while a sync reads happily from
    // the local store the socket already filled; aborting there would discard
    // a page for a source that was never removed.
    const { registry } = makeRegistry();
    const id = "whatsapp:+15550100142";
    registry.registerProvider(makeProvider(makeDocumentSource(id, async () => emptyPage())));
    const signal = registry.syncSignal(id);
    registry.stopSource(id);
    expect(signal.aborted).toBe(false);
  });

  test("a queued old instance cannot borrow the replacement's fresh signal", async () => {
    const gateway = new RecordingGateway();
    const { registry } = makeRegistry();
    const id = "gmail:queued@example.com";
    let oldCalls = 0;
    const oldSource = makeDocumentSource(id, async () => {
      oldCalls += 1;
      return emptyPage();
    });
    const replacement = makeDocumentSource(id, async () => emptyPage());
    registry.registerProvider(makeProvider(oldSource));
    registry.registerProvider(makeProvider(replacement));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(oldSource);

    expect(oldCalls).toBe(0);
    expect(gateway.calls).toEqual([]);
  });

  test("a stale queued run cannot clear the replacement's active attempt", async () => {
    const gateway = new RecordingGateway();
    const { registry, events } = makeRegistry();
    const id = "gmail:active-replacement@example.com";
    let releaseReplacement!: () => void;
    const replacementPage = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let replacementCalls = 0;
    const oldSource = makeDocumentSource(id, async () => emptyPage());
    const replacement = makeDocumentSource(id, async () => {
      replacementCalls += 1;
      await replacementPage;
      return emptyPage();
    });
    registry.registerProvider(makeProvider(oldSource));
    registry.registerProvider(makeProvider(replacement));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

    const freshRun = runner.runOne(replacement);
    await vi.waitFor(() => expect(replacementCalls).toBe(1));
    await runner.runOne(oldSource);
    releaseReplacement();
    await freshRun;

    expect(registry.getStatus(id)?.state).toBe("idle");
    expect(events.filter((event) => event.event === "sync.completed")).toHaveLength(1);
  });

  test("re-registering a source aborts its old run before arming the replacement", () => {
    const { registry } = makeRegistry();
    const id = "gmail:refreshed@example.com";
    const oldSource = makeDocumentSource(id, async () => emptyPage());
    const replacement = makeDocumentSource(id, async () => emptyPage());
    registry.registerProvider(makeProvider(oldSource));
    const oldSignal = registry.syncSignal(id);

    registry.registerProvider(makeProvider(replacement));

    const newSignal = registry.syncSignal(id);
    expect(oldSignal.aborted).toBe(true);
    expect(newSignal.aborted).toBe(false);
    expect(newSignal).not.toBe(oldSignal);
  });

  test("a source added back gets a fresh, un-aborted signal", async () => {
    // Otherwise a re-added account would refuse to sync for the life of the
    // collector.
    const { registry } = makeRegistry();
    const id = "gmail:sarah.mendez@example.com";
    const source = makeDocumentSource(id, async () => emptyPage());
    registry.registerProvider(makeProvider(source));
    const first = registry.syncSignal(id);
    await registry.unregisterSource(id);
    expect(first.aborted).toBe(true);

    // Re-added: registering is what arms a fresh signal.
    registry.registerProvider(makeProvider(source));
    const second = registry.syncSignal(id);
    expect(second.aborted).toBe(false);
    expect(second).not.toBe(first);
  });

  test("the signal is handed to the source so it can drop the upstream call", async () => {
    // Honouring it is optional — the engine discards the page either way — but
    // a source that does pass it to its HTTP client stops burning API quota
    // for a source that is gone.
    const { registry } = makeRegistry();
    let received: AbortSignal | undefined;
    const source = makeDocumentSource("gmail:seen-signal@example.com", async (_c, opts) => {
      received = opts?.signal;
      return { documents: [], deletedExternalIds: [], hasMore: false, cursor: { page: 1 } };
    });
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    expect(received).toBeInstanceOf(AbortSignal);
  });
});

/** A gateway whose sync lease answers are scripted per source. */
class LeaseGateway extends RecordingGateway {
  decisions = new Map<
    string,
    { granted: boolean; holder?: string; reason?: string; expiresAt?: number }
  >();
  claims: string[] = [];
  released: string[] = [];
  /** Answer every page with "the lease is another device's". */
  loseLease = false;
  /** Refuse a replicated tombstone page without treating the source as broken. */
  deferTombstones = false;
  /** Page writes the runner attempted, refused ones included. */
  writeAttempts = 0;

  async claimSyncLease(
    sourceId: SourceId,
  ): Promise<{ granted: boolean; holder?: string; reason?: string; expiresAt?: number }> {
    this.claims.push(sourceId);
    return this.decisions.get(sourceId) ?? { granted: true };
  }

  async releaseSyncLease(sourceId: SourceId): Promise<boolean> {
    this.released.push(sourceId);
    return true;
  }

  override async upsertWithCursor(
    ...args: Parameters<RecordingGateway["upsertWithCursor"]>
  ): ReturnType<RecordingGateway["upsertWithCursor"]> {
    this.writeAttempts += 1;
    if (this.deferTombstones) {
      return {
        ingested: 0,
        reconciledDeleted: 0,
        indexCleanedRows: 0,
        deletionDeferred: true,
        rejected: true,
        reason: "lease",
        holder: "other",
      };
    }
    if (this.loseLease) {
      return {
        ingested: 0,
        reconciledDeleted: 0,
        indexCleanedRows: 0,
        rejected: true,
        reason: "lease",
        holder: "other",
      };
    }
    return super.upsertWithCursor(...args);
  }
}

describe("SourceSyncRunner — the sync lease", () => {
  test("a replicated tombstone page deferred by the holder returns idle and retains its cursor", async () => {
    const { registry, events } = makeRegistry();
    const gateway = new LeaseGateway();
    gateway.deferTombstones = true;
    gateway.decisions.set("replicated-deferred", { granted: true });
    const source = {
      ...makeDocumentSource("replicated-deferred", async () => ({
        documents: [],
        deletedExternalIds: ["task-a"],
        cursor: { page: 1 },
        hasMore: false,
      })),
      multiDeviceMode: "replicated" as const,
    };
    registry.registerProvider(makeProvider(source));

    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);
    await runner.runOne(source);

    expect(registry.getStatus(source.id)?.state).toBe("idle");
    expect(registry.getStatus(source.id)?.lastError).toBeUndefined();
    expect(await gateway.getSyncState(source.id)).toBeNull();
    expect(events.some((event) => event.event === "sync.deferred")).toBe(true);
    expect(events.some((event) => event.event === "sync.error")).toBe(false);
    await runner.releaseLeases();
    expect(gateway.released).toEqual([]);
  });

  test("fails closed when a leased structured source's client cannot answer per page", async () => {
    const { registry } = makeRegistry();
    const gateway = new RecordingGateway();
    let pulls = 0;
    // A client that does not implement the page call at all: without its
    // response there is nothing to fence the lease on.
    Object.defineProperty(gateway, "ingestAnalyticsPage", { value: undefined });
    const legacyGateway = Object.assign(gateway, {
      claimSyncLease: async () => ({ granted: true }),
    });
    const source = {
      ...makeStructuredSource("legacy-analytics-handoff", async () => {
        pulls += 1;
        return {
          analytics: { tableName: "step_counts", records: [{ day: "2024-01-01", steps: 4200 }] },
          cursor: { page: 1 },
          hasMore: false,
        };
      }),
      multiDeviceMode: "handoff" as const,
    };
    registry.registerProvider(makeProvider(source));

    await new SourceSyncRunner(legacyGateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    expect(pulls).toBe(0);
    expect(gateway.calls.filter((call) => call.kind === "upsertWithCursor")).toHaveLength(0);
    expect(registry.getStatus(source.id)?.state).toBe("error");
    expect(registry.getStatus(source.id)?.lastError).toMatch(/analytics page responses/);
  });

  test("does not report success when a post-cursor analytics snapshot loses its lease", async () => {
    const { registry, events } = makeRegistry();
    const gateway = new LeaseGateway();
    const source = {
      ...makeStructuredSource("snapshot-lease-loss", async () => ({
        analytics: {
          tableName: "step_counts",
          records: [{ day: "2024-01-01", steps: 4200 }],
          presentIds: ["2024-01-01"],
        },
        cursor: { page: 1 },
        hasMore: false,
      })),
      multiDeviceMode: "handoff" as const,
    };
    registry.registerProvider(makeProvider(source));
    gateway.analyticsResponses = [
      { ingested: 1 },
      { ingested: 0, rejected: true, reason: "lease", holder: "dev-alpha" },
    ];

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    expect((await gateway.getSyncState(source.id))?.cursor).toEqual({ page: 1 });
    expect(registry.getStatus(source.id)?.state).toBe("error");
    expect(registry.getStatus(source.id)?.lastError).toMatch(/lost the sync lease to dev-alpha/);
    expect(events.some((event) => event.event === "sync.completed")).toBe(false);
  });

  test("a handoff source whose lease another device holds skips its tick without a sync attempt", async () => {
    const { registry, events } = makeRegistry();
    const gateway = new LeaseGateway();
    let pulls = 0;
    const source = {
      ...makeDocumentSource("handoff-held", async () => {
        pulls += 1;
        return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
      }),
      multiDeviceMode: "handoff" as const,
    };
    registry.registerProvider(makeProvider(source));
    gateway.decisions.set(source.id, { granted: false, holder: "other", reason: "held" });

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    expect(gateway.claims).toEqual([source.id]);
    expect(pulls).toBe(0);
    expect(gateway.beginCalls).toBe(0);
    expect(gateway.calls).toEqual([]);
    expect(registry.getStatus(source.id)?.state).toBe("idle");
    // A skipped tick is reported as nothing at all — not as a completion
    // that would clear the holder's errors on the gateway.
    expect(events).toEqual([]);
  });

  test("a replacement during lease claim cannot resume the old instance", async () => {
    const { registry } = makeRegistry();
    const gateway = new LeaseGateway();
    let resolveClaim!: (decision: { granted: boolean; expiresAt?: number }) => void;
    gateway.claimSyncLease = async (sourceId: SourceId) => {
      gateway.claims.push(sourceId);
      return new Promise((resolve) => {
        resolveClaim = resolve;
      });
    };
    let oldPulls = 0;
    const oldSource = {
      ...makeDocumentSource("handoff-replaced", async () => {
        oldPulls += 1;
        return emptyPage();
      }),
      multiDeviceMode: "handoff" as const,
    };
    const replacement = {
      ...makeDocumentSource("handoff-replaced", async () => emptyPage()),
      multiDeviceMode: "handoff" as const,
    };
    registry.registerProvider(makeProvider(oldSource));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

    const run = runner.runOne(oldSource);
    await vi.waitFor(() => expect(gateway.claims).toEqual([oldSource.id]));
    registry.registerProvider(makeProvider(replacement));
    resolveClaim({ granted: true, expiresAt: Date.now() + 20_000 });
    await run;

    expect(oldPulls).toBe(0);
    expect(gateway.beginCalls).toBe(0);
    expect(gateway.calls).toEqual([]);
    expect(gateway.released).toEqual([oldSource.id]);
  });

  test("a skipped tick rolls back a trigger's syncing claim so the next tick runs", async () => {
    const { registry, events } = makeRegistry();
    const gateway = new LeaseGateway();
    const source = {
      ...makeDocumentSource("handoff-triggered", async () => ({
        documents: [],
        deletedExternalIds: [],
        cursor: {},
        hasMore: false,
      })),
      multiDeviceMode: "handoff" as const,
    };
    registry.registerProvider(makeProvider(source));
    gateway.decisions.set(source.id, { granted: false, holder: "other", reason: "held" });
    // A triggered sync marks the source syncing before the runner decides
    // whether this tick runs at all.
    registry.getStatus(source.id)!.state = "syncing";

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    expect(registry.getStatus(source.id)?.state).toBe("idle");
    expect(events).toEqual([]);
  });

  test("losing the lease mid-sync stops the run with the cause on record", async () => {
    const { registry } = makeRegistry();
    const gateway = new LeaseGateway();
    gateway.loseLease = true;
    const source = {
      ...makeDocumentSource("handoff-lost", async () => ({
        documents: [makeDoc("one", "handoff-lost:test")],
        deletedExternalIds: [],
        cursor: { page: 1 },
        hasMore: false,
      })),
      multiDeviceMode: "handoff" as const,
    };
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

    await runner.runOne(source);

    const status = registry.getStatus(source.id);
    expect(status?.state).toBe("error");
    expect(status?.lastError).toMatch(/lost the sync lease to other/);
    await runner.releaseLeases();
    expect(gateway.released).toEqual([]);
  });

  test("a member whose sync fails on its credentials gives the lease up", async () => {
    const { registry } = makeRegistry();
    const gateway = new LeaseGateway();
    const source = {
      ...makeDocumentSource("handoff-unauthenticated", async () => {
        throw new SyncError("auth", "refresh token revoked");
      }),
      multiDeviceMode: "handoff" as const,
    };
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

    await runner.runOne(source);

    expect(registry.getStatus(source.id)?.state).toBe("needs-auth");
    expect(gateway.released).toEqual([source.id]);
    // Nothing is left to release when the runner drains.
    await runner.releaseLeases();
    expect(gateway.released).toEqual([source.id]);
  });

  test("a member whose read is refused carries the remedy on its status and gives the lease up", async () => {
    const { registry } = makeRegistry();
    const gateway = new LeaseGateway();
    const remediation = {
      summary: "Disk access is required",
      steps: ["Open the pane.", "Add the executable."],
      executable: "/opt/example/bin/node",
      restartRequired: true,
    };
    const source = {
      ...makeDocumentSource("handoff-refused", async () => {
        throw new SyncError("permission", "Cannot open the database", { remediation });
      }),
      multiDeviceMode: "handoff" as const,
    };
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

    await runner.runOne(source);

    const status = registry.getStatus(source.id);
    expect(status?.state).toBe("error");
    expect(status?.lastError).toBe("Cannot open the database");
    expect(status?.remediation).toEqual(remediation);
    expect(gateway.released).toEqual([source.id]);
  });

  test("a source refused once that reads cleanly next time carries no remedy any more", async () => {
    const { registry } = makeRegistry();
    const gateway = new LeaseGateway();
    let refuse = true;
    const source = makeDocumentSource("refused-then-clean", async () => {
      if (refuse) {
        throw new SyncError("permission", "Cannot open the database", {
          remediation: {
            summary: "Disk access is required",
            steps: ["Grant it."],
            restartRequired: true,
          },
        });
      }
      return { documents: [], deletedExternalIds: [], cursor: { page: 1 }, hasMore: false };
    });
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

    await runner.runOne(source);
    expect(registry.getStatus(source.id)?.remediation).toBeDefined();

    refuse = false;
    await runner.runOne(source);
    const status = registry.getStatus(source.id);
    expect(status?.state).not.toBe("error");
    expect(status?.lastError).toBeUndefined();
    expect(status?.remediation).toBeUndefined();
  });

  test("a failure without a remedy reports none", async () => {
    const { registry } = makeRegistry();
    const gateway = new LeaseGateway();
    const source = makeDocumentSource("plain-failure", async () => {
      throw new Error("permission denied");
    });
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

    await runner.runOne(source);

    const status = registry.getStatus(source.id);
    expect(status?.state).toBe("error");
    expect(status?.remediation).toBeUndefined();
  });

  test("a member whose credential refresh fails without a typed kind gives the lease up", async () => {
    const { registry } = makeRegistry();
    const gateway = new LeaseGateway();
    const source = {
      // What an eager OAuth refresh throws when the stored refresh token is
      // gone: a provider mapper with no HTTP status, reason or OAuth body to
      // read stamps `unknown` on it, and the message carries the diagnosis.
      ...makeDocumentSource("handoff-no-refresh-token", async () => {
        throw new SyncError("unknown", "No refresh token is set.");
      }),
      multiDeviceMode: "handoff" as const,
    };
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

    await runner.runOne(source);

    expect(registry.getStatus(source.id)?.state).toBe("needs-auth");
    expect(gateway.released).toEqual([source.id]);
  });

  test("a held lease is renewed through a page fetch longer than the lease", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { registry } = makeRegistry();
      const gateway = new LeaseGateway();
      let finish!: () => void;
      const fetching = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const source = {
        ...makeDocumentSource("handoff-slow", async () => {
          await fetching;
          return { documents: [], deletedExternalIds: [], cursor: {}, hasMore: false };
        }),
        multiDeviceMode: "handoff" as const,
      };
      registry.registerProvider(makeProvider(source));
      gateway.decisions.set(source.id, { granted: true, expiresAt: Date.now() + 20_000 });
      const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

      const run = runner.runOne(source);
      await vi.waitFor(() => expect(gateway.claims).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(25_000);
      expect(gateway.claims.length).toBeGreaterThanOrEqual(3);
      finish();
      await run;
      const claimsAtFinish = gateway.claims.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gateway.claims).toHaveLength(claimsAtFinish);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a renewal the gateway refuses stops the run where the lease was lost", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const { registry } = makeRegistry();
      const gateway = new LeaseGateway();
      // The page write would be bounced too, so the run must never get there.
      gateway.loseLease = true;
      let finish!: () => void;
      const fetching = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const source = {
        ...makeDocumentSource("handoff-stolen", async (_cursor, opts) => {
          // A page long enough to outlast the lease, which the caller can cut
          // short by aborting — what a real source does with its signal.
          await new Promise<void>((resolve) => {
            void fetching.then(resolve);
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return {
            documents: [makeDoc("one", "handoff-stolen:test")],
            deletedExternalIds: [],
            cursor: { page: 1 },
            hasMore: false,
          };
        }),
        multiDeviceMode: "handoff" as const,
      };
      registry.registerProvider(makeProvider(source));
      gateway.decisions.set(source.id, { granted: true, expiresAt: Date.now() + 20_000 });
      const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

      const run = runner.runOne(source);
      await vi.waitFor(() => expect(gateway.claims).toHaveLength(1));
      // The lease moves to another device while the page is in flight.
      gateway.decisions.set(source.id, { granted: false, holder: "other", reason: "held" });
      await vi.advanceTimersByTimeAsync(11_000);
      // Whatever the run decided, the page itself eventually comes back — the
      // assertions below say whether the runner was still waiting for it.
      finish();
      await run;

      const status = registry.getStatus(source.id);
      expect(status?.state).toBe("error");
      expect(status?.lastError).toMatch(/lost the sync lease to other/);
      // The fetch was cut short at the refusal: no page write was attempted,
      // and the heartbeat stopped instead of re-asking a lease that is now
      // another device's.
      expect(gateway.writeAttempts).toBe(0);
      const claimsAtLoss = gateway.claims.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gateway.claims).toHaveLength(claimsAtLoss);
      // The lease is not ours to give back.
      await runner.releaseLeases();
      expect(gateway.released).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a granted handoff lease syncs as usual and is released when the runner stops", async () => {
    const { registry } = makeRegistry();
    const gateway = new LeaseGateway();
    const source = {
      ...makeDocumentSource("handoff-held-by-us", async () => ({
        documents: [makeDoc("one", "handoff-held-by-us:test")],
        deletedExternalIds: [],
        cursor: { page: 1 },
        hasMore: false,
      })),
      multiDeviceMode: "handoff" as const,
    };
    registry.registerProvider(makeProvider(source));
    const runner = new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000);

    await runner.runOne(source);
    expect(gateway.calls.filter((c) => c.kind === "upsertWithCursor")).toHaveLength(1);
    expect(gateway.released).toEqual([]);
    await runner.releaseLeases();
    expect(gateway.released).toEqual([source.id]);
    // Nothing is held any more; a second stop releases nothing.
    await runner.releaseLeases();
    expect(gateway.released).toEqual([source.id]);
  });

  test("a replicated member without the lease commits its pages and still sends its snapshot", async () => {
    const { registry } = makeRegistry();
    const gateway = new LeaseGateway();
    const source = {
      ...makeDocumentSource("replica", async () => ({
        documents: [makeDoc("one", "replica:test")],
        deletedExternalIds: [],
        presentExternalIds: ["one"],
        cursor: { page: 1 },
        hasMore: false,
      })),
      multiDeviceMode: "replicated" as const,
    };
    registry.registerProvider(makeProvider(source));
    gateway.decisions.set(source.id, { granted: false, holder: "other", reason: "held" });

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    const write = gateway.calls.find((c) => c.kind === "upsertWithCursor");
    expect(write?.documents).toHaveLength(1);
    // The gateway sets a non-holder's snapshot aside for reconciling, but it
    // still reads it for the items this member keeps alive against another
    // member's deletion — so the collector always sends it.
    expect(write?.presentExternalIds).toEqual(["one"]);
    expect(registry.getStatus(source.id)?.state).toBe("idle");
  });

  test("a replicated structured member without the lease still sends its row snapshot", async () => {
    const { registry } = makeRegistry();
    const gateway = new LeaseGateway();
    const source = {
      ...makeStructuredSource("replica-rows", async () => ({
        analytics: {
          tableName: "step_counts",
          records: [{ day: "2024-01-01", steps: 4200 }],
          presentIds: ["2024-01-01"],
        },
        cursor: { page: 1 },
        hasMore: false,
      })),
      multiDeviceMode: "replicated" as const,
    };
    registry.registerProvider(makeProvider(source));
    gateway.decisions.set(source.id, { granted: false, holder: "other", reason: "held" });

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    // Rows first, the cursor next, the snapshot last — the gateway reads a
    // non-holder's snapshot for the rows it keeps alive, so it is sent.
    expect(gateway.calls.map((call) => call.kind)).toEqual([
      "ingestAnalytics",
      "upsertWithCursor",
      "ingestAnalytics",
    ]);
    expect(gateway.calls[2]).toMatchObject({ records: [], presentIds: ["2024-01-01"] });
    expect(registry.getStatus(source.id)?.state).toBe("idle");
  });

  test("a replicated row tombstone the gateway defers ends the tick idle with its cursor retained", async () => {
    const { registry, events } = makeRegistry();
    const gateway = new LeaseGateway();
    gateway.analyticsResponse = { ingested: 0, deleted: 0, deletionDeferred: true };
    const source = {
      ...makeStructuredSource("replica-deferred-rows", async () => ({
        analytics: { tableName: "step_counts", deletedIds: ["2024-01-01"] },
        cursor: { page: 1 },
        hasMore: false,
      })),
      multiDeviceMode: "replicated" as const,
    };
    registry.registerProvider(makeProvider(source));
    gateway.decisions.set(source.id, { granted: false, holder: "other", reason: "held" });

    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );

    // The SQLite page is never sent, so the cursor stays and the tick replays.
    expect(gateway.calls.map((call) => call.kind)).toEqual(["ingestAnalytics"]);
    expect(await gateway.getSyncState(source.id)).toBeNull();
    expect(registry.getStatus(source.id)?.state).toBe("idle");
    expect(registry.getStatus(source.id)?.lastError).toBeUndefined();
    expect(events.some((event) => event.event === "sync.deferred")).toBe(true);
    expect(events.some((event) => event.event === "sync.error")).toBe(false);
  });

  test("an exclusive source never claims", async () => {
    const { registry } = makeRegistry();
    const gateway = new LeaseGateway();
    const source = makeDocumentSource("solo", async () => ({
      documents: [],
      deletedExternalIds: [],
      cursor: {},
      hasMore: false,
    }));
    registry.registerProvider(makeProvider(source));
    await new SourceSyncRunner(gateway as unknown as GatewayClient, registry, 60_000).runOne(
      source,
    );
    expect(gateway.claims).toEqual([]);
  });
});
