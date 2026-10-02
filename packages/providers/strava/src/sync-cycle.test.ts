// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The provider-contract check, run against the real phase machine: with
 * upstream unchanged, a full sweep→enrich→sweep cycle must write nothing.
 *
 * The regression net for a churn bug: a single unchanged activity
 * re-ingesting itself on every cycle, at one detail fetch and two journal
 * events apiece.
 *
 * The phases here talk to each other through the analytics table — the sweep
 * decides what changed by reading back `summary_hash`, and enrichment finds its
 * work by reading back which rows have no `detail_fetched_at`. So the store is
 * modelled rather than stubbed away: a query returns what the previous phase
 * actually wrote, which is the only way the disagreement between them can show
 * up at all.
 */

import { describe, expect, test, vi } from "vitest";
import {
  emittedRows,
  expectUnchangedUpstreamIsNoOp,
  runSyncCycleContract,
} from "@omnesis/source-sdk/testing";
import { StravaActivitiesSource } from "./activities.js";
import type { SourceAnalyticsAccess } from "@omnesis/source-sdk";
import type { ProviderId, SourceId } from "@omnesis/types";
import type { StravaClient } from "./client.js";
import type { StravaActivitiesCursor } from "./types.js";

const PROVIDER_ID = "strava:77" as ProviderId;
const SOURCE_ID = "strava-activities:77" as SourceId;

/** One activity, unchanged for the whole test — the upstream that never moves. */
const ACTIVITY = {
  id: 4242,
  athlete: { id: 77 },
  name: "Afternoon Walk",
  distance: 3120.4,
  moving_time: 1980,
  elapsed_time: 2040,
  total_elevation_gain: 12,
  type: "Walk",
  sport_type: "Walk",
  start_date: "2026-07-31T14:09:00Z",
  start_date_local: "2026-07-31T15:09:00Z",
  timezone: "(GMT+01:00) Europe/London",
  trainer: false,
  commute: false,
  manual: false,
  private: false,
  flagged: false,
  gear_id: null,
  has_heartrate: false,
  kudos_count: 0,
  comment_count: 0,
  athlete_count: 1,
  map: { summary_polyline: "abc" },
};

/**
 * The detail Strava returns for it. The three fields below are the ones only
 * this endpoint carries, and the empty string is deliberate: an activity with
 * no description reads back as `""` here and as `null` from a listing, which
 * is exactly the difference that made the two phases disagree.
 */
const DETAIL = {
  ...ACTIVITY,
  description: "",
  calories: 0,
  perceived_exertion: null,
  prefer_perceived_exertion: null,
  available_zones: ["pace"],
  embed_token: "0123456789abcdef0123456789abcdef01234567",
  map: { summary_polyline: "abc", polyline: "" },
  device_name: null,
  segment_efforts: [],
  splits_metric: [],
  splits_standard: [],
  laps: [],
  best_efforts: [],
  photos: { primary: null, count: 0 },
};

/** A store the phases read back through, standing in for the analytics table. */
function analyticsBackedGateway(
  rows: () => readonly Record<string, unknown>[],
): SourceAnalyticsAccess {
  const answer = (sql: string): { columns: string[]; rows: Record<string, unknown>[] } => {
    const stored = [...rows()];
    if (/count\(\*\)/i.test(sql)) {
      const pending = stored.filter((r) => matchesWhere(sql, r));
      return { columns: ["n"], rows: [{ n: pending.length }] };
    }
    // Whole rows, whichever columns a read names: a superset of what it asked.
    return { columns: ["*"], rows: stored.filter((r) => matchesWhere(sql, r)) };
  };
  // One method, implemented outright rather than stubbed behind a cast.
  return {
    query: vi.fn((sql: string) => Promise.resolve(answer(sql))),
  } satisfies SourceAnalyticsAccess;
}

/**
 * Evaluate the `<tier>_fetched_at IS NULL` predicates the enrichment phases
 * ask with, and the `id NOT IN (…)` by which the social tier leaves out the
 * activities whose marks it is writing. The store holds one athlete, so their
 * owner predicate holds for every row.
 */
function matchesWhere(sql: string, row: Record<string, unknown>): boolean {
  const excluded = /\bid NOT IN \(([^)]*)\)/i.exec(sql)?.[1].split(/\s*,\s*/);
  if (excluded?.includes(String(row.id))) return false;
  const match = /\b(\w+_fetched_at)\s+IS\s+NULL/i.exec(sql);
  if (!match) return true;
  const value = row[match[1]];
  return value === null || value === undefined;
}

