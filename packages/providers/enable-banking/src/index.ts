// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineProvider, emptySync, readConnectionState } from "@omnesis/source-sdk";
import { EnableBankingClient } from "./client.js";
import {
  authenticate as enableBankingAuthenticate,
  authFlow as enableBankingAuthFlow,
  cleanupCredentials as enableBankingCleanupCredentials,
  discoverAccounts,
  loadCredentials,
} from "./provider.js";
import { enableBankingCredentialsSpec } from "./credentials-spec.js";
import { bankInstanceIcon, enableBankingIcon } from "./icons.js";
import { allSchemas } from "./schemas.js";
import { EnableBankingAccountsSource } from "./accounts.js";
import { inspectSession, isSessionValid, loadSession } from "./session.js";
import { enableBankingStateSpec } from "./state.js";
import { validateEnableBankingCursor } from "./types.js";
import type { EnableBankingContext } from "./types.js";

// Re-exports for tests and the synthetic twin (which reuses the real
// normalizers, schemas, and raw entry types over fixture data).
export { EnableBankingClient, EB_RATE_LIMIT_RETRY_MS } from "./client.js";
export type { EnableBankingTransport, GetTransactionsParams } from "./client.js";
export { enableBankingCredentialsSpec } from "./credentials-spec.js";
export {
  allSchemas,
  bankAccountsSchema,
  bankBalancesSchema,
  bankTransactionsSchema,
} from "./schemas.js";
export {
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
export { EnableBankingAccountsSource } from "./accounts.js";
export { bankInstanceIcon, enableBankingIcon } from "./icons.js";
export { loadSession, saveSession, isSessionValid } from "./session.js";
export { bankAccountSlug } from "./provider.js";
export type {
  EbAspsp,
  EbBalance,
  EbSessionAccount,
  EbSessionResponse,
  EbTransaction,
  EbTransactionsPage,
  EnableBankingContext,
  EnableBankingCursor,
  StoredSession,
  StoredSessionAccount,
} from "./types.js";
export { validateEnableBankingCursor } from "./types.js";

/** Descriptor id — the synth twin and fixtures key off this constant. */
export const ENABLE_BANKING_ACCOUNTS_SOURCE_ID = "enable-banking-accounts";

export default defineProvider<EnableBankingContext>({
  provider: { id: "enable-banking", name: "Enable Banking" },
  authType: "oauth",
  // The flow consumes externally delivered authorization codes via
  // `callbacks.receiveCode` (gateway /oauth/callback or CLI/portal paste) —
  // this flag is what gates those paste affordances in the portal and CLI.
  acceptsAuthCode: true,
  credentials: enableBankingCredentialsSpec,

  // Resolve connected banks offline from the persisted session files —
  // the collector derives accounts solely from discover().
  async discover(ctx) {
    return discoverAccounts(ctx?.configDir).map(String);
  },

  authenticate(session) {
    return enableBankingAuthenticate(session);
  },

  async authFlow(authParams, callbacks, ctx) {
    const accountId = await enableBankingAuthFlow(authParams, callbacks, {
      configDir: ctx?.configDir,
    });
    return String(accountId);
  },

  async cleanupCredentials(accountId: string, ctx) {
    await enableBankingCleanupCredentials(accountId, ctx?.configDir);
  },

  async createContext({ accountId, dataCutoff, host }) {
    const creds = await loadCredentials(host?.configDir);
    const client = new EnableBankingClient({
      applicationId: creds.applicationId,
      privateKeyPem: creds.privateKeyPem,
    });
    // The clock comes from the host, which a test can move; the context's own
    // `now` exists precisely so this source's consent-expiry arithmetic is
    // drivable without waiting.
    return {
      client,
      accountId,
      dataCutoff,
      now: host ? () => host.now() : () => new Date(),
      configDir: host?.configDir,
    };
  },

  // Offline only — the consent's own deadline against the clock. A network or
  // API failure must not flip the source to needs-auth; a session that has
  // genuinely stopped working surfaces as SyncError("auth") during sync.
  //
  // The deadline is reported rather than consumed. A consent under this scheme
  // lapses on a fixed schedule, so the useful thing to say a week out is not
  // "broken" but "working, until Friday" — and only the host knows how much
  // warning is worth giving.
  credentialState(ctx) {
    return readConnectionState(() => {
      const session = inspectSession(ctx.accountId, ctx.configDir);
      if (!session) return { status: "never-connected" };
      if (!isSessionValid(session, ctx.now())) {
        return { status: "expired", at: session.valid_until };
      }
      return { status: "connected", expiresAt: session.valid_until };
    });
  },

  async disposeContext() {
    // Stateless HTTP client — nothing to clean up.
  },

  sources: [
    {
      id: ENABLE_BANKING_ACCOUNTS_SOURCE_ID,
      name: "Bank account (Enable Banking)",
      description: "Connect Revolut or any EU/UK bank via PSD2 open banking (Enable Banking)",
      unitName: "transactions",
      contract: {
        // The host resolves the stored cursor against this before
        // `syncStructured` runs, so an unrecognised value is refused as
        // unreadable rather than read as "no accounts yet".
        state: enableBankingStateSpec,
        requires: ["state-envelope"],
      },
      icon: enableBankingIcon,
      analyticsSchemas: allSchemas,
      defaultSourcePrior: -0.04,
      defaultSyncInterval: "12h",
      async create({ sourceId, providerId, dataCutoff }, ctx) {
        const source = new EnableBankingAccountsSource(
          ctx.client,
          providerId,
          sourceId,
          ctx.accountId,
          { now: ctx.now, configDir: ctx.configDir, dataCutoff },
        );
        // Brand the instance as the connected bank (its ASPSP name and, for
        // recognized banks, its own logo) rather than the generic descriptor
        // name/icon — label/icon mirror the session.
        const session = loadSession(ctx.accountId, ctx.configDir);
        return {
          sync: () => Promise.resolve(emptySync()),
          syncStructured: (cursor) => source.syncStructured(validateEnableBankingCursor(cursor)),
          analyticsSchemas: allSchemas,
          label: session?.aspsp.name,
          icon: session ? bankInstanceIcon(session.aspsp.name) : undefined,
        };
      },
    },
  ],
});
