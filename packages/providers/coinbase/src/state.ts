// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What Coinbase persists between runs, and what should happen when it
 * cannot be read.
 *
 * The cursor is a phase machine (`types.ts` documents the full walk), and
 * every field but `phase` is optional — `snapshot-balances` carries a page
 * cursor, `snapshot-holdings` a portfolio index, `orders`/`fills` a
 * watermark and a running sweep max, `transactions` a per-wallet watermark
 * map. None of it is destructive to lose:
 *
 * - Balances and holdings are day-folded snapshots keyed on
 *   `(snapshot_date, …)`. Re-running `snapshot-balances` for today overwrites
 *   today's rows via `ON CONFLICT … DO UPDATE` — it cannot touch a prior
 *   day's rows, because those already carry an earlier `snapshot_date`. A
 *   day the source never got to snapshot is lost either way; losing the
 *   cursor does not make that worse.
 * - Orders, fills and the v2 ledger are append-only activity keyed on a
 *   stable upstream id (`order_id` / `trade_id` / the ledger transaction id).
 *   Coinbase keeps the full trade and ledger history for the item's
 *   lifetime, so dropping a watermark and re-walking from the beginning
 *   re-reads history Coinbase still has and re-upserts the same rows —
 *   idempotent, not destructive. `snapshot.ts`'s own `transactionsPage`
 *   already treats an invalidated Plaid-style delta the same way for a
 *   different reason (`INVALID_CURSOR`); losing the whole cursor is the same
 *   shape of recovery, just starting one phase earlier.
 *
 * So `onUnreadable: "rebootstrap"` costs a handful of extra list/page calls,
 * not a destructive or quota-threatening replay — Coinbase's REST limits
 * are per-second, not the 15-minute/daily budget a multi-tier enrichment
 * source like Strava has to protect. The value of declaring state here
 * anyway is observability: today, an unreadable cursor and a genuine first
 * run both silently produce `{ phase: "snapshot-balances" }` with nothing
 * to tell them apart in the log. Declaring `state` makes the collector log
 * a `rebootstrap` outcome by name.
 */

import { COINBASE_PHASES } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { CoinbaseCursor } from "./types.js";

export const COINBASE_STATE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function isOptionalStringRecord(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.values(value).every((entry) => typeof entry === "string"))
  );
}

export const coinbaseStateSpec: SourceStateSpec<CoinbaseCursor> = {
  version: COINBASE_STATE_VERSION,

  /**
   * Every field but `phase` is optional, and every phase in `snapshot.ts`
   * returns some subset of this same flat shape — a mid-`orders` walk (a
   * `pageCursor` and a running `ordersSweepMax`, watermark not yet promoted)
   * decodes exactly like a settled `incremental` cursor. Checking each
   * field's type once covers both, along with every other phase's partial
   * shape in between.
   */
  decode(value: unknown): CoinbaseCursor | null {
    if (!isRecord(value)) return null;
    if (typeof value.phase !== "string" || !COINBASE_PHASES.has(value.phase)) return null;
    if (!isOptionalString(value.pageCursor)) return null;
    if (!isOptionalString(value.snapshotDate)) return null;
    if (!isOptionalNumber(value.portfolioIndex)) return null;
    if (!isOptionalStringArray(value.portfolioUuids)) return null;
    if (!isOptionalString(value.lastSnapshotDate)) return null;
    if (!isOptionalString(value.ordersWatermark)) return null;
    if (!isOptionalString(value.ordersSweepMax)) return null;
    if (!isOptionalString(value.fillsWatermark)) return null;
    if (!isOptionalString(value.fillsSweepMax)) return null;
    if (!isOptionalStringArray(value.ledgerAccountIds)) return null;
    if (!isOptionalNumber(value.ledgerAccountIndex)) return null;
    if (!isOptionalStringRecord(value.ledgerWatermarks)) return null;
    if (!isOptionalString(value.ledgerSweepMax)) return null;
    if (value.ledgerUnavailable !== undefined && typeof value.ledgerUnavailable !== "boolean") {
      return null;
    }
    return value as unknown as CoinbaseCursor;
  },

  // No `maxBytes`: nothing here scales with the corpus. `portfolioUuids` and
  // `ledgerAccountIds` are resolved once per pass and sized to the account's
  // portfolio/wallet count (small and effectively fixed), not to how many
  // orders, fills or transactions the item has ever produced, and
  // `ledgerWatermarks` holds one entry per wallet for the same reason.

  /** See the module comment: cheap and idempotent, never destructive. */
  onUnreadable: "rebootstrap",
};
