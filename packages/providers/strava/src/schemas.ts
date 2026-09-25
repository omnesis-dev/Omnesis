// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/**
 * Summary-level activity data plus enrichment columns added on detail-fetch.
 * One row per Strava activity. Most columns ride in via the SummaryActivity
 * import; the `*_fetched_at` and detail-only columns (description, calories,
 * device_name, perceived_exertion, polyline, gear_brand/model, …) are filled
 * by the per-tier enrichment phases. `summary_hash` lets edit-sweep null the
 * per-tier stamps when an activity is edited on Strava's side.
 */
export const stravaActivitiesSchema: AnalyticsTableSchema = {
  tableName: "strava_activities",
  sharedDiscriminatorColumn: "athlete_id",
  displayName: "Strava Activities",
  description: "Runs, rides, swims, and other workouts from Strava (summary + per-activity detail)",
  columns: [
    { name: "id", type: "BIGINT", description: "Strava activity ID" },
    { name: "athlete_id", type: "BIGINT", description: "Strava athlete ID who owns the activity" },
    { name: "name", type: "VARCHAR", description: "Activity title" },
    {
      name: "sport_type",
      type: "VARCHAR",
      description: "Strava sport type (Run, Ride, Swim, Walk, Hike, VirtualRide, etc.)",
    },
    {
      name: "activity_type",
      type: "VARCHAR",
      description: "Legacy `type` field — kept as fallback",
      nullable: true,
    },
    { name: "distance_m", type: "DOUBLE", description: "Distance in meters" },
    {
      name: "moving_time_seconds",
      type: "INTEGER",
      description: "Moving time (stopped time excluded) in seconds",
    },
    { name: "elapsed_time_seconds", type: "INTEGER", description: "Total elapsed time in seconds" },
    {
      name: "total_elevation_gain_m",
      type: "DOUBLE",
      description: "Total elevation gain in meters",
    },
    { name: "start_time", type: "TIMESTAMPTZ", description: "UTC start time" },
    {
      name: "start_time_local",
      type: "TIMESTAMP",
      description: "Local wall-clock start time as reported by the device",
    },
    {
      name: "timezone",
      type: "VARCHAR",
      description: "Activity timezone (e.g. '(GMT-08:00) America/Los_Angeles')",
      nullable: true,
    },
    {
      name: "average_speed_ms",
      type: "DOUBLE",
      description: "Average speed in m/s",
      nullable: true,
    },
    { name: "max_speed_ms", type: "DOUBLE", description: "Max speed in m/s", nullable: true },
    {
      name: "average_cadence",
      type: "DOUBLE",
      description: "Average cadence (rpm or spm)",
      nullable: true,
    },
    {
      name: "average_temp",
      type: "DOUBLE",
      description: "Average ambient temperature (°C)",
      nullable: true,
    },
    {
      name: "average_heartrate_bpm",
      type: "DOUBLE",
      description: "Average heart rate in bpm",
      nullable: true,
    },
    {
      name: "max_heartrate_bpm",
      type: "DOUBLE",
      description: "Max heart rate in bpm",
      nullable: true,
    },
    {
      name: "average_watts",
      type: "DOUBLE",
      description: "Average power (bikes with power meter)",
      nullable: true,
    },
    { name: "max_watts", type: "DOUBLE", description: "Max power in watts", nullable: true },
    {
      name: "weighted_average_watts",
      type: "DOUBLE",
      description: "Normalized power (bikes only)",
      nullable: true,
    },
    {
      name: "kilojoules",
      type: "DOUBLE",
      description: "Total work in kJ (bikes with power)",
      nullable: true,
    },
    {
      name: "elev_high_m",
      type: "DOUBLE",
      description: "Highest elevation point in meters",
      nullable: true,
    },
    {
      name: "elev_low_m",
      type: "DOUBLE",
      description: "Lowest elevation point in meters",
      nullable: true,
    },
    {
      name: "has_heartrate",
      type: "BOOLEAN",
      description: "Whether the activity includes heart rate data",
    },
    {
      name: "device_watts",
      type: "BOOLEAN",
      description: "True if power data came from a device, false if estimated",
      nullable: true,
    },
    {
      name: "trainer",
      type: "BOOLEAN",
      description: "Whether the activity was done on an indoor trainer",
    },
    {
      name: "commute",
      type: "BOOLEAN",
      description: "Whether the activity is flagged as a commute",
    },
    {
      name: "manual",
      type: "BOOLEAN",
      description: "Whether the activity was manually logged (no device)",
    },
    { name: "private", type: "BOOLEAN", description: "Whether the activity is private" },
    {
      name: "flagged",
      type: "BOOLEAN",
      description: "Whether the activity has been flagged on Strava",
      nullable: true,
    },
    { name: "kudos_count", type: "INTEGER", description: "Number of kudos received" },
    { name: "comment_count", type: "INTEGER", description: "Number of comments" },
    {
      name: "athlete_count",
      type: "INTEGER",
      description: "Number of athletes on the activity (group rides/runs)",
    },
    {
      name: "achievement_count",
      type: "INTEGER",
      description: "Number of achievements (PRs, segment KOMs, etc.)",
      nullable: true,
    },
    {
      name: "photo_count",
      type: "INTEGER",
      description: "Number of Instagram photos attached",
      nullable: true,
    },
    {
      name: "total_photo_count",
      type: "INTEGER",
      description: "Total photos including Strava-uploaded",
      nullable: true,
    },
    {
      name: "pr_count",
      type: "INTEGER",
      description: "Number of personal records set",
      nullable: true,
    },
    {
      name: "suffer_score",
      type: "DOUBLE",
      description: "Relative effort / suffer score",
      nullable: true,
    },
    {
      name: "perceived_exertion",
      type: "DOUBLE",
      description: "User-reported perceived exertion (1-10)",
      nullable: true,
    },
    {
      name: "prefer_perceived_exertion",
      type: "BOOLEAN",
      description: "Whether the athlete prefers perceived-exertion over suffer score",
      nullable: true,
    },
    {
      name: "calories",
      type: "DOUBLE",
      description: "Calories burned (DetailedActivity only)",
      nullable: true,
    },
    {
      name: "description",
      type: "VARCHAR",
      description: "Activity description / write-up (DetailedActivity only)",
      nullable: true,
    },
    {
      name: "device_name",
      type: "VARCHAR",
      description: "Device that recorded the activity (e.g. 'Garmin Forerunner 965')",
      nullable: true,
    },
    {
      name: "embed_token",
      type: "VARCHAR",
      description: "Strava embed token for sharing the activity",
      nullable: true,
      sensitive: true,
    },
    {
      name: "workout_type",
      type: "INTEGER",
      description:
        "Strava workout type (0 default, 1 race, 2 long run, 3 workout, 10 ride race, 11 ride workout)",
      nullable: true,
    },
    {
      name: "location_city",
      type: "VARCHAR",
      description: "City where the activity took place",
      nullable: true,
    },
    { name: "location_state", type: "VARCHAR", description: "State/region", nullable: true },
    { name: "location_country", type: "VARCHAR", description: "Country", nullable: true },
    {
      name: "gear_id",
      type: "VARCHAR",
      description: "Strava gear ID (bike or shoe)",
      nullable: true,
    },
    {
      name: "gear_brand",
      type: "VARCHAR",
      description: "Brand of the gear used (resolved via /gear/{id})",
      nullable: true,
    },
    { name: "gear_model", type: "VARCHAR", description: "Model of the gear used", nullable: true },
    {
      name: "gear_name",
      type: "VARCHAR",
      description: "User-assigned name/nickname of the gear",
      nullable: true,
    },
    {
      name: "external_id",
      type: "VARCHAR",
      description: "External ID from the uploading device/app",
      nullable: true,
    },
    { name: "upload_id", type: "BIGINT", description: "Strava upload ID", nullable: true },
    {
      name: "map_summary_polyline",
      type: "VARCHAR",
      description: "Encoded polyline (low-resolution) — present in summary",
      nullable: true,
    },
    {
      name: "map_polyline",
      type: "VARCHAR",
      description: "Encoded polyline (full resolution) — DetailedActivity only",
      nullable: true,
    },
    { name: "start_lat", type: "DOUBLE", description: "Start point latitude", nullable: true },
    { name: "start_lng", type: "DOUBLE", description: "Start point longitude", nullable: true },
    { name: "end_lat", type: "DOUBLE", description: "End point latitude", nullable: true },
    { name: "end_lng", type: "DOUBLE", description: "End point longitude", nullable: true },
    {
      name: "photo_primary_url",
      type: "VARCHAR",
      description: "URL of the primary photo, if any",
      nullable: true,
    },
    {
      name: "available_zones",
      type: "JSON",
      description: "Zone types available for this activity (heartrate, power)",
      nullable: true,
    },
    {
      name: "summary_hash",
      type: "VARCHAR",
      description: "Hash of the summary fields — diff drives re-enrichment via edit-sweep",
      nullable: true,
      volatile: true,
    },
    {
      name: "detail_fetched_at",
      type: "TIMESTAMPTZ",
      description: "When DetailedActivity was last fetched (Tier 1)",
      nullable: true,
      volatile: true,
    },
    {
      name: "social_fetched_at",
      type: "TIMESTAMPTZ",
      description: "When comments + kudos were last fetched (Tier 2)",
      nullable: true,
      volatile: true,
    },
    {
      name: "zones_fetched_at",
      type: "TIMESTAMPTZ",
      description: "When activity zones were last fetched (Tier 3)",
      nullable: true,
      volatile: true,
    },
    {
      name: "zones_unavailable",
      type: "BOOLEAN",
      description: "True if zones returned 403 (Summit-only); skip on subsequent sweeps",
      nullable: true,
      volatile: true,
    },
    {
      name: "streams_fetched_at",
      type: "TIMESTAMPTZ",
      description: "When per-second streams were last fetched (Tier 5)",
      nullable: true,
      volatile: true,
    },
    {
      name: "strava_url",
      type: "VARCHAR",
      description: "Direct link to the activity on strava.com",
      references: "url",
    },
  ],
  primaryKey: ["id"],
  // An activity is placed at when it started.
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["name", "sport_type"],
    keyColumns: ["name", "sport_type", "start_time", "distance_m"],
  },
  // Each row co-describes the activity document whose externalId is the same
  // activity id (String(a.id), normalizer.ts) — declare the 1:1 doc↔row edge
  // (#450). Synthesized at walk time; no edge rows persisted.
  boundDocument: { externalIdColumns: ["id"] },
  exampleQueries: [
    "SELECT sport_type, COUNT(*) AS n, ROUND(SUM(distance_m)/1000, 1) AS km FROM strava_activities GROUP BY sport_type ORDER BY km DESC",
    "SELECT date_trunc('month', start_time) AS month, SUM(distance_m)/1000 AS km FROM strava_activities WHERE sport_type = 'Run' GROUP BY month ORDER BY month DESC",
    "SELECT name, start_time, distance_m/1000 AS km, average_heartrate_bpm, perceived_exertion FROM strava_activities WHERE sport_type = 'Run' ORDER BY start_time DESC LIMIT 10",
    "SELECT name, start_time, description FROM strava_activities WHERE description IS NOT NULL ORDER BY start_time DESC LIMIT 10",
    "SELECT sport_type, COUNT(*) AS pending FROM strava_activities WHERE detail_fetched_at IS NULL GROUP BY sport_type",
  ],
};

