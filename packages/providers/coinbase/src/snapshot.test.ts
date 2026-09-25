// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { rowsFor, tablesWritten } from "@omnesis/source-sdk/testing";
import { CoinbaseScopeError } from "./client.js";
import { CoinbaseSnapshotSource, utcDateOf } from "./snapshot.js";
import { validateCoinbaseCursor } from "./types.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";
import type { CoinbaseClient } from "./client.js";
import type {
  CoinbaseAccountsPage,
  CoinbaseFillsPage,
  CoinbaseOrdersPage,
  CoinbasePortfolioBreakdown,
  CoinbasePortfoliosResponse,
  CoinbaseV2AccountsPage,
  CoinbaseV2TransactionsPage,
} from "./schemas.js";
import type { CoinbaseCursor } from "./types.js";

// All fixture data is invented. BTC/ETH/USD/BTC-USD are public market symbols, not PII.

const ACCOUNT_KEY = "11111111-2222-3333-4444-555555555555";
const SOURCE_ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";
const PORTFOLIO_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PROVIDER_ID = ProviderId("coinbase:11111111-2222-3333-4444-555555555555");
const SOURCE_ID = SourceId("coinbase:11111111-2222-3333-4444-555555555555");
const WALLET_ID = "wallet-aaaa";

interface FakeClientOptions {
  portfolios?: CoinbasePortfoliosResponse;
  orderPages?: CoinbaseOrdersPage[];
  fillPages?: CoinbaseFillsPage[];
  /** v2 wallet account ids; an undefined value triggers a CoinbaseScopeError (grant absent). */
  v2Accounts?: CoinbaseV2AccountsPage | "scope-error";
  /** Per-wallet transaction pages (keyed by wallet id), or "scope-error" for a denied grant. */
  v2Transactions?: Record<string, CoinbaseV2TransactionsPage[]> | "scope-error";
}

/**
 * Fake client returning canned, optionally multi-page balances/holdings plus
 * the append-only orders/fills/v2-ledger reads. Money fields are decimal
 * strings, as Coinbase sends them. Counts calls so tests can assert pagination,
 * watermark filtering, and at-least-once-retry behavior.
 */
class FakeCoinbaseClient {
  accountsCalls: Array<{ cursor?: string; limit?: number }> = [];
  breakdownCalls: string[] = [];
  portfoliosCalls = 0;
  ordersCalls: Array<{ cursor?: string; startDate?: string }> = [];
  fillsCalls: Array<{ cursor?: string; startTime?: string }> = [];
  v2AccountsCalls = 0;
  v2TxnCalls: Array<{ accountId: string; startingAfter?: string }> = [];

  constructor(
    private readonly accountPages: CoinbaseAccountsPage[],
    private readonly breakdown: CoinbasePortfolioBreakdown,
    private readonly opts: FakeClientOptions = {},
  ) {}

  getAccountsPage(opts: { cursor?: string; limit?: number } = {}): Promise<CoinbaseAccountsPage> {
    this.accountsCalls.push(opts);
    const idx = opts.cursor ? Number(opts.cursor.replace("page-", "")) : 0;
    return Promise.resolve(this.accountPages[idx] ?? { accounts: [], has_next: false });
  }

  getPortfolios(): Promise<CoinbasePortfoliosResponse> {
    this.portfoliosCalls++;
    return Promise.resolve(this.opts.portfolios ?? { portfolios: [{ uuid: PORTFOLIO_UUID }] });
  }

  getPortfolioBreakdown(uuid: string): Promise<CoinbasePortfolioBreakdown> {
    this.breakdownCalls.push(uuid);
    return Promise.resolve(this.breakdown);
  }

  getOrdersPage(
    opts: { cursor?: string; startDate?: string; limit?: number } = {},
  ): Promise<CoinbaseOrdersPage> {
    this.ordersCalls.push({ cursor: opts.cursor, startDate: opts.startDate });
    const pages = this.opts.orderPages ?? [{ orders: [], has_next: false }];
    const idx = opts.cursor ? Number(opts.cursor.replace("ord-", "")) : 0;
    return Promise.resolve(pages[idx] ?? { orders: [], has_next: false });
  }

