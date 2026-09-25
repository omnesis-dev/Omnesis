// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  splitsFromActivity,
  bestEffortsFromActivity,
  lapsFromActivity,
  segmentEffortsFromActivity,
  activityZonesToRecords,
  commentToRecord,
  kudoToRecord,
  streamSetToRecord,
  athleteToRecord,
  athleteZonesToRecords,
  athleteStatsToRecords,
  gearToRecord,
  computeSummaryHash,
} from "./normalizer-detail.js";
import type {
  StravaDetailedActivity,
  StravaActivityZone,
  StravaComment,
  StravaSummaryAthlete,
  StravaStreamSet,
  StravaDetailedAthlete,
  StravaDetailedGear,
  StravaActivityStats,
  StravaSummaryActivity,
} from "./types.js";

const baseActivity: StravaSummaryActivity = {
  id: 12345,
  athlete: { id: 99 },
  name: "Morning Run",
  distance: 21530,
  moving_time: 6635,
  elapsed_time: 6640,
  total_elevation_gain: 131,
  sport_type: "Run",
  type: "Run",
  start_date: "2026-05-03T09:31:00Z",
  start_date_local: "2026-05-03T10:31:00Z",
};

describe("splitsFromActivity", () => {
  test("emits one row per metric split + one per standard split", () => {
    const detail: StravaDetailedActivity = {
      ...baseActivity,
      splits_metric: [
        {
          split: 1,
          distance: 1000,
          elapsed_time: 310,
          moving_time: 310,
          average_speed: 3.23,
          average_heartrate: 145,
          pace_zone: 2,
        },
        { split: 2, distance: 1000, elapsed_time: 316, moving_time: 316, average_speed: 3.16 },
      ],
      splits_standard: [
        { split: 1, distance: 1609.344, elapsed_time: 500, moving_time: 500, average_speed: 3.22 },
      ],
    };
    const rows = splitsFromActivity(detail);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      activity_id: 12345,
      unit: "metric",
      split_index: 1,
      distance_m: 1000,
      average_heartrate_bpm: 145,
      pace_zone: 2,
    });
    expect(rows[2]!.unit).toBe("standard");
  });

  test("returns empty array when activity has no splits", () => {
    const detail: StravaDetailedActivity = { ...baseActivity };
    expect(splitsFromActivity(detail)).toEqual([]);
  });
});

describe("bestEffortsFromActivity", () => {
  test("translates best efforts including PR rank", () => {
    const detail: StravaDetailedActivity = {
      ...baseActivity,
      best_efforts: [
        {
          id: 1001,
          activity: { id: 12345 },
          name: "5K",
          distance: 5000,
          elapsed_time: 1325,
          moving_time: 1325,
          start_index: 100,
          end_index: 1425,
          start_date: "2026-05-03T09:42:00Z",
          pr_rank: 1,
        },
        {
          id: 1002,
          activity: { id: 12345 },
          name: "Half-Marathon",
          distance: 21097.5,
          elapsed_time: 6503,
          moving_time: 6503,
          pr_rank: null,
        },
      ],
    };
    const rows = bestEffortsFromActivity(detail);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 1001, name: "5K", pr_rank: 1, distance_m: 5000 });
    expect(rows[1]!.pr_rank).toBeNull();
  });
});

describe("lapsFromActivity", () => {
  test("emits one row per lap with denormalized fields", () => {
    const detail: StravaDetailedActivity = {
      ...baseActivity,
      laps: [
        {
          id: 5001,
          activity: { id: 12345 },
          name: "Lap 1",
          distance: 1000,
          elapsed_time: 310,
          moving_time: 310,
          start_date: "2026-05-03T09:31:00Z",
          start_date_local: "2026-05-03T10:31:00Z",
          start_index: 0,
          end_index: 309,
          average_speed: 3.23,
          average_heartrate: 145,
          lap_index: 1,
        },
      ],
    };
    const rows = lapsFromActivity(detail);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 5001,
      activity_id: 12345,
      lap_index: 1,
      average_heartrate_bpm: 145,
    });
  });
});

