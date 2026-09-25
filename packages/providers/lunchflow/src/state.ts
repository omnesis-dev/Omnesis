// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a connected Lunch Flow connection persists between runs, and what
 * should happen when it cannot be read.
 *
 * Unlike Enable Banking's cache-backed bootstrap, this source has no
 * once-per-consent window to protect: `transactionsPage`'s first fetch for an
 * account (no `lastDate` yet) asks the Lunch Flow API for everything from the
 * configured data cutoff — the same request an ordinary API call can make at
 * any time, not a narrow prefetch captured during authentication. A lost
 * cursor restarts the phase machine at `{ phase: "accounts" }`, which walks
 * straight back through `accounts` → `transactions` → `balances` exactly as
 * a first connection would, re-requesting the same window from the same
 * always-available endpoint. The `[account_id, transaction_key]` /
 * `[account_id, snapshot_date]` composite-PK upserts make replaying it
 * idempotent, and nothing in this source ever deletes a row for going
 * unmentioned, so the data already stored from before the loss is untouched
 * either way. `onUnreadable: "rebootstrap"` costs a redundant re-fetch and
 * loses nothing.
 *
 * Every field here is bounded by the number of accounts one Lunch Flow
 * connection exposes — `accounts`, `lastDates` and `currencies` are all
 * one-entry-per-account, replaced or extended in place, never accumulating
 * per transaction or per day — so nothing here grows with the corpus the way
 * a per-file or per-session map would. No `maxBytes` ceiling.
 *
 * The cursor has gained two optional fields since this source shipped
 * (`accounts`, then `currencies`), and both were additive: code written
 * before either existed already treats its absence as "nothing captured
 * yet" rather than failing to decode. There is no shape a `legacyVersion`
 * needs to translate, so `version` stays at 1.
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { LunchflowCursor, LunchflowCursorAccount } from "./types.js";

const PHASES: ReadonlySet<string> = new Set<LunchflowCursor["phase"]>([
  "accounts",
  "transactions",
  "balances",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isOptionalStringMap(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every((v) => typeof v === "string"))
  );
}

function isCursorAccount(value: unknown): value is LunchflowCursorAccount {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.name === null || typeof value.name === "string") &&
    (value.institutionName === null || typeof value.institutionName === "string") &&
    (value.currency === null || typeof value.currency === "string")
  );
}

function isOptionalCursorAccountArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isCursorAccount));
}

export const lunchflowStateSpec: SourceStateSpec<LunchflowCursor> = {
  version: 1,

  /**
   * Every field but `phase` is optional, and the phase machine's pages each
   * return some subset of the same fields — a mid-`transactions` page (a
   * fresh `accountIndex`, `lastDates` untouched for that account) decodes
   * exactly like the settled `accounts` shape between ticks, so there is no
   * settled-vs-partial split to make here.
   */
  decode(value: unknown): LunchflowCursor | null {
    if (!isRecord(value)) return null;
    if (typeof value.phase !== "string" || !PHASES.has(value.phase)) return null;
    if (!isOptionalCursorAccountArray(value.accounts)) return null;
    if (!isOptionalNumber(value.accountIndex)) return null;
    if (!isOptionalStringMap(value.lastDates)) return null;
    if (!isOptionalString(value.lastBalancesDate)) return null;
    if (!isOptionalStringMap(value.currencies)) return null;
    return value as unknown as LunchflowCursor;
  },

  // No `maxBytes`: see the module comment — every field is bounded by
  // account count, not by transaction or day history.

  onUnreadable: "rebootstrap",
};
