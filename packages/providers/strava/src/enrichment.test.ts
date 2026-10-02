// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { deletionsFor, rowsFor, tablesWritten } from "@omnesis/source-sdk/testing";
import { tableWrites, type PageTableWrites } from "@omnesis/source-sdk";
import { StravaActivitiesSource } from "./activities.js";
import { StravaClient, StravaForbiddenError, StravaRateLimitError } from "./client.js";
import {
  syncDetailBackfill,
  syncSocialBackfill,
  syncZonesBackfill,
  syncStreamsBackfill,
  syncEnrichPending,
} from "./enrichment.js";
import type { SourceAnalyticsAccess } from "@omnesis/source-sdk";
import type { ProviderId, SourceId } from "@omnesis/types";
import type {
  StravaActivitiesCursor,
  StravaDetailedActivity,
  StravaActivityZone,
  StravaStreamSet,
  StravaComment,
  StravaSummaryAthlete,
} from "./types.js";

const PROVIDER_ID = "strava:99" as ProviderId;
const SOURCE_ID = "strava-activities:99" as SourceId;

// ── Test doubles ─────────────────────────────────────────────────

function makeMockGateway(rows: Record<string, unknown>[]): { gateway: SourceAnalyticsAccess } {
  // The whole facet, not a partial mock behind a cast: one method.
  const gateway: SourceAnalyticsAccess = {
    query: vi.fn((sql: string) => {
      if (/count\(\*\)/i.test(sql)) {
        return Promise.resolve({ columns: ["n"], rows: [{ n: rows.length }] });
      }
      return Promise.resolve({ columns: ["id"], rows });
    }),
  };
  return { gateway };
}

