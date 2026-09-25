// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { makeCursorValidator } from "@omnesis/source-sdk";
import type { SyncCursor } from "@omnesis/source-sdk";
import type { StravaClient } from "./client.js";

// ── Provider Context ────────────────────────────────────────────────

export interface StravaContext {
  client: StravaClient;
  accountId: string;
  dataCutoff?: string;
  athleteId: number;
  /** Display name of the authenticated athlete (e.g. "James Bond"), if available. */
  athleteName?: string;
  /** Config dir the account's tokens live under — undefined means the default. */
  configDir?: string;
}

// ── OAuth Credentials & Tokens ──────────────────────────────────────

export interface StravaCredentials {
  client_id: string;
  client_secret: string;
}

/** Tokens persisted to ~/.config/omnesis/strava/{athlete_id}/tokens.json */
export interface StravaTokens {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. Strava returns absolute expiry, not relative. */
  expires_at: number;
  athlete_id: number;
  athlete_firstname?: string;
  athlete_lastname?: string;
}

// ── Activities Source Cursor ────────────────────────────────────────

/**
 * Phase machine, pictured as a single state machine. Only the existing four
 * phases are required for backward compatibility — the new enrichment phases
 * insert between `backfill` and `incremental` on first reach, and slot into
 * the in-`incremental` priority chain on every subsequent tick.
 *
 * - `backfill` — newest → oldest summary import.
 * - `athlete-refresh` — one-shot per cycle: athlete profile, zones, lifetime
 *   stats, gear catalog (resolves `gear_id` → brand/model). Cadence-gated
 *   (default 7d) by `lastAthleteRefreshAt`.
 * - `detail-backfill` — drains activities WHERE `detail_fetched_at IS NULL`
 *   via `GET /activities/{id}` (DetailedActivity). Highest-value tier — adds
 *   description, splits, best efforts, laps, segment efforts.
 * - `social-backfill` — drains `social_fetched_at IS NULL` via the comments
 *   and kudos endpoints. 2 calls per activity.
 * - `zones-backfill` — drains `zones_fetched_at IS NULL AND zones_unavailable
 *   IS NOT TRUE`. Summit-only; 403 → `zones_unavailable=true`, never retry.
 * - `streams-backfill` — drains `streams_fetched_at IS NULL` via the streams
 *   endpoint (one call returns all keys).
 * - `incremental` — fetches new activities; in-priority queues snapshot-rewalk
 *   → edit-sweep → athlete-refresh → enrich-pending → newest.
 * - `snapshot-rewalk` — 24h cadence, deletion detection.
 * - `edit-sweep` — 6h cadence; clears `*_fetched_at` stamps when a re-ingested
 *   activity's summary_hash differs.
 * - `enrich-pending` — rotates across the four enrichment tiers picking
 *   whichever has rows lacking its stamp; one tier per tick to avoid
 *   starvation under quota pressure.
 */
export type StravaActivitiesPhase =
  | "backfill"
  | "incremental"
  | "snapshot-rewalk"
  | "edit-sweep"
  | "athlete-refresh"
  | "detail-backfill"
  | "social-backfill"
  | "zones-backfill"
  | "streams-backfill"
  | "enrich-pending";

/** Tiers handled by the rotating `enrich-pending` phase. */
export type EnrichmentTier = "detail" | "social" | "zones" | "streams";

