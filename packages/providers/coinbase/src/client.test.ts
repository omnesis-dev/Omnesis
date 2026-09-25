// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level behavior of the activity reads: orders/fills parse + cursor
 * params, 429 → non-terminal rate-limit, brokerage 401/403 → terminal auth, and
 * the v2 ledger's scope-aware error mapping (a v2 401/403 is a missing grant →
 * CoinbaseScopeError, NOT a source-wide auth failure). All keys are minted at
 * runtime — none committed.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { SyncError } from "@omnesis/types";
import { CoinbaseClient, CoinbaseScopeError } from "./client.js";
import type { FetchFn } from "./client.js";

const ecPem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

function makeClient(fetchImpl: FetchFn): CoinbaseClient {
  return new CoinbaseClient({
    keyId: "organizations/00000000-0000-0000-0000-000000000000/apiKeys/test",
    privateKeyPem: ecPem,
    fetchImpl,
    now: () => 1_750_000_000_000,
  });
}

/** A fetch returning a fixed status/body for every call, recording requested URLs. */
function fixedFetch(status: number, body: unknown, urls?: string[]): FetchFn {
  return (input: string) => {
    urls?.push(input);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

describe("CoinbaseClient — orders / fills reads", () => {
  test("parses an orders page and threads cursor + start_date params", async () => {
    const urls: string[] = [];
    const client = makeClient(
      fixedFetch(200, { orders: [{ order_id: "ord-1" }], has_next: true, cursor: "c2" }, urls),
    );
    const page = await client.getOrdersPage({
      cursor: "c1",
      startDate: "2026-06-01T00:00:00.000Z",
    });
    expect(page.orders[0]!.order_id).toBe("ord-1");
    expect(page.has_next).toBe(true);
    expect(urls[0]).toContain("/orders/historical/batch");
    expect(urls[0]).toContain("cursor=c1");
    expect(urls[0]).toContain("start_date=2026-06-01");
  });

  test("parses a fills page", async () => {
    const client = makeClient(fixedFetch(200, { fills: [{ trade_id: "t-1" }], has_next: false }));
    const page = await client.getFillsPage();
    expect(page.fills[0]!.trade_id).toBe("t-1");
  });

  test("a 429 maps to a non-terminal rate-limit SyncError with a backoff hint", async () => {
    const client = makeClient(fixedFetch(429, { error: "rate_limit" }));
    const err = await client.getOrdersPage().catch((e) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("rate-limit");
    expect((err as SyncError).retryAfterMs).toBeGreaterThan(0);
    // The JWT is signed with this account's own CDP key alone — no shared
    // Omnesis-wide app credential is ever in play — so the budget Coinbase
    // is enforcing is this account's.
    expect((err as SyncError).quota).toEqual({ kind: "account" });
  });

  test("a brokerage 403 stays a terminal auth SyncError", async () => {
    const client = makeClient(fixedFetch(403, { error: "forbidden" }));
    const err = await client.getOrdersPage().catch((e) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("auth");
  });

  test("a numeric money field is rejected at the boundary (never silently floated)", async () => {
    // Money/size fields are decimal STRINGS. A JSON number would already have
    // lost precision at parse time, so the schema rejects it loudly (an `unknown`
    // SyncError) rather than carrying a degraded value into a DECIMAL column.
    const client = makeClient(
      fixedFetch(200, { fills: [{ trade_id: "t-1", price: 12345.67 }], has_next: false }),
    );
    const err = await client.getFillsPage().catch((e) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("unknown");
  });

  test("a string money field parses through unchanged (the exact-money path)", async () => {
    const client = makeClient(
      fixedFetch(200, { fills: [{ trade_id: "t-1", price: "12345.67000000" }], has_next: false }),
    );
    const page = await client.getFillsPage();
    expect(page.fills[0]!.price).toBe("12345.67000000");
  });

  test("portfolio breakdown accepts NUMERIC spot-position crypto quantities (real API shape)", async () => {
    // Unlike fills/orders/accounts (exact decimal strings), the breakdown
    // endpoint serves total_balance_crypto / available_to_trade_crypto as JSON
    // numbers. The schema must accept them rather than failing the whole sync
    // with "unexpected shape".
    const client = makeClient(
      fixedFetch(200, {
        breakdown: {
          spot_positions: [
            {
              asset: "BTC",
              total_balance_crypto: 0.025,
              available_to_trade_crypto: 0.025,
              cost_basis: { value: "900.00", currency: "USD" },
              total_balance_fiat: 1000.5,
            },
          ],
        },
      }),
    );
    const bd = await client.getPortfolioBreakdown("pf-uuid");
    expect(bd.breakdown.spot_positions?.[0]?.total_balance_crypto).toBe(0.025);
  });
});

describe("CoinbaseClient — v2 ledger scope mapping", () => {
  test("a v2 403 becomes a CoinbaseScopeError (missing grant), not a source-wide auth failure", async () => {
    const client = makeClient(fixedFetch(403, { errors: [{ id: "invalid_scope" }] }));
    const err = await client.getV2AccountsPage().catch((e) => e);
    expect(err).toBeInstanceOf(CoinbaseScopeError);
    expect(err).not.toBeInstanceOf(SyncError);
  });

  test("a v2 401 also becomes a CoinbaseScopeError", async () => {
    const client = makeClient(fixedFetch(401, { errors: [{ id: "invalid_token" }] }));
    const err = await client.getV2TransactionsPage("wallet-1").catch((e) => e);
    expect(err).toBeInstanceOf(CoinbaseScopeError);
  });

  test("a v2 429 is still a non-terminal rate-limit (transport error, not a grant problem)", async () => {
    const client = makeClient(fixedFetch(429, { error: "rate_limit" }));
    const err = await client.getV2AccountsPage().catch((e) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("rate-limit");
  });

  test("parses a v2 accounts + transactions page", async () => {
    const accounts = makeClient(
      fixedFetch(200, { data: [{ id: "w-1", currency: "BTC" }], pagination: {} }),
    );
    expect((await accounts.getV2AccountsPage()).data[0]!.id).toBe("w-1");

    const txns = makeClient(
      fixedFetch(200, {
        data: [{ id: "txn-1", type: "buy" }],
        pagination: { next_starting_after: "x" },
      }),
    );
    const page = await txns.getV2TransactionsPage("w-1");
    expect(page.data[0]!.id).toBe("txn-1");
    expect(page.pagination?.next_starting_after).toBe("x");
  });
});
