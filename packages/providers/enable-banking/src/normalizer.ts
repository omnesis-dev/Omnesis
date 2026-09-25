// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure normalization from Enable Banking API shapes to analytics records and
 * searchable documents. No IO, no clock — everything injected — so the
 * synthetic twin and tests reuse these functions verbatim.
 *
 * Money discipline: amounts are string carriers end to end. The API serves
 * decimal strings; we validate `^-?\d+(\.\d+)?$`, apply the sign at the
 * STRING level from `credit_debit_indicator` (never a float round-trip),
 * and the gateway casts the quoted literal exactly into DECIMAL(18,4).
 * A malformed amount throws `MalformedRecordError` — the sync loop skips
 * that single record loudly instead of wedging the whole chunk.
 */

import { createHash } from "node:crypto";
import { computeContentHash } from "@omnesis/core";
import { z } from "zod";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { EbBalance, EbTransaction, StoredSessionAccount } from "./types.js";

/** Validated decimal-string carrier for DECIMAL columns. */
const decimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/);

/**
 * The only transaction status this source ingests. The request already asks
 * for `transaction_status=BOOK`, but PSD2 aggregator filtering is
 * bank-dependent — `processTransactionsPage` enforces it on the response
 * path too, so a pending entry from a non-filtering bank can never become a
 * duplicate row once it books under a different entry_reference.
 */
export const BOOKED_STATUS = "BOOK";

/** A single record failed normalization; the sync loop skips it loudly. */
export class MalformedRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedRecordError";
  }
}

/**
 * Normalize a raw amount carrier into a validated decimal string.
 * Absent → null. A leading "+" is stripped. JSON numbers (a few ASPSPs
 * emit them) are stringified, then held to the same shape — scientific
 * notation or other artifacts fail loudly rather than reaching DuckDB.
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

/**
 * Signed transaction amount: banks report a positive magnitude plus
 * `credit_debit_indicator`; a DBIT (money out) gets a string-level "-"
 * unless the bank already signed it. CRDT and unknown indicators keep the
 * normalized magnitude as-is.
 */
export function signedTransactionAmount(txn: EbTransaction): string | null {
  const normalized = normalizeAmountString(txn.transaction_amount?.amount);
  if (normalized === null) return null;
  if (txn.credit_debit_indicator === "DBIT" && !normalized.startsWith("-")) {
    return `-${normalized}`;
  }
  return normalized;
}

/** Mask an IBAN to country code + last 4 — never store or render it whole. */
export function maskIban(iban: string | null | undefined): string | null {
  if (!iban) return null;
  const compact = iban.replace(/\s+/g, "");
  if (compact.length < 8) return `${compact.slice(0, 2)}…`;
  return `${compact.slice(0, 2)}…${compact.slice(-4)}`;
}

/** Booking date with fallbacks; throws when the bank reported no date at all. */
export function transactionBookingDate(txn: EbTransaction): string {
  const date = txn.booking_date ?? txn.value_date ?? txn.transaction_date;
  if (!date) throw new MalformedRecordError("transaction has no booking/value/transaction date");
  return date;
}

/** Counterparty resolution: money out → creditor; money in → debtor. */
function counterparty(txn: EbTransaction): { name: string | null; iban: string | null } {
  const fromCreditor = {
    name: txn.creditor?.name ?? null,
    iban: txn.creditor_account?.iban ?? null,
  };
  const fromDebtor = { name: txn.debtor?.name ?? null, iban: txn.debtor_account?.iban ?? null };
  if (txn.credit_debit_indicator === "DBIT") return fromCreditor;
  if (txn.credit_debit_indicator === "CRDT") return fromDebtor;
  return fromCreditor.name !== null || fromCreditor.iban !== null ? fromCreditor : fromDebtor;
}

