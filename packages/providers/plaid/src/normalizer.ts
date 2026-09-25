// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure normalization from Plaid `/transactions/sync` shapes to analytics
 * records and searchable documents. No IO, no clock — everything injected — so
 * the synthetic twin and tests reuse these functions verbatim.
 *
 * Money discipline: Plaid serves `amount` as a JSON number where **positive =
 * money OUT** of the account (a purchase) and negative = money in — the inverse
 * of the bank-statement convention every other Omnesis money table uses. The
 * normalizer therefore NEGATES Plaid's sign so `plaid_transactions.amount`
 * reads negative-for-debit like `bank_transactions`, and renders the result as
 * an exact 2-scale decimal string via `decimalFromNumberOrNull` (never a fresh
 * float op) so `SUM()` over the column never drifts cents.
 */

import { computeContentHash } from "@omnesis/core";
import { decimalFromNumberOrNull, MONEY_SCALE } from "./decimal.js";
import type {
  PlaidBalanceAccount,
  PlaidHolding,
  PlaidSecurity,
  PlaidTransaction,
} from "./schemas.js";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

/** Scale for security quantities and per-unit prices — Plaid serves up to 8 dp. */
export const QUANTITY_SCALE = 8;

/**
 * Flip Plaid's sign to the bank-statement convention (negative = money out) and
 * render as an exact decimal string. A non-finite amount maps to null (it must
 * never reach DuckDB as `NaN`); `-0` is normalized to `0`.
 */
export function signedTransactionAmount(txn: PlaidTransaction): string | null {
  const flipped = decimalFromNumberOrNull(-txn.amount);
  // `-0` → `decimalFromNumberOrNull` already collapses "-0.00" to "0.00".
  return flipped;
}

/** ISO currency code, falling back to Plaid's unofficial code, else null. */
export function transactionCurrency(txn: PlaidTransaction): string | null {
  return txn.iso_currency_code ?? txn.unofficial_currency_code ?? null;
}

/** Primary personal-finance category when Plaid classified the transaction. */
function transactionCategory(txn: PlaidTransaction): string | null {
  return txn.personal_finance_category?.primary ?? null;
}

export interface TransactionRecordOptions {
  itemId: string;
}

/** One `plaid_transactions` row from a Plaid transaction. */
export function transactionToRecord(
  txn: PlaidTransaction,
  opts: TransactionRecordOptions,
): Record<string, unknown> {
  return {
    transaction_id: txn.transaction_id,
    item_id: opts.itemId,
    account_id: txn.account_id,
    date: txn.date,
    datetime: txn.datetime ?? null,
    amount: signedTransactionAmount(txn),
    currency: transactionCurrency(txn),
    name: txn.name ?? null,
    merchant_name: txn.merchant_name ?? null,
    category: transactionCategory(txn),
    payment_channel: txn.payment_channel ?? null,
    pending: txn.pending ?? false,
    pending_transaction_id: txn.pending_transaction_id ?? null,
  };
}

export interface TransactionDocumentOptions extends TransactionRecordOptions {
  providerId: ProviderId;
  sourceId: SourceId;
  /** Institution display name for the account label, when known. */
  institutionName?: string;
}

/**
 * Searchable document for one transaction. Compact body — merchant/name, signed
 * amount, date, category, institution label. No account numbers ever reach a
 * document body. The externalId is `${item_id}:${transaction_id}` so the 1:1
 * doc↔row binding (#450) splits cleanly back into the composite primary key.
 */
export function transactionToDocument(
  txn: PlaidTransaction,
  opts: TransactionDocumentOptions,
): DocumentInput {
  const signed = signedTransactionAmount(txn);
  const currency = transactionCurrency(txn);
  const merchant = txn.merchant_name ?? txn.name ?? null;
  const amountLabel = signed !== null ? `${signed} ${currency ?? ""}`.trim() : null;

  const title = [merchant ?? "Bank transaction", amountLabel]
    .filter((part): part is string => Boolean(part))
    .join(" — ");

  const lines = [
    merchant ? `Merchant: ${merchant}` : null,
    amountLabel ? `Amount: ${amountLabel}` : null,
    `Date: ${txn.date}`,
    txn.personal_finance_category?.primary
      ? `Category: ${txn.personal_finance_category.primary}`
      : null,
    txn.pending ? "Status: pending" : null,
    opts.institutionName ? `Account: ${opts.institutionName}` : null,
  ].filter((line): line is string => Boolean(line));
  const content = lines.join("\n");

  const iso = txn.datetime ?? `${txn.date}T00:00:00.000Z`;
  return {
    providerId: opts.providerId,
    sourceId: opts.sourceId,
    externalId: `${opts.itemId}:${txn.transaction_id}`,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "transaction",
      tags: ["transaction"],
      // Exactly the fields the source's document-event profile declares, so a
      // watch can predicate on any of them. The item and transaction ids are
      // deliberately absent: the externalId already carries both, and the
      // analytics row is bound to this document by them.
      extra: {
        merchantName: merchant ?? undefined,
        category: transactionCategory(txn) ?? undefined,
        paymentChannel: txn.payment_channel ?? undefined,
        pending: txn.pending ?? false,
        currency: currency ?? undefined,
        accountId: txn.account_id,
      },
    },
    sourceCreatedAt: iso,
    sourceUpdatedAt: iso,
  };
}