/**
 * One row per split (km or mile) per activity. Sourced from
 * DetailedActivity.splits_metric / splits_standard.
 */
export const stravaActivitySplitsSchema: AnalyticsTableSchema = {
  tableName: "strava_activity_splits",
  sharedDiscriminatorColumn: "source_athlete_id",
  sharedDiscriminatorParent: {
    table: "strava_activities",
    column: "activity_id",
    parentColumn: "id",
  },
  displayName: "Strava Activity Splits",
  description: "Per-split statistics (km or mile) for each activity",
  columns: [
    { name: "activity_id", type: "BIGINT", description: "Parent activity ID" },
    {
      name: "source_athlete_id",
      type: "BIGINT",
      description: "Owning account's athlete ID, independent of a comment or kudos actor",
      nullable: true,
    },
    {
      name: "unit",
      type: "VARCHAR",
      description: "Split unit — 'metric' (km) or 'standard' (mile)",
    },
    { name: "split_index", type: "INTEGER", description: "1-indexed split number" },
    { name: "distance_m", type: "DOUBLE", description: "Distance covered in this split (m)" },
    { name: "elapsed_time_seconds", type: "INTEGER", description: "Elapsed time for this split" },
    { name: "moving_time_seconds", type: "INTEGER", description: "Moving time for this split" },
    {
      name: "elevation_difference_m",
      type: "DOUBLE",
      description: "Net elevation change in meters",
      nullable: true,
    },
    {
      name: "average_speed_ms",
      type: "DOUBLE",
      description: "Average speed (m/s) in this split",
      nullable: true,
    },
    {
      name: "average_grade_adjusted_speed_ms",
      type: "DOUBLE",
      description: "Grade-adjusted average speed (m/s)",
      nullable: true,
    },
    {
      name: "average_heartrate_bpm",
      type: "DOUBLE",
      description: "Average heart rate during this split",
      nullable: true,
    },
    {
      name: "pace_zone",
      type: "INTEGER",
      description: "Strava pace zone (1-5) for this split",
      nullable: true,
    },
  ],
  primaryKey: ["activity_id", "unit", "split_index"],
  deleteKey: ["activity_id"],
  // A split is a sub-segment of an activity with no own timestamp — timeless.
  semanticTimeColumn: null,
  record: {
    titleColumns: ["split_index", "unit"],
    titleTemplate: "Split {split_index} ({unit})",
    keyColumns: ["split_index", "unit", "distance_m", "moving_time_seconds"],
  },
  exampleQueries: [
    "SELECT split_index, ROUND(distance_m, 0) AS m, ROUND(distance_m / moving_time_seconds * 3.6, 2) AS kmh, average_heartrate_bpm FROM strava_activity_splits WHERE activity_id = ? AND unit = 'metric' ORDER BY split_index",
  ],
};

