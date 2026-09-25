// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Boundary schemas for the Coinbase Advanced Trade API (zod — parse, don't
 * cast) and the analytics tables this provider manages: the two point-in-time
 * snapshot tables for balances and holdings and the three append-only
 * activity tables for orders, fills, and the v2 transaction ledger.
 *
 * The zod schemas are deliberately tolerant of upstream evolution: enum-ish
 * fields (`type`, `platform`, …) are plain strings so a new upstream variant
 * degrades to data rather than a sync failure; objects are `.passthrough()` so
 * unknown keys survive; non-essential fields are `.nullish()` so an explicit
 * `null` degrades to absent instead of rejecting the whole page (the accounts
 * endpoint returns a page as one array — one intolerant field would wedge the
 * entire page).
 *
 * Money columns are DECIMAL fed validated decimal strings (`decimalFromString`)
 * — Coinbase money fields are decimal STRINGS, carried verbatim, never
 * `Number()`'d. The portfolio-breakdown aggregate fields that arrive as floats
 * (`total_balance_fiat`, `allocation`, `unrealized_pnl`) are deliberately NOT
 * money columns — net worth is re-derived in SQL from the exact crypto-quantity
 * and cost-basis columns, never from a trusted float.
 */

import { z } from "zod";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

// ── Advanced Trade API response schemas ─────────────────────────────

/** A `{value, currency}` money amount — `value` is a decimal STRING. */
export const coinbaseAmountSchema = z
  .object({
    value: z.string(),
    currency: z.string().optional(),
  })
  .passthrough();

export type CoinbaseAmount = z.infer<typeof coinbaseAmountSchema>;

/**
 * The carrier for any money/quantity field that lands in a DECIMAL column:
 * a decimal STRING, only. Coinbase returns these as strings precisely so they
 * never round-trip through a binary float — accepting a JSON number here would
 * mean the value already passed through a JS `double` at `JSON.parse` time,
 * silently losing precision before any of our code runs. So a numeric value is
 * rejected: a real upstream shape change surfaces as a loud parse failure (an
 * `unknown` SyncError) rather than corrupting an exact amount. Non-DECIMAL,
 * non-money fields (e.g. counts) may stay tolerant of numbers; money may not.
 */
export const coinbaseDecimalString = z.string();

/** One account from `GET /api/v3/brokerage/accounts` (one per held currency). */
export const coinbaseAccountSchema = z
  .object({
    uuid: z.string(),
    currency: z.string(),
    available_balance: coinbaseAmountSchema.nullish(),
    hold: coinbaseAmountSchema.nullish(),
    type: z.string().nullish(),
    platform: z.string().nullish(),
    retail_portfolio_id: z.string().nullish(),
    ready: z.boolean().nullish(),
  })
  .passthrough();

export type CoinbaseAccountRow = z.infer<typeof coinbaseAccountSchema>;

/** The accounts list page (cursor-paginated via `has_next` + `cursor`). */
export const coinbaseAccountsResponseSchema = z
  .object({
    accounts: z.array(coinbaseAccountSchema),
    has_next: z.boolean().optional(),
    cursor: z.string().optional(),
    size: z.number().optional(),
  })
  .passthrough();

export type CoinbaseAccountsPage = z.infer<typeof coinbaseAccountsResponseSchema>;

/** One portfolio from `GET /api/v3/brokerage/portfolios`. */
export const coinbasePortfolioSchema = z
  .object({
    uuid: z.string(),
    name: z.string().nullish(),
    type: z.string().nullish(),
    deleted: z.boolean().nullish(),
  })
  .passthrough();

export type CoinbasePortfolio = z.infer<typeof coinbasePortfolioSchema>;

export const coinbasePortfoliosResponseSchema = z
  .object({
    portfolios: z.array(coinbasePortfolioSchema),
  })
  .passthrough();

export type CoinbasePortfoliosResponse = z.infer<typeof coinbasePortfoliosResponseSchema>;

/**
 * One spot position inside a portfolio breakdown. Crypto/fiat exact amounts
 * are nested `{value}` strings (`available_to_trade_crypto`, `cost_basis`);
 * the convenience aggregate fields (`total_balance_fiat`, `allocation`,
 * `unrealized_pnl`) arrive as floats and are intentionally not money columns.
 */
