// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  processTransactions,
  signedTransactionAmount,
  transactionCurrency,
  transactionToDocument,
  transactionToRecord,
} from "./normalizer.js";
import type { PlaidTransaction } from "./schemas.js";

const PROVIDER_ID = ProviderId("plaid:item-1");
const SOURCE_ID = SourceId("plaid:item-1");

/** A fictional Plaid transaction (invented data, never corpus-derived). */
function txn(overrides: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    transaction_id: "txn-1",
    account_id: "acct-1",
    amount: 12.34,
    iso_currency_code: "USD",
    date: "2026-05-01",
    name: "STELLAR SOUND",
    merchant_name: "Stellar Sound",
    pending: false,
    ...overrides,
  };
}

describe("signedTransactionAmount", () => {
  test("flips Plaid's sign so debits (money out) read negative", () => {
    // Plaid: positive amount = money OUT. Omnesis: negative = money out.
    expect(signedTransactionAmount(txn({ amount: 12.34 }))).toBe("-12.34");
    // A Plaid negative (money in, e.g. a refund) reads positive.
    expect(signedTransactionAmount(txn({ amount: -50 }))).toBe("50.00");
  });

  test("renders an exact 2-scale carrier (no float drift)", () => {
    expect(signedTransactionAmount(txn({ amount: 0.1 }))).toBe("-0.10");
    expect(signedTransactionAmount(txn({ amount: 100 }))).toBe("-100.00");
    expect(signedTransactionAmount(txn({ amount: 0 }))).toBe("0.00");
  });
});

describe("transactionCurrency", () => {
  test("prefers ISO, falls back to unofficial, else null", () => {
    expect(transactionCurrency(txn({ iso_currency_code: "CAD" }))).toBe("CAD");
    expect(
      transactionCurrency(txn({ iso_currency_code: null, unofficial_currency_code: "POINTS" })),
    ).toBe("POINTS");
    expect(
      transactionCurrency(txn({ iso_currency_code: null, unofficial_currency_code: null })),
    ).toBeNull();
  });
});

describe("transactionToRecord", () => {
  test("maps every column with the signed amount and pending defaults", () => {
    const rec = transactionToRecord(
      txn({
        datetime: "2026-05-01T14:30:00Z",
        payment_channel: "in store",
        personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "RESTAURANT" },
      }),
      { itemId: "item-1" },
    );
    expect(rec).toEqual({
      transaction_id: "txn-1",
      item_id: "item-1",
      account_id: "acct-1",
      date: "2026-05-01",
      datetime: "2026-05-01T14:30:00Z",
      amount: "-12.34",
      currency: "USD",
      name: "STELLAR SOUND",
      merchant_name: "Stellar Sound",
      category: "FOOD_AND_DRINK",
      payment_channel: "in store",
      pending: false,
      pending_transaction_id: null,
    });
  });

  test("carries the pending flag and pending_transaction_id link", () => {
    const rec = transactionToRecord(
      txn({ transaction_id: "txn-posted", pending: false, pending_transaction_id: "txn-pending" }),
      { itemId: "item-1" },
    );
    expect(rec.pending).toBe(false);
    expect(rec.pending_transaction_id).toBe("txn-pending");
  });
});

describe("transactionToDocument", () => {
  test("builds a compact searchable doc keyed by item:transaction", () => {
    const doc = transactionToDocument(txn(), {
      itemId: "item-1",
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
      institutionName: "Example Bank",
    });
    expect(doc.externalId).toBe("item-1:txn-1");
    expect(doc.title).toBe("Stellar Sound — -12.34 USD");
    expect(doc.content).toContain("Merchant: Stellar Sound");
    expect(doc.content).toContain("Amount: -12.34 USD");
    expect(doc.content).toContain("Account: Example Bank");
    // No account numbers ever in a document body.
    expect(doc.content).not.toContain("acct-1");
    expect(doc.sourceCreatedAt).toBe("2026-05-01T00:00:00.000Z");
  });

  test("uses the datetime instant when present", () => {
    const doc = transactionToDocument(txn({ datetime: "2026-05-01T09:15:00Z" }), {
      itemId: "item-1",
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
    });
    expect(doc.sourceCreatedAt).toBe("2026-05-01T09:15:00Z");
  });
});

describe("processTransactions", () => {
  test("emits a record + document per transaction", () => {
    const { records, documents } = processTransactions([txn(), txn({ transaction_id: "txn-2" })], {
      itemId: "item-1",
      providerId: PROVIDER_ID,
      sourceId: SOURCE_ID,
    });
    expect(records).toHaveLength(2);
    expect(documents).toHaveLength(2);
    expect(documents.map((d) => d.externalId)).toEqual(["item-1:txn-1", "item-1:txn-2"]);
  });

  test("drops transactions dated before dataCutoff", () => {
    const { records } = processTransactions(
      [txn({ date: "2025-01-01" }), txn({ transaction_id: "txn-2", date: "2026-05-01" })],
      { itemId: "item-1", providerId: PROVIDER_ID, sourceId: SOURCE_ID, dataCutoff: "2026-01-01" },
    );
    expect(records).toHaveLength(1);
    expect(records[0].transaction_id).toBe("txn-2");
  });
});
