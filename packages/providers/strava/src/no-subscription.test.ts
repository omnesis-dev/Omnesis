// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An athlete without a Strava subscription, from a first sync to a settled
 * source, and an install whose Strava API application's owner has none.
 *
 * Strava keeps an activity's heart-rate and power zones for subscribers. For
 * anyone else it refuses them with a 402 or a 403, or serves them with nothing
 * in them to store; here it also leaves out the relative-effort score, and
 * answers everything else as it would for a subscriber. The athlete's own
 * zones are no subscriber's feature, but the source has to cope should Strava
 * refuse them as well, so some athletes here have them refused too. Each of
 * these has to read as missing data and nothing worse: never a page that
 * throws, never a tier that cannot finish, never a page asked for again
 * without having moved, and never reads spent asking again for what Strava
 * has already refused, which would come out of the budget the rest of the
 * sync lives on.
 *
 * So the whole source runs here, through four stages of its life: the first
 * sync from a null cursor, a few steady ticks, the week later when its walks
 * and its weekly athlete refresh fall due, and an activity uploaded after
 * that. It is the real phase machine over a real `StravaClient` and the
 * `StravaRateLimitTracker` inside it; only Strava is fake, a fetch answering
 * as Strava answers a non-subscriber, rate-limit headers included. Each page
 * is applied, as the host applies it, to an in-memory store that answers the
 * phases' reads from what earlier pages wrote. The phases find their work
 * through that store — a tier's pending activities are the rows it has not
 * stamped — so it is modelled rather than stubbed: a refusal that was never
 * stamped shows up only as the same activity found pending again.
 *
 * The athlete needs no subscription for any of that; the account that
 * registered the install's API application does. Without one Strava
 * deactivates the application and refuses every request alike, with a 403
 * that names the application rather than anything of the athlete's. That is
 * not missing data but a source that cannot sync at all until the owner
 * subscribes and reactivates the application, and the last part of this file
 * has it happen at each point of the source's life. Every page that meets it
 * has to end the tick with the remedy and write nothing, so that reactivating
 * the application resumes the sync where it stopped, rather than finding the
 * backlog marked done with nothing fetched.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId, SyncError, syncRemediationOf } from "@omnesis/types";
import { analyticsDeleteKey, tableWrites } from "@omnesis/source-sdk";
import { StravaActivitiesSource } from "./activities.js";
import {
  StravaApiError,
  StravaApplicationInactiveError,
  StravaClient,
  StravaForbiddenError,
} from "./client.js";
import { allSchemas } from "./schemas.js";
import type { SourceAnalyticsAccess, StructuredSyncResult } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type { StravaActivitiesCursor } from "./types.js";

const ATHLETE_ID = 4107;
/** The athlete, as their tokens and `/athlete` name them. */
const ATHLETE = { firstname: "Maya", lastname: "Reeves" };
/** Their display name, joined from the tokens' names as `createContext` joins it. */
const ATHLETE_NAME = [ATHLETE.firstname, ATHLETE.lastname].join(" ");
const SHOE_ID = "g5501";

const MINUTE_MS = 60 * 1000;
const QUARTER_HOUR_MS = 15 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** When the source is added. */
const ADDED_AT = new Date("2026-09-14T07:05:00Z");
/**
 * A week and a little later: the daily rewalk, the six-hourly edit sweep and
 * the weekly athlete refresh are all due.
 */
const WEEK_LATER = new Date("2026-09-21T09:00:00Z");
/** Between two pages; well short of every cadence, so none falls due mid-stage. */
const PAGE_GAP_MS = MINUTE_MS;
/** Between two steady ticks: the source's default sync interval. */
const SYNC_INTERVAL_MS = 30 * MINUTE_MS;

/** Pages a stage may take before the driver calls it a spin and stops. */
const STAGE_PAGE_LIMIT = 40;

// ── Strava's side ────────────────────────────────────────────────────

/** One activity as Strava serves it, endpoint by endpoint. */
interface FakeActivity {
  /** What a listing carries. */
  summary: Record<string, unknown>;
  /** What `GET /activities/{id}` adds to the summary. */
  detail: Record<string, unknown>;
  /** Its streams, by type; Strava answers 404 for an activity without any. */
  streams?: Record<string, unknown>;
  comments: Record<string, unknown>[];
  kudoers: Record<string, unknown>[];
}

/**
 * A listed activity of this athlete: Strava's defaults, then `fields`. No
 * `suffer_score`, the relative-effort score, which Strava may leave out for a
 * non-subscriber, and no GPS unless the fields give it, which Strava spells as
 * empty coordinates.
 */
function listed(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    resource_state: 2,
    athlete: { id: ATHLETE_ID, resource_state: 1 },
    timezone: "(GMT+01:00) Europe/London",
    utc_offset: 3600,
    achievement_count: 0,
    kudos_count: 0,
    comment_count: 0,
    athlete_count: 1,
    photo_count: 0,
    total_photo_count: 0,
    pr_count: 0,
    trainer: false,
    commute: false,
    manual: false,
    private: false,
    flagged: false,
    has_heartrate: false,
    gear_id: null,
    upload_id: null,
    external_id: null,
    start_latlng: [],
    end_latlng: [],
    map: { id: `a${String(fields.id)}`, summary_polyline: "", resource_state: 2 },
    ...fields,
  };
}

/** Streams of `type`, `data` sampled over time. */
function stream(type: string, data: unknown[]): Record<string, unknown> {
  return { type, data, series_type: "time", original_size: data.length, resolution: "high" };
}

/**
 * A three-kilometre run with GPS, heart rate and the shoes: splits, a lap, best
 * efforts and a segment effort, none of them ranked, and streams. The child
 * rows take ids from the activity's, as Strava's ids are unique across them.
 */
