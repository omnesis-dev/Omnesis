// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The profile and the normalizer have to agree, in both directions. A field
 * the profile declares but nobody emits compiles a watch that can never fire;
 * a field the normalizer writes but the profile omits is absent from the watch
 * journal, so a watch cannot predicate on it. Neither fails at build or sync
 * time, which is why this test exists.
 */

import { describe, expect, test } from "vitest";
import { validateDocumentEventProfile } from "@omnesis/source-sdk";
import { plaidTransactionsDocumentProfile } from "./document-profiles.js";
import { transactionToDocument } from "./normalizer.js";
import type { ProviderId, SourceId } from "@omnesis/types";
import type { PlaidTransaction } from "./schemas.js";

const OPTS = {
  itemId: "item-1",
  providerId: "plaid" as ProviderId,
  sourceId: "plaid:item-1" as SourceId,
  institutionName: "Northstar Bank",
};

/** A transaction carrying every optional field, so no declared path is missed. */
const FULL: PlaidTransaction = {
  transaction_id: "txn-1",
  account_id: "acct-1",
  date: "2026-05-14",
  amount: 12.5,
  iso_currency_code: "USD",
  name: "STELLAR SOUND LTD",
  merchant_name: "Stellar Sound",
  payment_channel: "in store",
  pending: false,
  personal_finance_category: { primary: "GENERAL_MERCHANDISE" },
} as PlaidTransaction;

/** A transaction with every optional field absent. */
const SPARSE: PlaidTransaction = {
  transaction_id: "txn-2",
  account_id: "acct-1",
  date: "2026-05-14",
  amount: -20,
} as PlaidTransaction;

describe("Plaid document-event profile", () => {
  test("satisfies the source contract", () => {
    expect(() =>
      validateDocumentEventProfile(plaidTransactionsDocumentProfile, "source 'plaid'"),
    ).not.toThrow();
  });

  test("declares exactly the metadata the normalizer writes", () => {
    const declared = new Set(
      (plaidTransactionsDocumentProfile.metadataFields ?? []).map((f) => f.path),
    );
    const emitted = new Set(
      Object.keys(transactionToDocument(FULL, OPTS).metadata?.extra ?? {}).map(
        (key) => `extra.${key}`,
      ),
    );
    expect([...emitted].sort()).toEqual([...declared].sort());
  });

  test("declares the document type the normalizer writes", () => {
    const doc = transactionToDocument(FULL, OPTS);
    expect(plaidTransactionsDocumentProfile.documentTypes).toContain(doc.metadata?.documentType);
  });

  test("emits no people — a merchant is an organisation, not one of the person roles", () => {
    expect(plaidTransactionsDocumentProfile.personRoles).toEqual([]);
    expect(transactionToDocument(FULL, OPTS).metadata?.people ?? []).toEqual([]);
  });

  test("a transaction missing every optional field still emits only declared paths", () => {
    const declared = new Set(
      (plaidTransactionsDocumentProfile.metadataFields ?? []).map((f) => f.path),
    );
    for (const key of Object.keys(transactionToDocument(SPARSE, OPTS).metadata?.extra ?? {})) {
      expect(declared).toContain(`extra.${key}`);
    }
  });

  test("the category vocabulary covers what the normalizer can emit", () => {
    const category = plaidTransactionsDocumentProfile.metadataFields?.find(
      (f) => f.path === "extra.category",
    );
    // Plaid's primary personal-finance categories are a closed list it can
    // extend, so they are canonical rather than exhaustive.
    expect(category?.canonicalValues).toContain("GENERAL_MERCHANDISE");
    expect(category?.allowedValues).toBeUndefined();
  });
});
