// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Boundary schemas for the Lunch Flow API (https://lunchflow.app/docs/api-reference)
 * plus the analytics table schemas this source manages.
 *
 * Lunch Flow is a bank-data aggregator: a single API key fans out to every
 * bank account the user has connected through it (GoCardless, Quiltt, …),
 * across many institutions and countries — including UK banks, which the
 * Enable Banking source cannot reach.
 *
 * Every API response is zod-parsed at the client boundary; the rest of the
 * package works with the inferred types only. The schemas are deliberately
 * lenient (`.passthrough()`, most fields `.nullish()`): the aggregator spans
 * thousands of banks and field presence varies per provider, and the
 * passthrough keeps unknown fields from wedging a sync as the API evolves.
 */

import { z } from "zod";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

// ── API response schemas ────────────────────────────────────────────

/**
 * A connected account. `id` is Lunch Flow's stable numeric account id; the
 * API serves it as a JSON number, but we accept a string too for forward
 * compatibility and normalize to a string everywhere downstream. `provider`
 * is the upstream aggregator (gocardless, quiltt, …) — kept as a plain
 * string so a new upstream variant degrades to data, not a sync failure.
 */
export const lunchflowAccountSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    name: z.string().nullish(),
    institution_name: z.string().nullish(),
    institution_logo: z.string().nullish(),
    provider: z.string().nullish(),
    currency: z.string().nullish(),
    status: z.string().nullish(),
  })
  .passthrough();

/** `GET /accounts` response envelope. */
export const lunchflowAccountsResponseSchema = z
  .object({
    accounts: z.array(lunchflowAccountSchema),
    total: z.number().nullish(),
  })
  .passthrough();

/**
 * One transaction. `id` is nullable — when the aggregator provides one it is
 * the stable per-transaction identity; when absent the normalizer falls back
 * to a content hash. `amount` is a JSON number (a string is tolerated);
 * its sign is preserved as the aggregator reports it (negative = money out).
 */
export const lunchflowTransactionSchema = z
  .object({
    id: z.string().nullish(),
    accountId: z.union([z.number(), z.string()]).nullish(),
    amount: z.union([z.number(), z.string()]).nullish(),
    currency: z.string().nullish(),
    date: z.string().nullish(),
    merchant: z.string().nullish(),
    description: z.string().nullish(),
    isPending: z.boolean().nullish(),
  })
  .passthrough();

/** `GET /accounts/{id}/transactions` response envelope (whole date window — unpaginated). */
export const lunchflowTransactionsResponseSchema = z
  .object({
    transactions: z.array(lunchflowTransactionSchema),
    total: z.number().nullish(),
  })
  .passthrough();

export const lunchflowBalanceSchema = z
  .object({
    amount: z.union([z.number(), z.string()]).nullish(),
    currency: z.string().nullish(),
  })
  .passthrough();

/** `GET /accounts/{id}/balance` response envelope. */
export const lunchflowBalanceResponseSchema = z
  .object({ balance: lunchflowBalanceSchema })
  .passthrough();

// ── Analytics table schemas ─────────────────────────────────────────
//
// Several Lunch Flow connections can share these tables, so each carries a
// `source_account_id` discriminator recording which Omnesis account wrote a
// row — that is what lets one connection be removed without deleting another's
// history. It is deliberately not part of any primary key: those are keyed on
// the Lunch Flow numeric account id, and widening a live table's key is not
// something schema evolution can do.

const OWNED_NOTE =
  "One Lunch Flow connection (API key) fans out across every bank account it " +
  "reaches, keyed by account_id; source_account_id records which connection.";