function gpsRun(opts: {
  id: number;
  name: string;
  startDate: string;
  description: string;
  comments?: Record<string, unknown>[];
  kudoers?: Record<string, unknown>[];
}): FakeActivity {
  const { id, startDate } = opts;
  const summary = listed({
    id,
    name: opts.name,
    type: "Run",
    sport_type: "Run",
    distance: 3000,
    moving_time: 900,
    elapsed_time: 930,
    total_elevation_gain: 41,
    start_date: startDate,
    start_date_local: startDate,
    has_heartrate: true,
    average_heartrate: 151.2,
    max_heartrate: 172,
    average_speed: 3.333,
    max_speed: 4.1,
    gear_id: SHOE_ID,
    kudos_count: opts.kudoers?.length ?? 0,
    comment_count: opts.comments?.length ?? 0,
    start_latlng: [46.5001, 7.5001],
    end_latlng: [46.5102, 7.5203],
    map: { id: `a${id}`, summary_polyline: "fixture~polyline", resource_state: 2 },
  });
  const split = (n: number) => ({
    split: n,
    distance: 1000,
    elapsed_time: 310,
    moving_time: 300,
    elevation_difference: 4,
    average_speed: 3.33,
    average_grade_adjusted_speed: 3.35,
    average_heartrate: 140 + n * 8,
    pace_zone: 0,
  });
  const effort = (n: number, name: string, distance: number, seconds: number) => ({
    id: id * 10 + n,
    resource_state: 2,
    name,
    activity: { id },
    athlete: { id: ATHLETE_ID },
    elapsed_time: seconds,
    moving_time: seconds,
    start_date: startDate,
    start_date_local: startDate,
    distance,
    start_index: 0,
    end_index: 100,
    pr_rank: null,
    achievements: [],
  });
  return {
    summary,
    detail: {
      description: opts.description,
      calories: 212,
      device_name: "Fixture GPS Watch",
      gear: { id: SHOE_ID, primary: true, name: "Tempo trainers", resource_state: 2 },
      map: {
        id: `a${id}`,
        summary_polyline: "fixture~polyline",
        polyline: "fixture~full~polyline",
      },
      splits_metric: [split(1), split(2), split(3)],
      laps: [
        {
          id: id * 10 + 1,
          resource_state: 2,
          name: "Lap 1",
          activity: { id },
          athlete: { id: ATHLETE_ID },
          elapsed_time: 930,
          moving_time: 900,
          start_date: startDate,
          start_date_local: startDate,
          distance: 3000,
          start_index: 0,
          end_index: 900,
          total_elevation_gain: 41,
          average_speed: 3.333,
          max_speed: 4.1,
          average_heartrate: 151.2,
          max_heartrate: 172,
          lap_index: 1,
          split: 1,
          pace_zone: 0,
        },
      ],
      best_efforts: [effort(2, "400m", 400, 101), effort(3, "1k", 1000, 268)],
      segment_efforts: [
        {
          ...effort(4, "Fixture hill", 640, 190),
          kom_rank: null,
          hidden: false,
          segment: {
            id: id * 10 + 5,
            resource_state: 2,
            name: "Fixture hill",
            activity_type: "Run",
            distance: 640,
            average_grade: 3.1,
            maximum_grade: 7.4,
            elevation_high: 512,
            elevation_low: 492,
            climb_category: 0,
            private: false,
            starred: false,
          },
        },
      ],
    },
    streams: {
      time: stream("time", [0, 300, 600, 900]),
      distance: stream("distance", [0, 1000, 2000, 3000]),
      latlng: stream("latlng", [
        [46.5001, 7.5001],
        [46.5102, 7.5203],
      ]),
      heartrate: stream("heartrate", [121, 148, 156, 168]),
    },
    comments: opts.comments ?? [],
    kudoers: opts.kudoers ?? [],
  };
}

/** A run with GPS, a comment and two kudos. */
const RUN = gpsRun({
  id: 9100000001,
  name: "Riverside tempo run",
  startDate: "2026-09-10T06:15:00Z",
  description: "Easy first half, pushed the last kilometre.",
  comments: [
    {
      id: 3300001,
      activity_id: 9100000001,
      text: "Strong finish!",
      created_at: "2026-09-10T09:02:00Z",
      athlete: { id: 5100002, firstname: "Sarah", lastname: "M." },
    },
  ],
  kudoers: [
    { firstname: "Jamie", lastname: "L.", resource_state: 2 },
    { firstname: "David", lastname: "K.", resource_state: 2 },
  ],
});

/**
 * A walk logged by hand: no GPS, no device, so no splits, laps or efforts in
 * its detail, and no streams at all.
 */
const MANUAL_WALK: FakeActivity = {
  summary: listed({
    id: 9100000002,
    name: "Evening walk",
    type: "Walk",
    sport_type: "Walk",
    distance: 3200,
    moving_time: 2400,
    elapsed_time: 2400,
    total_elevation_gain: 0,
    manual: true,
    start_date: "2026-09-11T17:30:00Z",
    start_date_local: "2026-09-11T18:30:00Z",
  }),
  detail: { description: "Logged by hand after dinner.", calories: 0 },
  comments: [],
  kudoers: [],
};

/** A pool swim: laps and heart rate, but no GPS and no best efforts. */
const POOL_SWIM: FakeActivity = {
  summary: listed({
    id: 9100000003,
    name: "Pool session",
    type: "Swim",
    sport_type: "Swim",
    distance: 1500,
    moving_time: 1920,
    elapsed_time: 2280,
    total_elevation_gain: 0,
    has_heartrate: true,
    average_heartrate: 132,
    max_heartrate: 158,
    start_date: "2026-09-12T06:45:00Z",
    start_date_local: "2026-09-12T07:45:00Z",
  }),
  detail: {
    description: "Drills, then ten hundreds.",
    calories: 405,
    device_name: "Fixture GPS Watch",
    laps: [
      {
        id: 91000000031,
        name: "Lap 1",
        activity: { id: 9100000003 },
        elapsed_time: 1100,
        moving_time: 960,
        start_date: "2026-09-12T06:45:00Z",
        start_date_local: "2026-09-12T07:45:00Z",
        distance: 750,
        start_index: 0,
        end_index: 960,
        lap_index: 1,
      },
      {
        id: 91000000032,
        name: "Lap 2",
        activity: { id: 9100000003 },
        elapsed_time: 1180,
        moving_time: 960,
        start_date: "2026-09-12T07:03:20Z",
        start_date_local: "2026-09-12T08:03:20Z",
        distance: 750,
        start_index: 961,
        end_index: 1920,
        lap_index: 2,
      },
    ],
  },
  streams: {
    time: stream("time", [0, 960, 1920]),
    distance: stream("distance", [0, 750, 1500]),
    heartrate: stream("heartrate", [118, 131, 140]),
  },
  comments: [],
  kudoers: [],
};

/** An indoor workout on a wrist sensor: no distance, no GPS, heart rate only. */
const STRENGTH_SESSION: FakeActivity = {
  summary: listed({
    id: 9100000004,
    name: "Lunch strength session",
    type: "WeightTraining",
    sport_type: "WeightTraining",
    distance: 0,
    moving_time: 2700,
    elapsed_time: 3000,
    total_elevation_gain: 0,
    trainer: true,
    has_heartrate: true,
    average_heartrate: 118,
    max_heartrate: 149,
    start_date: "2026-09-13T11:00:00Z",
    start_date_local: "2026-09-13T12:00:00Z",
  }),
  detail: { description: null, calories: 310, device_name: "Fixture wrist HR" },
  streams: {
    time: stream("time", [0, 1350, 2700]),
    heartrate: stream("heartrate", [96, 131, 112]),
  },
  comments: [],
  kudoers: [],
};

/** A run uploaded after the source has settled: a watch synced late. */
const LATE_UPLOAD = gpsRun({
  id: 9100000005,
  name: "Hill repeats",
  startDate: "2026-09-21T06:30:00Z",
  description: "Six times up the long drag.",
  kudoers: [{ firstname: "Jamie", lastname: "L.", resource_state: 2 }],
});

const FIRST_SYNC = [RUN, MANUAL_WALK, POOL_SWIM, STRENGTH_SESSION];
const EVERY_ACTIVITY = [...FIRST_SYNC, LATE_UPLOAD];
const idOf = (activity: FakeActivity) => String(activity.summary.id);

const SHOE = {
  id: SHOE_ID,
  primary: true,
  name: "Tempo trainers",
  nickname: null,
  resource_state: 3,
  distance: 182_000,
  brand_name: "Stellar",
  model_name: "T3",
  description: null,
  retired: false,
};

const STATS = {
  biggest_ride_distance: null,
  biggest_climb_elevation_gain: null,
  recent_run_totals: { count: 2, distance: 6000, moving_time: 1800, elapsed_time: 1860 },
  ytd_run_totals: { count: 41, distance: 182_000, moving_time: 61_000, elapsed_time: 63_000 },
  all_run_totals: { count: 210, distance: 980_000, moving_time: 330_000, elapsed_time: 341_000 },
};