/**
 * Best efforts on running activities — Strava's named-distance PR table
 * (1 mile, 5K, 10K, half-marathon, marathon, etc.). One row per effort.
 */
export const stravaActivityBestEffortsSchema: AnalyticsTableSchema = {
  tableName: "strava_activity_best_efforts",
  sharedDiscriminatorColumn: "source_athlete_id",
  sharedDiscriminatorParent: {
    table: "strava_activities",
    column: "activity_id",
    parentColumn: "id",
  },
  displayName: "Strava Best Efforts",
  description:
    "Named-distance segment efforts within an activity (e.g. 5K, 10K, half-marathon PRs)",
  columns: [
    { name: "id", type: "BIGINT", description: "Best-effort ID (Strava-assigned)" },
    { name: "activity_id", type: "BIGINT", description: "Parent activity ID" },
    {
      name: "source_athlete_id",
      type: "BIGINT",
      description: "Owning account's athlete ID, independent of a comment or kudos actor",
      nullable: true,
    },
    {
      name: "name",
      type: "VARCHAR",
      description: "Effort name (e.g. '1 mile', '5K', 'Half-Marathon')",
    },
    { name: "distance_m", type: "DOUBLE", description: "Effort distance in meters" },
    { name: "elapsed_time_seconds", type: "INTEGER", description: "Elapsed time of the effort" },
    { name: "moving_time_seconds", type: "INTEGER", description: "Moving time of the effort" },
    {
      name: "start_index",
      type: "INTEGER",
      description: "Stream index where the effort began",
      nullable: true,
    },
    {
      name: "end_index",
      type: "INTEGER",
      description: "Stream index where the effort ended",
      nullable: true,
    },
    {
      name: "start_time",
      type: "TIMESTAMPTZ",
      description: "Effort start time (UTC)",
      nullable: true,
    },
    {
      name: "pr_rank",
      type: "INTEGER",
      description: "PR rank (1=best, null=not a PR)",
      nullable: true,
    },
  ],
  primaryKey: ["id"],
  deleteKey: ["activity_id"],
  // A best effort is placed at when it occurred within the activity.
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["name"],
    keyColumns: ["name", "start_time", "elapsed_time_seconds", "distance_m"],
  },
  exampleQueries: [
    "SELECT name, MIN(elapsed_time_seconds) AS best_time_s FROM strava_activity_best_efforts GROUP BY name ORDER BY name",
    "SELECT name, elapsed_time_seconds, start_time FROM strava_activity_best_efforts WHERE pr_rank = 1 ORDER BY start_time DESC",
  ],
};

