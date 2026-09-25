// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineProvider, emptySync, readConnectionState } from "@omnesis/source-sdk";
import { readProviderAccountOrLegacyCredentials } from "@omnesis/core";
import { LunchflowClient } from "./client.js";
import {
  authenticate as lunchflowAuthenticate,
  authFlow as lunchflowAuthFlow,
  cleanupCredentials as lunchflowCleanupCredentials,
  discoverAccounts,
  hasCredentials,
  loadApiKey,
} from "./provider.js";
import { lunchflowCredentialsSpec } from "./credentials-spec.js";
import { lunchflowIcon } from "./icons.js";
import { allSchemas } from "./schemas.js";
import { LunchflowAccountsSource } from "./accounts.js";
import { lunchflowStateSpec } from "./state.js";
import { validateLunchflowCursor } from "./types.js";
import type { LunchflowContext } from "./types.js";

// Re-exports for tests and the synthetic twin (which reuses the real
// normalizers, schemas, and raw entry types over fixture data).
export {
  LunchflowClient,
  LunchflowAccountGoneError,
  LUNCHFLOW_RATE_LIMIT_RETRY_MS,
} from "./client.js";
export type { LunchflowTransport, GetTransactionsParams } from "./client.js";
export { lunchflowCredentialsSpec } from "./credentials-spec.js";
export {
  allSchemas,
  lunchflowAccountsSchema,
  lunchflowBalancesSchema,
  lunchflowTransactionsSchema,
} from "./schemas.js";
export {
  accountIdString,
  accountToRecord,
  balanceToRecord,
  computeTransactionKey,
  normalizeAmountString,
  processTransactionsPage,
  toAccountContext,
  transactionToDocument,
  transactionToRecord,
  type AccountContext,
} from "./normalizer.js";
export { LunchflowAccountsSource } from "./accounts.js";
export { lunchflowIcon } from "./icons.js";
export { LUNCHFLOW_ACCOUNT_ID } from "./provider.js";
export type {
  LunchflowAccount,
  LunchflowBalance,
  LunchflowContext,
  LunchflowCursor,
  LunchflowCursorAccount,
  LunchflowTransaction,
} from "./types.js";
export { validateLunchflowCursor } from "./types.js";

/** Descriptor id — the synth twin and fixtures key off this constant. */
export const LUNCHFLOW_ACCOUNTS_SOURCE_ID = "lunchflow-accounts";

export default defineProvider<LunchflowContext>({
  provider: { id: "lunchflow", name: "Lunch Flow" },
  authType: "api-key",
  credentials: lunchflowCredentialsSpec,

  // Resolve connected accounts offline; the collector derives accounts solely
  // from discover().
  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map(String);
  },

  authenticate(session) {
    return lunchflowAuthenticate(session);
  },

  async authFlow(params, callbacks, ctx) {
    // The pasted API key arrives on `callbacks.credentials` for a new add and
    // is read from disk for a re-auth. No browser leg for an api-key source.
    const accountId = await lunchflowAuthFlow(params, callbacks, ctx);
    return String(accountId);
  },

  async cleanupCredentials(accountId: string, ctx) {
    await lunchflowCleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, dataCutoff, host }) {
    // Keyed by account: a shared load would hand every instance the same key,
    // so a second connection would sync the first one's banks.
    const apiKey = await loadApiKey(accountId, host?.configDir);
    const client = new LunchflowClient({ apiKey });
    return { client, accountId, dataCutoff, configDir: host?.configDir, now: () => new Date() };
  },

  // Offline check only — whether this account's API key is present. Network
  // failures must not flip the source to needs-auth; a truly dead key surfaces
  // as SyncError("auth") during sync instead.
  credentialState(ctx) {
    // A stored credential is the whole answer, and its absence means this
    // account was never connected rather than that something withdrew it —
    // the remedy differs: one asks the operator to connect, the other to
    // authenticate again.
    return readConnectionState(async () => {
      if (!hasCredentials(String(ctx.accountId), ctx.configDir))
        return { status: "never-connected" };
      const fields = await readProviderAccountOrLegacyCredentials(
        "lunchflow",
        String(ctx.accountId),
        ctx.configDir,
      );
      if (!fields?.api_key) throw new Error("Unreadable Lunch Flow credential");
      return { status: "connected" };
    });
  },

  async disposeContext() {
    // Stateless HTTP client — nothing to clean up.
  },

  sources: [
    {
      id: LUNCHFLOW_ACCOUNTS_SOURCE_ID,
      name: "Bank accounts (Lunch Flow)",
      description:
        "Sync transactions and balances from UK, EU, and global banks via the Lunch Flow aggregator (GoCardless and others)",
      unitName: "transactions",
      contract: {
        // The host resolves the stored cursor against this before
        // `syncStructured` runs, so an unrecognised value is refused as
        // unreadable rather than read as "no accounts yet".
        state: lunchflowStateSpec,
      },
      icon: lunchflowIcon,
      analyticsSchemas: allSchemas,
      defaultSourcePrior: -0.04,
      defaultSyncInterval: "6h",
      async create({ sourceId, providerId, dataCutoff, accountId }, ctx) {
        const source = new LunchflowAccountsSource(ctx.client, providerId, sourceId, accountId, {
          now: ctx.now,
          dataCutoff,
        });
        return {
          sync: () => Promise.resolve(emptySync()),
          syncStructured: (cursor) => source.syncStructured(validateLunchflowCursor(cursor)),
          analyticsSchemas: allSchemas,
        };
      },
    },
  ],
});