/** The athlete's heart-rate zones, as Strava serves them. */
const ATHLETE_ZONES = {
  heart_rate: {
    custom_zones: false,
    zones: [
      { min: 0, max: 123 },
      { min: 123, max: 153 },
      { min: 153, max: 169 },
      { min: 169, max: 184 },
      { min: 184, max: -1 },
    ],
  },
};

/** A non-subscriber, and how their Strava answers the endpoints that hold zones. */
interface NonSubscriber {
  label: string;
  /** What `/athlete` says of Summit; `undefined` leaves the field out. */
  summit: false | undefined;
  /** What `/athlete` says in `premium`, Summit's older name; `undefined` leaves it out. */
  premium: false | undefined;
  /**
   * The answer to an activity's zones: refused, or served as these zones,
   * which hold nothing a row can be made of.
   */
  activityZones: 402 | 403 | { served: unknown[] };
  /** How `/athlete/zones` answers: served, or refused should Strava ever refuse it. */
  athleteZones: 402 | 403 | 200;
}

const NON_SUBSCRIBERS: NonSubscriber[] = [
  {
    label: "summit false, every zone refused with 402",
    summit: false,
    premium: false,
    activityZones: 402,
    athleteZones: 402,
  },
  {
    label: "summit false, every zone refused with 403",
    summit: false,
    premium: false,
    activityZones: 403,
    athleteZones: 403,
  },
  {
    label: "summit false, athlete zones served",
    summit: false,
    premium: false,
    activityZones: 402,
    athleteZones: 200,
  },
  {
    label: "summit absent, every zone refused with 402",
    summit: undefined,
    premium: undefined,
    activityZones: 402,
    athleteZones: 402,
  },
  {
    label: "summit absent, every zone refused with 403",
    summit: undefined,
    premium: undefined,
    activityZones: 403,
    athleteZones: 403,
  },
  {
    label: "summit absent, athlete zones served",
    summit: undefined,
    premium: undefined,
    activityZones: 403,
    athleteZones: 200,
  },
  {
    label: "summit absent, premium false",
    summit: undefined,
    premium: false,
    activityZones: 403,
    athleteZones: 403,
  },
  {
    label: "summit absent, activity zones served without their distribution",
    summit: undefined,
    premium: undefined,
    activityZones: {
      served: [
        { type: "heartrate", score: 0, sensor_based: true, resource_state: 3 },
        { type: "power", sensor_based: false, resource_state: 3 },
      ],
    },
    athleteZones: 403,
  },
  {
    label: "summit absent, activity zones served with a null distribution",
    summit: undefined,
    premium: undefined,
    activityZones: { served: [{ type: "heartrate", distribution_buckets: null }] },
    athleteZones: 403,
  },
  {
    label: "summit absent, activity zones served without a type",
    summit: undefined,
    premium: undefined,
    activityZones: {
      served: [{ type: null, distribution_buckets: [{ min: 0, max: 123, time: 600 }] }],
    },
    athleteZones: 403,
  },
  {
    label: "summit absent, activity zones served with buckets without a time",
    summit: undefined,
    premium: undefined,
    activityZones: {
      served: [
        {
          type: "heartrate",
          distribution_buckets: [
            { min: 0, max: 123 },
            { min: 123, max: 153, time: null },
            { min: 153, max: -1, time: "unknown" },
          ],
        },
      ],
    },
    athleteZones: 403,
  },
];

/** Whether the source asks for this profile's activity zones: only while Summit is unknown. */
const zonesAskedOf = (profile: NonSubscriber) => (profile.summit ?? profile.premium) === undefined;

/**
 * The answer to every data request of an API application Strava has
 * deactivated: the application refused, not the athlete or the activity.
 */
const APPLICATION_INACTIVE = {
  message: "Forbidden",
  errors: [{ resource: "Application", field: "Status", code: "Inactive" }],
};

/**
 * Strava, as a fetch answering one non-subscriber. Every response carries the
 * rate-limit headers Strava sends, counted per 15-minute and per daily window
 * of the (faked) clock against a new app's limits, so the client's tracker
 * gates pages on usage it has observed, as in production.
 */
class FakeStrava {
  /** Every path the client asked for, in order, without its query. */
  readonly requests: string[] = [];
  /** Paths this Strava had no answer for. */
  readonly unexpected: string[] = [];
  /** The athlete's activities, as uploaded so far. */
  readonly activities: FakeActivity[];
  private readonly usage = new Map<string, number>();
  /** Requests answered before the application is deactivated; unbounded while it is active. */
  private answeredBeforeDeactivation = Infinity;

  constructor(
    private readonly profile: NonSubscriber,
    activities: FakeActivity[],
  ) {
    this.activities = [...activities];
  }

  /** An activity uploaded since the last sync. */
  upload(activity: FakeActivity): void {
    this.activities.push(activity);
  }

  /**
   * The application's owner has let the subscription lapse: Strava answers
   * `answered` more requests, then deactivates the application and refuses
   * every request after them.
   */
  deactivate(answered = 0): void {
    this.answeredBeforeDeactivation = answered;
  }

  /** The owner has subscribed again and reactivated the application. */
  reactivate(): void {
    this.answeredBeforeDeactivation = Infinity;
  }

  client(): StravaClient {
    return new StravaClient({
      // Outlives every clock the test sets, so no request refreshes it.
      tokens: {
        access_token: "fixture",
        refresh_token: "fixture",
        expires_at: 4_000_000_000,
        athlete_id: ATHLETE_ID,
        athlete_firstname: ATHLETE.firstname,
        athlete_lastname: ATHLETE.lastname,
      },
      credentials: { client_id: "fixture", client_secret: "fixture" },
      fetchFn: (url) => Promise.resolve(this.answer(new URL(url))),
    });
  }

  private answer(url: URL): Response {
    const path = url.pathname.replace(/^\/api\/v3/, "");
    this.requests.push(path);
    const headers = { "Content-Type": "application/json", ...this.meter() };
    const reply = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    const refused = (status: 402 | 403) =>
      reply({ message: `refused (${status})`, errors: [] }, status);

    // Counted and metered like any other request, as the rate-limit headers
    // it carries say it is.
    if (this.answeredBeforeDeactivation-- <= 0) return reply(APPLICATION_INACTIVE, 403);
    if (path === "/athlete/activities") return reply(this.list(url.searchParams));
    if (path === "/athlete") return reply(this.athlete());
    if (path === "/athlete/zones") {
      const answer = this.profile.athleteZones;
      return answer === 200 ? reply(ATHLETE_ZONES) : refused(answer);
    }
    if (path === `/athletes/${ATHLETE_ID}/stats`) return reply(STATS);
    if (path === `/gear/${SHOE_ID}`) return reply(SHOE);

    const match = /^\/activities\/(\d+)(?:\/(comments|kudos|zones|streams))?$/.exec(path);
    const activity = match && this.activities.find((a) => idOf(a) === match[1]);
    if (match && activity) {
      // Every list here fits its first page.
      const firstPage = Number(url.searchParams.get("page") ?? 1) === 1;
      switch (match[2]) {
        case undefined:
          return reply({
            ...activity.summary,
            resource_state: 3,
            perceived_exertion: null,
            prefer_perceived_exertion: null,
            available_zones: [],
            photos: { primary: null, count: 0 },
            ...activity.detail,
          });
        case "comments":
          return reply(firstPage ? activity.comments : []);
        case "kudos":
          return reply(firstPage ? activity.kudoers : []);
        case "zones": {
          // Kept for subscribers: one refusal per activity asked, or zones
          // with nothing in them.
          const answer = this.profile.activityZones;
          return typeof answer === "number" ? refused(answer) : reply(answer.served);
        }
        case "streams":
          return activity.streams
            ? reply(activity.streams)
            : reply({ message: "not found", errors: [] }, 404);
      }
    }
    this.unexpected.push(path);
    return reply({ message: "not found", errors: [] }, 404);
  }

