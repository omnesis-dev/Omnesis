// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentEventProfile } from "@omnesis/source-sdk";

/**
 * What a Plaid transaction document carries, so a watch can name one.
 *
 * The fields are exactly what the normalizer writes into
 * `metadata.extra` — a parity test asserts that, because a declared field
 * nobody emits compiles a watch that can never fire, and an undeclared field is
 * absent from the watch journal. None of them names a person: the counterparty
 * on a bank transaction is a merchant, which is an organisation rather than one
 * of the profile's person roles, so the source emits no people at all.
 */
export const plaidTransactionsDocumentProfile: DocumentEventProfile = {
  documentTypes: ["transaction"],
  personRoles: [],
  metadataFields: [
    {
      path: "extra.merchantName",
      type: "string",
      description:
        "Who the money went to or came from, as the bank or Plaid names them — a shop, an " +
        "employer, a transfer counterparty. An organisation, never a person.",
    },
    {
      path: "extra.category",
      type: "string",
      description: "Plaid's personal-finance category for the transaction, when it classified one.",
      canonicalValues: [
        "INCOME",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "LOAN_PAYMENTS",
        "BANK_FEES",
        "ENTERTAINMENT",
        "FOOD_AND_DRINK",
        "GENERAL_MERCHANDISE",
        "HOME_IMPROVEMENT",
        "MEDICAL",
        "PERSONAL_CARE",
        "GENERAL_SERVICES",
        "GOVERNMENT_AND_NON_PROFIT",
        "TRANSPORTATION",
        "TRAVEL",
        "RENT_AND_UTILITIES",
      ],
      valueAliases: {
        FOOD_AND_DRINK: ["eating out", "restaurants", "groceries", "coffee"],
        TRANSPORTATION: ["travel to work", "fuel", "taxis", "public transport"],
        RENT_AND_UTILITIES: ["rent", "bills", "electricity", "water"],
        INCOME: ["salary", "pay", "wages", "money in"],
      },
    },
    {
      path: "extra.paymentChannel",
      type: "string",
      description: "How the payment was made.",
      canonicalValues: ["online", "in store", "other"],
    },
    {
      path: "extra.pending",
      type: "boolean",
      description:
        "Whether the bank is still holding the transaction as pending. A pending transaction is " +
        "replaced by a posted one under a new id once it clears.",
    },
    {
      path: "extra.currency",
      type: "string",
      description: "ISO 4217 code of the amount, when the bank reports one.",
    },
    {
      path: "extra.accountId",
      type: "string",
      description:
        "Which account at the connected bank the transaction belongs to — one connection can " +
        "cover a current account, a savings account and a card.",
    },
  ],
};