  getFillsPage(
    opts: { cursor?: string; startTime?: string; limit?: number } = {},
  ): Promise<CoinbaseFillsPage> {
    this.fillsCalls.push({ cursor: opts.cursor, startTime: opts.startTime });
    const pages = this.opts.fillPages ?? [{ fills: [], has_next: false }];
    const idx = opts.cursor ? Number(opts.cursor.replace("fill-", "")) : 0;
    return Promise.resolve(pages[idx] ?? { fills: [], has_next: false });
  }

  getV2AccountsPage(): Promise<CoinbaseV2AccountsPage> {
    this.v2AccountsCalls++;
    if (this.opts.v2Accounts === "scope-error" || this.opts.v2Transactions === "scope-error") {
      return Promise.reject(new CoinbaseScopeError("missing wallet:transactions:read"));
    }
    return Promise.resolve(this.opts.v2Accounts ?? { data: [{ id: WALLET_ID, currency: "BTC" }] });
  }

  getV2TransactionsPage(
    accountId: string,
    opts: { startingAfter?: string; limit?: number } = {},
  ): Promise<CoinbaseV2TransactionsPage> {
    this.v2TxnCalls.push({ accountId, startingAfter: opts.startingAfter });
    if (this.opts.v2Transactions === "scope-error") {
      return Promise.reject(new CoinbaseScopeError("missing wallet:transactions:read"));
    }
    const pages = (this.opts.v2Transactions ?? {})[accountId] ?? [{ data: [] }];
    const idx = opts.startingAfter ? Number(opts.startingAfter.replace("txn-", "")) : 0;
    return Promise.resolve(pages[idx] ?? { data: [] });
  }
}

const SINGLE_PAGE: CoinbaseAccountsPage = {
  accounts: [
    {
      uuid: "acc-btc",
      currency: "BTC",
      type: "ACCOUNT_TYPE_CRYPTO",
      available_balance: { value: "0.12345678", currency: "BTC" },
      hold: { value: "0.00000001", currency: "BTC" },
    },
    {
      uuid: "acc-eth",
      currency: "ETH",
      type: "ACCOUNT_TYPE_CRYPTO",
      available_balance: { value: "1.500000000000000000", currency: "ETH" },
      hold: { value: "0", currency: "ETH" },
    },
    {
      // A zero-balance dust wallet — skipped from the snapshot.
      uuid: "acc-doge",
      currency: "DOGE",
      type: "ACCOUNT_TYPE_CRYPTO",
      available_balance: { value: "0", currency: "DOGE" },
      hold: { value: "0", currency: "DOGE" },
    },
  ],
  has_next: false,
};

const BREAKDOWN: CoinbasePortfolioBreakdown = {
  breakdown: {
    spot_positions: [
      {
        asset: "BTC",
        is_cash: false,
        total_balance_crypto: "0.12345679",
        available_to_trade_crypto: "0.12345678",
        cost_basis: { value: "4200.55", currency: "USD" },
        // Float convenience aggregates — must NOT reach a money column.
        total_balance_fiat: 8123.456789,
        allocation: 0.8,
        unrealized_pnl: 123.45,
        account_uuid: "acc-btc",
      },
      {
        asset: "USD",
        is_cash: true,
        total_balance_crypto: "250.75",
        available_to_trade_crypto: "250.75",
        total_balance_fiat: 250.75,
        allocation: 0.2,
        account_uuid: "acc-usd",
      },
    ],
  },
};

function makeSource(client: FakeCoinbaseClient, now: () => Date): CoinbaseSnapshotSource {
  return new CoinbaseSnapshotSource(
    client as unknown as CoinbaseClient,
    PROVIDER_ID,
    SOURCE_ID,
    ACCOUNT_KEY,
    SOURCE_ACCOUNT_ID,
    { now },
  );
}

/** Drive the phase machine from a cursor until `hasMore` is false, collecting rows + documents. */
async function drain(
  source: CoinbaseSnapshotSource,
  start: CoinbaseCursor | null = null,
): Promise<{
  byTable: Record<string, Record<string, unknown>[]>;
  documents: Array<{ externalId: string; title: string; content: string }>;
  cursor: CoinbaseCursor;
}> {
  const byTable: Record<string, Record<string, unknown>[]> = {};
  const documents: Array<{ externalId: string; title: string; content: string }> = [];
  let cursor: CoinbaseCursor | null = start;
  let page: StructuredSyncResult<CoinbaseCursor>;
  let guard = 0;
  do {
    page = await source.syncStructured(cursor ? validateCoinbaseCursor(cursor) : null);
    for (const name of new Set(tablesWritten(page))) {
      (byTable[name] ??= []).push(...rowsFor(page, name));
    }
    for (const doc of page.documents ?? []) {
      documents.push({ externalId: doc.externalId, title: doc.title, content: doc.content });
    }
    cursor = page.cursor;
    if (++guard > 80) throw new Error("phase machine did not terminate");
  } while (page.hasMore);
  return { byTable, documents, cursor };
}

