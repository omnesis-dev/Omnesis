// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  computeContentHash,
  formatLid,
  toCanonicalInstant,
  toCanonicalWallClock,
} from "@omnesis/core";
import { renderActivityMarkdown } from "./markdown.js";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";
import type {
  StravaSummaryActivity,
  StravaDetailedActivity,
  StravaComment,
  StravaSummaryAthlete,
} from "./types.js";

const STRAVA_ACTIVITY_URL = "https://www.strava.com/activities/";

/**
 * Keep the source's own string when it cannot be canonicalized.
 *
 * A value Strava sends in a shape this does not recognise is still the best
 * reading available; dropping it to null would lose a real timestamp to protect
 * a spelling. The row is written either way and the unparseable case is the one
 * a schema change would surface.
 */
export function canonicalOr(canonical: string | null, original: string): string {
  return canonical ?? original;
}

/** Resolved-gear blob (brand/model/name) — fed in from `strava_gear` lookups. */
export interface ResolvedGear {
  brand?: string | null;
  model?: string | null;
  /** User-assigned name (the field that's most often populated for shoes). */
  name?: string | null;
}

/**
 * Convert a Strava `SummaryActivity` (optionally enriched with DetailedActivity)
 * to a row for the `strava_activities` DuckDB table. Detail-only fields default
 * to `null` when no detail overlay is provided so subsequent `detail-backfill`
 * upserts don't have to migrate from "missing column" to "null".
 *
 * `summaryHash` is the deterministic hash that drives edit-detection; pass it
 * in so caller-side edit-sweep logic can decide whether to clear `*_fetched_at`
 * stamps via the same upsert.
 */
