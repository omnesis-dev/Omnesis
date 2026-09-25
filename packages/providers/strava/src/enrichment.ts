// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-tier enrichment phases for Strava activities.
 *
 * Each phase pulls a small page of pending activity IDs from the analytics
 * DB (via the analytics's read primitive), calls the corresponding Strava
 * endpoint per ID, and emits records to the relevant child tables plus
 * UPDATE rows on `strava_activities` that stamp the appropriate
 * `<tier>_fetched_at` column.
 *
 * "Pending" is determined per tier by `<tier>_fetched_at IS NULL` (with
 * `zones_unavailable IS NOT TRUE` excluded from zones-backfill so Summit-only
 * 403s don't make us spin forever).
 *
 * Rate-limit safety is enforced at page entry: if `client.quota.canMakeNCalls`
 * is false we return `hasMore: true` with the same cursor — the scheduler
 * retries past the next 15-min window reset.
 */

import { createLogger, toCanonicalInstant, toCanonicalWallClock } from "@omnesis/core";
import { StravaForbiddenError, StravaNotFoundError, StravaScopeError } from "./client.js";
import {
  splitsFromActivity,
  bestEffortsFromActivity,
  lapsFromActivity,
  segmentEffortsFromActivity,
  activityZonesToRecords,
  commentToRecord,
  kudoToRecord,
  streamSetToRecord,
  computeSummaryHash,
} from "./normalizer-detail.js";
import {
  activityToRecord,
  activityToDocument,
  canonicalOr,
  type ResolvedGear,
} from "./normalizer.js";
import type { SourceAnalyticsAccess, StructuredSyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { StravaClient } from "./client.js";
import type {
  StravaActivitiesCursor,
  StravaDetailedActivity,
  StravaSummaryActivity,
  StravaComment,
  StravaSummaryAthlete,
  EnrichmentTier,
} from "./types.js";

const log = createLogger("source:strava-enrichment");

/** Max activities to enrich per page. Conservative — keeps a single sync tick under ~20s. */
const ENRICHMENT_PAGE_SIZE = 10;

/** SQL row shape from `SELECT * FROM strava_activities WHERE …` — only the columns we use. */
interface PendingRow {
  id: number | bigint;
  name: string;
  athlete_id: number | bigint;
  sport_type: string;
  activity_type?: string | null;
  start_date_local?: string | null;
  start_time?: string | null;
  // Plus any other fields needed to rebuild a SummaryActivity. We hydrate from
  // the full row so the document re-render preserves summary metadata when no
  // detail overlay is present.
  [key: string]: unknown;
}

interface PhaseDeps {
  analytics: SourceAnalyticsAccess;
  client: StravaClient;
  sourceId: SourceId;
  providerId: ProviderId;
  athleteName?: string;
  athleteId: number;
}

interface PhaseResult {
  result: StructuredSyncResult<StravaActivitiesCursor>;
}

// ── Tier 1: detail-backfill ─────────────────────────────────────────

/**
 * Fetches DetailedActivity for up to ENRICHMENT_PAGE_SIZE activities lacking
 * `detail_fetched_at`. For each one:
 * - Updates the `strava_activities` row with description/calories/etc.,
 *   re-renders the document body, stamps `detail_fetched_at`.
 * - Emits records to `strava_activity_splits`, `_best_efforts`, `_laps`,
 *   `_segment_efforts`.
 *
 * Cursor stays in `detail-backfill` until the analytics DB reports zero
 * pending rows; then transitions to `social-backfill`.
 */
export async function syncDetailBackfill(
  cur: StravaActivitiesCursor,
  deps: PhaseDeps,
): Promise<PhaseResult> {
  // Only a returned cursor proves the child rows AND document committed.
  // Flush its bounded acknowledgements before fetching any new activities.
  if (cur.pendingDetailStamps?.length) {
    const rows = await rowsByIds(deps.analytics, cur.pendingDetailStamps);
    return {
      result: {
        analytics: [
          {
            tableName: "strava_activities",
            records: rows.map((row) =>
              stampOnlyRow(row, { detail_fetched_at: new Date().toISOString() }),
            ),
          },
        ],
        cursor: { ...cur, pendingDetailStamps: undefined },
        hasMore: true,
      },
    };
  }
  const pending = await pendingIds(
    deps.analytics,
    "detail_fetched_at IS NULL",
    ENRICHMENT_PAGE_SIZE,
  );
  if (pending.length === 0) {
    log.info("Detail-backfill complete; transitioning to social-backfill");
    return {
      result: structuredEmpty({
        ...cur,
        phase: "social-backfill",
      }),
    };
  }
  if (!deps.client.quota.canMakeNCalls(pending.length)) {
    log.warn(`Detail-backfill: quota too low for ${pending.length} calls; deferring`);
    return { result: structuredEmpty(cur, { hasMore: true }) };
  }

  const records: Record<string, unknown>[] = [];
  const splitsRows: Record<string, unknown>[] = [];
  const bestEffortRows: Record<string, unknown>[] = [];
  const lapRows: Record<string, unknown>[] = [];
  const segmentEffortRows: Record<string, unknown>[] = [];
  const documents: DocumentInput[] = [];
  const pendingDetailStamps: string[] = [];

  for (const row of pending) {
    const id = Number(row.id);
    let detail: StravaDetailedActivity;
    try {
      detail = await deps.client.getActivity(id);
    } catch (err) {
      if (err instanceof StravaNotFoundError || err instanceof StravaScopeError) {
        // 404: activity deleted between snapshot rewalks (snapshot phase will
        //       prune it).
        // Scope: token doesn't carry the right OAuth scope (e.g. private
        //        activity without `activity:read_all`). Stamping prevents
        //        infinite retry; user can re-auth later.
        log.warn(`Activity ${id} unavailable for detail fetch (${(err as Error).name}); stamping`);
        records.push(stampOnlyRow(row, { detail_fetched_at: new Date().toISOString() }));
        continue;
      }
      throw err;
    }

    const summary = rowToSummary(row, detail);
    const summaryHash = computeSummaryHash(summary);

    records.push(
      activityToRecord(summary, {
        detail,
        gear: gearFromRow(row),
        summaryHash,
      }),
    );
    pendingDetailStamps.push(String(id));

    splitsRows.push(...splitsFromActivity(detail));
    bestEffortRows.push(...bestEffortsFromActivity(detail));
    lapRows.push(...lapsFromActivity(detail));
    segmentEffortRows.push(...segmentEffortsFromActivity(detail));

    documents.push(
      activityToDocument(summary, deps.providerId, deps.sourceId, {
        detail,
        athleteName: deps.athleteName,
        gearName: gearNameFromRow(row),
      }),
    );
  }

  log.info(`Detail-backfill: enriched ${pending.length} activities`);

  // Child rows precede the activity update. Successful detail stamps wait for
  // the following page, after the document and cursor have committed too.
  return {
    result: {
      analytics: [
        // A complete detail response replaces each child's group, including
        // an empty one. Upserts alone leave removed splits and efforts behind.
        ...[
          { tableName: "strava_activity_splits", records: splitsRows },
          { tableName: "strava_activity_best_efforts", records: bestEffortRows },
          { tableName: "strava_activity_laps", records: lapRows },
          { tableName: "strava_activity_segment_efforts", records: segmentEffortRows },
        ].map((write) => ({
          ...write,
          deletedKeys: pendingDetailStamps.map((activity_id) => ({ activity_id })),
        })),
        { tableName: "strava_activities", records },
      ],
      documents,
      cursor: {
        ...cur,
        pendingDetailStamps: pendingDetailStamps.length ? pendingDetailStamps : undefined,
      },
      hasMore: true,
      progress: { phase: "incremental", processed: pending.length },
    },
  };
}

// ── Tier 2: social-backfill (comments + kudos) ──────────────────────

export async function syncSocialBackfill(
  cur: StravaActivitiesCursor,
  deps: PhaseDeps,
): Promise<PhaseResult> {
  // The previous page's activities are marked done here, now that their
  // documents and cursor have committed. Re-read rather than carried, because
  // the mark rewrites the whole row and a cursor may not grow with the corpus.
  const carried = cur.pendingSocialStamps ?? [];
  const carriedRows = carried.length > 0 ? await rowsByIds(deps.analytics, carried) : [];
  const carriedStamps = carriedRows.map((row) =>
    stampOnlyRow(row, { social_fetched_at: new Date().toISOString() }),
  );

  const pending = await pendingIds(
    deps.analytics,
    // Excluded because their mark is in this very page and has not landed yet.
    carried.length > 0
      ? `social_fetched_at IS NULL AND id NOT IN (${carried.map((id) => `'${id}'`).join(", ")})`
      : "social_fetched_at IS NULL",
    ENRICHMENT_PAGE_SIZE,
  );
  if (pending.length === 0) {
    if (carriedStamps.length > 0) {
      // One more page, carrying only the marks. The phase cannot end while an
      // activity it enriched is still unmarked, or the next cycle re-fetches it.
      log.info(`Social-backfill: marking ${carriedStamps.length} enriched activities done`);
      return {
        result: {
          analytics: [{ tableName: "strava_activities", records: carriedStamps }],
          cursor: { ...cur, pendingSocialStamps: undefined },
          hasMore: true,
          progress: { phase: "incremental", processed: 0 },
        },
      };
    }
    log.info("Social-backfill complete; transitioning to zones-backfill");
    return { result: structuredEmpty({ ...cur, phase: "zones-backfill" }) };
  }
  // 2 calls per activity (comments + kudos).
  if (!deps.client.quota.canMakeNCalls(pending.length * 2)) {
    log.warn(`Social-backfill: quota too low for ${pending.length * 2} calls; deferring`);
    return { result: structuredEmpty(cur, { hasMore: true }) };
  }

  const stampRows: Record<string, unknown>[] = [];
  const commentRows: Record<string, unknown>[] = [];
  const kudoRows: Record<string, unknown>[] = [];
  const documents: DocumentInput[] = [];
  // Activities whose kudoer list we actually read. An activity we could not
  // fetch is not on it, so its stored kudoers are left alone rather than
  // cleared in favour of nothing.
  // The activities this pass re-read in full. Both child tables are replaced
  // for these and only these, so an activity whose fetch failed keeps the
  // rows it already had.
  const refetched: string[] = [];

  for (const row of pending) {
    const id = Number(row.id);
    let comments: StravaComment[];
    let kudoers: StravaSummaryAthlete[];
    try {
      comments = await fetchAllPages((page) => deps.client.listActivityComments(id, { page }));
      kudoers = await fetchAllPages((page) => deps.client.listActivityKudos(id, { page }));
    } catch (err) {
      if (err instanceof StravaNotFoundError || err instanceof StravaScopeError) {
        log.warn(`Activity ${id} unavailable for social fetch (${(err as Error).name}); stamping`);
        stampRows.push(stampOnlyRow(row, { social_fetched_at: new Date().toISOString() }));
        continue;
      }
      throw err;
    }

    for (const c of comments) commentRows.push(commentToRecord({ ...c, activity_id: id }));
    kudoers.forEach((k, idx) => kudoRows.push(kudoToRecord(k, id, idx + 1)));
    refetched.push(String(id));

    // Re-render the document with the freshly-fetched comments + kudoers.
    const summary = rowToSummary(row);
    documents.push(
      activityToDocument(summary, deps.providerId, deps.sourceId, {
        comments,
        kudoers,
        athleteName: deps.athleteName,
        gearName: gearNameFromRow(row),
      }),
    );
  }

  log.info(
    `Social-backfill: enriched ${pending.length} activities (${commentRows.length} comments, ${kudoRows.length} kudos)`,
  );

  return {
    result: {
      // The marks in this page belong to the *previous* page's activities,
      // whose documents and cursor have already committed. This page's own
      // activities are marked on the next one — see `pendingSocialStamps`.
      //
      // A page's writes share a cursor, not a transaction: analytics is a
      // separate database and cannot join the cursor's commit, and the host
      // writes every analytics table before the documents. So a mark written
      // beside the enrichment it describes can outlive it — the mark lands,
      // the crash comes, the document never stores, and the retry filter skips
      // the activity forever because it looks finished.
      analytics: [
        ...(carriedStamps.length > 0
          ? [{ tableName: "strava_activities", records: carriedStamps }]
          : []),
        // Comments are re-read in full on every pass, so the stored set has to
        // be replaced rather than merged into: a comment deleted upstream is
        // simply missing from the new list, and merging would keep it forever.
        // Same clear-then-write shape as the kudoers below, and the same
        // scope — only activities this pass actually re-read.
        {
          tableName: "strava_activity_comments",
          deletedKeys: refetched.map((activity_id) => ({ activity_id })),
        },
        { tableName: "strava_activity_comments", records: commentRows },
        // Kudoers are keyed `(activity_id, position)` with position running
        // 1..N over the current list, so an activity that loses a kudoer would
        // strand positions N+1..oldMax. Clearing the activity's rows before
        // writing the fresh list is what keeps the table equal to the current
        // kudoers rather than the high-water mark of everyone who ever was
        // one. The host applies these two writes in the order given.
        {
          tableName: "strava_activity_kudos",
          deletedKeys: refetched.map((activity_id) => ({ activity_id })),
        },
        { tableName: "strava_activity_kudos", records: kudoRows },
      ],
      documents,
      cursor: { ...cur, pendingSocialStamps: refetched.length > 0 ? refetched : undefined },
      hasMore: true,
      progress: { phase: "incremental", processed: pending.length },
    },
  };
}

// ── Tier 3: zones-backfill ──────────────────────────────────────────

export async function syncZonesBackfill(
  cur: StravaActivitiesCursor,
  deps: PhaseDeps,
): Promise<PhaseResult> {
  const pending = await pendingIds(
    deps.analytics,
    "zones_fetched_at IS NULL AND (zones_unavailable IS NULL OR zones_unavailable = FALSE)",
    ENRICHMENT_PAGE_SIZE,
  );
  if (pending.length === 0) {
    log.info("Zones-backfill complete; transitioning to streams-backfill");
    return { result: structuredEmpty({ ...cur, phase: "streams-backfill" }) };
  }
  if (!deps.client.quota.canMakeNCalls(pending.length)) {
    return { result: structuredEmpty(cur, { hasMore: true }) };
  }

  const stampRows: Record<string, unknown>[] = [];
  const zoneRows: Record<string, unknown>[] = [];
  const refetched: number[] = [];

  for (const row of pending) {
    const id = Number(row.id);
    try {
      const zones = await deps.client.getActivityZones(id);
      refetched.push(id);
      zoneRows.push(...activityZonesToRecords(id, zones));
      stampRows.push(stampOnlyRow(row, { zones_fetched_at: new Date().toISOString() }));
    } catch (err) {
      if (err instanceof StravaForbiddenError) {
        // Summit-only — mark permanently and never retry.
        stampRows.push(
          stampOnlyRow(row, {
            zones_unavailable: true,
            zones_fetched_at: new Date().toISOString(),
          }),
        );
        continue;
      }
      if (err instanceof StravaNotFoundError || err instanceof StravaScopeError) {
        stampRows.push(stampOnlyRow(row, { zones_fetched_at: new Date().toISOString() }));
        continue;
      }
      throw err;
    }
  }

  log.info(
    `Zones-backfill: enriched ${pending.length} activities (${zoneRows.length} zone buckets)`,
  );

  return {
    result: {
      analytics: [
        {
          tableName: "strava_activity_zones",
          records: zoneRows,
          deletedKeys: refetched.map((activity_id) => ({ activity_id })),
        },
        { tableName: "strava_activities", records: stampRows },
      ],
      cursor: { ...cur },
      hasMore: true,
      progress: { phase: "incremental", processed: pending.length },
    },
  };
}

// ── Tier 5: streams-backfill ────────────────────────────────────────

export async function syncStreamsBackfill(
  cur: StravaActivitiesCursor,
  deps: PhaseDeps,
): Promise<PhaseResult> {
  const pending = await pendingIds(
    deps.analytics,
    "streams_fetched_at IS NULL",
    ENRICHMENT_PAGE_SIZE,
  );
  if (pending.length === 0) {
    log.info("Streams-backfill complete; transitioning to incremental");
    return { result: structuredEmpty({ ...cur, phase: "incremental" }) };
  }
  if (!deps.client.quota.canMakeNCalls(pending.length)) {
    return { result: structuredEmpty(cur, { hasMore: true }) };
  }

  const stampRows: Record<string, unknown>[] = [];
  const streamRows: Record<string, unknown>[] = [];

  for (const row of pending) {
    const id = Number(row.id);
    try {
      const set = await deps.client.getActivityStreams(id);
      streamRows.push(streamSetToRecord(id, set));
      stampRows.push(stampOnlyRow(row, { streams_fetched_at: new Date().toISOString() }));
    } catch (err) {
      if (
        err instanceof StravaNotFoundError ||
        err instanceof StravaForbiddenError ||
        err instanceof StravaScopeError
      ) {
        // Manual-logged or no-streams activities return 404 / 403. Stamp so
        // we don't loop. Scope errors get the same treatment.
        stampRows.push(stampOnlyRow(row, { streams_fetched_at: new Date().toISOString() }));
        continue;
      }
      throw err;
    }
  }

  log.info(`Streams-backfill: enriched ${pending.length} activities`);

  return {
    result: {
      analytics: [
        { tableName: "strava_activity_streams", records: streamRows },
        { tableName: "strava_activities", records: stampRows },
      ],
      cursor: { ...cur },
      hasMore: true,
      progress: { phase: "incremental", processed: pending.length },
    },
  };
}

// ── enrich-pending: rotates across the four tiers ──────────────────

const TIER_ORDER: EnrichmentTier[] = ["detail", "social", "zones", "streams"];

export async function syncEnrichPending(
  cur: StravaActivitiesCursor,
  deps: PhaseDeps,
): Promise<PhaseResult> {
  if (cur.pendingDetailStamps?.length) {
    const { result } = await syncDetailBackfill(cur, deps);
    return { result: { ...result, cursor: { ...result.cursor, phase: "enrich-pending" } } };
  }
  const startIdx = cur.enrichTier ? TIER_ORDER.indexOf(cur.enrichTier) : 0;
  for (let offset = 0; offset < TIER_ORDER.length; offset++) {
    const tier = TIER_ORDER[(startIdx + offset) % TIER_ORDER.length]!;
    const hasPending = await tierHasPending(deps.analytics, tier);
    if (!hasPending) continue;
    const nextTier = TIER_ORDER[(TIER_ORDER.indexOf(tier) + 1) % TIER_ORDER.length]!;
    const cursorWithTier: StravaActivitiesCursor = { ...cur, enrichTier: nextTier };
    switch (tier) {
      case "detail":
        return syncDetailBackfill({ ...cursorWithTier, phase: "detail-backfill" }, deps).then(
          (r) => ({
            // Re-route the post-tier transition: enrich-pending stays in
            // enrich-pending and just rotates the tier marker.
            result: { ...r.result, cursor: { ...r.result.cursor, phase: "enrich-pending" } },
          }),
        );
      case "social":
        return syncSocialBackfill({ ...cursorWithTier, phase: "social-backfill" }, deps).then(
          (r) => ({
            result: { ...r.result, cursor: { ...r.result.cursor, phase: "enrich-pending" } },
          }),
        );
      case "zones":
        return syncZonesBackfill({ ...cursorWithTier, phase: "zones-backfill" }, deps).then(
          (r) => ({
            result: { ...r.result, cursor: { ...r.result.cursor, phase: "enrich-pending" } },
          }),
        );
      case "streams":
        return syncStreamsBackfill({ ...cursorWithTier, phase: "streams-backfill" }, deps).then(
          (r) => ({
            result: { ...r.result, cursor: { ...r.result.cursor, phase: "enrich-pending" } },
          }),
        );
    }
  }
  // No tier had pending rows — fall back to incremental.
  return { result: structuredEmpty({ ...cur, phase: "incremental" }) };
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * String-interpolate the WHERE clause + LIMIT into the analytics query.
 *
 * **The interpolated values must be literal SQL fragments controlled by
 * this file — never user / API input.** All current callers pass either:
 *
 * - A literal `tier_fetched_at IS NULL` predicate from `tierWhere(tier)`,
 *   where `tier` is the closed `EnrichmentTier` union; or
 * - A literal numeric constant (`ENRICHMENT_PAGE_SIZE`) for the limit.
 *
 * The interpolation pattern is deliberate (the analytics's
 * `queryAnalytics` doesn't bind LIMIT or compose WHERE clauses for
 * us, and the schema shape is fixed), but new callers MUST keep the
 * same discipline. If you find yourself wanting to pass a user-supplied
 * filter through here, switch to a parameterised binding instead — the
 * read-only SQL endpoint already supports `?` placeholders.
 */
/** The stored rows for a known set of activity ids. */
async function rowsByIds(
  analytics: SourceAnalyticsAccess,
  ids: readonly string[],
): Promise<PendingRow[]> {
  const list = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
  const { rows } = await analytics.query(`SELECT * FROM strava_activities WHERE id IN (${list})`);
  return rows as unknown as PendingRow[];
}

async function pendingIds(
  analytics: SourceAnalyticsAccess,
  whereClause: string,
  limit: number,
): Promise<PendingRow[]> {
  const sql = `SELECT * FROM strava_activities WHERE ${whereClause} ORDER BY start_time DESC LIMIT ${limit}`;
  const { rows } = await analytics.query(sql);
  return rows as unknown as PendingRow[];
}

async function tierHasPending(
  analytics: SourceAnalyticsAccess,
  tier: EnrichmentTier,
): Promise<boolean> {
  const where = tierWhere(tier);
  const sql = `SELECT count(*) AS n FROM strava_activities WHERE ${where}`;
  const { rows } = await analytics.query(sql);
  const n = Number((rows[0] as { n: number | bigint } | undefined)?.n ?? 0);
  return n > 0;
}

function tierWhere(tier: EnrichmentTier): string {
  switch (tier) {
    case "detail":
      return "detail_fetched_at IS NULL";
    case "social":
      return "social_fetched_at IS NULL";
    case "zones":
      return "zones_fetched_at IS NULL AND (zones_unavailable IS NULL OR zones_unavailable = FALSE)";
    case "streams":
      return "streams_fetched_at IS NULL";
  }
}

/** Build a stamp-only update row for `strava_activities` (id + the stamps). */
function stampOnlyRow(row: PendingRow, stamps: Record<string, unknown>): Record<string, unknown> {
  // Reuse the full row to avoid losing fields not under our control here.
  // The analytics-db upsert is `INSERT ... ON CONFLICT DO UPDATE SET <all-cols>`
  // — passing only stamps would null other columns. So we hydrate the full row.
  return { ...row, ...stamps };
}

/** Best-effort hydrate a SummaryActivity from the stored row. */
function rowToSummary(row: PendingRow, detail?: StravaDetailedActivity): StravaSummaryActivity {
  return {
    id: Number(row.id),
    athlete: { id: Number(row.athlete_id) },
    name: String(row.name ?? ""),
    distance: Number(row.distance_m ?? 0),
    moving_time: Number(row.moving_time_seconds ?? 0),
    elapsed_time: Number(row.elapsed_time_seconds ?? 0),
    total_elevation_gain: Number(row.total_elevation_gain_m ?? 0),
    type: (row.activity_type as string | null) ?? undefined,
    sport_type: String(row.sport_type ?? ""),
    // Canonicalized here, where the store's rendering of an instant re-enters
    // the pipeline. The sweep phase holds what the API sent; this phase holds
    // what the analytics store handed back, and the two spell the same instant
    // differently. Everything built from this summary — the record, the
    // document, the digest — would otherwise inherit whichever spelling the
    // phase happened to have, and alternate on every cycle.
    start_date: canonicalOr(
      toCanonicalInstant(row.start_time),
      String(row.start_time ?? new Date(0).toISOString()),
    ),
    start_date_local: canonicalOr(
      toCanonicalWallClock(row.start_time_local ?? row.start_time),
      String(row.start_time_local ?? row.start_time ?? new Date(0).toISOString()),
    ),
    timezone: (row.timezone as string | null) ?? undefined,
    location_city: (row.location_city as string | null) ?? null,
    location_state: (row.location_state as string | null) ?? null,
    location_country: (row.location_country as string | null) ?? null,
    achievement_count: numOrUndef(row.achievement_count),
    kudos_count: numOrUndef(row.kudos_count),
    comment_count: numOrUndef(row.comment_count),
    athlete_count: numOrUndef(row.athlete_count),
    photo_count: numOrUndef(row.photo_count),
    total_photo_count: numOrUndef(row.total_photo_count),
    trainer: Boolean(row.trainer),
    commute: Boolean(row.commute),
    manual: Boolean(row.manual),
    private: Boolean(row.private),
    flagged: Boolean(row.flagged),
    gear_id: (row.gear_id as string | null) ?? null,
    average_speed: numOrUndef(row.average_speed_ms),
    max_speed: numOrUndef(row.max_speed_ms),
    average_cadence: numOrUndef(row.average_cadence),
    average_temp: numOrUndef(row.average_temp),
    average_watts: numOrUndef(row.average_watts),
    max_watts: numOrUndef(row.max_watts),
    weighted_average_watts: numOrUndef(row.weighted_average_watts),
    kilojoules: numOrUndef(row.kilojoules),
    device_watts: row.device_watts == null ? undefined : Boolean(row.device_watts),
    has_heartrate: Boolean(row.has_heartrate),
    average_heartrate: numOrUndef(row.average_heartrate_bpm),
    max_heartrate: numOrUndef(row.max_heartrate_bpm),
    elev_high: numOrUndef(row.elev_high_m),
    elev_low: numOrUndef(row.elev_low_m),
    upload_id: numOrUndef(row.upload_id),
    external_id: (row.external_id as string | null) ?? null,
    pr_count: numOrUndef(row.pr_count),
    suffer_score: numOrUndef(row.suffer_score),
    workout_type: numOrUndef(row.workout_type),
    map: detail?.map ?? {
      polyline: (row.map_polyline as string | null) ?? undefined,
      summary_polyline: (row.map_summary_polyline as string | null) ?? undefined,
    },
    start_latlng:
      row.start_lat != null && row.start_lng != null
        ? [Number(row.start_lat), Number(row.start_lng)]
        : null,
    end_latlng:
      row.end_lat != null && row.end_lng != null
        ? [Number(row.end_lat), Number(row.end_lng)]
        : null,
  };
}

function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  return Number(v);
}

function gearFromRow(row: PendingRow): ResolvedGear | undefined {
  if (!row.gear_brand && !row.gear_model && !row.gear_name) return undefined;
  return {
    brand: (row.gear_brand as string | null) ?? null,
    model: (row.gear_model as string | null) ?? null,
    name: (row.gear_name as string | null) ?? null,
  };
}

function gearNameFromRow(row: PendingRow): string | undefined {
  const brand = (row.gear_brand as string | null) ?? null;
  const model = (row.gear_model as string | null) ?? null;
  const name = (row.gear_name as string | null) ?? null;
  if (brand && model) return `${brand} ${model}`;
  if (name) return name;
  return undefined;
}

/** Walk paginated endpoints until a short page is returned. */
async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
  perPage = 200,
  maxPages = 5,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const got = await fetchPage(page);
    all.push(...got);
    if (got.length < perPage) break;
  }
  return all;
}

/**
 * A page that writes nothing and only moves the cursor — a phase handing over
 * to the next, or one deferring because the rate-limit window is spent.
 */
function structuredEmpty(
  cursor: StravaActivitiesCursor,
  opts: { hasMore?: boolean } = {},
): StructuredSyncResult<StravaActivitiesCursor> {
  return {
    cursor,
    hasMore: opts.hasMore ?? false,
  };
}
