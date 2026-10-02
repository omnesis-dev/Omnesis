// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Record builders for the per-tier child tables. Each function takes a
 * Strava API payload and returns a row (or rows) shaped for the gateway's
 * analytics-DB upsert. Splits and laps emit one row per item; segment
 * efforts denormalize the segment metadata inline.
 */

import { computeContentHash, toCanonicalInstant } from "@omnesis/core";
import type {
  StravaSummaryActivity,
  StravaDetailedActivity,
  StravaSplit,
  StravaBestEffort,
  StravaLap,
  StravaSegmentEffort,
  StravaActivityZone,
  StravaComment,
  StravaSummaryAthlete,
  StravaStreamSet,
  StravaDetailedAthlete,
  StravaDetailedGear,
  StravaActivityStats,
  StravaAthleteZones,
  StravaActivityTotal,
} from "./types.js";

// ── Splits ─────────────────────────────────────────────────────────

export function splitToRecord(
  s: StravaSplit,
  activityId: number,
  unit: "metric" | "standard",
): Record<string, unknown> {
  return {
    activity_id: activityId,
    unit,
    split_index: s.split,
    distance_m: s.distance,
    elapsed_time_seconds: s.elapsed_time,
    moving_time_seconds: s.moving_time,
    elevation_difference_m: s.elevation_difference ?? null,
    average_speed_ms: s.average_speed ?? null,
    average_grade_adjusted_speed_ms: s.average_grade_adjusted_speed ?? null,
    average_heartrate_bpm: s.average_heartrate ?? null,
    pace_zone: s.pace_zone ?? null,
  };
}

export function splitsFromActivity(detail: StravaDetailedActivity): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const s of detail.splits_metric ?? []) rows.push(splitToRecord(s, detail.id, "metric"));
  for (const s of detail.splits_standard ?? []) rows.push(splitToRecord(s, detail.id, "standard"));
  return rows;
}

// ── Best efforts ───────────────────────────────────────────────────

export function bestEffortToRecord(b: StravaBestEffort): Record<string, unknown> {
  return {
    id: b.id,
    activity_id: b.activity.id,
    name: b.name,
    distance_m: b.distance,
    elapsed_time_seconds: b.elapsed_time,
    moving_time_seconds: b.moving_time,
    start_index: b.start_index ?? null,
    end_index: b.end_index ?? null,
    start_time: b.start_date ?? null,
    pr_rank: b.pr_rank ?? null,
  };
}

export function bestEffortsFromActivity(detail: StravaDetailedActivity): Record<string, unknown>[] {
  return (detail.best_efforts ?? []).map(bestEffortToRecord);
}

// ── Laps ───────────────────────────────────────────────────────────

export function lapToRecord(l: StravaLap): Record<string, unknown> {
  return {
    id: l.id,
    activity_id: l.activity.id,
    lap_index: l.lap_index ?? null,
    name: l.name,
    distance_m: l.distance,
    elapsed_time_seconds: l.elapsed_time,
    moving_time_seconds: l.moving_time,
    start_time: l.start_date,
    start_index: l.start_index,
    end_index: l.end_index,
    total_elevation_gain_m: l.total_elevation_gain ?? null,
    average_speed_ms: l.average_speed ?? null,
    max_speed_ms: l.max_speed ?? null,
    average_heartrate_bpm: l.average_heartrate ?? null,
    max_heartrate_bpm: l.max_heartrate ?? null,
    average_cadence: l.average_cadence ?? null,
    average_watts: l.average_watts ?? null,
    device_watts: l.device_watts ?? null,
    pace_zone: l.pace_zone ?? null,
    split: l.split ?? null,
  };
}

export function lapsFromActivity(detail: StravaDetailedActivity): Record<string, unknown>[] {
  return (detail.laps ?? []).map(lapToRecord);
}

// ── Segment efforts ────────────────────────────────────────────────

