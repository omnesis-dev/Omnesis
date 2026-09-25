// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure mapping from Coinbase API shapes to point-in-time snapshot rows.
 * Deterministic and free of I/O — reused verbatim by the synth twin (#754),
 * so fixture semantics cannot drift from production behavior.
 *
 * Money/quantity columns are DECIMAL and Coinbase money fields are decimal
 * STRINGS — values go through `decimalFromString` so they reach the gateway as
 * validated decimal strings carried verbatim (no `Number()` ever touches a
 * balance). The float convenience aggregates from the portfolio breakdown
 * (`total_balance_fiat`, `allocation`, `unrealized_pnl`) are deliberately
 * dropped here: net worth is re-derived in SQL from the exact crypto-quantity
 * and cost-basis columns, never from a trusted float.
 */

import { computeContentHash } from "@omnesis/core";
import { decimalFromStringOrNull, decimalFromLooseOrNull } from "./decimal.js";
import { CRYPTO_SCALE, FIAT_SCALE } from "./schemas.js";
import type {
  CoinbaseAccountRow,
  CoinbaseFill,
  CoinbaseOrder,
  CoinbaseSpotPosition,
  CoinbaseV2Account,
  CoinbaseV2Transaction,
} from "./schemas.js";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

/**
 * Map one wallet account (one currency) to a `coinbase_balances` snapshot row.
 * The `snapshot_date` (part of the PK) makes a same-day re-sync idempotent and
 * each new UTC day a fresh snapshot.
 */
export function accountToBalanceRecord(
  account: CoinbaseAccountRow,
  accountKey: string,
  sourceAccountId: string,
  snapshotDate: string,
): Record<string, unknown> {
  return {
    snapshot_date: snapshotDate,
    currency: account.currency,
    available_balance: decimalFromStringOrNull(account.available_balance?.value, CRYPTO_SCALE),
    hold_balance: decimalFromStringOrNull(account.hold?.value, CRYPTO_SCALE),
    account_uuid: account.uuid,
    type: account.type ?? null,
    account_key: accountKey,
    source_account_id: sourceAccountId,
  };
}

/**
 * Map one spot position to a `coinbase_holdings` snapshot row. Exact upstream
 * decimal strings (`total_balance_crypto`, `available_to_trade_crypto`,
 * `cost_basis.value`) are carried verbatim; the float aggregates are dropped.
 */
export function spotPositionToHoldingRecord(
  position: CoinbaseSpotPosition,
  accountKey: string,
  sourceAccountId: string,
  snapshotDate: string,
): Record<string, unknown> {
  return {
    snapshot_date: snapshotDate,
    asset: position.asset,
    // The breakdown endpoint serves these as floats (see schemas.ts) — loose
    // converter renders a canonical DECIMAL carrier from a number or string.
    total_balance_crypto: decimalFromLooseOrNull(position.total_balance_crypto, CRYPTO_SCALE),
    available_to_trade_crypto: decimalFromLooseOrNull(
      position.available_to_trade_crypto,
      CRYPTO_SCALE,
    ),
    cost_basis: decimalFromStringOrNull(position.cost_basis?.value, FIAT_SCALE),
    cost_basis_currency: position.cost_basis?.currency ?? null,
    is_cash: position.is_cash ?? null,
    account_uuid: position.account_uuid ?? null,
    account_key: accountKey,
    source_account_id: sourceAccountId,
  };
}

/**
 * Collapse a page's accounts into balance rows, skipping wallets that hold
 * nothing (both available and hold are zero/absent) so a long tail of empty
 * dust currencies doesn't bloat every daily snapshot. A currency that later
 * holds a balance reappears; one that goes to zero simply stops being
 * snapshotted (its prior snapshots remain — point-in-time history is intact).
 */
export function accountsToBalanceRecords(
  accounts: CoinbaseAccountRow[],
  accountKey: string,
  sourceAccountId: string,
  snapshotDate: string,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const account of accounts) {
    const record = accountToBalanceRecord(account, accountKey, sourceAccountId, snapshotDate);
    if (isZeroBalance(record)) continue;
    rows.push(record);
  }
  return rows;
}

/** True when both balance columns are absent or exactly zero. */
function isZeroBalance(record: Record<string, unknown>): boolean {
  return isZeroOrNull(record.available_balance) && isZeroOrNull(record.hold_balance);
}

function isZeroOrNull(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  // Decimal carrier strings: "0", "0.000…" are all zero.
  return typeof v === "string" && /^-?0(\.0+)?$/.test(v);
}

// ── orders / fills / transactions (#753) ────────────────────────────

/** Normalize an upstream timestamp to strict ISO 8601, or null if absent/unparseable. */
export function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Map one historical order to a `coinbase_orders` append-only row, keyed on the
 * stable `order_id`. An OPEN order's mutable `status`/`filled_*` fields upsert
 * on re-sync (same PK); a terminal order's row is stable.
 */