  /** The athlete. Summit and premium as the profile says, or not mentioned at all. */
  private athlete(): Record<string, unknown> {
    const { summit, premium } = this.profile;
    return {
      id: ATHLETE_ID,
      resource_state: 3,
      ...ATHLETE,
      city: "Exampleton",
      sex: "F",
      ...(premium !== undefined && { premium }),
      ...(summit !== undefined && { summit }),
      created_at: "2021-04-02T10:00:00Z",
      updated_at: "2026-09-01T10:00:00Z",
      weight: 61.5,
      ftp: null,
      measurement_preference: "meters",
      bikes: [],
      shoes: [{ id: SHOE_ID, primary: true, name: "Tempo trainers", resource_state: 2 }],
    };
  }

  /**
   * The athlete's activities as Strava lists them: `before` exclusive, `after`
   * inclusive at the second, so the newest activity comes round again on every
   * steady listing (the source's listing allows for it), oldest first when only
   * `after` is given and newest first otherwise, paged.
   */
  private list(query: URLSearchParams): Record<string, unknown>[] {
    const startOf = (a: FakeActivity) => Date.parse(String(a.summary.start_date)) / 1000;
    const before = Number(query.get("before") ?? Infinity);
    const after = Number(query.get("after") ?? -Infinity);
    const oldestFirst = query.has("after") && !query.has("before");
    const page = Number(query.get("page") ?? 1);
    const perPage = Number(query.get("per_page") ?? 30);
    return this.activities
      .filter((a) => startOf(a) < before && startOf(a) >= after)
      .sort((x, y) => (oldestFirst ? startOf(x) - startOf(y) : startOf(y) - startOf(x)))
      .slice((page - 1) * perPage, page * perPage)
      .map((a) => a.summary);
  }

  /** This request counted in its windows, as the usage headers report it. */
  private meter(): Record<string, string> {
    const now = Date.now();
    const short = this.count(`short:${Math.floor(now / QUARTER_HOUR_MS)}`);
    const daily = this.count(`daily:${Math.floor(now / DAY_MS)}`);
    return {
      "X-RateLimit-Limit": "200,2000",
      "X-RateLimit-Usage": `${short},${daily}`,
      "X-ReadRateLimit-Limit": "100,1000",
      "X-ReadRateLimit-Usage": `${short},${daily}`,
    };
  }

  private count(window: string): number {
    const n = (this.usage.get(window) ?? 0) + 1;
    this.usage.set(window, n);
    return n;
  }
}

// ── The host's store ─────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

/** The tables the source declares, by name, for their keys. */
const SCHEMAS = new Map(allSchemas.map((schema) => [schema.tableName, schema]));

/** A row's key over `columns`, as a string adjacent values cannot forge. */
function keyOf(row: Row, columns: readonly string[]): string {
  return columns.map((column) => String(row[column] ?? "\u0000")).join("\u0001");
}

/** A value as one string whatever order its object keys were written in. */
function stable(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          )
        : v,
    ) ?? "undefined"
  );
}

/**
 * The analytics store the host keeps for this source, in memory.
 *
 * Every table the source declares exists from the start, empty, as the
 * collector registers them when it starts. A page's writes are applied as the
 * host applies them: in the order given, and within one write the rows first
 * and the deletions after, each row replacing the whole stored row its primary
 * key names. A snapshot's `presentKeys` delete nothing here — the gateway
 * records an omission as an absence rather than deleting at once — but every
 * stored row a snapshot leaves out is noted in `absent`. A page carrying a row
 * without a value for a column its table holds NOT NULL is refused whole, as
 * the host refuses it, which fails the page.
 *
 * It answers the SQL the phases read with, which the read handle takes as
 * text: one table, a WHERE of `=`, `IS [NOT] NULL`, `[NOT] IN (…)`, AND, OR
 * and parentheses, an ORDER BY and a LIMIT. Anything else it refuses and notes
 * in `unanswered`, so a read it cannot answer fails the test rather than
 * quietly reading as empty — several of the source's reads take a failure for
 * "nothing stored", and the Summit read takes it for "ask for zones".
 */
class FakeAnalytics implements SourceAnalyticsAccess {
  readonly documents = new Map<string, DocumentInput>();
  readonly unanswered: string[] = [];
  readonly absent: string[] = [];
  private readonly tables = new Map<string, Map<string, Row>>(
    allSchemas.map((schema) => [schema.tableName, new Map()]),
  );

  rows(tableName: string): Row[] {
    return [...(this.tables.get(tableName)?.values() ?? [])];
  }