export const lunchflowAccountsSchema: AnalyticsTableSchema = {
  tableName: "lunchflow_accounts",
  displayName: "Lunch Flow Accounts",
  description: `Bank accounts connected through Lunch Flow. ${OWNED_NOTE}`,
  columns: [
    { name: "account_id", type: "VARCHAR", description: "Lunch Flow numeric account id (stable)" },
    { name: "name", type: "VARCHAR", description: "Account display name", nullable: true },
    {
      name: "institution_name",
      type: "VARCHAR",
      description: "Bank / institution name",
      nullable: true,
    },
    {
      name: "institution_logo",
      type: "VARCHAR",
      description: "Institution logo URL, when provided",
      nullable: true,
    },
    {
      name: "provider",
      type: "VARCHAR",
      description: "Upstream aggregator (gocardless, quiltt, finverse, …)",
      nullable: true,
    },
    { name: "currency", type: "VARCHAR", description: "Account currency", nullable: true },
    {
      name: "status",
      type: "VARCHAR",
      description: "Connection status reported by Lunch Flow (ACTIVE, DISCONNECTED, ERROR)",
      nullable: true,
    },
    {
      name: "synced_at",
      type: "TIMESTAMPTZ",
      description: "When Omnesis last refreshed this row",
      volatile: true,
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      nullable: true,
      sourceColumnId: "omnesis:source_account_id",
      description:
        "Which Omnesis account wrote this row — discriminates sibling connections sharing the table",
    },
  ],
  primaryKey: ["account_id"],
  sharedDiscriminatorColumn: "source_account_id",
  // A profile row with no real-world event instant — synced_at is an ingest
  // timestamp, not semantic time — so it is timeless and never citable as a
  // timeline record.
  semanticTimeColumn: null,
  record: {
    titleColumns: ["name", "institution_name"],
    keyColumns: ["institution_name", "name", "currency", "status"],
  },
  exampleQueries: [
    "SELECT institution_name, name, currency, status FROM lunchflow_accounts ORDER BY institution_name, name",
    "SELECT provider, COUNT(*) AS accounts FROM lunchflow_accounts GROUP BY provider",
    "SELECT a.institution_name, a.name, b.amount, b.currency FROM lunchflow_accounts a JOIN lunchflow_balances b ON b.account_id = a.account_id WHERE b.snapshot_date = (SELECT MAX(snapshot_date) FROM lunchflow_balances)",
  ],
};

export const lunchflowBalancesSchema: AnalyticsTableSchema = {
  tableName: "lunchflow_balances",
  displayName: "Lunch Flow Balances",
  description: `Daily balance snapshots per account. snapshot_date is the UTC date Omnesis fetched the balance ("latest observation that day"). ${OWNED_NOTE}`,
  columns: [
    {
      name: "snapshot_date",
      type: "DATE",
      description: "UTC date the balance was fetched — one row per account per day",
    },
    { name: "account_id", type: "VARCHAR", description: "Lunch Flow numeric account id" },
    { name: "amount", type: "DECIMAL(18,4)", description: "Balance amount (exact decimal)" },
    { name: "currency", type: "VARCHAR", description: "Balance currency", nullable: true },
    {
      name: "source_account_id",
      type: "VARCHAR",
      nullable: true,
      sourceColumnId: "omnesis:source_account_id",
      description:
        "Which Omnesis account wrote this row — discriminates sibling connections sharing the table",
    },
  ],
  primaryKey: ["account_id", "snapshot_date"],
  sharedDiscriminatorColumn: "source_account_id",
  // A daily balance snapshot, dated by the day it represents.
  semanticTimeColumn: "snapshot_date",
  record: {
    titleColumns: ["amount", "currency"],
    titleTemplate: "{amount} {currency}",
    keyColumns: ["snapshot_date", "amount", "currency"],
  },
  exampleQueries: [
    "SELECT snapshot_date, account_id, amount, currency FROM lunchflow_balances ORDER BY snapshot_date, account_id",
    "SELECT account_id, amount, currency FROM lunchflow_balances WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM lunchflow_balances)",
    "SELECT date_trunc('month', snapshot_date) AS month, account_id, MIN(amount) AS low, MAX(amount) AS high FROM lunchflow_balances GROUP BY month, account_id ORDER BY month DESC",
  ],
};

