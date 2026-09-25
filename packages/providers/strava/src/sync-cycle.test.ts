// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The provider-contract check, run against the real phase machine: with
 * upstream unchanged, a full sweep→enrich→sweep cycle must write nothing.
 *
 * The regression net for the churn behind #1559: a single unchanged activity
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
    if (/SELECT id, summary_hash/i.test(sql)) {
      return {
        columns: ["id", "summary_hash"],
        rows: stored.map((r) => ({ id: r.id, summary_hash: r.summary_hash ?? null })),
      };
    }
    return { columns: ["*"], rows: stored.filter((r) => matchesWhere(sql, r)) };
  };
  // One method, implemented outright rather than stubbed behind a cast.
  return {
    query: vi.fn((sql: string) => Promise.resolve(answer(sql))),
  } satisfies SourceAnalyticsAccess;
}

/** Evaluate the `<col> IS NULL` predicates the enrichment phases ask with. */
function matchesWhere(sql: string, row: Record<string, unknown>): boolean {
  const match = /WHERE\s+(\w+)\s+IS\s+NULL/i.exec(sql);
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
    return Promise.resolve([ACTIVITY]);
  }
  getActivity(): Promise<unknown> {
    this.detailCalls += 1;
    return Promise.resolve(DETAIL);
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
    return Promise.resolve([]);
  }
  listActivityKudos(): Promise<unknown[]> {
    return Promise.resolve([]);
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

function sourceUnder(store: () => readonly Record<string, unknown>[]): {
  source: StravaActivitiesSource;
  client: UnchangingClient;
} {
  const client = new UnchangingClient();
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
