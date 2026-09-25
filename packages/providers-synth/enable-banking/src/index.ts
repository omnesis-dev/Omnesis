// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realEnableBanking, {
  allSchemas,
  bankAccountsSchema,
  bankBalancesSchema,
  bankInstanceIcon,
  bankTransactionsSchema,
} from "@omnesis/provider-enable-banking";
import { defineProvider, syncPage } from "@omnesis/source-sdk";
import {
  fakeOAuthFlow,
  preDiscoveredAccounts,
  selfAccountId,
  type SynthCursor,
  impairedSnapshot,
} from "@omnesis/providers-synth-common";
import { SYNTH_BANK_NAME, accountRecords, balanceRecords, transactionData } from "./fixtures.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";

const { type: _type, ...rest } = realEnableBanking;

// The connected-bank slug (e.g. "revolut-de") comes from the cast like every
// other synth identity, so the universe manifest, discover(), and the
// fixtures' source_account_id all agree.
const accountId = selfAccountId("extra", "enableBankingAccountId");

/** Hybrid sync phases: accounts → balances → transactions (with documents). */
interface EbSynthCursor extends SynthCursor {
  phase?: "accounts" | "balances" | "transactions";
}

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "oauth",
  credentials: undefined,
  supportedPlatforms: undefined,
  discover: async () => preDiscoveredAccounts("enable-banking", [accountId]),
  authFlow: async (_p, cb) => fakeOAuthFlow("enable-banking", "Enable Banking", accountId, cb),
  // A synthetic double spreads the real definition, so every auth entry point
  // the real source declares has to be overridden here or a demo run reaches
  // the real service.
  authenticate: undefined,
  cleanupCredentials: undefined,
  createContext: async () => ({}),
  // A synthetic double has no credential to be in a state about, and says so
  // outright: the real provider's declaration would otherwise leak through
  // the spread above with a context type this double does not have.
  credentialState: () => Promise.resolve({ status: "connected" as const }),
  disposeContext: async () => {},
  sources: rest.sources.map((s) => ({
    ...s,
    // The double drives its own cursor; the real source's decoder does not
    // know it. Inheriting the declaration refuses that cursor on the next tick.
    contract: undefined,
    analyticsSchemas: allSchemas,
    async create({ sourceId, providerId }) {
      const accounts = accountRecords(accountId);
      const balances = balanceRecords(accountId);
      const transactions = transactionData(accountId, { sourceId, providerId });
      return {
        analyticsSchemas: allSchemas,
        // Per-instance branding, mirroring the real create(): the source card
        // shows the connected bank, not the generic Enable Banking descriptor.
        label: SYNTH_BANK_NAME,
        icon: bankInstanceIcon(SYNTH_BANK_NAME),
        async sync() {
          // Structured sources route through syncStructured; the SDK still
          // requires a sync() to exist.
          return syncPage([], { offset: 0 } as SynthCursor, { hasMore: false });
        },
        async syncStructured(cursor): Promise<StructuredSyncResult<EbSynthCursor>> {
          const phase = (cursor as EbSynthCursor | null)?.phase ?? "accounts";
          if (phase === "accounts") {
            return {
              analytics: {
                tableName: bankAccountsSchema.tableName,
                records: accounts,
                schema: bankAccountsSchema,
              },
              cursor: { phase: "balances" },
              hasMore: true,
            };
          }
          if (phase === "balances") {
            return {
              analytics: {
                tableName: bankBalancesSchema.tableName,
                records: balances,
                schema: bankBalancesSchema,
              },
              cursor: { phase: "transactions" },
              hasMore: true,
            };
          }
          // Final page: transactions plus their searchable documents. The
          // cursor wraps back to the first phase so a re-triggered sync
          // re-emits the whole byte-stable corpus — every row re-upserts
          // onto the same primary key, making re-syncs exactly idempotent.
          const { visible: documents, presentExternalIds } = impairedSnapshot(
            transactions.documents,
            sourceId,
            (d) => d.externalId,
          );
          return {
            analytics: {
              tableName: bankTransactionsSchema.tableName,
              records: transactions.records,
              schema: bankTransactionsSchema,
            },
            documents,
            cursor: { phase: "accounts" },
            hasMore: false,
            presentExternalIds,
          };
        },
      };
    },
  })),
});