/** One row per lap. Sourced from DetailedActivity.laps. */
export const stravaActivityLapsSchema: AnalyticsTableSchema = {
  tableName: "strava_activity_laps",
  sharedDiscriminatorColumn: "source_athlete_id",
  sharedDiscriminatorParent: {
    table: "strava_activities",
    column: "activity_id",
    parentColumn: "id",
  },
  displayName: "Strava Activity Laps",
  description: "Per-lap statistics — auto-laps from device, manual press laps, or split laps",
  columns: [
    { name: "id", type: "BIGINT", description: "Lap ID (Strava-assigned)" },
    { name: "activity_id", type: "BIGINT", description: "Parent activity ID" },
    {
      name: "source_athlete_id",
      type: "BIGINT",
      description: "Owning account's athlete ID, independent of a comment or kudos actor",
      nullable: true,
    },
    { name: "lap_index", type: "INTEGER", description: "1-indexed lap number", nullable: true },
    { name: "name", type: "VARCHAR", description: "Lap name (typically 'Lap N')" },
    { name: "distance_m", type: "DOUBLE", description: "Lap distance (m)" },
    { name: "elapsed_time_seconds", type: "INTEGER", description: "Lap elapsed time (s)" },
    { name: "moving_time_seconds", type: "INTEGER", description: "Lap moving time (s)" },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Lap start time (UTC)" },
    { name: "start_index", type: "INTEGER", description: "Stream index where the lap began" },
    { name: "end_index", type: "INTEGER", description: "Stream index where the lap ended" },
    {
      name: "total_elevation_gain_m",
      type: "DOUBLE",
      description: "Lap elevation gain (m)",
      nullable: true,
    },
    {
      name: "average_speed_ms",
      type: "DOUBLE",
      description: "Lap average speed (m/s)",
      nullable: true,
    },
    { name: "max_speed_ms", type: "DOUBLE", description: "Lap max speed (m/s)", nullable: true },
    {
      name: "average_heartrate_bpm",
      type: "DOUBLE",
      description: "Lap average HR (bpm)",
      nullable: true,
    },
    { name: "max_heartrate_bpm", type: "DOUBLE", description: "Lap max HR (bpm)", nullable: true },
    { name: "average_cadence", type: "DOUBLE", description: "Lap average cadence", nullable: true },
    { name: "average_watts", type: "DOUBLE", description: "Lap average power (W)", nullable: true },
    {
      name: "device_watts",
      type: "BOOLEAN",
      description: "Whether power came from a device",
      nullable: true,
    },
    {
      name: "pace_zone",
      type: "INTEGER",
      description: "Strava pace zone for this lap",
      nullable: true,
    },
    {
      name: "split",
      type: "INTEGER",
      description: "Split index this lap belongs to",
      nullable: true,
    },
  ],
  primaryKey: ["id"],
  deleteKey: ["activity_id"],
  // A lap is placed at when it started within the activity.
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["name", "lap_index"],
    titleTemplate: "{name}",
    keyColumns: ["lap_index", "start_time", "distance_m", "moving_time_seconds"],
  },
};

