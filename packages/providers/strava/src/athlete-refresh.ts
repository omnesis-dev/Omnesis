// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tier 4 — athlete enrichment, once per cycle.
 *
 * Triggered after `backfill` completes (so detail-backfill can resolve
 * `gear_id` against `strava_gear`) and on a 7-day cadence inside
 * `incremental` thereafter.
 *
 * Endpoints (one of each per cycle):
 * - GET /athlete           → DetailedAthlete
 * - GET /athlete/zones     → HR + power zone definitions
 * - GET /athletes/{id}/stats → lifetime totals
 * - GET /gear/{id} for every distinct gear_id on this athlete's
 *   `strava_activities` rows, its profile and its catalogue, paced per call:
 *   gear a window's reads cannot cover waits on the cursor (`pendingGearIds`)
 *   for the next window. Gear Strava answers with a 404 leaves the catalogue.
 *
 * Side effect: while the athlete has Summit, the refresh's first page clears
 * `zones_unavailable` so `zones-backfill` retries those activities (see
 * `clearedZonesUnavailable`).
 */

import { createLogger } from "@omnesis/core";
import {
  quotaDeferral,
  requireEnrichmentBudget,
  StravaForbiddenError,
  StravaNotFoundError,
  StravaScopeError,
} from "./client.js";
import {
  athleteToRecord,
  athleteZonesToRecords,
  athleteStatsToRecords,
  gearToRecord,
} from "./normalizer-detail.js";
import { gearFromCatalogue } from "./gear.js";
import { ENRICHMENT_SAFETY_PCT } from "./quota.js";
import { gearIdList, ownedBy } from "./sql.js";
import type { SourceAnalyticsAccess, StructuredSyncResult, TableWrite } from "@omnesis/source-sdk";
import type { StravaClient } from "./client.js";
import type { StravaActivitiesCursor } from "./types.js";

const log = createLogger("source:strava-activities:athlete-refresh");

/**
 * Reads a refresh spends before it reaches the gear catalogue: /athlete, its
 * stats and its zones.
 */
const PROFILE_CALLS = 3;

/** Cadence — 7 days between athlete-refresh runs. */
export const ATHLETE_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldRefreshAthlete(cur: StravaActivitiesCursor): boolean {
  if (!cur.lastAthleteRefreshAt) return true;
  const elapsed = Date.now() - new Date(cur.lastAthleteRefreshAt).getTime();
  return elapsed >= ATHLETE_REFRESH_INTERVAL_MS;
}

interface Deps {
  analytics: SourceAnalyticsAccess;
  client: StravaClient;
  athleteId: number;
  // No `sourceId`: it existed only to attribute ingested rows, and the host
  // now stamps that itself, so a source cannot label rows as another's.
}

/**
 * Walk the three athlete-level endpoints and as many per-gear lookups as the
 * budget allows, and return what they produced as one page.
 *
 * A page that starts the refresh fills five tables: the athlete, its zones, its
 * lifetime stats, the gear catalogue, and the activity rows the resolved gear
 * updates. They travel together so the cursor that follows covers all of them.
 * A page that resumes one fills only the last two.
 *
 * The activity rewrites are merged into a single set of rows keyed by activity
 * id, because two of them can land on the same activity — a Summit athlete
 * whose zone marks are being cleared may also own gear being resolved — and
 * two independent full-row rewrites of one row would let the later silently
 * undo the earlier.
 *
 * The gear catalogue is the part that grows: an athlete can own more gear than
 * one window's reads cover, so a gate sized to the whole catalogue would refuse
 * every window, and listing new activities would wait behind it. The page gates
 * only on the calls it cannot start without, at enrichment's share of the
 * budget, and rechecks at the same share before each gear call. When the budget
 * runs out it lands what it fetched and leaves the gear it did not reach on the
 * cursor; the next page, once the window allows, fetches only that remainder.
 * Throwing a deferral there instead would discard the fetched gear with the
 * page, and every window would pay for the same gear again and run out in the
 * same place.
 */
