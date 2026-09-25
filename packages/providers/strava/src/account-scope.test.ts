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
      const cursor: StravaActivitiesCursor = { phase };
      const page = await source.syncStructured(cursor);
      expect(cursor).toEqual({ phase });
      for (const write of tableWrites(page.analytics)) {
        if (write.tableName === "strava_activities") continue;
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

  test("two accounts stamp child owners without replacing comment or kudos actors or deletion keys", async () => {
    const analytics: SourceAnalyticsAccess = {
      query: async (sql) =>
        /count\(\*\)/i.test(sql)
          ? { columns: ["n"], rows: [{ n: 1 }] }
          : { columns: ["id"], rows: [{ id: 7001 }] },
    };
    const pages = await Promise.all(
      [201, 202].map(async (owner) => {
        const client = new StravaClient({
          tokens: {
            access_token: "fixture",
            refresh_token: "fixture",
            expires_at: 4_000_000_000,
            athlete_id: owner,
          },
          credentials: { client_id: "fixture", client_secret: "fixture" },
          fetchFn: async (url) =>
            new Response(
              JSON.stringify(
                url.includes("/comments")
                  ? [
                      {
                        id: 8101,
                        activity_id: 7001,
                        text: "Great effort",
                        created_at: "2026-01-01T10:00:00Z",
                        athlete: { id: 303, firstname: "Maya" },
                      },
                    ]
                  : [{ id: 304, firstname: "Jamie" }],
              ),
              { status: 200 },
            ),
        });
        const source = new StravaActivitiesSource(
          client,
          SourceId(`strava-activities:${owner}`),
          ProviderId(`strava:${owner}`),
          undefined,
          undefined,
          owner,
          analytics,
        );
        const page = await source.syncStructured({ phase: "social-backfill" });
        expect(rowsFor(page, "strava_activity_comments")[0]).toMatchObject({
          athlete_id: 303,
          source_athlete_id: owner,
        });
        expect(rowsFor(page, "strava_activity_kudos")[0]).toMatchObject({
          athlete_id: 304,
          source_athlete_id: owner,
        });
        expect(deletionsFor(page, "strava_activity_comments")).toEqual(["7001"]);
        expect(deletionsFor(page, "strava_activity_kudos")).toEqual(["7001"]);
        expect(tableWrites(page.analytics).filter((write) => write.deletedKeys)).toHaveLength(2);
        expect(page.cursor.pendingSocialStamps).toEqual(["7001"]);
        return page;
      }),
    );
    expect(rowsFor(pages[0]!, "strava_activity_comments")[0]?.source_athlete_id).toBe(201);
    expect(rowsFor(pages[1]!, "strava_activity_comments")[0]?.source_athlete_id).toBe(202);
  });
});