function transactionDescription(txn: EbTransaction): string | null {
  const joined = (txn.remittance_information ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("; ");
  return joined.length > 0 ? joined : null;
}

// ── Transaction keys ────────────────────────────────────────────────

/**
 * Stable per-account transaction key:
 *   1. `entry_reference` when the bank provides one;
 *   2. else `transaction_id`;
 *   3. else `sha256(account_key|booking_date|amount|currency|description|`
 *      `counterparty_name|counterparty_iban_masked)` plus
 *      `-<occurrenceIndex>` — the duplicate's index within its
 *      identical-tuple group in the fetched window. Windows are day-aligned
 *      so a re-fetch reproduces the same grouping and indices. The
 *      counterparty fields keep same-day, same-amount twins to different
 *      parties out of one ambiguous occurrence group.
 *
 * Content-hash caveat: an amendment to a hash-keyed transaction (the bank
 * correcting amount or description in place) changes the hash, so the
 * amended row inserts under a new key while the original remains until the
 * incremental overlap window passes it by. Inherent to content-hash keys —
 * banks providing entry_reference/transaction_id are immune.
 *
 * `hashCounts` carries the per-window occurrence counters (only tuples that
 * actually needed the hash fallback) and is mutated in place.
 */
export function computeTransactionKey(
  txn: EbTransaction,
  accountKey: string,
  signedAmount: string | null,
  hashCounts: Record<string, number>,
): string {
  if (txn.entry_reference) return txn.entry_reference;
  if (txn.transaction_id) return txn.transaction_id;
  const cp = counterparty(txn);
  const tuple = [
    accountKey,
    transactionBookingDate(txn),
    signedAmount ?? "",
    txn.transaction_amount?.currency ?? "",
    transactionDescription(txn) ?? "",
    cp.name ?? "",
    maskIban(cp.iban) ?? "",
  ].join("|");
  const hash = createHash("sha256").update(tuple).digest("hex");
  const occurrenceIndex = hashCounts[hash] ?? 0;
  hashCounts[hash] = occurrenceIndex + 1;
  return `${hash}-${occurrenceIndex}`;
}

// ── Records ─────────────────────────────────────────────────────────

export interface AccountRecordOptions {
  sourceAccountId: string;
  bankName: string;
  country: string;
  syncedAt: string;
}

/** One `bank_accounts` row from a stored session account. */
export function accountToRecord(
  account: StoredSessionAccount,
  opts: AccountRecordOptions,
): Record<string, unknown> {
  return {
    account_key: account.account_key,
    source_account_id: opts.sourceAccountId,
    name: account.name,
    currency: account.currency,
    cash_account_type: account.cash_account_type,
    iban_masked: maskIban(account.iban),
    bank_name: opts.bankName,
    country: opts.country,
    uid: account.uid,
    synced_at: opts.syncedAt,
  };
}

export interface BalanceRecordsOptions {
  accountKey: string;
  sourceAccountId: string;
  /** UTC date (YYYY-MM-DD) of the fetch — ALWAYS the fetch date, not the bank's. */
  snapshotDate: string;
}

export interface BalanceRecordsResult {
  records: Record<string, unknown>[];
  /** Per-entry reasons for anything dropped — the caller logs them. */
  skipped: string[];
}

/**
 * `bank_balances` rows for one account's balance fetch. When the bank
 * reports several entries of the same `balance_type` (the PK), the one
 * with the latest `reference_date` wins; entries without a reference_date
 * rank lowest; ties keep the first encountered — deterministic.
 */
export function balancesToRecords(
  balances: EbBalance[],
  opts: BalanceRecordsOptions,
): BalanceRecordsResult {
  const skipped: string[] = [];
  const byType = new Map<string, EbBalance>();
  for (const entry of balances) {
    const type = entry.balance_type ?? entry.name ?? "unknown";
    const existing = byType.get(type);
    if (!existing) {
      byType.set(type, entry);
      continue;
    }
    const a = existing.reference_date ?? "";
    const b = entry.reference_date ?? "";
    if (b > a) byType.set(type, entry);
  }

  const records: Record<string, unknown>[] = [];
  for (const [type, entry] of byType) {
    let amount: string | null;
    try {
      amount = normalizeAmountString(entry.balance_amount?.amount);
    } catch (err) {
      skipped.push(`balance ${type}: ${(err as Error).message}`);
      continue;
    }
    if (amount === null) {
      skipped.push(`balance ${type}: no amount reported`);
      continue;
    }
    records.push({
      snapshot_date: opts.snapshotDate,
      source_account_id: opts.sourceAccountId,
      account_key: opts.accountKey,
      balance_type: type,
      amount,
      currency: entry.balance_amount?.currency ?? null,
      reference_date: entry.reference_date ?? null,
    });
  }
  return { records, skipped };
}

export interface TransactionRecordOptions {
  accountKey: string;
  sourceAccountId: string;
  bankName: string;
  transactionKey: string;
  signedAmount: string | null;
}

/** One `bank_transactions` row. */
export function transactionToRecord(
  txn: EbTransaction,
  opts: TransactionRecordOptions,
): Record<string, unknown> {
  const cp = counterparty(txn);
  return {
    booking_date: transactionBookingDate(txn),
    value_date: txn.value_date ?? null,
    amount: opts.signedAmount,
    currency: txn.transaction_amount?.currency ?? null,
    status: txn.status ?? null,
    counterparty_name: cp.name,
    counterparty_iban_masked: maskIban(cp.iban),
    description: transactionDescription(txn),
    bank_name: opts.bankName,
    source_account_id: opts.sourceAccountId,
    account_key: opts.accountKey,
    transaction_key: opts.transactionKey,
  };
}

export interface TransactionDocumentOptions extends TransactionRecordOptions {
  providerId: ProviderId;
  sourceId: SourceId;
  accountName: string | null;
}

/**
 * Searchable document for one transaction. Compact body — counterparty,
 * signed amount, date, description, account label. Deliberately NO IBANs
 * (masked or otherwise) in document bodies.
 */
export function transactionToDocument(
  txn: EbTransaction,
  opts: TransactionDocumentOptions,
): DocumentInput {
  const bookingDate = transactionBookingDate(txn);
  const cp = counterparty(txn);
  const description = transactionDescription(txn);
  const amountLabel =
    opts.signedAmount !== null
      ? `${opts.signedAmount} ${txn.transaction_amount?.currency ?? ""}`.trim()
      : null;
  const accountLabel = opts.accountName ? `${opts.bankName} ${opts.accountName}` : opts.bankName;

  const title = [cp.name ?? description ?? "Bank transaction", amountLabel]
    .filter((part): part is string => Boolean(part))
    .join(" — ");

  const lines = [
    cp.name ? `Counterparty: ${cp.name}` : null,
    amountLabel ? `Amount: ${amountLabel}` : null,
    `Date: ${bookingDate}`,
    description ? `Description: ${description}` : null,
    `Account: ${accountLabel}`,
  ].filter((line): line is string => Boolean(line));
  const content = lines.join("\n");

  const isoDate = `${bookingDate}T00:00:00.000Z`;
  return {
    providerId: opts.providerId,
    sourceId: opts.sourceId,
    externalId: `${opts.accountKey}:${opts.transactionKey}`,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "transaction",
      tags: ["transaction"],
      extra: {
        accountKey: opts.accountKey,
        transactionKey: opts.transactionKey,
        bankName: opts.bankName,
        currency: txn.transaction_amount?.currency ?? undefined,
      },
    },
    sourceCreatedAt: isoDate,
    sourceUpdatedAt: isoDate,
  };
}