export async function syncAthleteRefresh(
  cur: StravaActivitiesCursor,
  nextPhase: StravaActivitiesCursor["phase"],
  deps: Deps,
): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
  // Set when an earlier page ran out of budget mid-catalogue: its profile half,
  // and the Summit clear with it, has landed already.
  const resumed = cur.pendingGearIds?.length ? cur.pendingGearIds : undefined;
  requireEnrichmentBudget("Athlete-refresh", resumed ? 1 : PROFILE_CALLS, deps.client.quota);

  const writes: TableWrite[] = [];
  // Activity rewrites, keyed by id so two edits to one activity compose into
  // one row instead of racing each other.
  const activityEdits = new Map<string, Record<string, unknown>>();
  const editActivities = (rows: Record<string, unknown>[], fields: readonly string[]) => {
    for (const row of rows) {
      const id = String(row.id);
      // Every query sees the stored row, so merge only the fields this edit
      // owns; copying that whole row would undo an earlier pending edit.
      const merged = { ...(activityEdits.get(id) ?? row) };
      for (const field of fields) merged[field] = row[field];
      activityEdits.set(id, merged);
    }
  };

  const gearIds =
    resumed ??
    (await refreshProfile(deps, cur.lastAthleteRefreshAt !== undefined, writes, editActivities));

  log.info(`Athlete-refresh: resolving ${gearIds.length} gear IDs`);
  const gearRows: Record<string, unknown>[] = [];
  // Gear Strava no longer has. Deleted by the write that stores `gearRows`,
  // which the host applies after its rows; the ids are distinct, so neither
  // undoes the other.
  const goneGearIds: string[] = [];
  let reached = 0;
  // Rechecked per call, at the gate's share: the gate covered only what this
  // page could not start without. Sharing it is also what lets a resumed page
  // that passed its gate always reach at least one gear.
  while (reached < gearIds.length && deps.client.quota.canMakeNCalls(1, ENRICHMENT_SAFETY_PCT)) {
    const id = gearIds[reached++]!;
    try {
      gearRows.push(gearToRecord(await deps.client.getGear(id), deps.athleteId));
    } catch (err) {
      // Deleted on Strava, so the catalogue lets it go too.
      if (err instanceof StravaNotFoundError) {
        log.info(`Gear ${id} is gone from Strava; removing it from the catalogue`);
        goneGearIds.push(id);
        continue;
      }
      // Skipped rather than retried: left on the cursor, gear that always
      // fails would hold the refresh in place, and the listing behind it. A
      // refusal is no sign the gear is gone, so its row stays.
      if (err instanceof StravaForbiddenError) {
        log.warn(`Gear ${id} unavailable: ${err.message}`);
        continue;
      }
      // A scope the grant lacks refuses every gear alike, and each refusal
      // costs two reads and a token refresh, so the rest are not asked for.
      if (err instanceof StravaScopeError) {
        log.warn(`${err.message}; skipping the remaining ${gearIds.length - reached} gear IDs`);
        reached = gearIds.length;
        break;
      }
      throw err;
    }
  }
  if (resumed && reached === 0) {
    // A page returning `hasMore` with its cursor unchanged would be asked for
    // again at once. Nothing has been called by this point, so the deferral
    // keeps the promise `StravaQuotaDeferral` makes.
    throw quotaDeferral("Athlete-refresh", 1, deps.client.quota, ENRICHMENT_SAFETY_PCT);
  }
  const pendingGearIds = gearIds.slice(reached);
  writes.push({
    tableName: "strava_gear",
    records: gearRows,
    ...(goneGearIds.length > 0 && { deletedKeys: goneGearIds.map((id) => ({ id })) }),
  });

  // ── Update activities with resolved gear name/brand/model ─────────
  if (gearRows.length > 0) {
    editActivities(await activitiesWithResolvedGear(deps, gearRows), [
      "gear_brand",
      "gear_model",
      "gear_name",
    ]);
  }
  if (activityEdits.size > 0) {
    writes.push({ tableName: "strava_activities", records: [...activityEdits.values()] });
  }

  if (pendingGearIds.length > 0) {
    log.info(
      `Athlete-refresh: read budget spent with ${pendingGearIds.length} of ${gearIds.length} gear IDs left; resuming when it allows`,
    );
    return {
      analytics: writes,
      cursor: { ...cur, phase: "athlete-refresh", pendingGearIds },
      hasMore: true,
    };
  }

  log.info(`Athlete-refresh complete: ${resumed ? "" : "profile + "}${gearRows.length} gear items`);

  return {
    analytics: writes,
    cursor: {
      ...cur,
      phase: nextPhase,
      // Stamped on completion: the cadence, and where the refresh hands over,
      // both read it as a refresh that has finished.
      lastAthleteRefreshAt: new Date().toISOString(),
      pendingGearIds: undefined,
    },
    hasMore: true,
  };
}