describe("CoinbaseSnapshotSource", () => {
  const day1 = () => new Date("2026-06-18T09:00:00.000Z");
  const day2 = () => new Date("2026-06-19T09:00:00.000Z");

  test("bootstrap emits balance + holding snapshot rows with exact decimal strings", async () => {
    const client = new FakeCoinbaseClient([SINGLE_PAGE], BREAKDOWN);
    const { byTable } = await drain(makeSource(client, day1));

    const balances = byTable["coinbase_balances"] ?? [];
    const holdings = byTable["coinbase_holdings"] ?? [];

    // Zero-balance DOGE wallet skipped; BTC + ETH retained.
    expect(balances.map((r) => r.currency).sort()).toEqual(["BTC", "ETH"]);
    const btc = balances.find((r) => r.currency === "BTC")!;
    expect(btc.snapshot_date).toBe("2026-06-18");
    expect(btc.available_balance).toBe("0.123456780000000000"); // exact, not 0.12345678 float
    expect(btc.hold_balance).toBe("0.000000010000000000");
    expect(btc.account_key).toBe(ACCOUNT_KEY);
    expect(btc.source_account_id).toBe(SOURCE_ACCOUNT_ID);

    expect(holdings.map((r) => r.asset).sort()).toEqual(["BTC", "USD"]);
    const btcHold = holdings.find((r) => r.asset === "BTC")!;
    expect(btcHold.snapshot_date).toBe("2026-06-18");
    expect(btcHold.total_balance_crypto).toBe("0.123456790000000000");
    expect(btcHold.cost_basis).toBe("4200.55000000");
    expect(btcHold.cost_basis_currency).toBe("USD");
    expect(btcHold.is_cash).toBe(false);
  });

  test("float aggregate fields are never carried into money columns (re-derived, not trusted)", async () => {
    const client = new FakeCoinbaseClient([SINGLE_PAGE], BREAKDOWN);
    const { byTable } = await drain(makeSource(client, day1));
    const holdings = byTable["coinbase_holdings"] ?? [];
    for (const row of holdings) {
      // total_balance_fiat / allocation / unrealized_pnl are floats — they must
      // not appear as columns at all; only exact string-derived columns ship.
      expect(row).not.toHaveProperty("total_balance_fiat");
      expect(row).not.toHaveProperty("allocation");
      expect(row).not.toHaveProperty("unrealized_pnl");
    }
  });

  test("same-day re-sync is idempotent — same snapshot_date, same primary keys (overwrite, not duplicate)", async () => {
    const client = new FakeCoinbaseClient([SINGLE_PAGE], BREAKDOWN);
    const source = makeSource(client, day1);

    const first = await drain(source);
    const second = await drain(source); // re-run on the same UTC day

    const pk = (r: Record<string, unknown>, cols: string[]) => cols.map((c) => r[c]).join("|");
    const balCols = ["account_key", "currency", "snapshot_date"];
    const holdCols = ["account_key", "asset", "snapshot_date"];

    const firstBalKeys = (first.byTable["coinbase_balances"] ?? [])
      .map((r) => pk(r, balCols))
      .sort();
    const secondBalKeys = (second.byTable["coinbase_balances"] ?? [])
      .map((r) => pk(r, balCols))
      .sort();
    expect(secondBalKeys).toEqual(firstBalKeys);

    const firstHoldKeys = (first.byTable["coinbase_holdings"] ?? [])
      .map((r) => pk(r, holdCols))
      .sort();
    const secondHoldKeys = (second.byTable["coinbase_holdings"] ?? [])
      .map((r) => pk(r, holdCols))
      .sort();
    expect(secondHoldKeys).toEqual(firstHoldKeys);

    // All keys land on the SAME UTC day — the gateway's ON CONFLICT … DO UPDATE
    // then overwrites rather than appending.
    for (const k of secondBalKeys) expect(k.endsWith("2026-06-18")).toBe(true);
  });

  test("a same-day at-least-once page retry does not change the row's primary key", async () => {
    // Re-running a single balances page (as the cursor-retry path does) yields
    // the identical PK so the ON CONFLICT upsert dedupes it.
    const client = new FakeCoinbaseClient([SINGLE_PAGE], BREAKDOWN);
    const source = makeSource(client, day1);
    const a = await source.syncStructured(null);
    const b = await source.syncStructured(null); // retry the very same first page
    const key = (r: Record<string, unknown>) =>
      [r.account_key, r.currency, r.snapshot_date].join("|");
    expect(rowsFor(a, "coinbase_balances").map(key).sort()).toEqual(
      rowsFor(b, "coinbase_balances").map(key).sort(),
    );
  });

  test("a new UTC day appends a second snapshot (history retained)", async () => {
    const client = new FakeCoinbaseClient([SINGLE_PAGE], BREAKDOWN);
    const source = makeSource(client, day1);

    const first = await drain(source);
    expect(first.cursor.phase).toBe("incremental");
    expect(first.cursor.lastSnapshotDate).toBe("2026-06-18");

    // Roll the clock to the next UTC day, then drive the incremental phase.
    const source2 = new CoinbaseSnapshotSource(
      client as unknown as CoinbaseClient,
      PROVIDER_ID,
      SOURCE_ID,
      ACCOUNT_KEY,
      SOURCE_ACCOUNT_ID,
      { now: day2 },
    );
    const second = await drain(source2, first.cursor);

    const day2Balances = second.byTable["coinbase_balances"] ?? [];
    expect(day2Balances.length).toBeGreaterThan(0);
    for (const r of day2Balances) expect(r.snapshot_date).toBe("2026-06-19");
    expect(second.cursor.lastSnapshotDate).toBe("2026-06-19");
  });

  test("incremental is a no-op once the day is already snapshotted", async () => {
    const client = new FakeCoinbaseClient([SINGLE_PAGE], BREAKDOWN);
    const source = makeSource(client, day1);
    const first = await drain(source);

    const callsBefore = client.accountsCalls.length;
    const idle = await source.syncStructured(validateCoinbaseCursor(first.cursor));
    expect(idle.hasMore).toBe(false);
    expect(rowsFor(idle, "coinbase_balances")).toEqual([]);
    expect(client.accountsCalls.length).toBe(callsBefore); // no extra fetch
  });

  test("paginates the balances walk across multiple pages, holding one snapshot_date", async () => {
    const page0: CoinbaseAccountsPage = {
      accounts: [
        {
          uuid: "acc-btc",
          currency: "BTC",
          available_balance: { value: "1.0", currency: "BTC" },
          hold: { value: "0", currency: "BTC" },
        },
      ],
      has_next: true,
      cursor: "page-1",
    };
    const page1: CoinbaseAccountsPage = {
      accounts: [
        {
          uuid: "acc-eth",
          currency: "ETH",
          available_balance: { value: "2.0", currency: "ETH" },
          hold: { value: "0", currency: "ETH" },
        },
      ],
      has_next: false,
    };
    const client = new FakeCoinbaseClient([page0, page1], BREAKDOWN);
    const { byTable } = await drain(makeSource(client, day1));
    const balances = byTable["coinbase_balances"] ?? [];
    expect(balances.map((r) => r.currency).sort()).toEqual(["BTC", "ETH"]);
    // Both pages share the one pinned snapshot_date.
    expect(new Set(balances.map((r) => r.snapshot_date))).toEqual(new Set(["2026-06-18"]));
    expect(client.accountsCalls.length).toBe(2);
  });

  test("an empty portfolio (no spot positions) keeps the source healthy", async () => {
    const empty: CoinbasePortfolioBreakdown = { breakdown: { spot_positions: [] } };
    const client = new FakeCoinbaseClient([{ accounts: [], has_next: false }], empty);
    const { byTable, cursor } = await drain(makeSource(client, day1));
    expect(byTable["coinbase_balances"] ?? []).toEqual([]);
    expect(byTable["coinbase_holdings"] ?? []).toEqual([]);
    expect(cursor.phase).toBe("incremental");
    expect(cursor.lastSnapshotDate).toBe("2026-06-18");
  });
});