/** One row per segment effort. Segment metadata denormalized inline. */
export const stravaActivitySegmentEffortsSchema: AnalyticsTableSchema = {
  tableName: "strava_activity_segment_efforts",
  sharedDiscriminatorColumn: "source_athlete_id",
  sharedDiscriminatorParent: {
    table: "strava_activities",
    column: "activity_id",
    parentColumn: "id",
  },
  displayName: "Strava Segment Efforts",
  description:
    "Each pass over a Strava segment during an activity, with the segment's metadata inline",
  columns: [
    { name: "id", type: "BIGINT", description: "Segment-effort ID" },
    { name: "activity_id", type: "BIGINT", description: "Parent activity ID" },
    {
      name: "source_athlete_id",
      type: "BIGINT",
      description: "Owning account's athlete ID, independent of a comment or kudos actor",
      nullable: true,
    },
    { name: "segment_id", type: "BIGINT", description: "Strava segment ID" },
    { name: "segment_name", type: "VARCHAR", description: "Segment name" },
    {
      name: "segment_activity_type",
      type: "VARCHAR",
      description: "Segment activity type (Run, Ride, …)",
    },
    { name: "segment_distance_m", type: "DOUBLE", description: "Segment distance (m)" },
    {
      name: "segment_average_grade",
      type: "DOUBLE",
      description: "Segment average grade (%)",
      nullable: true,
    },
    {
      name: "segment_maximum_grade",
      type: "DOUBLE",
      description: "Segment max grade (%)",
      nullable: true,
    },
    {
      name: "segment_elevation_high_m",
      type: "DOUBLE",
      description: "Segment highest elevation (m)",
      nullable: true,
    },
    {
      name: "segment_elevation_low_m",
      type: "DOUBLE",
      description: "Segment lowest elevation (m)",
      nullable: true,
    },
    { name: "segment_city", type: "VARCHAR", description: "Segment city", nullable: true },
    { name: "segment_state", type: "VARCHAR", description: "Segment state/region", nullable: true },
    { name: "segment_country", type: "VARCHAR", description: "Segment country", nullable: true },
    {
      name: "segment_climb_category",
      type: "INTEGER",
      description: "Strava climb category (0-5)",
      nullable: true,
    },
    {
      name: "segment_private",
      type: "BOOLEAN",
      description: "Whether the segment is private",
      nullable: true,
    },
    {
      name: "segment_starred",
      type: "BOOLEAN",
      description: "Whether the athlete has starred this segment",
      nullable: true,
    },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Effort start time (UTC)" },
    { name: "elapsed_time_seconds", type: "INTEGER", description: "Effort elapsed time (s)" },
    { name: "moving_time_seconds", type: "INTEGER", description: "Effort moving time (s)" },
    { name: "start_index", type: "INTEGER", description: "Stream index where the effort began" },
    { name: "end_index", type: "INTEGER", description: "Stream index where the effort ended" },
    {
      name: "average_heartrate_bpm",
      type: "DOUBLE",
      description: "Effort average HR (bpm)",
      nullable: true,
    },
    {
      name: "max_heartrate_bpm",
      type: "DOUBLE",
      description: "Effort max HR (bpm)",
      nullable: true,
    },
    {
      name: "average_cadence",
      type: "DOUBLE",
      description: "Effort average cadence",
      nullable: true,
    },
    {
      name: "average_watts",
      type: "DOUBLE",
      description: "Effort average power (W)",
      nullable: true,
    },
    {
      name: "device_watts",
      type: "BOOLEAN",
      description: "Whether power came from a device",
      nullable: true,
    },
    {
      name: "kom_rank",
      type: "INTEGER",
      description: "KOM/QOM rank achieved (1-10) — null if outside leaderboard",
      nullable: true,
    },
    {
      name: "pr_rank",
      type: "INTEGER",
      description: "Personal-record rank for this effort",
      nullable: true,
    },
    {
      name: "achievements_json",
      type: "JSON",
      description: "Full achievements payload (rare types)",
      nullable: true,
    },
    {
      name: "hidden",
      type: "BOOLEAN",
      description: "Whether the athlete hid this effort",
      nullable: true,
    },
  ],
  primaryKey: ["id"],
  deleteKey: ["activity_id"],
  // A segment effort is placed at when it occurred within the activity.
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["segment_name"],
    keyColumns: ["segment_name", "start_time", "elapsed_time_seconds", "kom_rank"],
  },
  exampleQueries: [
    "SELECT segment_name, COUNT(*) AS visits, MIN(elapsed_time_seconds) AS best_s FROM strava_activity_segment_efforts GROUP BY segment_name ORDER BY visits DESC LIMIT 20",
    "SELECT segment_name, kom_rank, start_time FROM strava_activity_segment_efforts WHERE kom_rank IS NOT NULL ORDER BY kom_rank, start_time DESC",
  ],
};

/** Activity-level zone time-in-bucket (HR + power). One row per (activity, zone_type, bucket). */
export const stravaActivityZonesSchema: AnalyticsTableSchema = {
  tableName: "strava_activity_zones",
  sharedDiscriminatorColumn: "source_athlete_id",
  sharedDiscriminatorParent: {
    table: "strava_activities",
    column: "activity_id",
    parentColumn: "id",
  },
  displayName: "Strava Activity Zones",
  description: "Time spent in each HR / power zone per activity (Summit-only)",
  columns: [
    { name: "activity_id", type: "BIGINT", description: "Parent activity ID" },
    {
      name: "source_athlete_id",
      type: "BIGINT",
      description: "Owning account's athlete ID, independent of a comment or kudos actor",
      nullable: true,
    },
    { name: "zone_type", type: "VARCHAR", description: "Zone type — 'heartrate' or 'power'" },
    { name: "bucket_index", type: "INTEGER", description: "0-indexed zone bucket" },
    {
      name: "min_value",
      type: "DOUBLE",
      description: "Lower bound of the zone (bpm or W)",
      nullable: true,
    },
    {
      name: "max_value",
      type: "DOUBLE",
      description: "Upper bound of the zone (bpm or W)",
      nullable: true,
    },
    { name: "time_seconds", type: "INTEGER", description: "Seconds spent in this zone" },
    {
      name: "sensor_based",
      type: "BOOLEAN",
      description: "Whether zone was computed from sensor data",
    },
    { name: "custom_zones", type: "BOOLEAN", description: "Whether the athlete uses custom zones" },
    {
      name: "points",
      type: "INTEGER",
      description: "Suffer-score-style points earned in this zone",
      nullable: true,
    },
  ],
  primaryKey: ["activity_id", "zone_type", "bucket_index"],
  deleteKey: ["activity_id"],
  // A heart-rate/power zone bucket — a timeless aggregate of an activity.
  semanticTimeColumn: null,
  record: {
    titleColumns: ["zone_type", "bucket_index"],
    titleTemplate: "{zone_type} bucket {bucket_index}",
    keyColumns: ["zone_type", "bucket_index", "min_value", "max_value", "time_seconds"],
  },
};