export function segmentEffortToRecord(e: StravaSegmentEffort): Record<string, unknown> {
  const seg = e.segment;
  return {
    id: e.id,
    activity_id: e.activity.id,
    segment_id: seg.id,
    segment_name: seg.name,
    segment_activity_type: seg.activity_type,
    segment_distance_m: seg.distance,
    segment_average_grade: seg.average_grade ?? null,
    segment_maximum_grade: seg.maximum_grade ?? null,
    segment_elevation_high_m: seg.elevation_high ?? null,
    segment_elevation_low_m: seg.elevation_low ?? null,
    segment_city: seg.city ?? null,
    segment_state: seg.state ?? null,
    segment_country: seg.country ?? null,
    segment_climb_category: seg.climb_category ?? null,
    segment_private: seg.private ?? null,
    segment_starred: seg.starred ?? null,
    start_time: e.start_date,
    elapsed_time_seconds: e.elapsed_time,
    moving_time_seconds: e.moving_time,
    start_index: e.start_index,
    end_index: e.end_index,
    average_heartrate_bpm: e.average_heartrate ?? null,
    max_heartrate_bpm: e.max_heartrate ?? null,
    average_cadence: e.average_cadence ?? null,
    average_watts: e.average_watts ?? null,
    device_watts: e.device_watts ?? null,
    kom_rank: e.kom_rank ?? null,
    pr_rank: e.pr_rank ?? null,
    achievements_json:
      e.achievements && e.achievements.length > 0 ? JSON.stringify(e.achievements) : null,
    hidden: e.hidden ?? null,
  };
}

export function segmentEffortsFromActivity(
  detail: StravaDetailedActivity,
): Record<string, unknown>[] {
  return (detail.segment_efforts ?? []).map(segmentEffortToRecord);
}

// ── Activity zones ─────────────────────────────────────────────────

/**
 * A zone's upper bound as stored. Strava marks the open-ended top zone with
 * `max: -1`, which a query comparing against the bound would read as a bound
 * below every other zone's; it is stored as no bound at all.
 */
function zoneUpperBound(max: number): number | null {
  return max < 0 ? null : max;
}

/**
 * An activity's zones, one row per bucket of each zone.
 *
 * Taken as Strava sends it rather than as it documents it, because a throw
 * here, or a row the table refuses, fails the zones page on every tick and the
 * tier never finishes. A zone without its distribution, or with it null, has
 * no buckets to store; a zone without a type, or a bucket without a finite
 * time, would be a row without a `zone_type` or a `time_seconds`, both NOT
 * NULL. Each is left out and the rest stored. A bucket left out keeps its
 * neighbours' indexes, which number the zones.
 */
export function activityZonesToRecords(
  activityId: number,
  zones: (StravaActivityZone | null)[],
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  // A body that is not a list of zones at all stores none, for the same reason.
  if (!Array.isArray(zones)) return rows;
  for (const z of zones) {
    if (!z || typeof z.type !== "string" || !Array.isArray(z.distribution_buckets)) continue;
    const type = z.type;
    z.distribution_buckets.forEach((bucket, idx) => {
      if (typeof bucket?.time !== "number" || !Number.isFinite(bucket.time)) return;
      rows.push({
        activity_id: activityId,
        zone_type: type,
        bucket_index: idx,
        min_value: bucket.min,
        max_value: zoneUpperBound(bucket.max),
        time_seconds: bucket.time,
        sensor_based: Boolean(z.sensor_based),
        custom_zones: Boolean(z.custom_zones),
        points: z.points ?? null,
      });
    });
  }
  return rows;
}

// ── Comments ───────────────────────────────────────────────────────

export function commentToRecord(c: StravaComment): Record<string, unknown> {
  return {
    id: c.id,
    activity_id: c.activity_id,
    athlete_id: c.athlete?.id ?? null,
    athlete_firstname: c.athlete?.firstname ?? null,
    athlete_lastname: c.athlete?.lastname ?? null,
    text: c.text,
    created_at: c.created_at,
  };
}

// ── Kudos ──────────────────────────────────────────────────────────

