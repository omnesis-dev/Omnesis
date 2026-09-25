// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineProvider, emptySync, readConnectionState } from "@omnesis/source-sdk";
import { readProviderAccountOrLegacyCredentials } from "@omnesis/core";
import { CoinbaseClient } from "./client.js";
import { coinbaseCredentialsSpec } from "./credentials-spec.js";
import { coinbaseIcon } from "./icons.js";
import {
  authenticate as coinbaseAuthenticate,
  authFlow as coinbaseAuthFlow,
  cleanupCredentials as coinbaseCleanupCredentials,
  discoverAccounts,
  hasCredentials,
  loadCredentials,
} from "./provider.js";
import { allSchemas } from "./schemas.js";
import { CoinbaseSnapshotSource } from "./snapshot.js";
import { coinbaseStateSpec } from "./state.js";
import { validateCoinbaseCursor } from "./types.js";
import type { CoinbaseContext } from "./types.js";

/** Descriptor id of the brokerage source — also used by the synth twin. */
export const COINBASE_SOURCE_ID = "coinbase";

// Re-exports for tests and the (future) synth twin.
export {
  CoinbaseClient,
  CoinbaseScopeError,
  COINBASE_API_HOST,
  COINBASE_BROKERAGE_BASE,
  COINBASE_V2_BASE,
  ACTIVITY_PAGE_LIMIT,
} from "./client.js";
export type { FetchFn } from "./client.js";
export { signCoinbaseJwt, coinbaseJwtUri, COINBASE_JWT_TTL_SECONDS } from "./jwt.js";
export { coinbaseCredentialsSpec } from "./credentials-spec.js";
export { decimalFromString, decimalFromStringOrNull, DECIMAL_STRING_RE } from "./decimal.js";
export { CoinbaseSnapshotSource, utcDateOf, ACCOUNTS_PAGE_SIZE } from "./snapshot.js";
export {
  accountToBalanceRecord,
  accountsToBalanceRecords,
  spotPositionToHoldingRecord,
  orderToRecord,
  fillToRecord,
  transactionToRecord,
  transactionToDocument,
  v2AccountCurrency,
  toIso,
} from "./normalizer.js";
export {
  allSchemas,
  coinbaseBalancesTableSchema,
  coinbaseHoldingsTableSchema,
  coinbaseOrdersTableSchema,
  coinbaseFillsTableSchema,
  coinbaseTransactionsTableSchema,
  FIAT_SCALE,
  CRYPTO_SCALE,
} from "./schemas.js";
export type {
  CoinbaseAccountRow,
  CoinbaseAccountsPage,
  CoinbaseAmount,
  CoinbasePortfolio,
  CoinbasePortfoliosResponse,
  CoinbasePortfolioBreakdown,
  CoinbaseSpotPosition,
  CoinbaseOrder,
  CoinbaseOrdersPage,
  CoinbaseFill,
  CoinbaseFillsPage,
  CoinbaseV2Account,
  CoinbaseV2AccountsPage,
  CoinbaseV2Transaction,
  CoinbaseV2TransactionsPage,
} from "./schemas.js";
export {
  authenticate,
  authFlow,
  cleanupCredentials,
  deriveAccountId,
  discoverAccounts,
  hasCredentials,
  loadCredentials,
} from "./provider.js";
export { validateCoinbaseCursor } from "./types.js";
export type {
  CoinbaseContext,
  CoinbaseCredentials,
  CoinbaseCursor,
  CoinbasePhase,
  CoinbaseAccount,
  CoinbaseAccountsResponse,
  CoinbaseKeyPermissions,
} from "./types.js";

export default defineProvider<CoinbaseContext>({
  provider: { id: "coinbase", name: "Coinbase" },
  authType: "api-key",
  credentials: coinbaseCredentialsSpec,

  // Offline account resolution from the per-account marker dirs authFlow
  // writes — the collector derives instances solely from discover().
  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map(String);
  },

  async authFlow(params, callbacks, ctx) {
    // The pasted CDP key arrives on `callbacks.credentials` for a new add and
    // is read from disk for a re-auth. No browser leg for an api-key source.
    const accountId = await coinbaseAuthFlow(params, callbacks, ctx);
    return String(accountId);
  },

  authenticate(session) {
    return coinbaseAuthenticate(session);
  },

  async cleanupCredentials(accountId: string, ctx) {
    await coinbaseCleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, dataCutoff, host }) {
    // Keyed by account: a shared load would give every instance whichever key
    // happened to be stored, so a second portfolio would sync the first's data.
    const credentials = await loadCredentials(accountId, host?.configDir);
    const client = new CoinbaseClient({
      keyId: credentials.key_id,
      privateKeyPem: credentials.private_key,
    });
    return { client, accountId, dataCutoff, configDir: host?.configDir };
  },

  /**
   * Offline-only: credentials exist on disk. Coinbase keys never expire (auth-
   * once), so a transient API blip must not flip the source into sticky
   * needs-auth — a genuinely revoked key surfaces as a 401 →
   * SyncError("auth") during sync.
   */
  // A stored credential is the whole answer, and its absence means this
  // account was never connected rather than that something withdrew it — a
  // distinction the remedy depends on: one asks the operator to connect, the
  // other to authenticate again.
  credentialState(ctx) {
    return readConnectionState(async () => {
      if (!hasCredentials(ctx.accountId, ctx.configDir)) return { status: "never-connected" };
      const fields = await readProviderAccountOrLegacyCredentials(
        "coinbase",
        ctx.accountId,
        ctx.configDir,
      );
      if (!fields?.key_id || !fields.private_key) throw new Error("Unreadable Coinbase credential");
      return { status: "connected" };
    });
  },

  async disposeContext() {
    // Stateless HTTP client — nothing to clean up.
  },

  sources: [
    {
      id: COINBASE_SOURCE_ID,
      name: "Coinbase",
      description:
        "Crypto balances, holdings, and trade activity from Coinbase — read-only, point-in-time balance and holding snapshots plus orders and fills",
      unitName: "transactions",
      icon: coinbaseIcon,
      defaultSourcePrior: -0.04,
      defaultSyncInterval: "2h",
      analyticsSchemas: allSchemas,
      contract: {
        // The host resolves the stored cursor against this before
        // `syncStructured` runs. See `state.ts` for why an unreadable
        // cursor rebootstraps here rather than stopping the source.
        state: coinbaseStateSpec,
      },
      async create({ sourceId, providerId, accountId }, ctx) {
        const source = new CoinbaseSnapshotSource(
          ctx.client,
          providerId,
          sourceId,
          accountId,
          accountId,
        );
        return {
          sync: () => Promise.resolve(emptySync()),
          syncStructured: (cursor) => source.syncStructured(validateCoinbaseCursor(cursor)),
          analyticsSchemas: allSchemas,
        };
      },
    },
  ],
});