export function activityToRecord(
  a: StravaSummaryActivity,
  opts: {
    detail?: StravaDetailedActivity;
    gear?: ResolvedGear;
    /** Tier-stamp overrides — caller fills these on enrichment writes. */
    detailFetchedAt?: string | null;
    socialFetchedAt?: string | null;
    zonesFetchedAt?: string | null;
    zonesUnavailable?: boolean | null;
    streamsFetchedAt?: string | null;
    summaryHash?: string;
  } = {},
): Record<string, unknown> {
  const { detail, gear } = opts;
  const startLat = a.start_latlng?.[0] ?? null;
  const startLng = a.start_latlng?.[1] ?? null;
  const endLat = a.end_latlng?.[0] ?? null;
  const endLng = a.end_latlng?.[1] ?? null;
  return {
    id: a.id,
    athlete_id: a.athlete.id,
    name: a.name,
    sport_type: a.sport_type,
    activity_type: a.type ?? null,
    distance_m: a.distance,
    moving_time_seconds: a.moving_time,
    elapsed_time_seconds: a.elapsed_time,
    total_elevation_gain_m: a.total_elevation_gain,
    // Canonicalized rather than passed through, and by the column's declared
    // type: `start_time` is TIMESTAMPTZ so it reduces to one UTC instant,
    // `start_time_local` is TIMESTAMP so it keeps its wall-clock digits and
    // drops the designator Strava puts on them.
    //
    // Both phases build records here, but they do not hold the same strings:
    // the edit sweep has what the API sent, while enrichment rebuilds a
    // summary from the stored row and therefore has whatever the store
    // rendered on the way out — `2026-07-31T14:09:00Z` becomes
    // `2026-07-31 15:09:00+01`. Passing either through unchanged makes one
    // instant alternate between two spellings on every cycle, which every
    // consumer downstream that compares rendered values reads as a change.
    start_time: canonicalOr(toCanonicalInstant(a.start_date), a.start_date),
    start_time_local: canonicalOr(toCanonicalWallClock(a.start_date_local), a.start_date_local),
    timezone: a.timezone ?? null,
    average_speed_ms: a.average_speed ?? null,
    max_speed_ms: a.max_speed ?? null,
    average_cadence: a.average_cadence ?? null,
    average_temp: a.average_temp ?? null,
    average_heartrate_bpm: a.average_heartrate ?? null,
    max_heartrate_bpm: a.max_heartrate ?? null,
    average_watts: a.average_watts ?? null,
    max_watts: a.max_watts ?? null,
    weighted_average_watts: a.weighted_average_watts ?? null,
    kilojoules: a.kilojoules ?? null,
    elev_high_m: a.elev_high ?? null,
    elev_low_m: a.elev_low ?? null,
    has_heartrate: Boolean(a.has_heartrate),
    device_watts: a.device_watts ?? null,
    trainer: Boolean(a.trainer),
    commute: Boolean(a.commute),
    manual: Boolean(a.manual),
    private: Boolean(a.private),
    flagged: a.flagged ?? null,
    kudos_count: a.kudos_count ?? 0,
    comment_count: a.comment_count ?? 0,
    athlete_count: a.athlete_count ?? 1,
    achievement_count: a.achievement_count ?? null,
    photo_count: a.photo_count ?? null,
    total_photo_count: a.total_photo_count ?? null,
    pr_count: a.pr_count ?? null,
    suffer_score: a.suffer_score ?? null,
    perceived_exertion: detail?.perceived_exertion ?? null,
    prefer_perceived_exertion: detail?.prefer_perceived_exertion ?? null,
    calories: detail?.calories ?? null,
    description: detail?.description ?? null,
    device_name: detail?.device_name ?? null,
    embed_token: detail?.embed_token ?? null,
    workout_type: a.workout_type ?? null,
    location_city: a.location_city ?? null,
    location_state: a.location_state ?? null,
    location_country: a.location_country ?? null,
    gear_id: a.gear_id ?? null,
    gear_brand: gear?.brand ?? null,
    gear_model: gear?.model ?? null,
    gear_name: gear?.name ?? null,
    external_id: a.external_id ?? null,
    upload_id: a.upload_id ?? null,
    map_summary_polyline: a.map?.summary_polyline ?? null,
    map_polyline: detail?.map?.polyline ?? a.map?.polyline ?? null,
    start_lat: startLat,
    start_lng: startLng,
    end_lat: endLat,
    end_lng: endLng,
    photo_primary_url: pickPrimaryPhotoUrl(detail),
    available_zones: detail?.available_zones ? JSON.stringify(detail.available_zones) : null,
    summary_hash: opts.summaryHash ?? null,
    detail_fetched_at: opts.detailFetchedAt ?? null,
    social_fetched_at: opts.socialFetchedAt ?? null,
    zones_fetched_at: opts.zonesFetchedAt ?? null,
    zones_unavailable: opts.zonesUnavailable ?? null,
    streams_fetched_at: opts.streamsFetchedAt ?? null,
    strava_url: `${STRAVA_ACTIVITY_URL}${a.id}`,
  };
}

