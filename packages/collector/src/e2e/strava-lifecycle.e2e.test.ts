// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpGatewayClient } from "@omnesis/gateway-client";
import { AccountId, ProviderId, SourceId, SourceType } from "@omnesis/types";
import { analyticsDeleteKey, emptySync, type AnalyticsTableSchema } from "@omnesis/source-sdk";
import { StravaActivitiesSource } from "@omnesis/provider-strava/src/activities.js";
import { activityToDocument } from "@omnesis/provider-strava/src/normalizer.js";
import { activitySchemas, allSchemas } from "@omnesis/provider-strava/src/schemas.js";
import { SyncEngine } from "../sync-engine.js";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type { StravaClient } from "@omnesis/provider-strava/src/client.js";
import type {
  StravaActivitiesCursor,
  StravaSummaryActivity,
} from "@omnesis/provider-strava/src/types.js";
import type { RegisteredSource } from "../sync-engine-types.js";

const sourceId = SourceId("strava-activities:42");
const providerId = ProviderId("strava:42");
const athleteId = 42;
const activity = (id: number): StravaSummaryActivity => ({
  id,
  athlete: { id: athleteId },
  name: `Fixture activity ${id}`,
  distance: 5000,
  moving_time: 1800,
  elapsed_time: 1850,
  total_elevation_gain: 50,
  type: "Run",
  sport_type: "Run",
  start_date: "2026-01-01T12:00:00Z",
  start_date_local: "2026-01-01T12:00:00",
  has_heartrate: false,
  kudos_count: 0,
  comment_count: 0,
  athlete_count: 1,
  trainer: false,
  commute: false,
  manual: false,
  private: false,
});

/** Real table shapes; account ownership is independent of child/actor identity. */
function record(schema: AnalyticsTableSchema, id: number, child: number) {
  return Object.fromEntries(
    schema.columns.map((column) => {
      let value: unknown;
      if (column.name === schema.sharedDiscriminatorColumn) value = athleteId;
      else if (column.name === analyticsDeleteKey(schema)[0])
        value = column.type === "VARCHAR" ? String(id) : id;
      else if (column.type === "VARCHAR") value = `fixture-${id}-${child}`;
      else if (column.type === "BOOLEAN") value = false;
      else if (column.type === "JSON") value = [];
      else if (column.type.startsWith("TIMESTAMP")) value = "2026-01-01T12:00:00Z";
      else if (column.type.endsWith("[]")) value = [];
      else value = id * 10 + child;
      return [column.name, value];
    }),
  );
}