export const lunchflowTransactionsSchema: AnalyticsTableSchema = {
  tableName: "lunchflow_transactions",
  displayName: "Lunch Flow Transactions",
  description: `Booked bank transactions (pending excluded by design) with exact-decimal amounts — the sign is preserved as the aggregator reports it (negative = money out). ${OWNED_NOTE}`,
  columns: [
    { name: "transaction_date", type: "DATE", description: "Transaction date as reported" },
    {
      name: "amount",
      type: "DECIMAL(18,4)",
      description: "Signed amount (exact decimal) — negative for money out, positive for money in",
      nullable: true,
    },
    { name: "currency", type: "VARCHAR", description: "Transaction currency", nullable: true },
    {
      name: "merchant",
      type: "VARCHAR",
      description: "Merchant name, when provided",
      nullable: true,
    },
    {
      name: "description",
      type: "VARCHAR",
      description: "Transaction description, when provided",
      nullable: true,
    },
    {
      name: "institution_name",
      type: "VARCHAR",
      description: "Bank / institution name (denormalized from the account)",
      nullable: true,
    },
    { name: "account_id", type: "VARCHAR", description: "Lunch Flow numeric account id" },
    {
      name: "transaction_id",
      type: "VARCHAR",
      description: "Lunch Flow transaction id when provided (null otherwise — see transaction_key)",
      nullable: true,
    },
    {
      name: "transaction_key",
      type: "VARCHAR",
      description:
        "Stable per-account transaction key: the Lunch Flow transaction id when present, else a " +
        "content hash over date/amount/currency/merchant/description. Content-hash keys carry an " +
        "inherent caveat: an upstream amendment to such a row changes its hash, so the amended " +
        "version inserts as a new row alongside the stale original.",
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      nullable: true,
      sourceColumnId: "omnesis:source_account_id",
      description:
        "Which Omnesis account wrote this row — discriminates sibling connections sharing the table",
    },
  ],
  primaryKey: ["account_id", "transaction_key"],
  sharedDiscriminatorColumn: "source_account_id",
  // A transaction is placed at its reported transaction date.
  semanticTimeColumn: "transaction_date",
  record: {
    titleColumns: ["merchant", "description"],
    keyColumns: ["transaction_date", "amount", "currency", "merchant"],
  },
  // Each row co-describes the transaction document whose externalId is
  // `${account_id}:${transaction_key}` (normalizer.ts) — declare the 1:1
  // doc↔row edge (#450). The gateway reconstructs the externalId by joining
  // these columns with the default ':' separator, so each component must be
  // colon-free for the split to round-trip: account_id is always a numeric
  // string, and transaction_key is either a content hash (`<hex>-<n>`) or the
  // LunchFlow transaction id — which in practice is a colon-free token. (Same
  // invariant the enable-banking source relies on for its account_key:txn_key
  // binding.)
  boundDocument: { externalIdColumns: ["account_id", "transaction_key"] },
  exampleQueries: [
    "SELECT date_trunc('month', transaction_date) AS month, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS spent, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS received FROM lunchflow_transactions GROUP BY month ORDER BY month DESC",
    "SELECT merchant, COUNT(*) AS n, SUM(-amount) AS total_spent FROM lunchflow_transactions WHERE amount < 0 AND merchant IS NOT NULL GROUP BY merchant ORDER BY total_spent DESC LIMIT 20",
    "SELECT transaction_date, merchant, description, amount, currency FROM lunchflow_transactions ORDER BY transaction_date DESC LIMIT 50",
    "SELECT transaction_date, merchant, amount, currency FROM lunchflow_transactions WHERE ABS(amount) > 500 ORDER BY transaction_date DESC",
  ],
};

export const allSchemas = [
  lunchflowAccountsSchema,
  lunchflowBalancesSchema,
  lunchflowTransactionsSchema,
];