function makeFetchedClient(scenarios: Record<string, unknown>): StravaClient {
  // Minimal client built around an injected fetch that returns canned JSON
  // keyed by URL substring.
  const fetchFn = vi.fn(async (url: string) => {
    for (const [key, body] of Object.entries(scenarios)) {
      if (url.includes(key)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("", { status: 404 });
  });
  return new StravaClient({
    tokens: {
      access_token: "tok",
      refresh_token: "rtok",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      athlete_id: 99,
    },
    credentials: { client_id: "x", client_secret: "y" },
    fetchFn,
  });
}

/**
 * What one child table holds once the host has applied a page, starting from
 * `stored`: the page's writes in the order given, and within each write the
 * rows first and the deletions after them, as the gateway's table manager
 * applies them. Rows are matched on `activity_id`, the delete key of every
 * child table, and appended rather than upserted — each write here replaces
 * whole activities, so nothing is left for a key to collide with.
 */
function storedAfter(
  page: { analytics?: PageTableWrites },
  tableName: string,
  stored: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  let rows = [...stored];
  for (const write of tableWrites(page.analytics)) {
    if (write.tableName !== tableName) continue;
    rows.push(...(write.records ?? []));
    const deleted = new Set((write.deletedKeys ?? []).map((key) => String(key.activity_id)));
    rows = rows.filter((row) => !deleted.has(String(row.activity_id)));
  }
  return rows;
}

const baseRow = {
  id: 12345,
  athlete_id: 99,
  name: "Morning Run",
  sport_type: "Run",
  activity_type: "Run",
  distance_m: 21530,
  moving_time_seconds: 6635,
  elapsed_time_seconds: 6640,
  total_elevation_gain_m: 131,
  start_time: "2026-05-03T09:31:00Z",
  start_time_local: "2026-05-03T10:31:00Z",
  has_heartrate: true,
};

// ── Tier 1 — detail-backfill ─────────────────────────────────────

describe("syncDetailBackfill", () => {
  test("transitions to social-backfill when no rows are pending", async () => {
    const { gateway } = makeMockGateway([]);
    const client = makeFetchedClient({});
    const cur: StravaActivitiesCursor = { phase: "detail-backfill" };
    const { result } = await syncDetailBackfill(cur, {
      analytics: gateway,
      client,
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      athleteId: 99,
    });
    expect(result.cursor.phase).toBe("social-backfill");
    expect(rowsFor(result, "strava_activities")).toEqual([]);
  });

  test("fetches detail + emits child rows + updates summary stamp", async () => {
    const { gateway } = makeMockGateway([baseRow]);
    const detail: StravaDetailedActivity = {
      id: 12345,
      athlete: { id: 99 },
      name: "Morning Run",
      distance: 21530,
      moving_time: 6635,
      elapsed_time: 6640,
      total_elevation_gain: 131,
      sport_type: "Run",
      start_date: "2026-05-03T09:31:00Z",
      start_date_local: "2026-05-03T10:31:00Z",
      description: "Felt great today.",
      calories: 1482,
      device_name: "Apple Watch Ultra 2",
      perceived_exertion: 6,
      splits_metric: [{ split: 1, distance: 1000, elapsed_time: 310, moving_time: 310 }],
      best_efforts: [
        {
          id: 50,
          activity: { id: 12345 },
          name: "5K",
          distance: 5000,
          elapsed_time: 1325,
          moving_time: 1325,
          pr_rank: 1,
        },
      ],
      laps: [],
      segment_efforts: [],
    };
    const client = makeFetchedClient({ "/activities/12345": detail });
    const cur: StravaActivitiesCursor = { phase: "detail-backfill" };
    const { result } = await syncDetailBackfill(cur, {
      analytics: gateway,
      client,
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      athleteId: 99,
    });
    expect(result.cursor.phase).toBe("detail-backfill");
    expect(rowsFor(result, "strava_activities")).toHaveLength(1);
    expect((rowsFor(result, "strava_activities")[0] as Record<string, unknown>).description).toBe(
      "Felt great today.",
    );
    expect(
      (rowsFor(result, "strava_activities")[0] as Record<string, unknown>).detail_fetched_at,
    ).toBeNull();
    expect(result.cursor.pendingDetailStamps).toEqual(["12345"]);
    expect(tablesWritten(result).at(-1)).toBe("strava_activities");
    expect(rowsFor(result, "strava_activity_splits")).toHaveLength(1);
    expect(rowsFor(result, "strava_activity_best_efforts")).toHaveLength(1);
    for (const table of [
      "strava_activity_splits",
      "strava_activity_best_efforts",
      "strava_activity_laps",
      "strava_activity_segment_efforts",
    ]) {
      // A complete response replaces the activity's group even when it holds
      // no rows for this table, so the clear is there either way.
      expect(deletionsFor(result, table), table).toEqual(["12345"]);
    }
    expect(rowsFor(result, "strava_activity_laps")).toEqual([]);
    expect(result.documents).toHaveLength(1);
    expect(result.documents![0]!.content).toContain("Felt great today.");
    const { result: stamped } = await syncDetailBackfill(result.cursor as StravaActivitiesCursor, {
      analytics: gateway,
      client,
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      athleteId: 99,
    });
    expect(rowsFor(stamped, "strava_activities")[0].detail_fetched_at).toBeTruthy();
    expect(stamped.cursor.pendingDetailStamps).toBeUndefined();
  });

  test("the child rows a detail page writes are what the host holds once it applies the page", async () => {
    const { gateway } = makeMockGateway([baseRow]);
    const detail: StravaDetailedActivity = {
      id: 12345,
      athlete: { id: 99 },
      name: "Morning Run",
      distance: 2000,
      moving_time: 620,
      elapsed_time: 640,
      total_elevation_gain: 12,
      sport_type: "Run",
      start_date: "2026-05-03T09:31:00Z",
      start_date_local: "2026-05-03T10:31:00Z",
      splits_metric: [
        { split: 1, distance: 1000, elapsed_time: 310, moving_time: 305 },
        { split: 2, distance: 1000, elapsed_time: 330, moving_time: 315 },
      ],
      best_efforts: [
        {
          id: 51,
          activity: { id: 12345 },
          name: "1K",
          distance: 1000,
          elapsed_time: 300,
          moving_time: 300,
        },
      ],
      laps: [
        {
          id: 61,
          activity: { id: 12345 },
          name: "Lap 1",
          distance: 2000,
          elapsed_time: 640,
          moving_time: 620,
          start_date: "2026-05-03T09:31:00Z",
          start_date_local: "2026-05-03T10:31:00Z",
          start_index: 0,
          end_index: 640,
        },
      ],
      segment_efforts: [
        {
          id: 71,
          activity: { id: 12345 },
          name: "Segment 7",
          distance: 1200,
          elapsed_time: 380,
          moving_time: 375,
          start_date: "2026-05-03T09:35:00Z",
          start_date_local: "2026-05-03T10:35:00Z",
          start_index: 120,
          end_index: 500,
          segment: { id: 81, name: "Segment 7", activity_type: "Run", distance: 1200 },
        },
      ],
    };
    const { result } = await syncDetailBackfill(
      { phase: "detail-backfill" },
      {
        analytics: gateway,
        client: makeFetchedClient({ "/activities/12345": detail }),
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );

    // Rows from an earlier read of this activity are replaced, and another
    // activity's rows are left alone.
    const earlier = { activity_id: 12345, unit: "metric", split_index: 3 };
    const otherActivity = { activity_id: 777, unit: "metric", split_index: 1 };
    expect(storedAfter(result, "strava_activity_splits", [earlier, otherActivity])).toEqual([
      otherActivity,
      ...rowsFor(result, "strava_activity_splits"),
    ]);
    for (const table of [
      "strava_activity_splits",
      "strava_activity_best_efforts",
      "strava_activity_laps",
      "strava_activity_segment_efforts",
    ]) {
      expect(rowsFor(result, table), table).not.toEqual([]);
      expect(storedAfter(result, table), table).toEqual(rowsFor(result, table));
    }
  });

  test("an activity Strava would not show keeps the child rows it already has", async () => {
    const { gateway } = makeMockGateway([baseRow]);
    const { result } = await syncDetailBackfill(
      { phase: "detail-backfill" },
      {
        analytics: gateway,
        client: makeFetchedClient({}),
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );

    // Marked done so it is not asked for again, but nothing was read that
    // could replace its rows.
    expect(rowsFor(result, "strava_activities")[0]?.detail_fetched_at).toBeTruthy();
    const stored = [{ activity_id: 12345, unit: "metric", split_index: 1 }];
    expect(storedAfter(result, "strava_activity_splits", stored)).toEqual(stored);
  });

  test("pending detail stamps flush before tier selection and never recreate removed activities", async () => {
    const { gateway } = makeMockGateway([]);
    const { result } = await syncEnrichPending(
      { phase: "enrich-pending", pendingDetailStamps: ["12345"] },
      {
        analytics: gateway,
        client: makeFetchedClient({}),
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    expect(rowsFor(result, "strava_activities")).toEqual([]);
    expect(result.cursor.pendingDetailStamps).toBeUndefined();
    expect(result.cursor.phase).toBe("enrich-pending");
    expect(gateway.query).toHaveBeenCalledTimes(1);
  });
});

// ── Tier 2 — social-backfill ─────────────────────────────────────

describe("syncSocialBackfill", () => {
  test("transitions to zones-backfill when no rows pending", async () => {
    const { gateway } = makeMockGateway([]);
    const client = makeFetchedClient({});
    const cur: StravaActivitiesCursor = { phase: "social-backfill" };
    const { result } = await syncSocialBackfill(cur, {
      analytics: gateway,
      client,
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      athleteId: 99,
    });
    expect(result.cursor.phase).toBe("zones-backfill");
  });

  test("ingests comments + kudos and stamps social_fetched_at", async () => {
    const { gateway } = makeMockGateway([baseRow]);
    const comments: StravaComment[] = [
      {
        id: 1,
        activity_id: 12345,
        text: "Nice work",
        created_at: "2026-05-03T10:00:00Z",
        athlete: { firstname: "Sarah" },
      },
    ];
    const kudos: StravaSummaryAthlete[] = [{ firstname: "Bob" }, { firstname: "Carol" }];
    const client = makeFetchedClient({
      "/activities/12345/comments": comments,
      "/activities/12345/kudos": kudos,
    });
    const { result } = await syncSocialBackfill(
      { phase: "social-backfill" },
      {
        analytics: gateway,
        client,
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    // The mark is not on this page: it belongs to the activities this page
    // enriched, and their documents have not been written yet.
    expect(rowsFor(result, "strava_activities")).toHaveLength(0);
    expect((result.cursor as { pendingSocialStamps?: string[] }).pendingSocialStamps).toEqual([
      "12345",
    ]);
    expect(rowsFor(result, "strava_activity_comments")).toHaveLength(1);
    expect(rowsFor(result, "strava_activity_kudos")).toHaveLength(2);
    // The kudoers of a re-fetched activity replace its stored list rather than
    // merging with it, so a lost kudoer cannot linger past the current tail.
    expect(deletionsFor(result, "strava_activity_kudos")).toEqual(["12345"]);
    // Comments are re-read in full too, so the stored set is replaced for the
    // same activities. Merging would keep a comment its author deleted.
    expect(deletionsFor(result, "strava_activity_comments")).toEqual(["12345"]);
    expect(
      tableWrites(result.analytics).map((write) => [
        write.tableName,
        write.deletedKeys ? "delete" : "upsert",
      ]),
    ).toEqual([
      ["strava_activity_comments", "delete"],
      ["strava_activity_comments", "upsert"],
      ["strava_activity_kudos", "delete"],
      ["strava_activity_kudos", "upsert"],
    ]);
    expect(result.documents![0]!.content).toContain("Nice work");
  });

  test("the mark that says an activity is done is written after its document, not beside it", async () => {
    // A page's writes share a cursor, not a transaction: the host writes every
    // analytics table, then the documents and the cursor together. So a mark
    // written beside the enrichment it describes can outlive it — the mark
    // lands, the process dies, the document never stores, and the retry filter
    // skips that activity forever because it looks finished.
    const { gateway } = makeMockGateway([baseRow]);
    const client = makeFetchedClient({
      "/activities/12345/comments": [],
      "/activities/12345/kudos": [{ firstname: "Bob" }] as StravaSummaryAthlete[],
    });
    const deps = {
      analytics: gateway,
      client,
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      athleteId: 99,
    };

    const first = await syncSocialBackfill({ phase: "social-backfill" }, deps);
    // Nothing on this page says the activity is finished with.
    expect(rowsFor(first.result, "strava_activities")).toHaveLength(0);
    expect(first.result.documents).toHaveLength(1);
    const carried = (first.result.cursor as { pendingSocialStamps?: string[] }).pendingSocialStamps;
    expect(carried).toEqual(["12345"]);

    // The next page carries the mark, by which time the document above has
    // been committed alongside the cursor that named it.
    const second = await syncSocialBackfill(
      first.result.cursor as Parameters<typeof syncSocialBackfill>[0],
      deps,
    );
    const marked = rowsFor(second.result, "strava_activities") as Record<string, unknown>[];
    expect(marked.map((r) => String(r.id))).toEqual(["12345"]);
    expect(marked[0]!.social_fetched_at).toBeTruthy();
    // The mock answers every query with the same rows, so it cannot show the
    // second page's selection excluding the carried id — that exclusion is in
    // the SQL. What it does show is the ordering this test exists for: the
    // mark appears only once the document it describes has been handed over.
  });

  test("404 stamps social_fetched_at on the same page, so the activity is not fetched again", async () => {
    // Deleted or made private upstream: nothing about it is written on this
    // page, so there is nothing for the mark to outrun. Unmarked, it would be
    // pending on every page and the phase could never finish.
    const { gateway } = makeMockGateway([baseRow]);
    const client = makeFetchedClient({}); // every URL returns 404
    const { result } = await syncSocialBackfill(
      { phase: "social-backfill" },
      { analytics: gateway, client, sourceId: SOURCE_ID, providerId: PROVIDER_ID, athleteId: 99 },
    );

    const marked = rowsFor(result, "strava_activities") as Record<string, unknown>[];
    expect(marked.map((r) => String(r.id))).toEqual(["12345"]);
    expect(marked[0]!.social_fetched_at).toBeTruthy();
    expect(result.documents).toHaveLength(0);
    expect(result.cursor.pendingSocialStamps).toBeUndefined();
  });
});

// ── Tier 3 — zones-backfill ──────────────────────────────────────

describe("syncZonesBackfill", () => {
  test("transitions to streams-backfill when nothing pending", async () => {
    const { gateway } = makeMockGateway([]);
    const client = makeFetchedClient({});
    const cur: StravaActivitiesCursor = { phase: "zones-backfill" };
    const { result } = await syncZonesBackfill(cur, {
      analytics: gateway,
      client,
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      athleteId: 99,
    });
    expect(result.cursor.phase).toBe("streams-backfill");
  });

  test("403 marks zones_unavailable=true and stamps timestamp", async () => {
    const { gateway } = makeMockGateway([baseRow]);
    // Custom client that throws 403 on /zones
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("/zones")) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response("{}", { status: 200 });
    });
    const client = new StravaClient({
      tokens: {
        access_token: "tok",
        refresh_token: "rtok",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        athlete_id: 99,
      },
      credentials: { client_id: "x", client_secret: "y" },
      fetchFn,
    });
    const { result } = await syncZonesBackfill(
      { phase: "zones-backfill" },
      {
        analytics: gateway,
        client,
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    expect(
      (rowsFor(result, "strava_activities")[0] as Record<string, unknown>).zones_unavailable,
    ).toBe(true);
    expect(
      (rowsFor(result, "strava_activities")[0] as Record<string, unknown>).zones_fetched_at,
    ).toBeTruthy();
    // No zone bucket rows written.
    expect(tablesWritten(result)).not.toContain("strava_activity_zones");
  });

  test("402 (premium-gated zones) marks zones_unavailable=true instead of aborting", async () => {
    const { gateway } = makeMockGateway([baseRow]);
    // An activity's /zones returns 402 Payment Required when the athlete's
    // plan doesn't include zones — must downgrade gracefully, same as 403.
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("/zones")) {
        return new Response('{"message":"Payment Required"}', { status: 402 });
      }
      return new Response("{}", { status: 200 });
    });
    const client = new StravaClient({
      tokens: {
        access_token: "tok",
        refresh_token: "rtok",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        athlete_id: 99,
      },
      credentials: { client_id: "x", client_secret: "y" },
      fetchFn,
    });
    const { result } = await syncZonesBackfill(
      { phase: "zones-backfill" },
      {
        analytics: gateway,
        client,
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    expect(
      (rowsFor(result, "strava_activities")[0] as Record<string, unknown>).zones_unavailable,
    ).toBe(true);
    expect(
      (rowsFor(result, "strava_activities")[0] as Record<string, unknown>).zones_fetched_at,
    ).toBeTruthy();
    expect(tablesWritten(result)).not.toContain("strava_activity_zones");
  });

  test("happy path emits per-bucket rows", async () => {
    const { gateway } = makeMockGateway([baseRow]);
    const zones: StravaActivityZone[] = [
      {
        type: "heartrate",
        distribution_buckets: [
          { min: 0, max: 120, time: 600 },
          { min: 120, max: 140, time: 1200 },
        ],
      },
    ];
    const client = makeFetchedClient({ "/activities/12345/zones": zones });
    const { result } = await syncZonesBackfill(
      { phase: "zones-backfill" },
      {
        analytics: gateway,
        client,
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    expect(rowsFor(result, "strava_activity_zones")).toHaveLength(2);
    expect(deletionsFor(result, "strava_activity_zones")).toEqual(["12345"]);
    // The buckets just written are what the host holds once the page lands;
    // the activity's earlier buckets are gone.
    const earlier = { activity_id: 12345, zone_type: "heartrate", bucket_index: 4 };
    expect(storedAfter(result, "strava_activity_zones", [earlier])).toEqual(
      rowsFor(result, "strava_activity_zones"),
    );
    expect(tablesWritten(result)).toEqual([
      "strava_activity_zones",
      "strava_activity_zones",
      "strava_activities",
    ]);
  });

  test("a complete empty zones response replaces the old activity group", async () => {
    const { gateway } = makeMockGateway([baseRow]);
    const { result } = await syncZonesBackfill(
      { phase: "zones-backfill" },
      {
        analytics: gateway,
        client: makeFetchedClient({ "/activities/12345/zones": [] }),
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    expect(rowsFor(result, "strava_activity_zones")).toEqual([]);
    expect(deletionsFor(result, "strava_activity_zones")).toEqual(["12345"]);
    expect(tablesWritten(result)).toEqual(["strava_activity_zones", "strava_activities"]);
    const earlier = { activity_id: 12345, zone_type: "heartrate", bucket_index: 0 };
    expect(storedAfter(result, "strava_activity_zones", [earlier])).toEqual([]);
  });
});

// ── Tier 5 — streams-backfill ────────────────────────────────────

describe("syncStreamsBackfill", () => {
  test("transitions to incremental when nothing pending", async () => {
    const { gateway } = makeMockGateway([]);
    const client = makeFetchedClient({});
    const { result } = await syncStreamsBackfill(
      { phase: "streams-backfill" },
      {
        analytics: gateway,
        client,
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    expect(result.cursor.phase).toBe("incremental");
  });

  test("emits one row per activity with JSON blob", async () => {
    const { gateway } = makeMockGateway([baseRow]);
    const set: StravaStreamSet = {
      time: {
        type: "time",
        data: [0, 1, 2],
        series_type: "time",
        original_size: 3,
        resolution: "high",
      },
      heartrate: {
        type: "heartrate",
        data: [120, 125, 130],
        series_type: "time",
        resolution: "high",
      },
    };
    const client = makeFetchedClient({ "/activities/12345/streams": set });
    const { result } = await syncStreamsBackfill(
      { phase: "streams-backfill" },
      {
        analytics: gateway,
        client,
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    const streamRows = rowsFor(result, "strava_activity_streams");
    expect(tablesWritten(result)).toEqual(["strava_activity_streams", "strava_activities"]);
    expect(streamRows).toHaveLength(1);
    const row = streamRows[0] as Record<string, unknown>;
    expect(JSON.parse(row.streams_json as string).heartrate.data).toEqual([120, 125, 130]);
  });

  test("404 stamps timestamp and skips inserting a stream row", async () => {
    const { gateway } = makeMockGateway([baseRow]);
    const client = makeFetchedClient({}); // every URL returns 404
    const { result } = await syncStreamsBackfill(
      { phase: "streams-backfill" },
      {
        analytics: gateway,
        client,
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    expect(
      (rowsFor(result, "strava_activities")[0] as Record<string, unknown>).streams_fetched_at,
    ).toBeTruthy();
    expect(tablesWritten(result)).not.toContain("strava_activity_streams");
  });

  // Ensure StravaForbiddenError is exported for test consumers — used in
  // the 402/403 zones paths above. Anchor here so a future rename triggers a
  // compile error in this file.
  test("StravaForbiddenError carries status and is throwable", () => {
    expect(() => {
      throw new StravaForbiddenError("/x");
    }).toThrow(/Strava access denied \(403\)/);
    expect(new StravaForbiddenError("/x", 402).status).toBe(402);
  });
});

// ── Quota deferral — every tier ──────────────────────────────────

// A page the window cannot cover throws `quotaDeferral` rather than returning
// `hasMore` (see its JSDoc). These pin that for every tier, and for
// enrich-pending in front of them.
describe("a page the rate-limit window cannot cover", () => {
  // Seven and a half minutes before the quarter hour resets the short window.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T10:07:30Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** One activity pending in every tier, and a short window already spent. */
  function spentWindow(): { gateway: SourceAnalyticsAccess; client: StravaClient } {
    const { gateway } = makeMockGateway([baseRow]);
    const client = makeFetchedClient({});
    client.quota.setState(undefined, {
      used: { short: 95, daily: 100 },
      limit: { short: 100, daily: 1000 },
    });
    return { gateway, client };
  }

  const quarterHourDeferral = {
    kind: "rate-limit",
    // To the quarter hour, plus the 30 seconds that let Strava's reset land first.
    retryAfterMs: 8 * 60_000,
    quota: { kind: "app" },
  };

  test.each([
    ["detail-backfill", syncDetailBackfill],
    ["social-backfill", syncSocialBackfill],
    ["zones-backfill", syncZonesBackfill],
    ["streams-backfill", syncStreamsBackfill],
  ] as const)("%s defers the tick past the next quarter hour", async (phase, syncPhase) => {
    const { gateway, client } = spentWindow();

    const page = syncPhase(
      { phase },
      { analytics: gateway, client, sourceId: SOURCE_ID, providerId: PROVIDER_ID, athleteId: 99 },
    );

    await expect(page).rejects.toBeInstanceOf(StravaRateLimitError);
    await expect(page).rejects.toMatchObject(quarterHourDeferral);
  });

  test("the source defers from enrich-pending too, rather than rotating to the next tier", async () => {
    const { gateway, client } = spentWindow();
    const source = new StravaActivitiesSource(
      client,
      SOURCE_ID,
      PROVIDER_ID,
      undefined,
      undefined,
      99,
      gateway,
    );

    await expect(source.syncStructured({ phase: "enrich-pending" })).rejects.toMatchObject(
      quarterHourDeferral,
    );
  });
});

describe("StravaClient — 401 distinguishes auth-failure from missing scope", async () => {
  const { StravaScopeError, StravaAuthError } = await import("./client.js");
  const tokenRefreshResp = {
    access_token: "new",
    refresh_token: "new-rt",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    token_type: "Bearer",
  };

  test("401 → refresh succeeds → still 401 throws StravaScopeError, not StravaAuthError", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("/oauth/token")) {
        return new Response(JSON.stringify(tokenRefreshResp), { status: 200 });
      }
      calls++;
      // Both attempts return 401.
      return new Response("unauthorized", { status: 401 });
    });
    const client = new StravaClient({
      tokens: {
        access_token: "old",
        refresh_token: "old-rt",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        athlete_id: 99,
      },
      credentials: { client_id: "x", client_secret: "y" },
      fetchFn,
    });
    await expect(client.getAthleteZones()).rejects.toBeInstanceOf(StravaScopeError);
    expect(calls).toBe(2);
    expect(StravaAuthError).toBeDefined(); // sanity
  });
});