export interface StravaActivitiesCursor extends SyncCursor {
  phase: StravaActivitiesPhase;
  /** Unix seconds. Activities strictly older than this are fetched during backfill. */
  backfillBefore?: number;
  /** 1-indexed Strava page number for backfill pagination. */
  backfillPage?: number;
  /** Unix seconds of the newest activity we've ever seen. */
  lastActivityTimestamp?: number;
  /**
   * ISO 8601 timestamp of the last completed snapshot re-walk. Drives
   * the 24h cadence — when older than the interval, the next sync
   * enters `snapshot-rewalk`.
   */
  lastSnapshotAt?: string;
  /**
   * `before=` pin used by `snapshot-rewalk` so all pages of one rewalk
   * see the same point-in-time view. Set on phase entry; cleared on
   * exit.
   */
  snapshotBefore?: number;
  /**
   * Activities enriched on the previous social-backfill page, waiting to be
   * marked done.
   *
   * The mark cannot ride the page that produced the enrichment. A page's
   * analytics writes land before its documents and cursor — separate
   * databases, so they cannot share a transaction — and the mark is what the
   * retry filter selects on. Written alongside, a crash between the two would
   * leave an activity marked finished with its document never stored and never
   * fetched again. Written on the following page, the same crash leaves it
   * unmarked and the retry picks it up.
   *
   * Bounded by the enrichment page size, so it does not grow with the corpus.
   */
  pendingSocialStamps?: string[];
  /** Detail pages awaiting their post-document completion stamp; bounded by page size. */
  pendingDetailStamps?: string[];
  /** 1-indexed page within the current `snapshot-rewalk`. */
  snapshotPage?: number;
  /** Activity IDs accumulated across the multi-page snapshot run. */
  snapshotIds?: string[];
  /**
   * ISO 8601 timestamp of the last completed edit sweep. Drives the
   * 6h cadence — when older than the interval, the next sync re-walks
   * the last 30 days of activities and re-ingests them so contentHash
   * dedup picks up edits (renames, descriptions, gear changes) that
   * Strava's `after=` filter on `start_date` never surfaces.
   */
  lastEditSweepAt?: string;
  /** `after=` pin (unix s) used by `edit-sweep` for paging stability. */
  editSweepAfter?: number;
  /** 1-indexed page within the current `edit-sweep`. */
  editSweepPage?: number;
  /**
   * ISO 8601 timestamp of the last completed athlete-refresh. 7d cadence
   * (configurable). A flip of `summit` false→true also forces a re-sweep
   * of `zones-backfill` by clearing `zones_unavailable` flags on the next
   * incremental tick.
   */
  lastAthleteRefreshAt?: string;
  /**
   * When in `enrich-pending`, the tier to drain on this tick. Rotates
   * round-robin so a backlog in one tier doesn't starve the others.
   */
  enrichTier?: EnrichmentTier;
}

export const STRAVA_PHASES: ReadonlySet<string> = new Set<StravaActivitiesPhase>([
  "backfill",
  "incremental",
  "snapshot-rewalk",
  "edit-sweep",
  "athlete-refresh",
  "detail-backfill",
  "social-backfill",
  "zones-backfill",
  "streams-backfill",
  "enrich-pending",
]);

function isStravaActivitiesCursor(v: unknown): v is StravaActivitiesCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return typeof c.phase === "string" && STRAVA_PHASES.has(c.phase);
}

export const validateStravaActivitiesCursor = makeCursorValidator(isStravaActivitiesCursor);

// ── Strava API shapes (summary activity) ────────────────────────────

/**
 * Subset of Strava `SummaryActivity` fields we use.
 * See: https://developers.strava.com/docs/reference/#api-models-SummaryActivity
 */
export interface StravaSummaryActivity {
  id: number;
  athlete: { id: number };
  name: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  type?: string;
  sport_type: string;
  start_date: string; // ISO 8601 UTC
  start_date_local: string; // ISO 8601 without TZ (local wall clock)
  timezone?: string;
  utc_offset?: number;
  location_city?: string | null;
  location_state?: string | null;
  location_country?: string | null;
  achievement_count?: number;
  kudos_count?: number;
  comment_count?: number;
  athlete_count?: number;
  photo_count?: number;
  total_photo_count?: number;
  trainer?: boolean;
  commute?: boolean;
  manual?: boolean;
  private?: boolean;
  flagged?: boolean;
  gear_id?: string | null;
  average_speed?: number;
  max_speed?: number;
  average_cadence?: number;
  average_temp?: number;
  average_watts?: number;
  max_watts?: number;
  weighted_average_watts?: number;
  kilojoules?: number;
  device_watts?: boolean;
  has_heartrate?: boolean;
  average_heartrate?: number;
  max_heartrate?: number;
  elev_high?: number;
  elev_low?: number;
  upload_id?: number | null;
  external_id?: string | null;
  pr_count?: number;
  suffer_score?: number | null;
  workout_type?: number | null;
  /** From SummaryActivity — short polyline. DetailedActivity additionally fills `polyline`. */
  map?: StravaPolylineMap;
  start_latlng?: [number, number] | null;
  end_latlng?: [number, number] | null;
}

