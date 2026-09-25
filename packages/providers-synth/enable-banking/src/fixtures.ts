// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  accountToRecord,
  balancesToRecords,
  processTransactionsPage,
} from "@omnesis/provider-enable-banking";
import { loadActiveUniverse, loadSourceFixtureJson } from "@omnesis/providers-synth-common";
import type {
  EbBalance,
  EbTransaction,
  StoredSessionAccount,
} from "@omnesis/provider-enable-banking";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

/**
 * Deterministic stand-ins for every clock-derived value the real source
 * computes from its injectable `now()` — pinned so repeated synth syncs are
 * byte-stable (same rows, same primary keys, same document hashes).
 */
export const SYNTH_SYNCED_AT = "2025-12-31T00:00:00.000Z";
export const SYNTH_SNAPSHOT_DATE = "2025-12-31";

/** The synthetic connected bank — drives per-instance label/icon branding. */
export const SYNTH_BANK_NAME = "Revolut";
export const SYNTH_BANK_COUNTRY = "DE";

/** Per-account balance fixtures — raw `EbBalance` shapes keyed by account. */
export interface EbAccountBalancesFixture {
  account_key: string;
  balances: EbBalance[];
}

/** Per-account transaction fixtures — raw `EbTransaction` shapes keyed by account. */
export interface EbAccountTransactionsFixture {
  account_key: string;
  transactions: EbTransaction[];
}

let cachedAccounts: StoredSessionAccount[] | null = null;
let cachedBalances: EbAccountBalancesFixture[] | null = null;
let cachedTransactions: EbAccountTransactionsFixture[] | null = null;

export function loadAccounts(): StoredSessionAccount[] {
  if (!cachedAccounts) {
    cachedAccounts = loadSourceFixtureJson<StoredSessionAccount[]>(
      loadActiveUniverse(),
      "enable-banking-accounts",
      "accounts.json",
    );
  }
  return cachedAccounts;
}

export function loadBalances(): EbAccountBalancesFixture[] {
  if (!cachedBalances) {
    cachedBalances = loadSourceFixtureJson<EbAccountBalancesFixture[]>(
      loadActiveUniverse(),
      "enable-banking-accounts",
      "balances.json",
    );
  }
  return cachedBalances;
}

export function loadTransactions(): EbAccountTransactionsFixture[] {
  if (!cachedTransactions) {
    cachedTransactions = loadSourceFixtureJson<EbAccountTransactionsFixture[]>(
      loadActiveUniverse(),
      "enable-banking-accounts",
      "transactions.json",
    );
  }
  return cachedTransactions;
}

/** `bank_accounts` rows via the real normalizer. */
export function accountRecords(sourceAccountId: string): Record<string, unknown>[] {
  return loadAccounts().map((account) =>
    accountToRecord(account, {
      sourceAccountId,
      bankName: SYNTH_BANK_NAME,
      country: SYNTH_BANK_COUNTRY,
      syncedAt: SYNTH_SYNCED_AT,
    }),
  );
}

/** `bank_balances` rows via the real normalizer, pinned snapshot date. */
export function balanceRecords(sourceAccountId: string): Record<string, unknown>[] {
  return loadBalances().flatMap((group) => {
    const { records, skipped } = balancesToRecords(group.balances, {
      accountKey: group.account_key,
      sourceAccountId,
      snapshotDate: SYNTH_SNAPSHOT_DATE,
    });
    if (skipped.length > 0) {
      throw new Error(
        `enable-banking synth fixture has unprocessable balances for ${group.account_key}: ${skipped.join("; ")}`,
      );
    }
    return records;
  });
}

/**
 * `bank_transactions` rows + their searchable documents, mapped through the
 * real page normalizer (signed amounts, transaction keys, masked IBANs).
 * A fixture that fails normalization is a bug — fail loudly, never skip.
 */
export function transactionData(
  sourceAccountId: string,
  ids: { providerId: ProviderId; sourceId: SourceId },
): { records: Record<string, unknown>[]; documents: DocumentInput[] } {
  const accountsByKey = new Map(loadAccounts().map((a) => [a.account_key, a]));
  const records: Record<string, unknown>[] = [];
  const documents: DocumentInput[] = [];
  for (const group of loadTransactions()) {
    const account = accountsByKey.get(group.account_key);
    if (!account) {
      throw new Error(
        `enable-banking synth fixture references unknown account ${group.account_key}`,
      );
    }
    const result = processTransactionsPage(group.transactions, {
      account,
      sourceAccountId,
      bankName: SYNTH_BANK_NAME,
      providerId: ids.providerId,
      sourceId: ids.sourceId,
      hashCounts: {},
    });
    if (result.skipped.length > 0) {
      throw new Error(
        `enable-banking synth fixture has unprocessable transactions for ${group.account_key}: ${result.skipped.join("; ")}`,
      );
    }
    if (result.nonBooked > 0) {
      throw new Error(
        `enable-banking synth fixture has ${result.nonBooked} non-booked transaction(s) for ${group.account_key} — fixtures must carry status BOOK (or omit status), matching what the real source ingests`,
      );
    }
    records.push(...result.records);
    documents.push(...result.documents);
  }
  return { records, documents };
}