export const coinbaseSpotPositionSchema = z
  .object({
    asset: z.string(),
    account_uuid: z.string().nullish(),
    asset_uuid: z.string().nullish(),
    asset_img_url: z.string().nullish(),
    is_cash: z.boolean().nullish(),
    // The portfolio-breakdown endpoint serves spot-position crypto quantities as
    // JSON NUMBERS (floats), unlike the exact decimal STRINGS the accounts /
    // orders / fills endpoints return. Coinbase has already passed these through
    // a double on its side, so there's no exact string to preserve — accept the
    // number (string too, forward-compatible) and the normalizer renders a
    // canonical DECIMAL carrier from it.
    total_balance_crypto: z.union([z.string(), z.number()]).nullish(),
    available_to_trade_crypto: z.union([z.string(), z.number()]).nullish(),
    cost_basis: coinbaseAmountSchema.nullish(),
    // Float convenience aggregates (NOT money columns — re-derived in SQL).
    total_balance_fiat: z.number().nullish(),
    allocation: z.number().nullish(),
    unrealized_pnl: z.number().nullish(),
  })
  .passthrough();

export type CoinbaseSpotPosition = z.infer<typeof coinbaseSpotPositionSchema>;

export const coinbasePortfolioBreakdownSchema = z
  .object({
    breakdown: z
      .object({
        portfolio: coinbasePortfolioSchema.nullish(),
        spot_positions: z.array(coinbaseSpotPositionSchema).nullish(),
      })
      .passthrough(),
  })
  .passthrough();

export type CoinbasePortfolioBreakdown = z.infer<typeof coinbasePortfolioBreakdownSchema>;

/**
 * The discrete key permissions from `GET /api/v3/brokerage/key_permissions`.
 * Re-declared as a zod schema (the liveness probe in `provider.ts` reads the
 * `CoinbaseKeyPermissions` interface; this parses the same payload defensively
 * where the sync path needs it).
 */
export const coinbaseKeyPermissionsSchema = z
  .object({
    can_view: z.boolean(),
    can_trade: z.boolean(),
    can_transfer: z.boolean(),
    retail_portfolio_id: z.string().nullish(),
    portfolio_type: z.string().nullish(),
  })
  .passthrough();

// ── Orders / fills (Advanced Trade) ─────────────────────────────────

/**
 * One order from `GET /api/v3/brokerage/orders/historical/batch`. An order's
 * terminal state is stable; while OPEN its `status`/`filled_size` mutate, so
 * the row is upserted on the stable `order_id` (a re-fetch overwrites the
 * mutable fields rather than appending a second row). Money/size fields are
 * decimal STRINGS. Tolerant: enum-ish fields are plain strings, unknown keys
 * pass through.
 */
export const coinbaseOrderSchema = z
  .object({
    order_id: z.string(),
    product_id: z.string().nullish(),
    side: z.string().nullish(),
    status: z.string().nullish(),
    order_type: z.string().nullish(),
    time_in_force: z.string().nullish(),
    // Money/size → DECIMAL columns: string-only (see coinbaseDecimalString).
    filled_size: coinbaseDecimalString.nullish(),
    average_filled_price: coinbaseDecimalString.nullish(),
    filled_value: coinbaseDecimalString.nullish(),
    total_fees: coinbaseDecimalString.nullish(),
    // A count, not a DECIMAL money column — stays tolerant of a numeric upstream.
    number_of_fills: z.union([z.string(), z.number()]).nullish(),
    created_time: z.string().nullish(),
    last_fill_time: z.string().nullish(),
  })
  .passthrough();

export type CoinbaseOrder = z.infer<typeof coinbaseOrderSchema>;

/** The historical-orders page (cursor-paginated via `has_next` + `cursor`). */
export const coinbaseOrdersResponseSchema = z
  .object({
    orders: z.array(coinbaseOrderSchema),
    has_next: z.boolean().optional(),
    cursor: z.string().optional(),
  })
  .passthrough();

export type CoinbaseOrdersPage = z.infer<typeof coinbaseOrdersResponseSchema>;