export function orderToRecord(
  order: CoinbaseOrder,
  accountKey: string,
  sourceAccountId: string,
): Record<string, unknown> {
  return {
    created_time: toIso(order.created_time),
    order_id: order.order_id,
    product_id: order.product_id ?? null,
    side: order.side ?? null,
    status: order.status ?? null,
    order_type: order.order_type ?? null,
    filled_size: decimalFromStringOrNull(order.filled_size, CRYPTO_SCALE),
    average_filled_price: decimalFromStringOrNull(order.average_filled_price, FIAT_SCALE),
    filled_value: decimalFromStringOrNull(order.filled_value, FIAT_SCALE),
    total_fees: decimalFromStringOrNull(order.total_fees, FIAT_SCALE),
    last_fill_time: toIso(order.last_fill_time),
    account_key: accountKey,
    source_account_id: sourceAccountId,
  };
}

/**
 * Map one fill to a `coinbase_fills` append-only row, keyed on the stable
 * `trade_id`. A fill is immutable, so a re-fetched fill upserts the identical row.
 */
export function fillToRecord(
  fill: CoinbaseFill,
  accountKey: string,
  sourceAccountId: string,
): Record<string, unknown> {
  return {
    trade_time: toIso(fill.trade_time),
    trade_id: fill.trade_id,
    order_id: fill.order_id ?? null,
    product_id: fill.product_id ?? null,
    side: fill.side ?? null,
    liquidity_indicator: fill.liquidity_indicator ?? null,
    price: decimalFromStringOrNull(fill.price, FIAT_SCALE),
    size: decimalFromStringOrNull(fill.size, CRYPTO_SCALE),
    size_in_quote: fill.size_in_quote ?? null,
    commission: decimalFromStringOrNull(fill.commission, FIAT_SCALE),
    account_key: accountKey,
    source_account_id: sourceAccountId,
  };
}

/** The currency code of a v2 account (the field is either a string or a `{code}` object). */
export function v2AccountCurrency(account: CoinbaseV2Account): string | null {
  const c = account.currency;
  if (c == null) return null;
  if (typeof c === "string") return c;
  return c.code ?? null;
}

/**
 * Map one v2 ledger transaction to a `coinbase_transactions` append-only row,
 * keyed on the stable `transaction_id`. An unmodelled `type` is carried verbatim
 * (never dropped) so a new Coinbase activity kind still lands as queryable data.
 */
export function transactionToRecord(
  txn: CoinbaseV2Transaction,
  walletAccountId: string,
  accountKey: string,
  sourceAccountId: string,
): Record<string, unknown> {
  return {
    created_at: toIso(txn.created_at),
    transaction_id: txn.id,
    wallet_account_id: walletAccountId,
    type: txn.type ?? null,
    status: txn.status ?? null,
    amount: decimalFromStringOrNull(txn.amount?.amount, CRYPTO_SCALE),
    amount_currency: txn.amount?.currency ?? null,
    native_amount: decimalFromStringOrNull(txn.native_amount?.amount, FIAT_SCALE),
    native_amount_currency: txn.native_amount?.currency ?? null,
    description: txn.description ?? null,
    account_key: accountKey,
    source_account_id: sourceAccountId,
  };
}

/**
 * Compact searchable document for a v2 ledger transaction.
 * Orders/fills stay rows-only — they are pure numeric activity — but ledger
 * entries carry human-readable `type`/`description`/amount narrative worth
 * full-text search. The `externalId` is `${account_key}:${transaction_id}`,
 * the 1:1 doc↔row binding the table schema declares.
 */
export function transactionToDocument(
  txn: CoinbaseV2Transaction,
  opts: { providerId: ProviderId; sourceId: SourceId; accountKey: string },
): DocumentInput {
  const time = toIso(txn.created_at) ?? new Date(0).toISOString();
  const date = time.slice(0, 10);
  const amount = txn.amount?.amount;
  const currency = txn.amount?.currency;
  const label = txn.description?.trim() || titleCaseType(txn.type);
  const title = amount && currency ? `${label} (${amount} ${currency})` : label;
  const lines = [
    `Coinbase transaction (${txn.type ?? "unknown"}): ${label}`,
    amount ? `Amount: ${amount}${currency ? ` ${currency}` : ""}` : undefined,
    txn.native_amount?.amount
      ? `Value: ${txn.native_amount.amount}${
          txn.native_amount.currency ? ` ${txn.native_amount.currency}` : ""
        }`
      : undefined,
    txn.status ? `Status: ${txn.status}` : undefined,
    `Date: ${date}`,
  ].filter((l): l is string => Boolean(l));
  const content = lines.join("\n");

  return {
    providerId: opts.providerId,
    sourceId: opts.sourceId,
    externalId: `${opts.accountKey}:${txn.id}`,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "transaction",
      tags: ["coinbase"],
      extra: {
        transactionId: txn.id,
        type: txn.type ?? undefined,
        currency: currency ?? undefined,
        accountKey: opts.accountKey,
      },
    },
    sourceCreatedAt: time,
    sourceUpdatedAt: toIso(txn.updated_at) ?? time,
  };
}

/** Render a snake_case ledger type (`fiat_deposit`) as a Title Case label. */
function titleCaseType(type: string | null | undefined): string {
  if (!type) return "Transaction";
  return type
    .split(/[_\s]+/)
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}