// ── Page processing ─────────────────────────────────────────────────

export interface ProcessTransactionsOptions {
  account: StoredSessionAccount;
  sourceAccountId: string;
  bankName: string;
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
  /** Max booking_date among ingested transactions, if any. */
  maxBookingDate?: string;
  /** entry_reference presence tally (logged at debug by the caller). */
  entryRefPresent: number;
  total: number;
  /**
   * Entries dropped because the bank reported a non-booked status despite
   * the `transaction_status=BOOK` request filter (logged at debug by the
   * caller — expected to be 0 for filtering banks).
   */
  nonBooked: number;
  /** Per-record reasons for anything dropped — the caller logs them loudly. */
  skipped: string[];
}

/**
 * Normalize one page of transactions into records + documents. Booked-only
 * is enforced here on the response path: an entry whose status is present
 * and not `BOOK` is counted in `nonBooked` and dropped (entries with no
 * status are kept — some ASPSPs omit it on booked rows). A record that
 * fails normalization (malformed amount, no date) is reported in `skipped`
 * and dropped — it never wedges the rest of the page.
 */
export function processTransactionsPage(
  transactions: EbTransaction[],
  opts: ProcessTransactionsOptions,
): ProcessTransactionsResult {
  const records: Record<string, unknown>[] = [];
  const documents: DocumentInput[] = [];
  const skipped: string[] = [];
  let maxBookingDate: string | undefined;
  let entryRefPresent = 0;
  let nonBooked = 0;
  const cutoffDate = opts.dataCutoff?.slice(0, 10);

  for (const txn of transactions) {
    if (txn.status && txn.status !== BOOKED_STATUS) {
      nonBooked++;
      continue;
    }
    if (txn.entry_reference) entryRefPresent++;
    try {
      const bookingDate = transactionBookingDate(txn);
      if (cutoffDate && bookingDate < cutoffDate) continue;
      const signedAmount = signedTransactionAmount(txn);
      const transactionKey = computeTransactionKey(
        txn,
        opts.account.account_key,
        signedAmount,
        opts.hashCounts,
      );
      const recordOpts: TransactionRecordOptions = {
        accountKey: opts.account.account_key,
        sourceAccountId: opts.sourceAccountId,
        bankName: opts.bankName,
        transactionKey,
        signedAmount,
      };
      records.push(transactionToRecord(txn, recordOpts));
      documents.push(
        transactionToDocument(txn, {
          ...recordOpts,
          providerId: opts.providerId,
          sourceId: opts.sourceId,
          accountName: opts.account.name,
        }),
      );
      if (!maxBookingDate || bookingDate > maxBookingDate) maxBookingDate = bookingDate;
    } catch (err) {
      skipped.push(
        `transaction on ${txn.booking_date ?? "<no date>"} (${txn.entry_reference ?? txn.transaction_id ?? "no id"}): ${(err as Error).message}`,
      );
    }
  }

  return {
    records,
    documents,
    maxBookingDate,
    entryRefPresent,
    total: transactions.length,
    nonBooked,
    skipped,
  };
}
