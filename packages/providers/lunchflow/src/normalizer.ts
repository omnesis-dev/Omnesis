// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure normalization from Lunch Flow API shapes to analytics records and
 * searchable documents. No IO, no clock — everything injected — so the
 * synthetic twin and tests reuse these functions verbatim.
 *
 * Money discipline: amounts are decimal-string carriers end to end. The API
 * serves a JSON number; we stringify and validate `^-?\d+(\.\d+)?$`, preserve
 * the sign exactly as the aggregator reports it (negative = money out — no
 * re-signing), and the gateway casts the quoted literal into DECIMAL(18,4).
 * A malformed amount throws `MalformedRecordError` — the sync loop skips that
 * single record loudly instead of wedging the whole page.
 */

import { createHash } from "node:crypto";
import { computeContentHash } from "@omnesis/core";
import { z } from "zod";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { LunchflowAccount, LunchflowBalance, LunchflowTransaction } from "./types.js";

/** Validated decimal-string carrier for DECIMAL columns. */
const decimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/);

/** A single record failed normalization; the sync loop skips it loudly. */
export class MalformedRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedRecordError";
  }
}

/** The Lunch Flow numeric account id as a string — the identity used everywhere. */
export function accountIdString(account: Pick<LunchflowAccount, "id">): string {
  return String(account.id);
}

/**
 * Normalize a raw amount carrier into a validated decimal string. Absent →
 * null. A leading "+" is stripped. JSON numbers are stringified, then held to
 * the same shape — scientific notation or other artifacts fail loudly rather
 * than reaching DuckDB. The sign is preserved (Lunch Flow already signs the
 * amount: negative for money out).
 */
export function normalizeAmountString(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let s = typeof raw === "number" ? String(raw) : raw.trim();
  if (s.startsWith("+")) s = s.slice(1);
  const parsed = decimalStringSchema.safeParse(s);
  if (!parsed.success) {
    throw new MalformedRecordError(`amount is not a plain decimal (got ${JSON.stringify(s)})`);
  }
  return parsed.data;
}

/** Transaction date (YYYY-MM-DD); throws when the aggregator reported none. */
export function transactionDate(txn: LunchflowTransaction): string {
  const date = txn.date?.slice(0, 10);
  if (!date) throw new MalformedRecordError("transaction has no date");
  return date;
}

/** Trim a string; an empty or whitespace-only value collapses to null (never ""). */
function blankToNull(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t && t.length > 0 ? t : null;
}

function transactionMerchant(txn: LunchflowTransaction): string | null {
  // Some banks (notably SEPA debits via GoCardless) put a multi-line raw
  // statement memo in `merchant` — embedded newlines and reference codes.
  // Collapse internal whitespace runs to single spaces so it reads as a
  // one-line label and never renders a multi-line document title.
  const m = txn.merchant?.replace(/\s+/g, " ").trim();
  return m && m.length > 0 ? m : null;
}

function transactionDescription(txn: LunchflowTransaction): string | null {
  const d = txn.description?.trim();
  return d && d.length > 0 ? d : null;
}

// ── Transaction keys ────────────────────────────────────────────────

/**
 * Stable per-account transaction key:
 *   1. `id` when Lunch Flow provides one (the common case);
 *   2. else `sha256(account_id|date|amount|currency|merchant|description)`
 *      plus `-<occurrenceIndex>` — the duplicate's index within its
 *      identical-tuple group in the fetched window. The window is the whole
 *      date range in one call, so a re-fetch reproduces the same grouping and
 *      indices, keeping the key stable across syncs.
 *
 * Content-hash caveat: an upstream amendment to a hash-keyed transaction
 * (amount or description corrected in place) changes the hash, so the amended
 * row inserts under a new key while the original remains. Inherent to
 * content-hash keys — transactions carrying an `id` are immune.
 *
 * `hashCounts` carries the per-window occurrence counters (only tuples that
 * actually needed the hash fallback) and is mutated in place.
 */
export function computeTransactionKey(
  txn: LunchflowTransaction,
  accountId: string,
  signedAmount: string | null,
  hashCounts: Record<string, number>,
): string {
  if (txn.id) return txn.id;
  const tuple = [
    accountId,
    transactionDate(txn),
    signedAmount ?? "",
    txn.currency ?? "",
    transactionMerchant(txn) ?? "",
    transactionDescription(txn) ?? "",
  ].join("|");
  const hash = createHash("sha256").update(tuple).digest("hex");
  const occurrenceIndex = hashCounts[hash] ?? 0;
  hashCounts[hash] = occurrenceIndex + 1;
  return `${hash}-${occurrenceIndex}`;
}

