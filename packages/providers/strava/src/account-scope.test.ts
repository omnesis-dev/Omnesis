// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  tableWrites,
  validateAnalyticsOwnership,
  type SourceAnalyticsAccess,
} from "@omnesis/source-sdk";
import { rowsFor, deletionsFor } from "@omnesis/source-sdk/testing";
import { allSchemas, activitySchemas } from "./schemas.js";
import { StravaActivitiesSource } from "./activities.js";
import { StravaClient } from "./client.js";
import type { StravaActivitiesCursor } from "./types.js";

/** Activity 7001 is athlete 201's, 7002 athlete 202's. */
const ACTIVITY_OWNERS = new Map([
  [7001, 201],
  [7002, 202],
]);

/** Cadence stamps that leave neither walk due, so each page is its own phase's. */
const WALKED = {
  lastSnapshotAt: new Date().toISOString(),
  lastEditSweepAt: new Date().toISOString(),
};

/**
 * A page of each phase that picks activities to act on from the shared table,
 * from a cursor that sends it there. The walks' reads of the stored rows are
 * left out: they read by the ids of this athlete's own listing, which no
 * sibling account's row can carry.
 */
const READING_PAGES: StravaActivitiesCursor[] = [
  { phase: "detail-backfill", ...WALKED },
  { phase: "detail-backfill", pendingDetailStamps: ["7001"], ...WALKED },
  { phase: "social-backfill", pendingSocialStamps: ["7001"], ...WALKED },
  { phase: "zones-backfill", ...WALKED },
  { phase: "streams-backfill", ...WALKED },
  { phase: "enrich-pending", ...WALKED },
  { phase: "athlete-refresh", ...WALKED },
];

/**
 * The shared activity table as the gateway serves it to one account's source.
 * The read handle checks which tables a query names, not which rows it
 * returns, so both accounts' rows come back unless the query narrows them to
 * one athlete itself. Every row reads as pending whatever the tier, and carries
 * its athlete's gear and a Summit-only zones refusal, so every reader has a row
 * of each account to find. The child tables read as empty.
 */
function sharedActivityTable(queries: string[] = []): SourceAnalyticsAccess {
  const stored = [...ACTIVITY_OWNERS].map(([id, athlete]) => ({
    id,
    athlete_id: athlete,
    name: "Fixture run",
    sport_type: "Run",
    activity_type: "Run",
    start_time: "2026-01-01T10:00:00Z",
    distance_m: 1000,
    moving_time_seconds: 300,
    elapsed_time_seconds: 310,
    gear_id: `g${athlete}`,
    zones_unavailable: true,
  }));
  return {
    query: (sql) => {
      queries.push(sql);
      if (!/\bFROM strava_activities\b/.test(sql))
        return Promise.resolve({ columns: [], rows: [] });
      const athlete = /\bathlete_id = (\d+)\b/.exec(sql)?.[1];
      const rows =
        athlete === undefined ? stored : stored.filter((row) => String(row.athlete_id) === athlete);
      return Promise.resolve(
        /count\(\*\)/i.test(sql)
          ? { columns: ["n"], rows: [{ n: rows.length }] }
          : { columns: [], rows },
      );
    },
  };
}

/**
 * An account's source, reaching a Strava that shows it every activity, its
 * own or not, as it would a public one. Each URL it asks for lands in `calls`.
 */