export interface StravaPolylineMap {
  id?: string;
  polyline?: string;
  summary_polyline?: string;
  resource_state?: number;
}

// ── Strava API shapes (detailed activity & nested types) ────────────

/**
 * `GET /activities/{id}` — DetailedActivity. Extends SummaryActivity with
 * description and per-activity nested arrays. Some fields appear in real
 * API responses but are absent from the public swagger reference (e.g.
 * `splits_standard`, `best_efforts`, `available_zones`, `perceived_exertion`)
 * — we treat them as optional and tolerate absence.
 */
export interface StravaDetailedActivity extends StravaSummaryActivity {
  description?: string | null;
  calories?: number | null;
  device_name?: string | null;
  embed_token?: string | null;
  splits_metric?: StravaSplit[];
  splits_standard?: StravaSplit[];
  best_efforts?: StravaBestEffort[];
  segment_efforts?: StravaSegmentEffort[];
  laps?: StravaLap[];
  gear?: StravaSummaryGear | null;
  photos?: StravaPhotosSummary;
  highlighted_kudosers?: StravaHighlightedKudoser[];
  available_zones?: string[];
  perceived_exertion?: number | null;
  prefer_perceived_exertion?: boolean | null;
  hide_from_home?: boolean;
  segment_leaderboard_opt_out?: boolean;
  leaderboard_opt_out?: boolean;
  partner_brand_tag?: string | null;
  from_accepted_tag?: boolean;
  has_kudoed?: boolean;
}

export interface StravaSplit {
  /** 1-indexed split number. */
  split: number;
  distance: number;
  elapsed_time: number;
  moving_time: number;
  elevation_difference?: number | null;
  average_speed?: number | null;
  average_grade_adjusted_speed?: number | null;
  average_heartrate?: number | null;
  pace_zone?: number | null;
}

export interface StravaBestEffort {
  id: number;
  activity: { id: number };
  athlete?: { id: number };
  name: string;
  distance: number;
  elapsed_time: number;
  moving_time: number;
  start_index?: number;
  end_index?: number;
  start_date?: string;
  start_date_local?: string;
  pr_rank?: number | null;
  achievements?: unknown[];
  resource_state?: number;
}

export interface StravaLap {
  id: number;
  activity: { id: number };
  athlete?: { id: number };
  name: string;
  distance: number;
  elapsed_time: number;
  moving_time: number;
  start_date: string;
  start_date_local: string;
  start_index: number;
  end_index: number;
  total_elevation_gain?: number;
  average_speed?: number;
  max_speed?: number;
  average_cadence?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  device_watts?: boolean;
  average_watts?: number;
  pace_zone?: number | null;
  split?: number | null;
  lap_index?: number;
  resource_state?: number;
}

export interface StravaSegmentEffort {
  id: number;
  activity: { id: number };
  athlete?: { id: number };
  name: string;
  elapsed_time: number;
  moving_time: number;
  start_date: string;
  start_date_local: string;
  distance: number;
  start_index: number;
  end_index: number;
  average_cadence?: number;
  average_watts?: number;
  device_watts?: boolean;
  average_heartrate?: number;
  max_heartrate?: number;
  segment: StravaDetailedSegment;
  kom_rank?: number | null;
  pr_rank?: number | null;
  achievements?: unknown[];
  hidden?: boolean;
  resource_state?: number;
}

export interface StravaDetailedSegment {
  id: number;
  name: string;
  activity_type: string;
  distance: number;
  average_grade?: number;
  maximum_grade?: number;
  elevation_high?: number;
  elevation_low?: number;
  start_latlng?: [number, number] | null;
  end_latlng?: [number, number] | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  climb_category?: number;
  private?: boolean;
  starred?: boolean;
  hazardous?: boolean;
  resource_state?: number;
}

export interface StravaPhotosSummary {
  count?: number;
  use_primary_photo?: boolean;
  primary?: StravaPrimaryPhoto | null;
}

