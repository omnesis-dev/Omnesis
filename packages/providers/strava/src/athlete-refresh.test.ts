// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { rowsFor, tablesWritten } from "@omnesis/source-sdk/testing";
import { StravaActivitiesSource } from "./activities.js";
import { StravaClient, StravaQuotaDeferral } from "./client.js";
import { syncAthleteRefresh } from "./athlete-refresh.js";
import type { SourceAnalyticsAccess } from "@omnesis/source-sdk";
import type { ProviderId, SourceId } from "@omnesis/types";
import type { FetchFn } from "./client.js";

/** A client for athlete 99 that reaches Strava through `fetchFn`. */
function clientWith(fetchFn: FetchFn): StravaClient {
  return new StravaClient({
    tokens: {
      access_token: "token",
      refresh_token: "refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      athlete_id: 99,
    },
    credentials: { client_id: "client", client_secret: "secret" },
    fetchFn,
  });
}

/** Strava's answer to each athlete-refresh path; gear is named after its id. */
function athleteAnswer(path: string): unknown {
  if (path === "/athlete") return { id: 99, summit: false };
  if (path === "/athlete/zones") return { heart_rate: { zones: [{ min: 0, max: 120 }] } };
  if (path === "/athletes/99/stats") return { all_run_totals: { count: 1 } };
  return { id: path.slice("/gear/".length), name: "trail shoe" };
}

/**
 * A Strava that meters reads the way Strava does, per UTC quarter hour and
 * per day against a new app's read limits, and reports the count on every
 * response. `usedThisWindow` is what other pages have already spent. Built
 * after the clock is set: it starts counting in the current quarter hour.
 */
function meteredStrava(usedThisWindow = 0): { client: StravaClient; paths: string[] } {
  const paths: string[] = [];
  let quarter = Math.floor(Date.now() / 900_000);
  let short = usedThisWindow;
  let daily = usedThisWindow;
  const client = clientWith((url) => {
    const path = new URL(url).pathname.replace("/api/v3", "");
    paths.push(path);
    if (Math.floor(Date.now() / 900_000) !== quarter) {
      quarter = Math.floor(Date.now() / 900_000);
      short = 0;
    }
    short += 1;
    daily += 1;
    return Promise.resolve(
      new Response(JSON.stringify(athleteAnswer(path)), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-ReadRateLimit-Limit": "100,1000",
          "X-ReadRateLimit-Usage": `${short},${daily}`,
        },
      }),
    );
  });
  return { client, paths };
}

/** An analytics store whose activities use `gearIds` and need nothing else. */
function gearCatalogue(gearIds: readonly string[]): SourceAnalyticsAccess {
  return {
    query: vi.fn((sql: string) =>
      Promise.resolve({
        columns: [],
        rows: sql.includes("DISTINCT") ? gearIds.map((gear_id) => ({ gear_id })) : [],
      }),
    ),
  };
}

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

test("a spent daily budget defers the refresh until just after midnight UTC, without calling Strava", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-03-04T22:40:00Z"));
    const analytics: SourceAnalyticsAccess = {
      query: vi.fn(() => Promise.resolve({ columns: [], rows: [] })),
    };
    const fetchFn = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })));
    const client = new StravaClient({
      tokens: {
        access_token: "token",
        refresh_token: "refresh",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        athlete_id: 99,
      },
      credentials: { client_id: "client", client_secret: "secret" },
      fetchFn,
    });
    // 950 of the day's 1,000 reads used, past enrichment's cap of 800.
    client.quota.setState(undefined, {
      used: { short: 5, daily: 950 },
      limit: { short: 100, daily: 1000 },
    });

    const refresh = syncAthleteRefresh({ phase: "athlete-refresh" }, "detail-backfill", {
      analytics,
      client,
      athleteId: 99,
    });

    await expect(refresh).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 80.5 * 60_000,
      quota: { kind: "app" },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("gear beyond one window's reads is fetched in the next window, each piece once", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-03-04T10:01:00Z"));
    const gearIds = Array.from({ length: 100 }, (_, i) => `g${1000 + i}`);
    const { client, paths } = meteredStrava();
    // A tracker that has heard Strava's limits, as it has after any earlier page.
    client.quota.setState(undefined, {
      used: { short: 0, daily: 0 },
      limit: { short: 100, daily: 1000 },
    });
    const deps = { analytics: gearCatalogue(gearIds), client, athleteId: 99 };

    const first = await syncAthleteRefresh({ phase: "athlete-refresh" }, "detail-backfill", deps);

    // Enrichment's share of the window is 80 reads: three for the profile, the
    // rest for gear. What it reached lands; the remainder waits on the cursor.
    expect(tablesWritten(first)).toEqual([
      "strava_athlete",
      "strava_athlete_zones",
      "strava_athlete_stats",
      "strava_gear",
    ]);
    expect(rowsFor(first, "strava_gear")).toHaveLength(77);
    expect(first.cursor).toMatchObject({
      phase: "athlete-refresh",
      pendingGearIds: gearIds.slice(77),
    });
    expect(first.cursor.lastAthleteRefreshAt).toBeUndefined();
    expect(first.hasMore).toBe(true);

    // Asked for at once, as a page with more is, it defers to the quarter hour
    // without calling Strava.
    await expect(syncAthleteRefresh(first.cursor, "detail-backfill", deps)).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 14.5 * 60_000,
      quota: { kind: "app" },
    });
    expect(paths).toHaveLength(80);

    vi.setSystemTime(new Date("2026-03-04T10:15:30Z"));
    const second = await syncAthleteRefresh(first.cursor, "detail-backfill", deps);

    expect(rowsFor(second, "strava_gear")).toHaveLength(23);
    expect(second.cursor.phase).toBe("detail-backfill");
    expect(second.cursor.pendingGearIds).toBeUndefined();
    expect(second.cursor.lastAthleteRefreshAt).toBeTruthy();
    // The profile once, and every gear once.
    expect(paths.filter((path) => !path.startsWith("/gear/"))).toEqual([
      "/athlete",
      "/athletes/99/stats",
      "/athlete/zones",
    ]);
    expect(paths.filter((path) => path.startsWith("/gear/"))).toEqual(
      gearIds.map((id) => `/gear/${id}`),
    );
  } finally {
    vi.useRealTimers();
  }
});