function sourceFor(
  athlete: number,
  analytics: SourceAnalyticsAccess,
  calls: string[] = [],
): StravaActivitiesSource {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const client = new StravaClient({
    tokens: {
      access_token: "fixture",
      refresh_token: "fixture",
      expires_at: 4_000_000_000,
      athlete_id: athlete,
    },
    credentials: { client_id: "fixture", client_secret: "fixture" },
    fetchFn: (url) => {
      calls.push(url);
      const { pathname } = new URL(url);
      const activity = /\/activities\/(\d+)/.exec(pathname);
      if (activity) {
        const id = Number(activity[1]);
        if (pathname.endsWith("/comments"))
          return json([
            {
              id: id + 1000,
              activity_id: id,
              text: "Great effort",
              created_at: "2026-01-01T11:00:00Z",
              athlete: { id: 303, firstname: "Maya" },
            },
          ]);
        if (pathname.endsWith("/kudos")) return json([{ id: 304, firstname: "Jamie" }]);
        if (pathname.endsWith("/zones")) return json([]);
        if (pathname.endsWith("/streams"))
          return json({
            time: {
              type: "time",
              data: [0, 1],
              series_type: "time",
              original_size: 2,
              resolution: "high",
            },
          });
        return json({
          id,
          athlete: { id: ACTIVITY_OWNERS.get(id) },
          name: "Fixture run",
          sport_type: "Run",
          start_date: "2026-01-01T10:00:00Z",
          start_date_local: "2026-01-01T10:00:00",
          distance: 1000,
          moving_time: 300,
          elapsed_time: 310,
          total_elevation_gain: 5,
          splits_metric: [{ split: 1, distance: 1000, elapsed_time: 300, moving_time: 300 }],
        });
      }
      const gear = /\/gear\/(\w+)$/.exec(pathname);
      if (gear)
        return json({
          id: gear[1],
          name: "Fixture shoes",
          brand_name: "Stellar",
          model_name: "Trail",
        });
      if (pathname.endsWith("/athlete"))
        return json({ id: athlete, firstname: "Maya", lastname: "Reeves", summit: true });
      // The athlete's zones and stats, which a refresh does without.
      return json({}, pathname.endsWith("/athlete/zones") ? 403 : 404);
    },
  });
  return new StravaActivitiesSource(
    client,
    SourceId(`strava-activities:${athlete}`),
    ProviderId(`strava:${athlete}`),
    undefined,
    undefined,
    athlete,
    analytics,
  );
}

