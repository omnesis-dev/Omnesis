// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { rowsFor, tablesWritten } from "@omnesis/source-sdk/testing";
import { StravaClient } from "./client.js";
import { syncAthleteRefresh } from "./athlete-refresh.js";
import type { SourceAnalyticsAccess } from "@omnesis/source-sdk";

test("athlete refresh composes Summit recovery with gear edits on the same activity", async () => {
  const original = {
    id: 123,
    gear_id: "b1",
    zones_unavailable: true,
    zones_fetched_at: "2026-01-01",
    gear_brand: null,
    gear_model: null,
    gear_name: null,
  };
  const analytics: SourceAnalyticsAccess = {
    query: vi.fn(async (sql) => ({
      columns: [],
      rows: sql.includes("count(*)")
        ? [{ n: 1 }]
        : sql.includes("DISTINCT")
          ? [{ gear_id: "b1" }]
          : [original],
    })),
  };
  const responses: Record<string, unknown> = {
    "/athlete": { id: 99, summit: true },
    "/athlete/zones": { heart_rate: { zones: [{ min: 0, max: 120 }] } },
    "/athletes/99/stats": { all_run_totals: { count: 1 } },
    "/gear/b1": { id: "b1", brand_name: "Northstar", model_name: "Road", name: "Blue bike" },
  };
  const client = new StravaClient({
    tokens: {
      access_token: "token",
      refresh_token: "refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      athlete_id: 99,
    },
    credentials: { client_id: "client", client_secret: "secret" },
    fetchFn: vi.fn(
      async (url: string) =>
        new Response(JSON.stringify(responses[new URL(url).pathname.replace("/api/v3", "")]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  });
  const result = await syncAthleteRefresh({ phase: "athlete-refresh" }, "detail-backfill", {
    analytics,
    client,
    athleteId: 99,
  });
  expect(tablesWritten(result)).toEqual([
    "strava_athlete",
    "strava_athlete_zones",
    "strava_athlete_stats",
    "strava_gear",
    "strava_activities",
  ]);
  expect(rowsFor(result, "strava_activities")).toEqual([
    {
      ...original,
      zones_unavailable: false,
      zones_fetched_at: null,
      gear_brand: "Northstar",
      gear_model: "Road",
      gear_name: "Blue bike",
    },
  ]);
  expect(result.cursor.phase).toBe("detail-backfill");
  expect(result.cursor.lastAthleteRefreshAt).toBeTruthy();
});