describe("real Strava snapshot lifecycle across both storage planes", () => {
  let harness: MultiCollectorHarness;
  let gateway: HttpGatewayClient;
  let engine: SyncEngine;
  let source: RegisteredSource;
  let upstream = [activity(1), activity(2)];
  let upstreamError = false;
  const count = async (schema: AnalyticsTableSchema) => {
    const result = await harness.json<{ rows: number[][] }>("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql: `SELECT count(*) FROM ${schema.tableName}` }),
    });
    return Number(result.rows[0]![0]);
  };
  const sweep = async () => {
    for (let i = 0; i < 2; i++)
      await harness.json("/admin/background/run/absence.sweep", { method: "POST" });
  };
  const snapshot = async () => {
    const epoch = await gateway.beginSyncAttempt(sourceId);
    await gateway.upsertWithCursor({
      sourceId,
      providerId,
      documents: [],
      hasMore: false,
      cursor: { phase: "snapshot-rewalk", snapshotIds: [], snapshotPage: 1 },
      wipeEpoch: epoch,
    });
    await expect
      .poll(async () => (await gateway.getSyncState(sourceId))?.cursor.phase, { timeout: 10_000 })
      .toBe("snapshot-rewalk");
    await engine.syncSource(source);
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
      name: "activity-fixture",
      hostableSourceTypes: ["strava-activities"],
    });
    gateway = new HttpGatewayClient(harness.gatewayUrl, collector.token);
    expect(
      (
        await gateway.bulkUpsertSources([
          { type: SourceType("strava-activities"), accountId: AccountId("42"), enabled: true },
        ])
      ).errors,
    ).toEqual([]);
    const implementation = new StravaActivitiesSource(
      {
        listActivities: async () => {
          if (upstreamError) throw new Error("Fixture upstream unavailable");
          return upstream;
        },
      } as unknown as StravaClient,
      sourceId,
      providerId,
    );
    source = {
      id: sourceId,
      providerId,
      name: "Fixture activities",
      family: { name: "Strava" },
      instance: {
        sync: async () => emptySync(),
        analyticsSchemas: allSchemas,
        syncStructured: (cursor) => implementation.syncStructured(cursor as StravaActivitiesCursor),
      },
    };
    engine = new SyncEngine(gateway);
    engine.registerProvider({
      id: providerId,
      name: "Fixture activities",
      renewableCredential: false,
      credentialState: async () => ({ status: "connected" }),
      sources: [source],
    });
    const epoch = await gateway.beginSyncAttempt(sourceId);
    for (const schema of allSchemas) {
      // Profile, athlete zones and stats belong to one athlete, not two activities.
      const ids =
        analyticsDeleteKey(schema)[0] === schema.sharedDiscriminatorColumn ? [athleteId] : [1, 2];
      const childRows =
        schema.primaryKey.length === 1 && schema.primaryKey[0] === analyticsDeleteKey(schema)[0]
          ? [1]
          : [1, 2];
      await gateway.ingestAnalyticsPage({
        tableName: schema.tableName,
        sourceId,
        schema,
        records: ids.flatMap((id) => childRows.map((child) => record(schema, id, child))),
        writeEpoch: epoch,
      });
    }
    await gateway.upsertWithCursor({
      providerId,
      sourceId,
      documents: upstream.map((item) => activityToDocument(item, providerId, sourceId)),
      cursor: { phase: "incremental" },
      hasMore: false,
      wipeEpoch: epoch,
    });
  }, 60_000);

  afterAll(async () => {
    await engine?.stopSyncLoopAndDrain();
    await harness?.destroy();
  }, 20_000);

  test("all table fixtures belong to the source account without conflating activity or actor IDs", async () => {
    const expectedCounts = new Map([
      ["strava_activities", 2],
      ["strava_activity_splits", 4],
      ["strava_activity_best_efforts", 4],
      ["strava_activity_laps", 4],
      ["strava_activity_segment_efforts", 4],
      ["strava_activity_zones", 4],
      ["strava_activity_comments", 4],
      ["strava_activity_kudos", 4],
      ["strava_activity_streams", 2],
      ["strava_athlete", 1],
      ["strava_athlete_zones", 2],
      ["strava_athlete_stats", 2],
      ["strava_gear", 2],
    ]);
    for (const schema of allSchemas) {
      const owner = schema.sharedDiscriminatorColumn;
      expect(owner).toBeDefined();
      const result = await harness.json<{ rows: number[][] }>("/analytics/sql", {
        method: "POST",
        body: JSON.stringify({
          sql: `SELECT count(*), min(${owner}), max(${owner}), count(*) FILTER (WHERE ${owner} IS NULL) FROM ${schema.tableName}`,
        }),
      });
      expect(result.rows[0]!.map(Number), schema.tableName).toEqual([
        expectedCounts.get(schema.tableName),
        athleteId,
        athleteId,
        0,
      ]);
      if (schema.sharedDiscriminatorParent) {
        expect(allSchemas.indexOf(schema)).toBeGreaterThan(
          allSchemas.findIndex(
            (parent) => parent.tableName === schema.sharedDiscriminatorParent!.table,
          ),
        );
      }
    }
    for (const table of ["strava_activity_comments", "strava_activity_kudos"]) {
      const result = await harness.json<{ rows: number[][] }>("/analytics/sql", {
        method: "POST",
        body: JSON.stringify({
          sql: `SELECT count(*) FROM ${table} WHERE athlete_id <> source_athlete_id`,
        }),
      });
      expect(Number(result.rows[0]![0])).toBe(4);
    }
    const schema = activitySchemas[0]!;
    await expect(
      gateway.ingestAnalyticsPage({
        tableName: schema.tableName,
        sourceId,
        schema,
        records: [{ ...record(schema, 1, 1), athlete_id: 99 }],
        writeEpoch: await gateway.beginSyncAttempt(sourceId),
      }),
    ).rejects.toThrow(/different source account/);
    expect(await count(schema)).toBe(2);
  });

  test("failed enumeration retains data; repeated complete omissions remove whole activity groups only", async () => {
    const original = new Map(
      await Promise.all(
        allSchemas.map(async (schema) => [schema.tableName, await count(schema)] as const),
      ),
    );
    upstream = [activity(1)];
    upstreamError = true;
    await snapshot();
    expect(engine.getStatuses().find((status) => status.sourceId === sourceId)?.state).toBe(
      "error",
    );
    await sweep();
    for (const schema of allSchemas)
      expect(await count(schema)).toBe(original.get(schema.tableName));
    upstreamError = false;
    for (let cycle = 0; cycle < 3; cycle++) {
      await snapshot();
      expect(engine.getStatuses().find((status) => status.sourceId === sourceId)?.state).toBe(
        "idle",
      );
    }
    await sweep();
    for (const schema of activitySchemas)
      expect(await count(schema), schema.tableName).toBe(original.get(schema.tableName)! / 2);
    for (const schema of allSchemas.filter((candidate) => !activitySchemas.includes(candidate))) {
      expect(await count(schema), schema.tableName).toBe(original.get(schema.tableName));
    }
    const documents = (await gateway.listDocuments({ limit: 100 })).documents.filter(
      (doc) => doc.sourceId === sourceId,
    );
    expect(documents.map((doc) => doc.title)).toEqual(["Fixture activity 1"]);
    upstream = [];
    for (let cycle = 0; cycle < 3; cycle++) await snapshot();
    await sweep();
    for (const schema of activitySchemas) expect(await count(schema), schema.tableName).toBe(0);
    expect(
      (await gateway.listDocuments({ limit: 100 })).documents.filter(
        (doc) => doc.sourceId === sourceId,
      ),
    ).toHaveLength(0);
    for (const schema of allSchemas.filter((candidate) => !activitySchemas.includes(candidate))) {
      expect(await count(schema), schema.tableName).toBe(original.get(schema.tableName));
    }
  }, 60_000);
});