/**
 * A client that always answers with the same activity and the same detail —
 * upstream that never moves, which is the condition under test.
 */
class UnchangingClient {
  public detailCalls = 0;
  public commentCalls = 0;
  /** What the listing answers with; a test that edits the activity upstream sets it. */
  public listed: Record<string, unknown> = ACTIVITY;
  /** Who the kudos endpoint lists. */
  public kudoers: unknown[] = [];
  /** What the detail endpoint answers with; a test that moves the activity sets it too. */
  public detail: unknown;
  constructor(detail: unknown = DETAIL) {
    this.detail = detail;
  }
  /**
   * Honours `after` and `page` the way Strava does. It matters: the
   * incremental phase advances a high-water mark and asks only for what
   * followed it, so a mock that answered with the activity every time would
   * manufacture a loop the real cursor cannot produce.
   */
  listActivities(params: { after?: number; page?: number }): Promise<unknown[]> {
    const startedAt = Math.floor(new Date(ACTIVITY.start_date).getTime() / 1000);
    if ((params.page ?? 1) > 1) return Promise.resolve([]);
    if (params.after !== undefined && startedAt <= params.after) return Promise.resolve([]);
    return Promise.resolve([this.listed]);
  }
  getActivity(): Promise<unknown> {
    this.detailCalls += 1;
    return Promise.resolve(this.detail);
  }
  get quota(): { canMakeNCalls: () => boolean } {
    return { canMakeNCalls: () => true };
  }
  // The remaining phases of the cycle. Each answers with nothing to do, so the
  // machine walks through them and comes back round to the sweep — which is
  // the loop under test.
  getAthleteDetail(): Promise<unknown> {
    return Promise.resolve({ id: 77, firstname: "Test", lastname: "Athlete" });
  }
  getAthleteZones(): Promise<unknown> {
    return Promise.resolve({});
  }
  getAthleteStats(): Promise<unknown> {
    return Promise.resolve({});
  }
  listActivityComments(): Promise<unknown[]> {
    this.commentCalls += 1;
    return Promise.resolve([]);
  }
  listActivityKudos(): Promise<unknown[]> {
    return Promise.resolve(this.kudoers);
  }
  getActivityZones(): Promise<unknown[]> {
    return Promise.resolve([]);
  }
  getActivityStreams(): Promise<unknown> {
    return Promise.resolve({});
  }
  getGear(): Promise<unknown> {
    return Promise.resolve(null);
  }
  getTokens(): unknown {
    return undefined;
  }
}

function sourceUnder(
  store: () => readonly Record<string, unknown>[],
  detail?: unknown,
): {
  source: StravaActivitiesSource;
  client: UnchangingClient;
} {
  const client = new UnchangingClient(detail);
  const source = new StravaActivitiesSource(
    client as unknown as StravaClient,
    SOURCE_ID,
    PROVIDER_ID,
    undefined,
    undefined,
    77,
    analyticsBackedGateway(store),
  );
  return { source, client };
}

