// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { deletionsFor, rowsFor, tablesWritten } from "@omnesis/source-sdk/testing";
import { tableWrites, type PageTableWrites } from "@omnesis/source-sdk";
import { StravaActivitiesSource } from "./activities.js";
import {
  StravaClient,
  StravaForbiddenError,
  StravaQuotaDeferral,
  StravaRateLimitError,
} from "./client.js";
import {
  syncDetailBackfill,
  syncSocialBackfill,
  syncZonesBackfill,
  syncStreamsBackfill,
  syncEnrichPending,
} from "./enrichment.js";
import { activityToDocument, activityToRecord } from "./normalizer.js";
import { computeSummaryHash } from "./normalizer-detail.js";
import type { SourceAnalyticsAccess } from "@omnesis/source-sdk";
import type { ProviderId, SourceId } from "@omnesis/types";
import type { QuotaPair } from "./quota.js";
import type {
  StravaActivitiesCursor,
  StravaDetailedActivity,
  StravaActivityZone,
  StravaStreamSet,
  StravaComment,
  StravaSummaryActivity,
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

function makeFetchedClient(scenarios: Record<string, unknown>, seen: string[] = []): StravaClient {
  // Minimal client built around an injected fetch that returns canned JSON
  // keyed by URL substring. Every URL it is asked for lands in `seen`.
  const fetchFn = vi.fn(async (url: string) => {
    seen.push(url);
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

  test("the ids a cursor carries reach its reads as numerals only", async () => {
    // The cursor is stored state, not SQL this file wrote, so a carried id is
    // coerced to the integer Strava assigned rather than spliced in as given.
    const { gateway } = makeMockGateway([baseRow]);
    await syncSocialBackfill(
      { phase: "social-backfill", pendingSocialStamps: ["12345", "12345') OR ('1' = '1"] },
      {
        analytics: gateway,
        client: makeFetchedClient({}),
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    const lists = vi
      .mocked(gateway.query)
      .mock.calls.flatMap(([sql]) => [...sql.matchAll(/\bIN \(([^)]*)\)/g)].map((m) => m[1]));
    // The carried marks, the selection that leaves them out, and the stored
    // best efforts of the activity it selects.
    expect(lists).toEqual(["12345", "12345", "12345"]);
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

// A page the window cannot cover throws a `StravaQuotaDeferral` before its
// first call rather than returning `hasMore` (see `quotaDeferral`). These pin
// that for every tier. The activities source lists new activities in its place
// (see the next describe), and parks only when not even the listing fits.
describe("a page the rate-limit window cannot cover", () => {
  // Seven and a half minutes before the quarter hour resets the short window.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T10:07:30Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * One activity pending in every tier, and a short window already spent.
   * `seen` is every URL the client asked Strava for.
   */
  function spentWindow(): { gateway: SourceAnalyticsAccess; client: StravaClient; seen: string[] } {
    const { gateway } = makeMockGateway([baseRow]);
    const seen: string[] = [];
    const client = makeFetchedClient({}, seen);
    client.quota.setState(undefined, {
      used: { short: 95, daily: 100 },
      limit: { short: 100, daily: 1000 },
    });
    return { gateway, client, seen };
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
    const { gateway, client, seen } = spentWindow();

    const page = syncPhase(
      { phase },
      { analytics: gateway, client, sourceId: SOURCE_ID, providerId: PROVIDER_ID, athleteId: 99 },
    );

    await expect(page).rejects.toBeInstanceOf(StravaQuotaDeferral);
    await expect(page).rejects.toMatchObject(quarterHourDeferral);
    // Refused before its first call, which is what lets the source list in its place.
    expect(seen).toEqual([]);
  });

  test("a source in enrich-pending parks for one listing call when not even the listing fits", async () => {
    const { gateway, client, seen } = spentWindow();
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
    expect(seen).toEqual([]);
  });
});

// ── The listing a refused page falls back on ─────────────────────

describe("a page the budget refuses gives way to listing new activities", () => {
  // Seven and a half minutes before the quarter hour resets the short window.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-04T10:07:30Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** An activity the listing finds upstream. */
  function listed(id: number, startDate: string): StravaSummaryActivity {
    return {
      id,
      athlete: { id: 99 },
      name: `Ride ${id}`,
      distance: 30_000,
      moving_time: 3_600,
      elapsed_time: 3_700,
      total_elevation_gain: 210,
      sport_type: "Ride",
      start_date: startDate,
      start_date_local: startDate.replace("Z", ""),
    };
  }

  const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  /** The listing's high-water mark in the cursors below: before every listed activity. */
  const HIGH_WATER = unix("2026-03-03T08:00:00Z");
  const RIDE = listed(23456, "2026-03-04T09:00:00Z");

  /**
   * 850 of the day's 1,000 reads used: none left under enrichment's cap of
   * 800, and 50 under the listing's 900.
   */
  const pastEnrichmentsShare: QuotaPair = { short: 5, daily: 850 };

  /**
   * A source with `pending` activities waiting in every enrichment tier, whose
   * client has already spent `used` of a new app's reads. The listing answers
   * with `listings`, a page per call. A path `throttled` names is refused with
   * a 429 that reports the day's reads spent.
   */
  function starvedSource(
    pending: number,
    used: QuotaPair,
    listings: StravaSummaryActivity[][] = [[RIDE]],
    throttled: (path: string) => boolean = () => false,
  ): {
    source: StravaActivitiesSource;
    gateway: SourceAnalyticsAccess;
    urls: URL[];
    paths: () => string[];
  } {
    const rows = Array.from({ length: pending }, (_, i) => ({ ...baseRow, id: 12345 + i }));
    const { gateway } = makeMockGateway(rows);
    const urls: URL[] = [];
    const client = new StravaClient({
      tokens: {
        access_token: "tok",
        refresh_token: "rtok",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        athlete_id: 99,
      },
      credentials: { client_id: "x", client_secret: "y" },
      fetchFn: vi.fn((url: string) => {
        urls.push(new URL(url));
        if (throttled(new URL(url).pathname.replace("/api/v3", ""))) {
          return Promise.resolve(
            new Response("", {
              status: 429,
              headers: {
                "X-ReadRateLimit-Limit": "100,1000",
                "X-ReadRateLimit-Usage": "100,1000",
              },
            }),
          );
        }
        const body = url.includes("/athlete/activities") ? (listings.shift() ?? []) : {};
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    });
    client.quota.setState(undefined, { used, limit: { short: 100, daily: 1000 } });
    const source = new StravaActivitiesSource(
      client,
      SOURCE_ID,
      PROVIDER_ID,
      undefined,
      undefined,
      99,
      gateway,
    );
    const paths = () => urls.map((url) => url.pathname.replace("/api/v3", ""));
    return { source, gateway, urls, paths };
  }

  /** An `incremental` cursor with nothing time-gated due. */
  const settled = (): StravaActivitiesCursor => ({
    phase: "incremental",
    lastActivityTimestamp: HIGH_WATER,
    lastSnapshotAt: new Date().toISOString(),
    lastEditSweepAt: new Date().toISOString(),
    lastAthleteRefreshAt: new Date().toISOString(),
  });

  test.each([
    "enrich-pending",
    "detail-backfill",
    "social-backfill",
    "zones-backfill",
    "streams-backfill",
    "athlete-refresh",
  ] as const)(
    "%s: a refused page lists new activities instead, and keeps its place",
    async (phase) => {
      const { source, paths } = starvedSource(3, pastEnrichmentsShare);

      const result = await source.syncStructured({
        phase,
        enrichTier: "social",
        pendingSocialStamps: ["12345"],
        pendingGearIds: ["g5001"],
        lastActivityTimestamp: HIGH_WATER,
      });

      // Only the listing reached Strava, and only what it found was written.
      expect(paths()).toEqual(["/athlete/activities"]);
      expect(tablesWritten(result)).toEqual(["strava_activities"]);
      expect(rowsFor(result, "strava_activities").map((row) => row.id)).toEqual([23456]);
      expect(result.documents).toHaveLength(1);
      expect(result.hasMore).toBe(false);
      // The refused work resumes where it stopped: same phase, same tier, the
      // same marks and gear still waiting.
      expect(result.cursor).toMatchObject({
        phase,
        enrichTier: "social",
        pendingSocialStamps: ["12345"],
        pendingGearIds: ["g5001"],
        lastActivityTimestamp: unix(RIDE.start_date),
      });
    },
  );

  test("a 429 inside an enrichment page ends the tick rather than giving way to the listing", async () => {
    // Budget to spare on record, but Strava refuses the detail call: its
    // verdict, which the listing would meet too, and it came after the page
    // began, so it is not the gate's refusal the listing stands in for.
    const { source, paths } = starvedSource(3, { short: 0, daily: 0 }, [[RIDE]], (path) =>
      path.startsWith("/activities/"),
    );

    const sync = source.syncStructured({ ...settled(), phase: "detail-backfill" });

    await expect(sync).rejects.toBeInstanceOf(StravaRateLimitError);
    await expect(sync).rejects.not.toBeInstanceOf(StravaQuotaDeferral);
    // The day is spent: until UTC midnight, and the 30 seconds after it.
    await expect(sync).rejects.toMatchObject({ kind: "rate-limit", retryAfterMs: 833 * 60_000 });
    expect(paths()).toContain("/activities/12345");
    expect(paths()).not.toContain("/athlete/activities");
  });

  test("a due rewalk that enrichment's share cannot cover lists new activities instead", async () => {
    // The walk costs one read per hundred activities, so its cost grows with
    // the history: drawn from the listing's reads, it would spend them.
    const { source, urls } = starvedSource(3, pastEnrichmentsShare);
    const due = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    const result = await source.syncStructured({ ...settled(), lastSnapshotAt: due });

    expect(urls.map((url) => url.searchParams.has("before"))).toEqual([false]);
    expect(rowsFor(result, "strava_activities").map((row) => row.id)).toEqual([23456]);
    // Still due, so the next sync tries it again.
    expect(result.cursor).toMatchObject({ phase: "incremental", lastSnapshotAt: due });
  });

  test("a refused rewalk page lists new activities and keeps the walk's place", async () => {
    const { source, urls } = starvedSource(3, pastEnrichmentsShare);

    const result = await source.syncStructured({
      phase: "snapshot-rewalk",
      resumePhase: "detail-backfill",
      snapshotBefore: unix("2026-03-04T06:00:00Z"),
      snapshotPage: 5,
      snapshotIds: ["1", "2"],
      lastActivityTimestamp: HIGH_WATER,
    });

    expect(urls.map((url) => url.searchParams.has("before"))).toEqual([false]);
    expect(rowsFor(result, "strava_activities").map((row) => row.id)).toEqual([23456]);
    expect(result.presentExternalIds).toBeUndefined();
    // The listing's activity started after the walk's `before`, so no page of
    // the walk names it: the walk names it here, or its snapshot would leave
    // it out.
    expect(result.cursor).toMatchObject({
      phase: "snapshot-rewalk",
      resumePhase: "detail-backfill",
      snapshotPage: 5,
      snapshotIds: ["1", "2", "23456"],
      lastActivityTimestamp: unix(RIDE.start_date),
    });
  });

  test("a refused edit sweep page lists new activities and keeps the sweep's place", async () => {
    const { source, urls } = starvedSource(3, pastEnrichmentsShare);
    const sweptFrom = unix("2026-02-02T10:00:00Z");

    const result = await source.syncStructured({
      phase: "edit-sweep",
      editSweepAfter: sweptFrom,
      editSweepPage: 2,
      lastActivityTimestamp: HIGH_WATER,
    });

    expect(urls.map((url) => Number(url.searchParams.get("after")))).toEqual([HIGH_WATER]);
    expect(result.cursor).toMatchObject({
      phase: "edit-sweep",
      editSweepAfter: sweptFrom,
      editSweepPage: 2,
    });
  });

  test("a due walk the budget refuses holds back neither the backlog's place nor the listing", async () => {
    const { source, paths } = starvedSource(3, pastEnrichmentsShare);
    const due = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    const result = await source.syncStructured({
      phase: "detail-backfill",
      lastActivityTimestamp: HIGH_WATER,
      lastSnapshotAt: due,
      lastEditSweepAt: due,
    });

    expect(paths()).toEqual(["/athlete/activities"]);
    expect(rowsFor(result, "strava_activities").map((row) => row.id)).toEqual([23456]);
    expect(result.cursor).toMatchObject({
      phase: "detail-backfill",
      lastSnapshotAt: due,
      lastEditSweepAt: due,
    });
    expect(result.cursor.resumePhase).toBeUndefined();
  });

  test("due walks interrupt a backlog once each, then hand it back: they cannot spin", async () => {
    // A backlog that never drains: every page finds the same activities
    // pending. With the budget to spare, the rewalk and the sweep each run
    // once and stamp their cadence, and every page after them is the backlog's.
    const { source, urls, paths } = starvedSource(3, { short: 0, daily: 0 }, [[RIDE], []]);

    let cursor: StravaActivitiesCursor = {
      phase: "detail-backfill",
      lastActivityTimestamp: HIGH_WATER,
    };
    const phases: string[] = [];
    for (let page = 0; page < 8; page++) {
      cursor = (await source.syncStructured(cursor)).cursor;
      phases.push(cursor.phase);
    }

    const listings = urls.filter((url) => url.pathname.endsWith("/athlete/activities"));
    expect(listings.map((url) => url.searchParams.has("before"))).toEqual([true, false]);
    expect(phases).toEqual(Array(8).fill("detail-backfill"));
    expect(cursor.lastSnapshotAt).toBeDefined();
    expect(cursor.lastEditSweepAt).toBeDefined();
    // Three detail pages, each followed by its marks.
    expect(paths().filter((path) => path === "/activities/12345")).toHaveLength(3);
  });

  test("the steady-state chain lists once when its enrichment is refused", async () => {
    const { source, paths } = starvedSource(3, pastEnrichmentsShare);

    const result = await source.syncStructured(settled());

    expect(paths()).toEqual(["/athlete/activities"]);
    expect(rowsFor(result, "strava_activities").map((row) => row.id)).toEqual([23456]);
    expect(result.cursor.phase).toBe("incremental");
  });

  test("a due athlete refresh the budget cannot cover gives way to the listing", async () => {
    const { source, paths } = starvedSource(0, pastEnrichmentsShare);

    const result = await source.syncStructured({ ...settled(), lastAthleteRefreshAt: undefined });

    expect(paths()).toEqual(["/athlete/activities"]);
    expect(rowsFor(result, "strava_activities").map((row) => row.id)).toEqual([23456]);
    expect(result.cursor.phase).toBe("incremental");
    // Still due, so the next sync tries it again.
    expect(result.cursor.lastAthleteRefreshAt).toBeUndefined();
  });

  test("a listing before the first refresh leaves the gear catalogue unread", async () => {
    // The refresh creates the catalogue, so there is none to read yet, and the
    // gateway logs a read of a table the source has not created as a refused
    // grant. The detail tier names the gear once the refresh has run.
    const { source, gateway } = starvedSource(0, pastEnrichmentsShare, [
      [{ ...RIDE, gear_id: "b5001" }],
    ]);

    const result = await source.syncStructured({ ...settled(), lastAthleteRefreshAt: undefined });

    expect(rowsFor(result, "strava_activities").map((row) => row.id)).toEqual([23456]);
    const reads = vi.mocked(gateway.query).mock.calls.map(([sql]) => sql);
    expect(reads.filter((sql) => sql.includes("strava_gear"))).toEqual([]);
  });

  test("when not even a listing fits, the source waits for one call, not for a page", async () => {
    // The short window is spent and two of the day's reads are left under the
    // listing's cap: too few for a page of three, which would wait until
    // midnight, but a listing fits once the quarter hour resets the window.
    const { source, urls } = starvedSource(3, { short: 95, daily: 898 });

    const sync = source.syncStructured({
      phase: "enrich-pending",
      lastActivityTimestamp: HIGH_WATER,
    });

    await expect(sync).rejects.toBeInstanceOf(StravaQuotaDeferral);
    await expect(sync).rejects.toMatchObject({ kind: "rate-limit", retryAfterMs: 8 * 60_000 });
    expect(urls).toEqual([]);
  });

  test("with nothing to enrich and no budget, the listing waits instead of calling", async () => {
    const { source, urls } = starvedSource(0, { short: 95, daily: 100 });

    await expect(source.syncStructured(settled())).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 8 * 60_000,
    });
    expect(urls).toEqual([]);
  });

  test("a refused page cannot spin: the detour pages forward and stops", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      listed(30000 + i, new Date(Date.parse("2026-03-03T09:00:00Z") + i * 60_000).toISOString()),
    );
    const { source, urls, paths } = starvedSource(3, pastEnrichmentsShare, [fullPage, [RIDE]]);

    let cursor: StravaActivitiesCursor = {
      phase: "enrich-pending",
      lastActivityTimestamp: HIGH_WATER,
    };
    let pages = 0;
    for (let more = true; more && pages < 5; pages++) {
      const result = await source.syncStructured(cursor);
      cursor = result.cursor;
      more = result.hasMore ?? false;
    }

    expect(pages).toBe(2);
    expect(paths()).toEqual(["/athlete/activities", "/athlete/activities"]);
    const [first, second] = urls.map((url) => Number(url.searchParams.get("after")));
    expect(second).toBeGreaterThan(first!);
    expect(cursor.phase).toBe("enrich-pending");
    expect(cursor.lastActivityTimestamp).toBe(unix(RIDE.start_date));
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

// ── Every tier keeps the others' part of the document ────────────

describe("a tier re-rendering an activity's document", () => {
  /**
   * An analytics handle that answers by table: `activities` for
   * `strava_activities`, and `children` for the child tables a tier reads to
   * render the parts it did not fetch. A child table without rows here does
   * not exist yet, as before any page has written to it.
   */
  function storedGateway(
    activities: Record<string, unknown>[],
    children: Record<string, Record<string, unknown>[]> = {},
  ): SourceAnalyticsAccess {
    return {
      query: vi.fn((sql: string) => {
        if (/count\(\*\)/i.test(sql)) {
          return Promise.resolve({ columns: ["n"], rows: [{ n: activities.length }] });
        }
        const table = /FROM (\w+)/i.exec(sql)?.[1];
        if (table === undefined || table === "strava_activities") {
          return Promise.resolve({ columns: ["id"], rows: activities });
        }
        const rows = children[table];
        if (rows === undefined) {
          return Promise.reject(new Error(`Table with name ${table} does not exist!`));
        }
        return Promise.resolve({ columns: [], rows });
      }),
    };
  }

  const detailed = {
    ...baseRow,
    description: "Tempo along the river path.",
    calories: 640,
    device_name: "Example Watch 3",
    photo_primary_url: "https://example.com/photos/finish.jpg",
    photo_caption: "Finish line",
    detail_fetched_at: "2026-05-04T08:00:00Z",
  };

  test("a social page keeps the description and top results a detail page stored", async () => {
    const analytics = storedGateway([detailed], {
      strava_activity_best_efforts: [
        {
          id: 51,
          activity_id: 12345,
          name: "1K",
          distance_m: 1000,
          elapsed_time_seconds: 290,
          moving_time_seconds: 290,
          pr_rank: 1,
        },
      ],
    });
    const client = makeFetchedClient({
      "/activities/12345/comments": [
        {
          id: 1,
          activity_id: 12345,
          text: "Strong finish!",
          created_at: "2026-05-03T11:00:00Z",
          athlete: { firstname: "Maya", lastname: "Reeves" },
        },
      ],
      "/activities/12345/kudos": [{ firstname: "Jamie", lastname: "Lopez" }],
    });
    const { result } = await syncSocialBackfill(
      { phase: "social-backfill" },
      { analytics, client, sourceId: SOURCE_ID, providerId: PROVIDER_ID, athleteId: 99 },
    );

    const [doc] = result.documents!;
    expect(doc!.content).toContain("Tempo along the river path.");
    expect(doc!.content).toContain("1K: 4m 50s (PR)");
    expect(doc!.content).toContain("Finish line");
    expect(doc!.content).toContain("Strong finish!");
    expect(doc!.metadata.extra).toMatchObject({
      description: "Tempo along the river path.",
      calories: 640,
      deviceName: "Example Watch 3",
      photoUrls: ["https://example.com/photos/finish.jpg"],
    });
  });

  test("a detail page keeps the comments and kudoers a social page stored", async () => {
    const analytics = storedGateway([baseRow], {
      strava_activity_comments: [
        {
          id: 1,
          activity_id: 12345,
          athlete_id: 501,
          athlete_firstname: "Maya",
          athlete_lastname: "Reeves",
          text: "Strong finish!",
          created_at: "2026-05-03T11:00:00Z",
        },
      ],
      strava_activity_kudos: [
        { activity_id: 12345, position: 1, athlete_id: 502, firstname: "Jamie", lastname: "Lopez" },
      ],
    });
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
    };
    const { result } = await syncDetailBackfill(
      { phase: "detail-backfill" },
      {
        analytics,
        client: makeFetchedClient({ "/activities/12345": detail }),
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );

    const [doc] = result.documents!;
    expect(doc!.content).toContain("Felt great today.");
    expect(doc!.content).toContain("Strong finish!");
    expect(doc!.content).toContain("Kudos from: Jamie Lopez");
    expect(doc!.metadata.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "participant", name: "Maya Reeves" }),
        expect.objectContaining({ role: "mentioned", name: "Jamie Lopez" }),
      ]),
    );
  });

  test("a detail page renders before any social page has created its tables", async () => {
    const { result } = await syncDetailBackfill(
      { phase: "detail-backfill" },
      {
        analytics: storedGateway([baseRow]),
        client: makeFetchedClient({
          "/activities/12345": { ...baseRow, athlete: { id: 99 }, description: "Easy spin." },
        }),
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    expect(result.documents![0]!.content).toContain("Easy spin.");
  });

  test("a detail page keeps the marks the other tiers left, and stores the photo caption", async () => {
    const marks = {
      social_fetched_at: "2026-05-04T08:00:00Z",
      zones_fetched_at: "2026-05-04T08:05:00Z",
      zones_unavailable: true,
      streams_fetched_at: "2026-05-04T08:10:00Z",
    };
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
      photos: { primary: { urls: { "600": "https://example.com/p.jpg" }, caption: "Summit" } },
    };
    const { result } = await syncDetailBackfill(
      { phase: "detail-backfill" },
      {
        analytics: storedGateway([{ ...baseRow, ...marks }]),
        client: makeFetchedClient({ "/activities/12345": detail }),
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
    expect(rowsFor(result, "strava_activities")[0]).toMatchObject({
      ...marks,
      detail_fetched_at: null,
      photo_caption: "Summit",
    });
  });

  /** The listing's summary of the activity, and the row a listing page stores for it. */
  const listed: StravaSummaryActivity = {
    id: 12345,
    athlete: { id: 99 },
    name: "Morning Run",
    distance: 10400,
    moving_time: 3300,
    elapsed_time: 3340,
    total_elevation_gain: 40,
    type: "Run",
    sport_type: "Run",
    start_date: "2026-05-03T09:31:00Z",
    start_date_local: "2026-05-03T10:31:00Z",
    kudos_count: 0,
    comment_count: 0,
    pr_count: 0,
    achievement_count: 0,
  };
  const listedRow = (summary: StravaSummaryActivity = listed) =>
    activityToRecord(summary, { summaryHash: computeSummaryHash(summary) });
  const detailOf = (overrides: Partial<StravaDetailedActivity> = {}): StravaDetailedActivity => ({
    ...listed,
    ...overrides,
  });
  const detailPage = (analytics: SourceAnalyticsAccess, detail: StravaDetailedActivity) =>
    syncDetailBackfill(
      { phase: "detail-backfill" },
      {
        analytics,
        client: makeFetchedClient({ "/activities/12345": detail }),
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );
  const catalogued = {
    id: "g77",
    athlete_id: 99,
    name: "Trail shoe",
    nickname: null,
    brand_name: "Northstar",
    model_name: "T2",
  };

  test("a detail page leaves what the walks compare to the listing, its counters among it", async () => {
    // Uploaded, listed straight away, then congratulated and cropped before
    // the detail was fetched. The crop, like a rename, is the edit sweep's:
    // the sweep compares the row with each listing, so a row that took the
    // detail's distance would read as edited once the crop was undone, or
    // never match where the two responses spell one value differently. The
    // counters are a walk's too: one that finds them moved sends the activity
    // back for the comments and kudoers behind them, and a row that took the
    // detail's would leave it nothing to find.
    const { result } = await detailPage(
      storedGateway([listedRow()]),
      detailOf({
        distance: 10000,
        moving_time: 3200,
        elapsed_time: 3240,
        kudos_count: 6,
        comment_count: 2,
        pr_count: 1,
        achievement_count: 3,
        // Spelled by the detail where the listing left it out.
        workout_type: 0,
      }),
    );

    expect(rowsFor(result, "strava_activities")[0]).toMatchObject({
      distance_m: 10400,
      moving_time_seconds: 3300,
      elapsed_time_seconds: 3340,
      kudos_count: 0,
      comment_count: 0,
      pr_count: 0,
      achievement_count: 0,
      workout_type: null,
      summary_hash: computeSummaryHash(listed),
    });
    const [doc] = result.documents!;
    expect(doc!.content).toContain("**Distance:** 10.40 km");
    expect(doc!.content).not.toContain("kudos");
    expect(doc!.metadata.extra).toMatchObject({ kudosCount: 0, commentCount: 0, prCount: 0 });
    // And its start reads as the listing's document reads it.
    const fromListing = activityToDocument(listed, PROVIDER_ID, SOURCE_ID);
    const started = (content: string) => /\*\*Started:\*\* .*/.exec(content)?.[0];
    expect(started(doc!.content)).toBe("**Started:** 2026-05-03 10:31:00");
    expect(started(doc!.content)).toBe(started(fromListing.content));
  });

  test("a detail page names gear the catalogue has yet to reach by the name the detail gives it", async () => {
    const { result } = await detailPage(
      storedGateway([listedRow({ ...listed, gear_id: "b123" })]),
      detailOf({ gear_id: "b123", gear: { id: "b123", name: "Gravel bike" } }),
    );

    const [doc] = result.documents!;
    expect(doc!.content).toContain("**Gear:** Gravel bike");
    expect(doc!.content).not.toContain("**Gear ID:**");
    expect(doc!.metadata.extra?.gearName).toBe("Gravel bike");
    expect(rowsFor(result, "strava_activities")[0]).toMatchObject({
      gear_id: "b123",
      gear_name: "Gravel bike",
    });
  });

  test("a detail page names catalogued gear as the refresh names it", async () => {
    const { result } = await detailPage(
      storedGateway([listedRow({ ...listed, gear_id: "g77" })], { strava_gear: [catalogued] }),
      detailOf({ gear_id: "g77", gear: { id: "g77", name: "Trail shoe" } }),
    );

    expect(result.documents![0]!.content).toContain("**Gear:** Northstar T2");
    expect(rowsFor(result, "strava_activities")[0]).toMatchObject({
      gear_brand: "Northstar",
      gear_model: "T2",
      gear_name: "Trail shoe",
    });
  });

  test("a social page names catalogued gear and keeps Strava's counters", async () => {
    const analytics = storedGateway(
      [listedRow({ ...listed, gear_id: "g77", kudos_count: 3, comment_count: 2 })],
      { strava_gear: [catalogued] },
    );
    const client = makeFetchedClient({
      "/activities/12345/comments": [
        {
          id: 1,
          activity_id: 12345,
          text: "Strong finish!",
          created_at: "2026-05-03T11:00:00Z",
          athlete: { firstname: "Maya", lastname: "Reeves" },
        },
        {
          id: 2,
          activity_id: 12345,
          text: "Nice pace",
          created_at: "2026-05-03T11:05:00Z",
          athlete: { firstname: "David", lastname: "Lin" },
        },
      ],
      "/activities/12345/kudos": [{ firstname: "Jamie", lastname: "Lopez" }],
    });
    const { result } = await syncSocialBackfill(
      { phase: "social-backfill" },
      { analytics, client, sourceId: SOURCE_ID, providerId: PROVIDER_ID, athleteId: 99 },
    );

    const [doc] = result.documents!;
    expect(doc!.content).toContain("**Gear:** Northstar T2");
    expect(doc!.content).toContain("**Comments (2):**");
    // The counters are the row's, Strava's own: the edit sweep and the rewalk
    // compare them with each listing and send the activity back here when one
    // moves, so a count taken from the lists would read as moved on every
    // sweep wherever Strava counts what it does not list.
    expect(doc!.content).toContain("_3 kudos · 2 comments_");
    expect(doc!.metadata.extra).toMatchObject({ kudosCount: 3, commentCount: 2 });
    // Nothing for the row on this page: its mark is the next page's.
    expect(rowsFor(result, "strava_activities")).toEqual([]);
    expect(result.cursor.pendingSocialStamps).toEqual(["12345"]);
  });

  test("a social page keeps Strava's counter for a list cut off at the page limit", async () => {
    // The walk stops after five full pages, so it has not seen every kudoer,
    // and the number it holds is not the activity's count.
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      firstname: "Jamie",
      lastname: `Lopez ${i}`,
    }));
    const { result } = await syncSocialBackfill(
      { phase: "social-backfill" },
      {
        analytics: storedGateway([listedRow({ ...listed, kudos_count: 1200 })]),
        client: makeFetchedClient({
          "/activities/12345/comments": [],
          "/activities/12345/kudos": fullPage,
        }),
        sourceId: SOURCE_ID,
        providerId: PROVIDER_ID,
        athleteId: 99,
      },
    );

    expect(rowsFor(result, "strava_activity_kudos")).toHaveLength(1000);
    expect(rowsFor(result, "strava_activities")).toEqual([]);
    const [doc] = result.documents!;
    expect(doc!.content).toContain("_1200 kudos_");
    expect(doc!.metadata.extra).toMatchObject({ kudosCount: 1200 });
  });
});
