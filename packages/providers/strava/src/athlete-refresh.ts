// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tier 4 — one-shot athlete enrichment.
 *
 * Triggered after `backfill` completes (so detail-backfill can resolve
 * `gear_id` against `strava_gear`) and on a 7-day cadence inside
 * `incremental` thereafter.
 *
 * Endpoints (one of each per cycle):
 * - GET /athlete           → DetailedAthlete
 * - GET /athlete/zones     → HR + power zone definitions
 * - GET /athletes/{id}/stats → lifetime totals
 * - GET /gear/{id} for every distinct gear_id observed in `strava_activities`
 *
 * Side effect: when athlete `summit` flips false → true, the cursor logic
 * clears `zones_unavailable` so `zones-backfill` retries the activities.
 */

import { createLogger } from "@omnesis/core";
import { StravaForbiddenError, StravaNotFoundError, StravaScopeError } from "./client.js";
import {
  athleteToRecord,
  athleteZonesToRecords,
  athleteStatsToRecords,
  gearToRecord,
} from "./normalizer-detail.js";
import type { SourceAnalyticsAccess, StructuredSyncResult, TableWrite } from "@omnesis/source-sdk";
import type { StravaClient } from "./client.js";
import type { StravaActivitiesCursor } from "./types.js";

const log = createLogger("source:strava-athlete-refresh");

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
 * Walk the four athlete-level endpoints and the per-gear lookups, and return
 * everything they produced as one page.
 *
 * That page fills five tables: the athlete, its zones, its lifetime stats, the
 * gear catalogue, and the activity rows the resolved gear updates. They travel
 * together so the cursor that follows covers all of them.
 *
 * The activity rewrites are merged into a single set of rows keyed by activity
 * id, because two of them can land on the same activity — a Summit athlete
 * whose zone marks are being cleared may also own gear being resolved — and
 * two independent full-row rewrites of one row would let the later silently
 * undo the earlier.
 */
export async function syncAthleteRefresh(
  cur: StravaActivitiesCursor,
  nextPhase: StravaActivitiesCursor["phase"],
  deps: Deps,
): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
  const callBudget = await estimateCallBudget(deps);
  if (!deps.client.quota.canMakeNCalls(callBudget)) {
    log.warn(`Athlete-refresh: quota too low for ${callBudget} calls; deferring`);
    return { cursor: cur, hasMore: true };
  }

  const fetchedAt = new Date().toISOString();
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
  editActivities(await clearedZonesUnavailable(deps.analytics, Boolean(detailed.summit)), [
    "zones_unavailable",
    "zones_fetched_at",
  ]);

  // ── Athlete zones ─────────────────────────────────────────────────
  // Requires `profile:read_all` (which the default scope doesn't request)
  // and Summit on top. Skip on either a scope (401) or Summit (403) refusal.
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
  const gearIds = await distinctGearIds(deps.analytics);
  // Also pick up gear surfaced by the athlete profile that no activity
  // references yet (shoes for new Strava athletes, e.g.).
  for (const g of detailed.bikes ?? []) gearIds.add(g.id);
  for (const g of detailed.shoes ?? []) gearIds.add(g.id);
  log.info(`Athlete-refresh: resolving ${gearIds.size} gear IDs`);
  const gearRows: Record<string, unknown>[] = [];
  for (const id of gearIds) {
    if (!deps.client.quota.canMakeNCalls(1)) {
      log.warn("Athlete-refresh: quota exhausted mid-gear; partial gear catalogue this cycle");
      break;
    }
    try {
      const g = await deps.client.getGear(id);
      gearRows.push(gearToRecord(g, deps.athleteId));
    } catch (err) {
      if (err instanceof StravaNotFoundError || err instanceof StravaForbiddenError) {
        log.warn(`Gear ${id} unavailable: ${(err as Error).message}`);
        continue;
      }
      throw err;
    }
  }
  writes.push({ tableName: "strava_gear", records: gearRows });

  // ── Update activities with resolved gear name/brand/model ─────────
  if (gearRows.length > 0) {
    editActivities(await activitiesWithResolvedGear(deps.analytics, gearRows), [
      "gear_brand",
      "gear_model",
      "gear_name",
    ]);
  }
  if (activityEdits.size > 0) {
    writes.push({ tableName: "strava_activities", records: [...activityEdits.values()] });
  }

  log.info(`Athlete-refresh complete: profile + ${gearRows.length} gear items`);

  return {
    analytics: writes,
    cursor: {
      ...cur,
      phase: nextPhase,
      lastAthleteRefreshAt: fetchedAt,
    },
    hasMore: true,
  };
}

async function estimateCallBudget(deps: Deps): Promise<number> {
  // /athlete + /athlete/zones + /athletes/{id}/stats + N gear calls.
  // Rough estimate; if there are zero activities yet, gear count is 0.
  const ids = await distinctGearIds(deps.analytics);
  return 3 + ids.size;
}

async function distinctGearIds(analytics: SourceAnalyticsAccess): Promise<Set<string>> {
  try {
    const { rows } = await analytics.query(
      "SELECT DISTINCT gear_id FROM strava_activities WHERE gear_id IS NOT NULL",
    );
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
 * Activity rows whose Summit-only zone refusal no longer applies.
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
  analytics: SourceAnalyticsAccess,
  isSummit: boolean,
): Promise<Record<string, unknown>[]> {
  if (!isSummit) return [];
  const { rows } = await analytics.query(
    "SELECT count(*) AS n FROM strava_activities WHERE zones_unavailable = TRUE",
  );
  const n = Number((rows[0] as { n: number | bigint } | undefined)?.n ?? 0);
  if (n === 0) return [];
  const { rows: stale } = await analytics.query(
    "SELECT * FROM strava_activities WHERE zones_unavailable = TRUE LIMIT 5000",
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
 * Activity rows carrying the brand, model and name of gear just resolved.
 *
 * An activity records only its `gear_id` until the gear catalogue is walked;
 * this fills in the readable fields for the activities still missing them.
 *
 * Returns the rewritten rows rather than writing them, for the same reason as
 * {@link clearedZonesUnavailable}: one activity, one row.
 */
async function activitiesWithResolvedGear(
  analytics: SourceAnalyticsAccess,
  gearRows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const knownIds = gearRows.map((r) => `'${String(r.id).replace(/'/g, "''")}'`).join(",");
  if (!knownIds) return [];
  const sql = `SELECT * FROM strava_activities WHERE gear_id IN (${knownIds}) AND (gear_brand IS NULL OR gear_model IS NULL OR gear_name IS NULL)`;
  let rows: Record<string, unknown>[];
  try {
    const res = await analytics.query(sql);
    rows = res.rows;
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  const gearById = new Map(gearRows.map((r) => [String(r.id), r]));
  const updated = rows.map((row) => {
    const g = gearById.get(String(row.gear_id));
    if (!g) return row;
    return {
      ...row,
      gear_brand: g.brand_name ?? row.gear_brand,
      gear_model: g.model_name ?? row.gear_model,
      gear_name: (g.nickname as string | null) ?? (g.name as string | null) ?? row.gear_name,
    };
  });
  log.info(`Propagating resolved gear to ${updated.length} activities`);
  return updated;
}
