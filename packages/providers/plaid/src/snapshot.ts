// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Point-in-time balance + holdings snapshots for one connected Plaid item.
 *
 * Unlike the transactions delta (`/transactions/sync`, a true cursor),
 * `/accounts/get` and `/investments/holdings/get` return the live state in ONE
 * response — there is no pagination cursor. So each snapshot phase is a single
 * request that folds a `snapshot_date` (the UTC day, pinned once per pass) into
 * a composite primary key:
 *
 *  - balances → `plaid_balances` keyed `(item_id, account_id, snapshot_date)`
 *  - holdings → `plaid_holdings` keyed `(item_id, account_id, security_id, snapshot_date)`
 *
 * A same-day re-sync (including an at-least-once retry) overwrites the day's
 * rows via the composite-PK upsert; a new UTC day appends a fresh snapshot, so
 * balance/portfolio-over-time is `GROUP BY snapshot_date`.
 *
 * **Append-only — these phases NEVER emit `deletedIds`/`deleteKeyColumn`.** The
 * rows are history, and a delete keyed on any snapshot column would erase past
 * days rather than just the vanished account. A balance or position that
 * disappears simply stops being snapshotted; its prior days remain.
 *
 * The day for a pass is pinned on the balances phase and carried into holdings,
 * so a two-request pass that straddles UTC midnight still writes ONE consistent
 * day. `now` is injectable so tests and the synth twin pin the day.
 */

import { createLogger } from "@omnesis/core";
import { PLAID_NO_INVESTMENTS_CODES, PlaidApiError } from "./client.js";
import { balanceAccountsToRecords, holdingsToRecords } from "./normalizer.js";
import { plaidBalancesSchema, plaidHoldingsSchema } from "./schemas.js";
import type { StructuredSyncResult, SyncOptions } from "@omnesis/source-sdk";
import type { PlaidRequestOptions, PlaidTransport } from "./client.js";
import type { PlaidInvestmentsHoldingsGetResponse } from "./schemas.js";
import type { PlaidCursor } from "./types.js";

const log = createLogger("provider:plaid:snapshot");

type Result = StructuredSyncResult<PlaidCursor>;

export class PlaidSnapshotSource {
  constructor(
    private readonly client: PlaidTransport,
    /** The connected item id — the Omnesis accountId. */
    private readonly itemId: string,
    /** Per-item access token (secret — never logged). */
    private readonly accessToken: string,
    /** Injectable clock for deterministic snapshot dating in tests. */
    private readonly now: () => Date,
  ) {}

  /**
   * Snapshot every account's balance on the pinned UTC day, then advance to the
   * holdings phase carrying the same day. `/accounts/get` returns all accounts
   * in one response with the balances Plaid last refreshed, so this is a single
   * request — `hasMore` stays true to chain into holdings.
   *
   * This phase opens every snapshot pass (a fresh item, and once per UTC day in
   * steady state), so it is the natural cadence to refresh the forward-looking
   * consent deadline: one `/item/get` per pass reads `consent_expiration_time`
   * and reports it as `consentExpiresAt`. Plaid returns `null` for items that
   * never expire — surfaced verbatim so the gateway clears any prior deadline.
   * A failure to read consent must NOT fail the snapshot, so it is tolerated.
   */
  async balancesPage(cursor: PlaidCursor, opts?: SyncOptions): Promise<Result> {
    const snapshotDate = cursor.snapshotDate ?? utcDateOf(this.now());
    const request: PlaidRequestOptions = { signal: opts?.signal };
    const response = await this.client.accountsGet(this.accessToken, request);
    const records = balanceAccountsToRecords(response.accounts, {
      itemId: this.itemId,
      snapshotDate,
    });
    const consentExpiresAt = await this.readConsentDeadline(request);
    log.debug(
      `Plaid item ${this.itemId} balances snapshot ${snapshotDate}: ${records.length} account(s)`,
    );
    return {
      analytics: { tableName: plaidBalancesSchema.tableName, records, schema: plaidBalancesSchema },
      cursor: { ...cursor, phase: "snapshot-holdings", snapshotDate },
      hasMore: true,
      consentExpiresAt,
    };
  }

  /**
   * Read the item's forward-looking consent deadline from `/item/get`. Returns
   * the ISO deadline, `null` when the item has no expiry, or `undefined` when
   * the read failed (leave any stored deadline unchanged rather than clearing
   * it on a transient blip).
   */
  private async readConsentDeadline(opts: PlaidRequestOptions): Promise<string | null | undefined> {
    try {
      const { item } = await this.client.itemGet(this.accessToken, opts);
      return item.consent_expiration_time ?? null;
    } catch (err) {
      log.warn(
        `Plaid item ${this.itemId}: could not read consent_expiration_time ` +
          `(${(err as Error).message}); leaving the stored deadline unchanged`,
      );
      return undefined;
    }
  }

  /**
   * Snapshot every investment position on the pinned day, then close the pass
   * by recording the day and returning to the idle phase. `investments` is an
   * optional Link product, so an item with no investment account answers with
   * a 400 (`NO_INVESTMENT_ACCOUNTS` / `PRODUCTS_NOT_SUPPORTED`); that is zero
   * rows, not a failure — failing here would leave the day's snapshot
   * permanently unrecorded.
   */
  async holdingsPage(cursor: PlaidCursor, opts?: SyncOptions): Promise<Result> {
    const snapshotDate = cursor.snapshotDate ?? utcDateOf(this.now());
    const response = await this.readHoldings({ signal: opts?.signal });
    const records = holdingsToRecords(response.holdings, response.securities, {
      itemId: this.itemId,
      snapshotDate,
    });
    log.debug(
      `Plaid item ${this.itemId} holdings snapshot ${snapshotDate}: ${records.length} position(s)`,
    );
    return {
      analytics: { tableName: plaidHoldingsSchema.tableName, records, schema: plaidHoldingsSchema },
      cursor: {
        ...cursor,
        phase: "incremental",
        snapshotDate: undefined,
        lastSnapshotDate: snapshotDate,
      },
      // The day's snapshot completes the run; the next scheduled tick polls
      // the delta from `incremental`.
      hasMore: false,
    };
  }

  private async readHoldings(
    opts: PlaidRequestOptions,
  ): Promise<Pick<PlaidInvestmentsHoldingsGetResponse, "holdings" | "securities">> {
    try {
      return await this.client.investmentsHoldingsGet(this.accessToken, opts);
    } catch (err) {
      if (
        err instanceof PlaidApiError &&
        err.errorCode &&
        PLAID_NO_INVESTMENTS_CODES.has(err.errorCode)
      ) {
        log.debug(`Plaid item ${this.itemId} has no investment accounts (${err.errorCode})`);
        return { holdings: [], securities: [] };
      }
      throw err;
    }
  }
}

/** UTC calendar date (YYYY-MM-DD) of a Date. */
export function utcDateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