/**
 * One fill from `GET /api/v3/brokerage/orders/historical/fills`. A fill is
 * immutable once it exists, keyed on the stable `trade_id` (append-only).
 * `price`/`size`/`commission` are decimal STRINGS.
 */
export const coinbaseFillSchema = z
  .object({
    trade_id: z.string(),
    order_id: z.string().nullish(),
    product_id: z.string().nullish(),
    trade_time: z.string().nullish(),
    side: z.string().nullish(),
    liquidity_indicator: z.string().nullish(),
    // Money/size → DECIMAL columns: string-only (see coinbaseDecimalString).
    price: coinbaseDecimalString.nullish(),
    size: coinbaseDecimalString.nullish(),
    size_in_quote: z.boolean().nullish(),
    commission: coinbaseDecimalString.nullish(),
  })
  .passthrough();

export type CoinbaseFill = z.infer<typeof coinbaseFillSchema>;

/** The fills page (cursor-paginated via `has_next` + `cursor`). */
export const coinbaseFillsResponseSchema = z
  .object({
    fills: z.array(coinbaseFillSchema),
    has_next: z.boolean().optional(),
    cursor: z.string().optional(),
  })
  .passthrough();

export type CoinbaseFillsPage = z.infer<typeof coinbaseFillsResponseSchema>;

// ── v2 App-API transaction ledger ───────────────────────────────────

/** A `{amount, currency}` money amount from the v2 App API (decimal STRING). */
export const coinbaseV2AmountSchema = z
  .object({
    amount: z.string(),
    currency: z.string().nullish(),
  })
  .passthrough();

/** One v2 wallet account from `GET /v2/accounts` (paginated). */
export const coinbaseV2AccountSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    currency: z
      .union([z.string(), z.object({ code: z.string().nullish() }).passthrough()])
      .nullish(),
  })
  .passthrough();

export type CoinbaseV2Account = z.infer<typeof coinbaseV2AccountSchema>;

