// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The owner predicate and the activity- and gear-id lists the phases splice
 * into their reads of the analytics store. The read handle takes SQL and
 * nothing to bind, so the ids that reach a query from stored state or the API
 * are checked here: an athlete id that is not an integer fails the read, and an
 * activity or gear id that is not one Strava would assign is left out.
 */

/**
 * The predicate that keeps a read of `strava_activities` to one account.
 *
 * Every Strava account the gateway hosts shares that table, and the read
 * handle checks which tables a query names, not which rows it returns. A row
 * of a sibling account read back here would be fetched with this account's
 * token and written under the sibling's athlete, which the gateway refuses;
 * the refused page then replays on every retry, and the source stops.
 */
export function ownedBy(athleteId: number): string {
  if (!Number.isSafeInteger(athleteId)) throw new Error(`Invalid Strava athlete id ${athleteId}`);
  return `athlete_id = ${athleteId}`;
}

/**
 * Activity ids as the body of an `IN (…)` list, empty when none is valid.
 *
 * Strava assigns integers, so an id that is not one is left out and the list
 * carries nothing but numerals, whether the ids came from a stored row, a
 * cursor or the API.
 */
export function activityIdList(ids: readonly unknown[]): string {
  return ids
    .map(Number)
    .filter((id) => Number.isSafeInteger(id))
    .join(", ");
}

/**
 * Gear ids as the body of an `IN (…)` list, each quoted once, empty when none
 * is valid.
 *
 * Strava's gear ids are a letter and digits (`b12345`, `g67890`), so an id
 * with anything else in it is left out and no id can close its quotes.
 */
export function gearIdList(ids: readonly unknown[]): string {
  const valid = ids.filter((id): id is string => typeof id === "string" && /^\w+$/.test(id));
  return [...new Set(valid)].map((id) => `'${id}'`).join(", ");
}