export function kudoToRecord(
  k: StravaSummaryAthlete,
  activityId: number,
  position: number,
): Record<string, unknown> {
  return {
    activity_id: activityId,
    position,
    athlete_id: k.id ?? null,
    firstname: k.firstname ?? null,
    lastname: k.lastname ?? null,
    username: k.username ?? null,
  };
}

// ── Streams ────────────────────────────────────────────────────────

export function streamSetToRecord(
  activityId: number,
  set: StravaStreamSet,
): Record<string, unknown> {
  // Pull resolution / series_type / original_size off the first present stream
  // — Strava reports these consistently across keys.
  const first = Object.values(set).find((s) => s !== undefined);
  const json = JSON.stringify(set);
  return {
    activity_id: activityId,
    resolution: first?.resolution ?? null,
    series_type: first?.series_type ?? null,
    original_size: first?.original_size ?? null,
    streams_json: json,
    streams_size_bytes: Buffer.byteLength(json, "utf-8"),
    fetched_at: new Date().toISOString(),
  };
}

// ── Athlete profile / zones / stats / gear ─────────────────────────

export function athleteToRecord(
  a: StravaDetailedAthlete,
  biggestRideDistanceM: number | null,
  biggestClimbM: number | null,
): Record<string, unknown> {
  const url = a.profile_medium ?? a.profile ?? null;
  return {
    id: a.id,
    firstname: a.firstname ?? null,
    lastname: a.lastname ?? null,
    username: a.username ?? null,
    bio: a.bio ?? null,
    city: a.city ?? null,
    state: a.state ?? null,
    country: a.country ?? null,
    sex: a.sex ?? null,
    premium: a.premium ?? null,
    summit: a.summit ?? null,
    weight_kg: a.weight ?? null,
    ftp: a.ftp ?? null,
    measurement_preference: a.measurement_preference ?? null,
    athlete_type: a.athlete_type ?? null,
    profile_url: url,
    biggest_ride_distance_m: biggestRideDistanceM,
    biggest_climb_elevation_gain_m: biggestClimbM,
    created_at: a.created_at ?? null,
    updated_at: a.updated_at ?? null,
    fetched_at: new Date().toISOString(),
  };
}

export function athleteZonesToRecords(
  athleteId: number,
  z: StravaAthleteZones,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  if (z.heart_rate?.zones) {
    z.heart_rate.zones.forEach((bucket, idx) => {
      rows.push({
        athlete_id: athleteId,
        zone_type: "heartrate",
        bucket_index: idx,
        min_value: bucket.min,
        max_value: zoneUpperBound(bucket.max),
        custom_zones: z.heart_rate?.custom_zones ?? null,
      });
    });
  }
  if (z.power?.zones) {
    z.power.zones.forEach((bucket, idx) => {
      rows.push({
        athlete_id: athleteId,
        zone_type: "power",
        bucket_index: idx,
        min_value: bucket.min,
        max_value: zoneUpperBound(bucket.max),
        custom_zones: null,
      });
    });
  }
  return rows;
}

export function athleteStatsToRecords(
  athleteId: number,
  s: StravaActivityStats,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const buckets: Array<
    ["recent" | "ytd" | "all_time", "ride" | "run" | "swim", StravaActivityTotal | undefined]
  > = [
    ["recent", "ride", s.recent_ride_totals],
    ["recent", "run", s.recent_run_totals],
    ["recent", "swim", s.recent_swim_totals],
    ["ytd", "ride", s.ytd_ride_totals],
    ["ytd", "run", s.ytd_run_totals],
    ["ytd", "swim", s.ytd_swim_totals],
    ["all_time", "ride", s.all_ride_totals],
    ["all_time", "run", s.all_run_totals],
    ["all_time", "swim", s.all_swim_totals],
  ];
  for (const [bucket, sport, totals] of buckets) {
    if (!totals) continue;
    rows.push({
      athlete_id: athleteId,
      bucket,
      sport,
      count: totals.count ?? null,
      distance_m: totals.distance ?? null,
      moving_time_seconds: totals.moving_time ?? null,
      elapsed_time_seconds: totals.elapsed_time ?? null,
      elevation_gain_m: totals.elevation_gain ?? null,
      achievement_count: totals.achievement_count ?? null,
    });
  }
  return rows;
}

