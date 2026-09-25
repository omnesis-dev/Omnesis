// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a connected Enable Banking session persists between runs, and what
 * should happen when it cannot be read.
 *
 * The phase machine has two ways to recover its full-history bootstrap, and
 * a lost cursor only forces the cheaper of the two, never the destructive
 * one:
 *
 * - While any account's `bootstrap` phase is still draining, the raw pages
 *   the auth flow prefetched live in a cache keyed by `accountId` on the
 *   local filesystem — a separate persistence path from the sync cursor,
 *   untouched by the cursor becoming unreadable. `bootstrapPage` checks that
 *   cache directly (`completedBootstrapMarker`), not the cursor, so a fresh
 *   `{ phase: "accounts" }` start walks straight back into it and re-drains
 *   every page from the beginning — extra work, since pages already ingested
 *   get re-read, but no lost history, and the `[account_key, transaction_key]`
 *   composite-PK upsert makes replaying them idempotent.
 * - `initialBalancesPage` deletes that cache (`removeBootstrapCaches`) only
 *   once every account's bootstrap has fully drained into stored rows — by
 *   which point the full history the cache held is already durable and
 *   `onUnreadable` no longer has anything to protect. From here on, losing
 *   the cursor and restarting at `{ phase: "accounts" }` walks bootstrap
 *   again, finds no cache, and falls back to `bootstrapFromNetwork`'s 90-day
 *   window — cheap, and it changes nothing already on disk, because nothing
 *   in this source ever deletes a `bank_transactions` row for going
 *   unmentioned; it only ever upserts.
 *
 * So the two halves of "what does re-bootstrapping cost" are: mid-bootstrap,
 * a redundant re-drain of a cache that is still sitting right there; after
 * bootstrap, a redundant 90-day re-fetch over data that was never at risk.
 * Neither loses a transaction. `onUnreadable: "rebootstrap"` is not a
 * compromise, it is what this design already does on its own worst day (a
 * crash between "the last cached page drained" and "the next cursor write").
 *
 * The one field that is not bounded by account count is `windowHashCounts` —
 * occurrence counts for the rare transaction that arrives with neither
 * `entry_reference` nor `transaction_id` and has to be deduplicated by
 * content hash instead. It accumulates across every page of one account's
 * bootstrap walk before being dropped when that account finishes
 * (`advanceBootstrapAccount` does not carry it forward), so its ceiling is
 * sized against one account's full history, not the whole connection.
 *
 * Every field the phase machine has added since this source shipped
 * (`bootstrapSessionId`) has been optional and additive — code that predates
 * it already treats its absence as "no epoch to check" — so there is no
 * shape a `legacyVersion` needs to translate and `version` stays at 1.
 */

import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { EnableBankingCursor } from "./types.js";

const PHASES: ReadonlySet<string> = new Set<EnableBankingCursor["phase"]>([
  "accounts",
  "bootstrap",
  "balances",
  "incremental",
]);

const IN_STAGES: ReadonlySet<string> = new Set(["accounts-refresh", "balances", "transactions"]);

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

function isOptionalNumberMap(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every((v) => typeof v === "number"))
  );
}

export const enableBankingStateSpec: SourceStateSpec<EnableBankingCursor> = {
  version: 1,

  /**
   * Every field but `phase` is optional, and the phase machine's pages each
   * return some subset of the same fields — a mid-`bootstrap` page (a fresh
   * `cachePageIndex`, `incStage` untouched) decodes exactly like the settled
   * `incremental` shape, so there is no settled-vs-partial split to make here.
   */
  decode(value: unknown): EnableBankingCursor | null {
    if (!isRecord(value)) return null;
    if (typeof value.phase !== "string" || !PHASES.has(value.phase)) return null;
    if (!isOptionalNumber(value.accountIndex)) return null;
    if (!isOptionalNumber(value.cachePageIndex)) return null;
    if (!isOptionalString(value.bootstrapSessionId)) return null;
    if (!isOptionalString(value.continuationKey)) return null;
    if (!isOptionalString(value.windowMaxBookingDate)) return null;
    if (!isOptionalNumberMap(value.windowHashCounts)) return null;
    if (!isOptionalStringMap(value.lastBookingDates)) return null;
    if (!isOptionalStringMap(value.bootstrapReach)) return null;
    if (!isOptionalString(value.lastBalancesDate)) return null;
    if (value.incStage !== undefined && !IN_STAGES.has(value.incStage as string)) return null;
    if (!isOptionalNumber(value.incrementalAccountIndex)) return null;
    return value as unknown as EnableBankingCursor;
  },

  /**
   * A runaway guard, not a capacity limit. See the module comment:
   * `windowHashCounts` is the one field here that grows with transaction
   * volume rather than with account count, bounded by one account's full
   * bootstrap history before it is dropped. The ceiling sits well above what
   * even a large personal account's hash-fallback transactions could
   * plausibly total, so tripping it means an account never advances past
   * `bootstrap` (the counters never get dropped) rather than that its
   * history grew.
   */
  maxBytes: 8 * 1024 * 1024,

  onUnreadable: "rebootstrap",
};