describe("a full sync cycle against unchanged upstream", () => {
  test("writes nothing the second time round", async () => {
    // The regression this file exists for. Before the fix the edit sweep and
    // enrichment persisted `summary_hash` from different inputs, so the sweep
    // never recognised the row enrichment had just written, cleared its
    // stamps, and sent it back for another detail fetch — one third-party call
    // per activity per cycle, for as long as the source stayed connected.
    let latest: readonly Record<string, unknown>[] = [];
    const { source, client } = sourceUnder(() => latest);

    const report = await expectUnchangedUpstreamIsNoOp({
      initialCursor: { phase: "edit-sweep" } as StravaActivitiesCursor,
      primaryKey: () => ["id"],
      // The stamps and the digest are bookkeeping: moving them is the phase
      // doing its job. Everything else moving means the phases disagree.
      volatileColumns: () => [
        "detail_fetched_at",
        "social_fetched_at",
        "zones_fetched_at",
        "streams_fetched_at",
        "summary_hash",
      ],
      step: async (cursor, rows) => {
        latest = rows("strava_activities");
        const result = await source.syncStructured(cursor as StravaActivitiesCursor);
        return {
          records: emittedRows(result),
          cursor: result.cursor,
          hasMore: result.hasMore ?? false,
        };
      },
    });

    expect(report.converged).toBe(true);
    expect(report.rewritten).toEqual([]);
    // And the cost the loop was paying: one detail fetch, not one per cycle.
    expect(client.detailCalls).toBeLessThanOrEqual(1);
  });

  /**
   * A source whose pages are applied to its one-row store as the host applies
   * them, with `detail` as the activity's detail on Strava. `row` is the
   * activity's stored row.
   */
  function appliedPages(detail: unknown) {
    let stored: Record<string, unknown>[] = [];
    const { source, client } = sourceUnder(() => stored, detail);
    const page = async (cursor: StravaActivitiesCursor) => {
      const result = await source.syncStructured(cursor);
      for (const { table, row } of emittedRows(result))
        if (table === "strava_activities") stored = [{ ...stored[0], ...row }];
      return result;
    };
    return { page, client, row: () => stored[0] };
  }

  /** A page of `phase` with nothing time-gated due, so no walk interrupts it. */
  const settled = (phase: StravaActivitiesCursor["phase"]): StravaActivitiesCursor => {
    const recently = new Date().toISOString();
    return {
      phase,
      lastSnapshotAt: recently,
      lastEditSweepAt: recently,
      lastAthleteRefreshAt: recently,
    };
  };
  /** The listing that first stores the activity. */
  const listing = (): StravaActivitiesCursor => settled("incremental");
  /** A sweep reaching back far enough to walk the activity again. */
  const sweep: StravaActivitiesCursor = { phase: "edit-sweep", editSweepAfter: 0 };

  test("the next sweep writes nothing when the detail spells a hashed field the listing leaves out", async () => {
    // The detail page keeps the listing's hashed fields and summary hash: the
    // sweep compares listings with it, so a hash taken from the detail would
    // read this difference as an edit on every sweep and re-enrich the
    // activity each time.
    const { page, client, row } = appliedPages({ ...DETAIL, workout_type: 0 });

    await page(listing());
    expect(row()?.workout_type).toBeNull();
    await page(settled("detail-backfill"));
    expect(row()?.workout_type).toBeNull();

    const swept = await page(sweep);
    expect(emittedRows(swept)).toEqual([]);
    expect(swept.documents ?? []).toEqual([]);
    expect(client.detailCalls).toBe(1);
  });

  test("a replayed detail page leaves the next sweep nothing to write", async () => {
    // A tick that dies after a detail page's rows land but before its document
    // and cursor commit runs the same page again, over the row it wrote. The
    // replay must keep the listing's hash too, or the sweep re-ingests the
    // activity and sends it through every tier once more.
    const { page, client } = appliedPages({ ...DETAIL, workout_type: 0 });

    await page(listing());
    await page(settled("detail-backfill"));
    await page(settled("detail-backfill"));

    expect(emittedRows(await page(sweep))).toEqual([]);
    expect(client.detailCalls).toBe(2);
  });

  test("an edit made between the listing and the detail fetch is the sweep's to write", async () => {
    // Renamed and cropped on Strava after it was listed. The detail page
    // leaves both to the sweep, so the row keeps matching what its listing
    // gave it.
    const { page, client, row } = appliedPages({
      ...DETAIL,
      name: "Lakeside walk",
      distance: 3000,
    });

    await page(listing());
    await page(settled("detail-backfill"));
    expect(row()).toMatchObject({ name: "Afternoon Walk", distance_m: 3120.4 });

    // The edits undone: the listing matches the row again, which is right.
    expect(emittedRows(await page(sweep))).toEqual([]);
    expect(row()).toMatchObject({ name: "Afternoon Walk", distance_m: 3120.4 });

    // The edits made again: the sweep sees them, writes them and sends the
    // activity back for its detail.
    client.listed = { ...ACTIVITY, name: "Lakeside walk", distance: 3000 };
    const edited = await page(sweep);
    expect(emittedRows(edited)).toEqual([
      {
        table: "strava_activities",
        row: expect.objectContaining({
          name: "Lakeside walk",
          distance_m: 3000,
          detail_fetched_at: null,
        }),
      },
    ]);
    expect(row()).toMatchObject({ name: "Lakeside walk", distance_m: 3000 });
  });

  test("counters Strava keeps but does not list send the activity to the social tier once", async () => {
    // A kudo arrives whose giver the kudos list leaves out. The sweep sends
    // the activity back to the social tier, which keeps Strava's counter: a
    // row that took the list's length instead would read as moved on every
    // sweep, and each would fetch both lists again.
    const { page, client, row } = appliedPages(DETAIL);
    await page(listing());

    client.listed = { ...ACTIVITY, kudos_count: 2 };
    client.kudoers = [{ firstname: "Maya", lastname: "Reeves" }];
    const recounted = await page(sweep);
    expect(emittedRows(recounted)).toEqual([
      {
        table: "strava_activities",
        row: expect.objectContaining({ kudos_count: 2, social_fetched_at: null }),
      },
    ]);
    expect(recounted.documents ?? []).toEqual([]);

    const social = await page(settled("social-backfill"));
    expect(social.documents?.[0]?.content).toContain("_2 kudos_");
    await page(social.cursor);
    expect(row()).toMatchObject({ kudos_count: 2, social_fetched_at: expect.any(String) });

    const next = await page(sweep);
    expect(emittedRows(next)).toEqual([]);
    expect(next.documents ?? []).toEqual([]);
  });

  describe("comments that arrive while the social tier is under way are fetched", () => {
    // The comment endpoint answers with nothing throughout: these tests count
    // how often the social tier asks, not what it stores.
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const commented = () => ({ ...ACTIVITY, comment_count: 1 });

    test("by the walk after one that found them while the social marks were pending", async () => {
      // A social page fetched the comments and marks the activity done on its
      // next page, which the budget can hold back for hours while walks run. A
      // walk that wrote the recount in between would have that page mark it
      // done, with the social tier never run for the comment behind it.
      const { page, client } = appliedPages(DETAIL);
      await page(listing());
      const detailed = await page(settled("detail-backfill"));
      await page(detailed.cursor);
      const social = await page(settled("social-backfill"));
      expect(social.cursor.pendingSocialStamps).toEqual(["4242"]);

      client.listed = commented();
      client.detail = { ...DETAIL, comment_count: 1 };
      const rewalked = await page({ ...social.cursor, lastSnapshotAt: hoursAgo(25) });
      expect(rewalked.presentExternalIds).toEqual(["4242"]);
      expect(emittedRows(rewalked)).toEqual([]);

      let cursor = rewalked.cursor;
      for (let i = 0; i < 10 && cursor.phase !== "incremental"; i++)
        cursor = (await page(cursor)).cursor;
      expect(cursor.phase).toBe("incremental");

      expect(emittedRows(await page(sweep))).toEqual([
        {
          table: "strava_activities",
          row: expect.objectContaining({ comment_count: 1, social_fetched_at: null }),
        },
      ]);
      await page(settled("social-backfill"));
      expect(client.commentCalls).toBe(2);
    });

    test("when the detail is fetched after them", async () => {
      // `enrich-pending` rotates the social tier ahead of the detail, and a
      // refused page can split the two. A detail page that wrote the counters
      // it fetched would leave the next walk nothing moved to find.
      const { page, client, row } = appliedPages(DETAIL);
      await page(listing());
      const social = await page(settled("social-backfill"));
      await page(social.cursor);

      client.listed = commented();
      client.detail = { ...DETAIL, comment_count: 1 };
      const detailed = await page(settled("detail-backfill"));
      await page(detailed.cursor);
      expect(row()).toMatchObject({ comment_count: 0, detail_fetched_at: expect.any(String) });

      expect(emittedRows(await page(sweep))).toEqual([
        {
          table: "strava_activities",
          row: expect.objectContaining({ comment_count: 1, social_fetched_at: null }),
        },
      ]);
      await page(settled("social-backfill"));
      expect(client.commentCalls).toBe(2);
    });
  });

  test("and the settled row keeps the enrichment it fetched", async () => {
    // The failure mode that a bare "no-op" assertion would miss: a cycle that
    // writes nothing because the sweep never hands anything to enrichment is
    // also quiet, and useless. The detail must actually be there.
    let latest: readonly Record<string, unknown>[] = [];
    const { source } = sourceUnder(() => latest);
    await runSyncCycleContract({
      initialCursor: { phase: "edit-sweep" } as StravaActivitiesCursor,
      primaryKey: () => ["id"],
      step: async (cursor, rows) => {
        latest = rows("strava_activities");
        const result = await source.syncStructured(cursor as StravaActivitiesCursor);
        return {
          records: emittedRows(result),
          cursor: result.cursor,
          hasMore: result.hasMore ?? false,
        };
      },
    });
    expect(latest.length).toBeGreaterThan(0);
  });
});
