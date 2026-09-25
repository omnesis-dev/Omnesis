// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Boundary schemas for the Enable Banking API (https://enablebanking.com/docs/api/reference/)
 * plus the analytics table schemas this source manages.
 *
 * Every API response is zod-parsed at the client boundary — the rest of the
 * package works with the inferred types only. The schemas are deliberately
 * lenient (`.passthrough()`, most fields `.nullish()`): Enable Banking
 * aggregates 2,500+ banks and field presence varies per ASPSP, while the
 * passthrough keeps unknown fields intact so raw pages cached during the
 * authorization-time full-history prefetch lose no fidelity.
 */

import { z } from "zod";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

// ── API response schemas ────────────────────────────────────────────

/**
 * Berlin-Group style amount carrier. The spec types `amount` as a string;
 * a few ASPSP integrations have been observed emitting JSON numbers, so we
 * accept both here and let the normalizer convert + validate the decimal
 * shape (`^-?\d+(\.\d+)?$`) — anything else fails loudly per record.
 */
export const ebAmountSchema = z
  .object({
    currency: z.string().nullish(),
    amount: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

export const ebGenericIdSchema = z
  .object({
    identification: z.string().nullish(),
    scheme_name: z.string().nullish(),
  })
  .passthrough();

export const ebAspspSchema = z
  .object({
    name: z.string(),
    country: z.string(),
    logo: z.string().nullish(),
    psu_types: z.array(z.string()).nullish(),
    maximum_consent_validity: z.number().nullish(),
    beta: z.boolean().nullish(),
    bic: z.string().nullish(),
  })
  .passthrough();

/** `GET /aspsps` response envelope. */
export const ebAspspsResponseSchema = z.object({ aspsps: z.array(ebAspspSchema) }).passthrough();

/** `POST /auth` response — the URL the user opens to perform SCA. */
export const ebAuthStartResponseSchema = z
  .object({
    url: z.string(),
    authorization_id: z.string().nullish(),
    psu_id_hash: z.string().nullish(),
  })
  .passthrough();

/**
 * Account object inside the `POST /sessions` response. `identification_hash`
 * is the cross-session stable identity Enable Banking computes for the
 * underlying bank account; `uid` is the session-scoped API handle that
 * changes on every re-consent.
 */
export const ebSessionAccountSchema = z
  .object({
    uid: z.string().nullish(),
    identification_hash: z.string().nullish(),
    identification_hashes: z.array(z.string()).nullish(),
    account_id: z
      .object({ iban: z.string().nullish(), other: ebGenericIdSchema.nullish() })
      .passthrough()
      .nullish(),
    all_account_ids: z.array(ebGenericIdSchema).nullish(),
    name: z.string().nullish(),
    details: z.string().nullish(),
    usage: z.string().nullish(),
    cash_account_type: z.string().nullish(),
    product: z.string().nullish(),
    currency: z.string().nullish(),
  })
  .passthrough();

/** `POST /sessions` response envelope. */
export const ebSessionResponseSchema = z
  .object({
    session_id: z.string(),
    accounts: z.array(ebSessionAccountSchema),
    aspsp: z.object({ name: z.string(), country: z.string() }).passthrough().nullish(),
    access: z.object({ valid_until: z.string().nullish() }).passthrough().nullish(),
    psu_type: z.string().nullish(),
  })
  .passthrough();

export const ebBalanceSchema = z
  .object({
    name: z.string().nullish(),
    balance_amount: ebAmountSchema.nullish(),
    balance_type: z.string().nullish(),
    reference_date: z.string().nullish(),
    last_change_date_time: z.string().nullish(),
    last_committed_transaction: z.string().nullish(),
  })
  .passthrough();

/** `GET /accounts/{uid}/balances` response envelope. */
export const ebBalancesResponseSchema = z
  .object({ balances: z.array(ebBalanceSchema) })
  .passthrough();

export const ebCounterpartySchema = z.object({ name: z.string().nullish() }).passthrough();

export const ebCounterpartyAccountSchema = z.object({ iban: z.string().nullish() }).passthrough();

export const ebTransactionSchema = z
  .object({
    entry_reference: z.string().nullish(),
    transaction_id: z.string().nullish(),
    booking_date: z.string().nullish(),
    value_date: z.string().nullish(),
    transaction_date: z.string().nullish(),
    transaction_amount: ebAmountSchema.nullish(),
    credit_debit_indicator: z.string().nullish(),
    status: z.string().nullish(),
    debtor: ebCounterpartySchema.nullish(),
    debtor_account: ebCounterpartyAccountSchema.nullish(),
    creditor: ebCounterpartySchema.nullish(),
    creditor_account: ebCounterpartyAccountSchema.nullish(),
    remittance_information: z.array(z.string()).nullish(),
    merchant_category_code: z.string().nullish(),
    bank_transaction_code: z
      .object({
        description: z.string().nullish(),
        code: z.string().nullish(),
        sub_code: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    note: z.string().nullish(),
  })
  .passthrough();

/** `GET /accounts/{uid}/transactions` response envelope (one page). */
export const ebTransactionsPageSchema = z
  .object({
    transactions: z.array(ebTransactionSchema),
    continuation_key: z.string().nullish(),
  })
  .passthrough();

// ── Local persistence schemas ───────────────────────────────────────

/**
 * Shape of `session.json` under `<configDir>/enable-banking/<accountId>/`.
 * `account_key` is the stable identity (Enable Banking's
 * `identification_hash`); `uid` is the transient per-session API handle,
 * re-mapped from `account_key` whenever the session is recreated.
 */
export const storedSessionAccountSchema = z.object({
  account_key: z.string(),
  uid: z.string(),
  iban: z.string().nullable(),
  currency: z.string().nullable(),
  name: z.string().nullable(),
  cash_account_type: z.string().nullable(),
  product: z.string().nullable(),
});

export const storedSessionSchema = z.object({
  session_id: z.string(),
  valid_until: z.string(),
  aspsp: z.object({ name: z.string(), country: z.string() }),
  accounts: z.array(storedSessionAccountSchema),
});

// ── Analytics table schemas ─────────────────────────────────────────
//
// All three tables are shared across sibling enable-banking-accounts
// instances (one per connected bank), discriminated by `source_account_id`
// — exactly the accountId slug (e.g. "revolut-de"). On source removal the
// gateway deletes WHERE source_account_id = <accountId> instead of
// dropping the table, so other connected banks keep their rows.

const SHARED_NOTE =
  "Owned by the enable-banking-accounts source; shared across connected banks and " +
  "discriminated by source_account_id.";

export const bankAccountsSchema: AnalyticsTableSchema = {
  tableName: "bank_accounts",
  displayName: "Bank Accounts",
  description: `Bank accounts connected through Enable Banking open banking. ${SHARED_NOTE}`,
  columns: [
    {
      name: "account_key",
      type: "VARCHAR",
      description:
        "Stable account identity (Enable Banking identification_hash) — survives re-consent",
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      description: "Connected-bank instance slug (e.g. revolut-de)",
    },
    { name: "name", type: "VARCHAR", description: "Account display name", nullable: true },
    { name: "currency", type: "VARCHAR", description: "Account currency", nullable: true },
    {
      name: "cash_account_type",
      type: "VARCHAR",
      description: "ISO 20022 cash account type (CACC, CARD, …)",
      nullable: true,
    },
    {
      name: "iban_masked",
      type: "VARCHAR",
      description: "Masked IBAN — country code + last 4 digits",
      nullable: true,
      sensitive: true,
    },
    { name: "bank_name", type: "VARCHAR", description: "Bank (ASPSP) display name" },
    { name: "country", type: "VARCHAR", description: "Bank country code (ISO 3166-1 alpha-2)" },
    {
      name: "uid",
      type: "VARCHAR",
      description: "Session-scoped Enable Banking API handle — refreshed on every re-consent",
      nullable: true,
    },
    {
      name: "synced_at",
      type: "TIMESTAMPTZ",
      description: "When Omnesis last refreshed this row",
      volatile: true,
    },
  ],
  primaryKey: ["account_key"],
  // A profile row with no real-world event instant — synced_at is an ingest
  // timestamp, not semantic time — so it is timeless and never citable as a
  // timeline record.
  semanticTimeColumn: null,
  record: {
    titleColumns: ["name", "bank_name"],
    keyColumns: ["bank_name", "name", "currency", "cash_account_type"],
  },
  sharedDiscriminatorColumn: "source_account_id",
  exampleQueries: [
    "SELECT bank_name, name, currency, cash_account_type FROM bank_accounts ORDER BY bank_name, name",
    "SELECT bank_name, COUNT(*) AS accounts FROM bank_accounts GROUP BY bank_name",
    "SELECT a.bank_name, a.name, b.amount, b.currency FROM bank_accounts a JOIN bank_balances b ON b.account_key = a.account_key WHERE b.snapshot_date = (SELECT MAX(snapshot_date) FROM bank_balances)",
  ],
};

export const bankBalancesSchema: AnalyticsTableSchema = {
  tableName: "bank_balances",
  displayName: "Bank Balances",
  description: `Daily balance snapshots per account and balance type. snapshot_date is the UTC date Omnesis fetched the balance ("latest observation that day"). ${SHARED_NOTE}`,
  columns: [
    {
      name: "snapshot_date",
      type: "DATE",
      description: "UTC date the balance was fetched — one row per account/type/day",
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      description: "Connected-bank instance slug (e.g. revolut-de)",
    },
    { name: "account_key", type: "VARCHAR", description: "Stable account identity" },
    {
      name: "balance_type",
      type: "VARCHAR",
      description:
        "Balance type reported by the bank (CLBD closing booked, ITAV interim available, …)",
    },
    { name: "amount", type: "DECIMAL(18,4)", description: "Balance amount (exact decimal)" },
    { name: "currency", type: "VARCHAR", description: "Balance currency", nullable: true },
    {
      name: "reference_date",
      type: "DATE",
      description: "Bank-reported reference date for the balance, when provided",
      nullable: true,
    },
  ],
  primaryKey: ["account_key", "balance_type", "snapshot_date"],
  // A daily balance snapshot, dated by the day it represents.
  semanticTimeColumn: "snapshot_date",
  record: {
    titleColumns: ["balance_type", "amount"],
    titleTemplate: "{balance_type} {amount}",
    keyColumns: ["snapshot_date", "balance_type", "amount", "currency"],
  },
  sharedDiscriminatorColumn: "source_account_id",
  exampleQueries: [
    "SELECT snapshot_date, account_key, amount, currency FROM bank_balances WHERE balance_type = 'CLBD' ORDER BY snapshot_date, account_key",
    "SELECT account_key, balance_type, amount, currency FROM bank_balances WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM bank_balances)",
    "SELECT date_trunc('month', snapshot_date) AS month, account_key, MIN(amount) AS low, MAX(amount) AS high FROM bank_balances WHERE balance_type = 'CLBD' GROUP BY month, account_key ORDER BY month DESC",
  ],
};

export const bankTransactionsSchema: AnalyticsTableSchema = {
  tableName: "bank_transactions",
  displayName: "Bank Transactions",
  description: `Booked bank transactions (pending excluded by design) with signed exact-decimal amounts — negative = money out. ${SHARED_NOTE}`,
  columns: [
    { name: "booking_date", type: "DATE", description: "Date the transaction was booked" },
    {
      name: "value_date",
      type: "DATE",
      description: "Value date, when reported",
      nullable: true,
    },
    {
      name: "amount",
      type: "DECIMAL(18,4)",
      description: "Signed amount (exact decimal) — negative for debits, positive for credits",
      nullable: true,
    },
    { name: "currency", type: "VARCHAR", description: "Transaction currency", nullable: true },
    {
      name: "status",
      type: "VARCHAR",
      description: "Transaction status as reported (BOOK)",
      nullable: true,
    },
    {
      name: "counterparty_name",
      type: "VARCHAR",
      description: "Other party — creditor for debits, debtor for credits",
      nullable: true,
    },
    {
      name: "counterparty_iban_masked",
      type: "VARCHAR",
      description: "Masked counterparty IBAN — country code + last 4 digits",
      nullable: true,
      sensitive: true,
    },
    {
      name: "description",
      type: "VARCHAR",
      description: "Joined remittance information",
      nullable: true,
    },
    { name: "bank_name", type: "VARCHAR", description: "Bank (ASPSP) display name" },
    {
      name: "source_account_id",
      type: "VARCHAR",
      description: "Connected-bank instance slug (e.g. revolut-de)",
    },
    { name: "account_key", type: "VARCHAR", description: "Stable account identity" },
    {
      name: "transaction_key",
      type: "VARCHAR",
      description:
        "Stable per-account transaction key (entry_reference, else transaction_id, else a content " +
        "hash over date/amount/currency/description/counterparty). Content-hash keys carry an " +
        "inherent caveat: a bank-side amendment to such a row changes its hash, so the amended " +
        "version inserts as a new row alongside the stale original.",
    },
  ],
  primaryKey: ["account_key", "transaction_key"],
  // A transaction is placed at its booking date (the bank-settled day).
  semanticTimeColumn: "booking_date",
  record: {
    titleColumns: ["counterparty_name", "description"],
    keyColumns: ["booking_date", "amount", "currency", "counterparty_name"],
  },
  sharedDiscriminatorColumn: "source_account_id",
  // Each row co-describes the transaction document whose externalId is
  // `${account_key}:${transaction_key}` (normalizer.ts) — declare the 1:1
  // doc↔row edge. Neither key component contains the ':' separator, so
  // the composite externalId splits cleanly back into the primary key.
  boundDocument: { externalIdColumns: ["account_key", "transaction_key"] },
  exampleQueries: [
    "SELECT date_trunc('month', booking_date) AS month, SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS spent, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS received FROM bank_transactions GROUP BY month ORDER BY month DESC",
    "SELECT counterparty_name, COUNT(*) AS n, SUM(-amount) AS total_spent FROM bank_transactions WHERE amount < 0 GROUP BY counterparty_name ORDER BY total_spent DESC LIMIT 20",
    "SELECT booking_date, counterparty_name, amount, currency, description FROM bank_transactions ORDER BY booking_date DESC LIMIT 50",
    "SELECT booking_date, counterparty_name, amount, currency FROM bank_transactions WHERE ABS(amount) > 500 ORDER BY booking_date DESC",
  ],
};

export const allSchemas = [bankAccountsSchema, bankBalancesSchema, bankTransactionsSchema];