// ── Account context ─────────────────────────────────────────────────

/** The slice of a connected account needed to normalize its transactions. */
export interface AccountContext {
  id: string;
  name: string | null;
  institutionName: string | null;
  currency: string | null;
}

/** Project a raw API account onto the normalization context. */
export function toAccountContext(account: LunchflowAccount): AccountContext {
  return {
    id: accountIdString(account),
    name: blankToNull(account.name),
    institutionName: account.institution_name ?? null,
    currency: account.currency ?? null,
  };
}

// ── Records ─────────────────────────────────────────────────────────

export interface AccountRecordOptions {
  /**
   * The Omnesis account (Lunch Flow connection) this row belongs to. Distinct
   * from the Lunch Flow bank-account id: several connections can share these
   * tables, and this is what lets one be removed without deleting another's
   * rows.
   */
  sourceAccountId: string;
  syncedAt: string;
  /**
   * Currency to record when the account object itself carries none. Lunch
   * Flow's `GET /accounts` omits currency entirely, so the source derives it
   * from the account's transactions/balance and passes it here; an explicit
   * `account.currency` (other aggregators, or the synthetic twin) still wins.
   */
  currency?: string | null;
}

/** One `lunchflow_accounts` row from a raw API account. */
export function accountToRecord(
  account: LunchflowAccount,
  opts: AccountRecordOptions,
): Record<string, unknown> {
  return {
    account_id: accountIdString(account),
    name: blankToNull(account.name),
    institution_name: account.institution_name ?? null,
    institution_logo: account.institution_logo ?? null,
    provider: account.provider ?? null,
    currency: account.currency ?? opts.currency ?? null,
    status: account.status ?? null,
    synced_at: opts.syncedAt,
    source_account_id: opts.sourceAccountId,
  };
}

export interface BalanceRecordOptions {
  /**
   * The Omnesis account (Lunch Flow connection) this row belongs to. Distinct
   * from the Lunch Flow bank-account id: several connections can share these
   * tables, and this is what lets one be removed without deleting another's
   * rows.
   */
  sourceAccountId: string;
  accountId: string;
  /** UTC date (YYYY-MM-DD) of the fetch — ALWAYS the fetch date, not the bank's. */
  snapshotDate: string;
}

export interface BalanceRecordResult {
  record: Record<string, unknown> | null;
  /** Reason the balance was dropped, if any — the caller logs it. */
  skipped: string | null;
}

/** One `lunchflow_balances` row for an account's balance snapshot. */
export function balanceToRecord(
  balance: LunchflowBalance,
  opts: BalanceRecordOptions,
): BalanceRecordResult {
  let amount: string | null;
  try {
    amount = normalizeAmountString(balance.amount);
  } catch (err) {
    return { record: null, skipped: (err as Error).message };
  }
  if (amount === null) {
    return { record: null, skipped: "no amount reported" };
  }
  return {
    record: {
      snapshot_date: opts.snapshotDate,
      account_id: opts.accountId,
      amount,
      currency: balance.currency ?? null,
      source_account_id: opts.sourceAccountId,
    },
    skipped: null,
  };
}

export interface TransactionRecordOptions {
  /**
   * The Omnesis account (Lunch Flow connection) this row belongs to. Distinct
   * from the Lunch Flow bank-account id: several connections can share these
   * tables, and this is what lets one be removed without deleting another's
   * rows.
   */
  sourceAccountId: string;
  account: AccountContext;
  transactionKey: string;
  signedAmount: string | null;
}

/** One `lunchflow_transactions` row. */
export function transactionToRecord(
  txn: LunchflowTransaction,
  opts: TransactionRecordOptions,
): Record<string, unknown> {
  return {
    transaction_date: transactionDate(txn),
    amount: opts.signedAmount,
    currency: txn.currency ?? opts.account.currency ?? null,
    merchant: transactionMerchant(txn),
    description: transactionDescription(txn),
    institution_name: opts.account.institutionName,
    account_id: opts.account.id,
    transaction_id: txn.id ?? null,
    transaction_key: opts.transactionKey,
    source_account_id: opts.sourceAccountId,
  };
}

/**
 * Searchable document for one transaction. Compact body — merchant,
 * description, signed amount, date, account label.
 */
