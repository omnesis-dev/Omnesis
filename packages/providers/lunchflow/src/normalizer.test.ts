// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  MalformedRecordError,
  accountIdString,
  accountToRecord,
  balanceToRecord,
  computeTransactionKey,
  normalizeAmountString,
  processTransactionsPage,
  toAccountContext,
  transactionToDocument,
  transactionToRecord,
} from "./normalizer.js";
import type { AccountContext } from "./normalizer.js";
import type { LunchflowAccount, LunchflowTransaction } from "./types.js";

const PROVIDER_ID = ProviderId("lunchflow:default");
const SOURCE_ID = SourceId("lunchflow-accounts:default");

const ACCOUNT: AccountContext = {
  id: "481",
  name: "Everyday Current",
  institutionName: "Northstar Bank",
  currency: "GBP",
};

function txn(overrides: Partial<LunchflowTransaction> = {}): LunchflowTransaction {
  return {
    id: "lf-txn-001",
    accountId: 481,
    amount: -42.5,
    currency: "GBP",
    date: "2025-06-20",
    merchant: "Riverbend Market",
    description: "Weekly groceries",
    isPending: false,
    ...overrides,
  };
}

describe("normalizeAmountString", () => {
  test("stringifies JSON numbers and validates the decimal shape", () => {
    expect(normalizeAmountString(-42.5)).toBe("-42.5");
    expect(normalizeAmountString(1800)).toBe("1800");
    expect(normalizeAmountString(1.12)).toBe("1.12");
  });

  test("preserves the sign as given (no re-signing)", () => {
    expect(normalizeAmountString(-15)).toBe("-15");
    expect(normalizeAmountString("23.40")).toBe("23.40");
    expect(normalizeAmountString("+9.99")).toBe("9.99");
  });

  test("absent → null", () => {
    expect(normalizeAmountString(null)).toBeNull();
    expect(normalizeAmountString(undefined)).toBeNull();
  });

  test("rejects non-decimal artifacts loudly", () => {
    expect(() => normalizeAmountString("1e5")).toThrow(MalformedRecordError);
    expect(() => normalizeAmountString("12,34")).toThrow(MalformedRecordError);
    expect(() => normalizeAmountString("")).toThrow(MalformedRecordError);
  });
});

describe("accountIdString / toAccountContext", () => {
  test("normalizes a numeric id to a string", () => {
    expect(accountIdString({ id: 481 })).toBe("481");
    expect(accountIdString({ id: "902" })).toBe("902");
  });

  test("projects the slice the transaction normalizer needs", () => {
    const account: LunchflowAccount = {
      id: 481,
      name: "Everyday Current",
      institution_name: "Northstar Bank",
      institution_logo: "https://example.com/logo.png",
      provider: "gocardless",
      currency: "GBP",
      status: "ACTIVE",
    };
    expect(toAccountContext(account)).toEqual({
      id: "481",
      name: "Everyday Current",
      institutionName: "Northstar Bank",
      currency: "GBP",
    });
  });
});

describe("computeTransactionKey", () => {
  test("prefers the Lunch Flow transaction id", () => {
    expect(computeTransactionKey(txn(), "481", "-42.5", {})).toBe("lf-txn-001");
  });

  test("falls back to a content hash with an occurrence index when id is null", () => {
    const counts: Record<string, number> = {};
    const a = computeTransactionKey(txn({ id: null }), "481", "-42.5", counts);
    const b = computeTransactionKey(txn({ id: null }), "481", "-42.5", counts);
    expect(a).toMatch(/^[0-9a-f]{64}-0$/);
    // A byte-identical second occurrence in the same window gets the next index.
    expect(b).toBe(a.replace(/-0$/, "-1"));
  });

  test("distinct content yields distinct hashes", () => {
    const k1 = computeTransactionKey(txn({ id: null }), "481", "-42.5", {});
    const k2 = computeTransactionKey(
      txn({ id: null, merchant: "Vela Streaming" }),
      "481",
      "-42.5",
      {},
    );
    expect(k1.slice(0, 64)).not.toBe(k2.slice(0, 64));
  });
});

