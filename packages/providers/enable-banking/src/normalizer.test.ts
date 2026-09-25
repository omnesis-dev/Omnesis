// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  MalformedRecordError,
  accountToRecord,
  balancesToRecords,
  computeTransactionKey,
  maskIban,
  normalizeAmountString,
  processTransactionsPage,
  signedTransactionAmount,
  transactionToDocument,
  transactionToRecord,
} from "./normalizer.js";
import type { EbTransaction, StoredSessionAccount } from "./types.js";

const providerId = ProviderId("enable-banking:revolut-de");
const sourceId = SourceId("enable-banking-accounts:revolut-de");

const ACCOUNT: StoredSessionAccount = {
  account_key: "hash-aaa-111",
  uid: "uid-session-1",
  iban: "DE89975713758667268881",
  currency: "EUR",
  name: "Main EUR",
  cash_account_type: "CACC",
  product: "Standard",
};

function txn(overrides: Partial<EbTransaction> = {}): EbTransaction {
  return {
    entry_reference: "ref-1",
    transaction_id: "tid-1",
    booking_date: "2026-05-03",
    value_date: "2026-05-04",
    transaction_amount: { currency: "EUR", amount: "23.40" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    creditor: { name: "Riverside Grocers" },
    creditor_account: { iban: "DE89370400440532013000" },
    remittance_information: ["Groceries week 18"],
    ...overrides,
  };
}

describe("normalizeAmountString / signedTransactionAmount", () => {
  test("DBIT negates an unsigned magnitude at the string level", () => {
    expect(signedTransactionAmount(txn())).toBe("-23.40");
  });

  test("an already-signed DBIT amount is not double-negated", () => {
    expect(
      signedTransactionAmount(txn({ transaction_amount: { currency: "EUR", amount: "-23.40" } })),
    ).toBe("-23.40");
  });

  test("a leading + is stripped", () => {
    expect(
      signedTransactionAmount(
        txn({
          credit_debit_indicator: "CRDT",
          transaction_amount: { currency: "EUR", amount: "+1250.00" },
        }),
      ),
    ).toBe("1250.00");
  });

  test("CRDT keeps the magnitude positive", () => {
    expect(
      signedTransactionAmount(
        txn({
          credit_debit_indicator: "CRDT",
          transaction_amount: { currency: "EUR", amount: "1250.00" },
        }),
      ),
    ).toBe("1250.00");
  });

  test("absent amount is null", () => {
    expect(signedTransactionAmount(txn({ transaction_amount: null }))).toBeNull();
    expect(normalizeAmountString(undefined)).toBeNull();
  });

  test("malformed amounts throw loudly", () => {
    for (const bad of ["12,34", "12.34 EUR", "abc", "1e5", ""]) {
      expect(() => normalizeAmountString(bad)).toThrow(MalformedRecordError);
    }
  });

  test("a JSON-number amount is stringified then validated", () => {
    expect(normalizeAmountString(23.4)).toBe("23.4");
    expect(() => normalizeAmountString(1e-7)).toThrow(MalformedRecordError);
  });
});

describe("maskIban", () => {
  test("keeps country code + last 4 only", () => {
    expect(maskIban("DE89370400440532013000")).toBe("DE…3000");
    expect(maskIban("DE89 3704 0044 0532 0130 00")).toBe("DE…3000");
  });

  test("null/absent stays null", () => {
    expect(maskIban(null)).toBeNull();
    expect(maskIban(undefined)).toBeNull();
  });
});

describe("computeTransactionKey", () => {
  test("prefers entry_reference, then transaction_id", () => {
    const counts: Record<string, number> = {};
    expect(computeTransactionKey(txn(), "k", "-23.40", counts)).toBe("ref-1");
    expect(computeTransactionKey(txn({ entry_reference: null }), "k", "-23.40", counts)).toBe(
      "tid-1",
    );
    // No fallback hashes were consumed.
    expect(Object.keys(counts)).toHaveLength(0);
  });

  test("hash fallback is deterministic and appends the occurrence index", () => {
    const bare = txn({ entry_reference: null, transaction_id: null });
    const countsA: Record<string, number> = {};
    const first = computeTransactionKey(bare, "k", "-23.40", countsA);
    const second = computeTransactionKey(bare, "k", "-23.40", countsA);
    expect(first).toMatch(/^[0-9a-f]{64}-0$/);
    expect(second).toMatch(/^[0-9a-f]{64}-1$/);
    expect(first.slice(0, 64)).toBe(second.slice(0, 64));

    // Re-running the same window reproduces the same keys.
    const countsB: Record<string, number> = {};
    expect(computeTransactionKey(bare, "k", "-23.40", countsB)).toBe(first);
    expect(computeTransactionKey(bare, "k", "-23.40", countsB)).toBe(second);
  });

  test("same-day same-amount twins to different counterparties hash apart", () => {
    const counts: Record<string, number> = {};
    const base = {
      entry_reference: null,
      transaction_id: null,
      remittance_information: null,
    };
    const a = computeTransactionKey(
      txn({ ...base, creditor: { name: "Riverside Grocers" } }),
      "k",
      "-23.40",
      counts,
    );
    const b = computeTransactionKey(
      txn({ ...base, creditor: { name: "Northstar Hardware" } }),
      "k",
      "-23.40",
      counts,
    );
    // Distinct hash groups — both rows are the first of their own group, so
    // a re-fetch that reorders them can never swap their stored metadata.
    expect(a.endsWith("-0")).toBe(true);
    expect(b.endsWith("-0")).toBe(true);
    expect(a.slice(0, 64)).not.toBe(b.slice(0, 64));
  });

  test("the masked counterparty IBAN disambiguates twins with no counterparty name", () => {
    const counts: Record<string, number> = {};
    const base = {
      entry_reference: null,
      transaction_id: null,
      remittance_information: null,
      creditor: null,
    };
    const a = computeTransactionKey(
      txn({ ...base, creditor_account: { iban: "DE89370400440532013000" } }),
      "k",
      "-23.40",
      counts,
    );
    const b = computeTransactionKey(
      txn({ ...base, creditor_account: { iban: "FR1420041010050500013M02606" } }),
      "k",
      "-23.40",
      counts,
    );
    expect(a.slice(0, 64)).not.toBe(b.slice(0, 64));
  });

  test("different tuples never share a hash group", () => {
    const counts: Record<string, number> = {};
    const a = computeTransactionKey(
      txn({ entry_reference: null, transaction_id: null }),
      "k",
      "-23.40",
      counts,
    );
    const b = computeTransactionKey(
      txn({ entry_reference: null, transaction_id: null, booking_date: "2026-05-04" }),
      "k",
      "-23.40",
      counts,
    );
    expect(a.endsWith("-0")).toBe(true);
    expect(b.endsWith("-0")).toBe(true);
    expect(a.slice(0, 64)).not.toBe(b.slice(0, 64));
  });
});

describe("accountToRecord", () => {
  test("maps the session account with masked iban and discriminator", () => {
    const record = accountToRecord(ACCOUNT, {
      sourceAccountId: "revolut-de",
      bankName: "Revolut",
      country: "DE",
      syncedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(record).toEqual({
      account_key: "hash-aaa-111",
      source_account_id: "revolut-de",
      name: "Main EUR",
      currency: "EUR",
      cash_account_type: "CACC",
      iban_masked: "DE…8881",
      bank_name: "Revolut",
      country: "DE",
      uid: "uid-session-1",
      synced_at: "2026-06-01T00:00:00.000Z",
    });
  });
});

describe("balancesToRecords", () => {
  test("keeps the latest reference_date per balance_type; tie keeps the first", () => {
    const { records, skipped } = balancesToRecords(
      [
        {
          balance_type: "CLBD",
          balance_amount: { currency: "EUR", amount: "100.00" },
          reference_date: "2026-05-01",
        },
        {
          balance_type: "CLBD",
          balance_amount: { currency: "EUR", amount: "250.00" },
          reference_date: "2026-05-02",
        },
        {
          balance_type: "CLBD",
          balance_amount: { currency: "EUR", amount: "999.00" },
          reference_date: "2026-05-02",
        },
        {
          balance_type: "ITAV",
          balance_amount: { currency: "EUR", amount: "240.10" },
          reference_date: null,
        },
      ],
      { accountKey: "hash-aaa-111", sourceAccountId: "revolut-de", snapshotDate: "2026-06-01" },
    );
    expect(skipped).toEqual([]);
    expect(records).toHaveLength(2);
    const clbd = records.find((r) => r.balance_type === "CLBD");
    expect(clbd).toMatchObject({
      snapshot_date: "2026-06-01",
      source_account_id: "revolut-de",
      account_key: "hash-aaa-111",
      amount: "250.00",
      currency: "EUR",
      reference_date: "2026-05-02",
    });
    const itav = records.find((r) => r.balance_type === "ITAV");
    expect(itav).toMatchObject({ amount: "240.10", reference_date: null });
  });

  test("an entry without reference_date never beats one with it", () => {
    const { records } = balancesToRecords(
      [
        {
          balance_type: "CLBD",
          balance_amount: { currency: "EUR", amount: "1.00" },
          reference_date: "2026-05-01",
        },
        { balance_type: "CLBD", balance_amount: { currency: "EUR", amount: "2.00" } },
      ],
      { accountKey: "k", sourceAccountId: "revolut-de", snapshotDate: "2026-06-01" },
    );
    expect(records).toHaveLength(1);
    expect(records[0].amount).toBe("1.00");
  });

  test("malformed or missing amounts are skipped with reasons, not thrown", () => {
    const { records, skipped } = balancesToRecords(
      [
        { balance_type: "CLBD", balance_amount: { currency: "EUR", amount: "12,50" } },
        { balance_type: "ITAV" },
        { balance_type: "XPCD", balance_amount: { currency: "EUR", amount: "5.00" } },
      ],
      { accountKey: "k", sourceAccountId: "revolut-de", snapshotDate: "2026-06-01" },
    );
    expect(records).toHaveLength(1);
    expect(records[0].balance_type).toBe("XPCD");
    expect(skipped).toHaveLength(2);
  });
});

describe("transactionToRecord", () => {
  test("maps a debit with the creditor as counterparty", () => {
    const record = transactionToRecord(txn(), {
      accountKey: "hash-aaa-111",
      sourceAccountId: "revolut-de",
      bankName: "Revolut",
      transactionKey: "ref-1",
      signedAmount: "-23.40",
    });
    expect(record).toEqual({
      booking_date: "2026-05-03",
      value_date: "2026-05-04",
      amount: "-23.40",
      currency: "EUR",
      status: "BOOK",
      counterparty_name: "Riverside Grocers",
      counterparty_iban_masked: "DE…3000",
      description: "Groceries week 18",
      bank_name: "Revolut",
      source_account_id: "revolut-de",
      account_key: "hash-aaa-111",
      transaction_key: "ref-1",
    });
  });

  test("a credit uses the debtor as counterparty", () => {
    const record = transactionToRecord(
      txn({
        credit_debit_indicator: "CRDT",
        debtor: { name: "Maya Reeves" },
        debtor_account: { iban: "FR1420041010050500013M02606" },
        creditor: null,
        creditor_account: null,
      }),
      {
        accountKey: "k",
        sourceAccountId: "revolut-de",
        bankName: "Revolut",
        transactionKey: "ref-1",
        signedAmount: "23.40",
      },
    );
    expect(record.counterparty_name).toBe("Maya Reeves");
    expect(record.counterparty_iban_masked).toBe("FR…2606");
  });

  test("booking_date falls back to value_date then transaction_date", () => {
    const record = transactionToRecord(
      txn({ booking_date: null, value_date: null, transaction_date: "2026-05-05" }),
      {
        accountKey: "k",
        sourceAccountId: "revolut-de",
        bankName: "Revolut",
        transactionKey: "ref-1",
        signedAmount: "-23.40",
      },
    );
    expect(record.booking_date).toBe("2026-05-05");
  });
});

describe("transactionToDocument", () => {
  test("builds a compact body with no IBANs anywhere", () => {
    const doc = transactionToDocument(txn(), {
      accountKey: "hash-aaa-111",
      sourceAccountId: "revolut-de",
      bankName: "Revolut",
      transactionKey: "ref-1",
      signedAmount: "-23.40",
      providerId,
      sourceId,
      accountName: "Main EUR",
    });
    expect(doc.externalId).toBe("hash-aaa-111:ref-1");
    expect(doc.title).toBe("Riverside Grocers — -23.40 EUR");
    expect(doc.content).toContain("Counterparty: Riverside Grocers");
    expect(doc.content).toContain("Amount: -23.40 EUR");
    expect(doc.content).toContain("Date: 2026-05-03");
    expect(doc.content).toContain("Description: Groceries week 18");
    expect(doc.content).toContain("Account: Revolut Main EUR");
    expect(doc.content).not.toContain("DE89");
    expect(doc.content).not.toContain("3000");
    expect(doc.content).not.toContain("…");
    expect(doc.metadata.documentType).toBe("transaction");
    expect(doc.sourceCreatedAt).toBe("2026-05-03T00:00:00.000Z");
    expect(doc.contentHash).toBeTruthy();
  });
});

describe("processTransactionsPage", () => {
  function opts(overrides: Partial<Parameters<typeof processTransactionsPage>[1]> = {}) {
    return {
      account: ACCOUNT,
      sourceAccountId: "revolut-de",
      bankName: "Revolut",
      providerId,
      sourceId,
      hashCounts: {},
      ...overrides,
    };
  }

  test("emits one record and one document per transaction", () => {
    const result = processTransactionsPage(
      [txn(), txn({ entry_reference: "ref-2", booking_date: "2026-05-06" })],
      opts(),
    );
    expect(result.records).toHaveLength(2);
    expect(result.documents).toHaveLength(2);
    expect(result.maxBookingDate).toBe("2026-05-06");
    expect(result.entryRefPresent).toBe(2);
    expect(result.total).toBe(2);
    expect(result.skipped).toEqual([]);
  });

  test("booked-only is enforced on the response path: pending rows drop, absent status keeps", () => {
    const result = processTransactionsPage(
      [
        txn(),
        txn({ entry_reference: "ref-pending", status: "PDNG" }),
        txn({ entry_reference: "ref-info", status: "INFO" }),
        txn({ entry_reference: "ref-no-status", status: null }),
        txn({ entry_reference: "ref-undef-status", status: undefined }),
      ],
      opts(),
    );
    const keys = result.records.map((r) => r.transaction_key);
    expect(keys).toEqual(["ref-1", "ref-no-status", "ref-undef-status"]);
    expect(result.nonBooked).toBe(2);
    expect(result.total).toBe(5);
    // Non-booked drops are expected behavior, not malformed records.
    expect(result.skipped).toEqual([]);
  });

  test("one malformed record never wedges the page", () => {
    const result = processTransactionsPage(
      [
        txn(),
        txn({
          entry_reference: "ref-bad",
          transaction_amount: { currency: "EUR", amount: "12,34" },
        }),
        txn({ entry_reference: "ref-3" }),
      ],
      opts(),
    );
    expect(result.records).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("ref-bad");
    expect(result.skipped[0]).toContain("decimal");
  });

  test("a transaction with no usable date is skipped loudly", () => {
    const result = processTransactionsPage(
      [txn({ booking_date: null, value_date: null, transaction_date: null })],
      opts(),
    );
    expect(result.records).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });

  test("records older than dataCutoff are skipped silently", () => {
    const result = processTransactionsPage(
      [txn({ booking_date: "2020-01-15" }), txn({ entry_reference: "ref-2" })],
      opts({ dataCutoff: "2026-01-01T00:00:00.000Z" }),
    );
    expect(result.records).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  test("hash-fallback occurrence indices accumulate across pages of one window", () => {
    const bare = txn({ entry_reference: null, transaction_id: null });
    const hashCounts: Record<string, number> = {};
    const page1 = processTransactionsPage([bare], opts({ hashCounts }));
    const page2 = processTransactionsPage([bare], opts({ hashCounts }));
    const key1 = page1.records[0].transaction_key as string;
    const key2 = page2.records[0].transaction_key as string;
    expect(key1.endsWith("-0")).toBe(true);
    expect(key2.endsWith("-1")).toBe(true);
    expect(key1.slice(0, 64)).toBe(key2.slice(0, 64));
  });
});
