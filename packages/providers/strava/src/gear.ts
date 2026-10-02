// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gear as an activity shows it.
 *
 * An activity names its gear by id alone. The athlete refresh walks the gear
 * catalogue into `strava_gear`, and every page after the first refresh that
 * writes an activity resolves the id against that catalogue, so the record and
 * the document carry the gear's name without waiting for the next weekly
 * refresh, and a summary written again does not empty the gear columns it
 * replaces. The pages before it, the backfill among them, leave the gear id
 * unresolved; the detail tier, which follows the first refresh, names it.
 */

import { createLogger } from "@omnesis/core";
import { gearIdList, ownedBy } from "./sql.js";
import type { SourceAnalyticsAccess } from "@omnesis/source-sdk";
import type { ResolvedGear } from "./normalizer.js";

const log = createLogger("source:strava-activities:gear");

/**
 * A catalogue row as the gear an activity carries. The refresh and every
 * activity write map it through here, so the columns they fill agree.
 */
export function gearFromCatalogue(row: Record<string, unknown>): ResolvedGear {
  return {
    brand: (row.brand_name as string | null | undefined) ?? null,
    model: (row.model_name as string | null | undefined) ?? null,
    name:
      (row.nickname as string | null | undefined) ??
      (row.name as string | null | undefined) ??
      null,
  };
}

/** The gear line a document shows: brand and model, else the gear's name. */
export function gearDisplayName(gear: ResolvedGear | undefined): string | undefined {
  if (gear?.brand && gear.model) return `${gear.brand} ${gear.model}`;
  return gear?.name ?? undefined;
}

/**
 * This athlete's catalogued gear among `gearIds`, by id, in one read.
 *
 * Read through the activities' owner predicate, since `strava_gear` names its
 * owner in the same column and every account the gateway hosts shares it.
 *
 * Empty when the read fails, as it does while no refresh has stored any gear
 * and the table does not exist: an activity then shows its gear id until a
 * later write resolves it, which costs the document a name rather than costing
 * the page.
 */
export async function storedGear(
  analytics: SourceAnalyticsAccess,
  athleteId: number,
  gearIds: readonly unknown[],
): Promise<Map<string, ResolvedGear>> {
  const byId = new Map<string, ResolvedGear>();
  const list = gearIdList(gearIds);
  if (!list) return byId;
  // Outside the `try`, so an invalid athlete fails the page rather than
  // reading as no gear.
  const sql = `SELECT * FROM strava_gear WHERE ${ownedBy(athleteId)} AND id IN (${list})`;
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await analytics.query(sql));
  } catch (err) {
    log.debug(`strava_gear unreadable for resolving gear: ${(err as Error).message}`);
    return byId;
  }
  for (const row of rows) byId.set(String(row.id), gearFromCatalogue(row));
  return byId;
}