/** One row per comment on an activity. */
export const stravaActivityCommentsSchema: AnalyticsTableSchema = {
  tableName: "strava_activity_comments",
  sharedDiscriminatorColumn: "source_athlete_id",
  sharedDiscriminatorParent: {
    table: "strava_activities",
    column: "activity_id",
    parentColumn: "id",
  },
  displayName: "Strava Activity Comments",
  description: "Comments left by other athletes on the user's activities",
  columns: [
    { name: "id", type: "BIGINT", description: "Comment ID" },
    { name: "activity_id", type: "BIGINT", description: "Parent activity ID" },
    {
      name: "source_athlete_id",
      type: "BIGINT",
      description: "Owning account's athlete ID, independent of a comment or kudos actor",
      nullable: true,
    },
    {
      name: "athlete_id",
      type: "BIGINT",
      description: "Strava ID of the commenter",
      nullable: true,
    },
    {
      name: "athlete_firstname",
      type: "VARCHAR",
      description: "Commenter's first name",
      nullable: true,
    },
    {
      name: "athlete_lastname",
      type: "VARCHAR",
      description: "Commenter's last name",
      nullable: true,
    },
    { name: "text", type: "VARCHAR", description: "Comment text" },
    { name: "created_at", type: "TIMESTAMPTZ", description: "When the comment was posted" },
  ],
  primaryKey: ["id"],
  // Strava has no per-comment deletion signal: a re-read of an activity is
  // the whole truth about that activity's comments, so the unit this table is
  // deleted and reconciled by is the activity, not the comment.
  deleteKey: ["activity_id"],
  // A comment is placed at when it was posted.
  semanticTimeColumn: "created_at",
  record: {
    titleColumns: ["athlete_firstname", "athlete_lastname"],
    titleTemplate: "{athlete_firstname} {athlete_lastname}",
    keyColumns: ["athlete_firstname", "athlete_lastname", "text", "created_at"],
  },
  exampleQueries: [
    "SELECT athlete_firstname || ' ' || athlete_lastname AS who, COUNT(*) FROM strava_activity_comments GROUP BY who ORDER BY 2 DESC LIMIT 10",
  ],
};

/**
 * One row per kudoer per activity. Strava returns no stable id for a kudo,
 * so the primary key uses (activity_id, position) — the position in the
 * paginated list. On re-fetch we emit `deletedIds` for the activity's
 * full prior position range and re-insert.
 */
export const stravaActivityKudosSchema: AnalyticsTableSchema = {
  tableName: "strava_activity_kudos",
  sharedDiscriminatorColumn: "source_athlete_id",
  sharedDiscriminatorParent: {
    table: "strava_activities",
    column: "activity_id",
    parentColumn: "id",
  },
  displayName: "Strava Activity Kudos",
  description: "Athletes who kudosed each activity",
  columns: [
    { name: "activity_id", type: "BIGINT", description: "Parent activity ID" },
    {
      name: "source_athlete_id",
      type: "BIGINT",
      description: "Owning account's athlete ID, independent of a comment or kudos actor",
      nullable: true,
    },
    {
      name: "position",
      type: "INTEGER",
      description: "1-indexed position in the kudoers list (proxy id)",
    },
    {
      name: "athlete_id",
      type: "BIGINT",
      description: "Strava ID (returned only when public)",
      nullable: true,
    },
    { name: "firstname", type: "VARCHAR", description: "Kudoer's first name", nullable: true },
    { name: "lastname", type: "VARCHAR", description: "Kudoer's last name", nullable: true },
    { name: "username", type: "VARCHAR", description: "Kudoer's Strava username", nullable: true },
  ],
  primaryKey: ["activity_id", "position"],
  // Kudos are re-read per activity and rewritten whole: positions shift when
  // one is withdrawn, so the activity is the unit that is replaced.
  deleteKey: ["activity_id"],
  // A kudo carries no timestamp from Strava — timeless.
  semanticTimeColumn: null,
  record: {
    titleColumns: ["firstname", "lastname"],
    titleTemplate: "{firstname} {lastname}",
    keyColumns: ["firstname", "lastname", "username"],
  },
};

