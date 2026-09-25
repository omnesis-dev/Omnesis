// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { HttpGatewayClient } from "@omnesis/gateway-client";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { SourceSyncRunner } from "../source-sync-runner.js";
import { SourceRegistry } from "../source-registry.js";
import { SyncScheduler } from "../sync-scheduler.js";
import { FileWatcherManager } from "../file-watcher-manager.js";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type { RegisteredSource } from "../sync-engine-types.js";
import type { AnalyticsTableSchema, StructuredSyncResult } from "@omnesis/source-sdk";

const SOURCE = SourceId("notes-synth:journal");
const PROVIDER = ProviderId("notes-synth:journal");
const FIRST = "journal_first";
const SECOND = "journal_second";

const schema = (tableName: string): AnalyticsTableSchema => ({
  tableName,
  displayName: "Journal fixture",
  description: "Fictional rows for durable page replay",
  columns: [
    { name: "id", type: "VARCHAR", description: "Row id" },
    { name: "value", type: "INTEGER", description: "Value" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { keyColumns: ["id"], titleColumns: ["id"] },
});

const document: DocumentInput = {
  providerId: PROVIDER,
  sourceId: SOURCE,
  externalId: "original-document",
  title: "Fictional notebook",
  content: "An original page retained through a interrupted sync.",
  contentHash: "journal-original-hash",
  metadata: { documentType: "note" },
  sourceCreatedAt: "2026-01-01T00:00:00Z",
  sourceUpdatedAt: "2026-01-01T00:00:00Z",
};

function collector(
  client: HttpGatewayClient,
  syncStructured: () => Promise<StructuredSyncResult>,
  schemas = [schema(FIRST), schema(SECOND)],
) {
  const registry = new SourceRegistry(new SyncScheduler(), new FileWatcherManager(() => {}));
  const source: RegisteredSource = {
    id: SOURCE,
    providerId: PROVIDER,
    name: "Journal fixture",
    family: { name: "Journal fixtures" },
    instance: {
      sync: async () => {
        throw new Error("Wrong sync plane");
      },
      syncStructured,
      analyticsSchemas: schemas,
    },
  };
  registry.registerProvider({
    id: PROVIDER,
    name: "Journal fixture",
    renewableCredential: false,
    credentialState: async () => ({ status: "connected" }),
    sources: [source],
  });
  const runner = new SourceSyncRunner(client, registry, 30_000);
  return { run: () => runner.runOne(source), status: () => registry.getStatus(SOURCE) };
}

test("a child-only legacy journal installs parent ownership and preserves sibling rows across lost-response replay", async () => {
  const harness = new MultiCollectorHarness();
  try {
    await harness.start();
    const device = await harness.addCollector({
      name: "ownership-collector",
      hostableSourceTypes: ["notes-synth"],
    });
    const registration = await fetch(`${harness.gatewayUrl}/devices/sources/bulk-upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [
          { type: "notes-synth", accountId: "journal" },
          { type: "notes-synth", accountId: "sibling" },
        ],
      }),
    });
    expect((await registration.json()).errors).toEqual([]);
    const client = new HttpGatewayClient(harness.gatewayUrl, device.token);
    const admin = new HttpGatewayClient(harness.gatewayUrl, harness.bootstrapToken);
    for (const relation of [
      null,
      "invalid",
      { table: "parents" },
      { table: "parents; DROP TABLE ignored", column: "id", parentColumn: "id" },
    ]) {
      const invalidTable = "journal_invalid_relation";
      const invalid = await fetch(`${harness.gatewayUrl}/analytics/ingest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          tableName: invalidTable,
          sourceId: SOURCE,
          records: [],
          schema: {
            ...schema(invalidTable),
            sharedDiscriminatorColumn: "id",
            sharedDiscriminatorParent: relation,
          },
        }),
      });
      expect(invalid.status).toBe(400);
      const missing = await fetch(`${harness.gatewayUrl}/analytics/catalog/${invalidTable}`, {
        headers: { Authorization: `Bearer ${device.token}` },
      });
      expect(missing.status).toBe(404);
    }
    const parent: AnalyticsTableSchema = {
      ...schema("journal_parents"),
      columns: [
        ...schema(FIRST).columns,
        { name: "account", type: "VARCHAR", description: "Owning account" },
      ],
    };
    const child: AnalyticsTableSchema = {
      ...schema("journal_children"),
      deleteKey: ["parent_id"],
      columns: [
        ...schema(FIRST).columns,
        { name: "parent_id", type: "VARCHAR", description: "Parent row" },
      ],
    };
    // Bare metadata ownership and rows without a declared discriminator model an
    // installed catalog, not a new qualified writer's ownership claim.
    await admin.ingestAnalyticsPage({
      tableName: parent.tableName,
      schema: parent,
      sourceId: SourceId("notes-synth"),
      records: [
        { id: "parent-a", value: 1, account: "journal" },
        { id: "parent-b", value: 2, account: "sibling" },
      ],
    });
    await admin.ingestAnalyticsPage({
      tableName: child.tableName,
      schema: child,
      sourceId: SourceId("notes-synth"),
      records: [
        { id: "child-a", parent_id: "parent-a", value: 1 },
        { id: "child-b", parent_id: "parent-b", value: 2 },
      ],
    });
    const epoch = await client.beginSyncAttempt(SOURCE);
    expect(epoch).toBeTypeOf("number");
    const prepared = await client.prepareStructuredPage(SOURCE, {
      id: "33333333-3333-4333-8333-333333333333",
      writeEpoch: epoch!,
      result: {
        analytics: {
          tableName: child.tableName,
          schema: child,
          deletedKeys: [{ parent_id: "parent-a" }],
        },
        cursor: { generation: 1 },
        hasMore: false,
      },
    });
    const schemas: AnalyticsTableSchema[] = [
      {
        ...child,
        sharedDiscriminatorColumn: "account",
        sharedDiscriminatorParent: {
          table: parent.tableName,
          column: "parent_id",
          parentColumn: "id",
        },
        columns: [
          ...child.columns,
          { name: "account", type: "VARCHAR", nullable: true, description: "Owning account" },
        ],
      },
      { ...parent, sharedDiscriminatorColumn: "account" },
    ];
    const noRefetch = vi.fn(async (): Promise<StructuredSyncResult> => {
      throw new Error("Pending journal must replay first");
    });
    const ingest = client.ingestAnalyticsPage.bind(client);
    let loseResponse = true;
    const writes = vi.spyOn(client, "ingestAnalyticsPage").mockImplementation(async (page) => {
      const response = await ingest(page);
      if (page.pendingPageId && loseResponse) {
        loseResponse = false;
        expect(response.deleted).toBe(1);
        throw new Error("Injected lost child deletion response");
      }
      return response;
    });
    const first = collector(client, noRefetch, schemas);
    await first.run();
    expect(first.status()?.state).toBe("error");
    expect(await client.getPendingStructuredPage(SOURCE)).toEqual(prepared);
    expect((await client.getSyncState(SOURCE))?.cursor ?? null).toBeNull();
    expect(
      writes.mock.calls.slice(0, 2).map(([page]) => [page.tableName, page.pendingPageId]),
    ).toEqual([
      [parent.tableName, undefined],
      [child.tableName, undefined],
    ]);
    expect(
      (await client.queryAnalytics(`SELECT id, account FROM ${child.tableName} ORDER BY id`)).rows,
    ).toEqual([{ id: "child-b", account: "sibling" }]);
    await ingest({
      tableName: child.tableName,
      sourceId: SOURCE,
      records: [{ id: "child-a", parent_id: "parent-a", value: 99 }],
      writeEpoch: await client.getWipeEpoch(SOURCE),
    });
    await harness.restartGateway();
    const resumed = collector(client, noRefetch, schemas);
    await resumed.run();
    expect(resumed.status()?.state).toBe("idle");
    expect(noRefetch).not.toHaveBeenCalled();
    expect(await client.getPendingStructuredPage(SOURCE)).toBeNull();
    expect((await client.getSyncState(SOURCE))?.cursor).toEqual({ generation: 1 });
    expect(
      writes.mock.calls
        .filter(([page]) => page.pendingPageId)
        .map(([page]) => [page.pendingPageId, page.writeOrdinal, page.schema]),
    ).toEqual([
      [prepared.id, 0, child],
      [prepared.id, 0, child],
    ]);
    expect(
      (await client.queryAnalytics(`SELECT id, value, account FROM ${child.tableName} ORDER BY id`))
        .rows,
    ).toEqual([
      { id: "child-a", value: 99, account: "journal" },
      { id: "child-b", value: 2, account: "sibling" },
    ]);
  } finally {
    vi.restoreAllMocks();
    await harness.destroy();
  }
});