test("gear the window could not reach waits on the cursor, not for next week's refresh", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-03-04T10:01:00Z"));
    const gearIds = Array.from({ length: 20 }, (_, i) => `g${2000 + i}`);
    // Other pages have spent 75 of the window's reads; the tracker learns it
    // from the first response.
    const { client } = meteredStrava(75);

    const result = await syncAthleteRefresh({ phase: "athlete-refresh" }, "detail-backfill", {
      analytics: gearCatalogue(gearIds),
      client,
      athleteId: 99,
    });

    // The profile takes reads 76 to 78, and two gear take enrichment's share to 80.
    expect(rowsFor(result, "strava_gear")).toHaveLength(2);
    expect(result.cursor).toMatchObject({
      phase: "athlete-refresh",
      pendingGearIds: gearIds.slice(2),
    });
    expect(result.cursor.lastAthleteRefreshAt).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test("gear the token's scope cannot read is skipped, not left to hold the refresh in place", async () => {
  const gearPaths: string[] = [];
  const fetchFn = vi.fn((url: string) => {
    const path = new URL(url).pathname.replace("/api/v3", "");
    if (path === "/oauth/token") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "token-2",
            refresh_token: "refresh-2",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
          { status: 200 },
        ),
      );
    }
    // A 401 that a fresh token does not cure is a scope the grant lacks.
    if (path.startsWith("/gear/")) {
      gearPaths.push(path);
      return Promise.resolve(new Response("", { status: 401 }));
    }
    return Promise.resolve(new Response(JSON.stringify(athleteAnswer(path)), { status: 200 }));
  });

  const result = await syncAthleteRefresh({ phase: "athlete-refresh" }, "incremental", {
    analytics: gearCatalogue(["g3000", "g3001", "g3002"]),
    client: clientWith(fetchFn),
    athleteId: 99,
  });

  expect(rowsFor(result, "strava_gear")).toEqual([]);
  expect(result.cursor.phase).toBe("incremental");
  expect(result.cursor.pendingGearIds).toBeUndefined();
  expect(result.cursor.lastAthleteRefreshAt).toBeTruthy();
  // The scope is the grant's, so the first gear's refusal, asked once and once
  // more with a fresh token, stands for every gear.
  expect(gearPaths).toEqual(["/gear/g3000", "/gear/g3000"]);
});

test("a resumed refresh that reaches no gear defers rather than hand back the same cursor", async () => {
  const { client, paths } = meteredStrava();
  // The gate passes and the budget is gone by the first gear. A page that
  // returned `hasMore` with its cursor unchanged would be asked for again at
  // once, so the page defers instead, and has called nothing to lose.
  vi.spyOn(client.quota, "canMakeNCalls").mockReturnValueOnce(true).mockReturnValue(false);

  const refresh = syncAthleteRefresh(
    { phase: "athlete-refresh", pendingGearIds: ["g4000"] },
    "incremental",
    { analytics: gearCatalogue([]), client, athleteId: 99 },
  );

  await expect(refresh).rejects.toBeInstanceOf(StravaQuotaDeferral);
  expect(paths).toEqual([]);
});

describe("where a finished refresh hands over", () => {
  const recent = () => new Date(Date.now() - 60_000).toISOString();

  function sourceFor(client: StravaClient): StravaActivitiesSource {
    return new StravaActivitiesSource(
      client,
      "strava-activities:99" as SourceId,
      "strava:99" as ProviderId,
      undefined,
      undefined,
      99,
      gearCatalogue([]),
    );
  }

  test("the weekly refresh goes back to incremental, not through every enrichment tier", async () => {
    const lastWeek = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const { client, paths } = meteredStrava();

    const result = await sourceFor(client).syncStructured({
      phase: "incremental",
      lastActivityTimestamp: 1_772_000_000,
      lastSnapshotAt: recent(),
      lastEditSweepAt: recent(),
      lastAthleteRefreshAt: lastWeek,
    });

    expect(paths).toContain("/athlete");
    expect(result.cursor.phase).toBe("incremental");
    expect(result.cursor.lastAthleteRefreshAt).not.toBe(lastWeek);
  });

  test("the first refresh after a backfill chains into enrichment", async () => {
    const { client } = meteredStrava();

    const result = await sourceFor(client).syncStructured({
      phase: "athlete-refresh",
      lastActivityTimestamp: 1_772_000_000,
      lastSnapshotAt: recent(),
      lastEditSweepAt: recent(),
    });

    expect(result.cursor.phase).toBe("detail-backfill");
    expect(result.cursor.lastAthleteRefreshAt).toBeTruthy();
  });
});