describe("accountToRecord", () => {
  test("maps an account to its row, stringifying the id", () => {
    const account: LunchflowAccount = {
      id: 902,
      name: "Rainy Day Saver",
      institution_name: "Riverside Building Society",
      institution_logo: null,
      provider: "gocardless",
      currency: "GBP",
      status: "DISCONNECTED",
    };
    expect(
      accountToRecord(account, {
        syncedAt: "2025-12-31T00:00:00.000Z",
        sourceAccountId: "lunchflow-testaccount",
      }),
    ).toEqual({
      account_id: "902",
      name: "Rainy Day Saver",
      institution_name: "Riverside Building Society",
      institution_logo: null,
      provider: "gocardless",
      currency: "GBP",
      status: "DISCONNECTED",
      synced_at: "2025-12-31T00:00:00.000Z",
      source_account_id: "lunchflow-testaccount",
    });
  });

  test("derives currency from the option when the account carries none, and blanks an empty name", () => {
    // Lunch Flow's /accounts omits currency and returns "" for some names.
    const account: LunchflowAccount = {
      id: 481,
      name: "   ",
      institution_name: "Northstar Bank",
      institution_logo: null,
      provider: "gocardless",
      currency: null,
      status: "ACTIVE",
    };
    const row = accountToRecord(account, {
      syncedAt: "2025-12-31T00:00:00.000Z",
      currency: "EUR",
      sourceAccountId: "lunchflow-testaccount",
    });
    expect(row.currency).toBe("EUR");
    expect(row.name).toBeNull();
  });

  test("an explicit account currency wins over the derived option", () => {
    const account = { id: 1, currency: "GBP" } as LunchflowAccount;
    expect(
      accountToRecord(account, {
        syncedAt: "x",
        currency: "EUR",
        sourceAccountId: "lunchflow-testaccount",
      }).currency,
    ).toBe("GBP");
  });
});

describe("balanceToRecord", () => {
  test("normalizes the amount onto the snapshot date", () => {
    const { record, skipped } = balanceToRecord(
      { amount: 1280.75, currency: "GBP" },
      { accountId: "481", snapshotDate: "2025-12-31", sourceAccountId: "lunchflow-testaccount" },
    );
    expect(skipped).toBeNull();
    expect(record).toEqual({
      snapshot_date: "2025-12-31",
      account_id: "481",
      amount: "1280.75",
      currency: "GBP",
      source_account_id: "lunchflow-testaccount",
    });
  });

  test("a missing amount is skipped, not thrown", () => {
    const { record, skipped } = balanceToRecord(
      { amount: null, currency: "GBP" },
      { accountId: "481", snapshotDate: "2025-12-31", sourceAccountId: "lunchflow-testaccount" },
    );
    expect(record).toBeNull();
    expect(skipped).toBe("no amount reported");
  });
});

describe("transactionToRecord", () => {
  test("preserves the signed amount and denormalizes the institution", () => {
    expect(
      transactionToRecord(txn(), {
        sourceAccountId: "lunchflow-testaccount",
        account: ACCOUNT,
        transactionKey: "lf-txn-001",
        signedAmount: "-42.5",
      }),
    ).toEqual({
      transaction_date: "2025-06-20",
      amount: "-42.5",
      currency: "GBP",
      merchant: "Riverbend Market",
      description: "Weekly groceries",
      institution_name: "Northstar Bank",
      account_id: "481",
      transaction_id: "lf-txn-001",
      transaction_key: "lf-txn-001",
      source_account_id: "lunchflow-testaccount",
    });
  });

  test("falls back to the account currency when the transaction omits one", () => {
    const record = transactionToRecord(txn({ currency: null }), {
      sourceAccountId: "lunchflow-testaccount",
      account: ACCOUNT,
      transactionKey: "lf-txn-001",
      signedAmount: "-42.5",
    });
    expect(record.currency).toBe("GBP");
  });

  test("collapses a multi-line bank-memo merchant to a single readable line", () => {
    const record = transactionToRecord(
      txn({ merchant: "PRELVT SEPA RECU\n\nABEILLE VIE\n.RUM.X12  Y" }),
      {
        sourceAccountId: "lunchflow-testaccount",
        account: ACCOUNT,
        transactionKey: "lf-txn-001",
        signedAmount: "-42.5",
      },
    );
    expect(record.merchant).toBe("PRELVT SEPA RECU ABEILLE VIE .RUM.X12 Y");
  });
});