// ── orders / fills / transactions (#753) ────────────────────────────

const ORDER_PAGE: CoinbaseOrdersPage = {
  orders: [
    {
      order_id: "ord-1",
      product_id: "BTC-USD",
      side: "BUY",
      status: "FILLED",
      order_type: "MARKET",
      filled_size: "0.50000000",
      average_filled_price: "42000.12",
      filled_value: "21000.06",
      total_fees: "10.50",
      created_time: "2026-06-10T12:00:00Z",
      last_fill_time: "2026-06-10T12:00:01Z",
    },
    {
      order_id: "ord-2",
      product_id: "ETH-USD",
      side: "SELL",
      status: "OPEN",
      filled_size: "0",
      created_time: "2026-06-12T08:30:00Z",
    },
  ],
  has_next: false,
};

const FILL_PAGE: CoinbaseFillsPage = {
  fills: [
    {
      trade_id: "trade-1",
      order_id: "ord-1",
      product_id: "BTC-USD",
      side: "BUY",
      liquidity_indicator: "TAKER",
      price: "42000.12",
      size: "0.50000000",
      size_in_quote: false,
      commission: "10.50",
      trade_time: "2026-06-10T12:00:01Z",
    },
  ],
  has_next: false,
};

const TXN_PAGE: CoinbaseV2TransactionsPage = {
  data: [
    {
      id: "txn-1",
      type: "buy",
      status: "completed",
      amount: { amount: "0.50000000", currency: "BTC" },
      native_amount: { amount: "21000.06", currency: "USD" },
      description: "Bought 0.5 BTC",
      created_at: "2026-06-10T12:00:00Z",
    },
    {
      id: "txn-2",
      // An unmodelled ledger type still lands as queryable data, never dropped.
      type: "staking_reward",
      status: "completed",
      amount: { amount: "0.01000000", currency: "ETH" },
      native_amount: { amount: "30.00", currency: "USD" },
      created_at: "2026-06-11T00:00:00Z",
    },
  ],
};