export function gearToRecord(
  g: StravaDetailedGear,
  athleteId: number | null,
): Record<string, unknown> {
  const gearType = g.id.startsWith("b") ? "bike" : g.id.startsWith("g") ? "shoe" : "unknown";
  return {
    id: g.id,
    athlete_id: athleteId,
    gear_type: gearType,
    name: g.name ?? null,
    nickname: g.nickname ?? null,
    brand_name: g.brand_name ?? null,
    model_name: g.model_name ?? null,
    frame_type: g.frame_type ?? null,
    description: g.description ?? null,
    distance_m: g.distance ?? null,
    primary: g.primary ?? null,
    retired: g.retired ?? null,
    fetched_at: new Date().toISOString(),
  };
}

// ── Edit detection ──────────────────────────────────────────────────

/**
 * Deterministic hash over the user-editable fields **a summary carries**. The
 * listing and both walks compare it with the stored row's (`summaryEdited`);
 * a difference clears the four `*_fetched_at` columns so the activity flows
 * back through enrichment.
 *
 * Includes: name, sport_type, type, gear_id, commute, trainer, private,
 * workout_type. Excludes derived metrics (kudos_count, comment_count,
 * photo_count) that update organically without representing a user edit. The
 * stats an athlete edits in place are edits too, but `summaryEdited` compares
 * them with the stored row rather than through this digest; see
 * `EDITED_IN_PLACE` for why.
 *
 * It also excludes every detail-only field, and that exclusion is the point
 * rather than an omission. Two phases persist this hash — the edit sweep, which
 * has only a summary, and enrichment, which also has the detail. A field only
 * the second one can see takes a real value there and folds to a placeholder
 * here, so the two phases would compute different hashes for an activity that
 * never changed, the "unchanged summary" comparison would never match, and each
 * sweep would clear the stamps that enrichment had just written. That is a
 * self-feeding loop, not edit detection: re-ingest, re-enrich, repeat, one
 * detail call per activity per cycle for as long as the source is connected.
 *
 * There is no version of this that detects a detail-only edit, because the
 * summary endpoint never returns those fields — the sweep cannot observe a
 * description change no matter what it hashes. Detecting one requires asking
 * Strava for the detail, which is the cost the sweep exists to avoid.
 */
export function computeSummaryHash(a: StravaSummaryActivity): string {
  const payload = JSON.stringify({
    name: a.name ?? "",
    sport_type: a.sport_type ?? "",
    type: a.type ?? "",
    gear_id: a.gear_id ?? "",
    commute: Boolean(a.commute),
    trainer: Boolean(a.trainer),
    private: Boolean(a.private),
    workout_type: a.workout_type ?? null,
  });
  return computeContentHash(payload);
}

/**
 * The `strava_activities` columns of the summary fields an athlete edits in
 * place, on the same activity id: a crop or a distance correction moves the
 * distance and the times, an elevation correction the gain, and an edit to a
 * manual activity its duration and start.
 *
 * Compared with the stored row, column by column, rather than taken into the
 * hash. A digest that took them in would serve as well for every activity
 * written from then on, but every row written before carries the digest
 * without them and would read as edited once — and the daily rewalk compares
 * the whole history, so the whole account would go back through enrichment, at
 * about five reads an activity, for edits nobody made. The columns compare
 * safely as the store hands them back: DOUBLE and INTEGER return the numbers
 * written, and the start is one instant however the store spells it. The row
 * holds the listing's values, because a detail page keeps those
 * (`withListedComparedFields`).
 */
const EDITED_IN_PLACE = [
  "distance_m",
  "moving_time_seconds",
  "elapsed_time_seconds",
  "total_elevation_gain_m",
  "manual",
  "start_time",
] as const;

