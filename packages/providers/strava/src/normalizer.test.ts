// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { activityToRecord, activityToDocument, renderActivityMarkdown } from "./normalizer.js";
import type { StravaSummaryActivity } from "./types.js";

const providerId = ProviderId("strava:123");
const sourceId = SourceId("strava-activities:123");

const runActivity: StravaSummaryActivity = {
  id: 9876543210,
  athlete: { id: 123 },
  name: "Morning Run",
  distance: 8234.5,
  moving_time: 2712, // 45m 12s
  elapsed_time: 2910,
  total_elevation_gain: 120.5,
  type: "Run",
  sport_type: "Run",
  start_date: "2026-04-18T14:00:00Z",
  start_date_local: "2026-04-18T07:00:00Z",
  timezone: "(GMT-07:00) America/Los_Angeles",
  has_heartrate: true,
  average_heartrate: 152,
  max_heartrate: 178,
  kudos_count: 5,
  comment_count: 1,
  athlete_count: 1,
  location_city: "San Francisco",
  location_state: "CA",
  location_country: "United States",
  trainer: false,
  commute: false,
  manual: false,
  private: false,
};

const rideActivity: StravaSummaryActivity = {
  id: 1111,
  athlete: { id: 123 },
  name: "Napa loop",
  distance: 80000,
  moving_time: 10800, // 3h
  elapsed_time: 11400,
  total_elevation_gain: 1500,
  type: "Ride",
  sport_type: "Ride",
  start_date: "2026-03-15T16:00:00Z",
  start_date_local: "2026-03-15T09:00:00Z",
  timezone: "(GMT-07:00) America/Los_Angeles",
  has_heartrate: false,
  average_watts: 210,
  max_watts: 680,
  weighted_average_watts: 245,
  kilojoules: 2268,
  kudos_count: 12,
  comment_count: 0,
  athlete_count: 3,
  pr_count: 2,
  trainer: false,
  commute: false,
  manual: false,
  private: false,
  average_speed: 7.4,
  max_speed: 16.2,
};

describe("activityToRecord", () => {
  test("maps every column for a run with heart rate", () => {
    const r = activityToRecord(runActivity);
    expect(r.id).toBe(9876543210);
    expect(r.athlete_id).toBe(123);
    expect(r.name).toBe("Morning Run");
    expect(r.sport_type).toBe("Run");
    expect(r.activity_type).toBe("Run");
    expect(r.distance_m).toBe(8234.5);
    expect(r.moving_time_seconds).toBe(2712);
    expect(r.total_elevation_gain_m).toBe(120.5);
    // Canonicalized by declared column type: TIMESTAMPTZ to one UTC instant,
    // TIMESTAMP to bare wall-clock digits (Strava's trailing `Z` on a local
    // stamp is spurious and says nothing about a zone).
    expect(r.start_time).toBe("2026-04-18T14:00:00.000Z");
    expect(r.start_time_local).toBe("2026-04-18T07:00:00.000");
    expect(r.has_heartrate).toBe(true);
    expect(r.average_heartrate_bpm).toBe(152);
    expect(r.max_heartrate_bpm).toBe(178);
    expect(r.average_watts).toBeNull();
    expect(r.kudos_count).toBe(5);
    expect(r.comment_count).toBe(1);
    expect(r.athlete_count).toBe(1);
    expect(r.location_city).toBe("San Francisco");
    expect(r.strava_url).toBe("https://www.strava.com/activities/9876543210");
    expect(r.private).toBe(false);
    expect(r.trainer).toBe(false);
  });

  test("maps a ride with power and no heart rate", () => {
    const r = activityToRecord(rideActivity);
    expect(r.sport_type).toBe("Ride");
    expect(r.has_heartrate).toBe(false);
    expect(r.average_heartrate_bpm).toBeNull();
    expect(r.average_watts).toBe(210);
    expect(r.max_watts).toBe(680);
    expect(r.weighted_average_watts).toBe(245);
    expect(r.kilojoules).toBe(2268);
    expect(r.pr_count).toBe(2);
    expect(r.athlete_count).toBe(3);
  });

  test("gives one instant one spelling, whichever phase built the record", () => {
    // The two phases hold different strings for the same activity: the edit
    // sweep has what the API sent, enrichment has what the store rendered on
    // the way back out. If the record kept whichever it was handed, the row
    // would alternate between two spellings forever and every consumer that
    // compares rendered values would read a change that never happened.
    const fromApi = activityToRecord({
      ...runActivity,
      start_date: "2026-04-18T14:00:00Z",
      start_date_local: "2026-04-18T07:00:00Z",
    });
    const fromStore = activityToRecord({
      ...runActivity,
      start_date: "2026-04-18 15:00:00+01",
      start_date_local: "2026-04-18 07:00:00",
    });
    expect(fromStore.start_time).toBe(fromApi.start_time);
    expect(fromStore.start_time_local).toBe(fromApi.start_time_local);
  });

  test("still separates activities that genuinely started at different times", () => {
    const earlier = activityToRecord({ ...runActivity, start_date: "2026-04-18T14:00:00Z" });
    const later = activityToRecord({ ...runActivity, start_date: "2026-04-18T14:00:01Z" });
    expect(later.start_time).not.toBe(earlier.start_time);
  });

  test("keeps an unrecognised spelling rather than dropping the reading", () => {
    const r = activityToRecord({ ...runActivity, start_date: "18 April 2026, 2pm" });
    expect(r.start_time).toBe("18 April 2026, 2pm");
  });
});

