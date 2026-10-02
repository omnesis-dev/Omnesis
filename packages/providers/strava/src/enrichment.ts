// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-tier enrichment phases for Strava activities.
 *
 * Each phase pulls a small page of this account's pending activities from
 * the analytics DB (via the analytics's read primitive), calls the
 * corresponding Strava endpoint per ID, and emits records to the relevant
 * child tables plus UPDATE rows on `strava_activities` that stamp the
 * appropriate `<tier>_fetched_at` column.
 *
 * "Pending" is determined per tier by `<tier>_fetched_at IS NULL` (with
 * `zones_unavailable IS NOT TRUE` excluded from zones-backfill so Summit-only
 * 403s don't make us spin forever).
 *
 * Rate-limit safety is enforced at page entry, against enrichment's share of
 * the budget (`ENRICHMENT_SAFETY_PCT`): a page that share cannot cover throws
 * `StravaQuotaDeferral` before its first call. The activities source then lists
 * new activities in its place, and the next page resumes from the same cursor
 * and tier.
 */

import { createLogger, toCanonicalInstant, toCanonicalWallClock } from "@omnesis/core";
import {
  requireEnrichmentBudget,
  StravaForbiddenError,
  StravaNotFoundError,
  StravaScopeError,
} from "./client.js";
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
  withListedComparedFields,
} from "./normalizer-detail.js";
import {
  activityToRecord,
  activityToDocument,
  canonicalOr,
  type ResolvedGear,
} from "./normalizer.js";
import { gearDisplayName, storedGear } from "./gear.js";
import { activityIdList, ownedBy } from "./sql.js";
import type { SourceAnalyticsAccess, StructuredSyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { StravaClient } from "./client.js";
import type {
  StravaActivitiesCursor,
  StravaDetailedActivity,
  StravaSummaryActivity,
  StravaBestEffort,
  StravaComment,
  StravaSummaryAthlete,
  EnrichmentTier,
} from "./types.js";

const log = createLogger("source:strava-activities:enrichment");

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
 * - Rewrites the `strava_activities` row from the detail (description,
 *   calories and the rest; the fields the walks compare stay the listing's,
 *   see `summaryFromDetail`) and re-renders the document. The next page
 *   stamps `detail_fetched_at` (`pendingDetailStamps`).
 * - Replaces its rows in `strava_activity_splits`, `_best_efforts`, `_laps`,
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
    const rows = await rowsByIds(deps, cur.pendingDetailStamps);
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
  const pending = await pendingIds(deps, tierWhere("detail"), ENRICHMENT_PAGE_SIZE);
  if (pending.length === 0) {
    log.info("Detail-backfill complete; transitioning to social-backfill");
    return {
      result: structuredEmpty({
        ...cur,
        phase: "social-backfill",
      }),
    };
  }
  requireEnrichmentBudget("Detail-backfill", pending.length, deps.client.quota);

  const records: Record<string, unknown>[] = [];
  const splitsRows: Record<string, unknown>[] = [];
  const bestEffortRows: Record<string, unknown>[] = [];
  const lapRows: Record<string, unknown>[] = [];
  const segmentEffortRows: Record<string, unknown>[] = [];
  const documents: DocumentInput[] = [];
  const pendingDetailStamps: string[] = [];
  // The document is replaced whole, so it carries the comments and kudoers a
  // social page stored, or this page would remove them.
  const ids = pending.map((row) => row.id);
  const storedComments = await storedChildRows(
    deps.analytics,
    "strava_activity_comments",
    ids,
    "created_at",
  );
  const storedKudoers = await storedChildRows(
    deps.analytics,
    "strava_activity_kudos",
    ids,
    "position",
  );
  const catalogue = await storedGear(
    deps.analytics,
    deps.athleteId,
    pending.map((row) => row.gear_id),
  );

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

    const stored = rowToSummary(row);
    const summary = summaryFromDetail(stored, detail);
    // The hash is the one the row holds, which the listing stored, and the
    // fields it covers stay the listing's (see `summaryFromDetail`). The edit
    // sweep compares its listings with it, and the detail endpoint is not the
    // listing: a hashed field the two spelled differently would read as an
    // edit on every sweep, and each sweep would send the activity back here.
    // Read rather than recomputed, so a replay of this page, which reads back
    // the row it wrote, cannot move it either. Only a row stored before
    // listings kept a hash is given one here.
    const summaryHash =
      (row.summary_hash as string | null | undefined) ?? computeSummaryHash(stored);
    const gear = gearFor(summary.gear_id, catalogue, row, detail);

    records.push(
      activityToRecord(summary, {
        detail,
        gear,
        summaryHash,
        // This page marks detail only. The other tiers' marks stand, or an
        // activity they finished would be fetched by each of them again.
        socialFetchedAt: (row.social_fetched_at as string | null | undefined) ?? null,
        zonesFetchedAt: (row.zones_fetched_at as string | null | undefined) ?? null,
        zonesUnavailable: (row.zones_unavailable as boolean | null | undefined) ?? null,
        streamsFetchedAt: (row.streams_fetched_at as string | null | undefined) ?? null,
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
        comments: (storedComments.get(String(id)) ?? []).map(commentFromRow),
        kudoers: (storedKudoers.get(String(id)) ?? []).map(kudoerFromRow),
        athleteName: deps.athleteName,
        gearName: gearDisplayName(gear),
      }),
    );
  }

  log.info(`Detail-backfill: enriched ${pending.length} activities`);

  // Child rows precede the activity update. Successful detail stamps wait for
  // the following page, after the document and cursor have committed too.
  const replaced = pendingDetailStamps.map((activity_id) => ({ activity_id }));
  return {
    result: {
      analytics: [
        // A complete detail response replaces each child's group, including
        // an empty one. Upserts alone leave removed splits and efforts behind.
        // The clear is a write of its own, ahead of the rows: within one write
        // the host stores the rows before it applies the deletions, so a write
        // carrying both would delete the rows it had just written.
        ...[
          { tableName: "strava_activity_splits", records: splitsRows },
          { tableName: "strava_activity_best_efforts", records: bestEffortRows },
          { tableName: "strava_activity_laps", records: lapRows },
          { tableName: "strava_activity_segment_efforts", records: segmentEffortRows },
        ].flatMap((write) => [{ tableName: write.tableName, deletedKeys: replaced }, write]),
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
  const carriedRows = carried.length > 0 ? await rowsByIds(deps, carried) : [];
  const carriedStamps = carriedRows.map((row) =>
    stampOnlyRow(row, { social_fetched_at: new Date().toISOString() }),
  );

  // Excluded because their mark is in this very page and has not landed yet.
  // Only here, not in `tierWhere`: the rotation's count has to keep seeing
  // them until it lands, or enrich-pending would not come back to write it.
  const carriedIds = activityIdList(carried);
  const pending = await pendingIds(
    deps,
    carriedIds ? `${tierWhere("social")} AND id NOT IN (${carriedIds})` : tierWhere("social"),
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
  requireEnrichmentBudget("Social-backfill", pending.length * 2, deps.client.quota);

  const stampRows: Record<string, unknown>[] = [];
  const commentRows: Record<string, unknown>[] = [];
  const kudoRows: Record<string, unknown>[] = [];
  const documents: DocumentInput[] = [];
  // The activities this pass re-read in full. Both child tables are replaced
  // for these and only these, so an activity whose fetch failed keeps the
  // rows it already had.
  const refetched: string[] = [];
  // The document is replaced whole, so it carries the detail a detail page
  // stored, or this page would remove the description, the top results and
  // the rest of it.
  const storedEfforts = await storedChildRows(
    deps.analytics,
    "strava_activity_best_efforts",
    pending.map((row) => row.id),
    "distance_m",
  );
  const catalogue = await storedGear(
    deps.analytics,
    deps.athleteId,
    pending.map((row) => row.gear_id),
  );

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

    // Re-render the document with the freshly-fetched comments + kudoers. Its
    // counters stay Strava's own, as the row holds them, rather than the length
    // of these lists: the edit sweep and the rewalk compare the row's counters
    // with every listing's and send the activity back here when one moves, so
    // a count taken from a list that Strava's counter disagrees with — one cut
    // off at the page limit, or one leaving out what Strava counts but does not
    // show — would read as moved on every sweep, and fetch both lists each time.
    const detail = storedDetail(row, (storedEfforts.get(String(id)) ?? []).map(bestEffortFromRow));
    documents.push(
      activityToDocument(rowToSummary(row), deps.providerId, deps.sourceId, {
        detail,
        comments,
        kudoers,
        athleteName: deps.athleteName,
        gearName: gearDisplayName(gearFor(row.gear_id, catalogue, row)),
      }),
    );
  }

  log.info(
    `Social-backfill: enriched ${pending.length} activities (${commentRows.length} comments, ${kudoRows.length} kudos)`,
  );

  const activityRows = [...carriedStamps, ...stampRows];

  return {
    result: {
      // The marks in this page belong to the *previous* page's activities,
      // whose documents and cursor have already committed. This page's own
      // activities are marked on the next one — see `pendingSocialStamps` —
      // except those Strava would not show: they have no enrichment or document
      // here, so their mark lands now, or every page would fetch them again.
      //
      // A page's writes share a cursor, not a transaction: analytics is a
      // separate database and cannot join the cursor's commit, and the host
      // writes every analytics table before the documents. So a mark written
      // beside the enrichment it describes can outlive it — the mark lands,
      // the crash comes, the document never stores, and the retry filter skips
      // the activity forever because it looks finished.
      analytics: [
        ...(activityRows.length > 0
          ? [{ tableName: "strava_activities", records: activityRows }]
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
  const pending = await pendingIds(deps, tierWhere("zones"), ENRICHMENT_PAGE_SIZE);
  if (pending.length === 0) {
    log.info("Zones-backfill complete; transitioning to streams-backfill");
    return { result: structuredEmpty({ ...cur, phase: "streams-backfill" }) };
  }
  requireEnrichmentBudget("Zones-backfill", pending.length, deps.client.quota);

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
        // Clear, then write, as two writes in that order — the same shape as
        // the detail tier's child tables, and for the same reason.
        {
          tableName: "strava_activity_zones",
          deletedKeys: refetched.map((activity_id) => ({ activity_id })),
        },
        { tableName: "strava_activity_zones", records: zoneRows },
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
  const pending = await pendingIds(deps, tierWhere("streams"), ENRICHMENT_PAGE_SIZE);
  if (pending.length === 0) {
    log.info("Streams-backfill complete; transitioning to incremental");
    return { result: structuredEmpty({ ...cur, phase: "incremental" }) };
  }
  requireEnrichmentBudget("Streams-backfill", pending.length, deps.client.quota);

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
    const hasPending = await tierHasPending(deps, tier);
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

/** This account's stored rows for a known set of activity ids. */
async function rowsByIds(deps: PhaseDeps, ids: readonly string[]): Promise<PendingRow[]> {
  const list = activityIdList(ids);
  if (!list) return [];
  const { rows } = await deps.analytics.query(
    `SELECT * FROM strava_activities WHERE ${ownedBy(deps.athleteId)} AND id IN (${list})`,
  );
  return rows as unknown as PendingRow[];
}

/**
 * Up to `limit` of this account's activities matching `whereClause`, newest
 * first.
 *
 * **Both are interpolated, since the read handle binds nothing, so both must
 * be SQL this file controls — never user or API input.** The callers pass a
 * tier's predicate from `tierWhere(tier)`, where `tier` is the closed
 * `EnrichmentTier` union, and `ENRICHMENT_PAGE_SIZE`. The social tier adds the
 * ids its cursor carries, which are stored state rather than this file's SQL,
 * so they arrive as the numerals `activityIdList` reduces them to.
 */
async function pendingIds(
  deps: PhaseDeps,
  whereClause: string,
  limit: number,
): Promise<PendingRow[]> {
  const sql = `SELECT * FROM strava_activities WHERE ${ownedBy(deps.athleteId)} AND (${whereClause}) ORDER BY start_time DESC LIMIT ${limit}`;
  const { rows } = await deps.analytics.query(sql);
  return rows as unknown as PendingRow[];
}

async function tierHasPending(deps: PhaseDeps, tier: EnrichmentTier): Promise<boolean> {
  const sql = `SELECT count(*) AS n FROM strava_activities WHERE ${ownedBy(deps.athleteId)} AND (${tierWhere(tier)})`;
  const { rows } = await deps.analytics.query(sql);
  const n = Number((rows[0] as { n: number | bigint } | undefined)?.n ?? 0);
  return n > 0;
}

/**
 * The rows a tier has yet to enrich. The rotation counts with it and the
 * tier's page selects with it, so the two cannot disagree about what is
 * pending.
 */
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

/**
 * Rows of one of an activity's child tables, by activity id, in `orderBy`
 * order within each activity.
 *
 * For a document only: a tier renders the parts it did not fetch from what the
 * other tiers stored. A table no page has written to yet does not exist, and
 * reads as empty, as does any other failure, which costs the document those
 * parts until a tier renders it again rather than costing the page.
 *
 * By activity id alone: the ids come from this account's own rows, and an
 * owner predicate on top would hide the legacy rows the gateway has yet to
 * attribute to an owner.
 */
async function storedChildRows(
  analytics: SourceAnalyticsAccess,
  tableName: "strava_activity_best_efforts" | "strava_activity_comments" | "strava_activity_kudos",
  activityIds: readonly unknown[],
  orderBy: string,
): Promise<Map<string, Record<string, unknown>[]>> {
  const byActivity = new Map<string, Record<string, unknown>[]>();
  const ids = activityIdList(activityIds);
  if (!ids) return byActivity;
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await analytics.query(
      `SELECT * FROM ${tableName} WHERE activity_id IN (${ids}) ORDER BY activity_id, ${orderBy}`,
    ));
  } catch (err) {
    log.debug(`${tableName} unreadable for re-rendering: ${(err as Error).message}`);
    return byActivity;
  }
  for (const row of rows) {
    const key = String(row.activity_id);
    byActivity.set(key, [...(byActivity.get(key) ?? []), row]);
  }
  return byActivity;
}

/**
 * The detail a detail page stored for an activity, for a document rendered by
 * a tier that did not fetch it: what the row's detail columns and the stored
 * best efforts hold of what the document shows.
 */
function storedDetail(row: PendingRow, bestEfforts: StravaBestEffort[]): StravaDetailedActivity {
  const photoUrl = (row.photo_primary_url as string | null | undefined) ?? undefined;
  const caption = (row.photo_caption as string | null | undefined) ?? null;
  return {
    ...rowToSummary(row),
    description: (row.description as string | null | undefined) ?? null,
    calories: numOrUndef(row.calories) ?? null,
    device_name: (row.device_name as string | null | undefined) ?? null,
    perceived_exertion: numOrUndef(row.perceived_exertion) ?? null,
    best_efforts: bestEfforts,
    photos:
      photoUrl !== undefined || caption !== null
        ? { primary: { urls: photoUrl !== undefined ? { "600": photoUrl } : undefined, caption } }
        : undefined,
  };
}

function bestEffortFromRow(row: Record<string, unknown>): StravaBestEffort {
  return {
    id: Number(row.id),
    activity: { id: Number(row.activity_id) },
    name: String(row.name ?? ""),
    distance: Number(row.distance_m ?? 0),
    elapsed_time: Number(row.elapsed_time_seconds ?? 0),
    moving_time: Number(row.moving_time_seconds ?? 0),
    pr_rank: numOrUndef(row.pr_rank) ?? null,
  };
}

function commentFromRow(row: Record<string, unknown>): StravaComment {
  return {
    id: Number(row.id),
    activity_id: Number(row.activity_id),
    text: String(row.text ?? ""),
    created_at: String(row.created_at ?? ""),
    athlete: {
      id: numOrUndef(row.athlete_id),
      firstname: (row.athlete_firstname as string | null | undefined) ?? undefined,
      lastname: (row.athlete_lastname as string | null | undefined) ?? undefined,
    },
  };
}

function kudoerFromRow(row: Record<string, unknown>): StravaSummaryAthlete {
  return {
    id: numOrUndef(row.athlete_id),
    firstname: (row.firstname as string | null | undefined) ?? undefined,
    lastname: (row.lastname as string | null | undefined) ?? undefined,
  };
}

/** Build a stamp-only update row for `strava_activities` (id + the stamps). */
function stampOnlyRow(row: PendingRow, stamps: Record<string, unknown>): Record<string, unknown> {
  // Reuse the full row to avoid losing fields not under our control here.
  // The analytics-db upsert is `INSERT ... ON CONFLICT DO UPDATE SET <all-cols>`
  // — passing only stamps would null other columns. So we hydrate the full row.
  return { ...row, ...stamps };
}

/** Best-effort hydrate a SummaryActivity from the stored row. */
function rowToSummary(row: PendingRow): StravaSummaryActivity {
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
    map: {
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

/**
 * The summary a detail page writes: the activity as the detail response has
 * it, over the stored row for anything the response leaves out.
 *
 * The fields the walks compare with each listing are the exception and stay
 * the stored row's, which are the listing's, so the row keeps matching what
 * its listing gave it (see `withListedComparedFields`). An edit to one of them
 * — a rename, a crop — is a walk's to write, and so are counters that moved
 * since the listing: the walk that finds them moved sends the activity back to
 * the social tier, which fetches the comments and kudoers behind them. The
 * local start is canonicalized as `rowToSummary` canonicalizes the stored one,
 * and the owner stays the athlete the row was selected by.
 */
function summaryFromDetail(
  stored: StravaSummaryActivity,
  detail: StravaDetailedActivity,
): StravaSummaryActivity {
  return withListedComparedFields(
    {
      ...stored,
      ...detail,
      athlete: stored.athlete,
      start_date_local: detail.start_date_local
        ? canonicalOr(toCanonicalWallClock(detail.start_date_local), detail.start_date_local)
        : stored.start_date_local,
    },
    stored,
  );
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

/**
 * The gear `gearId` names, as an activity's record and document show it: the
 * catalogue's; else the name a detail response gives it, for gear the refresh
 * has yet to reach, such as new shoes; else what the row resolved for that
 * same id before.
 */
function gearFor(
  gearId: unknown,
  catalogue: Map<string, ResolvedGear>,
  row: PendingRow,
  detail?: StravaDetailedActivity,
): ResolvedGear | undefined {
  if (typeof gearId !== "string" || !gearId) return undefined;
  const named =
    detail?.gear?.id === gearId && detail.gear.name ? { name: detail.gear.name } : undefined;
  return catalogue.get(gearId) ?? named ?? (row.gear_id === gearId ? gearFromRow(row) : undefined);
}

/** Walk paginated endpoints until a short page is returned, or `maxPages` have been. */
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

/** A page that writes nothing and only moves the cursor: a phase handing over to the next. */
function structuredEmpty(
  cursor: StravaActivitiesCursor,
): StructuredSyncResult<StravaActivitiesCursor> {
  return { cursor, hasMore: false };
}