function activityClient(opts: FakeClientOptions): FakeCoinbaseClient {
  return new FakeCoinbaseClient([{ accounts: [], has_next: false }], BREAKDOWN, opts);
}

describe("CoinbaseSnapshotSource — orders / fills (append-only)", () => {
  const day1 = () => new Date("2026-06-18T09:00:00.000Z");

  test("bootstrap emits order + fill rows keyed on the stable id with exact decimal money", async () => {
    const client = activityClient({ orderPages: [ORDER_PAGE], fillPages: [FILL_PAGE] });
    const { byTable } = await drain(makeSource(client, day1));

    const orders = byTable["coinbase_orders"] ?? [];
    expect(orders.map((r) => r.order_id).sort()).toEqual(["ord-1", "ord-2"]);
    const o1 = orders.find((r) => r.order_id === "ord-1")!;
    expect(o1.filled_size).toBe("0.500000000000000000"); // exact, scaled
    expect(o1.average_filled_price).toBe("42000.12000000");
    expect(o1.total_fees).toBe("10.50000000");
    expect(o1.side).toBe("BUY");
    expect(o1.account_key).toBe(ACCOUNT_KEY);

    const fills = byTable["coinbase_fills"] ?? [];
    expect(fills.map((r) => r.trade_id)).toEqual(["trade-1"]);
    const f = fills[0]!;
    expect(f.price).toBe("42000.12000000");
    expect(f.size).toBe("0.500000000000000000");
    expect(f.commission).toBe("10.50000000");
    expect(f.liquidity_indicator).toBe("TAKER");
  });

  test("incremental walks only orders/fills past the watermark (no re-fetch of settled history)", async () => {
    const client = activityClient({ orderPages: [ORDER_PAGE], fillPages: [FILL_PAGE] });
    const source = makeSource(client, day1);
    const first = await drain(source);

    // Watermarks promoted to the newest ingested time.
    expect(first.cursor.ordersWatermark).toBe("2026-06-12T08:30:00.000Z");
    expect(first.cursor.fillsWatermark).toBe("2026-06-10T12:00:01.000Z");

    // A second pass on the SAME day is idle (no new fetch).
    const idle = await source.syncStructured(validateCoinbaseCursor(first.cursor));
    expect(idle.hasMore).toBe(false);

    // Forcing a fresh orders walk passes the watermark as the start filter.
    const ordersFromWatermark = await source.syncStructured(
      validateCoinbaseCursor({ ...first.cursor, phase: "orders" }),
    );
    expect(ordersFromWatermark).toBeDefined();
    const lastOrdersCall = client.ordersCalls.at(-1)!;
    expect(lastOrdersCall.startDate).toBe("2026-06-12T08:30:00.000Z");
  });

  test("at-least-once page retry yields identical primary keys (no dupes, no loss)", async () => {
    const client = activityClient({ orderPages: [ORDER_PAGE], fillPages: [FILL_PAGE] });
    const source = makeSource(client, day1);
    // Replay the orders phase from the same cursor twice.
    const cur: CoinbaseCursor = { phase: "orders" };
    const a = await source.syncStructured(validateCoinbaseCursor(cur));
    const b = await source.syncStructured(validateCoinbaseCursor(cur));
    const pk = (r: Record<string, unknown>) => [r.account_key, r.order_id].join("|");
    expect(rowsFor(a, "coinbase_orders").map(pk).sort()).toEqual(
      rowsFor(b, "coinbase_orders").map(pk).sort(),
    );
  });

  test("orders pagination walks every page holding one watermark promotion", async () => {
    const page0: CoinbaseOrdersPage = {
      orders: [{ order_id: "ord-1", created_time: "2026-06-10T12:00:00Z" }],
      has_next: true,
      cursor: "ord-1",
    };
    const page1: CoinbaseOrdersPage = {
      orders: [{ order_id: "ord-2", created_time: "2026-06-12T08:30:00Z" }],
      has_next: false,
    };
    const client = activityClient({ orderPages: [page0, page1] });
    const { byTable, cursor } = await drain(makeSource(client, day1));
    expect((byTable["coinbase_orders"] ?? []).map((r) => r.order_id).sort()).toEqual([
      "ord-1",
      "ord-2",
    ]);
    // Watermark promoted only at completion, to the newest order time.
    expect(cursor.ordersWatermark).toBe("2026-06-12T08:30:00.000Z");
  });

  test("an open order's mutable fields upsert on the same PK (status not duplicated)", async () => {
    const open: CoinbaseOrdersPage = {
      orders: [
        {
          order_id: "ord-2",
          status: "OPEN",
          filled_size: "0",
          created_time: "2026-06-12T08:30:00Z",
        },
      ],
      has_next: false,
    };
    const settled: CoinbaseOrdersPage = {
      orders: [
        {
          order_id: "ord-2",
          status: "FILLED",
          filled_size: "1.0",
          created_time: "2026-06-12T08:30:00Z",
        },
      ],
      has_next: false,
    };
    const c1 = activityClient({ orderPages: [open] });
    const a = await makeSource(c1, day1).syncStructured(
      validateCoinbaseCursor({ phase: "orders" }),
    );
    const c2 = activityClient({ orderPages: [settled] });
    const b = await makeSource(c2, day1).syncStructured(
      validateCoinbaseCursor({ phase: "orders" }),
    );
    // Same PK both times — the gateway upsert overwrites the mutable status.
    expect(rowsFor(a, "coinbase_orders")[0]!.order_id).toBe(
      rowsFor(b, "coinbase_orders")[0]!.order_id,
    );
    expect(rowsFor(a, "coinbase_orders")[0]!.status).toBe("OPEN");
    expect(rowsFor(b, "coinbase_orders")[0]!.status).toBe("FILLED");
  });
});