/** Per-second streams stored as JSON keyed by stream type. One row per activity. */
export const stravaActivityStreamsSchema: AnalyticsTableSchema = {
  tableName: "strava_activity_streams",
  sharedDiscriminatorColumn: "source_athlete_id",
  sharedDiscriminatorParent: {
    table: "strava_activities",
    column: "activity_id",
    parentColumn: "id",
  },
  displayName: "Strava Activity Streams",
  description:
    "Per-second time-series data (HR, power, GPS, cadence, ...) — JSON keyed by stream type",
  columns: [
    { name: "activity_id", type: "BIGINT", description: "Parent activity ID" },
    {
      name: "source_athlete_id",
      type: "BIGINT",
      description: "Owning account's athlete ID, independent of a comment or kudos actor",
      nullable: true,
    },
    {
      name: "resolution",
      type: "VARCHAR",
      description: "Stream resolution — low/medium/high",
      nullable: true,
    },
    {
      name: "series_type",
      type: "VARCHAR",
      description: "Stream series alignment — 'time' or 'distance'",
      nullable: true,
    },
    {
      name: "original_size",
      type: "INTEGER",
      description: "Original sample count (highest-resolution)",
      nullable: true,
    },
    {
      name: "streams_json",
      type: "JSON",
      description: "Stream data, keyed by stream type (time, latlng, heartrate, watts, ...)",
    },
    {
      name: "streams_size_bytes",
      type: "INTEGER",
      description: "Size of the JSON blob in bytes — flag pathologically large rows",
      nullable: true,
    },
    {
      name: "fetched_at",
      type: "TIMESTAMPTZ",
      description: "When the streams were fetched",
      volatile: true,
    },
  ],
  primaryKey: ["activity_id"],
  // A per-activity stream blob — fetched_at is an ingest timestamp, not a
  // real-world event instant — so it is timeless.
  semanticTimeColumn: null,
  record: {
    titleColumns: ["activity_id"],
    titleTemplate: "Streams for activity {activity_id}",
    keyColumns: ["resolution", "series_type", "original_size"],
  },
};

/** Athlete profile (one row per authenticated athlete). */
export const stravaAthleteSchema: AnalyticsTableSchema = {
  tableName: "strava_athlete",
  sharedDiscriminatorColumn: "id",
  displayName: "Strava Athlete",
  description: "Authenticated athlete profile (bio, FTP, weight, lifetime stats)",
  columns: [
    { name: "id", type: "BIGINT", description: "Strava athlete ID" },
    { name: "firstname", type: "VARCHAR", description: "First name", nullable: true },
    { name: "lastname", type: "VARCHAR", description: "Last name", nullable: true },
    { name: "username", type: "VARCHAR", description: "Strava username", nullable: true },
    { name: "bio", type: "VARCHAR", description: "Athlete bio", nullable: true },
    { name: "city", type: "VARCHAR", description: "Athlete's home city", nullable: true },
    { name: "state", type: "VARCHAR", description: "Athlete's state/region", nullable: true },
    { name: "country", type: "VARCHAR", description: "Athlete's country", nullable: true },
    { name: "sex", type: "VARCHAR", description: "Athlete's sex (M/F)", nullable: true },
    {
      name: "premium",
      type: "BOOLEAN",
      description: "Whether the account is premium (legacy)",
      nullable: true,
    },
    {
      name: "summit",
      type: "BOOLEAN",
      description: "Whether the account has Summit (subscription)",
      nullable: true,
    },
    { name: "weight_kg", type: "DOUBLE", description: "Athlete's weight in kg", nullable: true },
    { name: "ftp", type: "INTEGER", description: "Functional threshold power (W)", nullable: true },
    {
      name: "measurement_preference",
      type: "VARCHAR",
      description: "Preferred unit system (meters / feet)",
      nullable: true,
    },
    { name: "athlete_type", type: "INTEGER", description: "0=cyclist, 1=runner", nullable: true },
    {
      name: "profile_url",
      type: "VARCHAR",
      description: "URL of the athlete's profile photo",
      nullable: true,
    },
    {
      name: "biggest_ride_distance_m",
      type: "DOUBLE",
      description: "Lifetime biggest ride distance (m)",
      nullable: true,
    },
    {
      name: "biggest_climb_elevation_gain_m",
      type: "DOUBLE",
      description: "Lifetime biggest climb (m)",
      nullable: true,
    },
    {
      name: "created_at",
      type: "TIMESTAMPTZ",
      description: "Account creation time",
      nullable: true,
    },
    {
      name: "updated_at",
      type: "TIMESTAMPTZ",
      description: "Profile last-updated time",
      nullable: true,
    },
    {
      name: "fetched_at",
      type: "TIMESTAMPTZ",
      description: "When this row was last refreshed",
      volatile: true,
    },
  ],
  primaryKey: ["id"],
  // The athlete's profile is an identity snapshot, not a dated event — timeless.
  semanticTimeColumn: null,
  record: {
    titleColumns: ["firstname", "lastname"],
    titleTemplate: "{firstname} {lastname}",
    keyColumns: ["firstname", "lastname", "city", "country"],
  },
};

/** Athlete-level zone definitions. One row per (athlete, type, bucket). */
export const stravaAthleteZonesSchema: AnalyticsTableSchema = {
  tableName: "strava_athlete_zones",
  sharedDiscriminatorColumn: "athlete_id",
  displayName: "Strava Athlete Zones",
  description: "Athlete's HR and power zone bounds",
  columns: [
    { name: "athlete_id", type: "BIGINT", description: "Strava athlete ID" },
    { name: "zone_type", type: "VARCHAR", description: "Zone type — 'heartrate' or 'power'" },
    { name: "bucket_index", type: "INTEGER", description: "0-indexed zone" },
    { name: "min_value", type: "DOUBLE", description: "Lower bound (bpm or W)", nullable: true },
    { name: "max_value", type: "DOUBLE", description: "Upper bound (bpm or W)", nullable: true },
    {
      name: "custom_zones",
      type: "BOOLEAN",
      description: "Whether the athlete uses custom zones",
      nullable: true,
    },
  ],
  primaryKey: ["athlete_id", "zone_type", "bucket_index"],
  // An athlete-level zone definition — a timeless configuration bucket.
  semanticTimeColumn: null,
  record: {
    titleColumns: ["zone_type", "bucket_index"],
    titleTemplate: "{zone_type} bucket {bucket_index}",
    keyColumns: ["zone_type", "bucket_index", "min_value", "max_value"],
  },
};

