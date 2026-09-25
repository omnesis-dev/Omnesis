// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/**
 * Zod schemas for the Plaid API responses the auth/Link flow consumes,
 * validated at the client boundary (zod-at-boundary). Only the fields the
 * provider reads are modelled; unknown fields pass through harmlessly.
 */

/** The error body Plaid nests inside a Link session's exit, and returns on a failure. */
const plaidErrorBodySchema = z
  .object({
    error_type: z.string().nullable().optional(),
    error_code: z.string().nullable().optional(),
    error_message: z.string().nullable().optional(),
    display_message: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * `POST /link/token/create` → the Link token plus, for a Hosted Link session,
 * the Plaid-hosted URL the user opens. Both expire together.
 */
export const plaidLinkTokenCreateResponseSchema = z.object({
  link_token: z.string().min(1),
  hosted_link_url: z.string().min(1).optional(),
  expiration: z.string().optional(),
  request_id: z.string().optional(),
});
export type PlaidLinkTokenCreateResponse = z.infer<typeof plaidLinkTokenCreateResponseSchema>;

/** The institution a finished Link session connected. */
export const plaidLinkSessionInstitutionSchema = z
  .object({
    name: z.string().nullable().optional(),
    institution_id: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * One item a Link session added. `results.item_add_results` is the current
 * shape; the deprecated `on_success` carries the same `public_token` for
 * sessions Plaid still reports the older way, so both are read.
 */
const plaidItemAddResultSchema = z
  .object({
    public_token: z.string().min(1).optional(),
    institution: plaidLinkSessionInstitutionSchema.nullable().optional(),
  })
  .passthrough();

/**
 * `POST /link/token/get` → every session opened against a Link token. A Hosted
 * Link flow polls this to learn its outcome: a session with `finished_at` set
 * has either linked something (`results` / `on_success`) or been abandoned
 * (`exit` / `on_exit`, carrying the reason).
 */
export const plaidLinkTokenGetResponseSchema = z
  .object({
    link_token: z.string().min(1),
    link_sessions: z
      .array(
        z
          .object({
            link_session_id: z.string().optional(),
            finished_at: z.string().nullable().optional(),
            results: z
              .object({ item_add_results: z.array(plaidItemAddResultSchema).optional() })
              .passthrough()
              .nullable()
              .optional(),
            on_success: z
              .object({
                public_token: z.string().min(1).optional(),
                metadata: z
                  .object({ institution: plaidLinkSessionInstitutionSchema.nullable().optional() })
                  .passthrough()
                  .optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
            exit: z
              .object({ error: plaidErrorBodySchema.nullable().optional() })
              .passthrough()
              .nullable()
              .optional(),
            on_exit: z
              .object({ error: plaidErrorBodySchema.nullable().optional() })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    request_id: z.string().optional(),
  })
  .passthrough();
export type PlaidLinkTokenGetResponse = z.infer<typeof plaidLinkTokenGetResponseSchema>;

/** One session opened against a Link token. */
export type PlaidLinkSession = NonNullable<PlaidLinkTokenGetResponse["link_sessions"]>[number];

/**
 * `POST /institutions/get_by_id` → the institution's identity and, with
 * optional metadata requested, its brand mark and colour for the instance icon.
 */
export const plaidInstitutionGetByIdResponseSchema = z
  .object({
    institution: z
      .object({
        institution_id: z.string().min(1),
        name: z.string().optional(),
        /** Base64 PNG (Plaid serves 152×152), without a data-URI prefix. */
        logo: z.string().nullable().optional(),
        primary_color: z.string().nullable().optional(),
      })
      .passthrough(),
    request_id: z.string().optional(),
  })
  .passthrough();
export type PlaidInstitutionGetByIdResponse = z.infer<typeof plaidInstitutionGetByIdResponseSchema>;

/** `POST /item/public_token/exchange` → the per-item `access_token` + `item_id`. */
export const plaidItemPublicTokenExchangeResponseSchema = z.object({
  access_token: z.string().min(1),
  item_id: z.string().min(1),
  request_id: z.string().optional(),
});
export type PlaidItemPublicTokenExchangeResponse = z.infer<
  typeof plaidItemPublicTokenExchangeResponseSchema
>;

/**
 * The subset of `/item/get` the provider reads. `consent_expiration_time`
 * drives the forward-looking consent-expiry surface.
 */
export const plaidItemGetResponseSchema = z.object({
  item: z.object({
    item_id: z.string().min(1),
    institution_id: z.string().nullable().optional(),
    consent_expiration_time: z.string().nullable().optional(),
  }),
  request_id: z.string().optional(),
});
export type PlaidItemGetResponse = z.infer<typeof plaidItemGetResponseSchema>;

/** `POST /item/remove` → acknowledgement only; the access token is now invalid. */
export const plaidItemRemoveResponseSchema = z.object({
  request_id: z.string().optional(),
});
export type PlaidItemRemoveResponse = z.infer<typeof plaidItemRemoveResponseSchema>;

/**
 * Plaid's standard error envelope (returned with a non-2xx status). The client
 * maps `error_code` onto a typed `SyncError` so the collector routes the source
 * correctly. Never surfaced verbatim to the user (it can echo request context).
 */
export const plaidErrorResponseSchema = z.object({
  error_type: z.string().optional(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  request_id: z.string().optional(),
});

// ── /transactions/sync ──────────────────────────────────────────────

/**
 * One transaction in a `/transactions/sync` page. Plaid serves money as a JSON
 * **number** (`amount`), positive = money OUT of the account (a purchase),
 * negative = money in — the inverse of the bank-statement sign convention, so
 * the normalizer flips it. Only the fields the provider records are modelled;
 * the rest pass through (`.passthrough()`) so Plaid can evolve the shape.
 *
 * `pending_transaction_id` links a posted transaction back to the pending row
 * it replaced — when a pending transaction posts, Plaid mints a NEW
 * `transaction_id`, emits the posted row in `added`/`modified`, and lists the
 * OLD pending id in `removed[]`. Tombstoning `removed[]` by `transaction_id`
 * therefore handles the pending→posted transition with no orphan.
 */
export const plaidTransactionSchema = z
  .object({
    transaction_id: z.string().min(1),
    account_id: z.string().min(1),
    amount: z.number(),
    iso_currency_code: z.string().nullable().optional(),
    unofficial_currency_code: z.string().nullable().optional(),
    /** Posted/authorization date (YYYY-MM-DD). */
    date: z.string().min(1),
    /** ISO-8601 instant when present (newer Plaid responses). */
    datetime: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    merchant_name: z.string().nullable().optional(),
    pending: z.boolean().optional(),
    pending_transaction_id: z.string().nullable().optional(),
    payment_channel: z.string().nullable().optional(),
    personal_finance_category: z
      .object({
        primary: z.string().nullable().optional(),
        detailed: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();
export type PlaidTransaction = z.infer<typeof plaidTransactionSchema>;

/** A `removed[]` entry — only the id is guaranteed. */
export const plaidRemovedTransactionSchema = z
  .object({ transaction_id: z.string().min(1) })
  .passthrough();
export type PlaidRemovedTransaction = z.infer<typeof plaidRemovedTransactionSchema>;

/**
 * `POST /transactions/sync` → one delta page. `next_cursor` is opaque and is
 * advanced only after the page durably ingests; `has_more` drives pagination
 * within a single sync tick. `added` and `modified` rows are validated one at
 * a time by {@link parseTransactionRows} so a single malformed row is skipped
 * rather than failing the page.
 */
export const plaidTransactionsSyncResponseSchema = z
  .object({
    added: z.array(z.unknown()),
    modified: z.array(z.unknown()),
    removed: z.array(plaidRemovedTransactionSchema),
    next_cursor: z.string(),
    has_more: z.boolean(),
    /**
     * How far Plaid's history pull for the item has progressed; the initial
     * pages arrive before it reaches `HISTORICAL_UPDATE_COMPLETE`.
     */
    transactions_update_status: z.string().optional(),
    request_id: z.string().optional(),
  })
  .passthrough();
export type PlaidTransactionsSyncResponse = z.infer<typeof plaidTransactionsSyncResponseSchema>;

/** The `transactions_update_status` value meaning every requested day has been pulled. */
export const PLAID_HISTORICAL_UPDATE_COMPLETE = "HISTORICAL_UPDATE_COMPLETE";

/**
 * Validate a page's transaction rows individually. A row Plaid serves in a
 * shape the schema does not accept is dropped and counted, so one odd row
 * never blocks the rest of the page or the cursor behind it.
 */
export function parseTransactionRows(rows: unknown[]): {
  transactions: PlaidTransaction[];
  malformed: number;
} {
  const transactions: PlaidTransaction[] = [];
  let malformed = 0;
  for (const row of rows) {
    const parsed = plaidTransactionSchema.safeParse(row);
    if (parsed.success) transactions.push(parsed.data);
    else malformed += 1;
  }
  return { transactions, malformed };
}

// ── /accounts/get ───────────────────────────────────────────────────

/**
 * The balance block on one account. Plaid serves every figure as a JSON
 * **number** (or null when the institution doesn't report it). `current` is the
 * statement balance; `available` is what is spendable now (current minus holds);
 * `limit` is the credit limit on a credit account. Currency comes from either
 * the ISO code or Plaid's unofficial code. Only the fields the snapshot records
 * are modelled; the rest pass through.
 */
export const plaidAccountBalancesSchema = z
  .object({
    available: z.number().nullable().optional(),
    current: z.number().nullable().optional(),
    limit: z.number().nullable().optional(),
    iso_currency_code: z.string().nullable().optional(),
    unofficial_currency_code: z.string().nullable().optional(),
  })
  .passthrough();
export type PlaidAccountBalances = z.infer<typeof plaidAccountBalancesSchema>;

/**
 * One account in an `/accounts/get` response. `account_id` is stable
 * per item; `type`/`subtype` classify it (depository / credit / investment /
 * loan). `name`/`official_name` are display labels — never an account number.
 */
export const plaidBalanceAccountSchema = z
  .object({
    account_id: z.string().min(1),
    name: z.string().nullable().optional(),
    official_name: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    subtype: z.string().nullable().optional(),
    balances: plaidAccountBalancesSchema,
  })
  .passthrough();
export type PlaidBalanceAccount = z.infer<typeof plaidBalanceAccountSchema>;

/** `POST /accounts/get` → the live balance for every account on an item. */
export const plaidAccountsGetResponseSchema = z
  .object({
    accounts: z.array(plaidBalanceAccountSchema),
    request_id: z.string().optional(),
  })
  .passthrough();
export type PlaidAccountsGetResponse = z.infer<typeof plaidAccountsGetResponseSchema>;

// ── /investments/holdings/get ───────────────────────────────────────

/**
 * One holding (a position in one security on one investment account). Plaid
 * serves `quantity`, `institution_price`, `institution_value`, and `cost_basis`
 * as JSON **numbers**. `security_id` joins to the securities array; together
 * with `account_id` it identifies the position within an item.
 */
export const plaidHoldingSchema = z
  .object({
    account_id: z.string().min(1),
    security_id: z.string().min(1),
    quantity: z.number().nullable().optional(),
    institution_price: z.number().nullable().optional(),
    institution_value: z.number().nullable().optional(),
    cost_basis: z.number().nullable().optional(),
    iso_currency_code: z.string().nullable().optional(),
    unofficial_currency_code: z.string().nullable().optional(),
  })
  .passthrough();
export type PlaidHolding = z.infer<typeof plaidHoldingSchema>;

/**
 * One security referenced by a holding. `ticker_symbol`/`name` are display
 * labels; `type` classifies it (equity / etf / mutual fund / cash …). Modelled
 * loosely — Plaid evolves the security shape.
 */
export const plaidSecuritySchema = z
  .object({
    security_id: z.string().min(1),
    ticker_symbol: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    iso_currency_code: z.string().nullable().optional(),
    unofficial_currency_code: z.string().nullable().optional(),
  })
  .passthrough();
export type PlaidSecurity = z.infer<typeof plaidSecuritySchema>;

/**
 * `POST /investments/holdings/get` → every holding on an item plus the
 * securities they reference. An item with no investment account does not
 * return this shape at all — Plaid answers 400 (`PLAID_NO_INVESTMENTS_CODES`),
 * which the snapshot phase folds into zero holdings rows.
 */
export const plaidInvestmentsHoldingsGetResponseSchema = z
  .object({
    holdings: z.array(plaidHoldingSchema),
    securities: z.array(plaidSecuritySchema),
    request_id: z.string().optional(),
  })
  .passthrough();
export type PlaidInvestmentsHoldingsGetResponse = z.infer<
  typeof plaidInvestmentsHoldingsGetResponseSchema
>;

// ── Analytics table schema ──────────────────────────────────────────
//
// `plaid_transactions` is shared across sibling Plaid source instances (one
// per connected item/institution), discriminated by `item_id` — exactly the
// Omnesis accountId. On source removal the gateway deletes
// WHERE item_id = <accountId> instead of dropping the table, so other
// connected items keep their rows.

const PLAID_SHARED_NOTE =
  "Owned by the Plaid source; shared across connected institutions and discriminated by item_id.";

export const plaidTransactionsSchema: AnalyticsTableSchema = {
  tableName: "plaid_transactions",
  displayName: "Bank Transactions (Plaid)",
  description:
    "Bank and card transactions synced from US/Canada institutions via Plaid, with signed " +
    `exact-decimal amounts — negative = money out, positive = money in. ${PLAID_SHARED_NOTE}`,
  columns: [
    {
      name: "transaction_id",
      type: "VARCHAR",
      description: "Stable Plaid transaction id — changes when a pending transaction posts",
    },
    {
      name: "item_id",
      type: "VARCHAR",
      description: "Connected-institution instance id (the Plaid item id)",
    },
    {
      name: "account_id",
      type: "VARCHAR",
      description: "Plaid account id this transaction belongs to (one item can hold several)",
    },
    { name: "date", type: "DATE", description: "Posted/authorization date of the transaction" },
    {
      name: "datetime",
      type: "TIMESTAMPTZ",
      description: "Exact transaction instant when the institution reports one",
      nullable: true,
    },
    {
      name: "amount",
      type: "DECIMAL(38,2)",
      description:
        "Signed amount (exact decimal) in the transaction currency — negative for debits " +
        "(money out), positive for credits (money in)",
    },
    {
      name: "currency",
      type: "VARCHAR",
      description: "ISO currency code (or Plaid unofficial code), when reported",
      nullable: true,
    },
    {
      name: "name",
      type: "VARCHAR",
      description: "Transaction description as reported by the institution",
      nullable: true,
    },
    {
      name: "merchant_name",
      type: "VARCHAR",
      description: "Plaid-enriched merchant name, when resolved",
      nullable: true,
    },
    {
      name: "category",
      type: "VARCHAR",
      description: "Plaid personal-finance category (primary), when classified",
      nullable: true,
      canonicalValues: [
        "INCOME",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "LOAN_PAYMENTS",
        "BANK_FEES",
        "ENTERTAINMENT",
        "FOOD_AND_DRINK",
        "GENERAL_MERCHANDISE",
        "HOME_IMPROVEMENT",
        "MEDICAL",
        "PERSONAL_CARE",
        "GENERAL_SERVICES",
        "GOVERNMENT_AND_NON_PROFIT",
        "TRANSPORTATION",
        "TRAVEL",
        "RENT_AND_UTILITIES",
      ],
    },
    {
      name: "payment_channel",
      type: "VARCHAR",
      description: "How the transaction was made",
      nullable: true,
      canonicalValues: ["online", "in store", "other"],
    },
    {
      name: "pending",
      type: "BOOLEAN",
      description: "Whether the transaction is still pending (not yet posted)",
    },
    {
      name: "pending_transaction_id",
      type: "VARCHAR",
      description: "When posted, the id of the pending transaction this row replaced",
      nullable: true,
    },
  ],
  primaryKey: ["item_id", "transaction_id"],
  // Addressed by both halves. Plaid's transaction ids are unique across a
  // developer app, but that is the upstream's promise rather than this
  // table's shape, and a delete keyed on the id alone would reach a sibling
  // connection's row the moment the promise stopped holding.
  deleteKey: ["item_id", "transaction_id"],
  // A transaction is placed at its posted/authorization date.
  semanticTimeColumn: "date",
  record: {
    titleColumns: ["merchant_name", "name"],
    keyColumns: ["date", "amount", "currency", "merchant_name"],
  },
  sharedDiscriminatorColumn: "item_id",
  // Each row co-describes the transaction document whose externalId is
  // `${item_id}:${transaction_id}` (normalizer.ts) — declare the 1:1 doc↔row
  // edge (#450). Neither key component contains ':', so the composite
  // externalId splits cleanly back into the primary key.
  boundDocument: { externalIdColumns: ["item_id", "transaction_id"] },
  exampleQueries: [
    "SELECT date_trunc('month', date) AS month, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS spent, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS received FROM plaid_transactions WHERE NOT pending GROUP BY month ORDER BY month DESC",
    "SELECT merchant_name, COUNT(*) AS n, SUM(-amount) AS total_spent FROM plaid_transactions WHERE amount < 0 AND NOT pending GROUP BY merchant_name ORDER BY total_spent DESC LIMIT 20",
    "SELECT date, merchant_name, name, amount, currency FROM plaid_transactions ORDER BY date DESC LIMIT 50",
  ],
};

// ── Balances snapshot table ─────────────────────────────────────────
//
// Point-in-time, append-only: one row per (item_id, account_id, snapshot_date).
// A same-day re-sync overwrites the day's rows via the composite-PK upsert; a
// new UTC day appends a fresh snapshot, so balance-over-time = GROUP BY
// snapshot_date. This table NEVER emits deletes — its rows are history, and a
// delete keyed on any snapshot column would erase past days; snapshots only
// ever upsert by their composite primary key.

export const plaidBalancesSchema: AnalyticsTableSchema = {
  tableName: "plaid_balances",
  displayName: "Bank Balances (Plaid)",
  description:
    "Daily point-in-time snapshots of per-account balances at US/Canada institutions via Plaid, " +
    `with exact-decimal amounts — balance-over-time = GROUP BY snapshot_date. ${PLAID_SHARED_NOTE}`,
  columns: [
    {
      name: "snapshot_date",
      type: "DATE",
      description: "UTC date the snapshot was fetched (canonical time column)",
    },
    {
      name: "item_id",
      type: "VARCHAR",
      description: "Connected-institution instance id (the Plaid item id)",
    },
    {
      name: "account_id",
      type: "VARCHAR",
      description: "Plaid account id this balance belongs to (one item can hold several)",
    },
    {
      name: "account_name",
      type: "VARCHAR",
      description: "Account display name as reported by the institution (never an account number)",
      nullable: true,
    },
    {
      name: "account_type",
      type: "VARCHAR",
      description: "Plaid account type",
      nullable: true,
      canonicalValues: ["depository", "credit", "loan", "investment", "brokerage", "other"],
    },
    {
      name: "account_subtype",
      type: "VARCHAR",
      description: "Plaid account subtype",
      nullable: true,
      canonicalValues: [
        "checking",
        "savings",
        "money market",
        "cd",
        "credit card",
        "brokerage",
        "ira",
        "401k",
        "mortgage",
        "student",
        "auto",
      ],
    },
    {
      name: "available",
      type: "DECIMAL(38,2)",
      description: "Spendable balance (current minus holds), exact decimal — when reported",
      nullable: true,
    },
    {
      name: "current",
      type: "DECIMAL(38,2)",
      description: "Statement balance, exact decimal — when reported",
      nullable: true,
    },
    {
      name: "credit_limit",
      type: "DECIMAL(38,2)",
      description: "Credit limit on a credit account, exact decimal — when reported",
      nullable: true,
    },
    {
      name: "currency",
      type: "VARCHAR",
      description: "ISO currency code (or Plaid unofficial code), when reported",
      nullable: true,
    },
  ],
  primaryKey: ["item_id", "account_id", "snapshot_date"],
  semanticTimeColumn: "snapshot_date",
  record: {
    titleColumns: ["account_name", "current", "currency"],
    titleTemplate: "{account_name} {current} {currency}",
    keyColumns: ["snapshot_date", "account_id", "current", "available", "currency"],
  },
  sharedDiscriminatorColumn: "item_id",
  exampleQueries: [
    "SELECT account_name, current, currency FROM plaid_balances WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM plaid_balances) ORDER BY account_name",
    "SELECT snapshot_date, SUM(current) AS net_balance FROM plaid_balances GROUP BY snapshot_date ORDER BY snapshot_date DESC",
    "SELECT account_name, MIN(snapshot_date) AS first_seen, MAX(snapshot_date) AS last_seen FROM plaid_balances GROUP BY account_name ORDER BY first_seen",
  ],
};

// ── Holdings snapshot table ─────────────────────────────────────────
//
// Point-in-time, append-only: one row per (item_id, account_id, security_id,
// snapshot_date). Same append-only discipline as `plaid_balances` — never emits
// deletes.

export const plaidHoldingsSchema: AnalyticsTableSchema = {
  tableName: "plaid_holdings",
  displayName: "Investment Holdings (Plaid)",
  description:
    "Daily point-in-time snapshots of investment holdings (positions) at US/Canada institutions " +
    `via Plaid, with exact-decimal quantities and values. ${PLAID_SHARED_NOTE}`,
  columns: [
    {
      name: "snapshot_date",
      type: "DATE",
      description: "UTC date the snapshot was fetched (canonical time column)",
    },
    {
      name: "item_id",
      type: "VARCHAR",
      description: "Connected-institution instance id (the Plaid item id)",
    },
    {
      name: "account_id",
      type: "VARCHAR",
      description: "Plaid investment account id this holding belongs to",
    },
    {
      name: "security_id",
      type: "VARCHAR",
      description: "Plaid security id of the held position",
    },
    {
      name: "ticker",
      type: "VARCHAR",
      description: "Ticker symbol of the security, when resolved",
      nullable: true,
    },
    {
      name: "security_name",
      type: "VARCHAR",
      description: "Display name of the security, when resolved",
      nullable: true,
    },
    {
      name: "security_type",
      type: "VARCHAR",
      description: "Plaid security type, when classified",
      nullable: true,
      canonicalValues: [
        "cash",
        "cryptocurrency",
        "derivative",
        "equity",
        "etf",
        "fixed income",
        "loan",
        "mutual fund",
        "other",
      ],
    },
    {
      name: "quantity",
      type: "DECIMAL(38,8)",
      description: "Units of the security held, exact decimal — when reported",
      nullable: true,
    },
    {
      name: "institution_price",
      type: "DECIMAL(38,8)",
      description: "Per-unit price the institution last reported, exact decimal — when reported",
      nullable: true,
    },
    {
      name: "institution_value",
      type: "DECIMAL(38,2)",
      description: "Market value of the position the institution reported, exact decimal",
      nullable: true,
    },
    {
      name: "cost_basis",
      type: "DECIMAL(38,2)",
      description: "Total cost basis of the position, exact decimal — when reported",
      nullable: true,
    },
    {
      name: "currency",
      type: "VARCHAR",
      description: "ISO currency code (or Plaid unofficial code) of the holding, when reported",
      nullable: true,
    },
  ],
  primaryKey: ["item_id", "account_id", "security_id", "snapshot_date"],
  semanticTimeColumn: "snapshot_date",
  record: {
    titleColumns: ["security_name", "ticker", "quantity"],
    titleTemplate: "{security_name} ({ticker}) × {quantity}",
    keyColumns: ["snapshot_date", "security_id", "quantity", "institution_value", "currency"],
  },
  sharedDiscriminatorColumn: "item_id",
  exampleQueries: [
    "SELECT ticker, security_name, quantity, institution_value FROM plaid_holdings WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM plaid_holdings) ORDER BY institution_value DESC",
    "SELECT snapshot_date, SUM(institution_value) AS portfolio_value FROM plaid_holdings GROUP BY snapshot_date ORDER BY snapshot_date DESC",
    "SELECT ticker, MIN(snapshot_date) AS first_seen, MAX(snapshot_date) AS last_seen FROM plaid_holdings GROUP BY ticker ORDER BY first_seen",
  ],
};

/** Every analytics table this source manages — transactions + the two snapshots. */
export const allSchemas: AnalyticsTableSchema[] = [
  plaidTransactionsSchema,
  plaidBalancesSchema,
  plaidHoldingsSchema,
];