export function transactionToDocument(
  txn: LunchflowTransaction,
  opts: TransactionRecordOptions & { providerId: ProviderId; sourceId: SourceId },
): DocumentInput {
  const date = transactionDate(txn);
  const merchant = transactionMerchant(txn);
  const description = transactionDescription(txn);
  const currency = txn.currency ?? opts.account.currency ?? "";
  const amountLabel = opts.signedAmount !== null ? `${opts.signedAmount} ${currency}`.trim() : null;
  const accountLabel = [opts.account.institutionName, opts.account.name]
    .filter((part): part is string => Boolean(part))
    .join(" ");

  const title = [merchant ?? description ?? "Transaction", amountLabel]
    .filter((part): part is string => Boolean(part))
    .join(" — ");

  const lines = [
    merchant ? `Merchant: ${merchant}` : null,
    amountLabel ? `Amount: ${amountLabel}` : null,
    `Date: ${date}`,
    description ? `Description: ${description}` : null,
    accountLabel ? `Account: ${accountLabel}` : null,
  ].filter((line): line is string => Boolean(line));
  const content = lines.join("\n");

  const isoDate = `${date}T00:00:00.000Z`;
  return {
    providerId: opts.providerId,
    sourceId: opts.sourceId,
    externalId: `${opts.account.id}:${opts.transactionKey}`,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "transaction",
      tags: ["transaction"],
      extra: {
        accountId: opts.account.id,
        transactionKey: opts.transactionKey,
        institution: opts.account.institutionName ?? undefined,
        currency: txn.currency ?? opts.account.currency ?? undefined,
        merchant: merchant ?? undefined,
      },
    },
    sourceCreatedAt: isoDate,
    sourceUpdatedAt: isoDate,
  };
}

// ── Page processing ─────────────────────────────────────────────────

export interface ProcessTransactionsOptions {
  account: AccountContext;
  /** See `TransactionRecordOptions.sourceAccountId`. */
  sourceAccountId: string;
  providerId: ProviderId;
  sourceId: SourceId;
  /** ISO 8601 — records older than this are skipped (history-import bound). */
  dataCutoff?: string;
  /** Per-window occurrence counters for hash-fallback keys; mutated in place. */
  hashCounts: Record<string, number>;
}

export interface ProcessTransactionsResult {
  records: Record<string, unknown>[];
  documents: DocumentInput[];
  /** Max transaction date among ingested rows, if any. */
  maxDate?: string;
  total: number;
  /** Pending entries dropped (this source ingests booked transactions only). */
  pending: number;
  /** Per-record reasons for anything dropped — the caller logs them loudly. */
  skipped: string[];
}

/**
 * Normalize one window of transactions into records + documents. Pending
 * entries are dropped (the request asks for booked only, but the filter is
 * enforced here too so a non-filtering response can't introduce volatile
 * rows). A record that fails normalization (malformed amount, no date) is
 * reported in `skipped` and dropped — it never wedges the rest of the page.
 */
export function processTransactionsPage(
  transactions: LunchflowTransaction[],
  opts: ProcessTransactionsOptions,
): ProcessTransactionsResult {
  const records: Record<string, unknown>[] = [];
  const documents: DocumentInput[] = [];
  const skipped: string[] = [];
  let maxDate: string | undefined;
  let pending = 0;
  const cutoffDate = opts.dataCutoff?.slice(0, 10);

  for (const txn of transactions) {
    if (txn.isPending === true) {
      pending++;
      continue;
    }
    try {
      const date = transactionDate(txn);
      if (cutoffDate && date < cutoffDate) continue;
      const signedAmount = normalizeAmountString(txn.amount);
      const transactionKey = computeTransactionKey(
        txn,
        opts.account.id,
        signedAmount,
        opts.hashCounts,
      );
      const recordOpts: TransactionRecordOptions = {
        account: opts.account,
        sourceAccountId: opts.sourceAccountId,
        transactionKey,
        signedAmount,
      };
      records.push(transactionToRecord(txn, recordOpts));
      documents.push(
        transactionToDocument(txn, {
          ...recordOpts,
          providerId: opts.providerId,
          sourceId: opts.sourceId,
        }),
      );
      if (!maxDate || date > maxDate) maxDate = date;
    } catch (err) {
      skipped.push(
        `transaction on ${txn.date ?? "<no date>"} (${txn.id ?? "no id"}): ${(err as Error).message}`,
      );
    }
  }

  return { records, documents, maxDate, total: transactions.length, pending, skipped };
}