describe("Strava account ownership", () => {
  test("detail, zones and streams stamp every remaining activity child table", async () => {
    const activity = {
      id: 7001,
      athlete: { id: 201 },
      name: "Fixture run",
      sport_type: "Run",
      type: "Run",
      start_date: "2026-01-01T10:00:00Z",
      start_date_local: "2026-01-01T10:00:00",
      distance: 1000,
      moving_time: 300,
      elapsed_time: 310,
      total_elevation_gain: 5,
      splits_metric: [{ split: 1, distance: 1000, elapsed_time: 300, moving_time: 300 }],
      best_efforts: [
        {
          id: 9001,
          activity: { id: 7001 },
          name: "1K",
          distance: 1000,
          elapsed_time: 300,
          moving_time: 300,
        },
      ],
      laps: [
        { id: 9002, activity: { id: 7001 }, name: "Lap 1", start_date: "2026-01-01T10:00:00Z" },
      ],
      segment_efforts: [
        {
          id: 9003,
          activity: { id: 7001 },
          segment: { id: 8001, name: "Fixture hill", activity_type: "Run", distance: 500 },
        },
      ],
    };
    const client = new StravaClient({
      tokens: {
        access_token: "fixture",
        refresh_token: "fixture",
        expires_at: 4_000_000_000,
        athlete_id: 201,
      },
      credentials: { client_id: "fixture", client_secret: "fixture" },
      fetchFn: async (url) =>
        new Response(
          JSON.stringify(
            url.includes("/zones")
              ? [{ type: "heartrate", distribution_buckets: [{ min: 0, max: 120, time: 300 }] }]
              : url.includes("/streams")
                ? {
                    time: {
                      type: "time",
                      data: [0, 1],
                      series_type: "time",
                      original_size: 2,
                      resolution: "high",
                    },
                  }
                : activity,
          ),
          { status: 200 },
        ),
    });
    const analytics: SourceAnalyticsAccess = {
      query: async (sql) =>
        /count\(\*\)/i.test(sql)
          ? { columns: ["n"], rows: [{ n: 1 }] }
          : {
              columns: ["id"],
              rows: [
                {
                  id: 7001,
                  athlete_id: 201,
                  name: "Fixture run",
                  start_time: "2026-01-01T10:00:00Z",
                },
              ],
            },
    };
    const source = new StravaActivitiesSource(
      client,
      SourceId("strava-activities:201"),
      ProviderId("strava:201"),
      undefined,
      undefined,
      201,
      analytics,
    );
    const seen = new Set<string>();
    for (const phase of ["detail-backfill", "zones-backfill", "streams-backfill"] as const) {
      const cursor: StravaActivitiesCursor = { phase, ...WALKED };
      const page = await source.syncStructured(cursor);
      expect(cursor).toEqual({ phase, ...WALKED });
      for (const write of tableWrites(page.analytics)) {
        // A clear names activities, not rows, so it carries no owner.
        if (write.tableName === "strava_activities" || write.records === undefined) continue;
        expect(write.records).toHaveLength(1);
        expect(write.records![0]).toMatchObject({ source_athlete_id: 201, activity_id: 7001 });
        seen.add(write.tableName);
      }
    }
    expect([...seen].sort()).toEqual(
      ["splits", "best_efforts", "laps", "segment_efforts", "zones", "streams"]
        .map((name) => `strava_activity_${name}`)
        .sort(),
    );
  });

  test("all thirteen tables declare owners, and all eight children have parent ownership proofs", () => {
    expect(allSchemas).toHaveLength(13);
    expect(() => validateAnalyticsOwnership(allSchemas, "Strava")).not.toThrow();
    expect(allSchemas.every((schema) => schema.sharedDiscriminatorColumn)).toBe(true);
    const children = activitySchemas.slice(1);
    expect(children).toHaveLength(8);
    for (const schema of children) {
      expect(schema.sharedDiscriminatorColumn).toBe("source_athlete_id");
      expect(schema.sharedDiscriminatorParent).toEqual({
        table: "strava_activities",
        column: "activity_id",
        parentColumn: "id",
      });
      expect(schema.columns.filter((column) => column.name === "source_athlete_id")).toEqual([
        expect.objectContaining({ type: "BIGINT", nullable: true }),
      ]);
    }
    expect(
      allSchemas.find((schema) => schema.tableName === "strava_athlete")?.sharedDiscriminatorColumn,
    ).toBe("id");
  });

  test("two accounts each enrich their own activity and stamp its children with their own owner", async () => {
    const analytics = sharedActivityTable();
    await Promise.all(
      [...ACTIVITY_OWNERS].map(async ([activity, owner]) => {
        const page = await sourceFor(owner, analytics).syncStructured({
          phase: "social-backfill",
          ...WALKED,
        });
        // The owner is the account's; the actors stay who commented and gave kudos.
        expect(rowsFor(page, "strava_activity_comments")).toEqual([
          expect.objectContaining({
            activity_id: activity,
            athlete_id: 303,
            source_athlete_id: owner,
          }),
        ]);
        expect(rowsFor(page, "strava_activity_kudos")).toEqual([
          expect.objectContaining({
            activity_id: activity,
            athlete_id: 304,
            source_athlete_id: owner,
          }),
        ]);
        expect(deletionsFor(page, "strava_activity_comments")).toEqual([String(activity)]);
        expect(deletionsFor(page, "strava_activity_kudos")).toEqual([String(activity)]);
        expect(tableWrites(page.analytics).filter((write) => write.deletedKeys)).toHaveLength(2);
        expect(page.cursor.pendingSocialStamps).toEqual([String(activity)]);
      }),
    );
  });

  test("every enrichment and refresh read of the shared activity and gear tables names the owning athlete", async () => {
    const queries: string[] = [];
    const source = sourceFor(201, sharedActivityTable(queries));
    for (const cursor of READING_PAGES) await source.syncStructured(cursor);
    const reads = queries.filter((sql) => /\bFROM strava_(activities|gear)\b/.test(sql));
    // Every reader ran: the tiers' selections, the rotation's counts, the
    // carried marks, the refresh's gear, Summit and resolved-gear reads, and
    // the tiers' reads of the gear catalogue.
    for (const reader of [
      "FROM strava_gear",
      "ORDER BY start_time DESC",
      "count(*)",
      " id IN (",
      " id NOT IN (",
      "DISTINCT gear_id",
      "zones_unavailable = TRUE LIMIT",
      "gear_id IN (",
    ])
      expect(
        reads.some((sql) => sql.includes(reader)),
        reader,
      ).toBe(true);
    for (const sql of reads) expect(sql).toMatch(/\bathlete_id = 201\b/);
  });

  test("an account never fetches or writes a sibling account's activity", async () => {
    const calls: string[] = [];
    const source = sourceFor(201, sharedActivityTable(), calls);
    for (const cursor of READING_PAGES) {
      const page = await source.syncStructured(cursor);
      for (const write of tableWrites(page.analytics)) {
        // The gateway refuses a row of the shared table under another
        // athlete, and a refused page replays on every retry after it.
        if (write.tableName === "strava_activities")
          for (const row of write.records ?? []) expect(row.athlete_id).toBe(201);
        for (const row of [...(write.records ?? []), ...(write.deletedKeys ?? [])])
          expect(String(row.activity_id)).not.toBe("7002");
      }
      expect((page.documents ?? []).map((doc) => doc.externalId)).not.toContain("7002");
    }
    expect(calls.filter((url) => /\/activities\/7002\b|\/gear\/g202\b/.test(url))).toEqual([]);
    // Its own activity and gear it does enrich.
    expect(calls.filter((url) => /\/activities\/7001\b|\/gear\/g201\b/.test(url))).not.toEqual([]);
  });
});
