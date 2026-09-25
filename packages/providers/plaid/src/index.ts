// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineProvider, emptySync, readConnectionState } from "@omnesis/source-sdk";
import { SyncError } from "@omnesis/types";
import { PlaidClient } from "./client.js";
import { plaidCredentialsSpec } from "./credentials-spec.js";
import { plaidTransactionsDocumentProfile } from "./document-profiles.js";
import { institutionIcon, plaidIcon } from "./icons.js";
import { discoverAccounts, hasCredentials, loadItemCredential } from "./items.js";
import {
  authenticate as plaidAuthenticate,
  authFlow as plaidAuthFlow,
  cleanupCredentials as plaidCleanupCredentials,
  loadCredentials,
} from "./provider.js";
import { settlePendingLinks } from "./pending-links.js";
import { allSchemas } from "./schemas.js";
import { plaidStateSpec } from "./state.js";
import { PlaidSyncSource } from "./sync.js";
import { validatePlaidCursor } from "./types.js";
import type { PlaidContext } from "./types.js";

/** Descriptor id of the Plaid source — shared with its synth twin. */
export const PLAID_SOURCE_ID = "plaid";

// Re-exports for tests and the synth twin.
export {
  PlaidClient,
  PlaidApiError,
  PLAID_API_VERSION,
  PLAID_CLIENT_NAME,
  PLAID_ITEM_GONE_CODES,
  PLAID_NO_INVESTMENTS_CODES,
  PLAID_OPTIONAL_PRODUCTS,
  PLAID_PRODUCTS,
  PLAID_RATE_LIMIT_RETRY_MS,
  PLAID_SYNC_MUTATION_CODE,
  PLAID_TRANSACTIONS_DAYS_REQUESTED,
  PLAID_TRANSACTIONS_SYNC_COUNT,
} from "./client.js";
export type {
  LinkTokenCreateParams,
  PlaidClientOptions,
  PlaidRequestOptions,
  PlaidTransport,
  TransactionsSyncParams,
} from "./client.js";
export { decimalFromNumberOrNull, DECIMAL_STRING_RE, MONEY_SCALE } from "./decimal.js";
export {
  balanceAccountsToRecords,
  balanceAccountToRecord,
  holdingsToRecords,
  holdingToRecord,
  processTransactions,
  QUANTITY_SCALE,
  signedTransactionAmount,
  transactionCurrency,
  transactionToDocument,
  transactionToRecord,
} from "./normalizer.js";
export { PlaidTransactionsSource } from "./transactions.js";
export type { PlaidTransactionsSourceOptions } from "./transactions.js";
export { PlaidSnapshotSource, utcDateOf } from "./snapshot.js";
export { PlaidSyncSource } from "./sync.js";
export type { PlaidSyncSourceOptions } from "./sync.js";
export {
  allSchemas,
  plaidBalancesSchema,
  plaidHoldingsSchema,
  plaidTransactionsSchema,
} from "./schemas.js";
export { plaidCredentialsSpec } from "./credentials-spec.js";
export { institutionIcon, plaidIcon } from "./icons.js";
export { authFlow, cleanupCredentials, createClient, loadCredentials } from "./provider.js";
export {
  discoverAccounts,
  hasCredentials,
  loadItemCredential,
  saveItemCredential,
} from "./items.js";
export { forgetPendingLink, rememberPendingLink, settlePendingLinks } from "./pending-links.js";
export {
  plaidAccountBalancesSchema,
  plaidAccountsGetResponseSchema,
  plaidBalanceAccountSchema,
  plaidInstitutionGetByIdResponseSchema,
  plaidErrorResponseSchema,
  plaidHoldingSchema,
  plaidInvestmentsHoldingsGetResponseSchema,
  plaidItemGetResponseSchema,
  plaidItemPublicTokenExchangeResponseSchema,
  plaidItemRemoveResponseSchema,
  plaidLinkSessionInstitutionSchema,
  plaidLinkTokenCreateResponseSchema,
  plaidLinkTokenGetResponseSchema,
  plaidRemovedTransactionSchema,
  plaidSecuritySchema,
  plaidTransactionSchema,
  plaidTransactionsSyncResponseSchema,
} from "./schemas.js";
export type {
  PlaidAccountBalances,
  PlaidAccountsGetResponse,
  PlaidBalanceAccount,
  PlaidHolding,
  PlaidInvestmentsHoldingsGetResponse,
  PlaidItemGetResponse,
  PlaidItemPublicTokenExchangeResponse,
  PlaidItemRemoveResponse,
  PlaidInstitutionGetByIdResponse,
  PlaidLinkTokenGetResponse,
  PlaidLinkTokenCreateResponse,
  PlaidRemovedTransaction,
  PlaidSecurity,
  PlaidTransaction,
  PlaidTransactionsSyncResponse,
} from "./schemas.js";
export {
  PLAID_DEFAULT_COUNTRIES,
  PLAID_ENVIRONMENTS,
  PLAID_FILE_KEY,
  parseCountries,
  plaidHost,
  validatePlaidCursor,
} from "./types.js";
export type {
  PlaidContext,
  PlaidCredentials,
  PlaidCursor,
  PlaidEnvironment,
  PlaidItemCredential,
  PlaidPhase,
} from "./types.js";