test("mixed pages survive lost analytics responses, gateway restart, committed-cursor snapshot failure, and ack retry", async () => {
  const harness = new MultiCollectorHarness();
  try {
    await harness.start();
    const device = await harness.addCollector({
      name: "journal-collector",
      hostableSourceTypes: ["notes-synth"],
    });
    const registration = await fetch(`${harness.gatewayUrl}/devices/sources/bulk-upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${device.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sources: [{ type: "notes-synth", accountId: "journal" }] }),
    });
    expect((await registration.json()).errors).toEqual([]);
    const client = new HttpGatewayClient(harness.gatewayUrl, device.token);
    await client.ingestAnalyticsPage({
      tableName: FIRST,
      schema: schema(FIRST),
      sourceId: SOURCE,
      records: [{ id: "old", value: 1 }],
    });
    const result: StructuredSyncResult = {
      analytics: [
        { tableName: FIRST, deletedKeys: [{ id: "old" }] },
        {
          tableName: FIRST,
          records: [{ id: "kept", value: 2 }],
          presentKeys: [{ id: "old" }, { id: "kept" }],
        },
        { tableName: SECOND, records: [{ id: "child", value: 3 }], presentKeys: [{ id: "child" }] },
      ],
      documents: [document],
      cursor: { generation: 1 },
      hasMore: false,
    };
    const fetchPage = vi.fn(async () => result);
    const ingest = client.ingestAnalyticsPage.bind(client);
    const analytics = vi
      .spyOn(client, "ingestAnalyticsPage")
      .mockImplementationOnce(async (page) => {
        const response = await ingest(page);
        expect(response.deleted).toBe(1);
        throw new Error("Injected lost response after durable DuckDB commit");
      });
    const first = collector(client, fetchPage);
    await first.run();
    expect(first.status()?.state).toBe("error");
    const prepared = await client.getPendingStructuredPage(SOURCE);
    expect(prepared).toMatchObject({
      cursorCommitted: false,
      result: { cursor: { generation: 1 } },
    });
    expect((await client.getSyncState(SOURCE))?.cursor ?? null).toBeNull();
    const currentEpoch = (await client.getWipeEpoch(SOURCE))!;
    expect(
      await client.acknowledgeStructuredPage(SOURCE, {
        id: prepared!.id,
        writeEpoch: currentEpoch,
      }),
    ).toEqual({ acknowledged: false });
    const samePage = await client.prepareStructuredPage(SOURCE, {
      id: "22222222-2222-4222-8222-222222222222",
      writeEpoch: currentEpoch,
      result: { cursor: { generation: 999 }, hasMore: false },
    });
    expect(samePage.id).toBe(prepared!.id);
    expect(samePage.result).toEqual(prepared!.result);

    // A later arrival must not be erased by repeating the already-committed delete.
    await ingest({
      tableName: FIRST,
      sourceId: SOURCE,
      records: [{ id: "old", value: 99 }],
      writeEpoch: await client.getWipeEpoch(SOURCE),
    });
    await harness.restartGateway();
    const noRefetch = vi.fn(async (): Promise<StructuredSyncResult> => {
      throw new Error("Pending page must precede upstream discovery");
    });
    analytics.mockImplementation(async (page) => {
      if (page.observationId) throw new Error("Injected unavailable post-cursor snapshot");
      return ingest(page);
    });
    const resumed = collector(client, noRefetch);
    await resumed.run();
    expect(resumed.status()?.state).toBe("error");
    expect(await client.getPendingStructuredPage(SOURCE)).toMatchObject({
      id: prepared!.id,
      cursorCommitted: true,
    });
    expect((await client.getSyncState(SOURCE))?.cursor).toEqual({ generation: 1 });
    expect(
      (await client.queryAnalytics(`SELECT id, value FROM ${FIRST} ORDER BY id`)).rows,
    ).toEqual([
      { id: "kept", value: 2 },
      { id: "old", value: 99 },
    ]);
    expect((await client.queryAnalytics(`SELECT id, value FROM ${SECOND}`)).rows).toEqual([
      { id: "child", value: 3 },
    ]);
    expect(await client.getDocumentCount(SOURCE)).toBe(1);

    await harness.restartGateway();
    analytics.mockClear().mockImplementation(ingest);
    const upserts = vi.spyOn(client, "upsertWithCursor");
    const acknowledge = vi
      .spyOn(client, "acknowledgeStructuredPage")
      .mockRejectedValueOnce(new Error("Injected unavailable acknowledgement"));
    const snapshots = collector(client, noRefetch);
    await snapshots.run();
    expect(snapshots.status()?.state).toBe("error");
    expect(await client.getPendingStructuredPage(SOURCE)).toMatchObject({
      id: prepared!.id,
      cursorCommitted: true,
    });
    expect(upserts).not.toHaveBeenCalled();
    expect(
      analytics.mock.calls.map(([page]) => ({
        records: page.records,
        observationId: page.observationId,
        ordinal: page.writeOrdinal,
      })),
    ).toEqual([
      { records: [], observationId: prepared!.id, ordinal: 3 },
      { records: [], observationId: prepared!.id, ordinal: 4 },
    ]);
    const finish = collector(client, noRefetch);
    await finish.run();
    expect(finish.status()?.state).toBe("idle");
    expect(await client.getPendingStructuredPage(SOURCE)).toBeNull();
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(upserts).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(noRefetch).not.toHaveBeenCalled();
    await expect(
      ingest({
        tableName: FIRST,
        sourceId: SOURCE,
        records: [],
        deletedKeys: [{ id: "old" }],
        pendingPageId: prepared!.id,
        writeOrdinal: 0,
        writeEpoch: await client.getWipeEpoch(SOURCE),
      }),
    ).rejects.toThrow(/409/);
    expect(
      (await client.queryAnalytics(`SELECT value FROM ${FIRST} WHERE id = 'old'`)).rows,
    ).toEqual([{ value: 99 }]);
  } finally {
    vi.restoreAllMocks();
    await harness.destroy();
  }
}, 120_000);