/** Build a searchable document for a Strava activity. */
export function activityToDocument(
  a: StravaSummaryActivity,
  providerId: ProviderId,
  sourceId: SourceId,
  opts: {
    /** Detailed activity overlay (description, splits, best efforts, photos). */
    detail?: StravaDetailedActivity;
    /** Comments fetched from /activities/{id}/comments. */
    comments?: StravaComment[];
    /** Kudoers fetched from /activities/{id}/kudos. */
    kudoers?: StravaSummaryAthlete[];
    /** Resolved gear name (from /gear/{id}). */
    gearName?: string;
    /**
     * Display name of the athlete that owns this activity. When provided,
     * attached as a `PersonMention` with role `owner` so the gateway's
     * people-identity resolution can merge this athlete with their records
     * in other sources.
     */
    athleteName?: string;
  } = {},
): DocumentInput {
  const content = renderActivityMarkdown(a, opts.detail, {
    gearName: opts.gearName,
    comments: opts.comments,
    kudoers: opts.kudoers?.map((k) => ({ firstname: k.firstname, lastname: k.lastname })),
  });

  const people: PersonMention[] = [];

  if (opts.athleteName) {
    people.push({
      role: "owner",
      name: opts.athleteName,
      // LID gives each Strava athlete a stable, matchable identity. The
      // gateway's people-identity resolution merges this with the self
      // identity via `detectSelfFromSourceIds`.
      lids: [formatLid("strava-athlete", String(a.athlete.id))],
    });
  }

  // Comment authors → people graph. Comments include athlete IDs when public.
  // Modeled as `participant` (they actively engaged with the activity); finer-
  // grained "Strava commenter" semantics survive in metadata.extra below.
  for (const c of opts.comments ?? []) {
    const name = [c.athlete?.firstname, c.athlete?.lastname].filter(Boolean).join(" ").trim();
    if (!name) continue;
    people.push({
      role: "participant",
      name,
      lids: c.athlete?.id ? [`strava-athlete:${c.athlete.id}`] : undefined,
    });
  }

  // Kudoers → people graph. Strava typically returns names only, so emit
  // name-only mentions; gateway dedupes against existing identities.
  // Modeled as `mentioned` — passive acknowledgement, not active engagement.
  for (const k of opts.kudoers ?? []) {
    const name = [k.firstname, k.lastname].filter(Boolean).join(" ").trim();
    if (!name) continue;
    people.push({
      role: "mentioned",
      name,
      lids: k.id ? [`strava-athlete:${k.id}`] : undefined,
    });
  }

  const photoUrls = collectPhotoUrls(opts.detail);

  return {
    providerId,
    sourceId,
    externalId: String(a.id),
    title: a.name,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "activity",
      sourceUrl: `${STRAVA_ACTIVITY_URL}${a.id}`,
      tags: [a.sport_type],
      people: people.length > 0 ? people : undefined,
      extra: {
        sportType: a.sport_type,
        activityType: a.type,
        gearId: a.gear_id ?? undefined,
        gearName: opts.gearName,
        externalId: a.external_id ?? undefined,
        athleteId: a.athlete.id,
        athleteUrl: `https://www.strava.com/athletes/${a.athlete.id}`,
        description: opts.detail?.description ?? undefined,
        deviceName: opts.detail?.device_name ?? undefined,
        calories: opts.detail?.calories ?? undefined,
        perceivedExertion: opts.detail?.perceived_exertion ?? undefined,
        mapPolyline: opts.detail?.map?.polyline ?? a.map?.polyline ?? undefined,
        mapSummaryPolyline: a.map?.summary_polyline ?? undefined,
        photoUrls: photoUrls.length > 0 ? photoUrls : undefined,
        kudosCount: a.kudos_count,
        commentCount: a.comment_count,
        achievementCount: a.achievement_count,
        prCount: a.pr_count,
      },
    },
    // Canonicalized for the same reason the record's columns are: this builder
    // is called by every phase, and they do not hold the same string for one
    // instant — the sweep has what the API sent, enrichment has what the store
    // rendered. Passing either through makes the document's own clock alternate
    // between two spellings while the activity sits still.
    sourceCreatedAt: canonicalOr(toCanonicalInstant(a.start_date), a.start_date),
    // SummaryActivity lacks an updated_at field. `start_date` is the best proxy
    // (the activity is effectively immutable from the athlete's POV once saved).
    sourceUpdatedAt: canonicalOr(toCanonicalInstant(a.start_date), a.start_date),
  };
}

function pickPrimaryPhotoUrl(detail?: StravaDetailedActivity): string | null {
  const urls = detail?.photos?.primary?.urls;
  if (!urls) return null;
  // Prefer the largest size that's present.
  return urls["600"] ?? urls["1024"] ?? urls["100"] ?? Object.values(urls)[0] ?? null;
}

function collectPhotoUrls(detail?: StravaDetailedActivity): string[] {
  const urls = detail?.photos?.primary?.urls;
  if (!urls) return [];
  return Array.from(new Set(Object.values(urls).filter(Boolean)));
}

// Re-export markdown renderer so callers don't need a second import.
export { renderActivityMarkdown };