/**
 * The profile half of a refresh: the athlete, its zones and its lifetime
 * stats, written to `writes`, and the Summit clear, handed to `editActivities`.
 * Returns the gear the catalogue walk should resolve. `catalogued` says an
 * earlier refresh has finished, and so has stored a catalogue to recheck.
 */
async function refreshProfile(
  deps: Deps,
  catalogued: boolean,
  writes: TableWrite[],
  editActivities: (rows: Record<string, unknown>[], fields: readonly string[]) => void,
): Promise<string[]> {
  // ── Athlete profile + lifetime stats ──────────────────────────────
  // /athlete is covered by the basic `read` scope so it always works.
  const detailed = await deps.client.getAthleteDetail();
  const stats = await safeGetStats(deps);
  const athleteRow = athleteToRecord(
    detailed,
    stats?.biggest_ride_distance ?? null,
    stats?.biggest_climb_elevation_gain ?? null,
  );
  writes.push({ tableName: "strava_athlete", records: [athleteRow] });

  // Summit clears stale 403 marks so zones-backfill retries those activities.
  editActivities(await clearedZonesUnavailable(deps, Boolean(detailed.summit)), [
    "zones_unavailable",
    "zones_fetched_at",
  ]);

  // ── Athlete zones ─────────────────────────────────────────────────
  // Requires `profile:read_all`, which the athlete can untick on Strava's
  // consent screen, and Summit on top. Skip on either a scope (401) or Summit
  // (403) refusal.
  try {
    const zones = await deps.client.getAthleteZones();
    writes.push({
      tableName: "strava_athlete_zones",
      records: athleteZonesToRecords(deps.athleteId, zones),
    });
  } catch (err) {
    if (err instanceof StravaForbiddenError) {
      log.info("Athlete zones forbidden (non-Summit); skipping");
    } else if (err instanceof StravaScopeError) {
      log.info("Athlete zones missing scope (profile:read_all); skipping");
    } else {
      throw err;
    }
  }

  // ── Lifetime totals ───────────────────────────────────────────────
  if (stats) {
    writes.push({
      tableName: "strava_athlete_stats",
      records: athleteStatsToRecords(deps.athleteId, stats),
    });
  }

  // ── Gear catalog ──────────────────────────────────────────────────
  const gearIds = await distinctGearIds(deps);
  // Also pick up gear surfaced by the athlete profile that no activity
  // references yet (shoes for new Strava athletes, e.g.).
  for (const g of detailed.bikes ?? []) gearIds.add(g.id);
  for (const g of detailed.shoes ?? []) gearIds.add(g.id);
  // And the catalogue's own: gear that has left both the profile and every
  // activity is otherwise never asked about again, and only Strava's 404 says
  // it is gone. Absence from the profile does not: a grant without
  // `profile:read_all` lists no gear there at all.
  if (catalogued) for (const id of await storedGearIds(deps)) gearIds.add(id);
  return [...gearIds];
}

/**
 * This athlete's catalogued gear ids. By owner, since every account the
 * gateway hosts shares `strava_gear`, and a sibling's gear written back as this
 * athlete's is refused (see `ownedBy`).
 */
async function storedGearIds(deps: Deps): Promise<string[]> {
  // Outside the `try`, so an invalid athlete fails the page rather than
  // reading as no gear.
  const sql = `SELECT id FROM strava_gear WHERE ${ownedBy(deps.athleteId)}`;
  try {
    const { rows } = await deps.analytics.query(sql);
    return rows.map((r) => String((r as { id: unknown }).id));
  } catch (err) {
    log.warn(`storedGearIds: ${(err as Error).message}`);
    return [];
  }
}