describe("activityToDocument", () => {
  test("carries one spelling of the activity's own clock", () => {
    // The document's timestamps come from the same field the record's do, and
    // the phase that rebuilds a summary from stored rows holds the store's
    // rendering rather than the API's. Two spellings here churn the document's
    // own metadata on every cycle.
    const fromApi = activityToDocument(
      { ...runActivity, start_date: "2026-04-18T14:00:00Z" },
      providerId,
      sourceId,
    );
    const fromStore = activityToDocument(
      { ...runActivity, start_date: "2026-04-18 15:00:00+01" },
      providerId,
      sourceId,
    );
    expect(fromStore.sourceCreatedAt).toBe(fromApi.sourceCreatedAt);
    expect(fromStore.sourceUpdatedAt).toBe(fromApi.sourceUpdatedAt);
  });

  test("produces a searchable document with expected fields", () => {
    const d = activityToDocument(runActivity, providerId, sourceId);
    expect(d.providerId).toBe(providerId);
    expect(d.sourceId).toBe(sourceId);
    expect(d.externalId).toBe("9876543210");
    expect(d.title).toBe("Morning Run");
    expect(d.metadata.documentType).toBe("activity");
    expect(d.metadata.sourceUrl).toBe("https://www.strava.com/activities/9876543210");
    expect(d.metadata.tags).toContain("Run");
    expect(d.sourceCreatedAt).toBe("2026-04-18T14:00:00.000Z");
    expect(d.contentHash.length).toBe(64);
  });

  test("includes athlete as `owner` PersonMention with name + LID when name is provided", () => {
    const d = activityToDocument(runActivity, providerId, sourceId, {
      athleteName: "James Bond",
    });
    expect(d.metadata.people).toEqual([
      { role: "owner", name: "James Bond", lids: ["strava-athlete:123"] },
    ]);
  });

  test("omits people field when no athlete name is provided", () => {
    const d = activityToDocument(runActivity, providerId, sourceId);
    expect(d.metadata.people).toBeUndefined();
  });

  test("omits people field when athlete name is empty string", () => {
    const d = activityToDocument(runActivity, providerId, sourceId, { athleteName: "" });
    expect(d.metadata.people).toBeUndefined();
  });

  test("carries athlete id and profile URL in metadata.extra for future cross-linking", () => {
    const d = activityToDocument(runActivity, providerId, sourceId, {
      athleteName: "James Bond",
    });
    expect(d.metadata.extra?.athleteId).toBe(123);
    expect(d.metadata.extra?.athleteUrl).toBe("https://www.strava.com/athletes/123");
  });
});

describe("renderActivityMarkdown", () => {
  test("includes key metrics for a run", () => {
    const md = renderActivityMarkdown(runActivity);
    expect(md).toContain("**Sport:** Run");
    expect(md).toContain("8.23 km");
    expect(md).toContain("5.12 mi");
    expect(md).toContain("**Moving time:**");
    expect(md).toContain("**Pace:**");
    expect(md).toContain("/km");
    expect(md).toContain("152 bpm");
    expect(md).toContain("(max 178)");
    expect(md).toContain("**Elevation gain:** 121 m");
    expect(md).toContain("San Francisco");
    expect(md).toContain("5 kudos");
    expect(md).toContain("1 comment");
  });

  test("uses km/h pace for rides, reports power", () => {
    const md = renderActivityMarkdown(rideActivity);
    expect(md).toContain("**Sport:** Ride");
    expect(md).toContain("km/h");
    expect(md).not.toContain("/km");
    expect(md).toContain("210 W");
    expect(md).toContain("(max 680)");
    expect(md).toContain("2 PRs");
    expect(md).toContain("3 athletes");
  });
});
