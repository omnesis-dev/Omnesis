// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { APIErrorCode, APIResponseError } from "@notionhq/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpGatewayClient } from "@omnesis/gateway-client";
import { AccountId, ProviderId, SourceId, SourceType, type DocumentInput } from "@omnesis/types";
import { emptySync, withVersionedState } from "@omnesis/source-sdk";
import { NotionDatabasesSource } from "@omnesis/provider-notion/src/databases.js";
import { notionDatabasesStateSpec } from "@omnesis/provider-notion/src/state.js";
import { SyncEngine } from "../sync-engine.js";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type { NotionDatabasesCursor } from "@omnesis/provider-notion/src/types.js";
import type { NotionClient } from "@omnesis/provider-notion/src/client.js";
import type {
  DataSourceObjectResponse,
  PageObjectResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { RegisteredSource } from "../sync-engine-types.js";

const sourceId = SourceId("notion-databases:fixture");
const providerId = ProviderId("notion:fixture");
const stamp = "2026-01-01T12:00:00.000Z";
function database(id: string): DataSourceObjectResponse {
  return {
    object: "data_source",
    id: `ds-${id}`,
    title: [{ plain_text: `Fixture ${id}` }],
    description: [],
    properties: {},
    created_time: stamp,
    last_edited_time: stamp,
    archived: false,
    in_trash: false,
    is_inline: false,
    parent: { type: "database_id", database_id: id },
    database_parent: { type: "workspace", workspace: true },
    url: `https://notion.so/${id}`,
    public_url: null,
    cover: null,
    icon: null,
    created_by: { object: "user", id: "fixture-user" },
    last_edited_by: { object: "user", id: "fixture-user" },
  } as unknown as DataSourceObjectResponse;
}
function row(id: string, databaseId: string): PageObjectResponse {
  return {
    object: "page",
    id,
    properties: {},
    created_time: stamp,
    last_edited_time: stamp,
    archived: false,
    in_trash: false,
    url: `https://notion.so/${id}`,
    parent: { type: "database_id", database_id: databaseId },
    created_by: { object: "user", id: "fixture-user" },
    last_edited_by: { object: "user", id: "fixture-user" },
  } as unknown as PageObjectResponse;
}

describe("real Notion database lifecycle through both storage planes", () => {
  let harness: MultiCollectorHarness;
  let gateway: HttpGatewayClient;
  let engine: SyncEngine;
  let source: RegisteredSource;
  let now = Date.parse("2026-02-01T00:00:00.000Z");
  let listed = ["readable", "vanished", "blocked"];
  let denyBlocked = false;
  const rows: Record<string, string[]> = {
    readable: ["kept", "removed"],
    vanished: ["former"],
    blocked: ["held"],
  };
  const emitted = new Map<string, DocumentInput>();
  const readDb = <T>(fn: (db: Database.Database) => T): T => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const stored = () =>
    readDb((db) =>
      db
        .prepare<
          [string],
          { external_id: string; partition_key: string }
        >("SELECT external_id, partition_key FROM documents WHERE source_id = ? ORDER BY external_id")
        .all(sourceId),
    );
  const absent = () =>
    readDb((db) =>
      db
        .prepare<[string], { external_id: string }>(
          "SELECT external_id FROM document_absences WHERE source_id = ? ORDER BY external_id",
        )
        .all(sourceId)
        .map((entry) => entry.external_id),
    );
  const countRows = async (id: "readable" | "vanished" | "blocked") => {
    const result = await harness.json<{ rows: number[][] }>("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql: `SELECT count(*) FROM notion_${id}` }),
    });
    return Number(result.rows[0]![0]);
  };
  const sweep = async () => {
    for (let pass = 0; pass < 2; pass++)
      await harness.json("/admin/background/run/absence.sweep", { method: "POST" });
  };
  const sync = async () => {
    // Expire both the discovery cache and the longest inaccessible-DB backoff.
    now += 2 * 24 * 60 * 60 * 1000;
    await engine.syncSource(source);
    expect(engine.getStatuses().find((status) => status.sourceId === sourceId)?.state).toBe("idle");
  };

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
      extraGatewayEnv: { OMNESIS_SYNTHETIC: "1" },
      gatewayConfig: {
        gateway: {
          snapshotAbsence: {
            minObservations: 3,
            minAge: "10ms",
            deletionGrace: "1ms",
            maxMarksPerSnapshot: 200,
          },
        },
      },
    });
    await harness.start();
    const collector = await harness.addCollector({
      name: "database-fixture",
      hostableSourceTypes: ["notion-databases"],
    });
    gateway = new HttpGatewayClient(harness.gatewayUrl, collector.token);
    expect(
      (
        await gateway.bulkUpsertSources([
          { type: SourceType("notion-databases"), accountId: AccountId("fixture"), enabled: true },
        ])
      ).errors,
    ).toEqual([]);
    const upstream = {
      searchDatabases: async () => ({
        results: listed.map(database),
        has_more: false,
        next_cursor: null,
      }),
      getDatabase: async (id: string) => {
        if (denyBlocked && id === "blocked")
          throw new APIResponseError({
            code: APIErrorCode.RestrictedResource,
            status: 403,
            message: "Fixture permission unavailable",
            headers: new Headers(),
            rawBodyText: "{}",
            additional_data: undefined,
            request_id: undefined,
          });
        return database(id);
      },
      queryDatabase: async (id: string) => ({
        results: rows[id]!.map((value) => row(value, id)),
        has_more: false,
        next_cursor: null,
      }),
    } as unknown as NotionClient;
    const implementation = new NotionDatabasesSource(
      upstream,
      sourceId,
      providerId,
      undefined,
      undefined,
      { nowFn: () => now },
    );
    source = {
      id: sourceId,
      providerId,
      name: "Fixture databases",
      family: { name: "Notion" },
      instance: withVersionedState(
        {
          sync: async () => emptySync(),
          analyticsSchemas: [],
          syncStructured: async (cursor) => {
            const page = await implementation.syncStructured(
              cursor as NotionDatabasesCursor | null,
            );
            for (const document of page.documents ?? []) emitted.set(document.externalId, document);
            return page;
          },
        },
        notionDatabasesStateSpec,
        { sourceId },
      ),
    };
    engine = new SyncEngine(gateway);
    engine.registerProvider({
      id: providerId,
      name: "Fixture databases",
      renewableCredential: false,
      credentialState: async () => ({ status: "connected" }),
      sources: [source],
    });
  }, 60_000);

  afterAll(async () => {
    await engine?.stopSyncLoopAndDrain();
    await harness?.destroy();
  }, 20_000);

  test("restamps old summaries, revokes transient absence, and retires missing partitions despite a sibling 403", async () => {
    await sync();
    expect(stored()).toHaveLength(7);
    expect(await countRows("readable")).toBe(2);
    const summary = [...emitted.values()].find(
      (document) => document.partitionKey === "readable" && document.externalId.startsWith("db-"),
    )!;
    expect(summary).toBeDefined();
    const installed = await gateway.getSyncState(sourceId);
    const epoch = await gateway.beginSyncAttempt(sourceId);
    await gateway.upsertWithCursor({
      providerId,
      sourceId,
      documents: [{ ...summary, partitionKey: "" }],
      cursor: installed!.cursor,
      hasMore: false,
      wipeEpoch: epoch,
    });
    expect(stored().find((entry) => entry.external_id === summary.externalId)?.partition_key).toBe(
      "",
    );
    denyBlocked = true;
    await sync();
    expect(stored().find((entry) => entry.external_id === summary.externalId)?.partition_key).toBe(
      "readable",
    );
    expect(stored()).toHaveLength(7);

    listed = ["readable", "blocked"];
    await sync();
    expect(absent()).toContain("row-former");
    listed = ["readable", "vanished", "blocked"];
    await sync();
    expect(absent()).not.toContain("row-former");
    await sweep();
    expect(stored()).toHaveLength(7);
    expect(await countRows("vanished")).toBe(1);

    listed = ["readable", "blocked"];
    rows.readable = ["kept"];
    for (let cycle = 0; cycle < 3; cycle++) await sync();
    await sweep();
    expect(stored().map((entry) => entry.external_id)).toEqual([
      "db-blocked",
      "db-readable",
      "row-held",
      "row-kept",
    ]);
    expect(await countRows("readable")).toBe(1);
    expect(await countRows("vanished")).toBe(0);
    expect(await countRows("blocked")).toBe(1);

    listed = [];
    for (let cycle = 0; cycle < 3; cycle++) await sync();
    await sweep();
    expect(stored()).toEqual([]);
    for (const id of ["readable", "vanished", "blocked"] as const)
      expect(await countRows(id)).toBe(0);
  }, 90_000);
});