export interface StravaPrimaryPhoto {
  unique_id: string;
  source: number;
  urls?: Record<string, string>;
  caption?: string | null;
  uploaded_at?: string;
  created_at?: string;
}

export interface StravaHighlightedKudoser {
  destination_url?: string;
  display_name?: string;
  avatar_url?: string;
  show_name?: boolean;
}

// ── Comments & kudos ────────────────────────────────────────────────

export interface StravaComment {
  id: number;
  activity_id: number;
  text: string;
  created_at: string;
  athlete?: {
    id?: number;
    firstname?: string;
    lastname?: string;
  };
  cursor?: string;
}

/** Used by `/kudos` — Strava typically returns only firstname/lastname. */
export interface StravaSummaryAthlete {
  id?: number;
  firstname?: string;
  lastname?: string;
  username?: string;
  resource_state?: number;
}

// ── Activity zones ─────────────────────────────────────────────────

export interface StravaActivityZone {
  score?: number | null;
  type: "heartrate" | "power";
  sensor_based?: boolean;
  points?: number;
  custom_zones?: boolean;
  max?: number;
  distribution_buckets: StravaZoneBucket[];
  resource_state?: number;
}

export interface StravaZoneBucket {
  min: number;
  max: number;
  time: number;
}

// ── Streams ────────────────────────────────────────────────────────

/** All stream keys we request. Strava only returns those that exist for the activity. */
export const STREAM_KEYS = [
  "time",
  "distance",
  "latlng",
  "altitude",
  "velocity_smooth",
  "heartrate",
  "cadence",
  "watts",
  "temp",
  "moving",
  "grade_smooth",
] as const;

export type StreamKey = (typeof STREAM_KEYS)[number];

/** With `key_by_type=true`, response is an object keyed by stream type. */
export type StravaStreamSet = Partial<Record<StreamKey, StravaStream>>;

export interface StravaStream {
  type: string;
  data: number[] | number[][] | boolean[];
  series_type?: "time" | "distance";
  original_size?: number;
  resolution?: "low" | "medium" | "high";
}

// ── Athlete-level ──────────────────────────────────────────────────

export interface StravaDetailedAthlete {
  id: number;
  username?: string | null;
  firstname?: string | null;
  lastname?: string | null;
  bio?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  sex?: string | null;
  premium?: boolean;
  summit?: boolean;
  created_at?: string;
  updated_at?: string;
  badge_type_id?: number;
  weight?: number | null;
  ftp?: number | null;
  profile_medium?: string | null;
  profile?: string | null;
  measurement_preference?: string | null;
  date_preference?: string | null;
  athlete_type?: number;
  bikes?: StravaSummaryGear[];
  shoes?: StravaSummaryGear[];
  resource_state?: number;
}

export interface StravaSummaryGear {
  id: string;
  primary?: boolean;
  resource_state?: number;
  distance?: number;
  name?: string;
  retired?: boolean;
}

export interface StravaDetailedGear extends StravaSummaryGear {
  brand_name?: string | null;
  model_name?: string | null;
  frame_type?: number | null;
  description?: string | null;
  nickname?: string | null;
}

export interface StravaAthleteZones {
  heart_rate?: { custom_zones?: boolean; zones: Array<{ min: number; max: number }> };
  power?: { zones: Array<{ min: number; max: number }> };
}

export interface StravaActivityStats {
  biggest_ride_distance?: number | null;
  biggest_climb_elevation_gain?: number | null;
  recent_ride_totals?: StravaActivityTotal;
  recent_run_totals?: StravaActivityTotal;
  recent_swim_totals?: StravaActivityTotal;
  ytd_ride_totals?: StravaActivityTotal;
  ytd_run_totals?: StravaActivityTotal;
  ytd_swim_totals?: StravaActivityTotal;
  all_ride_totals?: StravaActivityTotal;
  all_run_totals?: StravaActivityTotal;
  all_swim_totals?: StravaActivityTotal;
}

export interface StravaActivityTotal {
  count?: number;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  elevation_gain?: number;
  achievement_count?: number;
}
