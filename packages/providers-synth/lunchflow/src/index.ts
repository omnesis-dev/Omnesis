// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import realLunchflow, {
  allSchemas,
  lunchflowAccountsSchema,
  lunchflowBalancesSchema,
  lunchflowTransactionsSchema,
} from "@omnesis/provider-lunchflow";
import { defineProvider, syncPage } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  preDiscoveredAccounts,
  selfAccountId,
  type SynthCursor,
  impairedSnapshot,
} from "@omnesis/providers-synth-common";
import { accountRecords, balanceRecords, transactionData } from "./fixtures.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";

const { type: _type, ...rest } = realLunchflow;

// The single connection's account id comes from the cast like every other
// synth identity, so the universe manifest, discover(), and the fixtures all
// agree on the source-id suffix.
const accountId = selfAccountId("extra", "lunchflowAccountId");

/** Hybrid sync phases: accounts → balances → transactions (with documents). */
interface LfSynthCursor extends SynthCursor {
  phase?: "accounts" | "balances" | "transactions";
}

export default defineProvider<Record<string, never>>({
  ...rest,
  authType: "api-key",
  credentials: undefined,
  supportedPlatforms: undefined,
  discover: async () => preDiscoveredAccounts("lunchflow", [accountId]),
  // Api-key sources have no browser leg — a local pair shim stands in.
  authFlow: async () => fakeLocalFlow("lunchflow", accountId),
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
    async create({ sourceId, providerId, accountId }) {
      const accounts = accountRecords(accountId);
      const balances = balanceRecords(accountId);
      const transactions = transactionData({ sourceId, providerId, sourceAccountId: accountId });
      return {
        analyticsSchemas: allSchemas,
        async sync() {
          // Structured sources route through syncStructured; the SDK still
          // requires a sync() to exist.
          return syncPage([], { offset: 0 } as SynthCursor, { hasMore: false });
        },
        async syncStructured(cursor): Promise<StructuredSyncResult<LfSynthCursor>> {
          const phase = (cursor as LfSynthCursor | null)?.phase ?? "accounts";
          if (phase === "accounts") {
            return {
              analytics: {
                tableName: lunchflowAccountsSchema.tableName,
                records: accounts,
                schema: lunchflowAccountsSchema,
              },
              cursor: { phase: "balances" },
              hasMore: true,
            };
          }
          if (phase === "balances") {
            return {
              analytics: {
                tableName: lunchflowBalancesSchema.tableName,
                records: balances,
                schema: lunchflowBalancesSchema,
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
              tableName: lunchflowTransactionsSchema.tableName,
              records: transactions.records,
              schema: lunchflowTransactionsSchema,
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