describe("segmentEffortsFromActivity", () => {
  test("denormalizes segment metadata onto the effort row", () => {
    const detail: StravaDetailedActivity = {
      ...baseActivity,
      segment_efforts: [
        {
          id: 9001,
          activity: { id: 12345 },
          name: "Putney Hill",
          elapsed_time: 240,
          moving_time: 240,
          start_date: "2026-05-03T09:35:00Z",
          start_date_local: "2026-05-03T10:35:00Z",
          distance: 800,
          start_index: 100,
          end_index: 340,
          average_heartrate: 168,
          kom_rank: 5,
          pr_rank: 1,
          segment: {
            id: 700,
            name: "Putney Hill",
            activity_type: "Run",
            distance: 800,
            average_grade: 6.5,
            maximum_grade: 9.2,
            elevation_high: 95,
            elevation_low: 35,
            city: "London",
            state: "England",
            country: "UK",
            climb_category: 4,
            private: false,
            starred: true,
          },
        },
      ],
    };
    const rows = segmentEffortsFromActivity(detail);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 9001,
      activity_id: 12345,
      segment_id: 700,
      segment_name: "Putney Hill",
      segment_average_grade: 6.5,
      segment_climb_category: 4,
      segment_starred: true,
      kom_rank: 5,
      pr_rank: 1,
    });
  });

  test("serializes achievements as JSON when non-empty", () => {
    const detail: StravaDetailedActivity = {
      ...baseActivity,
      segment_efforts: [
        {
          id: 9002,
          activity: { id: 12345 },
          name: "X",
          elapsed_time: 1,
          moving_time: 1,
          start_date: "2026-05-03T09:35:00Z",
          start_date_local: "2026-05-03T10:35:00Z",
          distance: 1,
          start_index: 0,
          end_index: 0,
          achievements: [{ type: "pr", rank: 1 }],
          segment: { id: 1, name: "X", activity_type: "Run", distance: 1 },
        },
      ],
    };
    const [row] = segmentEffortsFromActivity(detail);
    expect(JSON.parse(String(row!.achievements_json))).toEqual([{ type: "pr", rank: 1 }]);
  });
});

describe("activityZonesToRecords", () => {
  test("flattens distribution buckets across heartrate + power zones", () => {
    const zones: StravaActivityZone[] = [
      {
        type: "heartrate",
        sensor_based: true,
        custom_zones: false,
        points: 110,
        distribution_buckets: [
          { min: 0, max: 120, time: 600 },
          { min: 120, max: 140, time: 1200 },
          { min: 140, max: 160, time: 1800 },
        ],
      },
      {
        type: "power",
        sensor_based: false,
        custom_zones: true,
        distribution_buckets: [{ min: 0, max: 100, time: 30 }],
      },
    ];
    const rows = activityZonesToRecords(12345, zones);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      activity_id: 12345,
      zone_type: "heartrate",
      bucket_index: 0,
      time_seconds: 600,
      sensor_based: true,
      points: 110,
    });
    expect(rows[3]).toMatchObject({ zone_type: "power", custom_zones: true });
  });
});

describe("commentToRecord / kudoToRecord", () => {
  test("comment row preserves activity_id + author identity", () => {
    const c: StravaComment = {
      id: 42,
      activity_id: 12345,
      text: "Great run!",
      created_at: "2026-05-03T09:50:00Z",
      athlete: { id: 7, firstname: "Sarah", lastname: "Smith" },
    };
    expect(commentToRecord(c)).toEqual({
      id: 42,
      activity_id: 12345,
      athlete_id: 7,
      athlete_firstname: "Sarah",
      athlete_lastname: "Smith",
      text: "Great run!",
      created_at: "2026-05-03T09:50:00Z",
    });
  });

  test("kudo row uses (activity_id, position) as proxy id", () => {
    const k: StravaSummaryAthlete = { firstname: "Bob", lastname: "Jones" };
    expect(kudoToRecord(k, 12345, 3)).toEqual({
      activity_id: 12345,
      position: 3,
      athlete_id: null,
      firstname: "Bob",
      lastname: "Jones",
      username: null,
    });
  });
});

describe("streamSetToRecord", () => {
  test("preserves resolution + size of the JSON blob", () => {
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
        data: [120, 130, 140],
        series_type: "time",
        original_size: 3,
        resolution: "high",
      },
    };
    const row = streamSetToRecord(12345, set);
    expect(row.activity_id).toBe(12345);
    expect(row.resolution).toBe("high");
    expect(row.series_type).toBe("time");
    expect(row.original_size).toBe(3);
    expect(typeof row.streams_json).toBe("string");
    expect(JSON.parse(row.streams_json as string).heartrate.data).toEqual([120, 130, 140]);
    expect(row.streams_size_bytes).toBeGreaterThan(0);
  });
});