  /** Everything stored, as one string: a page that moved nothing leaves it as it was. */
  fingerprint(): string {
    const sorted = <T>(entries: Iterable<[string, T]>) =>
      [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return stable({
      tables: sorted(this.tables).map(([name, rows]) => [name, sorted(rows)]),
      documents: sorted(this.documents),
    });
  }

  /** What is stored, as `fingerprint` has it, less when each part was fetched. */
  contents(): string {
    return this.fingerprint().replace(/"(\w*fetched_at)":"[^"]*"/g, '"$1":"(when)"');
  }

  apply(page: StructuredSyncResult<StravaActivitiesCursor>): void {
    for (const write of tableWrites(page.analytics)) {
      const schema = SCHEMAS.get(write.tableName);
      if (!schema) throw new Error(`A write to undeclared table ${write.tableName}`);
      if (write.deletedIds?.length || write.presentIds)
        throw new Error(`${write.tableName}: the deprecated id lists are not modelled`);
      for (const record of write.records ?? []) {
        const missing = schema.columns
          .filter((column) => !column.nullable && (record[column.name] ?? null) === null)
          .map((column) => column.name);
        if (missing.length > 0)
          throw new Error(`${write.tableName} refuses a row without ${missing.join(", ")}`);
      }
    }
    for (const write of tableWrites(page.analytics)) {
      const schema = SCHEMAS.get(write.tableName)!;
      const table = this.tables.get(write.tableName)!;
      for (const record of write.records ?? [])
        table.set(keyOf(record, schema.primaryKey), { ...record });
      const deleteKey = analyticsDeleteKey(schema);
      for (const key of write.deletedKeys ?? [])
        for (const [stored, row] of table)
          if (keyOf(row, deleteKey) === keyOf(key, deleteKey)) table.delete(stored);
      if (write.presentKeys) {
        const present = new Set(write.presentKeys.map((key) => keyOf(key, deleteKey)));
        for (const row of table.values())
          if (!present.has(keyOf(row, deleteKey)))
            this.absent.push(`${write.tableName} ${keyOf(row, deleteKey)}`);
      }
    }
    for (const doc of page.documents ?? []) this.documents.set(doc.externalId, doc);
  }

  query(sql: string): Promise<{ columns: string[]; rows: Row[] }> {
    try {
      return Promise.resolve(this.select(sql));
    } catch (err) {
      this.unanswered.push(`${sql} — ${(err as Error).message}`);
      return Promise.reject(err as Error);
    }
  }

  private select(sql: string): { columns: string[]; rows: Row[] } {
    const parsed =
      /^SELECT\s+(?<projection>.+?)\s+FROM\s+(?<table>\w+)(?:\s+WHERE\s+(?<where>.+?))?(?:\s+ORDER BY\s+(?<order>.+?))?(?:\s+LIMIT\s+(?<limit>\d+))?\s*$/is.exec(
        sql,
      )?.groups;
    if (!parsed) throw new Error("not a single-table SELECT");
    const table = this.tables.get(parsed.table!);
    if (!table) throw new Error(`no table ${parsed.table}`);
    const where = parsed.where ? predicate(tokenize(parsed.where)) : () => true;
    let rows = [...table.values()].filter(where);

    const projection = parsed.projection!.trim();
    const counted = /^count\(\*\)\s+AS\s+(\w+)$/i.exec(projection);
    if (counted) return { columns: [counted[1]!], rows: [{ [counted[1]!]: rows.length }] };

    for (const term of (parsed.order ?? "").split(",").reverse()) {
      const [column, direction] = term.trim().split(/\s+/);
      if (!column) continue;
      const sign = direction?.toUpperCase() === "DESC" ? -1 : 1;
      rows = rows.sort((a, b) => sign * compare(a[column], b[column]));
    }
    if (parsed.limit) rows = rows.slice(0, Number(parsed.limit));

    const distinct = /^DISTINCT\s+(\w+)$/i.exec(projection);
    if (distinct) {
      const column = distinct[1]!;
      const values = [...new Set(rows.map((row) => row[column]))];
      return { columns: [column], rows: values.map((value) => ({ [column]: value })) };
    }
    if (projection === "*") return { columns: [], rows: rows.map((row) => ({ ...row })) };
    const columns = projection.split(",").map((column) => column.trim());
    if (!columns.every((column) => /^\w+$/.test(column)))
      throw new Error(`projection ${projection}`);
    return {
      columns,
      rows: rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null]))),
    };
  }
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const [x, y] = [String(a ?? ""), String(b ?? "")];
  return x < y ? -1 : x > y ? 1 : 0;
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const token = /\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?|\w+|[(),=])/y;
  while (text.slice(token.lastIndex).trim()) {
    const match = token.exec(text);
    if (!match) throw new Error(`cannot read the WHERE at "${text.slice(token.lastIndex)}"`);
    tokens.push(match[1]!);
  }
  return tokens;
}

/** A WHERE clause's tokens as a predicate on a row, with SQL's NULL semantics. */
function predicate(tokens: string[]): Predicate {
  let at = 0;
  const peek = () => tokens[at]?.toUpperCase();
  const take = (expected?: string): string => {
    const t = tokens[at++];
    if (t === undefined || (expected !== undefined && t.toUpperCase() !== expected))
      throw new Error(`expected ${expected ?? "more"} at "${t ?? "the end"}"`);
    return t;
  };
  const literal = (): unknown => {
    const t = take();
    if (/^TRUE$/i.test(t)) return true;
    if (/^FALSE$/i.test(t)) return false;
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^-?\d/.test(t)) return Number(t);
    throw new Error(`not a literal: ${t}`);
  };
  const equals = (stored: unknown, value: unknown) =>
    stored !== null &&
    stored !== undefined &&
    (typeof value === "boolean"
      ? stored === value
      : typeof value === "number"
        ? Number(stored) === value
        : String(stored) === value);
  const comparison = (): Predicate => {
    if (peek() === "(") {
      take("(");
      const inner = disjunction();
      take(")");
      return inner;
    }
    const column = take();
    if (!/^[a-z_]\w*$/i.test(column)) throw new Error(`not a column: ${column}`);
    if (peek() === "IS") {
      take("IS");
      const negated = peek() === "NOT";
      if (negated) take("NOT");
      take("NULL");
      return (row) => (row[column] === null || row[column] === undefined) !== negated;
    }
    const negated = peek() === "NOT";
    if (negated) take("NOT");
    if (peek() === "IN") {
      take("IN");
      take("(");
      const values = [literal()];
      while (peek() === ",") {
        take(",");
        values.push(literal());
      }
      take(")");
      return (row) =>
        row[column] !== null &&
        row[column] !== undefined &&
        values.some((value) => equals(row[column], value)) !== negated;
    }
    if (negated) throw new Error("NOT before something other than IN");
    take("=");
    const value = literal();
    return (row) => equals(row[column], value);
  };
  const conjunction = (): Predicate => {
    const terms = [comparison()];
    while (peek() === "AND") {
      take("AND");
      terms.push(comparison());
    }
    return (row) => terms.every((term) => term(row));
  };
  function disjunction(): Predicate {
    const terms = [conjunction()];
    while (peek() === "OR") {
      take("OR");
      terms.push(conjunction());
    }
    return (row) => terms.some((term) => term(row));
  }
  const whole = disjunction();
  if (at !== tokens.length) throw new Error(`left unread: ${tokens.slice(at).join(" ")}`);
  return whole;
}

// ── The source's life ────────────────────────────────────────────────

type Stage =
  | "first sync"
  | "steady"
  | "a week later"
  | "a new activity"
  | "deactivated"
  | "reactivated";

/** What one page did. */
interface PageReport {
  stage: Stage;
  /** The phase the page was handed; a null cursor starts the backfill. */
  phaseIn: string;
  phaseOut?: string;
  hasMore?: boolean;
  /** Paths of the Strava requests the page made. */
  requests: string[];
  cursorMoved?: boolean;
  storeMoved?: boolean;
  error?: unknown;
}

/**
 * A page of a settled source: a listing that found nothing new, wrote nothing
 * and moved nothing, and leaves the cursor where the next tick does the same.
 */
function isBareListing(page: PageReport): boolean {
  return (
    page.phaseIn === "incremental" &&
    page.phaseOut === "incremental" &&
    page.hasMore === false &&
    page.cursorMoved === false &&
    page.storeMoved === false &&
    page.requests.length === 1 &&
    page.requests[0] === "/athlete/activities"
  );
}

/**
 * The source driven page by page as the collector drives it: each page handed
 * the cursor the last returned, and its writes applied to the store before the
 * next runs. Whatever `hasMore` says, the next page runs a minute later — the
 * tick a `false` ends is followed by the next one — so the driver needs no
 * notion of ticks, and a page that says it has more yet moved nothing is
 * caught by its report rather than by a hang.
 */
class Lifecycle {
  cursor: StravaActivitiesCursor | null = null;
  readonly pages: PageReport[] = [];
  /** The cursor as each stage left it. */
  readonly leftAt = new Map<Stage, StravaActivitiesCursor | null>();

  constructor(
    private readonly source: StravaActivitiesSource,
    readonly store: FakeAnalytics,
    readonly strava: FakeStrava,
  ) {}

  async page(stage: Stage): Promise<PageReport> {
    const cursorBefore = stable(this.cursor);
    const storeBefore = this.store.fingerprint();
    const asked = this.strava.requests.length;
    const report: PageReport = {
      stage,
      phaseIn: this.cursor?.phase ?? "backfill",
      requests: [],
    };
    try {
      const result = await this.source.syncStructured(this.cursor);
      this.store.apply(result);
      this.cursor = result.cursor;
      report.phaseOut = result.cursor.phase;
      report.hasMore = result.hasMore;
      report.cursorMoved = stable(result.cursor) !== cursorBefore;
      report.storeMoved = this.store.fingerprint() !== storeBefore;
    } catch (err) {
      report.error = err;
    }
    report.requests = this.strava.requests.slice(asked);
    this.pages.push(report);
    vi.setSystemTime(Date.now() + PAGE_GAP_MS);
    return report;
  }