describe("CoinbaseSnapshotSource — v2 transaction ledger", () => {
  const day1 = () => new Date("2026-06-18T09:00:00.000Z");

  test("ingests ledger rows + co-emits searchable documents", async () => {
    const client = activityClient({ v2Transactions: { [WALLET_ID]: [TXN_PAGE] } });
    const { byTable, documents } = await drain(makeSource(client, day1));

    const txns = byTable["coinbase_transactions"] ?? [];
    expect(txns.map((r) => r.transaction_id).sort()).toEqual(["txn-1", "txn-2"]);
    const t1 = txns.find((r) => r.transaction_id === "txn-1")!;
    expect(t1.amount).toBe("0.500000000000000000");
    expect(t1.amount_currency).toBe("BTC");
    expect(t1.native_amount).toBe("21000.06000000");
    expect(t1.type).toBe("buy");
    expect(t1.wallet_account_id).toBe(WALLET_ID);

    // Unmodelled type carried verbatim, never dropped.
    const t2 = txns.find((r) => r.transaction_id === "txn-2")!;
    expect(t2.type).toBe("staking_reward");

    // One document per transaction, externalId = account_key:transaction_id.
    expect(documents.map((d) => d.externalId).sort()).toEqual([
      `${ACCOUNT_KEY}:txn-1`,
      `${ACCOUNT_KEY}:txn-2`,
    ]);
    const doc1 = documents.find((d) => d.externalId === `${ACCOUNT_KEY}:txn-1`)!;
    expect(doc1.title).toContain("Bought 0.5 BTC");
    expect(doc1.content).toContain("0.50000000 BTC");
  });

  test("a missing wallet:transactions:read grant SKIPS the ledger but keeps the source healthy", async () => {
    const client = activityClient({
      orderPages: [ORDER_PAGE],
      fillPages: [FILL_PAGE],
      v2Transactions: "scope-error",
    });
    const { byTable, cursor } = await drain(makeSource(client, day1));

    // Ledger empty + flagged unavailable; orders/fills unaffected.
    expect(byTable["coinbase_transactions"] ?? []).toEqual([]);
    expect(cursor.ledgerUnavailable).toBe(true);
    expect(cursor.phase).toBe("incremental");
    expect((byTable["coinbase_orders"] ?? []).length).toBe(2);
    expect((byTable["coinbase_fills"] ?? []).length).toBe(1);
  });

  test("once the grant is confirmed absent, later passes do not re-probe the ledger", async () => {
    const client = activityClient({ v2Transactions: "scope-error" });
    const source = makeSource(client, day1);
    await drain(source);
    const probesAfterFirst = client.v2AccountsCalls;
    // Re-enter the transactions phase with ledgerUnavailable set.
    await source.syncStructured(
      validateCoinbaseCursor({ phase: "transactions", ledgerUnavailable: true }),
    );
    expect(client.v2AccountsCalls).toBe(probesAfterFirst); // no extra probe
  });

  test("ledger incremental stops at the per-wallet watermark (no re-fetch of older rows)", async () => {
    const client = activityClient({ v2Transactions: { [WALLET_ID]: [TXN_PAGE] } });
    const source = makeSource(client, day1);
    const first = await drain(source);
    expect(first.cursor.ledgerWatermarks?.[WALLET_ID]).toBe("2026-06-11T00:00:00.000Z");

    // Re-walk from the saved cursor: a page of only-older rows yields no records.
    const olderPage: CoinbaseV2TransactionsPage = {
      data: [{ id: "txn-old", type: "send", created_at: "2026-06-01T00:00:00Z" }],
    };
    const client2 = activityClient({ v2Transactions: { [WALLET_ID]: [olderPage] } });
    const source2 = makeSource(client2, day1);
    const page = await source2.syncStructured(
      validateCoinbaseCursor({
        phase: "transactions",
        ledgerWatermarks: first.cursor.ledgerWatermarks,
      }),
    );
    expect(rowsFor(page, "coinbase_transactions")).toEqual([]);
  });

  test("a single retry of a ledger page yields identical transaction PKs", async () => {
    const client = activityClient({ v2Transactions: { [WALLET_ID]: [TXN_PAGE] } });
    const source = makeSource(client, day1);
    const cur: CoinbaseCursor = { phase: "transactions" };
    const a = await source.syncStructured(validateCoinbaseCursor(cur));
    const b = await source.syncStructured(validateCoinbaseCursor(cur));
    const pk = (r: Record<string, unknown>) => [r.account_key, r.transaction_id].join("|");
    expect(rowsFor(a, "coinbase_transactions").map(pk).sort()).toEqual(
      rowsFor(b, "coinbase_transactions").map(pk).sort(),
    );
  });
});

describe("utcDateOf", () => {
  test("renders the UTC calendar day", () => {
    expect(utcDateOf(new Date("2026-06-18T23:59:59.999Z"))).toBe("2026-06-18");
    expect(utcDateOf(new Date("2026-06-19T00:00:00.000Z"))).toBe("2026-06-19");
  });
});