describe("athleteToRecord / athleteZonesToRecords / athleteStatsToRecords", () => {
  test("athlete profile flattens key fields and stamps fetched_at", () => {
    const a: StravaDetailedAthlete = {
      id: 99,
      firstname: "James",
      lastname: "Bond",
      city: "London",
      premium: false,
      summit: true,
      ftp: 280,
      weight: 72.5,
      profile_medium: "https://example.com/p.jpg",
    };
    const row = athleteToRecord(a, 65000, 1200);
    expect(row).toMatchObject({
      id: 99,
      firstname: "James",
      ftp: 280,
      weight_kg: 72.5,
      summit: true,
      profile_url: "https://example.com/p.jpg",
      biggest_ride_distance_m: 65000,
      biggest_climb_elevation_gain_m: 1200,
    });
    expect(typeof row.fetched_at).toBe("string");
  });

  test("athlete zones produce one row per bucket per type", () => {
    const rows = athleteZonesToRecords(99, {
      heart_rate: {
        custom_zones: false,
        zones: [
          { min: 0, max: 120 },
          { min: 120, max: 140 },
        ],
      },
      power: { zones: [{ min: 0, max: 100 }] },
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ athlete_id: 99, zone_type: "heartrate", bucket_index: 0 });
    expect(rows[2]).toMatchObject({ zone_type: "power", bucket_index: 0 });
  });

  test("athlete stats explode to nine rows (3 buckets × 3 sports) when all populated", () => {
    const stats: StravaActivityStats = {
      recent_run_totals: {
        count: 2,
        distance: 25000,
        moving_time: 9000,
        elapsed_time: 9000,
        elevation_gain: 200,
      },
      ytd_run_totals: {
        count: 30,
        distance: 300000,
        moving_time: 100000,
        elapsed_time: 100000,
        elevation_gain: 5000,
      },
      all_run_totals: {
        count: 500,
        distance: 5000000,
        moving_time: 2000000,
        elapsed_time: 2000000,
        elevation_gain: 80000,
      },
      recent_ride_totals: {
        count: 1,
        distance: 80000,
        moving_time: 12000,
        elapsed_time: 12000,
        elevation_gain: 800,
      },
    };
    const rows = athleteStatsToRecords(99, stats);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.bucket === "all_time" && r.sport === "run")).toMatchObject({
      count: 500,
      distance_m: 5000000,
    });
  });
});

describe("gearToRecord", () => {
  test("infers gear_type from id prefix", () => {
    const g: StravaDetailedGear = {
      id: "b12345",
      brand_name: "Felt",
      model_name: "FR3",
      distance: 4500000,
      primary: true,
    };
    expect(gearToRecord(g, 99)).toMatchObject({
      id: "b12345",
      gear_type: "bike",
      brand_name: "Felt",
      model_name: "FR3",
      primary: true,
      athlete_id: 99,
    });

    const shoe: StravaDetailedGear = { id: "g7777", name: "Nike Pegasus 41" };
    expect(gearToRecord(shoe, 99).gear_type).toBe("shoe");
  });
});

describe("computeSummaryHash", () => {
  test("changes when the user edits a field that affects the document", () => {
    const original = computeSummaryHash(baseActivity);
    const renamed = computeSummaryHash({ ...baseActivity, name: "Different Title" });
    expect(renamed).not.toBe(original);
  });

  test("matches when only derived metrics change (kudos count)", () => {
    const a1 = computeSummaryHash({ ...baseActivity, kudos_count: 5 });
    const a2 = computeSummaryHash({ ...baseActivity, kudos_count: 17 });
    expect(a1).toBe(a2);
  });

  test("depends on nothing a summary does not carry", () => {
    // The two phases that persist this hash hold different things: the edit
    // sweep has a summary, enrichment has a summary plus the detail. If any
    // detail-only field reached the hash the two would permanently disagree,
    // the unchanged-summary comparison would never match, and every sweep
    // would clear the stamps enrichment had just written — a re-enrichment
    // loop rather than edit detection.
    const enriched = {
      ...baseActivity,
      description: "Easy recovery",
      perceived_exertion: 4,
      prefer_perceived_exertion: true,
      calories: 512,
      device_name: "A Watch",
    } as StravaDetailedActivity;
    expect(computeSummaryHash(enriched)).toBe(computeSummaryHash(baseActivity));
  });

  test("still changes for every summary-carried field it claims to cover", () => {
    // The other half: excluding detail must not quietly excuse a field the
    // sweep genuinely can see.
    const base = computeSummaryHash(baseActivity);
    const edits: Partial<StravaSummaryActivity>[] = [
      { name: "Different Title" },
      { sport_type: "Ride" },
      { type: "Ride" },
      { gear_id: "g999" },
      { commute: !baseActivity.commute },
      { trainer: !baseActivity.trainer },
      { private: !baseActivity.private },
      { workout_type: 3 },
    ];
    for (const edit of edits) {
      expect(computeSummaryHash({ ...baseActivity, ...edit })).not.toBe(base);
    }
  });
});