  /**
   * Pages until two in a row are bare listings, a page throws, or the stage
   * runs out of pages.
   */
  async settle(stage: Stage): Promise<void> {
    let bare = 0;
    for (let n = 0; n < STAGE_PAGE_LIMIT && bare < 2; n++) {
      const report = await this.page(stage);
      if (report.error !== undefined) break;
      bare = isBareListing(report) ? bare + 1 : 0;
    }
    this.leftAt.set(stage, this.cursor);
  }

  /** Pages until the cursor is in `phase`, which a null cursor's backfill is. */
  async pageUntil(stage: Stage, phase: string): Promise<void> {
    for (let n = 0; (this.cursor?.phase ?? "backfill") !== phase; n++) {
      if (n === STAGE_PAGE_LIMIT) throw new Error(`${stage}: never reached ${phase}`);
      const report = await this.page(stage);
      if (report.error !== undefined) throw report.error;
    }
  }

  pagesOf(stage: Stage): PageReport[] {
    return this.pages.filter((page) => page.stage === stage);
  }

  requestsOf(stage: Stage): string[] {
    return this.pagesOf(stage).flatMap((page) => page.requests);
  }
}

/** A source added at `ADDED_AT` for an athlete with these activities, before its first page. */
function added(profile: NonSubscriber, activities: FakeActivity[]): Lifecycle {
  vi.setSystemTime(ADDED_AT);
  const strava = new FakeStrava(profile, activities);
  const store = new FakeAnalytics();
  const source = new StravaActivitiesSource(
    strava.client(),
    SourceId(`strava-activities:${ATHLETE_ID}`),
    ProviderId(`strava:${ATHLETE_ID}`),
    undefined,
    ATHLETE_NAME,
    ATHLETE_ID,
    store,
  );
  return new Lifecycle(source, store, strava);
}

/** The four stages of a non-subscriber's source, from the first sync on. */
async function livedThrough(profile: NonSubscriber): Promise<Lifecycle> {
  const life = added(profile, FIRST_SYNC);
  const strava = life.strava;

  await life.settle("first sync");
  for (let tick = 0; tick < 4; tick++) {
    vi.setSystemTime(Date.now() + SYNC_INTERVAL_MS);
    await life.page("steady");
  }
  vi.setSystemTime(WEEK_LATER);
  await life.settle("a week later");
  strava.upload(LATE_UPLOAD);
  await life.settle("a new activity");
  return life;
}

/** How many times each value occurs. */
function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** The enrichment requests one activity costs: one of each, zones only when asked. */
function enrichmentOf(activity: FakeActivity, zonesAsked: boolean): Record<string, number> {
  const id = idOf(activity);
  return {
    [`/activities/${id}`]: 1,
    [`/activities/${id}/comments`]: 1,
    [`/activities/${id}/kudos`]: 1,
    [`/activities/${id}/streams`]: 1,
    ...(zonesAsked && { [`/activities/${id}/zones`]: 1 }),
  };
}

const isActivityRequest = (path: string) => path.startsWith("/activities/");