/** Lifetime stats per (athlete, bucket, sport). */
export const stravaAthleteStatsSchema: AnalyticsTableSchema = {
  tableName: "strava_athlete_stats",
  sharedDiscriminatorColumn: "athlete_id",
  displayName: "Strava Athlete Stats",
  description: "Recent / YTD / all-time totals per sport",
  columns: [
    { name: "athlete_id", type: "BIGINT", description: "Strava athlete ID" },
    {
      name: "bucket",
      type: "VARCHAR",
      description: "Stat bucket — 'recent' (4-week rolling), 'ytd', or 'all_time'",
    },
    { name: "sport", type: "VARCHAR", description: "Sport — 'ride', 'run', or 'swim'" },
    { name: "count", type: "INTEGER", description: "Number of activities", nullable: true },
    { name: "distance_m", type: "DOUBLE", description: "Total distance (m)", nullable: true },
    {
      name: "moving_time_seconds",
      type: "INTEGER",
      description: "Total moving time (s)",
      nullable: true,
    },
    {
      name: "elapsed_time_seconds",
      type: "INTEGER",
      description: "Total elapsed time (s)",
      nullable: true,
    },
    {
      name: "elevation_gain_m",
      type: "DOUBLE",
      description: "Total elevation gain (m)",
      nullable: true,
    },
    {
      name: "achievement_count",
      type: "INTEGER",
      description: "Achievements earned in this bucket",
      nullable: true,
    },
  ],
  primaryKey: ["athlete_id", "bucket", "sport"],
  // A rolling/lifetime totals bucket — an aggregate with no single instant.
  semanticTimeColumn: null,
  record: {
    titleColumns: ["sport", "bucket"],
    titleTemplate: "{sport} ({bucket})",
    keyColumns: ["sport", "bucket", "count", "distance_m"],
  },
};

/** Gear catalog (bikes + shoes) for the athlete. One row per gear ID. */
export const stravaGearSchema: AnalyticsTableSchema = {
  tableName: "strava_gear",
  sharedDiscriminatorColumn: "athlete_id",
  displayName: "Strava Gear",
  description: "Bikes and shoes registered to the athlete",
  columns: [
    {
      name: "id",
      type: "VARCHAR",
      description: "Strava gear ID (e.g. 'b12345' for bike, 'g67890' for shoe)",
    },
    { name: "athlete_id", type: "BIGINT", description: "Owning athlete ID", nullable: true },
    {
      name: "gear_type",
      type: "VARCHAR",
      description: "Gear type — 'bike' or 'shoe' (inferred from ID prefix)",
    },
    { name: "name", type: "VARCHAR", description: "User-assigned name", nullable: true },
    {
      name: "nickname",
      type: "VARCHAR",
      description: "Nickname (alias for some gear)",
      nullable: true,
    },
    { name: "brand_name", type: "VARCHAR", description: "Brand", nullable: true },
    { name: "model_name", type: "VARCHAR", description: "Model", nullable: true },
    { name: "frame_type", type: "INTEGER", description: "Frame type (bikes only)", nullable: true },
    {
      name: "description",
      type: "VARCHAR",
      description: "User-supplied description",
      nullable: true,
    },
    {
      name: "distance_m",
      type: "DOUBLE",
      description: "Lifetime distance covered with this gear (m)",
      nullable: true,
    },
    {
      name: "primary",
      type: "BOOLEAN",
      description: "Whether this is the athlete's primary gear of its type",
      nullable: true,
    },
    {
      name: "retired",
      type: "BOOLEAN",
      description: "Whether the gear is retired",
      nullable: true,
    },
    {
      name: "fetched_at",
      type: "TIMESTAMPTZ",
      description: "When this row was last refreshed",
      volatile: true,
    },
  ],
  primaryKey: ["id"],
  // A gear catalog item — identity, not a dated event — timeless.
  semanticTimeColumn: null,
  record: {
    titleColumns: ["name", "nickname"],
    titleTemplate: "{name}",
    keyColumns: ["name", "gear_type", "brand_name", "distance_m"],
  },
};

/** Activity-owned tables share the account's complete activity inventory. */
export const activitySchemas = [
  stravaActivitiesSchema,
  stravaActivitySplitsSchema,
  stravaActivityBestEffortsSchema,
  stravaActivityLapsSchema,
  stravaActivitySegmentEffortsSchema,
  stravaActivityZonesSchema,
  stravaActivityCommentsSchema,
  stravaActivityKudosSchema,
  stravaActivityStreamsSchema,
];

export const allSchemas = [
  ...activitySchemas,
  stravaAthleteSchema,
  stravaAthleteZonesSchema,
  stravaAthleteStatsSchema,
  stravaGearSchema,
];
