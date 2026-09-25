// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  sha256Hex,
  personMention,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

interface ActivityEntry {
  externalId: string;
  /** Numeric Strava activity id used as the primary key in `strava_activities`. */
  id: number;
  name: string;
  sportType: string;
  distanceMeters: number;
  movingTimeSeconds: number;
  totalElevationGainMeters: number;
  startTime: string;
  /** Wall-clock start used by `start_time_local`. Defaults to UTC strip when absent. */
  startTimeLocal?: string;
  averageHeartRate: number | null;
  maxHeartRate?: number | null;
  description: string;
}

interface ZoneEntry {
  activityId: number;
  zoneType: string;
  bucketIndex: number;
  minValue: number | null;
  maxValue: number | null;
  timeSeconds: number;
}

let cachedActivities: ActivityEntry[] | null = null;
let cachedZones: ZoneEntry[] | null = null;

export function loadActivities(): ActivityEntry[] {
  if (cachedActivities) return cachedActivities;
  cachedActivities = loadSourceFixtureJson<ActivityEntry[]>(
    loadActiveUniverse(),
    "strava-activities",
    "activities.json",
  );
  return cachedActivities;
}

export function loadZones(): ZoneEntry[] {
  if (cachedZones) return cachedZones;
  cachedZones = loadSourceFixtureJson<ZoneEntry[]>(
    loadActiveUniverse(),
    "strava-activities",
    "zones.json",
  );
  return cachedZones;
}

function fmtKm(m: number): string {
  return (m / 1000).toFixed(2) + " km";
}
function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function mapActivity(
  e: ActivityEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const content = [
    `# ${e.name}`,
    `${e.sportType} — ${fmtKm(e.distanceMeters)} in ${fmtDuration(e.movingTimeSeconds)}`,
    `Elevation: ${e.totalElevationGainMeters} m` +
      (e.averageHeartRate ? ` · Avg HR: ${e.averageHeartRate}` : ""),
    "",
    e.description,
  ].join("\n");
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: e.name,
    content,
    contentHash: sha256Hex(`${e.externalId}:${content}:${e.startTime}`),
    metadata: {
      documentType: "activity",
      people: [personMention("self", "owner")],
      extra: {
        activityType: e.sportType,
        distanceMeters: e.distanceMeters,
        movingTimeSeconds: e.movingTimeSeconds,
        totalElevationGainMeters: e.totalElevationGainMeters,
        averageHeartRate: e.averageHeartRate,
      },
    },
    sourceCreatedAt: e.startTime,
    sourceUpdatedAt: e.startTime,
  };
}

const STRAVA_ACTIVITY_URL = "https://www.strava.com/activities/";

/** Build a `strava_activities` row matching the columns declared by the real schema. */
export function mapActivityRecord(e: ActivityEntry, athleteId: number): Record<string, unknown> {
  const startLocal = e.startTimeLocal ?? e.startTime.replace(/Z$/, "");
  return {
    id: e.id,
    athlete_id: athleteId,
    name: e.name,
    sport_type: e.sportType,
    activity_type: e.sportType,
    distance_m: e.distanceMeters,
    moving_time_seconds: e.movingTimeSeconds,
    elapsed_time_seconds: e.movingTimeSeconds,
    total_elevation_gain_m: e.totalElevationGainMeters,
    start_time: e.startTime,
    start_time_local: startLocal,
    timezone: null,
    average_speed_ms: e.movingTimeSeconds > 0 ? e.distanceMeters / e.movingTimeSeconds : null,
    max_speed_ms: null,
    average_cadence: null,
    average_temp: null,
    average_heartrate_bpm: e.averageHeartRate,
    max_heartrate_bpm: e.maxHeartRate ?? null,
    average_watts: null,
    max_watts: null,
    weighted_average_watts: null,
    kilojoules: null,
    elev_high_m: null,
    elev_low_m: null,
    has_heartrate: e.averageHeartRate !== null,
    device_watts: null,
    trainer: false,
    commute: false,
    manual: false,
    private: false,
    flagged: null,
    kudos_count: 0,
    comment_count: 0,
    athlete_count: 1,
    achievement_count: null,
    photo_count: null,
    total_photo_count: null,
    pr_count: null,
    suffer_score: null,
    perceived_exertion: null,
    prefer_perceived_exertion: null,
    calories: null,
    description: e.description,
    device_name: null,
    embed_token: null,
    workout_type: null,
    location_city: null,
    location_state: null,
    location_country: null,
    gear_id: null,
    gear_brand: null,
    gear_model: null,
    gear_name: null,
    external_id: null,
    upload_id: null,
    map_summary_polyline: null,
    map_polyline: null,
    start_lat: null,
    start_lng: null,
    end_lat: null,
    end_lng: null,
    photo_primary_url: null,
    available_zones: e.averageHeartRate !== null ? JSON.stringify(["heartrate"]) : null,
    summary_hash: null,
    detail_fetched_at: null,
    social_fetched_at: null,
    zones_fetched_at: e.averageHeartRate !== null ? e.startTime : null,
    zones_unavailable: e.averageHeartRate !== null ? false : null,
    streams_fetched_at: null,
    strava_url: `${STRAVA_ACTIVITY_URL}${e.id}`,
  };
}

/** Build a `strava_activity_zones` row. */
export function mapZoneRecord(z: ZoneEntry, athleteId: number): Record<string, unknown> {
  return {
    activity_id: z.activityId,
    source_athlete_id: athleteId,
    zone_type: z.zoneType,
    bucket_index: z.bucketIndex,
    min_value: z.minValue,
    max_value: z.maxValue,
    time_seconds: z.timeSeconds,
    sensor_based: true,
    custom_zones: true,
    points: null,
  };
}