describe.each(NON_SUBSCRIBERS)("an athlete without a subscription: $label", (profile) => {
  /** Only an absent Summit leaves the zones worth asking for. */
  const zonesAsked = zonesAskedOf(profile);
  /** Served, the zones are fetched, though there is nothing in them to store. */
  const zonesServed = typeof profile.activityZones !== "number";
  let life: Lifecycle;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    life = await livedThrough(profile);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  test("every page resolves", () => {
    expect(
      life.pages
        .filter((page) => page.error !== undefined)
        .map((page) => `${page.stage}, ${page.phaseIn}: ${String(page.error)}`),
    ).toEqual([]);
  });

  test("no page asks to run again without moving its cursor or the store", () => {
    // A page that says it has more is fetched again at once (the runner's
    // loop). The tier pages say so with their cursor unchanged — their
    // progress is the stamps they write, which the next page's selection
    // reads — so the cursor alone cannot tell progress from a spin. A page
    // that moved neither would be asked the same question with the same
    // answer until the tick timed out.
    expect(
      life.pages
        .filter((page) => page.hasMore && !page.cursorMoved && !page.storeMoved)
        .map((page) => `${page.stage}: ${page.phaseIn}`),
    ).toEqual([]);
  });

  test("the first sync walks every phase once and settles in incremental", () => {
    const first = life.pagesOf("first sync");
    const walked = first
      .map((page) => page.phaseIn)
      .filter((phase, i, phases) => phase !== phases[i - 1]);
    expect(walked).toEqual([
      "backfill",
      "athlete-refresh",
      "detail-backfill",
      "social-backfill",
      "zones-backfill",
      "streams-backfill",
      "incremental",
    ]);
    // Four activities fit one page of every tier, so the walk is a dozen-odd
    // pages; the bound leaves room without letting a loop through.
    expect(first.length).toBeLessThanOrEqual(20);
    expect(first.slice(-2).every(isBareListing)).toBe(true);
  });

  test("the activity zones Strava keeps for subscribers are asked for at most once each", () => {
    const zoneRequests = life.strava.requests.filter((path) =>
      /^\/activities\/\d+\/zones$/.test(path),
    );
    const activities = life.store.rows("strava_activities");
    if (!zonesAsked) {
      // A stored profile without Summit skips the tier: not one read.
      expect(zoneRequests).toEqual([]);
      // Left pending for a refresh that finds Summit, and holding nothing back.
      for (const row of activities) expect(row.zones_unavailable ?? null).toBeNull();
    } else {
      // Summit unknown: each activity is asked once, and its refusal, or
      // zones with nothing to store, stamped so it is never asked again — the
      // later upload included.
      expect(tally(zoneRequests)).toEqual(
        Object.fromEntries(EVERY_ACTIVITY.map((a) => [`/activities/${idOf(a)}/zones`, 1])),
      );
      for (const row of activities)
        expect(row, String(row.id)).toMatchObject({
          // A 200 is no refusal: fetched, with nothing in it, not unavailable.
          zones_unavailable: zonesServed ? null : true,
          zones_fetched_at: expect.any(String),
        });
    }
    // Nothing a zone row can be made of: neither a refusal nor these zones.
    expect(life.store.rows("strava_activity_zones")).toEqual([]);
  });

  test("every activity ends with its detail, social and streams fetched and stamped", () => {
    const activities = life.store.rows("strava_activities");
    expect(activities.map((row) => String(row.id)).sort()).toEqual(EVERY_ACTIVITY.map(idOf).sort());
    for (const row of activities)
      expect(row, String(row.id)).toMatchObject({
        detail_fetched_at: expect.any(String),
        social_fetched_at: expect.any(String),
        streams_fetched_at: expect.any(String),
        // Never sent to a non-subscriber, and never invented.
        suffer_score: null,
        perceived_exertion: null,
      });

    const childrenOf = (table: string) =>
      tally(life.store.rows(table).map((row) => String(row.activity_id)));
    const [run, swim, strength, late] = [RUN, POOL_SWIM, STRENGTH_SESSION, LATE_UPLOAD].map(idOf);
    expect(childrenOf("strava_activity_splits")).toEqual({ [run!]: 3, [late!]: 3 });
    // The swim has none, and the manual walk no efforts of any kind.
    expect(childrenOf("strava_activity_best_efforts")).toEqual({ [run!]: 2, [late!]: 2 });
    expect(childrenOf("strava_activity_laps")).toEqual({ [run!]: 1, [swim!]: 2, [late!]: 1 });
    expect(childrenOf("strava_activity_segment_efforts")).toEqual({ [run!]: 1, [late!]: 1 });
    // Every activity but the manual walk, whose 404 is marked done instead.
    expect(childrenOf("strava_activity_streams")).toEqual({
      [run!]: 1,
      [swim!]: 1,
      [strength!]: 1,
      [late!]: 1,
    });
    expect(childrenOf("strava_activity_comments")).toEqual({ [run!]: 1 });
    expect(childrenOf("strava_activity_kudos")).toEqual({ [run!]: 2, [late!]: 1 });
  });

  test("every document renders what Strava did serve, without the zones it refused", () => {
    const content = (activity: FakeActivity) =>
      life.store.documents.get(idOf(activity))?.content ?? "";
    expect([...life.store.documents.keys()].sort()).toEqual(EVERY_ACTIVITY.map(idOf).sort());

    expect(content(RUN)).toContain("> Easy first half, pushed the last kilometre.");
    expect(content(RUN)).toContain("**Top results:**");
    expect(content(RUN)).toContain("> **Sarah M.:** Strong finish!");
    expect(content(RUN)).toContain("_Kudos from: Jamie L., David K._");
    expect(content(RUN)).toContain("**Gear:** Stellar T3");
    expect(content(MANUAL_WALK)).toContain("> Logged by hand after dinner.");
    expect(content(MANUAL_WALK)).toContain("manually logged");
    expect(content(POOL_SWIM)).toContain("> Drills, then ten hundreds.");
    expect(content(POOL_SWIM)).not.toContain("Top results");
    expect(content(STRENGTH_SESSION)).toContain("indoor trainer");
    expect(content(STRENGTH_SESSION)).toContain("**Calories:** 310");
    expect(content(LATE_UPLOAD)).toContain("> Six times up the long drag.");
    expect(content(LATE_UPLOAD)).toContain("_Kudos from: Jamie L._");
    for (const doc of life.store.documents.values()) {
      expect(doc.content, doc.externalId).not.toContain("Perceived exertion");
      expect(doc.metadata?.extra?.perceivedExertion, doc.externalId).toBeUndefined();
    }
  });

  test("both athlete refreshes complete whether /athlete/zones is refused or served", () => {
    const first = life.leftAt.get("first sync")?.lastAthleteRefreshAt;
    const weekly = life.leftAt.get("a week later")?.lastAthleteRefreshAt;
    expect(first).toEqual(expect.any(String));
    expect(weekly).toEqual(expect.any(String));
    expect(Date.parse(weekly!)).toBeGreaterThanOrEqual(WEEK_LATER.getTime());
    expect(life.store.rows("strava_athlete")).toEqual([
      expect.objectContaining({
        id: ATHLETE_ID,
        summit: profile.summit ?? null,
        premium: profile.premium ?? null,
      }),
    ]);
    expect(life.store.rows("strava_athlete_stats")).toHaveLength(3);
    expect(life.store.rows("strava_gear")).toEqual([
      expect.objectContaining({ id: SHOE_ID, brand_name: "Stellar", model_name: "T3" }),
    ]);
    expect(life.store.rows("strava_athlete_zones")).toHaveLength(
      profile.athleteZones === 200 ? ATHLETE_ZONES.heart_rate.zones.length : 0,
    );
  });

  test("a settled source spends one listing a tick and nothing else", () => {
    const steady = life.pagesOf("steady");
    expect(steady).toHaveLength(4);
    expect(steady.filter((page) => !isBareListing(page))).toEqual([]);
  });

  test("a week later the walks and the refresh run, and ask the activities for nothing again", () => {
    const week = life.pagesOf("a week later");
    expect(week.length).toBeLessThanOrEqual(10);
    expect(week.slice(-2).every(isBareListing)).toBe(true);
    expect(life.requestsOf("a week later").filter(isActivityRequest)).toEqual([]);
    expect(tally(life.requestsOf("a week later"))).toMatchObject({
      "/athlete": 1,
      "/athlete/zones": 1,
      [`/athletes/${ATHLETE_ID}/stats`]: 1,
      [`/gear/${SHOE_ID}`]: 1,
    });
    // Nothing the rewalk enumerated went missing from its snapshot.
    expect(life.store.absent).toEqual([]);
  });

  test("an activity uploaded later is enriched once, tier by tier, and the source settles again", () => {
    const later = life.pagesOf("a new activity");
    expect(later.length).toBeLessThanOrEqual(14);
    expect(later.slice(-2).every(isBareListing)).toBe(true);
    expect(tally(life.requestsOf("a new activity").filter(isActivityRequest))).toEqual(
      enrichmentOf(LATE_UPLOAD, zonesAsked),
    );
  });

  test("over its whole life Strava is asked for each thing once, and lists one page at a time", () => {
    const listing = "/athlete/activities";
    const everythingElse = life.strava.requests.filter((path) => path !== listing);
    expect(tally(everythingElse)).toEqual({
      // Two refreshes: the first sync's and the weekly one.
      "/athlete": 2,
      "/athlete/zones": 2,
      [`/athletes/${ATHLETE_ID}/stats`]: 2,
      [`/gear/${SHOE_ID}`]: 2,
      ...Object.fromEntries(
        EVERY_ACTIVITY.flatMap((a) => Object.entries(enrichmentOf(a, zonesAsked))),
      ),
    });
    // No page lists twice, so the listings are bounded by the pages.
    for (const page of life.pages)
      expect(page.requests.filter((path) => path === listing).length).toBeLessThanOrEqual(1);
    expect(life.strava.unexpected).toEqual([]);
  });

  test("the store answered every read the source made", () => {
    expect(life.store.unanswered).toEqual([]);
  });
});

// ── The application's owner without a subscription ──────────────────

/** The point at which the application is deactivated, and what is refused first. */
interface Deactivation {
  label: string;
  /** Drives the source to the page that meets the deactivation. */
  reach: (life: Lifecycle) => Promise<void>;
  /** How many requests are still answered before the refusals start. */
  answered: number;
  /** The path of the first request it refuses. */
  refuses: string;
}

/** The first sync, then a source settled `elapsed` later. */
function settledFor(elapsed: number): Deactivation["reach"] {
  return async (life) => {
    await life.settle("first sync");
    vi.setSystemTime(Date.now() + elapsed);
  };
}

const [walk, swim, late] = [MANUAL_WALK, POOL_SWIM, LATE_UPLOAD].map(idOf);

/**
 * Each point of the source's life the deactivation can meet, from a page's
 * first request or partway through it. The tiers take the newest activity
 * first: the strength session, the swim, the walk, then the run.
 */