/**
 * Settle what a previous run left behind, at most once per collector process.
 *
 * Sweeping is idempotent, so a second pass would be harmless but not free: the
 * collector builds a context per connected bank, and each pass is a Plaid
 * round-trip per outstanding session. `settlePendingLinks` never rejects, so
 * nothing here can surface as a failed source.
 */
let pendingLinkSweep: Promise<unknown> | undefined;
function sweepPendingLinksOnce(client: PlaidClient, configDir: string | undefined): void {
  pendingLinkSweep ??= settlePendingLinks(client, configDir);
}

export default defineProvider<PlaidContext>({
  provider: { id: "plaid", name: "Plaid" },
  // Plaid hosts the whole sign-in page, so the add is a URL the user opens —
  // no embedded widget, and no callback for Omnesis to host. The bank's own
  // OAuth redirect happens entirely between the user's browser and Plaid.
  authType: "oauth",
  // Not yet battle-tested: hidden from the Add-source picker until the
  // operator opts in with OMNESIS_EXPERIMENTAL=1.
  experimental: true,
  credentials: plaidCredentialsSpec,

  // Resolve connected items offline from the per-item credential dirs the
  // auth flow wrote — the collector derives accounts solely from discover().
  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map(String);
  },

  authenticate(session) {
    // One Link session connects one institution, which becomes one Omnesis
    // account keyed by its Plaid item id.
    return plaidAuthenticate(session);
  },

  async authFlow(params, callbacks, ctx) {
    return (await plaidAuthFlow(params, callbacks, ctx?.configDir)).map(String);
  },

  async cleanupCredentials(accountId: string, ctx) {
    await plaidCleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, dataCutoff, host }) {
    // Validate the app credential exists (throws into the wizard if not). The
    // per-item access token is loaded by the sync source from the item dir.
    const credentials = await loadCredentials(host?.configDir);
    const client = new PlaidClient({
      clientId: credentials.client_id,
      secret: credentials.secret,
      environment: credentials.environment,
      countryCodes: credentials.countries,
    });
    // A collector that restarted mid-add is the one case another add does not
    // cover: that add's own settle never ran, and a bank the user finished
    // connecting would keep billing with nothing here able to disconnect it.
    //
    // Started rather than awaited, and once per collector rather than once per
    // bank: this is a factory the collector calls for every source in turn, so
    // waiting on Plaid here would stall every other provider's setup behind a
    // slow request, and settling has nothing to tell the context it returns.
    sweepPendingLinksOnce(client, host?.configDir);
    return { client, accountId, dataCutoff, configDir: host?.configDir };
  },

  /**
   * Offline check only: the app credential plus this item's stored credential
   * are present. A transient API blip must never flip a connected item into
   * sticky needs-auth — a genuinely revoked consent surfaces as
   * `SyncError("auth")` during sync.
   */
  // A stored credential is the whole answer, and its absence means this
  // account was never connected rather than that something withdrew it — a
  // distinction the remedy depends on: one asks the operator to connect, the
  // other to authenticate again.
  credentialState(ctx) {
    return readConnectionState(async () => {
      if (!hasCredentials(ctx.accountId, ctx.configDir)) return { status: "never-connected" };
      await loadCredentials(ctx.configDir);
      return { status: "connected" };
    });
  },

  async disposeContext() {
    // Stateless HTTP client — nothing to clean up.
  },

  sources: [
    {
      id: PLAID_SOURCE_ID,
      name: "Bank account (Plaid)",
      description:
        "Connect a bank through Plaid — read-only balances, transactions, and investment holdings",
      unitName: "transactions",
      // Balances and holdings add one analytics row per account per day, so
      // the headline count must stay on the transaction documents.
      primaryCount: "documents",
      icon: plaidIcon,
      documentEventProfile: plaidTransactionsDocumentProfile,
      defaultSourcePrior: -0.04,
      defaultSyncInterval: "12h",
      analyticsSchemas: allSchemas,
      contract: {
        // The host resolves the stored cursor against this before
        // `syncStructured` runs. See `state.ts` for why an unreadable
        // cursor rebootstraps here rather than stopping the source.
        state: plaidStateSpec,
      },
      async create({ sourceId, providerId, accountId, dataCutoff }, ctx) {
        // Load the per-item access token written by authFlow. A missing item
        // file means the connection was removed underneath us — surface as a
        // re-auth-needed sync error rather than crashing the collector tick.
        const item = loadItemCredential(accountId, ctx.configDir);
        if (!item) {
          return {
            sync: () =>
              Promise.reject(
                new SyncError(
                  "auth",
                  `No stored Plaid connection for ${accountId} — reconnect the bank to restore access.`,
                ),
              ),
          };
        }
        // One phase machine: the transactions delta followed by the day's
        // balances + holdings snapshots (see sync.ts).
        const source = new PlaidSyncSource(
          ctx.client,
          providerId,
          sourceId,
          accountId,
          item.access_token,
          { dataCutoff, institutionName: item.institution_name },
        );
        return {
          sync: () => Promise.resolve(emptySync()),
          syncStructured: (cursor, opts) =>
            source.syncStructured(validatePlaidCursor(cursor), opts),
          analyticsSchemas: allSchemas,
          label: item.institution_name,
          // Brand the instance with the connected bank's own mark when Plaid
          // served one; otherwise it keeps the Plaid mark.
          icon: institutionIcon(item),
        };
      },
    },
  ],
});