describe("transactionToDocument", () => {
  test("builds a compact searchable document keyed by account:transaction", () => {
    const doc = transactionToDocument(txn(), {
      sourceAccountId: "lunchflow-testaccount",
      account: ACCOUNT,
      transactionKey: "lf-txn-001",
      signedAmount: "-42.5",
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
    });
    expect(doc.externalId).toBe("481:lf-txn-001");
    expect(doc.title).toBe("Riverbend Market — -42.5 GBP");
    expect(doc.content).toContain("Merchant: Riverbend Market");
    expect(doc.content).toContain("Amount: -42.5 GBP");
    expect(doc.content).toContain("Account: Northstar Bank Everyday Current");
    expect(doc.sourceCreatedAt).toBe("2025-06-20T00:00:00.000Z");
    expect(doc.metadata.extra?.accountId).toBe("481");
  });

  test("externalId round-trips back into [account_id, transaction_key] on ':'", () => {
    // The lunchflow_transactions boundDocument reconstructs the externalId by
    // joining [account_id, transaction_key] with ':'; the document must build
    // it the same way so the gateway's split recovers exactly two components.
    // account_id is numeric and transaction_key is colon-free in practice.
    const doc = transactionToDocument(txn(), {
      sourceAccountId: "lunchflow-testaccount",
      account: ACCOUNT,
      transactionKey: "lf-txn-001",
      signedAmount: "-42.5",
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
    });
    const parts = doc.externalId.split(":");
    expect(parts).toEqual(["481", "lf-txn-001"]);
    // Content-hash fallback keys (`<hex>-<n>`) are colon-free too.
    const hashed = transactionToDocument(txn({ id: null }), {
      account: { ...ACCOUNT, id: "902" },
      transactionKey: computeTransactionKey(txn({ id: null }), "902", "-42.5", {}),
      signedAmount: "-42.5",
      sourceAccountId: "lunchflow-testaccount",
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
    });
    expect(hashed.externalId.split(":")).toHaveLength(2);
  });

  test("titles a merchant-less transaction by its description", () => {
    const doc = transactionToDocument(
      txn({ id: null, merchant: null, description: "Savings interest", amount: 1.12 }),
      {
        account: { ...ACCOUNT, id: "902" },
        transactionKey: "abc-0",
        signedAmount: "1.12",
        sourceAccountId: "lunchflow-testaccount",
        providerId: PROVIDER_ID,
        sourceId: SOURCE_ID,
      },
    );
    expect(doc.title).toBe("Savings interest — 1.12 GBP");
  });
});

describe("processTransactionsPage", () => {
  test("emits records + documents and tracks the max date", () => {
    const result = processTransactionsPage(
      [txn({ id: "a", date: "2025-06-20" }), txn({ id: "b", date: "2025-06-25", amount: 1800 })],
      {
        account: ACCOUNT,
        sourceAccountId: "lunchflow-testaccount",
        providerId: PROVIDER_ID,
        sourceId: SOURCE_ID,
        hashCounts: {},
      },
    );
    expect(result.records).toHaveLength(2);
    expect(result.documents).toHaveLength(2);
    expect(result.maxDate).toBe("2025-06-25");
    expect(result.total).toBe(2);
  });

  test("drops pending transactions", () => {
    const result = processTransactionsPage([txn({ isPending: true })], {
      account: ACCOUNT,
      sourceAccountId: "lunchflow-testaccount",
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
      hashCounts: {},
    });
    expect(result.records).toHaveLength(0);
    expect(result.pending).toBe(1);
  });

  test("honors the data cutoff", () => {
    const result = processTransactionsPage(
      [txn({ id: "old", date: "2024-01-01" }), txn({ id: "new", date: "2025-06-20" })],
      {
        account: ACCOUNT,
        sourceAccountId: "lunchflow-testaccount",
        providerId: PROVIDER_ID,
        sourceId: SOURCE_ID,
        dataCutoff: "2025-01-01T00:00:00.000Z",
        hashCounts: {},
      },
    );
    expect(result.records).toHaveLength(1);
    expect((result.records[0] as { transaction_id: string }).transaction_id).toBe("new");
  });

  test("a malformed record is skipped loudly, not fatal", () => {
    const result = processTransactionsPage(
      [txn({ id: "bad", amount: "not-a-number" }), txn({ id: "good" })],
      {
        account: ACCOUNT,
        sourceAccountId: "lunchflow-testaccount",
        providerId: PROVIDER_ID,
        sourceId: SOURCE_ID,
        hashCounts: {},
      },
    );
    expect(result.records).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("bad");
  });
});
