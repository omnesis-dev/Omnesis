// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { HttpGatewayClient } from "@omnesis/gateway-client";
import { AccountId, ProviderId, SourceId, SourceType } from "@omnesis/types";
import {
  analyticsDeleteKey,
  emptySync,
  type AnalyticsTableSchema,
  type StructuredSyncResult,
} from "@omnesis/source-sdk";
import { rowsFor } from "@omnesis/source-sdk/testing";
import { StravaActivitiesSource } from "@omnesis/provider-strava/src/activities.js";
import { activityToDocument } from "@omnesis/provider-strava/src/normalizer.js";
import { StravaRateLimitTracker } from "@omnesis/provider-strava/src/quota.js";
import { activitySchemas, allSchemas } from "@omnesis/provider-strava/src/schemas.js";
import { SyncEngine } from "../sync-engine.js";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type { ListActivitiesParams, StravaClient } from "@omnesis/provider-strava/src/client.js";
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
        // The rewalk checks its budget first; one that has heard nothing allows it.
        quota: new StravaRateLimitTracker(),
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

describe("Strava walks against the analytics store's own renderings", () => {
  // Each walk compares every activity it lists with the row the store hands
  // back: numbers as DuckDB returns them, the start as its TIMESTAMPTZ
  // rendering, a flag the listing left out as null. A difference misread there
  // would send the whole history back through enrichment, or the social tier,
  // on every daily rewalk.
  const walkSourceId = SourceId("strava-activities:43");
  const walkProviderId = ProviderId("strava:43");
  const walkAthleteId = 43;
  let harness: MultiCollectorHarness;
  let gateway: HttpGatewayClient;
  let engine: SyncEngine;
  let source: RegisteredSource;
  let commentCalls = 0;
  /** What the last listing answered with. */
  let lastListing: StravaSummaryActivity[] = [];
  /** Every page the source returned, in order. */
  const pages: StructuredSyncResult<StravaActivitiesCursor>[] = [];
  /** Noon UTC `days` ago, inside the edit sweep's month, spelled with milliseconds. */
  const daysAgo = (days: number) =>
    new Date((Math.floor(Date.now() / 86_400_000) - days) * 86_400_000 + 43_200_000).toISOString();
  const listed = (
    id: number,
    start: string,
    overrides: Partial<StravaSummaryActivity>,
  ): StravaSummaryActivity => ({
    id,
    athlete: { id: walkAthleteId },
    name: `Walked activity ${id}`,
    distance: 5000,
    moving_time: 1800,
    elapsed_time: 1850,
    total_elevation_gain: 50,
    type: "Run",
    sport_type: "Run",
    start_date: start,
    start_date_local: start.replace(/(\.000)?Z$/, ""),
    has_heartrate: false,
    trainer: false,
    commute: false,
    private: false,
    ...overrides,
  });
  let upstream: StravaSummaryActivity[] = [
    // Fractional numbers, a `Z` start without milliseconds and no `manual`.
    listed(501, daysAgo(3).replace(".000Z", "Z"), {
      distance: 5012.7,
      total_elevation_gain: 48.3,
      average_speed: 2.784,
      kudos_count: 3,
      comment_count: 1,
    }),
    listed(502, daysAgo(2), {
      manual: false,
      kudos_count: 0,
      comment_count: 0,
      achievement_count: 2,
      pr_count: 1,
    }),
  ];

  const status = () => engine.getStatuses().find((s) => s.sourceId === walkSourceId);
  const sync = async () => {
    await engine.syncSource(source);
    expect(status()?.state, status()?.lastError).toBe("idle");
  };
  /** Syncs until the cursor rests in `incremental` with nothing left to enrich. */
  const settle = async () => {
    for (let run = 0; run < 12; run++) {
      await sync();
      const last = pages.at(-1)!;
      if (last.cursor.phase === "incremental" && !last.hasMore) return;
    }
    throw new Error("The source never settled into incremental");
  };
  /** The one page a sync runs once `stamp`'s walk is due: the walk, ending where it began. */
  const walk = async (stamp: "lastSnapshotAt" | "lastEditSweepAt") => {
    const current = (await gateway.getSyncState(walkSourceId))!.cursor as StravaActivitiesCursor;
    const due = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const epoch = await gateway.beginSyncAttempt(walkSourceId);
    await gateway.upsertWithCursor({
      sourceId: walkSourceId,
      providerId: walkProviderId,
      documents: [],
      hasMore: false,
      cursor: { ...current, [stamp]: due },
      wipeEpoch: epoch,
    });
    await expect
      .poll(
        async () =>
          ((await gateway.getSyncState(walkSourceId))?.cursor as StravaActivitiesCursor)[stamp],
        { timeout: 10_000 },
      )
      .toBe(due);
    pages.length = 0;
    await sync();
    expect(pages).toHaveLength(1);
    const [page] = pages;
    expect(page!.cursor.phase).toBe("incremental");
    expect(page!.cursor[stamp]).not.toBe(due);
    // It walked both activities, so it compared both with the store.
    expect(lastListing.map((activity) => activity.id).sort()).toEqual([501, 502]);
    return page!;
  };
  const stored = async (id: number) => {
    const result = await harness.json<{ columns: string[]; rows: unknown[][] }>("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({
        sql: `SELECT kudos_count, social_fetched_at FROM strava_activities WHERE id = ${id}`,
      }),
    });
    const [kudos, socialFetchedAt] = result.rows[0]!;
    return { kudos: Number(kudos), socialFetchedAt };
  };

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    const collector = await harness.addCollector({
      name: "walk-fixture",
      hostableSourceTypes: ["strava-activities"],
    });
    gateway = new HttpGatewayClient(harness.gatewayUrl, collector.token);
    expect(
      (
        await gateway.bulkUpsertSources([
          { type: SourceType("strava-activities"), accountId: AccountId("43"), enabled: true },
        ])
      ).errors,
    ).toEqual([]);
    const started = (activity: StravaSummaryActivity) => Date.parse(activity.start_date) / 1000;
    const client = {
      // Budget to spare: one that has heard nothing allows every page.
      quota: new StravaRateLimitTracker(),
      listActivities: ({ before, after, page }: ListActivitiesParams) => {
        lastListing =
          (page ?? 1) > 1
            ? []
            : upstream.filter(
                (activity) =>
                  (before === undefined || started(activity) < before) &&
                  (after === undefined || started(activity) > after),
              );
        return Promise.resolve(lastListing);
      },
      getActivity: (id: number) =>
        Promise.resolve({
          ...upstream.find((activity) => activity.id === id)!,
          description: "Easy aerobic run",
          calories: 321,
        }),
      listActivityComments: () => {
        commentCalls += 1;
        return Promise.resolve([]);
      },
      listActivityKudos: () => Promise.resolve([]),
      getActivityZones: () => Promise.resolve([]),
      getActivityStreams: () => Promise.resolve({}),
      getAthleteDetail: () =>
        Promise.resolve({ id: walkAthleteId, firstname: "Maya", lastname: "Reeves" }),
      getAthleteZones: () => Promise.resolve({}),
      getAthleteStats: () => Promise.resolve({}),
    } as unknown as StravaClient;
    // Scoped as the collector scopes a source's analytics.
    const implementation = new StravaActivitiesSource(
      client,
      walkSourceId,
      walkProviderId,
      undefined,
      undefined,
      walkAthleteId,
      { query: (sql, opts) => gateway.queryAnalytics(sql, opts?.limit, walkSourceId) },
    );
    source = {
      id: walkSourceId,
      providerId: walkProviderId,
      name: "Fixture walks",
      family: { name: "Strava" },
      instance: {
        sync: () => Promise.resolve(emptySync()),
        analyticsSchemas: allSchemas,
        syncStructured: async (cursor) => {
          const result = await implementation.syncStructured(cursor as StravaActivitiesCursor);
          pages.push(result);
          return result;
        },
      },
    };
    engine = new SyncEngine(gateway);
    engine.registerProvider({
      id: walkProviderId,
      name: "Fixture walks",
      renewableCredential: false,
      credentialState: () => Promise.resolve({ status: "connected" as const }),
      sources: [source],
    });
    // The first import, the athlete refresh and every tier, as a new account
    // runs them.
    await settle();
  }, 60_000);

  afterAll(async () => {
    await engine?.stopSyncLoopAndDrain();
    await harness?.destroy();
  }, 20_000);

  test("unchanged upstream: the rewalk and the edit sweep write nothing", async () => {
    expect(commentCalls).toBe(2);
    for (const stamp of ["lastSnapshotAt", "lastEditSweepAt"] as const) {
      const page = await walk(stamp);
      expect(rowsFor(page, "strava_activities"), stamp).toEqual([]);
      expect(page.documents ?? [], stamp).toEqual([]);
    }
    expect(commentCalls).toBe(2);
  }, 60_000);

  test("a kudo sends its activity back to the social tier once, and the next sweep writes nothing", async () => {
    upstream = upstream.map((activity) =>
      activity.id === 501 ? { ...activity, kudos_count: 4 } : activity,
    );

    const recounted = await walk("lastEditSweepAt");
    const rows = rowsFor(recounted, "strava_activities");
    expect(rows.map((row) => [Number(row.id), row.kudos_count, row.social_fetched_at])).toEqual([
      [501, 4, null],
    ]);
    expect(rows[0]!.detail_fetched_at).toBeTruthy();
    expect(recounted.documents ?? []).toEqual([]);
    expect(await stored(501)).toEqual({ kudos: 4, socialFetchedAt: null });

    pages.length = 0;
    await settle();
    expect(commentCalls).toBe(3);
    const rendered = pages.flatMap((page) => page.documents ?? []);
    expect(rendered.map((doc) => doc.externalId)).toEqual(["501"]);
    expect(rendered[0]!.content).toContain("4 kudos");
    expect((await stored(501)).socialFetchedAt).toBeTruthy();

    const next = await walk("lastEditSweepAt");
    expect(rowsFor(next, "strava_activities")).toEqual([]);
    expect(next.documents ?? []).toEqual([]);
  }, 60_000);
});
