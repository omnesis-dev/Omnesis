// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a connected Plaid item persists between runs, and what should happen
 * when it cannot be read.
 *
 * Every field but `phase` is optional and none of them grows with the item's
 * history: `transactionsCursor` is a single opaque token Plaid mints and
 * returns on every `/transactions/sync` call, and `snapshotDate` /
 * `lastSnapshotDate` are one UTC day each. Losing any of it is cheap and
 * non-destructive:
 *
 * - Balances and holdings are day-folded snapshots (composite PK on
 *   `snapshot_date`), so re-running `snapshot-balances`/`snapshot-holdings`
 *   for today only overwrites today's rows; it cannot reach a prior day's.
 * - `/transactions/sync` is Plaid's own delta cursor. Calling it with no
 *   cursor re-fetches the item's full available history (bounded by the
 *   `days_requested` the item was linked with — no worse than what an
 *   incremental sync already assumes) and the composite-PK
 *   `(item_id, transaction_id)` upsert makes replaying it idempotent.
 *   `transactions.ts`'s own `transactionsPage` already does exactly this on
 *   Plaid's `INVALID_CURSOR` (a cursor Plaid itself revoked, e.g. after
 *   re-consent): "the composite-PK upserts make the full re-walk idempotent
 *   — no duplicates, no data loss." Losing the whole cursor takes the same
 *   path, just from the phase machine's start rather than mid-`transactions`.
 *
 * So `onUnreadable: "rebootstrap"` is not a compromise here — it is the
 * behaviour this source already chose for the one case where Plaid forces the
 * question. Declaring `state` extends it to every other way a cursor can
 * become unreadable, and makes the outcome a named, logged one instead of
 * being indistinguishable from a genuine first run.
 */

import { isPlaidCursor } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { PlaidCursor } from "./types.js";

export const PLAID_STATE_VERSION = 1;

export const plaidStateSpec: SourceStateSpec<PlaidCursor> = {
  version: PLAID_STATE_VERSION,

  /**
   * The same predicate the source applies to a cursor it is handed, so the
   * shape has one definition rather than two that can drift apart. Every
   * phase returns some subset of the same fields — a mid-`transactions` page
   * (a fresh `transactionsCursor`, `lastSnapshotDate` untouched) decodes
   * exactly like the settled `incremental` shape, so there is nothing
   * settled-vs-partial to special case the way a paging index or an
   * accumulating list would need.
   */
  decode(value: unknown): PlaidCursor | null {
    return isPlaidCursor(value) ? value : null;
  },

  // No `maxBytes`: nothing in this cursor accumulates. `transactionsCursor`
  // is one opaque token Plaid replaces wholesale on every call, never a list
  // this source appends to.

  /** See the module comment: cheap, idempotent, and already this source's own recovery from a Plaid-revoked cursor. */
  onUnreadable: "rebootstrap",
};