/**
 * Counters Strava moves on its own as kudos, comments, photos, achievements and
 * group members arrive. Not an edit: the activity's enrichment stands, and only
 * the social tier has to run again — it fetches the comments and kudoers behind
 * two of them and renders the activity's document anew. Each is named alike in
 * the row and in the summary.
 */
const SUMMARY_COUNTERS = [
  "kudos_count",
  "comment_count",
  "athlete_count",
  "achievement_count",
  "pr_count",
  "photo_count",
  "total_photo_count",
] as const satisfies readonly (keyof StravaSummaryActivity)[];

/** What a phase reads of a stored activity to tell what a listing changed. */
export const COMPARED_COLUMNS: readonly string[] = [
  "id",
  "summary_hash",
  ...EDITED_IN_PLACE,
  ...SUMMARY_COUNTERS,
];

/**
 * A compared column's value as the comparison reads it. A missing number reads
 * as 0, as the detail tier writes one back; the start reads as the instant it
 * names, since the store renders it in its own spelling and zone.
 */
function comparable(column: string, value: unknown): unknown {
  if (column === "start_time") return toCanonicalInstant(value) ?? value;
  if (column === "manual") return Boolean(value);
  return Number(value ?? 0);
}

function differs(
  columns: readonly string[],
  stored: Record<string, unknown>,
  listed: Record<string, unknown>,
): boolean {
  return columns.some(
    (column) => comparable(column, stored[column]) !== comparable(column, listed[column]),
  );
}

/**
 * Whether the record a listing builds edits the activity `stored` holds: a field
 * the hash covers, or one edited in place. An edited activity is written again
 * with its enrichment marks cleared, since its splits, laps, efforts, zones and
 * streams may describe the activity as it was.
 */
export function summaryEdited(
  stored: Record<string, unknown>,
  listed: Record<string, unknown>,
): boolean {
  return stored.summary_hash !== listed.summary_hash || differs(EDITED_IN_PLACE, stored, listed);
}

/**
 * The listing's counters when any of them differs from the stored row's, or
 * `undefined` when none does.
 */
export function movedCounters(
  stored: Record<string, unknown>,
  listed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!differs(SUMMARY_COUNTERS, stored, listed)) return undefined;
  return Object.fromEntries(SUMMARY_COUNTERS.map((column) => [column, listed[column]]));
}

/**
 * `fetched` with every field the walks compare with a listing taken from
 * `listed`: those the summary hash covers, those edited in place, and the
 * counters.
 *
 * For a page that writes an activity from a response other than a listing,
 * such as its detail, so that the row still matches what its listing gave it.
 * A walk reads a matching row as "the row is what the listing says": a row
 * that took a compared field from elsewhere would keep it once Strava had
 * changed the field back, since the listing would match again — or, where the
 * two responses spell one value differently, would never match at all, and
 * each walk would send the activity back for its detail. An edit made since
 * the listing arrives through a walk instead, as any other edit does.
 *
 * The counters for a reason of their own: a walk that finds them moved is what
 * sends the activity back to the social tier, which alone fetches the comments
 * and kudoers behind them. That tier may have run before they moved, so a page
 * that wrote the fresh counters without it would leave a walk nothing to find,
 * and what arrived since unfetched until they moved again. Kept beside the
 * comparison so that the two name the same fields.
 */
export function withListedComparedFields(
  fetched: StravaSummaryActivity,
  listed: StravaSummaryActivity,
): StravaSummaryActivity {
  const written: StravaSummaryActivity = {
    ...fetched,
    name: listed.name,
    sport_type: listed.sport_type,
    type: listed.type,
    gear_id: listed.gear_id,
    commute: listed.commute,
    trainer: listed.trainer,
    private: listed.private,
    workout_type: listed.workout_type,
    distance: listed.distance,
    moving_time: listed.moving_time,
    elapsed_time: listed.elapsed_time,
    total_elevation_gain: listed.total_elevation_gain,
    manual: listed.manual,
    start_date: listed.start_date,
  };
  for (const counter of SUMMARY_COUNTERS) written[counter] = listed[counter];
  return written;
}
