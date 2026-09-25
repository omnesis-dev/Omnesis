// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  accountIdString,
  accountToRecord,
  balanceToRecord,
  processTransactionsPage,
  toAccountContext,
} from "@omnesis/provider-lunchflow";
import { loadActiveUniverse, loadSourceFixtureJson } from "@omnesis/providers-synth-common";
import type {
  LunchflowAccount,
  LunchflowBalance,
  LunchflowTransaction,
} from "@omnesis/provider-lunchflow";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

/**
 * Deterministic stand-ins for every clock-derived value the real source
 * computes from its injectable `now()` — pinned so repeated synth syncs are
 * byte-stable (same rows, same primary keys, same document hashes).
 */
export const SYNTH_SYNCED_AT = "2025-12-31T00:00:00.000Z";
export const SYNTH_SNAPSHOT_DATE = "2025-12-31";

/** Per-account transaction fixtures — raw `LunchflowTransaction` shapes keyed by account id. */
export interface LfAccountTransactionsFixture {
  account_id: number | string;
  transactions: LunchflowTransaction[];
}

/** Per-account balance fixtures — a raw `LunchflowBalance` keyed by account id. */
export interface LfAccountBalanceFixture {
  account_id: number | string;
  balance: LunchflowBalance;
}

let cachedAccounts: LunchflowAccount[] | null = null;
let cachedBalances: LfAccountBalanceFixture[] | null = null;
let cachedTransactions: LfAccountTransactionsFixture[] | null = null;

export function loadAccounts(): LunchflowAccount[] {
  if (!cachedAccounts) {
    cachedAccounts = loadSourceFixtureJson<LunchflowAccount[]>(
      loadActiveUniverse(),
      "lunchflow-accounts",
      "accounts.json",
    );
  }
  return cachedAccounts;
}

export function loadBalances(): LfAccountBalanceFixture[] {
  if (!cachedBalances) {
    cachedBalances = loadSourceFixtureJson<LfAccountBalanceFixture[]>(
      loadActiveUniverse(),
      "lunchflow-accounts",
      "balances.json",
    );
  }
  return cachedBalances;
}

export function loadTransactions(): LfAccountTransactionsFixture[] {
  if (!cachedTransactions) {
    cachedTransactions = loadSourceFixtureJson<LfAccountTransactionsFixture[]>(
      loadActiveUniverse(),
      "lunchflow-accounts",
      "transactions.json",
    );
  }
  return cachedTransactions;
}

/** `lunchflow_accounts` rows via the real normalizer. */
export function accountRecords(sourceAccountId: string): Record<string, unknown>[] {
  return loadAccounts().map((account) =>
    accountToRecord(account, { syncedAt: SYNTH_SYNCED_AT, sourceAccountId }),
  );
}

/** `lunchflow_balances` rows via the real normalizer, pinned snapshot date. */
export function balanceRecords(sourceAccountId: string): Record<string, unknown>[] {
  return loadBalances().map((group) => {
    const { record, skipped } = balanceToRecord(group.balance, {
      sourceAccountId,
      accountId: String(group.account_id),
      snapshotDate: SYNTH_SNAPSHOT_DATE,
    });
    if (skipped || !record) {
      throw new Error(
        `lunchflow synth fixture has an unprocessable balance for account ${group.account_id}: ${skipped ?? "no record"}`,
      );
    }
    return record;
  });
}

/**
 * `lunchflow_transactions` rows + their searchable documents, mapped through
 * the real page normalizer (decimal amounts, transaction keys). A fixture that
 * fails normalization is a bug — fail loudly, never skip.
 */
export function transactionData(ids: {
  providerId: ProviderId;
  sourceId: SourceId;
  sourceAccountId: string;
}): {
  records: Record<string, unknown>[];
  documents: DocumentInput[];
} {
  const accountsById = new Map(loadAccounts().map((a) => [accountIdString(a), a]));
  const records: Record<string, unknown>[] = [];
  const documents: DocumentInput[] = [];
  for (const group of loadTransactions()) {
    const accountId = String(group.account_id);
    const account = accountsById.get(accountId);
    if (!account) {
      throw new Error(`lunchflow synth fixture references unknown account ${accountId}`);
    }
    const result = processTransactionsPage(group.transactions, {
      sourceAccountId: ids.sourceAccountId,
      account: toAccountContext(account),
      providerId: ids.providerId,
      sourceId: ids.sourceId,
      hashCounts: {},
    });
    if (result.skipped.length > 0) {
      throw new Error(
        `lunchflow synth fixture has unprocessable transactions for account ${accountId}: ${result.skipped.join("; ")}`,
      );
    }
    if (result.pending > 0) {
      throw new Error(
        `lunchflow synth fixture has ${result.pending} pending transaction(s) for account ${accountId} — fixtures must be booked (isPending false/absent), matching what the real source ingests`,
      );
    }
    records.push(...result.records);
    documents.push(...result.documents);
  }
  return { records, documents };
}