const DEACTIVATIONS: Deactivation[] = [
  {
    label: "the first listing",
    reach: async () => {},
    answered: 0,
    refuses: "/athlete/activities",
  },
  ...["/athlete", `/athletes/${ATHLETE_ID}/stats`, "/athlete/zones", `/gear/${SHOE_ID}`].map(
    (refuses, answered) => ({
      label: `the athlete refresh, at ${refuses}`,
      reach: (life: Lifecycle) => life.pageUntil("first sync", "athlete-refresh"),
      answered,
      refuses,
    }),
  ),
  {
    label: "the detail tier, two activities in",
    reach: (life) => life.pageUntil("first sync", "detail-backfill"),
    answered: 2,
    refuses: `/activities/${walk}`,
  },
  {
    label: "the social tier, between an activity's comments and its kudos",
    reach: (life) => life.pageUntil("first sync", "social-backfill"),
    answered: 3,
    refuses: `/activities/${swim}/kudos`,
  },
  {
    label: "the zones tier, after Strava refused one activity's zones as a subscriber's",
    reach: (life) => life.pageUntil("first sync", "zones-backfill"),
    answered: 1,
    refuses: `/activities/${swim}/zones`,
  },
  {
    label: "the streams tier, two activities in",
    reach: (life) => life.pageUntil("first sync", "streams-backfill"),
    answered: 2,
    refuses: `/activities/${walk}/streams`,
  },
  {
    label: "a settled source's listing",
    reach: settledFor(SYNC_INTERVAL_MS),
    answered: 0,
    refuses: "/athlete/activities",
  },
  {
    label: "the six-hourly edit sweep",
    reach: settledFor(7 * 60 * MINUTE_MS),
    answered: 0,
    refuses: "/athlete/activities",
  },
  {
    label: "the daily rewalk",
    reach: settledFor(DAY_MS + MINUTE_MS),
    answered: 0,
    refuses: "/athlete/activities",
  },
  {
    label: "the weekly athlete refresh",
    reach: async (life) => {
      await settledFor(WEEK_LATER.getTime() - ADDED_AT.getTime())(life);
      // The rewalk and the sweep, which come first.
      await life.page("a week later");
      await life.page("a week later");
    },
    answered: 0,
    refuses: "/athlete",
  },
  {
    label: "a new activity's details",
    reach: async (life) => {
      await settledFor(SYNC_INTERVAL_MS)(life);
      life.strava.upload(LATE_UPLOAD);
      // The listing that finds it.
      await life.page("a new activity");
    },
    answered: 0,
    refuses: `/activities/${late}`,
  },
];

/**
 * Gaps between the ticks after the one that meets the deactivation, while the
 * owner has yet to notice: two at the sync interval, then one more than a week
 * on, by when the daily rewalk, the edit sweep and the weekly athlete refresh
 * are all due.
 */
const DEACTIVATED_TICKS_MS = [SYNC_INTERVAL_MS, SYNC_INTERVAL_MS, 8 * DAY_MS];

describe("an install whose Strava API application is deactivated", () => {
  // The non-subscriber whose refusals look most like the application's: a
  // plain 403 for each activity's zones and for the athlete's.
  const profile = NON_SUBSCRIBERS.find(
    (p) => p.summit === undefined && p.activityZones === 403 && p.athleteZones === 403,
  )!;
  /** What a source that never met the deactivation holds once settled, by the activities on Strava. */
  const settledContents = new Map<string, string>();

  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  async function neverDeactivated(activities: FakeActivity[]): Promise<string> {
    const key = activities.map(idOf).join(",");
    if (!settledContents.has(key)) {
      const life = added(profile, activities);
      await life.settle("first sync");
      expect(life.pages.filter((page) => page.error !== undefined)).toEqual([]);
      settledContents.set(key, life.store.contents());
    }
    return settledContents.get(key)!;
  }

  describe.each(DEACTIVATIONS)("deactivated at $label", (deactivation) => {
    let life: Lifecycle;
    /** The cursor and the store as the deactivation found them, and as it left them. */
    let found: { cursor: string; store: string };
    let left: { cursor: string; store: string };
    let deactivated: PageReport[];

    beforeAll(async () => {
      life = added(profile, FIRST_SYNC);
      await deactivation.reach(life);
      found = { cursor: stable(life.cursor), store: life.store.fingerprint() };

      life.strava.deactivate(deactivation.answered);
      await life.page("deactivated");
      for (const gap of DEACTIVATED_TICKS_MS) {
        vi.setSystemTime(Date.now() + gap);
        await life.page("deactivated");
      }
      left = { cursor: stable(life.cursor), store: life.store.fingerprint() };
      deactivated = life.pagesOf("deactivated");

      life.strava.reactivate();
      vi.setSystemTime(Date.now() + SYNC_INTERVAL_MS);
      await life.settle("reactivated");
    });

    test("the deactivation meets the page it is meant to", () => {
      const first = deactivated[0]!;
      expect(first.requests).toHaveLength(deactivation.answered + 1);
      expect(first.requests.at(-1)).toBe(deactivation.refuses);
    });

    test("every page it meets ends the tick with the application refused, and its remedy", () => {
      for (const page of deactivated) {
        const err = page.error;
        expect(err, `${page.phaseIn}: ${String(err)}`).toBeInstanceOf(
          StravaApplicationInactiveError,
        );
        // Never read as one activity, one endpoint or one athlete refused,
        // which the tiers and the refresh step over.
        expect(err).not.toBeInstanceOf(StravaForbiddenError);
        expect(err).not.toBeInstanceOf(StravaApiError);
        expect(err).toBeInstanceOf(SyncError);
        expect(err).toMatchObject({
          // A remedy for the operator, not a sign-in that would change nothing.
          kind: "permission",
          scope: "connection",
          remediation: {
            summary: "Strava has deactivated this install's API application",
            restartRequired: false,
          },
        });
        const steps = syncRemediationOf(err)!.steps.join(" ");
        expect(steps).toMatch(/account that registered this install's API application/);
        expect(steps).toMatch(/active Strava subscription/);
        expect(steps).toMatch(/https:\/\/www\.strava\.com\/settings\/api/);
      }
    });

    test("each page stops at Strava's first refusal", () => {
      // Asking for the next activity, or the next tier, would meet the same
      // refusal: the backlog is not worked through one refusal at a time.
      for (const page of deactivated.slice(1)) expect(page.requests).toHaveLength(1);
    });

    test("nothing is written and the cursor stays where the deactivation found it", () => {
      expect(left.cursor).toBe(found.cursor);
      expect(left.store).toBe(found.store);
    });

    test("reactivated, it resumes where it stopped and fetches everything", async () => {
      const resumed = life.pagesOf("reactivated");
      expect(resumed.filter((page) => page.error !== undefined)).toEqual([]);
      expect(resumed.slice(-2).every(isBareListing)).toBe(true);
      // The request refused is asked again, and this time answered.
      expect(life.requestsOf("reactivated")).toContain(deactivation.refuses);
      // Every activity fetched as if the application had never been
      // deactivated: no tier marked one done for want of an answer.
      expect(life.store.contents()).toBe(await neverDeactivated(life.strava.activities));
      const activities = life.store.rows("strava_activities");
      expect(activities).toHaveLength(life.strava.activities.length);
      for (const row of activities)
        expect(row, String(row.id)).toMatchObject({
          detail_fetched_at: expect.any(String),
          social_fetched_at: expect.any(String),
          zones_fetched_at: expect.any(String),
          streams_fetched_at: expect.any(String),
        });
    });

    test("the store answered every read, and Strava every request", () => {
      expect(life.store.unanswered).toEqual([]);
      expect(life.strava.unexpected).toEqual([]);
    });
  });
});
