// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The phase machine must settle. Plaid walks four phases in a ring —
 * transactions, the two snapshot legs, then the idle poll that comes back
 * round — and every one of them writes rows. So the question this asks is
 * whether a corpus that never changes eventually stops producing writes, or
 * whether some phase rewrites a row on every pass and the source churns
 * forever against an upstream that is standing still.
 */

import { describe, test } from "vitest";
import { emittedRows, expectUnchangedUpstreamIsNoOp } from "@omnesis/source-sdk/testing";
import { PlaidSyncSource } from "./sync.js";
import { plaidBalancesSchema, plaidHoldingsSchema, plaidTransactionsSchema } from "./schemas.js";
import type { ProviderId, SourceId } from "@omnesis/types";
import type { LinkTokenCreateParams, PlaidTransport, TransactionsSyncParams } from "./client.js";
import type { PlaidCursor } from "./types.js";

const PROVIDER_ID = "plaid" as ProviderId;
const SOURCE_ID = "plaid:item-1" as SourceId;
const ITEM_ID = "item-1";
/** Pinned so every pass writes the same snapshot day and can be compared. */
const NOW = (): Date => new Date("2026-05-15T12:00:00Z");

const TRANSACTION = {
  transaction_id: "txn-1",
  account_id: "acct-1",
  date: "2026-05-14",
  amount: 12.5,
  iso_currency_code: "USD",
  name: "Stellar Sound",
  merchant_name: "Stellar Sound",
  payment_channel: "in store",
  pending: false,
};

/** Upstream that never moves: the same account, position and transaction. */
class UnchangingPlaid implements PlaidTransport {
  transactionsSync(params: TransactionsSyncParams): Promise<never> {
    // The delta is exhausted after the first page, exactly as Plaid reports it
    // once an item's history is complete.
    return Promise.resolve({
      added: params.cursor ? [] : [TRANSACTION],
      modified: [],
      removed: [],
      next_cursor: "cursor-end",
      has_more: false,
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    }) as unknown as Promise<never>;
  }
  accountsGet(): Promise<never> {
    return Promise.resolve({
      accounts: [
        {
          account_id: "acct-1",
          name: "Everyday Checking",
          type: "depository",
          subtype: "checking",
          balances: { available: 100, current: 110, iso_currency_code: "USD" },
        },
      ],
    }) as unknown as Promise<never>;
  }
  investmentsHoldingsGet(): Promise<never> {
    return Promise.resolve({
      holdings: [
        {
          account_id: "acct-1",
          security_id: "sec-1",
          quantity: 3,
          institution_price: 10,
          institution_value: 30,
          iso_currency_code: "USD",
        },
      ],
      securities: [{ security_id: "sec-1", ticker_symbol: "ZZZX", name: "Stellar Index Fund" }],
    }) as unknown as Promise<never>;
  }
  itemGet(): Promise<never> {
    return Promise.resolve({
      item: { item_id: ITEM_ID, consent_expiration_time: null },
    }) as unknown as Promise<never>;
  }
  linkTokenCreate(_p: LinkTokenCreateParams): Promise<never> {
    throw new Error("not used");
  }
  linkTokenGet(): Promise<never> {
    throw new Error("not used");
  }
  itemPublicTokenExchange(): Promise<never> {
    throw new Error("not used");
  }
  itemRemove(): Promise<never> {
    throw new Error("not used");
  }
  institutionGetById(): Promise<never> {
    throw new Error("not used");
  }
}

const PRIMARY_KEYS: Record<string, readonly string[]> = {
  [plaidTransactionsSchema.tableName]: plaidTransactionsSchema.primaryKey,
  [plaidBalancesSchema.tableName]: plaidBalancesSchema.primaryKey,
  [plaidHoldingsSchema.tableName]: plaidHoldingsSchema.primaryKey,
};

describe("PlaidSyncSource — sync cycle", () => {
  test("an upstream that never changes settles and stops rewriting rows", async () => {
    const source = new PlaidSyncSource(
      new UnchangingPlaid(),
      PROVIDER_ID,
      SOURCE_ID,
      ITEM_ID,
      "access-1",
      { now: NOW },
    );

    await expectUnchangedUpstreamIsNoOp({
      initialCursor: null,
      async step(cursor) {
        const result = await source.syncStructured(cursor as PlaidCursor | null);
        return {
          records: emittedRows(result),
          cursor: result.cursor,
          hasMore: result.hasMore ?? false,
        };
      },
      primaryKey: (table) => PRIMARY_KEYS[table] ?? [],
      // Four phases in the ring, so the settle cycle needs at least that many.
      settleSteps: 8,
    });
  });
});