/** The v2 list-response envelope — `data[]` + `pagination.next_starting_after`. */
export const coinbaseV2AccountsResponseSchema = z
  .object({
    data: z.array(coinbaseV2AccountSchema),
    pagination: z
      .object({ next_starting_after: z.string().nullish(), next_uri: z.string().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type CoinbaseV2AccountsPage = z.infer<typeof coinbaseV2AccountsResponseSchema>;

/**
 * One v2 ledger transaction. The `amount` (signed, debit/credit) and the
 * `native_amount` (fiat-valued at the time) are decimal STRINGS. `type`
 * (`buy`, `sell`, `send`, `receive`, `fiat_deposit`, `pro_withdrawal`, …) is a
 * plain string so an unmodelled type degrades to data rather than a failure.
 */
export const coinbaseV2TransactionSchema = z
  .object({
    id: z.string(),
    type: z.string().nullish(),
    status: z.string().nullish(),
    amount: coinbaseV2AmountSchema.nullish(),
    native_amount: coinbaseV2AmountSchema.nullish(),
    description: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();

export type CoinbaseV2Transaction = z.infer<typeof coinbaseV2TransactionSchema>;

/** The v2 transactions page — `data[]` + `pagination.next_starting_after`. */
export const coinbaseV2TransactionsResponseSchema = z
  .object({
    data: z.array(coinbaseV2TransactionSchema),
    pagination: z
      .object({ next_starting_after: z.string().nullish(), next_uri: z.string().nullish() })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type CoinbaseV2TransactionsPage = z.infer<typeof coinbaseV2TransactionsResponseSchema>;

// ── Analytics table schemas ─────────────────────────────────────────
//
// The balances/holdings tables are point-in-time snapshots keyed on a `snapshot_date` (UTC day),
// the day-snapshot convention: a same-day re-sync overwrites idempotently
// (ON CONFLICT … DO UPDATE) while each new UTC day appends a fresh snapshot, so
// net-worth-over-time = `GROUP BY snapshot_date`. They are shared across sibling
// Coinbase source instances (one Omnesis source per CDP portfolio) and so
// discriminate on `source_account_id`.

/** Fractional digits of the fiat-denominated DECIMAL columns. */
export const FIAT_SCALE = 8;
/** Fractional digits of the crypto-quantity DECIMAL columns. */
export const CRYPTO_SCALE = 18;
/** Fiat-denominated money: 8 fractional digits absorbs Coinbase's USD/quote precision. */
const FIAT_DECIMAL = `DECIMAL(38,${FIAT_SCALE})` as const;
/** Crypto quantity: 18 fractional digits covers ETH-class assets at full precision. */
const CRYPTO_DECIMAL = `DECIMAL(38,${CRYPTO_SCALE})` as const;

export const coinbaseBalancesTableSchema: AnalyticsTableSchema = {
  tableName: "coinbase_balances",
  displayName: "Coinbase Balances",
  description:
    "Daily point-in-time snapshots of per-currency wallet balances at Coinbase — owned by the coinbase source; history accumulates one snapshot per currency per UTC day (net-worth-over-time = GROUP BY snapshot_date)",
  columns: [
    {
      name: "snapshot_date",
      type: "DATE",
      description: "UTC date the snapshot was fetched (canonical time column)",
    },
    {
      name: "currency",
      type: "VARCHAR",
      description: "Asset/currency code of the wallet (e.g. BTC, ETH, USD)",
    },
    {
      name: "available_balance",
      type: CRYPTO_DECIMAL,
      description: "Spendable balance of the currency (exact decimal string from the API)",
      nullable: true,
    },
    {
      name: "hold_balance",
      type: CRYPTO_DECIMAL,
      description: "Balance held/locked (e.g. by open orders) — exact decimal string",
      nullable: true,
    },
    {
      name: "account_uuid",
      type: "VARCHAR",
      description: "Coinbase wallet account UUID for this currency",
      nullable: true,
    },
    {
      name: "type",
      type: "VARCHAR",
      description: "Account type (e.g. ACCOUNT_TYPE_CRYPTO, ACCOUNT_TYPE_FIAT)",
      nullable: true,
    },
    {
      name: "account_key",
      type: "VARCHAR",
      description:
        "Stable per-account key — the Coinbase retail_portfolio_id (or a hash-derived id) common to all of a source instance's rows",
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      description: "Omnesis account slug discriminating sibling source instances",
    },
  ],
  primaryKey: ["account_key", "currency", "snapshot_date"],
  semanticTimeColumn: "snapshot_date",
  record: {
    titleColumns: ["available_balance", "currency"],
    titleTemplate: "{available_balance} {currency}",
    keyColumns: ["snapshot_date", "currency", "available_balance", "hold_balance"],
  },
  sharedDiscriminatorColumn: "source_account_id",
  exampleQueries: [
    "SELECT snapshot_date, currency, available_balance FROM coinbase_balances WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM coinbase_balances) ORDER BY currency",
    "SELECT currency, MIN(snapshot_date) AS first_seen, MAX(snapshot_date) AS last_seen FROM coinbase_balances GROUP BY currency ORDER BY first_seen",
    "SELECT snapshot_date, SUM(available_balance + COALESCE(hold_balance, 0)) AS total_units FROM coinbase_balances WHERE currency = 'BTC' GROUP BY snapshot_date ORDER BY snapshot_date",
  ],
};

export const coinbaseHoldingsTableSchema: AnalyticsTableSchema = {
  tableName: "coinbase_holdings",
  displayName: "Coinbase Holdings",
  description:
    "Daily point-in-time snapshots of spot positions (holdings) at Coinbase from the portfolio breakdown — owned by the coinbase source; history accumulates one snapshot per asset per UTC day. Fiat valuations are derived from exact crypto-quantity + cost-basis columns, not from the API's float aggregates.",
  columns: [
    {
      name: "snapshot_date",
      type: "DATE",
      description: "UTC date the snapshot was fetched (canonical time column)",
    },
    {
      name: "asset",
      type: "VARCHAR",
      description: "Asset code of the spot position (e.g. BTC, ETH)",
    },
    {
      name: "total_balance_crypto",
      type: CRYPTO_DECIMAL,
      description: "Total units of the asset held (exact decimal string from the API)",
      nullable: true,
    },
    {
      name: "available_to_trade_crypto",
      type: CRYPTO_DECIMAL,
      description: "Units available to trade (exact decimal string)",
      nullable: true,
    },
    {
      name: "cost_basis",
      type: FIAT_DECIMAL,
      description: "Cost basis of the position in its quote currency (exact decimal string)",
      nullable: true,
    },
    {
      name: "cost_basis_currency",
      type: "VARCHAR",
      description: "Quote currency of the cost basis (e.g. USD)",
      nullable: true,
    },
    {
      name: "is_cash",
      type: "BOOLEAN",
      description: "Whether the position is a fiat/cash holding rather than a crypto asset",
      nullable: true,
    },
    {
      name: "account_uuid",
      type: "VARCHAR",
      description: "Coinbase wallet account UUID backing this position",
      nullable: true,
    },
    {
      name: "account_key",
      type: "VARCHAR",
      description:
        "Stable per-account key — the Coinbase retail_portfolio_id (or a hash-derived id) common to all of a source instance's rows",
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      description: "Omnesis account slug discriminating sibling source instances",
    },
  ],
  primaryKey: ["account_key", "asset", "snapshot_date"],
  semanticTimeColumn: "snapshot_date",
  record: {
    titleColumns: ["total_balance_crypto", "asset"],
    titleTemplate: "{total_balance_crypto} {asset}",
    keyColumns: [
      "snapshot_date",
      "asset",
      "total_balance_crypto",
      "cost_basis",
      "cost_basis_currency",
    ],
  },
  sharedDiscriminatorColumn: "source_account_id",
  exampleQueries: [
    "SELECT snapshot_date, asset, total_balance_crypto, cost_basis FROM coinbase_holdings WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM coinbase_holdings) ORDER BY asset",
    "SELECT asset, MIN(snapshot_date) AS first_seen, MAX(snapshot_date) AS last_seen FROM coinbase_holdings GROUP BY asset ORDER BY first_seen",
    "SELECT snapshot_date, SUM(cost_basis) AS total_cost_basis FROM coinbase_holdings WHERE cost_basis IS NOT NULL GROUP BY snapshot_date ORDER BY snapshot_date",
  ],
};

// ── Append-only activity tables ──────────────────────────────
//
// Orders, fills, and v2 ledger transactions are CURRENT-STATE APPEND-ONLY (not
// day snapshots): each row is keyed on the stable upstream id so an at-least-once
// retry of the same page upserts the identical PK (no duplicate, no loss), and
// incremental syncs append only rows newer than a persisted watermark rather than
// re-walking settled history. Shared across sibling instances via `source_account_id`.

export const coinbaseOrdersTableSchema: AnalyticsTableSchema = {
  tableName: "coinbase_orders",
  displayName: "Coinbase Orders",
  description:
    "Historical orders placed at Coinbase (one row per order, keyed on the stable order_id) — owned by the coinbase source; append-only, an open order's mutable status/filled fields are upserted on re-sync",
  columns: [
    {
      name: "created_time",
      type: "TIMESTAMPTZ",
      description: "When the order was created (canonical time column)",
      nullable: true,
    },
    { name: "order_id", type: "VARCHAR", description: "Coinbase's stable order id" },
    {
      name: "product_id",
      type: "VARCHAR",
      description: "Traded product (e.g. BTC-USD)",
      nullable: true,
    },
    { name: "side", type: "VARCHAR", description: "BUY or SELL", nullable: true },
    {
      name: "status",
      type: "VARCHAR",
      description: "Order status (OPEN, FILLED, CANCELLED, EXPIRED, ...)",
      nullable: true,
    },
    {
      name: "order_type",
      type: "VARCHAR",
      description: "Order type (e.g. MARKET, LIMIT)",
      nullable: true,
    },
    {
      name: "filled_size",
      type: CRYPTO_DECIMAL,
      description: "Base units filled (exact decimal string)",
      nullable: true,
    },
    {
      name: "average_filled_price",
      type: FIAT_DECIMAL,
      description:
        "Volume-weighted average fill price in the quote currency (exact decimal string)",
      nullable: true,
    },
    {
      name: "filled_value",
      type: FIAT_DECIMAL,
      description: "Total filled value in the quote currency (exact decimal string)",
      nullable: true,
    },
    {
      name: "total_fees",
      type: FIAT_DECIMAL,
      description: "Total fees in the quote currency (exact decimal string)",
      nullable: true,
    },
    {
      name: "last_fill_time",
      type: "TIMESTAMPTZ",
      description: "Time of the most recent fill",
      nullable: true,
    },
    {
      name: "account_key",
      type: "VARCHAR",
      description:
        "Stable per-account key — the Coinbase retail_portfolio_id (or a hash-derived id) common to all of a source instance's rows",
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      description: "Omnesis account slug discriminating sibling source instances",
    },
  ],
  primaryKey: ["account_key", "order_id"],
  semanticTimeColumn: "created_time",
  record: {
    titleColumns: ["side", "product_id"],
    titleTemplate: "{side} {product_id}",
    keyColumns: [
      "created_time",
      "product_id",
      "side",
      "status",
      "filled_size",
      "average_filled_price",
    ],
  },
  sharedDiscriminatorColumn: "source_account_id",
  exampleQueries: [
    "SELECT product_id, side, COUNT(*) AS orders, SUM(filled_value) AS total_value FROM coinbase_orders WHERE status = 'FILLED' GROUP BY product_id, side ORDER BY total_value DESC",
    "SELECT date_trunc('month', created_time) AS month, SUM(total_fees) AS fees FROM coinbase_orders WHERE total_fees IS NOT NULL GROUP BY month ORDER BY month DESC",
    "SELECT order_id, product_id, status, filled_size, average_filled_price FROM coinbase_orders ORDER BY created_time DESC LIMIT 50",
  ],
};

export const coinbaseFillsTableSchema: AnalyticsTableSchema = {
  tableName: "coinbase_fills",
  displayName: "Coinbase Fills",
  description:
    "Individual trade fills at Coinbase (one row per fill, keyed on the stable trade_id) — owned by the coinbase source; append-only and immutable, a re-fetched fill upserts the identical row",
  columns: [
    {
      name: "trade_time",
      type: "TIMESTAMPTZ",
      description: "When the fill executed (canonical time column)",
      nullable: true,
    },
    { name: "trade_id", type: "VARCHAR", description: "Coinbase's stable trade id" },
    {
      name: "order_id",
      type: "VARCHAR",
      description: "The order this fill belongs to",
      nullable: true,
    },
    {
      name: "product_id",
      type: "VARCHAR",
      description: "Traded product (e.g. BTC-USD)",
      nullable: true,
    },
    { name: "side", type: "VARCHAR", description: "BUY or SELL", nullable: true },
    {
      name: "liquidity_indicator",
      type: "VARCHAR",
      description: "MAKER or TAKER (or UNKNOWN_LIQUIDITY_INDICATOR)",
      nullable: true,
    },
    {
      name: "price",
      type: FIAT_DECIMAL,
      description: "Per-unit fill price in the quote currency (exact decimal string)",
      nullable: true,
    },
    {
      name: "size",
      type: CRYPTO_DECIMAL,
      description:
        "Filled size — base units, or quote units when size_in_quote (exact decimal string)",
      nullable: true,
    },
    {
      name: "size_in_quote",
      type: "BOOLEAN",
      description: "Whether `size` is denominated in the quote currency rather than base units",
      nullable: true,
    },
    {
      name: "commission",
      type: FIAT_DECIMAL,
      description: "Commission charged on the fill in the quote currency (exact decimal string)",
      nullable: true,
    },
    {
      name: "account_key",
      type: "VARCHAR",
      description:
        "Stable per-account key — the Coinbase retail_portfolio_id (or a hash-derived id) common to all of a source instance's rows",
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      description: "Omnesis account slug discriminating sibling source instances",
    },
  ],
  primaryKey: ["account_key", "trade_id"],
  semanticTimeColumn: "trade_time",
  record: {
    titleColumns: ["side", "product_id"],
    titleTemplate: "{side} {product_id}",
    keyColumns: ["trade_time", "product_id", "side", "price", "size"],
  },
  sharedDiscriminatorColumn: "source_account_id",
  exampleQueries: [
    "SELECT product_id, SUM(size) AS units, SUM(commission) AS fees FROM coinbase_fills GROUP BY product_id ORDER BY units DESC",
    "SELECT date_trunc('month', trade_time) AS month, side, COUNT(*) AS fills FROM coinbase_fills GROUP BY month, side ORDER BY month DESC",
    "SELECT trade_id, product_id, side, price, size FROM coinbase_fills ORDER BY trade_time DESC LIMIT 50",
  ],
};

export const coinbaseTransactionsTableSchema: AnalyticsTableSchema = {
  tableName: "coinbase_transactions",
  displayName: "Coinbase Transactions",
  description:
    "The Coinbase v2 wallet transaction ledger (buys, sells, sends, receives, fiat deposits/withdrawals) keyed on the stable transaction id — owned by the coinbase source; append-only. Requires the read-only wallet:transactions:read grant; the source stays healthy if it is absent (this table is simply not populated).",
  columns: [
    {
      name: "created_at",
      type: "TIMESTAMPTZ",
      description: "When the transaction was created (canonical time column)",
      nullable: true,
    },
    { name: "transaction_id", type: "VARCHAR", description: "Coinbase's stable transaction id" },
    {
      name: "wallet_account_id",
      type: "VARCHAR",
      description: "The v2 wallet account the transaction belongs to",
      nullable: true,
    },
    {
      name: "type",
      type: "VARCHAR",
      description:
        "Transaction type (buy, sell, send, receive, fiat_deposit, ...) — carried verbatim",
      nullable: true,
    },
    {
      name: "status",
      type: "VARCHAR",
      description: "Transaction status (completed, pending, ...)",
      nullable: true,
    },
    {
      name: "amount",
      type: CRYPTO_DECIMAL,
      description:
        "Signed asset amount moved (positive credit / negative debit) — exact decimal string",
      nullable: true,
    },
    {
      name: "amount_currency",
      type: "VARCHAR",
      description: "Currency of `amount` (e.g. BTC, USD)",
      nullable: true,
    },
    {
      name: "native_amount",
      type: FIAT_DECIMAL,
      description: "Signed value in the account's native fiat at the time (exact decimal string)",
      nullable: true,
    },
    {
      name: "native_amount_currency",
      type: "VARCHAR",
      description: "Native fiat currency of `native_amount` (e.g. USD, EUR)",
      nullable: true,
    },
    {
      name: "description",
      type: "VARCHAR",
      description: "Human-readable description from Coinbase",
      nullable: true,
    },
    {
      name: "account_key",
      type: "VARCHAR",
      description:
        "Stable per-account key — the Coinbase retail_portfolio_id (or a hash-derived id) common to all of a source instance's rows",
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      description: "Omnesis account slug discriminating sibling source instances",
    },
  ],
  primaryKey: ["account_key", "transaction_id"],
  semanticTimeColumn: "created_at",
  record: {
    titleColumns: ["type", "amount_currency"],
    titleTemplate: "{type} {amount_currency}",
    keyColumns: [
      "created_at",
      "type",
      "amount",
      "amount_currency",
      "native_amount",
      "native_amount_currency",
    ],
  },
  sharedDiscriminatorColumn: "source_account_id",
  // Each transaction row co-describes a searchable ledger document whose
  // externalId is `${account_key}:${transaction_id}` (normalizer.ts) — the 1:1
  // doc↔row edge. account_key (a UUID/hash) never contains the ':'
  // separator, so the composite externalId splits cleanly back into the PK.
  boundDocument: { externalIdColumns: ["account_key", "transaction_id"] },
  exampleQueries: [
    "SELECT type, COUNT(*) AS n, SUM(native_amount) AS net_native FROM coinbase_transactions GROUP BY type ORDER BY n DESC",
    "SELECT date_trunc('month', created_at) AS month, SUM(native_amount) AS net_flow FROM coinbase_transactions GROUP BY month ORDER BY month DESC",
    "SELECT created_at, type, amount, amount_currency, description FROM coinbase_transactions ORDER BY created_at DESC LIMIT 50",
  ],
};

/** All analytics tables managed by the Coinbase provider (balances + holdings; orders + fills + transactions). */
export const allSchemas: AnalyticsTableSchema[] = [
  coinbaseBalancesTableSchema,
  coinbaseHoldingsTableSchema,
  coinbaseOrdersTableSchema,
  coinbaseFillsTableSchema,
  coinbaseTransactionsTableSchema,
];