async function distinctGearIds(deps: Deps): Promise<Set<string>> {
  // Outside the `try`, so an invalid athlete fails the page rather than
  // reading as no gear.
  const sql = `SELECT DISTINCT gear_id FROM strava_activities WHERE ${ownedBy(deps.athleteId)} AND gear_id IS NOT NULL`;
  try {
    const { rows } = await deps.analytics.query(sql);
    return new Set(
      rows.map((r) => String((r as { gear_id: unknown }).gear_id)).filter((s) => s && s !== "null"),
    );
  } catch (err) {
    // First run: table doesn't exist yet. Return empty set.
    log.warn(`distinctGearIds: ${(err as Error).message}`);
    return new Set();
  }
}

async function safeGetStats(
  deps: Deps,
): Promise<Awaited<ReturnType<StravaClient["getAthleteStats"]>> | null> {
  try {
    return await deps.client.getAthleteStats(deps.athleteId);
  } catch (err) {
    if (
      err instanceof StravaForbiddenError ||
      err instanceof StravaNotFoundError ||
      err instanceof StravaScopeError
    ) {
      log.info(`Athlete stats unavailable (${(err as Error).name}); skipping`);
      return null;
    }
    throw err;
  }
}

/**
 * This athlete's activity rows whose Summit-only zone refusal no longer
 * applies. Another account's Summit says nothing about this one's.
 *
 * A 403 from the zones endpoint marks an activity `zones_unavailable` so
 * zones-backfill stops asking. Summit lifts that refusal, but nothing upstream
 * announces the change, and the cursor cannot tell a fresh upgrade from a
 * steady subscription — so the clear runs whenever Summit is true, guarded by
 * a count so the common case costs one read and nothing else.
 *
 * Returns the rewritten rows rather than writing them: the caller merges them
 * with any other edits to the same activities and emits one row per activity.
 */
async function clearedZonesUnavailable(
  deps: Deps,
  isSummit: boolean,
): Promise<Record<string, unknown>[]> {
  if (!isSummit) return [];
  const refused = `${ownedBy(deps.athleteId)} AND zones_unavailable = TRUE`;
  const { rows } = await deps.analytics.query(
    `SELECT count(*) AS n FROM strava_activities WHERE ${refused}`,
  );
  const n = Number((rows[0] as { n: number | bigint } | undefined)?.n ?? 0);
  if (n === 0) return [];
  const { rows: stale } = await deps.analytics.query(
    `SELECT * FROM strava_activities WHERE ${refused} LIMIT 5000`,
  );
  const cleared = (stale as Record<string, unknown>[]).map((r) => ({
    ...r,
    zones_unavailable: false,
    zones_fetched_at: null,
  }));
  log.info(`Clearing zones_unavailable on ${cleared.length} activities (Summit detected)`);
  return cleared;
}

/**
 * This athlete's activity rows carrying the brand, model and name of gear
 * just resolved.
 *
 * An activity records only its `gear_id` until the gear catalogue is walked;
 * this fills in the readable fields for the activities still missing them.
 *
 * Returns the rewritten rows rather than writing them, for the same reason as
 * {@link clearedZonesUnavailable}: one activity, one row.
 */
async function activitiesWithResolvedGear(
  deps: Deps,
  gearRows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const knownIds = gearIdList(gearRows.map((r) => r.id));
  if (!knownIds) return [];
  const sql = `SELECT * FROM strava_activities WHERE ${ownedBy(deps.athleteId)} AND gear_id IN (${knownIds}) AND (gear_brand IS NULL OR gear_model IS NULL OR gear_name IS NULL)`;
  let rows: Record<string, unknown>[];
  try {
    const res = await deps.analytics.query(sql);
    rows = res.rows;
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  const gearById = new Map(gearRows.map((r) => [String(r.id), r]));
  const updated = rows.map((row) => {
    const g = gearById.get(String(row.gear_id));
    if (!g) return row;
    const gear = gearFromCatalogue(g);
    return {
      ...row,
      gear_brand: gear.brand ?? row.gear_brand,
      gear_model: gear.model ?? row.gear_model,
      gear_name: gear.name ?? row.gear_name,
    };
  });
  log.info(`Propagating resolved gear to ${updated.length} activities`);
  return updated;
}