export interface ProcessTransactionsOptions extends TransactionDocumentOptions {
  /** ISO 8601 — transactions dated before this are skipped (history-import bound). */
  dataCutoff?: string;
}

export interface ProcessTransactionsResult {
  records: Record<string, unknown>[];
  documents: DocumentInput[];
}

/**
 * Normalize a batch of added/modified transactions into records + co-emitted
 * documents, dropping anything before `dataCutoff`. `added` and `modified` are
 * processed identically — both upsert by the composite primary key, so a
 * `modified` row simply overwrites the prior version.
 */
export function processTransactions(
  transactions: PlaidTransaction[],
  opts: ProcessTransactionsOptions,
): ProcessTransactionsResult {
  const records: Record<string, unknown>[] = [];
  const documents: DocumentInput[] = [];
  const cutoffDate = opts.dataCutoff?.slice(0, 10);

  for (const txn of transactions) {
    if (cutoffDate && txn.date < cutoffDate) continue;
    records.push(transactionToRecord(txn, opts));
    documents.push(transactionToDocument(txn, opts));
  }
  return { records, documents };
}

// ── Balances snapshot ───────────────────────────────────────────────

/** ISO currency code of a balance block, falling back to Plaid's unofficial code. */
function balanceCurrency(account: PlaidBalanceAccount): string | null {
  return account.balances.iso_currency_code ?? account.balances.unofficial_currency_code ?? null;
}

/**
 * One `plaid_balances` snapshot row for one account on the pinned UTC day.
 * Balances are NOT sign-flipped: Plaid reports them in the bank's own
 * convention (a deposit balance is positive, a credit-card `current` is the
 * amount owed). Exact decimals via `decimalFromNumberOrNull`; a null figure
 * stays null (never `NaN`). Snapshots are append-only — this row only ever
 * upserts by `(item_id, account_id, snapshot_date)`, never deletes.
 */
export function balanceAccountToRecord(
  account: PlaidBalanceAccount,
  opts: { itemId: string; snapshotDate: string },
): Record<string, unknown> {
  return {
    snapshot_date: opts.snapshotDate,
    item_id: opts.itemId,
    account_id: account.account_id,
    account_name: account.name ?? account.official_name ?? null,
    account_type: account.type ?? null,
    account_subtype: account.subtype ?? null,
    available: decimalFromNumberOrNull(account.balances.available, MONEY_SCALE),
    current: decimalFromNumberOrNull(account.balances.current, MONEY_SCALE),
    credit_limit: decimalFromNumberOrNull(account.balances.limit, MONEY_SCALE),
    currency: balanceCurrency(account),
  };
}

/** Snapshot rows for every account in an `/accounts/get` response. */
export function balanceAccountsToRecords(
  accounts: PlaidBalanceAccount[],
  opts: { itemId: string; snapshotDate: string },
): Record<string, unknown>[] {
  return accounts.map((account) => balanceAccountToRecord(account, opts));
}

// ── Holdings snapshot ───────────────────────────────────────────────

/** ISO currency code of a holding, falling back to Plaid's unofficial code. */
function holdingCurrency(holding: PlaidHolding): string | null {
  return holding.iso_currency_code ?? holding.unofficial_currency_code ?? null;
}

/**
 * One `plaid_holdings` snapshot row for one position on the pinned UTC day.
 * `security` is the resolved security from the response's `securities` array
 * (joined by `security_id`); when absent the display columns stay null but the
 * position is still recorded. Quantities/prices carry at scale 8, values/cost
 * basis at money scale — all exact, null-preserving. Append-only by
 * `(item_id, account_id, security_id, snapshot_date)`; never deletes.
 */
export function holdingToRecord(
  holding: PlaidHolding,
  security: PlaidSecurity | undefined,
  opts: { itemId: string; snapshotDate: string },
): Record<string, unknown> {
  return {
    snapshot_date: opts.snapshotDate,
    item_id: opts.itemId,
    account_id: holding.account_id,
    security_id: holding.security_id,
    ticker: security?.ticker_symbol ?? null,
    security_name: security?.name ?? null,
    security_type: security?.type ?? null,
    quantity: decimalFromNumberOrNull(holding.quantity, QUANTITY_SCALE),
    institution_price: decimalFromNumberOrNull(holding.institution_price, QUANTITY_SCALE),
    institution_value: decimalFromNumberOrNull(holding.institution_value, MONEY_SCALE),
    cost_basis: decimalFromNumberOrNull(holding.cost_basis, MONEY_SCALE),
    currency: holdingCurrency(holding),
  };
}

/**
 * Snapshot rows for every holding in an `/investments/holdings/get` response,
 * resolving each holding's security from the response's `securities` array.
 */
export function holdingsToRecords(
  holdings: PlaidHolding[],
  securities: PlaidSecurity[],
  opts: { itemId: string; snapshotDate: string },
): Record<string, unknown>[] {
  const byId = new Map(securities.map((s) => [s.security_id, s]));
  return holdings.map((h) => holdingToRecord(h, byId.get(h.security_id), opts));
}
